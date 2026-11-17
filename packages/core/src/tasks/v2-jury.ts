// SPDX-License-Identifier: Apache-2.0
// Jury, vote and reviewer steps for Tasks V2 (DisputeResolverV3). Plans come from
// the hosted writes route; this module only reads the chain, seals ballots and
// hands the raw write to executeTaskV2. Rules: with 20 or fewer eligible reviewers
// everyone eligible votes; above 20, 5 are drawn. A verdict needs at least 3 reveals
// and a strict majority. A tie or no majority restores the pre-dispute state and a
// new dispute round may be raised. There is no mediation or appeal.
import { randomBytes as nodeRandomBytes } from "node:crypto";

import {
  encodeAbiParameters,
  getAddress,
  keccak256,
  parseAbi,
  parseAbiParameters,
  toHex,
  zeroAddress,
  zeroHash,
  type Address,
  type Hex,
} from "viem";
import { z } from "zod";

import {
  listTaskV2Ballots,
  readTaskV2Ballot,
  TASK_V2_VOTE_OUTCOMES,
  taskV2BallotPath,
  writeTaskV2Ballot,
  type TaskV2Ballot,
} from "./ballots.js";
import type { TasksChainOptions } from "./chain.js";
import {
  TaskInputError,
  TaskOperationError,
  type TaskOperationContext,
} from "./operation-support.js";
import {
  disputeResolverV3Abi,
  escrowFactoryV2Abi,
  escrowV2Abi,
  TASK_V2_CASE_STATE,
} from "./v2-abi.js";
import { executeTaskV2, type TaskV2ExecutionInput } from "./v2-execution.js";
import { v2Read, verifiedV2Case, verifiedV2Resolver, verifyV2Target } from "./v2-plan-guard.js";
import { getTrustedTasksV2Deployment, type TasksV2DeploymentOverrides } from "./v2-trust.js";
import { taskV2IndexSchema, type TaskV2Action } from "./v2-write.js";
import { TasksClientError } from "./client.js";
import {
  publicTaskLifecycle,
  publicTaskNextAction,
  publicTaskV2OperationOf,
  taskV2VoteHostedError,
} from "./v2-public.js";
import type { PublicClient } from "viem";

/** DisputeResolverV3 case states (vapi-app tasks-v2.ts CaseState). Snapshotting was appended. */
export const TASK_V2_CASE_STATES = [
  "None",
  "Raised",
  "Matched",
  "JuryDrawPending",
  "Voting",
  "Resolved",
  "Snapshotting",
] as const;
const SNAPSHOTTING = 6;

export const TASK_V2_JURY_STEPS = {
  open: "open-jury",
  draw: "draw-jury",
  rearm: "rearm-draw",
  resolve: "resolve",
} as const;
export type TaskV2JuryStep = keyof typeof TASK_V2_JURY_STEPS;

// External reviewer-seat contracts, mirrored from vapi-app tasks-v1 2621284b3
// apps/api/app/tasks/server/chain/v2-writes.server.ts reviewerStatus().
const registryAbi = parseAbi(["function isReviewer(address) view returns (bool)"]);
const vapiIdAbi = parseAbi(["function hasId(address wallet) view returns (bool)"]);
const gateAbi = parseAbi([
  "function staking() view returns (address)",
  "function threshold() view returns (uint256)",
  "function isEligible(address) view returns (bool)",
]);
const stakingAbi = parseAbi(["function stakedBalance(address) view returns (uint256)"]);
// DisputeResolverV3's public `disputeRound` mapping getter; not in the synced ABI.
const disputeRoundAbi = parseAbi([
  "function disputeRound(address escrow, uint8 milestone) view returns (uint32)",
]);
const caseIdParameters = parseAbiParameters("address, uint8, uint32");
const commitmentParameters = parseAbiParameters(
  "address, uint8, uint32, address, uint8, uint96, bytes32",
);

