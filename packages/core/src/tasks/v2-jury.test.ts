import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  encodeFunctionData,
  getAddress,
  keccak256,
  parseAbi,
  zeroAddress,
  zeroHash,
  type Hex,
  type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import {
  listTaskV2Ballots,
  readTaskV2Ballot,
  taskV2BallotPath,
  writeTaskV2Ballot,
  type TaskV2Ballot,
} from "./ballots.js";
import type { TasksChainOptions } from "./chain.js";
import { TasksClientError, type TasksClient } from "./client.js";
import type { TaskOperationContext, TaskOperationError } from "./operation-support.js";
import { createPendingTransactions } from "./pending-transactions.js";
import { readSpendLedger } from "../spend-policy.js";
import { disputeResolverV3Abi, escrowV2Abi } from "./v2-abi.js";
import { createTaskV2Executor, executeTaskV2, recoverTaskV2 } from "./v2-execution.js";
import {
  createTaskV2Jury,
  readTaskV2ReviewerStatus,
  runTaskV2Jury,
  runTaskV2Vote,
  taskV2CaseId,
  taskV2VoteCommitment,
} from "./v2-jury.js";
import { acceptedV2TermsHash, verifyV2Plan, verifyV2Target } from "./v2-plan-guard.js";
import { taskV2OperationResponseSchema, type TaskV2Action } from "./v2-write.js";
import { V2_WRITE_OPERATION, V2_WRITE_ORDER } from "./fixtures/tasks-v2-writes.js";
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
const POSTER = getAddress(`0x${"aa".repeat(20)}`);
const ESCROW = getAddress(`0x${"22".repeat(20)}`);
const USDC = getAddress(`0x${"44".repeat(20)}`);
const FACTORY = getAddress(`0x${"55".repeat(20)}`);
const POOL_FACTORY = getAddress(`0x${"66".repeat(20)}`);
const RESOLVER = getAddress(`0x${"99".repeat(20)}`);
const IMPLEMENTATION = getAddress(`0x${"67".repeat(20)}`);
const OTHER = getAddress(`0x${"bb".repeat(20)}`);
const ROUND = 1;
// keccak256(abi.encode(ESCROW, 0, ROUND)), DisputeResolverV3 `_caseId`; see the vector test.
const CASE_ID = "0xba4627d02ca66c0baf94b16a1d1976338b69f2a517570fb9b91e993e361ffcaf" as Hex;
const DEADLINE = "2026-10-28T12:00:00.000Z";
const NOW_SECONDS = BigInt(Date.parse("2026-10-26T12:00:00Z") / 1000);
const PIN = {
  escrowFactoryV2: FACTORY,
  disputeResolverV3: RESOLVER,
  bountyPoolFactoryV1: POOL_FACTORY,
  usdc: USDC,
  usdcName: "USD Coin",
  usdcVersion: "2",
  offerTtlSeconds: 86400,
};
const SALT = `0x${"5a".repeat(32)}` as Hex;
const statuses = ["pending", "submitted", "released", "refunded", "disputed", "split"];
const approvalAbi = parseAbi(["function approve(address spender, uint256 amount) returns (bool)"]);

function view(workerBondBp?: number) {
  return {
    workOrder: {
      id: V2_WRITE_ORDER,
      clientAddress: POSTER,
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
        ...(workerBondBp === undefined ? {} : { workerBondBp }),
      },
      v2State: {
        escrow: ESCROW,
        feeBp: 500,
        totalBaseUnits: "100000000",
        paidBaseUnits: "0",
        refundedBaseUnits: "0",
        milestones: [{ amountBaseUnits: "100000000", status: "disputed" }],
      },
    },
    lifecycle: { shape: "task", state: "Active" },
    nextAction: { action: "judge" },
  };
}
/** DisputeResolverV3 `_commitment` for this wallet in ROUND, as the contract computes it. */
function contractCommitment(i: number, outcome: number, toWorker: bigint, salt: Hex): Hex {
  return taskV2VoteCommitment({
    escrow: ESCROW,
    i,
    round: ROUND,
    reviewer: account.address,
    outcome,
    toWorker,
    salt,
  });
}

/** What the hosted builder encodes for each write; the guard decodes and binds it locally. */
function hostedPlan(write: TaskV2Action) {
  const at = [ESCROW, "i" in write ? write.i : 0] as const;
  const resolverCall = (functionName: string, args: readonly unknown[]) => ({
    to: RESOLVER,
    data: encodeFunctionData({
      abi: disputeResolverV3Abi,
      functionName: functionName as "openJury",
      args: args as never,
    }),
  });
  switch (write.action) {
    case "open-jury":
      return { step: "v2-open-jury", ...resolverCall("openJury", at) };
    case "draw-jury":
      return { step: "v2-draw-jury", ...resolverCall("drawJury", at) };
    case "rearm-draw":
      return { step: "v2-rearm-draw", ...resolverCall("rearmDraw", at) };
    case "resolve":
      return { step: "v2-resolve", ...resolverCall("resolve", at) };
    case "commit-vote":
      return { step: "v2-commit-vote", ...resolverCall("commitVote", [...at, write.commitment]) };
    case "reveal-vote":
      return {
        step: "v2-reveal-vote",
        ...resolverCall("revealVote", [...at, write.outcome, BigInt(write.toWorker), write.salt]),
      };
    case "approve-bond":
      return {
        step: "v2-approve-usdc",
        to: USDC,
        data: encodeFunctionData({
          abi: approvalAbi,
          functionName: "approve",
          args: [ESCROW, 10_000_000n],
        }),
      };
    case "claim-owed":
      return {
        step: "v2-claim-owed",
        to: ESCROW,
        data: encodeFunctionData({
          abi: escrowV2Abi,
          functionName: "claimOwed",
          args: [write.to ?? account.address],
        }),
      };
    default:
      throw new Error(`No hosted plan for ${write.action}`);
  }
}
function operation(plan: { step: string; to: string; data: Hex }) {
  return taskV2OperationResponseSchema.parse({
    orderId: V2_WRITE_ORDER,
    operation: {
      id: V2_WRITE_OPERATION,
      kind: "tasks-v2-write",
      state: "prepared",
      step: plan.step,
      expectedActor: account.address,
      transactionHash: null,
      plan: {
        version: "work-transaction-plan-v2",
        operationId: V2_WRITE_OPERATION,
        step: plan.step,
        chainId: 84532,
        network: "eip155:84532",
        from: account.address,
        to: plan.to,
        data: plan.data,
        value: "0",
      },
    },
  });
}

