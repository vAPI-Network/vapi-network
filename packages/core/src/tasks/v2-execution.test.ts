import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { encodeFunctionData, keccak256, parseAbi, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createTasksClient, TasksClientError, type TasksClient } from "./client.js";
import { createPendingTransactions } from "./pending-transactions.js";
import {
  createTaskV2Executor,
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
const state = {
  escrow: v2WritePrepared.operation.plan.to,
  feeBp: 500,
  totalBaseUnits: "100000000",
  paidBaseUnits: "0",
  refundedBaseUnits: "0",
  milestones: [{ amountBaseUnits: "100000000", status: "submitted" }],
};
async function fixture(step: TaskV2OperationResponse["operation"]["step"] = "v2-approve") {
  const home = await mkdtemp(join(tmpdir(), "vapi-v2-write-"));
  homes.push(home);
  const prepared = taskV2OperationResponseSchema.parse({
    ...v2WritePrepared,
    operation: {
      ...v2WritePrepared.operation,
      expectedActor: account.address,
      step,
      plan: { ...v2WritePrepared.operation.plan, from: account.address, step },
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
    readContract: vi.fn(async () => 20000000n),
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
    getOrder: vi.fn(async () => ({
      workOrder: {
        id: V2_WRITE_ORDER,
        terms: { shape: "task", milestones: [{ index: 1, amountBaseUnits: "100000000" }] },
        v2State: state,
      },
      lifecycle: { shape: "task", state: "Active" },
      nextAction: { action: "none" },
    })),
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
  const execute = createTaskV2Executor({
    client: client as unknown as TasksClient,
    account,
    pending,
    rpcFor: () => rpc as unknown as PublicClient,
    sleep,
    now: () => new Date("2026-10-26T12:00:00Z"),
  });
  const input: TaskV2ExecutionInput = {
    id: V2_WRITE_ORDER,
    write: { action: "approve", i: 0 },
    policy: { maxPerTaskUsd: 200, approveAboveUsd: 200 },
    caps: { perCallAtomic: "1", perDayAtomic: "200000000" },
    wallet: "worker" as WalletName,
    ledgerPath: join(home, "spend-ledger.json"),
  };
  return { execute, input, client, rpc, pending, home, prepared, sign, typedSign, sleep };
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
      args: [v2WritePrepared.operation.plan.to, 100000000n],
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
      args: [v2WritePrepared.operation.plan.to, 100000000n],
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
              to: v2WritePrepared.operation.plan.to,
              data: "0x1234",
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
      domain: { name: "EscrowV2", version: "1", chainId: 84532, verifyingContract: state.escrow },
      types: {
        AwardConsent: [
          { name: "worker", type: "address" },
          { name: "termsDigest", type: "bytes32" },
          { name: "nonce", type: "uint256" },
          { name: "expiry", type: "uint256" },
        ],
      },
      primaryType: "AwardConsent",
      message: {
        worker: account.address,
        termsDigest: `0x${"12".repeat(32)}`,
        nonce: "0",
        expiry: "2000000000",
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
      expiry: "2000000000",
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
        domain: { name: "EscrowV2", version: "1", chainId: 84532, verifyingContract: state.escrow },
        types: {},
        primaryType: "AwardConsent",
        message: {},
      },
    });
    await expect(
      f.execute({ ...f.input, write: undefined, consent: { action: "award-consent" } }),
    ).rejects.toThrow("another wallet");
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
        validAfter: "0",
        validBefore: "2000000000",
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
    f.client.confirmV2Signature.mockResolvedValue(f.prepared);
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