/** DisputeResolverV3 `_caseId`: keccak256(abi.encode(escrow, i, round)). */
export function taskV2CaseId(escrow: Address, i: number, round: number): Hex {
  return keccak256(encodeAbiParameters(caseIdParameters, [escrow, i, round]));
}

/**
 * DisputeResolverV3 `_commitment`: keccak256(abi.encode(escrow, i, round, reviewer, outcome,
 * toWorker, salt)), the same value its voteCommitment view returns for the current round.
 * Computed on this machine so the vote and its salt never reach the RPC before the reveal.
 */
export function taskV2VoteCommitment(input: {
  escrow: Address;
  i: number;
  round: number;
  reviewer: Address;
  outcome: number;
  toWorker: bigint;
  salt: Hex;
}): Hex {
  return keccak256(
    encodeAbiParameters(commitmentParameters, [
      input.escrow,
      input.i,
      input.round,
      input.reviewer,
      input.outcome,
      input.toWorker,
      input.salt,
    ]),
  );
}

const address = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/u)
  .transform((v) => getAddress(v));
const hash = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/u)
  .transform((v) => v.toLowerCase() as Hex);

/** Chain-side jury helpers bound to one unlocked wallet. Exposed as TasksChain.juryV2. */
export function createTaskV2Jury(options: TasksChainOptions) {
  const { client, account } = options;
  const randomBytes = options.randomBytes ?? ((size: number) => nodeRandomBytes(size));
  const now = options.now ?? (() => new Date());
  const home = () => {
    if (!options.ballotsHome)
      throw new TaskOperationError(
        "ballot_store_unavailable",
        "The local ballot store is unavailable.",
      );
    return options.ballotsHome;
  };

  /**
   * The verified clone, its resolver (from the clone's DISPUTE_RESOLVER()), the current dispute
   * round and its case id. The round is a public value read over RPC; the case id must be the
   * one the round derives, so a commitment is never sealed for another round.
   */
  async function voteCase(id: string, i: number) {
    taskV2IndexSchema.parse(i);
    const deployment = await client.deployment();
    if (!deployment.configured)
      throw new TaskOperationError("v2_resolver_unavailable", "Hosted Tasks V2 is not configured.");
    const view = await client.getOrder(id);
    if (view.workOrder.id !== id)
      throw new TaskOperationError("invalid_response", "The order view belongs to another task.");
    const target = await verifyV2Target(options, { chainId: deployment.chainId }, view, {
      action: "open-jury",
      i,
    });
    const resolver = await verifiedV2Resolver(target);
    const at = [target.escrow, i] as const;
    const caseId = hash.parse(
      await v2Read(target.rpc, resolver, disputeResolverV3Abi, "currentCaseId", at),
    );
    const round = z
      .number()
      .int()
      .min(0)
      .max(2 ** 32 - 1)
      .parse(await v2Read(target.rpc, resolver, disputeRoundAbi, "disputeRound", at));
    if (taskV2CaseId(target.escrow, i, round) !== caseId)
      throw new TaskOperationError(
        "invalid_response",
        "The resolver's current case does not match its dispute round; retry the same vote.",
      );
    return { target, resolver, caseId, round, at };
  }
  async function onchainCommitment(
    rpc: PublicClient,
    resolver: Address,
    caseId: Hex,
  ): Promise<Hex> {
    return hash.parse(
      await v2Read(rpc, resolver, disputeResolverV3Abi, "commitments", [caseId, account.address]),
    );
  }
  /** The ballot's commitment for this wallet in `round`, computed locally (no RPC call). */
  function commitmentOf(
    round: number,
    ballot: Pick<TaskV2Ballot, "escrow" | "i" | "outcome" | "toWorker" | "salt">,
  ): Hex {
    return taskV2VoteCommitment({
      escrow: getAddress(ballot.escrow),
      i: ballot.i,
      round,
      reviewer: account.address,
      outcome: ballot.outcome,
      toWorker: BigInt(ballot.toWorker),
      salt: ballot.salt,
    });
  }

  return {
    /** Current DisputeResolverV3 case state for one milestone. */
    async caseState(input: { id: string; i: number }) {
      const { target } = await voteCase(input.id, input.i);
      const { resolver, data } = await verifiedV2Case(target, input.i);
      const state = z.number().int().min(0).max(6).parse(data.state);
      return { state, name: TASK_V2_CASE_STATES[state]!, resolver };
    },
    /**
     * The jury may open only once the evidence window has closed (DisputeResolverV3 F2: openJury
     * after evidenceDeadline). Checked against the resolver's caseData and the chain clock, so an
     * early open is refused locally. A Snapshotting case continues without the check.
     */
    async assertJuryOpenable(input: { id: string; i: number }) {
      const { target } = await voteCase(input.id, input.i);
      const { data } = await verifiedV2Case(target, input.i);
      if (data.state !== TASK_V2_CASE_STATE.Matched) return;
      const now = (await target.rpc.getBlock()).timestamp;
      if (now <= data.evidenceDeadline)
        throw new TaskOperationError(
          "evidence_window_open",
          `The evidence window is open until ${new Date(Number(data.evidenceDeadline) * 1000).toISOString()}; open the jury after it closes.`,
        );
    },
    /**
     * Generate a 32-byte salt locally, compute the commitment locally and write the
     * ballot (0600, fsync) before any commit plan is requested. A retry with the same
     * vote reuses its sealed ballot so the hosted preparation resumes.
     */
    async sealBallot(input: { id: string; i: number; outcome: 0 | 1 | 2; toWorker: string }) {
      const { target, resolver, caseId, round } = await voteCase(input.id, input.i);
      const milestone = target.milestones[input.i];
      if (!milestone)
        throw new TaskInputError("The milestone index is outside the verified escrow.");
      if (
        (input.outcome !== 2 && input.toWorker !== "0") ||
        (input.outcome === 2 && BigInt(input.toWorker) > milestone.amount)
      )
        throw new TaskInputError(
          "A split names toWorker up to the milestone amount; other outcomes use 0.",
        );
      const key = { chainId: target.chainId, resolver, caseId };
      const onchain = await onchainCommitment(target.rpc, resolver, caseId);
      const sealed = (await listTaskV2Ballots(home(), key)).filter(
        (b) =>
          b.voter === account.address.toLowerCase() &&
          b.orderId === input.id &&
          b.i === input.i &&
          b.outcome === input.outcome &&
          b.toWorker === input.toWorker,
      );
      if (onchain !== zeroHash) {
        const committed = sealed.find((b) => b.commitment === onchain);
        if (!committed)
          throw new TaskOperationError(
            "already_committed",
            "This wallet already committed a different vote in this round. Reveal it with vapi task vote --reveal.",
          );
        return { ballot: committed, reused: true, path: taskV2BallotPath(home(), committed) };
      }
      const previous = sealed.at(-1);
      if (previous && commitmentOf(round, previous) === previous.commitment)
        return { ballot: previous, reused: true, path: taskV2BallotPath(home(), previous) };
      const salt = toHex(randomBytes(32));
      const draft = {
        escrow: target.escrow.toLowerCase() as Hex,
        i: input.i,
        outcome: input.outcome,
        toWorker: input.toWorker,
        salt,
      };
      const commitment = commitmentOf(round, draft);
      const ballot: TaskV2Ballot = {
        version: "vapi-tasks-ballot-v1",
        orderId: input.id,
        chainId: target.chainId,
        resolver: resolver.toLowerCase() as Hex,
        caseId,
        voter: account.address.toLowerCase() as Hex,
        commitment,
        createdAt: now().toISOString(),
        ...draft,
      };
      const path = await writeTaskV2Ballot(home(), ballot);
      return { ballot, reused: false, path };
    },
    /**
     * The sealed ballot's case must still be the resolver's current case: a commitment binds its
     * round, so one signed after the dispute moved on would be accepted but could never reveal.
     */
    async assertSealedCase(input: { id: string; i: number; caseId: Hex }) {
      const { caseId } = await voteCase(input.id, input.i);
      if (caseId !== input.caseId.toLowerCase())
        throw new TaskOperationError(
          "v2_round_changed",
          "The dispute moved to a new round after this vote was sealed; nothing was signed. Run vote --commit again to vote in the new round.",
        );
    },
    /** The ballot whose commitment is onchain for this wallet in the current round. */
    async openBallot(input: { id: string; i: number }) {
      const { target, resolver, caseId, round } = await voteCase(input.id, input.i);
      // Never hand the salt to the hosted API outside the reveal window: others could still
      // commit after seeing it. Resolver state and the chain clock decide, as revealVote does.
      const { data } = await verifiedV2Case(target, input.i);
      const now = (await target.rpc.getBlock()).timestamp;
      if (data.state !== TASK_V2_CASE_STATE.Voting)
        throw new TaskOperationError(
          "reveal_unavailable",
          "The dispute is not in its voting stage; nothing was revealed.",
        );
      if (now <= data.commitDeadline)
        throw new TaskOperationError(
          "reveal_not_open",
          `The commit window is open until ${new Date(Number(data.commitDeadline) * 1000).toISOString()}; reveal after it closes. Nothing was revealed.`,
        );
      if (now > data.revealDeadline)
        throw new TaskOperationError(
          "reveal_window_closed",
          "The reveal window has closed; nothing was revealed.",
        );
      const onchain = await onchainCommitment(target.rpc, resolver, caseId);
      if (onchain === zeroHash)
        throw new TaskOperationError(
          "no_commitment",
          "This wallet has no committed vote in the current dispute round.",
        );
      const ballot = await readTaskV2Ballot(home(), {
        chainId: target.chainId,
        resolver,
        caseId,
        commitment: onchain,
        voter: account.address,
      });
      if (!ballot || ballot.orderId !== input.id || ballot.i !== input.i)
        throw new TaskOperationError(
          "ballot_unavailable",
          "No local ballot matches the onchain commitment. Reveal from the machine that committed.",
        );
      if (commitmentOf(round, ballot) !== onchain)
        throw new TaskOperationError(
          "invalid_commitment",
          "The stored ballot no longer matches its onchain commitment.",
        );
      return { ballot, path: taskV2BallotPath(home(), ballot) };
    },
  };
}
export type TaskV2Jury = ReturnType<typeof createTaskV2Jury>;

