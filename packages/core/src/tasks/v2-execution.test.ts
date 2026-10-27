import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  encodeFunctionData,
  keccak256,
  parseAbi,
  type Hex,
  type PublicClient,
  getAddress,
  toHex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createTasksClient, TasksClientError, type TasksClient } from "./client.js";
import { escrowFactoryV2Abi, escrowV2Abi, bountyPoolV1Abi } from "./v2-abi.js";
import { acceptedV2TermsHash } from "./v2-plan-guard.js";
import { type TasksChainOptions } from "./chain.js";
import { createPendingTransactions } from "./pending-transactions.js";
import {
  createTaskV2Executor,
  executeTaskV2,
  recoverTaskV2,
  taskUsesV2,
  type TaskV2ExecutionInput,
} from "./v2-execution.js";
import {
  taskV2OperationResponseSchema,
  taskV2PreparedSchema,
  taskV2RecoverySchema,
  taskV2AbandonSchema,
  type TaskV2OperationResponse,
  type TaskV2Prepared,
} from "./v2-write.js";
import {
  v2WritePrepared,
  v2WriteConfirmed,
  v2WriteSubmitted,
  V2_WRITE_ORDER,
  V2_WRITE_OPERATION,
} from "./fixtures/tasks-v2-writes.js";
import { missingTasksChain } from "./chain-port.js";
import { readSpendLedger } from "../spend-policy.js";
import type { WalletName } from "../wallet-name.js";