async function fixture(options: { worker?: string; workerBondBp?: number } = {}) {
  const home = await mkdtemp(join(tmpdir(), "vapi-v2-jury-"));
  homes.push(home);
  const order = view(options.workerBondBp);
  const chain = {
    commitment: zeroHash as Hex,
    round: ROUND,
    // Queued caseData states; Voting (4) once the queue is empty.
    caseStates: [] as number[],
    evidenceDeadline: NOW_SECONDS - 3600n,
    commitDeadline: NOW_SECONDS - 60n,
    revealDeadline: NOW_SECONDS + 3600n,
    resolverOnClone: RESOLVER as string,
    owed: 5_000_000n,
    workerBondBp: undefined as number | undefined,
    termsHash: undefined as Hex | undefined,
  };
  const rpc = {
    getChainId: vi.fn(async () => 84532),
    getTransactionCount: vi.fn(async () => 0),
    sendRawTransaction: vi.fn(async ({ serializedTransaction }: { serializedTransaction: Hex }) =>
      keccak256(serializedTransaction),
    ),
    waitForTransactionReceipt: vi.fn(async () => ({ status: "success" })),
    getBlock: vi.fn(async () => ({ timestamp: NOW_SECONDS })),
    readContract: vi.fn(
      async (call: {
        functionName: string;
        args?: readonly unknown[];
        address?: string;
      }): Promise<unknown> => {
        switch (call.functionName) {
          case "isEscrow":
            return true;
          case "paymentToken":
          case "USDC":
            return USDC;
          case "FACTORY":
            return FACTORY;
          case "implementation":
            return IMPLEMENTATION;
          case "MIN_OBJECTION_WINDOW":
            return 86400n;
          case "feeBp":
            return 500;
          case "terms":
            return {
              shape: 0,
              poster: POSTER,
              worker: options.worker ?? OTHER,
              termsHash:
                chain.termsHash ??
                acceptedV2TermsHash(
                  order as unknown as import("./types.js").GetOrderResponse,
                  PIN,
                  604800n,
                ),
              offerTtl: 86400n,
              reviewWindow: 604800n,
              choiceWindow: 0n,
              bountyDeadline: 0n,
              objectionWindow: 604800n,
              workerBondBp: chain.workerBondBp ?? options.workerBondBp ?? 0,
              feeBp: 500,
              winners: 0,
              rewardPerWinner: 0n,
            };
          case "totalPrincipal":
            return 100000000n;
          case "milestoneCount":
            return 1;
          case "milestone": {
            const m = order.workOrder.v2State.milestones[Number(call.args![0])]!;
            return {
              amount: BigInt(m.amountBaseUnits),
              deadline: BigInt(Date.parse(DEADLINE) / 1000),
              status: statuses.indexOf(m.status),
              deliveryHash: zeroHash,
            };
          }
          case "predictEscrow":
            return ESCROW;
          case "DISPUTE_RESOLVER":
            return chain.resolverOnClone;
          case "currentCaseId":
            return taskV2CaseId(
              getAddress(call.args![0] as string),
              Number(call.args![1]),
              chain.round,
            );
          case "disputeRound":
            return chain.round;
          case "commitments":
            return chain.commitment;
          case "caseData":
            return {
              state: chain.caseStates.shift() ?? 4,
              raisedBy: POSTER,
              evidenceDeadline: chain.evidenceDeadline,
              commitDeadline: chain.commitDeadline,
              revealDeadline: chain.revealDeadline,
            };
          case "owed":
            return chain.owed;
          default:
            throw new Error(`Unexpected RPC read ${call.functionName}`);
        }
      },
    ),
  };
  const writes: TaskV2Action[] = [];
  const events: string[] = [];
  const client = {
    prepareV2: vi.fn(async (_id: string, write: TaskV2Action) => {
      writes.push(write);
      events.push(`prepare:${write.action}`);
      return operation(hostedPlan(write));
    }),
    signV2: vi.fn(),
    confirmV2Signature: vi.fn(),
    operationV2: vi.fn(
      async (_id: string, mode: string, body: { step: string; transactionHash?: string }) => {
        const write = writes.at(-1)!;
        const prepared = operation(hostedPlan(write));
        if (mode === "recover") return { ...prepared, recovered: false, scanComplete: true };
        return {
          ...prepared,
          operation: {
            ...prepared.operation,
            state: mode === "transaction" ? "submitted" : "confirmed",
            transactionHash: body.transactionHash,
          },
        };
      },
    ),
    getOrder: vi.fn(async () => order),
    deployment: vi.fn(async () => ({
      configured: true,
      chainId: 84532,
      network: "eip155:84532",
      usdc: USDC,
      feeBp: 500,
    })),
  };
  const pending = createPendingTransactions(home);
  const options_: TasksChainOptions = {
    client: client as unknown as TasksClient,
    account,
    pending,
    rpcFor: () => rpc as unknown as PublicClient,
    sleep: vi.fn(async () => {}),
    env: {},
    trustedV2Deployments: { 84532: PIN },
    onV2UntrustedOverride: vi.fn(),
    now: () => new Date("2026-10-26T12:00:00Z"),
    randomBytes: (size) => new Uint8Array(size).fill(0x5a),
    ballotsHome: home,
  };
  const context: TaskOperationContext = {
    client: client as unknown as TasksClient,
    chain: {
      available: true,
      executeV2: createTaskV2Executor(options_),
      juryV2: createTaskV2Jury(options_),
    } as unknown as TaskOperationContext["chain"],
    pending,
    baseUrl: "https://tasks.example",
    randomUUID: () => crypto.randomUUID(),
    signInHint: "sign in",
  };
  const base = {
    id: V2_WRITE_ORDER,
    policy: { maxPerTaskUsd: 200, approveAboveUsd: 200 },
    caps: { perCallAtomic: "1", perDayAtomic: "200000000" },
    wallet: "juror" as WalletName,
    ledgerPath: join(home, "spend-ledger.json"),
  };
  return { home, rpc, client, chain, options: options_, context, base, order, writes, events };
}

async function guard(
  f: Awaited<ReturnType<typeof fixture>>,
  action: TaskV2Action,
  plan = hostedPlan(action),
  pays = 0n,
) {
  const op = operation(plan);
  const target = await verifyV2Target(
    f.options,
    op,
    f.order as unknown as import("./types.js").GetOrderResponse,
    action,
  );
  return verifyV2Plan(target, op.operation, action, pays);
}