type RunBase = Omit<
  TaskV2ExecutionInput,
  "write" | "consent" | "prepared" | "preparationKey" | "beforeSigning"
>;
function jury(context: TaskOperationContext): TaskV2Jury {
  if (!context.chain.juryV2)
    throw new TaskOperationError("chain_unavailable", "Local jury signing is unavailable.");
  return context.chain.juryV2;
}

/** Run one jury step. `open` repeats while the case is Snapshotting (continueJury batches). */
export async function runTaskV2Jury(
  context: TaskOperationContext,
  input: RunBase & { i: number; step: TaskV2JuryStep; maxRounds?: number },
) {
  const action = TASK_V2_JURY_STEPS[input.step];
  if (!action) throw new TaskInputError("The jury step must be open, draw, rearm or resolve.");
  const { step, maxRounds, i, ...base } = input;
  const write = { action, i } as TaskV2Action;
  if (step === "open") await jury(context).assertJuryOpenable({ id: input.id, i });
  let rounds = 0;
  for (;;) {
    rounds += 1;
    const result = await executeTaskV2(context, { ...base, write });
    if (!result.ok || step !== "open") return { ...result, rounds };
    const caseState = await jury(context).caseState({ id: input.id, i });
    if (caseState.state !== SNAPSHOTTING || rounds >= (maxRounds ?? 32))
      return { ...result, rounds, caseState: caseState.name };
  }
}

