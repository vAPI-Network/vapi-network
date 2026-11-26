import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  encodeFunctionData,
  decodeFunctionData,
  keccak256,
  parseAbi,
  type Abi,
  type Hex,
  type PublicClient,
  getAddress,
  parseTransaction,
  toHex,
  zeroAddress,
  zeroHash,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createTasksClient, TasksClientError, type TasksClient } from "./client.js";
import {
  escrowFactoryV2Abi,
  escrowV2Abi,
  bountyEscrowV2Abi,
  bountyPoolV1Abi,
  reviewerRegistryV2Abi,
} from "./v2-abi.js";
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
  type TaskV2Action,
} from "./v2-write.js";
import {
  v2WritePrepared,
  v2WriteConfirmed,
  v2WriteScanning,
  v2WriteSubmitted,
  V2_WRITE_ORDER,
  V2_WRITE_OPERATION,
} from "./fixtures/tasks-v2-writes.js";
import { publicTaskV2Operation } from "./v2-public.js";
import { TRUSTED_TASKS_V2_DEPLOYMENTS, type TasksV2Deployment } from "./v2-trust.js";
import { canonicalJson } from "./canonical-json.js";
import { prepareTransactionRequest } from "viem/actions";
import { missingTasksChain } from "./chain-port.js";
import { readSpendLedger, reserveSpend } from "../spend-policy.js";
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
const IMPLEMENTATION = `0x${"67".repeat(20)}` as const;
const WORKER = `0x${"88".repeat(20)}` as const;
const RESOLVER = `0x${"99".repeat(20)}` as const;
const NOW_SECONDS = BigInt(Date.parse("2026-10-26T12:00:00Z") / 1000);
const DEADLINE = "2026-10-28T12:00:00.000Z";
const PIN = {
  escrowFactoryV2: FACTORY,
  disputeResolverV3: RESOLVER,
  bountyPoolFactoryV1: POOL_FACTORY,
  usdc: USDC,
  usdcName: "USD Coin",
  usdcVersion: "2",
  offerTtlSeconds: 86400,
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
/** IEscrowV2.Terms fields; the fixture answers terms() from one pseudo read per field. */
const TERM_FIELDS = [
  "shape",
  "poster",
  "worker",
  "termsHash",
  "offerTtl",
  "reviewWindow",
  "choiceWindow",
  "bountyDeadline",
  "objectionWindow",
  "workerBondBp",
  "feeBp",
  "winners",
  "rewardPerWinner",
] as const;
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
/** vapi-app v2TermsFromOrder for the fixture order: the exact EscrowFactoryV2 creation inputs. */
function creationArgs(view = fullView(), pin: TasksV2Deployment = PIN, feeBp = 500) {
  return [
    {
      shape: 0,
      poster: account.address,
      worker: zeroAddress,
      termsHash: acceptedV2TermsHash(
        view as unknown as import("./types.js").GetOrderResponse,
        pin,
        604800n,
      ),
      offerTtl: BigInt(pin.offerTtlSeconds ?? 604800),
      reviewWindow: 604800n,
      choiceWindow: 0n,
      bountyDeadline: 0n,
      objectionWindow: 604800n,
      workerBondBp: 0,
      feeBp,
      winners: 0,
      rewardPerWinner: 0n,
    },
    [
      {
        amount: 100000000n,
        deadline: BigInt(Date.parse(DEADLINE) / 1000),
        status: 0,
        deliveryHash: zeroHash,
      },
    ],
    keccak256(toHex(V2_WRITE_ORDER)),
  ] as const;
}
const CREATE_DATA = () =>
  encodeFunctionData({
    abi: escrowFactoryV2Abi,
    functionName: "createEscrow",
    args: creationArgs(),
  });
const FUND_DATA = () => encodeFunctionData({ abi: escrowV2Abi, functionName: "fund" });
const HASH_EVIDENCE = (s: string) => keccak256(toHex(JSON.stringify(s)));
type PlannedResponse = TaskV2OperationResponse & {
  operation: { plan: NonNullable<TaskV2OperationResponse["operation"]["plan"]> };
};
/**
 * What the hosted journal really returns: the plan only for a prepared, validated step. A
 * submitted or confirmed operation, and an unfinished recovery scan, carry `plan: null`. Every
 * mocked answer passes through this.
 */
function asHosted<T>(value: T): T {
  if (!value || typeof value !== "object" || !("operation" in value)) return value;
  const operation = (value as { operation: unknown }).operation;
  if (!operation || typeof operation !== "object" || !("state" in operation)) return value;
  const scanning = "scanComplete" in value && value.scanComplete === false;
  return operation.state !== "prepared" || scanning
    ? { ...value, operation: { ...operation, plan: null } }
    : value;
}
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
        to: v2WritePrepared.operation.plan.to,
      },
    },
  }) as PlannedResponse;
  const sign = vi.spyOn(account, "signTransaction");
  const typedSign = vi.spyOn(account, "signTypedData");
  type Read = { functionName: string; args?: readonly unknown[]; address?: string };
  const rpc = {
    getChainId: vi.fn(async () => 84532),
    getTransactionCount: vi.fn(async () => 0),
    sendRawTransaction: vi.fn(async ({ serializedTransaction }: { serializedTransaction: Hex }) =>
      keccak256(serializedTransaction),
    ),
    waitForTransactionReceipt: vi.fn(async () => ({ status: "success" })),
    getBlock: vi.fn(async () => ({ timestamp: NOW_SECONDS })),
    readContract: vi.fn(async (call: Read): Promise<unknown> => {
      const pool = view.workOrder.terms.shape === "pool";
      switch (call.functionName) {
        case "isEscrow":
        case "isPool":
          return true;
        case "paymentToken":
        case "USDC":
          return USDC;
        case "FACTORY":
          return pool ? POOL_FACTORY : FACTORY;
        case "implementation":
          return IMPLEMENTATION;
        case "name":
          return "USD Coin";
        case "version":
          return "2";
        case "terms": {
          // Each field is its own pseudo read so a test can override one of them.
          const terms: Record<string, unknown> = {};
          for (const field of TERM_FIELDS)
            terms[field] = await rpc.readContract({ ...call, functionName: `terms.${field}` });
          return terms;
        }
        case "terms.poster":
        case "poster":
          return account.address;
        case "terms.worker":
          return WORKER;
        case "terms.shape":
        case "terms.winners":
        case "terms.workerBondBp":
          return 0;
        case "terms.rewardPerWinner":
        case "terms.choiceWindow":
        case "terms.bountyDeadline":
          return 0n;
        case "terms.offerTtl":
          return 86400n;
        case "terms.reviewWindow":
        case "terms.objectionWindow":
          return 604800n;
        case "terms.feeBp":
        case "feeBp":
          return 500;
        case "terms.termsHash":
        case "termsHash":
          return acceptedV2TermsHash(
            view as unknown as import("./types.js").GetOrderResponse,
            PIN,
            pool ? 0n : 604800n,
          );
        case "totalPrincipal":
        case "budget":
          return BigInt(view.workOrder.v2State.totalBaseUnits);
        case "milestoneCount":
          return view.workOrder.v2State.milestones.length;
        case "milestone": {
          const m = view.workOrder.v2State.milestones[Number(call.args![0])]!;
          return {
            amount: BigInt(m.amountBaseUnits),
            deadline: BigInt(Date.parse(DEADLINE) / 1000),
            status: statuses.indexOf(m.status),
            deliveryHash: zeroHash,
          };
        }
        case "MIN_WORK_TIME":
          return 3600n;
        case "balanceOf":
          return 1_000_000_000_000n;
        case "disputeRounds":
          return 1;
        case "registry":
          return USDC;
        case "consentNonces":
          return 0n;
        case "disputeFee":
          return 20000000n;
        case "DISPUTE_RESOLVER":
          return RESOLVER;
        case "caseData":
          return {
            state: 1,
            raisedBy: WORKER,
            evidenceDeadline: NOW_SECONDS - 1n,
            commitDeadline: 0n,
            revealDeadline: 0n,
            drawBlock: 100n,
            rearms: 0,
          };
        case "submissionCommitment":
          return [`0x${"5e".repeat(32)}`, NOW_SECONDS - 10n, true];
        case "predictEscrow":
        case "predictBountyEscrow":
        case "predictPool":
          return state.escrow;
        default:
          throw new Error(`Unexpected RPC read ${call.functionName}`);
      }
    }),
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
  const hosted = new Proxy(client, {
    get(mock, name, receiver) {
      const value = Reflect.get(mock, name, receiver) as unknown;
      return name === "operationV2" || name === "confirmV2Signature"
        ? async (...args: unknown[]) =>
            asHosted(await (value as (...a: unknown[]) => Promise<unknown>)(...args))
        : value;
    },
  });
  const options: TasksChainOptions = {
    client: hosted as unknown as TasksClient,
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

/**
 * The hosted fresh-funding sequence (vapi-app funding preparation): createEscrow on the
 * pinned factory, then approve the clone, then fund() on the clone. The clone is unregistered
 * until the creation transaction confirms.
 */
function freshFunding(
  f: Awaited<ReturnType<typeof fixture>>,
  createData = CREATE_DATA(),
  pin: Pick<TasksV2Deployment, "escrowFactoryV2" | "usdc"> = PIN,
) {
  f.prepared.operation.step = "v2-create-escrow";
  f.prepared.operation.plan.step = "v2-create-escrow";
  f.prepared.operation.plan.to = pin.escrowFactoryV2.toLowerCase() as Hex;
  f.prepared.operation.plan.data = createData;
  let registered = false;
  const registrations: boolean[] = [];
  const original = f.rpc.readContract.getMockImplementation()!;
  f.rpc.readContract.mockImplementation(async (call) => {
    if (call.functionName === "isEscrow") {
      registrations.push(registered);
      return registered;
    }
    if (!registered && call.address?.toLowerCase() === state.escrow.toLowerCase())
      throw new Error("Cannot read the escrow before creation");
    return original(call);
  });
  f.rpc.waitForTransactionReceipt.mockImplementation(async () => {
    if (f.rpc.sendRawTransaction.mock.calls.length === 1) registered = true;
    return { status: "success" };
  });
  const approval = encodeFunctionData({
    abi: parseAbi(["function approve(address,uint256) returns (bool)"]),
    functionName: "approve",
    args: [state.escrow, BigInt(f.view.workOrder.v2State.totalBaseUnits)],
  });
  let current = f.prepared;
  const advance = (step: "v2-approve-usdc" | "v2-fund", to: string, data: Hex) => {
    current = {
      ...current,
      operation: {
        ...current.operation,
        step,
        plan: { ...current.operation.plan, step, to: to.toLowerCase() as Hex, data },
      },
    };
    return current;
  };
  f.client.operationV2.mockImplementation(async (_id, mode, body) => {
    if (mode === "recover") return { ...current, recovered: false, scanComplete: true };
    if (mode === "reconcile" && current.operation.step === "v2-create-escrow")
      return advance("v2-approve-usdc", pin.usdc, approval);
    if (mode === "reconcile" && current.operation.step === "v2-approve-usdc")
      return advance("v2-fund", state.escrow, FUND_DATA());
    return {
      ...current,
      operation: {
        ...current.operation,
        state: mode === "transaction" ? "submitted" : "confirmed",
        transactionHash: body.transactionHash,
      },
    };
  });
  return { registrations, registered: () => registered };
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
  it("parses what the API sends after broadcast: no plan once submitted or confirmed", async () => {
    // The hosted journal answers with `plan: null` unless the step is prepared and validated.
    // 0.16.0 required an object and reported a mined step as failed.
    for (const sent of [v2WriteSubmitted, v2WriteConfirmed]) {
      const parsed = taskV2OperationResponseSchema.parse(sent);
      expect(parsed.operation.plan).toBeNull();
      expect(publicTaskV2Operation(parsed.operation)).toMatchObject({
        state: sent.operation.state,
        plan: null,
      });
    }
    expect(taskV2RecoverySchema.parse(v2WriteScanning).operation.plan).toBeNull();
    expect(
      taskV2RecoverySchema.parse({ ...v2WriteConfirmed, recovered: true, scanComplete: true })
        .operation.plan,
    ).toBeNull();
    // A plan that is present must still bind to its operation, step and actor.
    expect(
      taskV2OperationResponseSchema.safeParse({
        ...v2WritePrepared,
        operation: {
          ...v2WritePrepared.operation,
          plan: { ...v2WritePrepared.operation.plan, from: `0x${"99".repeat(20)}` },
        },
      }).success,
    ).toBe(false);
    // A submitted step without a transaction hash stays invalid.
    expect(
      taskV2OperationResponseSchema.safeParse({
        ...v2WriteSubmitted,
        operation: { ...v2WriteSubmitted.operation, transactionHash: null },
      }).success,
    ).toBe(false);
    const sent = [v2WriteSubmitted, v2WriteConfirmed, v2WriteScanning];
    const fetch = vi.fn(async () => Response.json(sent.shift()));
    const client = createTasksClient({ baseUrl: "https://tasks.example", fetch });
    const call = { idempotencyKey: V2_WRITE_OPERATION };
    const body = {
      step: "v2-approve",
      transactionHash: v2WriteSubmitted.operation.transactionHash,
    };
    expect(await client.operationV2(V2_WRITE_OPERATION, "transaction", body, call)).toMatchObject({
      operation: { state: "submitted", plan: null },
    });
    expect(await client.operationV2(V2_WRITE_OPERATION, "reconcile", body, call)).toMatchObject({
      operation: { state: "confirmed", plan: null },
    });
    expect(
      await client.operationV2(V2_WRITE_OPERATION, "recover", { step: "v2-approve" }, call),
    ).toMatchObject({ scanComplete: false, operation: { state: "prepared", plan: null } });
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
    expect(money).toHaveBeenCalledWith(
      expect.objectContaining({
        escrow: state.escrow,
        line: expect.stringContaining(state.escrow),
      }),
    );
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
      args: [state.escrow, 100000000n],
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
      args: [state.escrow, 100000000n],
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
              to: state.escrow,
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
  it("reports a mined step as confirmed when the API answers without a plan", async () => {
    const f = await fixture();
    const answers: unknown[] = [];
    const answer = f.client.operationV2.getMockImplementation()!;
    f.client.operationV2.mockImplementation(async (...args) => {
      const value = asHosted(await answer(...args));
      answers.push(value);
      return value;
    });
    const result = await f.execute(f.input);
    expect(result).toMatchObject({
      ok: true,
      orderId: V2_WRITE_ORDER,
      operation: { state: "confirmed", step: "v2-approve", plan: null },
    });
    // recover (plan), transaction (submitted, no plan), reconcile (confirmed, no plan).
    expect(answers).toMatchObject([
      { operation: { state: "prepared", plan: { step: "v2-approve" } } },
      { operation: { state: "submitted", plan: null } },
      { operation: { state: "confirmed", plan: null } },
    ]);
    expect(f.sign).toHaveBeenCalledTimes(1);
    expect(f.rpc.sendRawTransaction).toHaveBeenCalledTimes(1);
  });
  it("finishes a resumed step the API already holds as submitted, without signing again", async () => {
    const f = await fixture();
    // A retried prepare returns the journal record as it is now: submitted, no plan.
    f.client.prepareV2.mockResolvedValue({
      ...f.prepared,
      operation: {
        ...f.prepared.operation,
        state: "submitted",
        transactionHash: v2WriteSubmitted.operation.transactionHash,
        plan: null,
      },
    });
    expect(await f.execute(f.input)).toMatchObject({
      ok: true,
      operation: { state: "confirmed", plan: null },
    });
    expect(f.sign).not.toHaveBeenCalled();
    expect(f.rpc.sendRawTransaction).not.toHaveBeenCalled();
    expect(f.client.operationV2).toHaveBeenCalledWith(
      V2_WRITE_OPERATION,
      "reconcile",
      { step: "v2-approve", transactionHash: v2WriteSubmitted.operation.transactionHash },
      expect.anything(),
    );
  });
  it("refuses a plan that changed while a recovery scan answered without one", async () => {
    const f = await fixture();
    f.client.operationV2
      .mockResolvedValueOnce({ ...f.prepared, recovered: false, scanComplete: false })
      .mockResolvedValueOnce({
        ...f.prepared,
        operation: {
          ...f.prepared.operation,
          plan: {
            ...f.prepared.operation.plan,
            data: encodeFunctionData({
              abi: escrowV2Abi,
              functionName: "approveMilestone",
              args: [1],
            }),
          },
        },
        recovered: false,
        scanComplete: true,
      });
    await expect(f.execute(f.input)).rejects.toThrow("Recovery changed the prepared plan.");
    expect(f.sign).not.toHaveBeenCalled();
  });
  it("refuses a prepared step that never carries a plan", async () => {
    const f = await fixture();
    f.client.operationV2.mockResolvedValue({
      ...f.prepared,
      operation: { ...f.prepared.operation, plan: null },
      recovered: false,
      scanComplete: true,
    });
    await expect(f.execute(f.input)).rejects.toThrow("carries no plan to sign");
    expect(f.sign).not.toHaveBeenCalled();
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

async function consentFixture(split = false) {
  const f = await fixture("v2-award");
  f.view.workOrder.clientAddress = WORKER;
  const original = f.rpc.readContract.getMockImplementation()!;
  f.rpc.readContract.mockImplementation(async (call) =>
    call.functionName === "terms.poster"
      ? WORKER
      : call.functionName === "terms.worker"
        ? `0x${"00".repeat(20)}`
        : original(call),
  );
  const typedData = {
    domain: {
      name: "vAPI Tasks Escrow",
      version: "2",
      chainId: 84532,
      verifyingContract: state.escrow,
    },
    types: {
      AwardConsent: [
        { name: "escrow", type: "address" },
        { name: "worker", type: "address" },
        { name: "termsHash", type: "bytes32" },
        { name: "nonce", type: "uint256" },
        { name: "expiry", type: "uint64" },
      ],
    },
    primaryType: "AwardConsent",
    message: {
      escrow: state.escrow,
      worker: account.address,
      termsHash: acceptedV2TermsHash(
        f.view as unknown as import("./types.js").GetOrderResponse,
        PIN,
        604800n,
      ),
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

  if (split) {
    const read = f.rpc.readContract.getMockImplementation()!;
    f.rpc.readContract.mockImplementation(async (call) =>
      call.functionName === "terms.worker" ? account.address : read(call),
    );
    f.client.signV2.mockResolvedValue({
      kind: "eip712",
      signer: account.address,
      operationId: `sig_${V2_WRITE_OPERATION}`,
      typedData: {
        ...typedData,
        primaryType: "SplitConsent",
        types: {
          SplitConsent: [
            { name: "escrow", type: "address" },
            { name: "milestone", type: "uint8" },
            { name: "round", type: "uint32" },
            { name: "toWorker", type: "uint96" },
            { name: "termsHash", type: "bytes32" },
            { name: "signer", type: "address" },
            { name: "nonce", type: "uint256" },
            { name: "expiry", type: "uint64" },
          ],
        },
        message: {
          escrow: state.escrow,
          milestone: 0,
          round: 0,
          toWorker: "1",
          termsHash: typedData.message.termsHash,
          signer: account.address,
          nonce: "0",
          expiry: typedData.message.expiry,
        },
      },
    });
    f.client.confirmV2Signature.mockResolvedValue({
      kind: "consent",
      workOrderId: V2_WRITE_ORDER,
      consent: "split",
      signer: account.address,
      expiry: typedData.message.expiry,
    });
  }
  const consent = split
    ? { action: "split-consent" as const, i: 0, toWorker: "1" }
    : { action: "award-consent" as const };
  return { ...f, consent, typedData };
}

describe("hosted EIP-712 consent", () => {
  it("signs only the returned consent and confirms it without broadcasting", async () => {
    const f = await consentFixture();
    const { typedData } = f;
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
  it("does not say nothing was signed when a consent may have been signed and uploaded", async () => {
    const f = await consentFixture();
    const consent = { ...f.input, write: undefined, consent: { action: "award-consent" } as const };
    // Signed and uploaded; the answer is lost.
    f.client.confirmV2Signature.mockRejectedValueOnce(new Error("socket hang up"));
    await expect(f.execute(consent)).rejects.toMatchObject({ code: "chain_error" });
    expect(f.typedSign).toHaveBeenCalledTimes(1);
    const earlier = `This run signed nothing and moved no money. A consent this wallet signed earlier for this task may still be valid until it expires; vapi task bump-consent-nonce ${V2_WRITE_ORDER} --new-nonce <n> revokes it. Try again later.`;
    f.client.deployment.mockResolvedValue({
      configured: false,
      chainId: 84532,
      network: "eip155:84532",
    } as never);
    await expect(f.execute(consent)).rejects.toMatchObject({
      code: "tasks_unavailable",
      message: `vAPI reports Tasks as unavailable on Base Sepolia right now. ${earlier}`,
    });
    f.client.deployment.mockRejectedValue(new TasksClientError("network", "offline"));
    await expect(f.execute(consent)).rejects.toMatchObject({
      code: "tasks_unavailable",
      message: `vAPI's Tasks status could not be read. ${earlier}`,
    });
    // Hiring still waits: no second signature, no second upload.
    expect(f.typedSign).toHaveBeenCalledTimes(1);
    expect(f.client.confirmV2Signature).toHaveBeenCalledTimes(1);
  });
  it("refuses a consent naming another wallet", async () => {
    const f = await fixture();
    f.view.workOrder.clientAddress = WORKER;
    const original = f.rpc.readContract.getMockImplementation()!;
    f.rpc.readContract.mockImplementation(async (call) =>
      call.functionName === "terms.poster"
        ? WORKER
        : call.functionName === "terms.worker"
          ? `0x${"00".repeat(20)}`
          : original(call),
    );
    f.client.signV2.mockResolvedValue({
      kind: "eip712",
      signer: USDC,
      operationId: "sig_wrong",
      typedData: {
        domain: {
          name: "vAPI Tasks Escrow",
          version: "2",
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
        // The hosted authorization starts at 0 (vapi-app funding).
        validAfter: "0",
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
        // A registered clone is funded on the clone itself.
        f.prepared.operation.plan.data = encodeFunctionData({
          abi: escrowV2Abi,
          functionName: "fundWithAuthorization",
          args: [
            account.address,
            0n,
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

it("signs every V2 write with a 25% buffer over the gas estimate", async () => {
  const f = await fixture();
  expect(await f.execute(f.input)).toMatchObject({ ok: true });
  expect(f.sign).toHaveBeenCalledTimes(1);
  // The mocked node estimate is 100000.
  expect(f.sign.mock.calls[0]![0].gas).toBe(125000n);
  const saved = await f.pending.get(V2_WRITE_OPERATION, "v2-approve");
  expect(parseTransaction(saved!.raw as Hex).gas).toBe(125000n);
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
        if (attack === "foreign poster" && call.functionName === "terms.poster") return WORKER;
        if (attack === "foreign token" && call.functionName === "paymentToken") return WORKER;
        return original(call);
      });
      await expect(f.execute(f.input)).rejects.toMatchObject({ code: "v2_plan_mismatch" });
      expect(f.sign).not.toHaveBeenCalled();
      expect(f.typedSign).not.toHaveBeenCalled();
    },
  );
});

function fundingIntent(chainId = 84532, usdc: `0x${string}` = USDC) {
  return {
    kind: "eip712" as const,
    operationId: `sig_${V2_WRITE_OPERATION}`,
    signer: account.address,
    escrow: state.escrow,
    typedData: {
      domain: { name: "USD Coin", version: "2", chainId, verifyingContract: usdc },
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
        call.functionName === "paymentToken" ? USDC : false,
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
    if (attack === "review window") {
      const original = f.rpc.readContract.getMockImplementation()!;
      f.rpc.readContract.mockImplementation(async (call) =>
        call.functionName === "terms.reviewWindow" ? 86400n : original(call),
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
        call.functionName === (attack === "onchain domain" ? "name" : "terms.termsHash")
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
      const original = f.rpc.readContract.getMockImplementation()!;
      f.rpc.readContract.mockImplementation(async (call) =>
        call.functionName === "caseData"
          ? { ...((await original(call)) as object), raisedBy }
          : original(call),
      );
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
  it("refuses unmatched settlement through a resolver that differs from the local pin", async () => {
    const f = await fixture("v2-resolve-unmatched");
    f.view.workOrder.v2State.milestones[0]!.status = "disputed";
    f.view.workOrder.v2State.milestones[0]!.dispute = {
      stage: "Raised",
      matched: false,
      raisedBy: WORKER,
    };
    f.prepared.operation.plan.data = encodeFunctionData({
      abi: escrowV2Abi,
      functionName: "resolveUnmatched",
      args: [0],
    });
    const original = f.rpc.readContract.getMockImplementation()!;
    f.rpc.readContract.mockImplementation(async (call) =>
      // The clone's immutable resolver is the trust chain; it must match the local pin.
      call.functionName === "DISPUTE_RESOLVER" ? `0x${"aa".repeat(20)}` : original(call),
    );
    const preview = vi.fn();
    await expect(
      f.execute({
        ...f.input,
        write: { action: "resolve-unmatched", i: 0 },
        onMoney: preview,
      }),
    ).rejects.toMatchObject({
      code: "v2_plan_mismatch",
      message: "The verified escrow's dispute resolver differs from the local pin.",
    });
    expect(f.rpc.readContract.mock.calls.some(([call]) => call.functionName === "caseData")).toBe(
      false,
    );
    expect(preview).not.toHaveBeenCalled();
    expect(f.sign).not.toHaveBeenCalled();
    expect(f.typedSign).not.toHaveBeenCalled();
    expect(f.rpc.sendRawTransaction).not.toHaveBeenCalled();
    await expect(readFile(f.input.ledgerPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
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
          call.functionName === "caseData"
            ? { ...((await original(call)) as object), evidenceDeadline: NOW_SECONDS + 1n }
            : original(call),
        );
      }
      if (reason === "unverified opener") {
        const original = f.rpc.readContract.getMockImplementation()!;
        f.rpc.readContract.mockImplementation(async (call) =>
          call.functionName === "caseData"
            ? { ...((await original(call)) as object), raisedBy: USDC }
            : original(call),
        );
      }
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
      f.view.workOrder.market.budget.amountBaseUnits = "150000000";
      f.view.workOrder.terms.milestones = f.view.workOrder.v2State.milestones.map((m, i) => ({
        index: i + 1,
        amountBaseUnits: m.amountBaseUnits,
        acceptance: "A useful proof",
        deadlineAt: DEADLINE,
      }));
      if (action === "refund") {
        f.view.workOrder.clientAddress = WORKER;
        const original = f.rpc.readContract.getMockImplementation()!;
        f.rpc.readContract.mockImplementation(async (call) =>
          call.functionName === "terms.worker"
            ? account.address
            : call.functionName === "terms.poster"
              ? WORKER
              : original(call),
        );
      }
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
  const fresh = freshFunding(f);
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
  expect(f.sign).toHaveBeenCalledTimes(3);
  expect(fresh.registrations[0]).toBe(false);
  expect(fresh.registered()).toBe(true);
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
    Object.assign(f.view.workOrder, {
      terms,
      market: { ...f.view.workOrder.market, deadlineAt: DEADLINE },
    });
    const original = f.rpc.readContract.getMockImplementation()!;
    f.rpc.readContract.mockImplementation(async (call) => {
      if (["terms.rewardPerWinner", "rewardPerClaim"].includes(call.functionName)) return 30000000n;
      if (call.functionName === "terms.shape") return 1;
      if (call.functionName === "terms.winners") return 5;
      if (call.functionName === "verifier") return account.address;
      if (call.functionName === "gate") return 0;
      if (call.functionName === "deadline") return BigInt(Date.parse(DEADLINE) / 1000);
      return original(call);
    });
    f.prepared.operation.plan.data =
      shape === "bounty"
        ? encodeFunctionData({
            abi: bountyEscrowV2Abi,
            functionName: "awardBounty",
            args: [[WORKER], [`0x${"5e".repeat(32)}`]],
          })
        : encodeFunctionData({
            abi: bountyPoolV1Abi,
            functionName: "payClaim",
            args: [WORKER, `0x${"12".repeat(32)}`],
          });
    const write =
      shape === "bounty"
        ? { action: "award-bounty" as const, winners: [WORKER] }
        : { action: "pay-claim" as const, claimant: WORKER };
    await expect(f.execute({ ...f.input, write })).rejects.toThrow(/accepted|reward differs/u);
    expect(f.sign).not.toHaveBeenCalled();
    expect(f.rpc.sendRawTransaction).not.toHaveBeenCalled();
  },
);

describe("repair2: bind every registered action to its accepted order and role", () => {
  it.each(["different terms", "identical terms, different order salt"])(
    "refuses task A approval routed to registered escrow B with %s and the same poster",
    async (attack) => {
      const f = await fixture();
      const other = `0x${"ab".repeat(20)}` as const;
      f.view.workOrder.v2State.escrow = other;
      f.prepared.operation.plan.to = other;
      const original = f.rpc.readContract.getMockImplementation()!;
      f.rpc.readContract.mockImplementation(async (call) => {
        if (
          call.functionName === "termsHash" &&
          call.address?.toLowerCase() === other.toLowerCase() &&
          attack === "different terms"
        )
          return `0x${"ff".repeat(32)}`;
        // Both escrows are registered and have the same poster and money snapshot.
        return original(call);
      });
      await expect(f.execute(f.input)).rejects.toMatchObject({ code: "v2_plan_mismatch" });
      expect(f.sign).not.toHaveBeenCalled();
      expect(f.typedSign).not.toHaveBeenCalled();
      expect(f.rpc.sendRawTransaction).not.toHaveBeenCalled();
      await expect(readFile(f.input.ledgerPath)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it.each([
    { action: "approve", i: 0 },
    { action: "reject", i: 0, reason: "Revise the proof" },
    { action: "award", worker: WORKER },
    { action: "cancel-remainder" },
    { action: "submit", i: 0, proof: [{ preset: "text", value: "Proof text" }] },
    { action: "refund" },
    { action: "raise-dispute", i: 0, evidence: "Proof text" },
    { action: "counter-evidence", i: 0, evidence: "Proof text" },
    { action: "split", i: 0, toWorker: "1000000" },
  ] satisfies NonNullable<TaskV2ExecutionInput["write"]>[])(
    "refuses $action from a wallet without the required on-chain role",
    async (write) => {
      const f = await fixture();
      if (!["submit", "refund"].includes(write.action)) {
        f.view.workOrder.clientAddress = USDC;
        const original = f.rpc.readContract.getMockImplementation()!;
        f.rpc.readContract.mockImplementation(async (call) =>
          call.functionName === "terms.poster" ? USDC : original(call),
        );
      }
      await expect(f.execute({ ...f.input, write })).rejects.toThrow("on-chain role");
      expect(f.sign).not.toHaveBeenCalled();
      expect(f.typedSign).not.toHaveBeenCalled();
      expect(f.rpc.sendRawTransaction).not.toHaveBeenCalled();
    },
  );

  it("checks the on-chain party before signing split consent", async () => {
    const f = await fixture();
    f.view.workOrder.clientAddress = USDC;
    const original = f.rpc.readContract.getMockImplementation()!;
    f.rpc.readContract.mockImplementation(async (call) =>
      call.functionName === "terms.poster" ? USDC : original(call),
    );
    f.client.signV2.mockResolvedValue({
      kind: "eip712",
      signer: account.address,
      operationId: "sig_split",
      typedData: {
        domain: {
          name: "vAPI Tasks Escrow",
          version: "2",
          chainId: 84532,
          verifyingContract: state.escrow,
        },
        types: {},
        primaryType: "SplitConsent",
        message: {},
      },
    });
    await expect(
      f.execute({
        ...f.input,
        write: undefined,
        consent: { action: "split-consent", i: 0, toWorker: "1" },
      }),
    ).rejects.toThrow("on-chain role");
    expect(f.typedSign).not.toHaveBeenCalled();
  });
});

describe("repair2: fresh createEscrow → approve → fund funding", () => {
  it("creates the clone on the pinned factory, approves the clone and funds it", async () => {
    const f = await fixture("v2-approve-usdc");
    const fresh = freshFunding(f);
    f.client.getOrder.mockResolvedValue({
      ...f.view,
      workOrder: { ...f.view.workOrder, v2State: undefined },
    } as unknown as ReturnType<typeof fullView>);
    expect(await f.execute({ ...f.input, write: { action: "fund" } })).toMatchObject({
      ok: true,
      operation: { step: "v2-fund", state: "confirmed" },
      money: { escrow: state.escrow },
    });
    expect(fresh.registrations[0]).toBe(false);
    expect(fresh.registered()).toBe(true);
    expect(f.sign).toHaveBeenCalledTimes(3);
    const [creation, approval, funding] = f.sign.mock.calls.map(([tx]) => tx);
    expect(creation!.to).toBe(FACTORY);
    expect(decodeFunctionData({ abi: escrowFactoryV2Abi, data: creation!.data! })).toMatchObject({
      functionName: "createEscrow",
      args: creationArgs(),
    });
    expect(approval!.to).toBe(USDC);
    expect(funding!.to).toBe(state.escrow);
    expect(
      (await readSpendLedger(f.input.ledgerPath, new Date("2026-10-26T12:00:00Z"), f.input.wallet))
        .spentAtomic,
    ).toBe("100000000");
    expect(f.typedSign).not.toHaveBeenCalled();
  });

  it.each(["offer TTL", "objection window", "worker"])(
    "refuses a createEscrow plan that changes the locally accepted %s",
    async (changed) => {
      const f = await fixture("v2-approve-usdc");
      const creation = creationArgs();
      freshFunding(
        f,
        encodeFunctionData({
          abi: escrowFactoryV2Abi,
          functionName: "createEscrow",
          args: [
            {
              ...creation[0],
              ...(changed === "offer TTL"
                ? { offerTtl: 1n }
                : changed === "objection window"
                  ? { objectionWindow: 86400n }
                  : { worker: WORKER }),
            },
            creation[1],
            creation[2],
          ],
        }),
      );
      await expect(f.execute({ ...f.input, write: { action: "fund" } })).rejects.toMatchObject({
        code: "v2_plan_mismatch",
      });
      expect(f.sign).not.toHaveBeenCalled();
      expect(f.rpc.sendRawTransaction).not.toHaveBeenCalled();
      expect(f.typedSign).not.toHaveBeenCalled();
    },
  );
});

it.each(["poster", "vapi"] as const)(
  "preserves a registered pool payout by its %s verifier with accepted terms",
  async (verifier) => {
    const f = await fixture("v2-pay-claim");
    if (verifier === "vapi") f.view.workOrder.clientAddress = WORKER;
    Object.assign(f.view.workOrder, {
      terms: {
        shape: "pool",
        pool: {
          rewardPerClaimBaseUnits: "20000000",
          budgetBaseUnits: "100000000",
          gate: "proven",
          verifier,
        },
      },
      market: { ...f.view.workOrder.market, deadlineAt: DEADLINE },
    });
    const original = f.rpc.readContract.getMockImplementation()!;
    f.rpc.readContract.mockImplementation(async (call) => {
      if (call.functionName === "poster") return f.view.workOrder.clientAddress;
      if (call.functionName === "verifier") return account.address;
      if (call.functionName === "rewardPerClaim") return 20000000n;
      if (call.functionName === "deadline") return BigInt(Date.parse(DEADLINE) / 1000);
      if (call.functionName === "gate") return 0;
      return original(call);
    });
    f.prepared.operation.plan.data = encodeFunctionData({
      abi: bountyPoolV1Abi,
      functionName: "payClaim",
      args: [WORKER, `0x${"12".repeat(32)}`],
    });
    expect(
      await f.execute({ ...f.input, write: { action: "pay-claim", claimant: WORKER } }),
    ).toMatchObject({ ok: true, money: { gross: { usd: "20.00" }, escrow: state.escrow } });
    expect(f.sign).toHaveBeenCalledTimes(1);
  },
);

// Hashes recorded from the hosted v2TermsFromOrder + freezeScopeTerms path on tasks-v1.
// The market budget is $20 per award; the frozen budget/milestone is $20 × winners.
const bountyTermsHashes = {
  1: "0x893c9023b664935b7337a4d46361f7f5d12ffafca2c7a370fc9f208956c04a4e",
  3: "0xcfaf5a1abdb1252d5656eab7058823f05cc746b1be842248b919e9f25b5cb160",
} as const;
async function bountyFixture(winners: 1 | 3, step: TaskV2OperationResponse["operation"]["step"]) {
  const f = await fixture(step);
  f.options.trustedV2Deployments = { 84532: { ...PIN, choiceWindowSeconds: 604800 } };
  const total = BigInt(winners) * 20000000n;
  Object.assign(f.view.workOrder, {
    terms: {
      shape: "bounty",
      bounty: {
        winners,
        rewardPerWinnerBaseUnits: "20000000",
        deadlineAt: DEADLINE,
        choiceWindowSeconds: 86400,
      },
    },
  });
  f.view.workOrder.market.budget.amountBaseUnits = "20000000";
  f.view.workOrder.v2State.totalBaseUnits = total.toString();
  f.view.workOrder.v2State.milestones[0]!.amountBaseUnits = total.toString();
  const bountyDeadline = BigInt(Date.parse(DEADLINE) / 1000);
  const args = [
    {
      ...creationArgs()[0],
      shape: 1,
      winners,
      rewardPerWinner: 20000000n,
      choiceWindow: 86400n,
      bountyDeadline,
      termsHash: bountyTermsHashes[winners],
    },
    [],
    keccak256(toHex(V2_WRITE_ORDER)),
  ] as const;
  const createData = encodeFunctionData({
    abi: escrowFactoryV2Abi,
    functionName: "createEscrow",
    args,
  });
  const original = f.rpc.readContract.getMockImplementation()!;
  f.rpc.readContract.mockImplementation(async (call) => {
    if (call.functionName === "terms.shape") return 1;
    if (call.functionName === "terms.winners") return winners;
    if (call.functionName === "terms.rewardPerWinner") return 20000000n;
    if (call.functionName === "terms.choiceWindow") return 86400n;
    if (call.functionName === "terms.bountyDeadline") return bountyDeadline;
    if (call.functionName === "terms.termsHash") return bountyTermsHashes[winners];
    if (call.functionName === "milestoneCount") throw new Error("A bounty clone has no milestones");
    return original(call);
  });
  return { ...f, args, createData };
}

describe("repair3: accepted bounty windows and aggregate funding", () => {
  it.each([1, 3] as const)(
    "matches the hosted frozen aggregate-budget hash for %i winners",
    async (winners) => {
      const f = await bountyFixture(winners, "v2-fund");
      expect(
        acceptedV2TermsHash(
          f.view as unknown as import("./types.js").GetOrderResponse,
          PIN,
          604800n,
        ),
      ).toBe(bountyTermsHashes[winners]);
    },
  );
  it.each([1, 3] as const)(
    "funds a registered bounty with %i winners and a per-award market budget",
    async (winners) => {
      const f = await bountyFixture(winners, "v2-fund");
      expect(await f.execute({ ...f.input, write: { action: "fund" } })).toMatchObject({
        ok: true,
        money: { gross: { baseUnits: String(winners * 20000000) } },
      });
      expect(f.sign).toHaveBeenCalledTimes(1);
    },
  );
  it.each([1, 3] as const)(
    "awards a registered bounty with %i winners and a per-award market budget",
    async (winners) => {
      const f = await bountyFixture(winners, "v2-award-bounty");
      const addresses = [WORKER, RESOLVER, USDC].slice(0, winners);
      f.prepared.operation.plan.to = state.escrow;
      f.prepared.operation.plan.data = encodeFunctionData({
        abi: bountyEscrowV2Abi,
        functionName: "awardBounty",
        args: [addresses, addresses.map(() => `0x${"5e".repeat(32)}` as const)],
      });
      expect(
        await f.execute({ ...f.input, write: { action: "award-bounty", winners: addresses } }),
      ).toMatchObject({ ok: true, money: { gross: { baseUnits: String(winners * 20000000) } } });
      expect(f.sign).toHaveBeenCalledTimes(1);
    },
  );
  it.each([1, 3] as const)(
    "fresh funding for %i winners preserves the accepted one-day choice window over the seven-day pin",
    async (winners) => {
      const f = await bountyFixture(winners, "v2-approve-usdc");
      const fresh = freshFunding(f, f.createData);
      expect(await f.execute({ ...f.input, write: { action: "fund" } })).toMatchObject({
        ok: true,
      });
      const prediction = f.rpc.readContract.mock.calls.find(
        ([call]) => call.functionName === "predictBountyEscrow",
      )![0];
      expect(prediction.args).toEqual(f.args);
      expect(fresh.registrations[0]).toBe(false);
      expect(fresh.registered()).toBe(true);
      expect(f.sign).toHaveBeenCalledTimes(3);
    },
  );
  it.each(["offerTtl", "reviewWindow", "choiceWindow"] as const)(
    "refuses a registered bounty whose %s conflicts with accepted windows",
    async (field) => {
      const f = await bountyFixture(1, "v2-award-bounty");
      const original = f.rpc.readContract.getMockImplementation()!;
      f.rpc.readContract.mockImplementation(async (call) =>
        call.functionName === `terms.${field}`
          ? field === "reviewWindow"
            ? 86400n
            : 604800n
          : original(call),
      );
      f.prepared.operation.plan.to = state.escrow;
      f.prepared.operation.plan.data = encodeFunctionData({
        abi: bountyEscrowV2Abi,
        functionName: "awardBounty",
        args: [[WORKER], [`0x${"5e".repeat(32)}`]],
      });
      await expect(
        f.execute({ ...f.input, write: { action: "award-bounty", winners: [WORKER] } }),
      ).rejects.toMatchObject({ code: "v2_plan_mismatch" });
      expect(f.sign).not.toHaveBeenCalled();
    },
  );
  it("refuses a seven-day creation plan when the accepted bounty choice window is one day", async () => {
    const f = await bountyFixture(1, "v2-create-escrow");
    f.prepared.operation.plan.to = FACTORY;
    f.prepared.operation.plan.data = encodeFunctionData({
      abi: escrowFactoryV2Abi,
      functionName: "createEscrow",
      args: [{ ...f.args[0], choiceWindow: 604800n }, f.args[1], f.args[2]],
    });
    await expect(f.execute({ ...f.input, write: { action: "fund" } })).rejects.toMatchObject({
      code: "v2_plan_mismatch",
    });
    expect(f.sign).not.toHaveBeenCalled();
  });
});

describe("durable locally accepted V2 target", () => {
  it.each([false, true])(
    "persists %s split consent before failed confirmation and survives restart",
    async (split) => {
      const f = await consentFixture(split);
      f.client.confirmV2Signature.mockRejectedValueOnce(new Error("confirmation unavailable"));
      await expect(f.execute({ ...f.input, write: undefined, consent: f.consent })).rejects.toThrow(
        "The prepared V2 step did not complete",
      );
      expect(f.typedSign).toHaveBeenCalledOnce();
      const restarted = createPendingTransactions(f.home);
      expect(await restarted.v2Target!(f.input.id)).toEqual({
        chainId: 84532,
        escrow: state.escrow.toLowerCase(),
        termsHash: f.typedData.message.termsHash,
      });
      f.prepared.operation.step = f.prepared.operation.plan.step = "v2-bump-consent-nonce";
      f.prepared.operation.plan.data = encodeFunctionData({
        abi: escrowV2Abi,
        functionName: "bumpConsentNonce",
        args: [7n],
      });
      const result = await createTaskV2Executor({ ...f.options, pending: restarted })({
        ...f.input,
        write: { action: "bump-consent-nonce", newNonce: "7" },
      });
      expect(result.ok).toBe(true);
      expect(f.sign).toHaveBeenCalledOnce();
    },
  );

  it("refuses revocation without local acceptance", async () => {
    const f = await fixture();
    await expect(
      f.execute({ ...f.input, write: { action: "bump-consent-nonce", newNonce: "7" } }),
    ).rejects.toThrow("locally accepted consent target binding");
    expect(f.sign).not.toHaveBeenCalled();
    expect(f.typedSign).not.toHaveBeenCalled();
  });

  it("refuses a consent on another chain after local acceptance", async () => {
    const f = await consentFixture();
    await f.execute({ ...f.input, write: undefined, consent: f.consent });
    f.typedSign.mockClear();
    f.typedData.domain.chainId = 8453;
    await expect(
      createTaskV2Executor({ ...f.options, pending: createPendingTransactions(f.home) })({
        ...f.input,
        write: undefined,
        consent: f.consent,
      }),
    ).rejects.toMatchObject({
      code: "v2_plan_mismatch",
      message: "The V2 chain differs from the locally accepted target binding.",
    });
    expect(f.typedSign).not.toHaveBeenCalled();
    expect(f.rpc.sendRawTransaction).not.toHaveBeenCalled();
  });

  it("refuses consent if its local binding cannot be saved", async () => {
    const f = await consentFixture();
    vi.spyOn(f.pending, "bindV2Target").mockRejectedValueOnce(new Error("disk full"));
    await expect(f.execute({ ...f.input, write: undefined, consent: f.consent })).rejects.toThrow(
      "The prepared V2 step did not complete",
    );
    expect(f.typedSign).not.toHaveBeenCalled();
    expect(f.client.confirmV2Signature).not.toHaveBeenCalled();
  });

  it.each([
    "bump-consent-nonce",
    "close-rejected",
    "prune-reviewer",
    "prune-reviewers",
    "split",
    "award-consent",
    "split-consent",
  ] as const)(
    "refuses consistent genuine clone and hosted terms substitution for %s after consent",
    async (verb) => {
      const f = await consentFixture(verb === "split" || verb === "split-consent");
      await f.execute({ ...f.input, write: undefined, consent: f.consent });
      f.sign.mockClear();
      f.typedSign.mockClear();
      const clone = `0x${"ab".repeat(20)}` as Hex;
      f.view.workOrder.v2State.escrow = clone;
      f.view.workOrder.terms.milestones[0]!.acceptance = "Changed accepted deliverable";
      const original = f.rpc.readContract.getMockImplementation()!;
      f.rpc.readContract.mockImplementation(async (call) =>
        call.functionName === "predictEscrow"
          ? clone
          : call.functionName === "terms.worker"
            ? account.address
            : original(call),
      );
      // The pinned factory recognizes the substituted clone and predicts it using
      // the changed terms. Its on-chain terms hash agrees with the hosted metadata.
      const termsHash = acceptedV2TermsHash(
        f.view as unknown as import("./types.js").GetOrderResponse,
        PIN,
        604800n,
      );
      expect(await f.rpc.readContract({ functionName: "isEscrow", args: [clone] })).toBe(true);
      expect(await f.rpc.readContract({ functionName: "terms.termsHash", address: clone })).toBe(
        termsHash,
      );
      const consent =
        verb === "award-consent"
          ? { action: verb }
          : verb === "split-consent"
            ? { action: verb, i: 0, toWorker: "1" }
            : undefined;
      if (consent) {
        const fresh = await consentFixture(verb === "split-consent");
        const intent = await fresh.client.signV2();
        intent.typedData.domain.verifyingContract = clone;
        intent.typedData.message.escrow = clone;
        intent.typedData.message.termsHash = termsHash;
        f.client.signV2.mockResolvedValue(intent);
      } else if (verb !== "award-consent" && verb !== "split-consent") {
        const write: TaskV2Action =
          verb === "bump-consent-nonce"
            ? { action: verb, newNonce: "7" }
            : verb === "close-rejected"
              ? { action: verb, i: 0 }
              : verb === "split"
                ? { action: verb, i: 0, toWorker: "1" }
                : verb === "prune-reviewer"
                  ? { action: verb, reviewer: WORKER }
                  : { action: "prune-reviewers", reviewers: [WORKER] };
        const functionName = {
          "bump-consent-nonce": "bumpConsentNonce",
          "close-rejected": "closeRejected",
          split: "resolveWithSplit",
          "prune-reviewer": "pruneReviewer",
          "prune-reviewers": "pruneReviewers",
        }[verb];
        const args =
          verb === "bump-consent-nonce"
            ? [7n]
            : verb === "close-rejected"
              ? [0]
              : verb === "split"
                ? [0, 1n, "0x"]
                : verb === "prune-reviewer"
                  ? [WORKER]
                  : [[WORKER]];
        const prune = verb.startsWith("prune-");
        f.prepared.operation.step = f.prepared.operation.plan.step = `v2-${verb}`;
        f.prepared.operation.plan.to = prune ? USDC : clone;
        f.prepared.operation.plan.data = encodeFunctionData({
          abi: (prune ? reviewerRegistryV2Abi : escrowV2Abi) as Abi,
          functionName,
          args,
        });
        f.input.write = write;
      }
      const execute = createTaskV2Executor({
        ...f.options,
        pending: createPendingTransactions(f.home),
      });
      await expect(
        execute({ ...f.input, ...(consent ? { write: undefined, consent } : {}) }),
      ).rejects.toMatchObject({
        code: "v2_plan_mismatch",
        message: expect.stringContaining("locally accepted target binding"),
      });
      expect(f.sign).not.toHaveBeenCalled();
      expect(f.typedSign).not.toHaveBeenCalled();
      expect(f.rpc.sendRawTransaction).not.toHaveBeenCalled();
    },
  );
});

describe("awardable funding deadlines", () => {
  it.each(["creation", "funding"] as const)(
    "refuses a twenty-minute milestone before %s",
    async (stage) => {
      const f = await fixture("v2-fund");
      const deadline = NOW_SECONDS + 1200n;
      f.view.workOrder.terms.milestones[0]!.deadlineAt = new Date(
        Number(deadline) * 1000,
      ).toISOString();
      const args = creationArgs(f.view);
      const updated = [args[0], [{ ...args[1][0], deadline }], args[2]] as const;
      if (stage === "creation")
        freshFunding(
          f,
          encodeFunctionData({
            abi: escrowFactoryV2Abi,
            functionName: "createEscrow",
            args: updated,
          }),
        );
      const read = f.rpc.readContract.getMockImplementation()!;
      f.rpc.readContract.mockImplementation(async (call) =>
        call.functionName === "milestone"
          ? { ...((await read(call)) as object), deadline }
          : read(call),
      );
      await expect(f.execute({ ...f.input, write: { action: "fund" } })).rejects.toThrow(
        /MIN_WORK_TIME.*3600.*chain clock/u,
      );
      expect(f.sign).not.toHaveBeenCalled();
      expect(f.typedSign).not.toHaveBeenCalled();
      expect(f.rpc.sendRawTransaction).not.toHaveBeenCalled();
      await expect(readFile(f.input.ledgerPath)).rejects.toMatchObject({ code: "ENOENT" });
      expect(f.rpc.readContract.mock.calls).toContainEqual([
        expect.objectContaining({
          functionName: "MIN_WORK_TIME",
          address: stage === "creation" ? IMPLEMENTATION : state.escrow,
        }),
      ]);
    },
  );

  it("uses the deployed minimum, checks every milestone and rereads the chain clock", async () => {
    const f = await fixture("v2-fund");
    f.view.workOrder.v2State.milestones = ["80000000", "20000000"].map((amountBaseUnits) => ({
      amountBaseUnits,
      status: "pending",
      dispute: undefined,
    }));
    f.view.workOrder.terms.milestones = [7200n, 5400n].map((seconds, i) => ({
      index: i + 1,
      amountBaseUnits: i ? "20000000" : "80000000",
      acceptance: "Work",
      deadlineAt: new Date(Number(NOW_SECONDS + seconds) * 1000).toISOString(),
    }));
    const read = f.rpc.readContract.getMockImplementation()!;
    f.rpc.readContract.mockImplementation(async (call) =>
      call.functionName === "MIN_WORK_TIME"
        ? 5400n
        : call.functionName === "milestone"
          ? {
              ...((await read(call)) as object),
              deadline: NOW_SECONDS + (Number(call.args![0]) ? 5400n : 7200n),
            }
          : read(call),
    );
    f.rpc.getBlock.mockResolvedValue({ timestamp: NOW_SECONDS + 1n });
    await expect(f.execute({ ...f.input, write: { action: "fund" } })).rejects.toThrow(
      /MIN_WORK_TIME.*5400/u,
    );
    expect(f.sign).not.toHaveBeenCalled();
  });
});

it("rechecks deadline headroom after approval before signing a redeemable funding authorization", async () => {
  const f = await fixture("v2-fund");
  const deadline = NOW_SECONDS + 3601n;
  f.view.workOrder.terms.milestones[0]!.deadlineAt = new Date(
    Number(deadline) * 1000,
  ).toISOString();
  const read = f.rpc.readContract.getMockImplementation()!;
  f.rpc.readContract.mockImplementation(async (call) =>
    call.functionName === "milestone"
      ? { ...((await read(call)) as object), deadline }
      : read(call),
  );
  f.client.prepareV2.mockResolvedValue({
    kind: "eip712",
    signer: account.address,
    operationId: `sig_${V2_WRITE_OPERATION}`,
    escrow: state.escrow,
    typedData: {
      domain: { name: "USD Coin", version: "2", chainId: 84532, verifyingContract: USDC },
      primaryType: "ReceiveWithAuthorization",
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
      message: {
        from: account.address,
        to: state.escrow,
        value: "100000000",
        validAfter: "0",
        validBefore: (NOW_SECONDS + 300n).toString(),
        nonce: `0x${"12".repeat(32)}`,
      },
    },
  });
  const ask = vi.fn(async () => {
    f.rpc.getBlock.mockResolvedValue({ timestamp: NOW_SECONDS + 2n });
    return true;
  });
  await expect(
    f.execute({
      ...f.input,
      write: { action: "fund" },
      policy: { ...f.input.policy, approveAboveUsd: 1 },
      approval: { ask },
    }),
  ).rejects.toThrow(/MIN_WORK_TIME.*chain clock/u);
  expect(ask).toHaveBeenCalledOnce();
  expect(f.sign).not.toHaveBeenCalled();
  expect(f.typedSign).not.toHaveBeenCalled();
  expect(f.client.confirmV2Signature).not.toHaveBeenCalled();
  expect(f.rpc.sendRawTransaction).not.toHaveBeenCalled();
  await expect(readFile(f.input.ledgerPath)).rejects.toMatchObject({ code: "ENOENT" });
});

/**
 * Base mainnet (chain 8453) with the built-in pin and no local override. Every other test in
 * this file runs on chain 84532 with `configured: true`, which is how 0.16.0 shipped an executor
 * that refused every signed step against production.
 */
const BASE = TRUSTED_TASKS_V2_DEPLOYMENTS[8453]!;
/** The production body of GET /api/tasks/readiness on 2026-11-25, byte for byte. */
const READINESS_UNAVAILABLE =
  '{"configured":false,"chainId":8453,"network":"eip155:8453","networkLabel":"Base","feeBp":null,"explorerUrl":null,"capabilities":{"erc3009Funding":false,"vapiVerify":false},"eip3009Domain":null}';
/** A V2-only deployment in the existing `configured: true` response shape. */
const READINESS_V2_ONLY = JSON.stringify({
  configured: true,
  chainId: 8453,
  network: "eip155:8453",
  networkLabel: "Base",
  feeBp: 0,
  explorerUrl: "https://basescan.org",
  escrowContract: BASE.escrowFactoryV2.toLowerCase(),
  feeRouter: `0x${"0f".repeat(20)}`,
  usdc: BASE.usdc.toLowerCase(),
  capabilities: { erc3009Funding: true, vapiVerify: false },
  eip3009Domain: {
    name: "USD Coin",
    version: "2",
    chainId: 8453,
    verifyingContract: BASE.usdc.toLowerCase(),
  },
  maxEscrowAmountBaseUnits: "5000000000",
  defaults: { workDurationSeconds: 604800 },
  verifyReviewPriceBaseUnits: null,
});
const BASE_USDC = BASE.usdc.toLowerCase() as `0x${string}`;
const FUND_VERB = `v2:${canonicalJson({ action: "fund" })}`;
/** Moves a fixture to chain 8453: the built-in pin, a 0% fee, and readiness through the real schema. */
function onBase(f: Awaited<ReturnType<typeof fixture>>, readiness: string) {
  f.options.trustedV2Deployments = {};
  f.rpc.getChainId.mockResolvedValue(8453);
  f.prepared.operation.plan.chainId = 8453;
  f.prepared.operation.plan.network = "eip155:8453";
  f.view.workOrder.market.budget.network = "eip155:8453";
  f.view.workOrder.v2State.feeBp = 0;
  const read = f.rpc.readContract.getMockImplementation()!;
  f.rpc.readContract.mockImplementation(async (call) => {
    const pool = f.view.workOrder.terms.shape === "pool";
    switch (call.functionName) {
      case "paymentToken":
      case "USDC":
        return BASE.usdc;
      case "FACTORY":
        return pool ? BASE.bountyPoolFactoryV1 : BASE.escrowFactoryV2;
      case "DISPUTE_RESOLVER":
        return BASE.disputeResolverV3;
      case "terms.offerTtl":
        return 604800n;
      case "terms.feeBp":
      case "feeBp":
        return 0;
      case "terms.termsHash":
      case "termsHash":
        return acceptedV2TermsHash(
          f.view as unknown as import("./types.js").GetOrderResponse,
          BASE,
          pool ? 0n : 604800n,
        );
      case "owed":
        return 5_000_000n;
      default:
        return read(call);
    }
  });
  // The body goes through the client's own response schema, as it does in production.
  const served = createTasksClient({
    baseUrl: "https://api.example",
    fetch: async () => new Response(readiness, { headers: { "content-type": "application/json" } }),
  });
  f.client.deployment.mockImplementation((() => served.deployment()) as never);
  return f;
}
function nothingLeftTheMachine(f: Awaited<ReturnType<typeof fixture>>) {
  expect(f.typedSign).not.toHaveBeenCalled();
  expect(f.sign).not.toHaveBeenCalled();
  expect(f.client.confirmV2Signature).not.toHaveBeenCalled();
  expect(f.rpc.sendRawTransaction).not.toHaveBeenCalled();
}
const noLedger = (f: Awaited<ReturnType<typeof fixture>>) =>
  expect(readFile(f.input.ledgerPath)).rejects.toMatchObject({ code: "ENOENT" });
/** The hosted answer to a signed funding authorization: fundWithAuthorization on the clone. */
function authorizedFunding(
  f: Awaited<ReturnType<typeof fixture>>,
  chainId = 84532,
  usdc?: `0x${string}`,
) {
  const intent = fundingIntent(chainId, usdc);
  f.client.prepareV2.mockResolvedValue(intent);
  f.client.confirmV2Signature.mockImplementation(
    async (_id: string, _op: string, signature: `0x${string}`) => {
      f.prepared.operation.plan.data = encodeFunctionData({
        abi: escrowV2Abi,
        functionName: "fundWithAuthorization",
        args: [
          account.address,
          BigInt(intent.typedData.message.validAfter),
          BigInt(intent.typedData.message.validBefore),
          intent.typedData.message.nonce as `0x${string}`,
          signature,
        ],
      });
      return f.prepared;
    },
  );
  return intent;
}

describe("Base mainnet: today's production readiness (configured: false)", () => {
  it("parses the exact production body as unavailable on chain 8453", async () => {
    const f = onBase(await fixture("v2-fund"), READINESS_UNAVAILABLE);
    expect(await f.client.deployment()).toMatchObject({ configured: false, chainId: 8453 });
  });
  it("refuses fund in plain words before the authorization is signed, sent or counted", async () => {
    const f = onBase(await fixture("v2-fund"), READINESS_UNAVAILABLE);
    const intent = authorizedFunding(f, 8453, BASE_USDC);
    // `task post --fund` hands the executor the intent the API returned at posting.
    await expect(
      f.execute({ ...f.input, write: { action: "fund" }, prepared: intent }),
    ).rejects.toMatchObject({
      code: "tasks_unavailable",
      message:
        "vAPI reports Tasks as unavailable on Base right now. Nothing was signed and no money moved. Try again later.",
    });
    nothingLeftTheMachine(f);
    expect(f.rpc.readContract).not.toHaveBeenCalled();
    await noLedger(f);
    // The supplied intent is kept, so a later `task fund` resumes it instead of preparing again.
    expect((await f.pending.preparation(V2_WRITE_ORDER, FUND_VERB))?.preparedV2).toMatchObject({
      kind: "eip712",
    });
  });
  it("does not ask the API to prepare a funding it will not sign", async () => {
    const f = onBase(await fixture("v2-fund"), READINESS_UNAVAILABLE);
    await expect(f.execute({ ...f.input, write: { action: "fund" } })).rejects.toMatchObject({
      code: "tasks_unavailable",
    });
    expect(f.client.prepareV2).not.toHaveBeenCalled();
    nothingLeftTheMachine(f);
    await noLedger(f);
    // The SDK entry point stops at the same place, before the vault is opened.
    const executeV2 = vi.fn();
    await expect(
      executeTaskV2(
        {
          client: f.client as unknown as TasksClient,
          chain: { ...missingTasksChain, executeV2 },
          pending: f.pending,
          baseUrl: "https://api.example",
          randomUUID: () => V2_WRITE_OPERATION,
          signInHint: "test",
        },
        { ...f.input, write: { action: "fund" } },
      ),
    ).rejects.toMatchObject({ code: "tasks_unavailable" });
    expect(f.client.prepareV2).not.toHaveBeenCalled();
    expect(executeV2).not.toHaveBeenCalled();
  });
  it("refuses a worker bond approval the same way", async () => {
    const f = onBase(await fixture("v2-approve-usdc"), READINESS_UNAVAILABLE);
    await expect(
      f.execute({ ...f.input, write: { action: "approve-bond" } }),
    ).rejects.toMatchObject({ code: "tasks_unavailable" });
    expect(f.client.prepareV2).not.toHaveBeenCalled();
    nothingLeftTheMachine(f);
  });
  it("refuses an award and the worker's consent to it: hiring is new work", async () => {
    const f = onBase(await fixture("v2-award"), READINESS_UNAVAILABLE);
    const refusal = {
      code: "tasks_unavailable",
      message:
        "vAPI reports Tasks as unavailable on Base right now. Nothing was signed and no money moved. Try again later.",
    };
    const award = { ...f.input, write: { action: "award", worker: WORKER } as const };
    const consent = { ...f.input, write: undefined, consent: { action: "award-consent" } as const };
    await expect(f.execute(award)).rejects.toMatchObject(refusal);
    await expect(f.execute(consent)).rejects.toMatchObject(refusal);
    // The SDK entry point stops both before the API prepares anything or the vault opens.
    const executeV2 = vi.fn();
    const context = {
      client: f.client as unknown as TasksClient,
      chain: { ...missingTasksChain, executeV2 },
      pending: f.pending,
      baseUrl: "https://api.example",
      randomUUID: () => V2_WRITE_OPERATION,
      signInHint: "test",
    };
    await expect(executeTaskV2(context, award)).rejects.toMatchObject(refusal);
    await expect(executeTaskV2(context, consent)).rejects.toMatchObject(refusal);
    expect(executeV2).not.toHaveBeenCalled();
    expect(f.client.prepareV2).not.toHaveBeenCalled();
    expect(f.client.signV2).not.toHaveBeenCalled();
    nothingLeftTheMachine(f);
    expect(f.rpc.readContract).not.toHaveBeenCalled();
    // An unreadable status holds hiring back as well.
    f.client.deployment.mockRejectedValue(new TasksClientError("network", "offline"));
    await expect(f.execute(award)).rejects.toMatchObject({
      code: "tasks_unavailable",
      message: expect.stringContaining("vAPI's Tasks status could not be read."),
    });
    await expect(f.execute(consent)).rejects.toMatchObject({ code: "tasks_unavailable" });
    expect(f.client.prepareV2).not.toHaveBeenCalled();
    expect(f.client.signV2).not.toHaveBeenCalled();
  });
  it.each([
    ["approve", { action: "approve", i: 0 }, "approveMilestone", [0]],
    ["finalize", { action: "finalize", i: 0 }, "finalizeMilestone", [0]],
    ["cancel-offer", { action: "cancel-offer" }, "cancelOffer", []],
    [
      "raise-dispute",
      { action: "raise-dispute", i: 0, evidence: "Proof text" },
      "raiseDispute",
      [0, HASH_EVIDENCE("Proof text")],
    ],
    ["claim-owed", { action: "claim-owed" }, "claimOwed", [account.address]],
  ] as const)(
    "still signs %s: money already in an escrow is never held back by a hosted flag",
    async (name, write, functionName, args) => {
      const step = `v2-${name}` as TaskV2OperationResponse["operation"]["step"];
      const f = onBase(await fixture(), READINESS_UNAVAILABLE);
      f.prepared.operation.step = step;
      f.prepared.operation.plan.step = step;
      f.prepared.operation.plan.data = encodeFunctionData({
        abi: escrowV2Abi,
        functionName,
        args,
      } as never);
      expect(await f.execute({ ...f.input, write: write as TaskV2Action })).toMatchObject({
        ok: true,
        operation: { state: "confirmed", step, plan: null },
      });
      expect(f.sign).toHaveBeenCalledTimes(1);
      expect(f.sign.mock.calls[0]![0]).toMatchObject({ chainId: 8453, to: state.escrow });
      // The built-in pin was used: no override notice, and the pinned factory vouched for the clone.
      expect(f.notice).not.toHaveBeenCalled();
      expect(f.rpc.readContract).toHaveBeenCalledWith(
        expect.objectContaining({ address: BASE.escrowFactoryV2, functionName: "isEscrow" }),
      );
    },
  );
  it("keeps exits open when the readiness document cannot be read", async () => {
    const f = onBase(await fixture(), READINESS_UNAVAILABLE);
    f.client.deployment.mockRejectedValue(new TasksClientError("invalid_response", "bad body"));
    expect(await f.execute(f.input)).toMatchObject({ ok: true });
    expect(f.sign.mock.calls[0]![0]).toMatchObject({ chainId: 8453, to: state.escrow });
  });
  it("keeps funding closed when the readiness document cannot be read", async () => {
    const f = onBase(await fixture("v2-fund"), READINESS_UNAVAILABLE);
    f.client.deployment.mockRejectedValue(new TasksClientError("network", "offline"));
    await expect(f.execute({ ...f.input, write: { action: "fund" } })).rejects.toMatchObject({
      code: "tasks_unavailable",
      message: expect.stringContaining("vAPI's Tasks status could not be read."),
    });
    expect(f.client.prepareV2).not.toHaveBeenCalled();
    nothingLeftTheMachine(f);
    await noLedger(f);
  });
});

describe("Base mainnet: a V2-only configured: true readiness body", () => {
  it("parses in the existing response schema", async () => {
    const f = onBase(await fixture("v2-fund"), READINESS_V2_ONLY);
    expect(await f.client.deployment()).toMatchObject({
      configured: true,
      chainId: 8453,
      escrowContract: BASE.escrowFactoryV2.toLowerCase(),
      usdc: BASE.usdc.toLowerCase(),
    });
  });
  it("funds a registered escrow with one authorization and one transaction", async () => {
    const f = onBase(await fixture("v2-fund"), READINESS_V2_ONLY);
    const intent = authorizedFunding(f, 8453, BASE_USDC);
    expect(await f.execute({ ...f.input, write: { action: "fund" } })).toMatchObject({
      ok: true,
      operation: { state: "confirmed", step: "v2-fund", plan: null },
      money: { gross: { usd: "100.00" }, fee: { usd: "0.00" }, net: { usd: "100.00" } },
    });
    expect(f.typedSign).toHaveBeenCalledWith(intent.typedData);
    expect(f.sign).toHaveBeenCalledTimes(1);
    expect(f.sign.mock.calls[0]![0]).toMatchObject({ chainId: 8453, to: state.escrow });
    expect(f.notice).not.toHaveBeenCalled();
    expect(
      (await readSpendLedger(f.input.ledgerPath, new Date("2026-10-26T12:00:00Z"), f.input.wallet))
        .spentAtomic,
    ).toBe("100000000");
  });
  it("creates the clone on the pinned factory, approves pinned USDC and funds it", async () => {
    const f = onBase(await fixture("v2-approve-usdc"), READINESS_V2_ONLY);
    const args = creationArgs(f.view, BASE, 0);
    const fresh = freshFunding(
      f,
      encodeFunctionData({ abi: escrowFactoryV2Abi, functionName: "createEscrow", args }),
      BASE,
    );
    expect(await f.execute({ ...f.input, write: { action: "fund" } })).toMatchObject({
      ok: true,
      operation: { step: "v2-fund", state: "confirmed", plan: null },
    });
    expect(fresh.registered()).toBe(true);
    const [creation, approval, funding] = f.sign.mock.calls.map(([tx]) => tx);
    expect(f.sign).toHaveBeenCalledTimes(3);
    expect(creation).toMatchObject({ chainId: 8453, to: BASE.escrowFactoryV2.toLowerCase() });
    expect(approval).toMatchObject({ chainId: 8453, to: BASE.usdc.toLowerCase() });
    expect(funding).toMatchObject({ chainId: 8453, to: state.escrow });
    expect(f.typedSign).not.toHaveBeenCalled();
    expect(f.notice).not.toHaveBeenCalled();
    expect(
      (await readSpendLedger(f.input.ledgerPath, new Date("2026-10-26T12:00:00Z"), f.input.wallet))
        .spentAtomic,
    ).toBe("100000000");
  });
  it("refuses a step prepared for another chain before anything is signed", async () => {
    // A local override exists for 84532, so only the hosted chain ID stands in the way.
    const f = await fixture("v2-fund");
    const served = createTasksClient({
      baseUrl: "https://api.example",
      fetch: async () => Response.json(JSON.parse(READINESS_V2_ONLY)),
    });
    f.client.deployment.mockImplementation((() => served.deployment()) as never);
    const intent = authorizedFunding(f);
    await expect(
      f.execute({ ...f.input, write: { action: "fund" }, prepared: intent }),
    ).rejects.toThrow(
      "The prepared step is for Base Sepolia, but vAPI serves Tasks on Base. Nothing was signed.",
    );
    nothingLeftTheMachine(f);
    await noLedger(f);
  });
});

describe("refusals that need no signature come before any signature", () => {
  it("refuses a funding the wallet cannot pay before signing or reserving", async () => {
    const f = await fixture("v2-fund");
    const intent = authorizedFunding(f);
    const read = f.rpc.readContract.getMockImplementation()!;
    f.rpc.readContract.mockImplementation(async (call) =>
      call.functionName === "balanceOf" ? 99_999_999n : read(call),
    );
    const ask = vi.fn(async () => true);
    await expect(
      f.execute({
        ...f.input,
        write: { action: "fund" },
        prepared: intent,
        policy: { ...f.input.policy, approveAboveUsd: 1 },
        approval: { ask },
      }),
    ).rejects.toMatchObject({
      code: "insufficient_usdc",
      message:
        "This step pays $100.00 USDC, but the wallet holds $99.999999 on Base Sepolia. Nothing was signed and no money moved.",
    });
    expect(f.rpc.readContract).toHaveBeenCalledWith(
      expect.objectContaining({
        address: USDC,
        functionName: "balanceOf",
        args: [account.address],
      }),
    );
    expect(ask).not.toHaveBeenCalled();
    nothingLeftTheMachine(f);
    await noLedger(f);
  });
  it("refuses a funding above the factory's live limit before signing or reserving", async () => {
    const f = await fixture("v2-fund");
    const intent = authorizedFunding(f);
    const read = f.rpc.readContract.getMockImplementation()!;
    f.rpc.readContract.mockImplementation(async (call) =>
      call.functionName === "maxEscrowAmount" ? 99_999_999n : read(call),
    );
    await expect(
      f.execute({ ...f.input, write: { action: "fund" }, prepared: intent }),
    ).rejects.toMatchObject({
      code: "invalid_input",
      message:
        "The total of $100.00 USDC is above the live limit of $99.999999 USDC per task on Base Sepolia. Nothing was signed and no money moved.",
    });
    expect(f.rpc.readContract).toHaveBeenCalledWith(
      expect.objectContaining({ address: getAddress(FACTORY), functionName: "maxEscrowAmount" }),
    );
    nothingLeftTheMachine(f);
    await noLedger(f);
  });
  it("refuses a funding from a wallet without gas before signing or reserving", async () => {
    const f = await fixture("v2-fund");
    const intent = authorizedFunding(f);
    Object.assign(f.rpc, { getBalance: vi.fn(async () => 0n) });
    await expect(
      f.execute({ ...f.input, write: { action: "fund" }, prepared: intent }),
    ).rejects.toMatchObject({
      code: "insufficient_gas",
      message:
        "The wallet holds no ETH on Base Sepolia to pay for the transaction. Nothing was signed and no money moved.",
    });
    nothingLeftTheMachine(f);
    await noLedger(f);
  });
  it("leaves the decision to the chain when the balance cannot be read", async () => {
    const f = await fixture("v2-fund");
    authorizedFunding(f);
    const read = f.rpc.readContract.getMockImplementation()!;
    f.rpc.readContract.mockImplementation(async (call) => {
      if (call.functionName === "balanceOf") throw new Error("rate limited");
      return read(call);
    });
    expect(await f.execute({ ...f.input, write: { action: "fund" } })).toMatchObject({ ok: true });
  });
  it("does not count a step the node refuses to estimate against the daily cap", async () => {
    const f = await fixture("v2-fund");
    vi.mocked(prepareTransactionRequest).mockRejectedValueOnce(new Error("execution reverted"));
    await expect(f.execute({ ...f.input, write: { action: "fund" } })).rejects.toMatchObject({
      code: "chain_error",
    });
    expect(f.sign).not.toHaveBeenCalled();
    expect(f.rpc.sendRawTransaction).not.toHaveBeenCalled();
    await noLedger(f);
    // The same step still reserves once, right before its signature.
    expect(await f.execute({ ...f.input, write: { action: "fund" } })).toMatchObject({ ok: true });
    expect(f.sign).toHaveBeenCalledTimes(1);
    expect(
      (await readSpendLedger(f.input.ledgerPath, new Date("2026-10-26T12:00:00Z"), f.input.wallet))
        .spentAtomic,
    ).toBe("100000000");
  });
  it("files a dispute when vAPI reports Tasks as unavailable: its deadline does not wait", async () => {
    const f = await fixture("v2-raise-dispute");
    f.client.deployment.mockResolvedValue({
      configured: false,
      chainId: 84532,
      network: "eip155:84532",
    } as never);
    expect(
      await f.execute({
        ...f.input,
        write: { action: "raise-dispute", i: 0, evidence: "Proof text" },
      }),
    ).toMatchObject({ ok: true, money: { gross: { usd: "20.00" } } });
  });
});

describe("a rerun of an operation that already signed something", () => {
  type Fixture = Awaited<ReturnType<typeof fixture>>;
  const STILL_STANDS =
    "This step was not signed. Anything this operation signed earlier stands. Try again later.";
  const spent = async (f: Fixture) =>
    (await readSpendLedger(f.input.ledgerPath, new Date("2026-10-26T12:00:00Z"), f.input.wallet))
      .spentAtomic;
  const serve = (f: Fixture, readiness: string) => {
    const served = createTasksClient({
      baseUrl: "https://api.example",
      fetch: async () =>
        new Response(readiness, { headers: { "content-type": "application/json" } }),
    });
    f.client.deployment.mockImplementation((() => served.deployment()) as never);
  };
  const walletHolds = (f: Fixture, balance: bigint) => {
    const read = f.rpc.readContract.getMockImplementation()!;
    f.rpc.readContract.mockImplementation(async (call) =>
      call.functionName === "balanceOf" ? balance : read(call),
    );
  };
  /** First run: the transaction is broadcast, then the API call that records it fails. */
  async function sentThenDropped(f: Fixture, write: TaskV2Action, paid: string) {
    const normal = f.client.operationV2.getMockImplementation()!;
    f.client.operationV2.mockImplementation(async (id, mode, body) => {
      if (mode === "transaction") throw new Error("socket hang up");
      return normal(id, mode, body);
    });
    await expect(f.execute({ ...f.input, write })).rejects.toMatchObject({
      code: "chain_error",
      message: "The prepared V2 step did not complete. Resume the saved operation.",
    });
    expect(f.sign).toHaveBeenCalledTimes(1);
    expect(f.rpc.sendRawTransaction).toHaveBeenCalledTimes(1);
    expect(await spent(f)).toBe(paid);
    f.client.operationV2.mockImplementation(normal);
  }
  /** The API has seen the transaction on chain and holds the operation as confirmed. */
  const minedAndKnown = (f: Fixture) =>
    f.client.operationV2.mockImplementation(async (_id, mode) => ({
      ...f.prepared,
      ...(mode === "recover" ? { recovered: true, scanComplete: true } : {}),
      operation: {
        ...f.prepared.operation,
        state: "confirmed",
        transactionHash: `0x${"aa".repeat(32)}`,
      },
    }));

  it("reconciles a mined funding although the wallet no longer holds the amount", async () => {
    const f = onBase(await fixture("v2-fund"), READINESS_V2_ONLY);
    await sentThenDropped(f, { action: "fund" }, "100000000");
    // The funding mined: the 100 USDC are in the escrow, and the wallet is at zero.
    minedAndKnown(f);
    walletHolds(f, 0n);
    expect(await f.execute({ ...f.input, write: { action: "fund" } })).toMatchObject({
      ok: true,
      operation: { state: "confirmed", step: "v2-fund" },
    });
    expect(f.sign).toHaveBeenCalledTimes(1);
    expect(f.rpc.sendRawTransaction).toHaveBeenCalledTimes(1);
    // Counted once, and the finished operation leaves no journal behind.
    expect(await spent(f)).toBe("100000000");
    expect(await f.pending.preparation(V2_WRITE_ORDER, FUND_VERB)).toBeUndefined();
  });
  it("does not count a reconciled funding against the cap of a later day", async () => {
    const f = onBase(await fixture("v2-fund"), READINESS_V2_ONLY);
    await sentThenDropped(f, { action: "fund" }, "100000000");
    minedAndKnown(f);
    const nextDay = new Date("2026-10-27T12:00:00Z");
    const later = createTaskV2Executor({ ...f.options, now: () => nextDay });
    expect(await later({ ...f.input, write: { action: "fund" } })).toMatchObject({ ok: true });
    expect(f.sign).toHaveBeenCalledTimes(1);
    expect((await readSpendLedger(f.input.ledgerPath, nextDay, f.input.wallet)).spentAtomic).toBe(
      "0",
    );
    expect(await spent(f)).toBe("100000000");
  });
  it("reconciles a sent funding although vAPI now reports Tasks as unavailable", async () => {
    const f = onBase(await fixture("v2-fund"), READINESS_V2_ONLY);
    await sentThenDropped(f, { action: "fund" }, "100000000");
    serve(f, READINESS_UNAVAILABLE);
    walletHolds(f, 0n);
    expect(await f.execute({ ...f.input, write: { action: "fund" } })).toMatchObject({
      ok: true,
      operation: { state: "confirmed", step: "v2-fund" },
    });
    // The saved transaction is sent again unchanged; nothing new is signed or counted.
    expect(f.sign).toHaveBeenCalledTimes(1);
    const [first, again] = f.rpc.sendRawTransaction.mock.calls.map(([sent]) => sent);
    expect(f.rpc.sendRawTransaction).toHaveBeenCalledTimes(2);
    expect(again).toEqual(first);
    expect(await spent(f)).toBe("100000000");
  });
  it("reconciles a sent funding when the readiness document cannot be read", async () => {
    const f = onBase(await fixture("v2-fund"), READINESS_V2_ONLY);
    await sentThenDropped(f, { action: "fund" }, "100000000");
    minedAndKnown(f);
    f.client.deployment.mockRejectedValue(new TasksClientError("network", "offline"));
    expect(await f.execute({ ...f.input, write: { action: "fund" } })).toMatchObject({ ok: true });
    expect(f.sign).toHaveBeenCalledTimes(1);
    expect(await spent(f)).toBe("100000000");
  });
  it("reconciles a sent dispute fee although the wallet no longer holds it", async () => {
    const f = await fixture("v2-raise-dispute");
    const write = { action: "raise-dispute", i: 0, evidence: "Proof text" } as const;
    await sentThenDropped(f, write, "20000000");
    minedAndKnown(f);
    walletHolds(f, 0n);
    Object.assign(f.rpc, { getBalance: vi.fn(async () => 0n) });
    expect(await f.execute({ ...f.input, write })).toMatchObject({
      ok: true,
      operation: { state: "confirmed", step: "v2-raise-dispute" },
    });
    expect(f.sign).toHaveBeenCalledTimes(1);
    expect(f.rpc.sendRawTransaction).toHaveBeenCalledTimes(1);
    expect(await spent(f)).toBe("20000000");
  });
  it("never says nothing was signed after a funding authorization was signed", async () => {
    const f = onBase(await fixture("v2-fund"), READINESS_V2_ONLY);
    authorizedFunding(f, 8453, BASE_USDC);
    // The authorization is signed and counted; its upload is never answered.
    f.client.confirmV2Signature.mockRejectedValueOnce(new Error("socket hang up"));
    await expect(f.execute({ ...f.input, write: { action: "fund" } })).rejects.toMatchObject({
      code: "chain_error",
    });
    expect(f.typedSign).toHaveBeenCalledTimes(1);
    expect(await spent(f)).toBe("100000000");
    // A transaction that was never signed still waits for Tasks to be available, in true words.
    serve(f, READINESS_UNAVAILABLE);
    const refused = await f.execute({ ...f.input, write: { action: "fund" } }).catch((e) => e);
    expect(refused).toMatchObject({
      code: "tasks_unavailable",
      message: `vAPI reports Tasks as unavailable on Base right now. ${STILL_STANDS}`,
    });
    // The rerun holds its signature, so it went on to the transaction step: same bytes again.
    expect(f.typedSign).toHaveBeenCalledTimes(2);
    expect(f.client.confirmV2Signature).toHaveBeenCalledTimes(2);
    expect(f.client.confirmV2Signature.mock.calls[1]![2]).toBe(
      f.client.confirmV2Signature.mock.calls[0]![2],
    );
    expect(f.sign).not.toHaveBeenCalled();
    expect(f.rpc.sendRawTransaction).not.toHaveBeenCalled();
    // The wallet's balance is not asked about either: the authorization may already be redeemed.
    serve(f, READINESS_V2_ONLY);
    walletHolds(f, 0n);
    expect(await f.execute({ ...f.input, write: { action: "fund" } })).toMatchObject({ ok: true });
    expect(f.sign).toHaveBeenCalledTimes(1);
    expect(await spent(f)).toBe("100000000");
  });
  const fund = (f: Fixture) => ({ ...f.input, write: { action: "fund" } as const });
  const nodeHoldsItAsMined = (f: Fixture) =>
    Object.assign(f.rpc, { getTransactionReceipt: vi.fn(async () => ({ status: "success" })) });
  /** Two hours on: the chain clock and the local clock are past the authorization window. */
  const twoHoursLater = (f: Fixture) => {
    f.rpc.getBlock.mockResolvedValue({ timestamp: NOW_SECONDS + 7200n });
    return createTaskV2Executor({ ...f.options, now: () => new Date("2026-10-26T14:00:00Z") });
  };
  const journalKey = async (f: Fixture) =>
    (await f.pending.preparation(V2_WRITE_ORDER, FUND_VERB))?.idempotencyKey;

  it("does not sign a reserved funding authorization for the first time while Tasks is unavailable", async () => {
    const f = onBase(await fixture("v2-fund"), READINESS_V2_ONLY);
    authorizedFunding(f, 8453, BASE_USDC);
    // The spend is reserved, then the vault fails: no signature exists.
    f.typedSign.mockRejectedValueOnce(new Error("vault closed"));
    await expect(f.execute(fund(f))).rejects.toMatchObject({ code: "chain_error" });
    expect(await spent(f)).toBe("100000000");
    serve(f, READINESS_UNAVAILABLE);
    await expect(f.execute(fund(f))).rejects.toMatchObject({
      code: "tasks_unavailable",
      message:
        "vAPI reports Tasks as unavailable on Base right now. No new signature was made. An authorization signed earlier stays valid until it expires. Try again later.",
    });
    f.client.deployment.mockRejectedValue(new TasksClientError("network", "offline"));
    await expect(f.execute(fund(f))).rejects.toMatchObject({
      code: "tasks_unavailable",
      message: expect.stringContaining("No new signature was made."),
    });
    // Only the failed attempt reached the vault, and nothing was uploaded or sent.
    expect(f.typedSign).toHaveBeenCalledTimes(1);
    expect(f.client.confirmV2Signature).not.toHaveBeenCalled();
    expect(f.sign).not.toHaveBeenCalled();
    serve(f, READINESS_V2_ONLY);
    expect(await f.execute(fund(f))).toMatchObject({ ok: true });
    expect(f.typedSign).toHaveBeenCalledTimes(2);
    expect(await spent(f)).toBe("100000000");
  });
  it("sends the saved transaction of a signed authorization although Tasks is now unavailable", async () => {
    const f = onBase(await fixture("v2-fund"), READINESS_V2_ONLY);
    authorizedFunding(f, 8453, BASE_USDC);
    await sentThenDropped(f, { action: "fund" }, "100000000");
    serve(f, READINESS_UNAVAILABLE);
    expect(await f.execute(fund(f))).toMatchObject({
      ok: true,
      operation: { state: "confirmed", step: "v2-fund" },
    });
    expect(f.sign).toHaveBeenCalledTimes(1);
    expect(await spent(f)).toBe("100000000");
  });
  it("finishes a mined funding on a later day without asking the cap, approval or the deadline", async () => {
    const f = onBase(await fixture("v2-fund"), READINESS_V2_ONLY);
    f.input.caps = { perCallAtomic: "1", perDayAtomic: "150000000" };
    await sentThenDropped(f, { action: "fund" }, "100000000");
    nodeHoldsItAsMined(f);
    // Half an hour before the deadline, on a day whose cap has 50 USDC left, with stricter
    // limits than on the first run. The API still holds the step as prepared.
    const later = new Date(Date.parse(DEADLINE) - 1_800_000);
    f.rpc.getBlock.mockResolvedValue({ timestamp: BigInt(later.getTime() / 1000) });
    await reserveSpend(100_000_000n, f.input.caps, {
      kind: "escrow-funding",
      taskKey: "33333333-3333-4333-8333-333333333333",
      maxPerTaskAtomic: 200_000_000n,
      wallet: f.input.wallet,
      ledgerPath: f.input.ledgerPath,
      now: later,
      reservationId: "44444444-4444-4444-8444-444444444444",
    });
    const rerun = createTaskV2Executor({ ...f.options, now: () => later });
    expect(
      await rerun({ ...fund(f), policy: { maxPerTaskUsd: 50, approveAboveUsd: 0 } }),
    ).toMatchObject({ ok: true, operation: { state: "confirmed", step: "v2-fund" } });
    // Reported, not signed or sent again.
    expect(f.sign).toHaveBeenCalledTimes(1);
    expect(f.rpc.sendRawTransaction).toHaveBeenCalledTimes(1);
    const reported = f.client.operationV2.mock.calls.filter(([, mode]) => mode === "transaction");
    expect(reported).toHaveLength(2);
    expect(reported.at(-1)![2].transactionHash).toBe(
      keccak256(f.rpc.sendRawTransaction.mock.calls[0]![0].serializedTransaction),
    );
    // Counted once, on the day it was reserved; the later day holds only the other task.
    expect(await spent(f)).toBe("100000000");
    expect((await readSpendLedger(f.input.ledgerPath, later, f.input.wallet)).spentAtomic).toBe(
      "100000000",
    );
    const rows = JSON.parse(await readFile(f.input.ledgerPath, "utf8")) as {
      rows: { date: string; reservations?: { taskKey?: string }[] }[];
    };
    expect(
      rows.rows.map((row) => [row.date, row.reservations?.map((entry) => entry.taskKey)]),
    ).toEqual([
      ["2026-10-26", [V2_WRITE_ORDER]],
      ["2026-10-28", ["33333333-3333-4333-8333-333333333333"]],
    ]);
  });
  it("finishes a mined authorized funding after its authorization window, without signing again", async () => {
    const f = onBase(await fixture("v2-fund"), READINESS_V2_ONLY);
    authorizedFunding(f, 8453, BASE_USDC);
    await sentThenDropped(f, { action: "fund" }, "100000000");
    const key = await journalKey(f);
    const rerun = twoHoursLater(f);
    // The node does not know the transaction: the saved authorization is kept, not replaced,
    // and the expired window is named.
    await expect(rerun(fund(f))).rejects.toMatchObject({
      code: "v2_plan_mismatch",
      message: expect.stringContaining("bounded time window"),
    });
    expect(await journalKey(f)).toBe(key);
    expect(f.client.prepareV2).toHaveBeenCalledTimes(1);
    expect(f.typedSign).toHaveBeenCalledTimes(1);
    // The node holds it as mined: the rerun reports it and finishes.
    nodeHoldsItAsMined(f);
    expect(await rerun(fund(f))).toMatchObject({
      ok: true,
      operation: { state: "confirmed", step: "v2-fund" },
    });
    expect(f.typedSign).toHaveBeenCalledTimes(1);
    expect(f.client.confirmV2Signature).toHaveBeenCalledTimes(1);
    expect(f.sign).toHaveBeenCalledTimes(1);
    expect(f.rpc.sendRawTransaction).toHaveBeenCalledTimes(1);
    expect(await spent(f)).toBe("100000000");
  });
  it("signs nothing new for a mined funding, whatever step vAPI asks for", async () => {
    const f = onBase(await fixture("v2-fund"), READINESS_V2_ONLY);
    authorizedFunding(f, 8453, BASE_USDC);
    await sentThenDropped(f, { action: "fund" }, "100000000");
    nodeHoldsItAsMined(f);
    // The API answers with an approval that would pass every plan check.
    const approval = {
      ...f.prepared.operation,
      step: "v2-approve-usdc" as const,
      plan: {
        ...f.prepared.operation.plan,
        step: "v2-approve-usdc" as const,
        to: BASE_USDC,
        data: encodeFunctionData({
          abi: parseAbi(["function approve(address,uint256) returns (bool)"]),
          functionName: "approve",
          args: [state.escrow, 100_000_000n],
        }),
      },
    };
    f.client.operationV2.mockImplementation(async () => ({
      ...f.prepared,
      operation: approval,
      recovered: false,
      scanComplete: true,
    }));
    await expect(
      f.execute({ ...fund(f), policy: { maxPerTaskUsd: 50, approveAboveUsd: 0 } }),
    ).rejects.toMatchObject({
      code: "invalid_response",
      message:
        "vAPI asks for an earlier step although the last step of this operation is mined. Nothing was signed.",
    });
    expect(f.sign).toHaveBeenCalledTimes(1);
    expect(f.typedSign).toHaveBeenCalledTimes(1);
    expect(f.rpc.sendRawTransaction).toHaveBeenCalledTimes(1);
  });
  it("prepares a new authorization when the saved one ran out before anything was signed", async () => {
    const f = onBase(await fixture("v2-fund"), READINESS_V2_ONLY);
    const first = authorizedFunding(f, 8453, BASE_USDC);
    walletHolds(f, 0n);
    await expect(f.execute(fund(f))).rejects.toMatchObject({ code: "insufficient_usdc" });
    const key = await journalKey(f);
    // Inside the window the saved authorization is used again.
    await expect(f.execute(fund(f))).rejects.toMatchObject({ code: "insufficient_usdc" });
    expect(f.client.prepareV2).toHaveBeenCalledTimes(1);
    expect(await journalKey(f)).toBe(key);
    // Two hours later the wallet is topped up. vAPI hands out a new authorization.
    walletHolds(f, 1_000_000_000n);
    const message = {
      ...first.typedData.message,
      validAfter: (NOW_SECONDS + 7199n).toString(),
      validBefore: (NOW_SECONDS + 7500n).toString(),
      nonce: `0x${"34".repeat(32)}`,
    };
    const second = { ...first, typedData: { ...first.typedData, message } };
    f.client.prepareV2.mockResolvedValue(second);
    f.client.confirmV2Signature.mockImplementation(
      async (_id: string, _op: string, signature: `0x${string}`) => {
        f.prepared.operation.plan.data = encodeFunctionData({
          abi: escrowV2Abi,
          functionName: "fundWithAuthorization",
          args: [
            account.address,
            BigInt(message.validAfter),
            BigInt(message.validBefore),
            message.nonce as `0x${string}`,
            signature,
          ],
        });
        return f.prepared;
      },
    );
    expect(await twoHoursLater(f)(fund(f))).toMatchObject({ ok: true });
    expect(f.client.prepareV2).toHaveBeenCalledTimes(2);
    const keys = (
      f.client.prepareV2.mock.calls as unknown as [string, unknown, { idempotencyKey: string }][]
    ).map((call) => call[2].idempotencyKey);
    expect(keys[0]).toBe(key);
    expect(keys[1]).not.toBe(key);
    expect(f.typedSign).toHaveBeenCalledTimes(1);
    expect(f.typedSign).toHaveBeenCalledWith(second.typedData);
    expect(await spent(f)).toBe("100000000");
  });
  it("keeps an authorization that was signed, also after its window", async () => {
    const f = onBase(await fixture("v2-fund"), READINESS_V2_ONLY);
    authorizedFunding(f, 8453, BASE_USDC);
    // Signed and counted; the upload is never answered, so no transaction exists.
    f.client.confirmV2Signature.mockRejectedValueOnce(new Error("socket hang up"));
    await expect(f.execute(fund(f))).rejects.toMatchObject({ code: "chain_error" });
    const key = await journalKey(f);
    // The ledger is lost as well: the journal alone remembers the signature.
    await rm(f.input.ledgerPath);
    await expect(twoHoursLater(f)(fund(f))).rejects.toMatchObject({ code: "v2_plan_mismatch" });
    expect(await journalKey(f)).toBe(key);
    expect(f.client.prepareV2).toHaveBeenCalledTimes(1);
    expect(f.typedSign).toHaveBeenCalledTimes(1);
  });
  it("holds the unsigned steps of a started create, approve and fund sequence", async () => {
    const f = onBase(await fixture("v2-approve-usdc"), READINESS_V2_ONLY);
    freshFunding(
      f,
      encodeFunctionData({
        abi: escrowFactoryV2Abi,
        functionName: "createEscrow",
        args: creationArgs(f.view, BASE, 0),
      }),
      BASE,
    );
    // The clone is created; the node then refuses to estimate the approval.
    const estimate = vi.mocked(prepareTransactionRequest);
    estimate
      .mockImplementationOnce(estimate.getMockImplementation()!)
      .mockRejectedValueOnce(new Error("execution reverted"));
    await expect(f.execute({ ...f.input, write: { action: "fund" } })).rejects.toMatchObject({
      code: "chain_error",
    });
    expect(f.sign).toHaveBeenCalledTimes(1);
    serve(f, READINESS_UNAVAILABLE);
    await expect(f.execute({ ...f.input, write: { action: "fund" } })).rejects.toMatchObject({
      code: "tasks_unavailable",
      message: `vAPI reports Tasks as unavailable on Base right now. ${STILL_STANDS}`,
    });
    expect(f.sign).toHaveBeenCalledTimes(1);
    expect(f.rpc.sendRawTransaction).toHaveBeenCalledTimes(1);
    serve(f, READINESS_V2_ONLY);
    expect(await f.execute({ ...f.input, write: { action: "fund" } })).toMatchObject({
      ok: true,
      operation: { step: "v2-fund", state: "confirmed" },
    });
    expect(f.sign).toHaveBeenCalledTimes(3);
    expect(await spent(f)).toBe("100000000");
  });
  it("takes a saved signed transaction alone as proof that the operation started", async () => {
    const f = onBase(await fixture("v2-fund"), READINESS_V2_ONLY);
    await sentThenDropped(f, { action: "fund" }, "100000000");
    // The spend ledger is lost; the signed transaction is still saved next to the journal.
    await rm(f.input.ledgerPath);
    serve(f, READINESS_UNAVAILABLE);
    walletHolds(f, 0n);
    expect(await f.execute({ ...f.input, write: { action: "fund" } })).toMatchObject({ ok: true });
    expect(f.sign).toHaveBeenCalledTimes(1);
    expect(await spent(f)).toBe("100000000");
  });
  it("still refuses a first run that only kept its preparation", async () => {
    const f = onBase(await fixture("v2-fund"), READINESS_UNAVAILABLE);
    const intent = authorizedFunding(f, 8453, BASE_USDC);
    const run = () => f.execute({ ...f.input, write: { action: "fund" }, prepared: intent });
    await expect(run()).rejects.toMatchObject({ code: "tasks_unavailable" });
    // The journal and the intent are saved, but nothing was signed: the rerun is a first run.
    await expect(run()).rejects.toMatchObject({
      code: "tasks_unavailable",
      message:
        "vAPI reports Tasks as unavailable on Base right now. Nothing was signed and no money moved. Try again later.",
    });
    nothingLeftTheMachine(f);
    await noLedger(f);
  });
});