describe("V2 jury plan guard", () => {
  const COMMIT = `0x${"ab".repeat(32)}` as Hex;
  const accepted: TaskV2Action[] = [
    { action: "open-jury", i: 0 },
    { action: "draw-jury", i: 0 },
    { action: "rearm-draw", i: 0 },
    { action: "resolve", i: 0 },
    { action: "commit-vote", i: 0, commitment: COMMIT },
    { action: "reveal-vote", i: 0, outcome: 2, toWorker: "40000000", salt: SALT },
    { action: "claim-owed" },
    { action: "claim-owed", to: OTHER },
  ];
  it.each(accepted)("accepts the hosted plan for $action", async (action) => {
    const f = await fixture();
    await expect(guard(f, action)).resolves.toBeUndefined();
  });

  it("accepts continueJury for a Snapshotting open step", async () => {
    const f = await fixture();
    const action = { action: "open-jury", i: 0 } as const;
    const plan = {
      step: "v2-open-jury",
      to: RESOLVER,
      data: encodeFunctionData({
        abi: disputeResolverV3Abi,
        functionName: "continueJury",
        args: [ESCROW, 0],
      }),
    };
    await expect(guard(f, action, plan)).resolves.toBeUndefined();
  });

  it("accepts the worker bond approval of the verified clone for the agreed amount", async () => {
    const f = await fixture({ worker: zeroAddress, workerBondBp: 1000 });
    await expect(
      guard(f, { action: "approve-bond" }, hostedPlan({ action: "approve-bond" }), 10_000_000n),
    ).resolves.toBeUndefined();
  });

  const reveal = {
    action: "reveal-vote",
    i: 0,
    outcome: 2,
    toWorker: "40000000",
    salt: SALT,
  } as const;
  const mismatches: Array<[string, TaskV2Action, TaskV2Action]> = [
    ["i", { action: "resolve", i: 0 }, { action: "resolve", i: 1 }],
    [
      "commitment",
      { action: "commit-vote", i: 0, commitment: COMMIT },
      { action: "commit-vote", i: 0, commitment: `0x${"cd".repeat(32)}` },
    ],
    ["outcome", reveal, { ...reveal, outcome: 0, toWorker: "0" }],
    ["toWorker", reveal, { ...reveal, toWorker: "40000001" }],
    ["salt", reveal, { ...reveal, salt: `0x${"5b".repeat(32)}` }],
    ["selector", { action: "draw-jury", i: 0 }, { action: "rearm-draw", i: 0 }],
    ["claim recipient", { action: "claim-owed", to: OTHER }, { action: "claim-owed" }],
  ];
  it.each(mismatches)("rejects a plan with another %s", async (_label, requested, prepared) => {
    const f = await fixture();
    const plan = { ...hostedPlan(prepared), step: hostedPlan(requested).step };
    await expect(guard(f, requested, plan)).rejects.toMatchObject({ code: "v2_plan_mismatch" });
  });

  it("rejects a resolver plan sent anywhere but the clone's DISPUTE_RESOLVER()", async () => {
    const f = await fixture();
    const action = { action: "resolve", i: 0 } as const;
    await expect(guard(f, action, { ...hostedPlan(action), to: OTHER })).rejects.toMatchObject({
      code: "v2_plan_mismatch",
    });
  });

  it("rejects a resolver that is not the verified clone's, even when the plan matches it", async () => {
    const f = await fixture();
    f.chain.resolverOnClone = OTHER;
    const action = { action: "open-jury", i: 0 } as const;
    await expect(guard(f, action)).rejects.toMatchObject({ code: "v2_plan_mismatch" });
  });

  it("rejects a clone resolver that differs from the local resolver pin", async () => {
    const f = await fixture();
    f.options.trustedV2Deployments = { 84532: { ...PIN, disputeResolverV3: OTHER } };
    await expect(guard(f, { action: "draw-jury", i: 0 })).rejects.toMatchObject({
      code: "v2_plan_mismatch",
    });
  });

  it("rejects a bond approval with another spender, another amount, or from the poster", async () => {
    const f = await fixture({ worker: zeroAddress, workerBondBp: 1000 });
    const other = {
      step: "v2-approve-usdc",
      to: USDC,
      data: encodeFunctionData({
        abi: approvalAbi,
        functionName: "approve",
        args: [OTHER, 10_000_000n],
      }),
    };
    await expect(guard(f, { action: "approve-bond" }, other, 10_000_000n)).rejects.toMatchObject({
      code: "v2_plan_mismatch",
    });
    await expect(
      guard(f, { action: "approve-bond" }, hostedPlan({ action: "approve-bond" }), 9_000_000n),
    ).rejects.toMatchObject({ code: "v2_plan_mismatch" });
    const poster = await fixture({ worker: OTHER, workerBondBp: 1000 });
    await expect(
      guard(
        poster,
        { action: "approve-bond" },
        hostedPlan({ action: "approve-bond" }),
        10_000_000n,
      ),
    ).rejects.toMatchObject({ code: "v2_plan_mismatch" });
  });

  it("rejects a claim-owed plan that targets another contract", async () => {
    const f = await fixture();
    const action = { action: "claim-owed" } as const;
    await expect(guard(f, action, { ...hostedPlan(action), to: RESOLVER })).rejects.toMatchObject({
      code: "v2_plan_mismatch",
    });
  });
});