export const taskV2VoteInputSchema = z
  .strictObject({
    i: taskV2IndexSchema,
    action: z.enum(["commit", "reveal"]),
    outcome: z.enum(TASK_V2_VOTE_OUTCOMES).optional(),
    toWorker: z
      .string()
      .regex(/^(0|[1-9][0-9]*)$/u)
      .refine((v) => BigInt(v) < 2n ** 96n)
      .optional(),
  })
  .superRefine((value, context) => {
    const issue = (message: string) => context.addIssue({ code: "custom", message });
    if (value.action === "reveal" && (value.outcome || value.toWorker !== undefined))
      issue("Reveal reads the sealed local ballot; it takes no outcome or toWorker.");
    if (value.action === "commit" && !value.outcome) issue("Commit needs an outcome.");
    if (value.outcome === "split" && (value.toWorker === undefined || value.toWorker === "0"))
      issue("A split vote needs toWorker in USDC base units.");
    if (value.outcome && value.outcome !== "split" && (value.toWorker ?? "0") !== "0")
      issue("Only a split vote names toWorker.");
  });
export type TaskV2VoteInput = z.input<typeof taskV2VoteInputSchema>;

/** Error codes this SDK raises itself on vote paths; any other code is replaced. */
const LOCAL_VOTE_ERROR_CODES = new Set([
  "already_committed",
  "ballot_store_unavailable",
  "ballot_unavailable",
  "chain_error",
  "chain_unavailable",
  "invalid_commitment",
  "invalid_input",
  "invalid_response",
  "no_commitment",
  "operation_pending",
  "reveal_not_open",
  "reveal_unavailable",
  "reveal_window_closed",
  "transaction_reverted",
  "v2_round_changed",
  "v2_plan_mismatch",
  "v2_resolver_unavailable",
  "v2_trust_unavailable",
  "v2_vote_rejected",
  "vote_failed",
]);
const VOTE_FAILED =
  "The vote step failed. The sealed ballot stays on this machine; retry the same command.";