vi.mock("viem/actions", () => ({
  prepareTransactionRequest: vi.fn(async (_rpc, request) => ({
    ...request,
    type: "eip1559",
    gas: 100000n,
    maxFeePerGas: 10n,
    maxPriorityFeePerGas: 1n,
  })),
}));
const homes: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(homes.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
const account = privateKeyToAccount(`0x${"77".repeat(32)}`);
const USDC = `0x${"44".repeat(20)}` as const;
const FACTORY = `0x${"55".repeat(20)}` as const;
const POOL_FACTORY = `0x${"66".repeat(20)}` as const;
const WORKER = `0x${"88".repeat(20)}` as const;
const RESOLVER = `0x${"99".repeat(20)}` as const;
const NOW_SECONDS = BigInt(Date.parse("2026-10-26T12:00:00Z") / 1000);
const DEADLINE = "2026-10-28T12:00:00.000Z";
const PIN = {
  escrowFactoryV2: FACTORY,
  bountyPoolFactoryV1: POOL_FACTORY,
  usdc: USDC,
  usdcName: "USD Coin",
  usdcVersion: "2",
};
const state = {
  escrow: v2WritePrepared.operation.plan.to,
  feeBp: 500,
  totalBaseUnits: "100000000",
  paidBaseUnits: "0",
  refundedBaseUnits: "0",
  milestones: [
    { amountBaseUnits: "100000000", status: "submitted", dispute: undefined as unknown },
  ],
};
const statuses = ["pending", "submitted", "released", "refunded", "disputed", "split"];
function fullView() {
  return {
    workOrder: {
      id: V2_WRITE_ORDER,
      clientAddress: account.address,
      title: "Deliver useful proof",
      description: "Deliver the requested proof for this task.",
      market: { budget: { network: "eip155:84532", amountBaseUnits: "100000000" } },
      terms: {
        shape: "task",
        milestones: [
          {
            index: 1,
            amountBaseUnits: "100000000",
            acceptance: "A useful proof",
            deadlineAt: DEADLINE,
          },
        ],
      },
      v2State: { ...state, milestones: state.milestones.map((m) => ({ ...m })) },
    },
    lifecycle: { shape: "task", state: "Active" },
    nextAction: { action: "none" },
  };
}
function creationArgs(view = fullView()) {
  return [
    {
      shape: 0,
      poster: account.address,
      termsHash: acceptedV2TermsHash(
        view as unknown as import("./types.js").GetOrderResponse,
        PIN,
        604800n,
      ),
      total: 100000000n,
      offerTtl: 86400n,
      reviewWindow: 604800n,
      choiceWindow: 604800n,
      winners: 0,
      rewardPerWinner: 0n,
    },
    [{ amount: 100000000n, deadline: BigInt(Date.parse(DEADLINE) / 1000) }],
    keccak256(toHex(V2_WRITE_ORDER)),
  ] as const;
}
const FUND_DATA = () =>
  encodeFunctionData({
    abi: escrowFactoryV2Abi,
    functionName: "createAndFund",
    args: creationArgs(),
  });
const HASH_EVIDENCE = (s: string) => keccak256(toHex(JSON.stringify(s)));
async function fixture(step: TaskV2OperationResponse["operation"]["step"] = "v2-approve") {
  const home = await mkdtemp(join(tmpdir(), "vapi-v2-write-"));
  homes.push(home);
  const view = fullView();
  const data =
    step === "v2-fund"
      ? FUND_DATA()
      : step === "v2-raise-dispute"
        ? encodeFunctionData({
            abi: escrowV2Abi,
            functionName: "raiseDispute",
            args: [0, HASH_EVIDENCE("Proof text")],
          })
        : encodeFunctionData({ abi: escrowV2Abi, functionName: "approveMilestone", args: [0] });
  const prepared = taskV2OperationResponseSchema.parse({
    ...v2WritePrepared,
    operation: {
      ...v2WritePrepared.operation,
      expectedActor: account.address,
      step,
      plan: {
        ...v2WritePrepared.operation.plan,
        from: account.address,
        step,
        data,
        to: step === "v2-fund" ? FACTORY : v2WritePrepared.operation.plan.to,
      },
    },
  });
  const sign = vi.spyOn(account, "signTransaction");
  const typedSign = vi.spyOn(account, "signTypedData");
  const rpc = {
    getChainId: vi.fn(async () => 84532),
    getTransactionCount: vi.fn(async () => 0),
    sendRawTransaction: vi.fn(async ({ serializedTransaction }: { serializedTransaction: Hex }) =>
      keccak256(serializedTransaction),
    ),
    waitForTransactionReceipt: vi.fn(async () => ({ status: "success" })),
    getBlock: vi.fn(async () => ({ timestamp: NOW_SECONDS })),
    getLogs: vi.fn(async () => [{ args: { raisedBy: WORKER } }]),
    readContract: vi.fn(
      async (call: { functionName: string; args?: readonly unknown[] }): Promise<unknown> => {
        switch (call.functionName) {
          case "isEscrow":
          case "isPool":
            return true;
          case "usdc":
            return USDC;
          case "name":
            return "USD Coin";
          case "version":
            return "2";
          case "poster":
            return account.address;
          case "worker":
            return WORKER;
          case "shape":
          case "winners":
            return 0;
          case "rewardPerWinner":
            return 0n;
          case "offerTtl":
            return 86400n;
          case "choiceWindow":
            return 604800n;
          case "reviewWindow":
            return 604800n;
          case "total":
          case "budget":
            return BigInt(view.workOrder.v2State.totalBaseUnits);
          case "feeBp":
            return 500;
          case "termsHash":
            return acceptedV2TermsHash(
              view as unknown as import("./types.js").GetOrderResponse,
              PIN,
              604800n,
            );
          case "termsDigest":
            return `0x${"12".repeat(32)}`;
          case "milestoneCount":
            return view.workOrder.v2State.milestones.length;
          case "milestone": {
            const m = view.workOrder.v2State.milestones[Number(call.args![0])]!;
            return {
              amount: BigInt(m.amountBaseUnits),
              deadline: BigInt(Date.parse(DEADLINE) / 1000),
              status: statuses.indexOf(m.status),
            };
          }
          case "nonces":
            return 0n;
          case "disputeFee":
            return 20000000n;
          case "disputeResolver":
            return RESOLVER;
          case "stage":
            return 1;
          case "deadlines":
            return [NOW_SECONDS - 1n, 0n, 0n, 0n];
          case "predictEscrow":
          case "predictPool":
            return state.escrow;
          default:
            throw new Error(`Unexpected RPC read ${call.functionName}`);
        }
      },
    ),
  };
  const client = {
    prepareV2: vi.fn(async (): Promise<TaskV2Prepared> => prepared),
    signV2: vi.fn(),
    confirmV2Signature: vi.fn(),
    operationV2: vi.fn(
      async (_id: string, mode: string, body: { transactionHash?: string }): Promise<unknown> =>
        mode === "recover"
          ? { ...prepared, recovered: false, scanComplete: true }
          : {
              ...prepared,
              operation: {
                ...prepared.operation,
                state: mode === "transaction" ? "submitted" : "confirmed",
                transactionHash: body.transactionHash,
              },
            },
    ),
    getOrder: vi.fn(async () => view),
    deployment: vi.fn(async () => ({
      configured: true,
      chainId: 84532,
      network: "eip155:84532",
      usdc: USDC,
      feeBp: 500,
    })),
  };
  const pending = createPendingTransactions(home);
  const sleep = vi.fn(async () => {});
  const notice = vi.fn();
  const options: TasksChainOptions = {
    client: client as unknown as TasksClient,
    account,
    pending,
    rpcFor: () => rpc as unknown as PublicClient,
    sleep,
    env: {},
    trustedV2Deployments: { 84532: PIN },
    onV2UntrustedOverride: notice,
    now: () => new Date("2026-10-26T12:00:00Z"),
  };
  const execute = createTaskV2Executor(options);
  const input: TaskV2ExecutionInput = {
    id: V2_WRITE_ORDER,
    write: { action: "approve", i: 0 },
    policy: { maxPerTaskUsd: 200, approveAboveUsd: 200 },
    caps: { perCallAtomic: "1", perDayAtomic: "200000000" },
    wallet: "worker" as WalletName,
    ledgerPath: join(home, "spend-ledger.json"),
  };
  return {
    execute,
    input,
    client,
    rpc,
    pending,
    home,
    prepared,
    sign,
    typedSign,
    sleep,
    view,
    options,
    notice,
  };
}

describe("recorded T11 operation boundaries", () => {
  it("parses confirm, recover and abandon without a milestone", () => {
    expect(taskV2PreparedSchema.parse(v2WritePrepared)).toEqual(v2WritePrepared);
    expect(taskV2OperationResponseSchema.parse(v2WriteSubmitted).operation.state).toBe("submitted");
    expect(
      taskV2RecoverySchema.parse({ ...v2WriteConfirmed, recovered: true, scanComplete: true })
        .orderId,
    ).toBe(V2_WRITE_ORDER);
    expect(
      taskV2AbandonSchema.parse({ orderId: V2_WRITE_ORDER, operation: null, outcome: "abandoned" })
        .operation,
    ).toBeNull();
    expect(
      taskV2RecoverySchema.safeParse({ ...v2WriteConfirmed, recovered: true, scanComplete: false })
        .success,
    ).toBe(false);
  });
  it.each([
    "chain_preflight_unavailable",
    "v2_binding_mismatch",
    "v2_funding_snapshot_unavailable",
    "v1_order",
    "v2_writes_disabled",
  ])("preserves hosted error %s without signing", async (code) => {
    const fetch = vi.fn(async () =>
      Response.json({ code }, { status: code === "v2_writes_disabled" ? 404 : 503 }),
    );
    const client = createTasksClient({ baseUrl: "https://tasks.example", fetch });
    await expect(
      client.prepareV2(V2_WRITE_ORDER, { action: "fund" }, { idempotencyKey: V2_WRITE_OPERATION }),
    ).rejects.toMatchObject({ serverCode: code });
  });
});

describe("local V2 execution", () => {
  it("refuses above maxPerTaskUsd before any signature, broadcast or spend-state mutation", async () => {
    const f = await fixture("v2-fund");
    const result = await f.execute({
      ...f.input,
      write: { action: "fund" },
      policy: { maxPerTaskUsd: 99, approveAboveUsd: 200 },
    });
    expect(result).toMatchObject({ ok: false, reason: "policy.perTask" });
    expect(f.sign).not.toHaveBeenCalled();
    expect(f.typedSign).not.toHaveBeenCalled();
    expect(f.rpc.sendRawTransaction).not.toHaveBeenCalled();
    await expect(readFile(f.input.ledgerPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("keeps polling after chain confirmation until the hosted order operation is confirmed", async () => {
    const f = await fixture();
    let reconciles = 0;
    f.client.operationV2.mockImplementation(async (_id, mode, body) => {
      if (mode === "recover") return { ...f.prepared, recovered: false, scanComplete: true };
      const confirmed = mode === "reconcile" && ++reconciles === 3;
      return {
        ...f.prepared,
        operation: {
          ...f.prepared.operation,
          state: confirmed ? "confirmed" : "submitted",
          transactionHash: body.transactionHash,
        },
      };
    });
    const money = vi.fn();
    const result = await f.execute({ ...f.input, onMoney: money });
    expect(result).toMatchObject({
      ok: true,
      orderId: V2_WRITE_ORDER,
      operation: { state: "confirmed" },
      money: { gross: { usd: "100.00" }, fee: { usd: "5.00" }, net: { usd: "95.00" } },
    });
    expect(reconciles).toBe(3);
    expect(f.sign).toHaveBeenCalledTimes(1);
    expect(money.mock.invocationCallOrder[0]).toBeLessThan(f.sign.mock.invocationCallOrder[0]!);
    expect(await f.pending.get(V2_WRITE_OPERATION, "v2-approve")).toBeDefined();
  });
  it("stops an approval → fund sequence at the first stable hosted error", async () => {
    const f = await fixture("v2-approve-usdc");
    f.prepared.operation.plan.to = USDC;
    f.prepared.operation.plan.data = encodeFunctionData({
      abi: parseAbi(["function approve(address,uint256) returns (bool)"]),
      functionName: "approve",
      args: [FACTORY, 100000000n],
    });
    f.client.operationV2.mockImplementation(async (_id, mode, body) => {
      if (mode === "recover") return { ...f.prepared, recovered: false, scanComplete: true };
      if (mode === "reconcile")
        throw new TasksClientError(
          "http",
          "preflight unavailable",
          503,
          "chain_preflight_unavailable",
        );
      return {
        ...f.prepared,
        operation: {
          ...f.prepared.operation,
          state: "submitted",
          transactionHash: body.transactionHash,
        },
      };
    });
    await expect(f.execute({ ...f.input, write: { action: "fund" } })).rejects.toMatchObject({
      code: "chain_preflight_unavailable",
      details: {
        orderId: V2_WRITE_ORDER,
        operation: { id: V2_WRITE_OPERATION, state: "submitted" },
      },
    });
    expect(f.sign).toHaveBeenCalledTimes(1);
    expect(f.rpc.sendRawTransaction).toHaveBeenCalledTimes(1);
    expect(await readFile(f.input.ledgerPath, "utf8")).toContain("100000000");
  });
  it("sends approval and final action in order and charges only once", async () => {
    const f = await fixture("v2-approve-usdc");
    f.prepared.operation.plan.to = USDC;
    f.prepared.operation.plan.data = encodeFunctionData({
      abi: parseAbi(["function approve(address,uint256) returns (bool)"]),
      functionName: "approve",
      args: [FACTORY, 100000000n],
    });
    let current = f.prepared;
    f.client.operationV2.mockImplementation(async (_id, mode, body) => {
      if (mode === "recover") return { ...current, recovered: false, scanComplete: true };
      if (mode === "reconcile" && current.operation.step === "v2-approve-usdc") {
        current = {
          ...current,
          operation: {
            ...current.operation,
            step: "v2-fund",
            plan: {
              ...current.operation.plan,
              step: "v2-fund",
              to: FACTORY,
              data: FUND_DATA(),
            },
          },
        };
        return current;
      }
      return {
        ...current,
        operation: {
          ...current.operation,
          state: mode === "transaction" ? "submitted" : "confirmed",
          transactionHash: body.transactionHash,
        },
      };
    });
    expect(await f.execute({ ...f.input, write: { action: "fund" } })).toMatchObject({
      ok: true,
      operation: { step: "v2-fund", state: "confirmed" },
    });
    expect(f.sign).toHaveBeenCalledTimes(2);
    expect(
      (await readSpendLedger(f.input.ledgerPath, new Date("2026-10-26T12:00:00Z"), f.input.wallet))
        .spentAtomic,
    ).toBe("100000000");
  });
  it("does not sign while order-only recovery is scanning", async () => {
    const f = await fixture();
    f.client.operationV2.mockResolvedValueOnce({
      ...f.prepared,
      recovered: false,
      scanComplete: false,
    });
    expect(await f.execute(f.input)).toMatchObject({ ok: true });
    expect(f.sleep).toHaveBeenCalledWith(1000);
    expect(f.sign).toHaveBeenCalledTimes(1);
  });
  it("polls order-only recovery/abandon and rejects a different order", async () => {
    const f = await fixture();
    const client = {
      operationV2: vi
        .fn()
        .mockResolvedValueOnce({
          orderId: V2_WRITE_ORDER,
          outcome: "scanning",
          operation: f.prepared.operation,
        })
        .mockResolvedValueOnce({ orderId: V2_WRITE_ORDER, outcome: "abandoned", operation: null }),
      getOrder: f.client.getOrder,
    } as unknown as TasksClient;
    const context = {
      client,
      chain: missingTasksChain,
      randomUUID: () => V2_WRITE_OPERATION,
      sleep: f.sleep,
      baseUrl: "https://tasks.example",
      signInHint: "test",
    };
    expect(
      await recoverTaskV2(context, {
        id: V2_WRITE_ORDER,
        operationId: V2_WRITE_OPERATION,
        step: "v2-approve",
        abandon: true,
      }),
    ).toMatchObject({ outcome: "abandoned", operation: null });
    expect(f.sleep).toHaveBeenCalledTimes(1);
    vi.mocked(client.operationV2!).mockResolvedValueOnce({
      ...v2WriteConfirmed,
      orderId: V2_WRITE_OPERATION,
    });
    await expect(
      recoverTaskV2(context, {
        id: V2_WRITE_ORDER,
        operationId: V2_WRITE_OPERATION,
        step: "v2-approve",
      }),
    ).rejects.toThrow("another task");
  });
  it("keeps an old adapter on the V1 path without making a V2 request", async () => {
    const getOrder = vi.fn();
    expect(
      await taskUsesV2({ client: { getOrder } as unknown as TasksClient }, V2_WRITE_ORDER),
    ).toBe(false);
    expect(getOrder).not.toHaveBeenCalled();
  });
});

describe("hosted EIP-712 consent", () => {
  it("signs only the returned consent and confirms it without broadcasting", async () => {
    const f = await fixture("v2-award");
    const typedData = {
      domain: {
        name: "vAPI EscrowV2",
        version: "1",
        chainId: 84532,
        verifyingContract: state.escrow,
      },
      types: {
        AwardConsent: [
          { name: "worker", type: "address" },
          { name: "termsDigest", type: "bytes32" },
          { name: "nonce", type: "uint256" },
          { name: "expiry", type: "uint64" },
        ],
      },
      primaryType: "AwardConsent",
      message: {
        worker: account.address,
        termsDigest: `0x${"12".repeat(32)}`,
        nonce: "0",
        expiry: (NOW_SECONDS + 300n).toString(),
      },
    };
    f.client.signV2.mockResolvedValue({
      kind: "eip712",
      signer: account.address,
      operationId: `sig_${V2_WRITE_OPERATION}`,
      typedData,
    });
    f.client.confirmV2Signature.mockResolvedValue({
      kind: "consent",
      workOrderId: V2_WRITE_ORDER,
      consent: "award",
      signer: account.address,
      expiry: (NOW_SECONDS + 300n).toString(),
    });
    const result = await f.execute({
      ...f.input,
      write: undefined,
      consent: { action: "award-consent" },
    });
    expect(result).toMatchObject({ ok: true, kind: "consent" });
    expect(f.typedSign).toHaveBeenCalledWith(typedData);
    expect(f.client.confirmV2Signature).toHaveBeenCalledWith(
      V2_WRITE_ORDER,
      `sig_${V2_WRITE_OPERATION}`,
      expect.stringMatching(/^0x/u),
      expect.any(Object),
    );
    expect(f.rpc.sendRawTransaction).not.toHaveBeenCalled();
  });
  it("refuses a consent naming another wallet", async () => {
    const f = await fixture();
    f.client.signV2.mockResolvedValue({
      kind: "eip712",
      signer: USDC,
      operationId: "sig_wrong",
      typedData: {
        domain: {
          name: "vAPI EscrowV2",
          version: "1",
          chainId: 84532,
          verifyingContract: state.escrow,
        },
        types: {},
        primaryType: "AwardConsent",
        message: {},
      },
    });
    await expect(
      f.execute({ ...f.input, write: undefined, consent: { action: "award-consent" } }),
    ).rejects.toThrow("another signer");
    expect(f.typedSign).not.toHaveBeenCalled();
    expect(f.rpc.sendRawTransaction).not.toHaveBeenCalled();
  });
});

describe("V2 amounts paid by the wallet", () => {
  it("reserves funding once before signing hosted authorization and transaction", async () => {
    const f = await fixture("v2-fund");
    const typedData = {
      domain: { name: "USD Coin", version: "2", chainId: 84532, verifyingContract: USDC },
      types: {
        ReceiveWithAuthorization: [
          { name: "from", type: "address" },
          { name: "to", type: "address" },
          { name: "value", type: "uint256" },
          { name: "validAfter", type: "uint256" },
          { name: "validBefore", type: "uint256" },
          { name: "nonce", type: "bytes32" },
        ],
      },
      primaryType: "ReceiveWithAuthorization",
      message: {
        from: account.address,
        to: state.escrow,
        value: "100000000",
        validAfter: (NOW_SECONDS - 1n).toString(),
        validBefore: (NOW_SECONDS + 300n).toString(),
        nonce: `0x${"12".repeat(32)}`,
      },
    };
    f.client.prepareV2.mockResolvedValue({
      kind: "eip712",
      signer: account.address,
      operationId: `sig_${V2_WRITE_OPERATION}`,
      escrow: state.escrow,
      typedData,
    });
    f.client.confirmV2Signature.mockImplementation(
      async (_id: string, _op: string, signature: `0x${string}`) => {
        f.prepared.operation.plan.to = FACTORY;
        f.prepared.operation.plan.data = encodeFunctionData({
          abi: escrowFactoryV2Abi,
          functionName: "createAndFundWithAuthorization",
          args: [
            ...creationArgs(),
            account.address,
            NOW_SECONDS - 1n,
            NOW_SECONDS + 300n,
            typedData.message.nonce as `0x${string}`,
            signature,
          ],
        });
        return f.prepared;
      },
    );
    expect(await f.execute({ ...f.input, write: { action: "fund" } })).toMatchObject({
      ok: true,
      operation: { state: "confirmed" },
    });
    expect(f.typedSign).toHaveBeenCalledWith(typedData);
    expect(f.sign).toHaveBeenCalledTimes(1);
    expect(
      (await readSpendLedger(f.input.ledgerPath, new Date("2026-10-26T12:00:00Z"), f.input.wallet))
        .spentAtomic,
    ).toBe("100000000");
  });
  it("applies the task cap to the returned dispute fee rather than the escrow total", async () => {
    const f = await fixture("v2-raise-dispute");
    expect(
      await f.execute({
        ...f.input,
        write: { action: "raise-dispute", i: 0, evidence: "Proof text" },
        policy: { maxPerTaskUsd: 25, approveAboveUsd: 25 },
      }),
    ).toMatchObject({ ok: true, money: { gross: { usd: "20.00" } } });
    expect(f.rpc.readContract).toHaveBeenCalledWith(
      expect.objectContaining({ functionName: "disputeFee", args: [0] }),
    );
    expect(
      (await readSpendLedger(f.input.ledgerPath, new Date("2026-10-26T12:00:00Z"), f.input.wallet))
        .spentAtomic,
    ).toBe("20000000");
  });
});

it("refuses to broadcast signed bytes that differ from the hosted plan", async () => {
  const f = await fixture();
  const wrong = await account.signTransaction({
    chainId: 84532,
    to: USDC,
    data: "0x1234",
    value: 0n,
    nonce: 0,
    gas: 100000n,
    type: "eip1559",
    maxFeePerGas: 10n,
    maxPriorityFeePerGas: 1n,
  });
  f.sign.mockClear().mockResolvedValueOnce(wrong);
  await expect(f.execute(f.input)).rejects.toThrow("signed transaction differs");
  expect(f.rpc.sendRawTransaction).not.toHaveBeenCalled();
  expect(await f.pending.get(V2_WRITE_OPERATION, "v2-approve")).toBeUndefined();
});

describe("review: locally anchored V2 plans", () => {
  const transfer = () =>
    encodeFunctionData({
      abi: parseAbi(["function transfer(address,uint256) returns (bool)"]),
      functionName: "transfer",
      args: [USDC, 999999999n],
    });
  it.each(["transfer selector", "foreign contract", "wrong milestone", "unknown selector"])(
    "refuses %s disguised as milestone approval",
    async (attack) => {
      const f = await fixture();
      if (attack === "transfer selector") f.prepared.operation.plan.data = transfer();
      if (attack === "foreign contract") f.prepared.operation.plan.to = USDC;
      if (attack === "wrong milestone")
        f.prepared.operation.plan.data = encodeFunctionData({
          abi: escrowV2Abi,
          functionName: "approveMilestone",
          args: [1],
        });
      if (attack === "unknown selector") f.prepared.operation.plan.data = "0x01020304";
      await expect(f.execute(f.input)).rejects.toMatchObject({ code: "v2_plan_mismatch" });
      expect(f.sign).not.toHaveBeenCalled();
      expect(f.typedSign).not.toHaveBeenCalled();
      expect(f.rpc.sendRawTransaction).not.toHaveBeenCalled();
      await expect(readFile(f.input.ledgerPath)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );
  it("refuses an approval whose spender is foreign before reserving spend", async () => {
    const f = await fixture("v2-approve-usdc");
    f.prepared.operation.plan.to = USDC;
    f.prepared.operation.plan.data = encodeFunctionData({
      abi: parseAbi(["function approve(address,uint256) returns (bool)"]),
      functionName: "approve",
      args: [WORKER, 100000000n],
    });
    await expect(f.execute({ ...f.input, write: { action: "fund" } })).rejects.toThrow("spender");
    expect(f.sign).not.toHaveBeenCalled();
    await expect(readFile(f.input.ledgerPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("does not trust server readiness as a deployment pin", async () => {
    const f = await fixture();
    f.options.trustedV2Deployments = {};
    await expect(f.execute(f.input)).rejects.toMatchObject({ code: "v2_trust_unavailable" });
    expect(f.sign).not.toHaveBeenCalled();
    expect(f.rpc.readContract).not.toHaveBeenCalled();
  });
  it("logs explicit staging overrides and verifies factory membership", async () => {
    const f = await fixture();
    await f.execute(f.input);
    expect(f.notice).toHaveBeenCalledWith(expect.stringContaining("untrusted override"));
    expect(f.rpc.readContract).toHaveBeenCalledWith(
      expect.objectContaining({
        address: getAddress(FACTORY),
        functionName: "isEscrow",
        args: [getAddress(state.escrow)],
      }),
    );
  });
  it.each(["unregistered", "foreign poster", "foreign token"])(
    "refuses a locally unverified target: %s",
    async (attack) => {
      const f = await fixture();
      const original = f.rpc.readContract.getMockImplementation()!;
      f.rpc.readContract.mockImplementation(async (call) => {
        if (attack === "unregistered" && call.functionName === "isEscrow") return false;
        if (attack === "foreign poster" && call.functionName === "poster") return WORKER;
        if (attack === "foreign token" && call.functionName === "usdc") return WORKER;
        return original(call);
      });
      await expect(f.execute(f.input)).rejects.toMatchObject({ code: "v2_plan_mismatch" });
      expect(f.sign).not.toHaveBeenCalled();
      expect(f.typedSign).not.toHaveBeenCalled();
    },
  );
});

function fundingIntent() {
  return {
    kind: "eip712" as const,
    operationId: `sig_${V2_WRITE_OPERATION}`,
    signer: account.address,
    escrow: state.escrow,
    typedData: {
      domain: { name: "USD Coin", version: "2", chainId: 84532, verifyingContract: USDC },
      types: {
        ReceiveWithAuthorization: [
          { name: "from", type: "address" },
          { name: "to", type: "address" },
          { name: "value", type: "uint256" },
          { name: "validAfter", type: "uint256" },
          { name: "validBefore", type: "uint256" },
          { name: "nonce", type: "bytes32" },
        ],
      },
      primaryType: "ReceiveWithAuthorization",
      message: {
        from: account.address,
        to: state.escrow,
        value: "100000000",
        validAfter: (NOW_SECONDS - 1n).toString(),
        validBefore: (NOW_SECONDS + 300n).toString(),
        nonce: `0x${"12".repeat(32)}`,
      },
    },
  };
}
describe("review: funding authorizations", () => {
  it.each([
    "recipient",
    "unregistered recipient",
    "domain name",
    "domain version",
    "domain token",
    "domain chain",
    "value",
    "nonce",
    "schema",
    "future start",
    "expired",
    "unbounded window",
    "stale start",
    "onchain domain",
    "review window",
    "prediction",
    "self-consistent API",
    "accepted terms",
  ])("refuses %s before signing or reserving", async (attack) => {
    const f = await fixture("v2-fund");
    const intent = fundingIntent();
    const { domain, message, types } = intent.typedData;
    if (attack === "recipient") {
      intent.escrow = WORKER;
      message.to = WORKER;
    }
    if (attack === "unregistered recipient") {
      f.rpc.readContract.mockImplementation(async (call) =>
        call.functionName === "usdc" ? USDC : false,
      );
    }
    if (attack === "domain name") domain.name = "Evil Coin";
    if (attack === "domain version") domain.version = "3";
    if (attack === "domain token") domain.verifyingContract = WORKER;
    if (attack === "domain chain") domain.chainId = 1;
    if (attack === "value") message.value = "100000001";
    if (attack === "nonce") message.nonce = "0x12";
    if (attack === "schema") types.ReceiveWithAuthorization[0]!.type = "bytes32";
    if (attack === "future start") message.validAfter = (NOW_SECONDS + 1n).toString();
    if (attack === "expired") message.validBefore = (NOW_SECONDS - 1n).toString();
    if (attack === "unbounded window") message.validBefore = (NOW_SECONDS + 7200n).toString();
    if (attack === "stale start") message.validAfter = "0";
    if (attack === "review window") {
      const original = f.rpc.readContract.getMockImplementation()!;
      f.rpc.readContract.mockImplementation(async (call) =>
        call.functionName === "reviewWindow" ? 86400n : original(call),
      );
    }
    if (attack === "prediction") {
      const original = f.rpc.readContract.getMockImplementation()!;
      f.rpc.readContract.mockImplementation(async (call) =>
        call.functionName === "predictEscrow" ? WORKER : original(call),
      );
    }
    if (attack === "self-consistent API") {
      intent.escrow = WORKER;
      message.to = WORKER;
      domain.verifyingContract = WORKER;
      f.view.workOrder.v2State.escrow = WORKER;
      f.client.deployment.mockResolvedValue({ ...(await f.client.deployment()), usdc: WORKER });
      const original = f.rpc.readContract.getMockImplementation()!;
      f.rpc.readContract.mockImplementation(async (call) =>
        call.functionName === "isEscrow" ? false : original(call),
      );
    }
    if (attack === "onchain domain" || attack === "accepted terms") {
      const original = f.rpc.readContract.getMockImplementation()!;
      f.rpc.readContract.mockImplementation(async (call) =>
        call.functionName === (attack === "onchain domain" ? "name" : "termsHash")
          ? attack === "onchain domain"
            ? "Evil Coin"
            : `0x${"ff".repeat(32)}`
          : original(call),
      );
    }
    f.client.prepareV2.mockResolvedValue(intent);
    await expect(f.execute({ ...f.input, write: { action: "fund" } })).rejects.toBeInstanceOf(
      Error,
    );
    expect(f.sign).not.toHaveBeenCalled();
    expect(f.typedSign).not.toHaveBeenCalled();
    expect(f.rpc.sendRawTransaction).not.toHaveBeenCalled();
    await expect(readFile(f.input.ledgerPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("review: settlement and refund previews", () => {
  it.each(["worker", "poster"])(
    "previews unmatched settlement to the %s with verified state",
    async (winner) => {
      const f = await fixture("v2-resolve-unmatched");
      const raisedBy = winner === "worker" ? WORKER : account.address;
      f.view.workOrder.v2State.milestones[0]!.status = "disputed";
      f.view.workOrder.v2State.milestones[0]!.dispute = {
        stage: "Raised",
        matched: false,
        raisedBy,
      };
      f.rpc.getLogs.mockResolvedValue([{ args: { raisedBy } }]);
      f.prepared.operation.plan.data = encodeFunctionData({
        abi: escrowV2Abi,
        functionName: "resolveUnmatched",
        args: [0],
      });
      const preview = vi.fn();
      expect(
        await f.execute({
          ...f.input,
          write: { action: "resolve-unmatched", i: 0 },
          onMoney: preview,
        }),
      ).toMatchObject({
        ok: true,
        money: {
          gross: { usd: "100.00" },
          fee: { usd: winner === "worker" ? "5.00" : "0.00" },
          net: { usd: winner === "worker" ? "95.00" : "100.00" },
        },
      });
      expect(preview.mock.invocationCallOrder[0]).toBeLessThan(f.sign.mock.invocationCallOrder[0]!);
    },
  );
  it.each(["no snapshot", "no dispute", "matched", "unclosed window", "unverified opener"])(
    "refuses unmatched settlement with %s",
    async (reason) => {
      const f = await fixture("v2-resolve-unmatched");
      f.view.workOrder.v2State.milestones[0]!.status = "disputed";
      f.view.workOrder.v2State.milestones[0]!.dispute = {
        stage: "Raised",
        matched: false,
        raisedBy: WORKER,
      };
      if (reason === "no snapshot")
        f.client.getOrder.mockResolvedValueOnce({
          ...f.view,
          workOrder: { ...f.view.workOrder, v2State: undefined },
        } as unknown as ReturnType<typeof fullView>);
      if (reason === "no dispute") f.view.workOrder.v2State.milestones[0]!.dispute = undefined;
      if (reason === "matched")
        f.view.workOrder.v2State.milestones[0]!.dispute = {
          stage: "Matched",
          matched: true,
          raisedBy: WORKER,
        };
      if (reason === "unclosed window") {
        const original = f.rpc.readContract.getMockImplementation()!;
        f.rpc.readContract.mockImplementation(async (call) =>
          call.functionName === "deadlines" ? [NOW_SECONDS + 1n, 0n, 0n, 0n] : original(call),
        );
      }
      if (reason === "unverified opener") f.rpc.getLogs.mockResolvedValue([]);
      await expect(
        f.execute({ ...f.input, write: { action: "resolve-unmatched", i: 0 } }),
      ).rejects.toBeInstanceOf(Error);
      expect(f.sign).not.toHaveBeenCalled();
      expect(f.rpc.sendRawTransaction).not.toHaveBeenCalled();
    },
  );
  it.each(["refund", "cancel-remainder"] as const)(
    "computes %s eligibility separately across mixed statuses",
    async (action) => {
      const f = await fixture(action === "refund" ? "v2-refund" : "v2-cancel-remainder");
      f.view.workOrder.v2State.milestones = [
        "pending",
        "submitted",
        "disputed",
        "released",
        "refunded",
      ].map((status, i) => ({
        amountBaseUnits: String((i + 1) * 10000000),
        status,
        dispute: undefined,
      }));
      f.view.workOrder.v2State.totalBaseUnits = "150000000";
      f.prepared.operation.plan.data =
        action === "refund"
          ? encodeFunctionData({ abi: escrowV2Abi, functionName: "refundRemainder" })
          : encodeFunctionData({ abi: escrowV2Abi, functionName: "cancelRemainder" });
      expect(await f.execute({ ...f.input, write: { action } })).toMatchObject({
        ok: true,
        money: { gross: { usd: action === "refund" ? "30.00" : "10.00" }, fee: { usd: "0.00" } },
      });
    },
  );
});

it("resumes the supplied post funding operation after approval refusal without preparing again", async () => {
  const f = await fixture("v2-approve-usdc");
  f.prepared.operation.plan.to = USDC;
  f.prepared.operation.plan.data = encodeFunctionData({
    abi: parseAbi(["function approve(address,uint256) returns (bool)"]),
    functionName: "approve",
    args: [FACTORY, 100000000n],
  });
  const postKey = "33333333-3333-4333-8333-333333333333";
  const policy = { maxPerTaskUsd: 200, approveAboveUsd: 50 };
  expect(
    await f.execute({
      ...f.input,
      write: { action: "fund" },
      prepared: f.prepared,
      preparationKey: postKey,
      policy,
    }),
  ).toMatchObject({ approval: true });
  const journal = await f.pending.preparation(V2_WRITE_ORDER, 'v2:{"action":"fund"}');
  expect(journal).toMatchObject({
    idempotencyKey: postKey,
    preparedV2: { operation: { id: V2_WRITE_OPERATION } },
  });
  f.client.prepareV2.mockRejectedValue(
    new TasksClientError("http", "already prepared", 409, "operation_in_progress"),
  );
  let current = f.prepared;
  f.client.operationV2.mockImplementation(async (_id, mode, body) => {
    if (mode === "recover") return { ...current, recovered: false, scanComplete: true };
    if (mode === "reconcile" && current.operation.step === "v2-approve-usdc") {
      current = {
        ...current,
        operation: {
          ...current.operation,
          step: "v2-fund",
          plan: { ...current.operation.plan, step: "v2-fund", to: FACTORY, data: FUND_DATA() },
        },
      };
      return current;
    }
    return {
      ...current,
      operation: {
        ...current.operation,
        state: mode === "transaction" ? "submitted" : "confirmed",
        transactionHash: body.transactionHash,
      },
    };
  });
  const context = {
    client: f.client as unknown as TasksClient,
    chain: { ...missingTasksChain, executeV2: f.execute },
    pending: f.pending,
    randomUUID: () => postKey,
    baseUrl: "https://tasks.example",
    signInHint: "test",
  };
  expect(
    await executeTaskV2(context, {
      ...f.input,
      write: { action: "fund" },
      policy,
      approval: { granted: true },
    }),
  ).toMatchObject({ ok: true, operation: { state: "confirmed" } });
  expect(f.client.prepareV2).not.toHaveBeenCalled();
  expect(f.sign).toHaveBeenCalledTimes(2);
});

it.each(["bounty", "pool"] as const)(
  "checks the %s reward against the verified contract before a payout signature",
  async (shape) => {
    const f = await fixture(shape === "bounty" ? "v2-award-bounty" : "v2-pay-claim");
    const terms =
      shape === "bounty"
        ? {
            shape,
            bounty: { winners: 5, rewardPerWinnerBaseUnits: "20000000", deadlineAt: DEADLINE },
          }
        : {
            shape,
            pool: {
              rewardPerClaimBaseUnits: "20000000",
              budgetBaseUnits: "100000000",
              gate: "proven",
              verifier: "poster",
            },
          };
    f.client.getOrder.mockResolvedValue({
      ...f.view,
      workOrder: { ...f.view.workOrder, terms },
    } as unknown as ReturnType<typeof fullView>);
    const original = f.rpc.readContract.getMockImplementation()!;
    f.rpc.readContract.mockImplementation(async (call) =>
      ["rewardPerWinner", "rewardPerClaim"].includes(call.functionName)
        ? 30000000n
        : original(call),
    );
    f.prepared.operation.plan.data =
      shape === "bounty"
        ? encodeFunctionData({ abi: escrowV2Abi, functionName: "awardBounty", args: [[WORKER]] })
        : encodeFunctionData({
            abi: bountyPoolV1Abi,
            functionName: "payClaim",
            args: [WORKER, `0x${"12".repeat(32)}`],
          });
    const write =
      shape === "bounty"
        ? { action: "award-bounty" as const, winners: [WORKER] }
        : { action: "pay-claim" as const, claimant: WORKER };
    await expect(f.execute({ ...f.input, write })).rejects.toThrow("reward differs");
    expect(f.sign).not.toHaveBeenCalled();
    expect(f.rpc.sendRawTransaction).not.toHaveBeenCalled();
  },
);