describe("local ballot store", () => {
  const ballot = (
    commitment: Hex,
    outcome: 0 | 1 | 2 = 0,
    createdAt = "2026-10-26T12:00:00.000Z",
  ): TaskV2Ballot => ({
    version: "vapi-tasks-ballot-v1",
    orderId: V2_WRITE_ORDER,
    chainId: 84532,
    resolver: RESOLVER.toLowerCase() as Hex,
    escrow: ESCROW.toLowerCase() as Hex,
    i: 0,
    caseId: CASE_ID,
    voter: account.address.toLowerCase() as Hex,
    outcome,
    toWorker: "0",
    salt: SALT,
    commitment,
    createdAt,
  });

  it("writes mode 0600 and finds a ballot only by its exact commitment and voter", async () => {
    const home = await mkdtemp(join(tmpdir(), "vapi-ballots-"));
    homes.push(home);
    const sealed = ballot(`0x${"01".repeat(32)}`);
    const path = await writeTaskV2Ballot(home, sealed);
    expect(path).toBe(
      join(
        home,
        "tasks",
        "ballots",
        "84532",
        RESOLVER.toLowerCase(),
        CASE_ID,
        `${sealed.commitment}.json`,
      ),
    );
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    const key = { chainId: 84532, resolver: RESOLVER, caseId: CASE_ID, voter: account.address };
    await expect(
      readTaskV2Ballot(home, { ...key, commitment: sealed.commitment }),
    ).resolves.toEqual(sealed);
    await expect(
      readTaskV2Ballot(home, { ...key, commitment: `0x${"02".repeat(32)}` }),
    ).resolves.toBeUndefined();
    await expect(
      readTaskV2Ballot(home, { ...key, voter: OTHER, commitment: sealed.commitment }),
    ).resolves.toBeUndefined();
  });

  it("lists every sealed ballot of a round, oldest first", async () => {
    const home = await mkdtemp(join(tmpdir(), "vapi-ballots-"));
    homes.push(home);
    await writeTaskV2Ballot(home, ballot(`0x${"ff".repeat(32)}`, 1, "2026-10-26T12:00:00.000Z"));
    await writeTaskV2Ballot(home, ballot(`0x${"00".repeat(31)}01`, 0, "2026-10-26T12:05:00.000Z"));
    const listed = await listTaskV2Ballots(home, {
      chainId: 84532,
      resolver: RESOLVER,
      caseId: CASE_ID,
    });
    expect(listed.map((b) => b.outcome)).toEqual([1, 0]);
  });
});