/** Only the documented operation fields leave a vote step; the reveal calldata is redacted. */
function publicVoteDetails(details: Record<string, unknown> | undefined, secret: boolean) {
  if (!details) return undefined;
  const operation = publicTaskV2OperationOf(details.operation, secret);
  return {
    ...(typeof details.orderId === "string" ? { orderId: details.orderId } : {}),
    ...(operation ? { operation } : {}),
    ...(typeof details.operationId === "string" ? { operationId: details.operationId } : {}),
    ...(typeof details.operationState === "string"
      ? { operationState: details.operationState }
      : {}),
  };
}

/**
 * A failed vote step never echoes the ballot. A hosted error is replaced by a fixed code and
 * message (it may echo the request); an SDK error keeps its own code, with the salt and a split
 * amount scrubbed from its message and only public operation fields in its details; anything
 * else (an RPC client error quotes its call arguments) becomes vote_failed.
 */
function sealedVoteError(
  error: unknown,
  ballot?: Pick<TaskV2Ballot, "salt" | "toWorker">,
  secret = false,
): never {
  if (error instanceof TaskInputError) throw error;
  if (error instanceof TasksClientError) throw taskV2VoteHostedError(error);
  if (!(error instanceof TaskOperationError) || !LOCAL_VOTE_ERROR_CODES.has(error.code))
    throw new TaskOperationError("vote_failed", VOTE_FAILED);
  const secrets = ballot
    ? [ballot.salt.slice(2), ...(ballot.toWorker === "0" ? [] : [ballot.toWorker])]
    : [];
  const scrub = (text: string) =>
    secrets.reduce((value, item) => value.split(item).join("[redacted]"), text);
  if (secrets.some((item) => error.message.toLowerCase().includes(item.toLowerCase())))
    throw new TaskOperationError(
      error.code,
      VOTE_FAILED,
      undefined,
      publicVoteDetails(error.details, secret),
    );
  throw new TaskOperationError(
    error.code,
    scrub(error.message),
    undefined,
    publicVoteDetails(error.details, secret),
  );
}

/** The public result fields of a vote step; unknown hosted fields are never spread. */
function publicVoteResult(
  value: Awaited<ReturnType<typeof executeTaskV2>>,
  ballot: { commitment: Hex; caseId: Hex; path: string },
  secret: boolean,
) {
  const result = value as Record<string, unknown>;
  const operation = publicTaskV2OperationOf(result.operation, secret);
  return {
    ok: result.ok === true,
    ...(typeof result.reason === "string" ? { reason: result.reason } : {}),
    ...(result.approval === true ? { approval: true as const } : {}),
    ...(result.declined === true ? { declined: true as const } : {}),
    ...("money" in value ? { money: value.money } : {}),
    ...(typeof result.orderId === "string" ? { orderId: result.orderId } : {}),
    ...(operation ? { operation } : {}),
    ...(typeof result.operationId === "string" ? { operationId: result.operationId } : {}),
    ...(typeof result.operationState === "string" ? { operationState: result.operationState } : {}),
    lifecycle: publicTaskLifecycle(result.lifecycle),
    nextAction: publicTaskNextAction(result.nextAction),
    ballot,
  };
}

/**
 * Commit seals the ballot locally first; reveal reads it back by the onchain commitment.
 * Results carry the commitment, case and ballot path, never the vote or its salt.
 */
export async function runTaskV2Vote(
  context: TaskOperationContext,
  input: RunBase & TaskV2VoteInput,
) {
  const { i, action, outcome, toWorker, ...base } = input;
  const parsed = taskV2VoteInputSchema.safeParse({
    i,
    action,
    ...(outcome === undefined ? {} : { outcome }),
    ...(toWorker === undefined ? {} : { toWorker }),
  });
  if (!parsed.success) throw new TaskInputError(parsed.error.issues[0]!.message);
  const vote = parsed.data;
  if (vote.action === "commit") {
    const sealed = await jury(context)
      .sealBallot({
        id: input.id,
        i: vote.i,
        outcome: TASK_V2_VOTE_OUTCOMES.indexOf(vote.outcome!) as 0 | 1 | 2,
        toWorker: vote.toWorker ?? "0",
      })
      .catch((error: unknown) => sealedVoteError(error));
    const result = await executeTaskV2(context, {
      ...base,
      write: { action: "commit-vote", i: vote.i, commitment: sealed.ballot.commitment },
      beforeSigning: () =>
        jury(context).assertSealedCase({ id: input.id, i: vote.i, caseId: sealed.ballot.caseId }),
    }).catch((error: unknown) => sealedVoteError(error, sealed.ballot));
    return publicVoteResult(
      result,
      { commitment: sealed.ballot.commitment, caseId: sealed.ballot.caseId, path: sealed.path },
      false,
    );
  }
  const opened = await jury(context)
    .openBallot({ id: input.id, i: vote.i })
    .catch((error: unknown) => sealedVoteError(error));
  const result = await executeTaskV2(context, {
    ...base,
    write: {
      action: "reveal-vote",
      i: vote.i,
      outcome: opened.ballot.outcome,
      toWorker: opened.ballot.toWorker,
      salt: opened.ballot.salt,
    },
  }).catch((error: unknown) => sealedVoteError(error, opened.ballot, true));
  return publicVoteResult(
    result,
    { commitment: opened.ballot.commitment, caseId: opened.ballot.caseId, path: opened.path },
    true,
  );
}

/**
 * Reviewer readiness from local RPC reads only; there is no hosted order-less route yet.
 * The resolver is the pinned factory's task implementation's immutable DISPUTE_RESOLVER()
 * (EscrowFactoryV2 has no resolver getter); an optional local resolver pin must agree with it.
 */