describe("V2 vote commit and reveal", () => {
  it("seals the ballot before the commit plan is requested and sends only the commitment", async () => {
    const f = await fixture();
    let sealedBeforePlan = false;
    f.client.prepareV2.mockImplementationOnce(async (_id, write) => {
      f.writes.push(write);
      const ballots = await listTaskV2Ballots(f.home, {
        chainId: 84532,
        resolver: RESOLVER,
        caseId: CASE_ID,
      });
      sealedBeforePlan =
        ballots.length === 1 &&
        write.action === "commit-vote" &&
        ballots[0]!.commitment === write.commitment;
      return operation(hostedPlan(write));
    });
    const result = await runTaskV2Vote(f.context, {
      ...f.base,
      i: 0,
      action: "commit",
      outcome: "split",
      toWorker: "40000000",
    });
    expect(sealedBeforePlan).toBe(true);
    expect(result).toMatchObject({ ok: true, ballot: { caseId: CASE_ID } });
    const write = f.writes[0]!;
    expect(write).toEqual({ action: "commit-vote", i: 0, commitment: result.ballot.commitment });
    expect(JSON.stringify(write)).not.toContain(SALT.slice(2));
    expect(result.ballot.commitment).toBe(contractCommitment(0, 2, 40000000n, SALT));
    const stored = JSON.parse(await readFile(result.ballot.path, "utf8")) as TaskV2Ballot;
    expect(stored).toMatchObject({ outcome: 2, toWorker: "40000000", salt: SALT });
  });

  it("keeps a revealable ballot after a crash between the write and the plan", async () => {
    const f = await fixture();
    f.client.prepareV2.mockRejectedValueOnce(new Error("network down"));
    await expect(
      runTaskV2Vote(f.context, { ...f.base, i: 0, action: "commit", outcome: "poster" }),
    ).rejects.toThrow();
    const [ballot] = await listTaskV2Ballots(f.home, {
      chainId: 84532,
      resolver: RESOLVER,
      caseId: CASE_ID,
    });
    expect(ballot).toMatchObject({ outcome: 1, toWorker: "0" });
    // The commit mined from another attempt with that sealed ballot; reveal finds it.
    f.chain.commitment = ballot!.commitment;
    const result = await runTaskV2Vote(f.context, { ...f.base, i: 0, action: "reveal" });
    expect(result).toMatchObject({ ok: true, ballot: { commitment: ballot!.commitment } });
    expect(f.writes.at(-1)).toEqual({
      action: "reveal-vote",
      i: 0,
      outcome: 1,
      toWorker: "0",
      salt: SALT,
    });
  });

  it("reveals the ballot matching the onchain commitment and ignores a replaced one", async () => {
    const f = await fixture();
    const jury = createTaskV2Jury({
      ...f.options,
      randomBytes: (n) => new Uint8Array(n).fill(0x11),
    });
    const replaced = await jury.sealBallot({ id: V2_WRITE_ORDER, i: 0, outcome: 0, toWorker: "0" });
    const mined = await createTaskV2Jury(f.options).sealBallot({
      id: V2_WRITE_ORDER,
      i: 0,
      outcome: 1,
      toWorker: "0",
    });
    expect(replaced.ballot.commitment).not.toBe(mined.ballot.commitment);
    f.chain.commitment = mined.ballot.commitment;
    await runTaskV2Vote(f.context, { ...f.base, i: 0, action: "reveal" });
    expect(f.writes.at(-1)).toMatchObject({ action: "reveal-vote", outcome: 1, salt: SALT });
  });

  it("refuses to reveal without a commitment or without the matching local ballot", async () => {
    const f = await fixture();
    await expect(
      runTaskV2Vote(f.context, { ...f.base, i: 0, action: "reveal" }),
    ).rejects.toMatchObject({
      code: "no_commitment",
    });
    f.chain.commitment = `0x${"de".repeat(32)}`;
    await expect(
      runTaskV2Vote(f.context, { ...f.base, i: 0, action: "reveal" }),
    ).rejects.toMatchObject({
      code: "ballot_unavailable",
    });
    expect(f.client.prepareV2).not.toHaveBeenCalled();
  });

  it("validates vote arguments before any chain read", async () => {
    const f = await fixture();
    for (const input of [
      { action: "commit" as const },
      { action: "commit" as const, outcome: "split" as const },
      { action: "commit" as const, outcome: "worker" as const, toWorker: "5" },
      { action: "reveal" as const, outcome: "worker" as const },
    ])
      await expect(runTaskV2Vote(f.context, { ...f.base, i: 0, ...input })).rejects.toMatchObject({
        code: "invalid_input",
      });
    expect(f.rpc.readContract).not.toHaveBeenCalled();
  });

  it("computes the commitment and case id exactly as DisputeResolverV3 does", () => {
    // Fixed vectors from Foundry against DisputeResolverV3 `_commitment` / `_caseId`
    // (contracts/src/DisputeResolverV3.sol: keccak256(abi.encode(...))), reviewer = this
    // test account (0xAe72A48c1a36bd18Af168541c53037965d26e4A8):
    //   cast keccak $(cast abi-encode "f(address,uint8,uint32,address,uint8,uint96,bytes32)" \
    //     0x2222222222222222222222222222222222222222 0 1 0xAe72A48c1a36bd18Af168541c53037965d26e4A8 \
    //     2 40000000 0x5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a)
    //   cast keccak $(cast abi-encode "f(address,uint8,uint32)" \
    //     0x2222222222222222222222222222222222222222 0 1)
    expect(account.address).toBe("0xAe72A48c1a36bd18Af168541c53037965d26e4A8");
    expect(contractCommitment(0, 2, 40000000n, SALT)).toBe(
      "0x862791faf680653faf4fc752c50c2e09de0be3cdf02d846e53e0844cbe40b34a",
    );
    expect(taskV2CaseId(ESCROW, 0, ROUND)).toBe(CASE_ID);
  });

  it("never sends the vote or its salt over RPC while committing or revealing", async () => {
    const f = await fixture();
    const result = await runTaskV2Vote(f.context, {
      ...f.base,
      i: 0,
      action: "commit",
      outcome: "split",
      toWorker: "40000000",
    });
    expect(result.ballot.commitment).toBe(contractCommitment(0, 2, 40000000n, SALT));
    f.chain.commitment = result.ballot.commitment;
    await runTaskV2Vote(f.context, { ...f.base, i: 0, action: "reveal" });
    const calls = JSON.stringify(f.rpc.readContract.mock.calls, (_, v: unknown) =>
      typeof v === "bigint" ? v.toString() : v,
    ).toLowerCase();
    expect(calls).not.toContain(SALT.slice(2, 18));
    expect(calls).not.toContain("40000000");
    expect(f.rpc.readContract.mock.calls.map(([call]) => call.functionName)).not.toContain(
      "voteCommitment",
    );
  });

  it("never signs a sealed commitment after the dispute moved to a new round", async () => {
    const f = await fixture();
    f.client.prepareV2.mockImplementationOnce(async (_id, write) => {
      f.writes.push(write);
      // A tie restored the case and a new round opened while the commit was being prepared.
      f.chain.round = ROUND + 1;
      return operation(hostedPlan(write));
    });
    const signed = vi.spyOn(account, "signTransaction");
    const error = await runTaskV2Vote(f.context, {
      ...f.base,
      i: 0,
      action: "commit",
      outcome: "worker",
    }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      code: "v2_round_changed",
      message: expect.stringContaining("vote --commit again"),
    });
    expect(signed).not.toHaveBeenCalled();
    expect(f.rpc.sendRawTransaction).not.toHaveBeenCalled();
    expect(f.client.prepareV2).toHaveBeenCalledTimes(1);
  });

  it("refuses to seal a ballot when the case id does not match the dispute round", async () => {
    const f = await fixture();
    const original = f.rpc.readContract.getMockImplementation()!;
    f.rpc.readContract.mockImplementation(async (call) =>
      call.functionName === "disputeRound" ? ROUND + 1 : original(call),
    );
    await expect(
      runTaskV2Vote(f.context, { ...f.base, i: 0, action: "commit", outcome: "poster" }),
    ).rejects.toMatchObject({ code: "invalid_response" });
    expect(f.client.prepareV2).not.toHaveBeenCalled();
    await expect(
      listTaskV2Ballots(f.home, { chainId: 84532, resolver: RESOLVER, caseId: CASE_ID }),
    ).resolves.toEqual([]);
  });

  it("keeps the salt out of reveal results, progress and signing errors", async () => {
    const f = await fixture();
    const sealed = await createTaskV2Jury(f.options).sealBallot({
      id: V2_WRITE_ORDER,
      i: 0,
      outcome: 1,
      toWorker: "0",
    });
    f.chain.commitment = sealed.ballot.commitment;
    const ok = await runTaskV2Vote(f.context, { ...f.base, i: 0, action: "reveal" });
    expect(ok).toMatchObject({ ok: true, ballot: { commitment: sealed.ballot.commitment } });
    expect(JSON.stringify(ok)).not.toContain(SALT.slice(2, 18));
    // A failure after the plan is verified carries the operation as progress, never its calldata.
    const g = await fixture();
    await createTaskV2Jury(g.options).sealBallot({
      id: V2_WRITE_ORDER,
      i: 0,
      outcome: 1,
      toWorker: "0",
    });
    g.chain.commitment = sealed.ballot.commitment;
    g.rpc.getTransactionCount.mockRejectedValueOnce(new Error("rpc down"));
    const error = (await runTaskV2Vote(g.context, { ...g.base, i: 0, action: "reveal" }).catch(
      (caught: unknown) => caught,
    )) as TaskOperationError;
    expect(error).toBeInstanceOf(Error);
    expect(JSON.stringify({ message: error.message, details: error.details })).not.toContain(
      SALT.slice(2, 18),
    );
    expect(error.details).toMatchObject({
      operation: { plan: { data: "[redacted: reveal calldata]" } },
    });
  });

  it.each([
    ["during the commit window", "reveal_not_open", { commitDeadline: NOW_SECONDS }],
    ["after the reveal window", "reveal_window_closed", { revealDeadline: NOW_SECONDS - 1n }],
    ["outside the voting stage", "reveal_unavailable", { caseStates: [5] }],
  ] as const)(
    "refuses to reveal %s before the salt leaves the machine",
    async (_n, code, chain) => {
      const f = await fixture();
      const sealed = await createTaskV2Jury(f.options).sealBallot({
        id: V2_WRITE_ORDER,
        i: 0,
        outcome: 1,
        toWorker: "0",
      });
      f.chain.commitment = sealed.ballot.commitment;
      Object.assign(f.chain, "caseStates" in chain ? { caseStates: [...chain.caseStates] } : chain);
      await expect(
        runTaskV2Vote(f.context, { ...f.base, i: 0, action: "reveal" }),
      ).rejects.toMatchObject({ code });
      expect(f.client.prepareV2).not.toHaveBeenCalled();
    },
  );

  it("refuses a second, different commit in the same round", async () => {
    const f = await fixture();
    f.chain.commitment = `0x${"de".repeat(32)}`;
    await expect(
      runTaskV2Vote(f.context, { ...f.base, i: 0, action: "commit", outcome: "worker" }),
    ).rejects.toMatchObject({ code: "already_committed" });
  });
});