export async function readTaskV2ReviewerStatus(input: {
  chainId: number;
  wallet: string;
  rpcFor: (chainId: number) => PublicClient;
  trustedV2Deployments?: TasksV2DeploymentOverrides;
  env?: NodeJS.ProcessEnv;
  onV2UntrustedOverride?: (message: string) => void;
}) {
  const wallet = address.parse(input.wallet);
  const pin = getTrustedTasksV2Deployment(input.chainId, {
    ...(input.trustedV2Deployments ? { overrides: input.trustedV2Deployments } : {}),
    ...(input.env ? { env: input.env } : {}),
    ...(input.onV2UntrustedOverride ? { notice: input.onV2UntrustedOverride } : {}),
  });
  const rpc = input.rpcFor(input.chainId);
  if ((await rpc.getChainId()) !== input.chainId)
    throw new TaskOperationError(
      "v2_plan_mismatch",
      "The RPC chain differs from the pinned V2 chain.",
    );
  let resolver: Address;
  try {
    const implementation = address.parse(
      await v2Read(rpc, pin.escrowFactoryV2, escrowFactoryV2Abi, "implementation"),
    );
    resolver = address.parse(await v2Read(rpc, implementation, escrowV2Abi, "DISPUTE_RESOLVER"));
  } catch {
    throw new TaskOperationError(
      "v2_resolver_unavailable",
      `The pinned escrow factory's implementation().DISPUTE_RESOLVER() could not be read on chain ${input.chainId}.`,
    );
  }
  if (resolver === zeroAddress || (pin.disputeResolverV3 && resolver !== pin.disputeResolverV3))
    throw new TaskOperationError(
      "v2_plan_mismatch",
      "The pinned factory's dispute resolver differs from the local resolver pin.",
    );
  const read = (
    contract: Address,
    abi: Parameters<typeof v2Read>[2],
    name: string,
    args: readonly unknown[] = [],
  ) => v2Read(rpc, contract, abi, name, args);
  const registry = address.parse(await read(resolver, disputeResolverV3Abi, "registry"));
  const vapiId = address.parse(await read(resolver, disputeResolverV3Abi, "vapiId"));
  const stakeGate = address.parse(await read(resolver, disputeResolverV3Abi, "stakeGate"));
  const staking = address.parse(await read(stakeGate, gateAbi, "staking"));
  const flag = (value: unknown) => z.boolean().parse(value);
  const uint = (value: unknown) => z.bigint().nonnegative().parse(value);
  const status = {
    chainId: input.chainId,
    wallet,
    resolver,
    registry,
    vapiId,
    stakeGate,
    staking,
    isReviewer: flag(await read(registry, registryAbi, "isReviewer", [wallet])),
    hasId: flag(await read(vapiId, vapiIdAbi, "hasId", [wallet])),
    staked: uint(await read(staking, stakingAbi, "stakedBalance", [wallet])).toString(),
    threshold: uint(await read(stakeGate, gateAbi, "threshold")).toString(),
    eligible: flag(await read(stakeGate, gateAbi, "isEligible", [wallet])),
    available: flag(await read(resolver, disputeResolverV3Abi, "available", [wallet])),
    suspended: flag(await read(resolver, disputeResolverV3Abi, "suspended", [wallet])),
    claimable: uint(await read(resolver, disputeResolverV3Abi, "claimable", [wallet])).toString(),
    missedReveals: Number(await read(resolver, disputeResolverV3Abi, "missedReveals", [wallet])),
  };
  const meetsStake = BigInt(status.staked) >= BigInt(status.threshold);
  return {
    ...status,
    meetsStake,
    // A seat, a vAPI ID, the stake gate and availability decide whether this wallet can be drawn.
    ready:
      status.isReviewer &&
      status.hasId &&
      status.eligible &&
      meetsStake &&
      status.available &&
      !status.suspended,
  };
}