describe("hosted echoes on vote paths", () => {
  const SPLIT = "40000000";
  const ECHO = { salt: SALT, toWorker: SPLIT, outcome: 2 };
  /** Nothing a caller sees may contain the salt or the split amount. */
  const leaks = (value: unknown) => {
    const text = JSON.stringify(value, (_, v: unknown) =>
      typeof v === "bigint" ? v.toString() : v,
    );
    return text.includes(SALT.slice(2, 18)) || text.includes(SPLIT);
  };
  const errorView = (error: unknown) => {
    const e = error as TaskOperationError;
    return { code: e.code, message: e.message, details: e.details };
  };
  async function splitBallot() {
    const f = await fixture();
    const sealed = await createTaskV2Jury(f.options).sealBallot({
      id: V2_WRITE_ORDER,
      i: 0,
      outcome: 2,
      toWorker: SPLIT,
    });
    f.chain.commitment = sealed.ballot.commitment;
    const reveal = {
      action: "reveal-vote",
      i: 0,
      outcome: 2,
      toWorker: SPLIT,
      salt: SALT,
    } as const satisfies TaskV2Action;
    return { f, reveal, prepared: operation(hostedPlan(reveal)) };
  }

  it("redacts a recovered or abandoned prepared reveal and its echoed fields", async () => {
    const { f, prepared } = await splitBallot();
    f.client.operationV2.mockImplementation((async (_id: string, mode: string) =>
      mode === "abandon"
        ? { orderId: V2_WRITE_ORDER, outcome: "recovered", operation: prepared.operation, ECHO }
        : { ...prepared, recovered: true, scanComplete: true, debug: ECHO }) as never);
    for (const step of ["v2-reveal-vote", "v2-approve"])
      for (const abandon of [false, true]) {
        const result = await recoverTaskV2(f.context, {
          id: V2_WRITE_ORDER,
          operationId: V2_WRITE_OPERATION,
          step,
          abandon,
        });
        expect(result.operation?.plan.data, `${step} ${abandon}`).toBe(
          "[redacted: reveal calldata]",
        );
        expect(leaks(result), `${step} ${abandon}`).toBe(false);
      }
    f.client.operationV2.mockRejectedValue(
      new TasksClientError("http", `no such step for salt ${SALT} / ${SPLIT}`, 409, SALT),
    );
    const error = await recoverTaskV2(f.context, {
      id: V2_WRITE_ORDER,
      operationId: V2_WRITE_OPERATION,
      step: "v2-reveal-vote",
    }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "v2_vote_rejected" });
    expect(leaks(errorView(error))).toBe(false);
  });

  it("never copies a hosted error code or message on a reveal (SDK, executor and vote)", async () => {
    const { f, reveal } = await splitBallot();
    const echo = () =>
      new TasksClientError("http", `invalid reveal ${JSON.stringify(ECHO)}`, 409, SALT.slice(2));
    f.client.prepareV2.mockImplementation(async () => {
      throw echo();
    });
    const direct = createTaskV2Executor(f.options);
    for (const run of [
      () => runTaskV2Vote(f.context, { ...f.base, i: 0, action: "reveal" }),
      () => executeTaskV2(f.context, { ...f.base, write: reveal }),
      () => direct({ ...f.base, write: reveal }),
    ]) {
      const error = await run().catch((caught: unknown) => caught);
      expect(error).toMatchObject({ code: "v2_vote_rejected" });
      expect(leaks(errorView(error))).toBe(false);
    }
    expect(f.rpc.sendRawTransaction).not.toHaveBeenCalled();
  });

  it("drops unknown hosted fields from a successful reveal (SDK, executor and vote)", async () => {
    const { f, reveal } = await splitBallot();
    const prepare = f.client.prepareV2.getMockImplementation()!;
    const operate = f.client.operationV2.getMockImplementation()!;
    f.client.prepareV2.mockImplementation(async (...args: Parameters<typeof prepare>) => ({
      ...(await prepare(...args)),
      debug: ECHO,
    }));
    f.client.operationV2.mockImplementation(async (...args: Parameters<typeof operate>) => ({
      ...(await operate(...args)),
      debug: ECHO,
      request: { write: reveal },
    }));
    const voted = await runTaskV2Vote(f.context, { ...f.base, i: 0, action: "reveal" });
    expect(voted, JSON.stringify(voted)).toMatchObject({
      ok: true,
      operation: { state: "confirmed" },
    });
    expect(leaks(voted)).toBe(false);
    const g = (await splitBallot()).f;
    g.client.prepareV2.mockImplementation(f.client.prepareV2.getMockImplementation()!);
    g.client.operationV2.mockImplementation(async (...args: Parameters<typeof operate>) => ({
      ...(await operate(...args)),
      debug: ECHO,
    }));
    const direct = await createTaskV2Executor(g.options)({ ...g.base, write: reveal });
    expect(direct).toMatchObject({ ok: true });
    expect(leaks(direct)).toBe(false);
  });

  /** A hosted view whose loose lifecycle and next action carry the echoed ballot. */
  function echoLifecycle(f: Awaited<ReturnType<typeof fixture>>) {
    Object.assign(f.order as Record<string, unknown>, {
      lifecycle: {
        shape: "task",
        state: "Active",
        substate: "Disputed",
        debug: ECHO,
        milestones: [
          { id: "m1", status: "disputed", amountBaseUnits: "100000000", debug: ECHO, ECHO },
        ],
      },
      nextAction: { action: "judge", debug: ECHO, request: { salt: SALT } },
    });
  }
  const shownLifecycle = {
    lifecycle: {
      shape: "task",
      state: "Active",
      substate: "Disputed",
      milestones: [{ id: "m1", status: "disputed", amountBaseUnits: "100000000" }],
    },
    nextAction: { action: "judge" },
  };

  it("projects hosted lifecycle and nextAction in reveal results, progress and recovery", async () => {
    const { f, reveal, prepared } = await splitBallot();
    echoLifecycle(f);
    // Success, through the vote verb and the direct executor.
    const voted = await runTaskV2Vote(f.context, { ...f.base, i: 0, action: "reveal" });
    expect(voted).toMatchObject({ ok: true, ...shownLifecycle });
    expect(leaks(voted), JSON.stringify(voted)).toBe(false);
    const g = (await splitBallot()).f;
    echoLifecycle(g);
    const direct = await createTaskV2Executor(g.options)({ ...g.base, write: reveal });
    expect(direct).toMatchObject({ ok: true, ...shownLifecycle });
    expect(leaks(direct), JSON.stringify(direct)).toBe(false);
    // Progress carried by a signing-loop error.
    const h = (await splitBallot()).f;
    echoLifecycle(h);
    h.rpc.getTransactionCount.mockRejectedValueOnce(new Error("rpc down"));
    const error = await createTaskV2Executor(h.options)({ ...h.base, write: reveal }).catch(
      (caught: unknown) => caught,
    );
    expect((error as TaskOperationError).details).toMatchObject(shownLifecycle);
    expect(leaks(errorView(error)), JSON.stringify(errorView(error))).toBe(false);
    // Recovery and abandon, whatever step the caller names.
    f.client.operationV2.mockImplementation((async (_id: string, mode: string) =>
      mode === "abandon"
        ? { orderId: V2_WRITE_ORDER, outcome: "abandoned", operation: null }
        : { ...prepared, recovered: true, scanComplete: true }) as never);
    for (const step of ["v2-reveal-vote", "v2-approve"])
      for (const abandon of [false, true]) {
        const result = await recoverTaskV2(f.context, {
          id: V2_WRITE_ORDER,
          operationId: V2_WRITE_OPERATION,
          step,
          abandon,
        });
        expect(result, `${step} ${abandon}`).toMatchObject(shownLifecycle);
        expect(leaks(result), `${step} ${abandon}`).toBe(false);
      }
  });

  it("projects a lifecycle that sits on the work order and drops malformed fields", async () => {
    const { f, reveal } = await splitBallot();
    Object.assign(f.order as Record<string, unknown>, {
      lifecycle: undefined,
      nextAction: undefined,
    });
    Object.assign(f.order.workOrder as Record<string, unknown>, {
      lifecycle: { shape: "task", state: SALT, milestones: [{ id: "m1", debug: ECHO }] },
      nextAction: { action: "judge", amountBaseUnits: SALT, dueAt: SALT },
    });
    const direct = await createTaskV2Executor(f.options)({ ...f.base, write: reveal });
    expect(direct).toMatchObject({
      ok: true,
      lifecycle: { shape: "task", milestones: [{ id: "m1" }] },
      nextAction: { action: "judge" },
    });
    expect(leaks(direct), JSON.stringify(direct)).toBe(false);
  });

  it("sanitizes an echoed order refresh failure during recovery and abandon", async () => {
    const { f, prepared } = await splitBallot();
    f.client.operationV2.mockImplementation((async (_id: string, mode: string) =>
      mode === "abandon"
        ? { orderId: V2_WRITE_ORDER, outcome: "abandoned", operation: null }
        : { ...prepared, recovered: true, scanComplete: true }) as never);
    for (const failure of [
      () => new TasksClientError("http", `order ${JSON.stringify(ECHO)}`, 409, SALT.slice(2)),
      () => new Error(`fetch failed: response ${JSON.stringify(ECHO)}`),
    ])
      for (const [step, code] of [
        ["v2-reveal-vote", "v2_vote_rejected"],
        ["v2-approve", "v2_recovery_failed"],
      ] as const)
        for (const abandon of [false, true]) {
          f.client.getOrder.mockRejectedValueOnce(failure());
          const error = await recoverTaskV2(f.context, {
            id: V2_WRITE_ORDER,
            operationId: V2_WRITE_OPERATION,
            step,
            abandon,
          }).catch((caught: unknown) => caught);
          expect(error, `${step} ${abandon}`).toMatchObject({ code });
          expect(leaks(errorView(error)), `${step} ${abandon}`).toBe(false);
        }
  });

  it("sanitizes an echoed recovery or abandon failure when a non-secret step is named", async () => {
    const { f } = await splitBallot();
    for (const failure of [
      () => new TasksClientError("http", `no such step for salt ${SALT} / ${SPLIT}`, 409, SALT),
      () => new Error(`socket closed after ${JSON.stringify(ECHO)}`),
    ])
      for (const abandon of [false, true]) {
        f.client.operationV2.mockRejectedValueOnce(failure());
        const error = await recoverTaskV2(f.context, {
          id: V2_WRITE_ORDER,
          operationId: V2_WRITE_OPERATION,
          step: "v2-approve",
          abandon,
        }).catch((caught: unknown) => caught);
        expect(error, String(abandon)).toMatchObject({ code: "v2_recovery_failed" });
        expect((error as Error).message).toContain(
          failure() instanceof TasksClientError ? "HTTP 409" : "recovery",
        );
        expect(leaks(errorView(error)), String(abandon)).toBe(false);
      }
  });
});

describe("V2 jury, bond and owed steps", () => {
  it("repeats open while the case is Snapshotting", async () => {
    const f = await fixture();
    // Matched with a closed evidence window, then two snapshot batches.
    f.chain.caseStates = [2, 6, 6, 3];
    const result = await runTaskV2Jury(f.context, { ...f.base, i: 0, step: "open" });
    expect(result).toMatchObject({ ok: true, rounds: 3, caseState: "JuryDrawPending" });
    expect(f.writes).toEqual(Array(3).fill({ action: "open-jury", i: 0 }));
  });

  it("refuses to open the jury while the evidence window is open", async () => {
    const f = await fixture();
    f.chain.caseStates = [2];
    f.chain.evidenceDeadline = NOW_SECONDS;
    await expect(runTaskV2Jury(f.context, { ...f.base, i: 0, step: "open" })).rejects.toMatchObject(
      { code: "evidence_window_open" },
    );
    expect(f.client.prepareV2).not.toHaveBeenCalled();
  });

  it("runs draw without moving USDC", async () => {
    const f = await fixture();
    const result = await runTaskV2Jury(f.context, { ...f.base, i: 0, step: "draw" });
    expect(result).toMatchObject({ ok: true, rounds: 1, money: { gross: { baseUnits: "0" } } });
    expect(f.writes).toEqual([{ action: "draw-jury", i: 0 }]);
  });

  it("reserves the agreed bond before approving the verified clone", async () => {
    const f = await fixture({ worker: zeroAddress, workerBondBp: 1000 });
    const execute = createTaskV2Executor(f.options);
    const result = await execute({ ...f.base, write: { action: "approve-bond" } });
    expect(result).toMatchObject({ ok: true, money: { gross: { baseUnits: "10000000" } } });
    const ledger = await readSpendLedger(
      f.base.ledgerPath,
      new Date("2026-10-26T12:00:00Z"),
      "juror" as WalletName,
    );
    expect(JSON.stringify(ledger)).toContain("10000000");
  });

  it.each([
    ["a hosted bond rate the frozen terms hash does not carry", "hosted"],
    ["a clone whose terms().workerBondBp differs from the accepted terms", "clone"],
  ] as const)("refuses an approve-bond for %s", async (_name, attack) => {
    const f = await fixture({ worker: zeroAddress, workerBondBp: 1000 });
    if (attack === "hosted") {
      // The clone and its frozen terms hash agree on 10%; the hosted view claims 20%.
      f.chain.termsHash = acceptedV2TermsHash(
        f.order as unknown as import("./types.js").GetOrderResponse,
        PIN,
        604800n,
      );
      (f.order.workOrder.terms as { workerBondBp?: number }).workerBondBp = 2000;
    } else f.chain.workerBondBp = 500;
    const bond = attack === "hosted" ? 20_000_000n : 5_000_000n;
    f.client.prepareV2.mockImplementation(async (_id: string, write: TaskV2Action) => {
      f.writes.push(write);
      return operation({
        step: "v2-approve-usdc",
        to: USDC,
        data: encodeFunctionData({
          abi: approvalAbi,
          functionName: "approve",
          args: [ESCROW, bond],
        }),
      });
    });
    const sign = vi.spyOn(account, "signTransaction");
    const execute = createTaskV2Executor(f.options);
    await expect(execute({ ...f.base, write: { action: "approve-bond" } })).rejects.toMatchObject({
      code: "v2_plan_mismatch",
    });
    expect(sign).not.toHaveBeenCalled();
    expect(f.rpc.sendRawTransaction).not.toHaveBeenCalled();
    await expect(readFile(f.base.ledgerPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("claims owed credit to the caller by default", async () => {
    const f = await fixture();
    const execute = createTaskV2Executor(f.options);
    const result = await execute({ ...f.base, write: { action: "claim-owed" } });
    expect(result).toMatchObject({ ok: true, money: { gross: { baseUnits: "5000000" } } });
    f.chain.owed = 0n;
    await expect(
      execute({ ...f.base, write: { action: "claim-owed", to: OTHER } }),
    ).rejects.toMatchObject({
      code: "nothing_owed",
    });
  });
});

describe("reviewer status from local RPC reads", () => {
  it("reads the seat, vAPI ID, stake against the gate threshold and resolver flags", async () => {
    const STAKING = getAddress(`0x${"5e".repeat(20)}`);
    const reads: string[] = [];
    const rpc = {
      getChainId: vi.fn(async () => 84532),
      readContract: vi.fn(async (call: { functionName: string; address: string }) => {
        reads.push(`${call.address}:${call.functionName}`);
        return (
          {
            implementation: IMPLEMENTATION,
            DISPUTE_RESOLVER: RESOLVER,
            registry: OTHER,
            vapiId: POSTER,
            stakeGate: ESCROW,
            staking: STAKING,
            isReviewer: true,
            hasId: true,
            stakedBalance: 900n,
            threshold: 1000n,
            isEligible: false,
            available: true,
            suspended: false,
            claimable: 7n,
            missedReveals: 1,
          } as Record<string, unknown>
        )[call.functionName];
      }),
    };
    const status = await readTaskV2ReviewerStatus({
      chainId: 84532,
      wallet: account.address,
      rpcFor: () => rpc as unknown as PublicClient,
      trustedV2Deployments: { 84532: PIN },
      onV2UntrustedOverride: () => {},
    });
    expect(status).toMatchObject({
      resolver: RESOLVER,
      isReviewer: true,
      hasId: true,
      staked: "900",
      threshold: "1000",
      meetsStake: false,
      available: true,
      suspended: false,
      claimable: "7",
      missedReveals: 1,
      ready: false,
    });
    expect(reads.slice(0, 2)).toEqual([
      `${FACTORY}:implementation`,
      `${IMPLEMENTATION}:DISPUTE_RESOLVER`,
    ]);
    expect(reads).toContain(`${STAKING}:stakedBalance`);
  });

  it("requires a local resolver pin to agree with the factory implementation's resolver", async () => {
    const chainResolver = { value: RESOLVER as string };
    const rpc = {
      getChainId: vi.fn(async () => 84532),
      readContract: vi.fn(async (call: { functionName: string }) => {
        if (call.functionName === "implementation") return IMPLEMENTATION;
        if (call.functionName === "DISPUTE_RESOLVER") return chainResolver.value;
        return ["isReviewer", "hasId", "isEligible", "available", "suspended"].includes(
          call.functionName,
        )
          ? false
          : ["stakedBalance", "threshold", "claimable"].includes(call.functionName)
            ? 0n
            : call.functionName === "missedReveals"
              ? 0
              : OTHER;
      }),
    };
    const read = (pin: Record<string, unknown>) =>
      readTaskV2ReviewerStatus({
        chainId: 84532,
        wallet: account.address,
        rpcFor: () => rpc as unknown as PublicClient,
        env: {},
        trustedV2Deployments: { 84532: { ...PIN, ...pin } },
        onV2UntrustedOverride: () => {},
      });
    expect((await read({ disputeResolverV3: RESOLVER })).resolver).toBe(RESOLVER);
    chainResolver.value = OTHER;
    await expect(read({ disputeResolverV3: RESOLVER })).rejects.toMatchObject({
      code: "v2_plan_mismatch",
    });
    rpc.readContract.mockRejectedValue(new Error("no implementation"));
    await expect(read({})).rejects.toMatchObject({ code: "v2_resolver_unavailable" });
  });
});

describe("ballot path helper", () => {
  it("keys ballots by chain, resolver, case and commitment", () => {
    expect(
      taskV2BallotPath("/h", {
        chainId: 1,
        resolver: RESOLVER,
        caseId: CASE_ID,
        commitment: CASE_ID,
      }),
    ).toBe(join("/h", "tasks", "ballots", "1", RESOLVER.toLowerCase(), CASE_ID, `${CASE_ID}.json`));
  });
});
