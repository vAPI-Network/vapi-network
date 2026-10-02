import {
  allocateFromTreasury,
  createRunBudget,
  createRunId,
  getVapiPaths,
  isRunId,
  readDelegationRecord,
  readAgentProfile,
  readSpendLedger,
  readSwarm,
  spendCapsForWallet,
  validateRecoveryPhrase,
  writeDelegationRecord,
  type AgentProfile,
  type DelegationRecord,
  type RunBudget,
  type SwarmCapitalDeps,
  type SwarmFile,
  type SwarmStatusResult,
  type WalletStore,
} from "@vapi-network/core";

import { registeredAgentProfileSchema } from "../actions/register.js";
import type { SwarmAllocateResult, SwarmDelegateResult } from "../actions/swarm-agent.js";
import { runAgent, type RunAgentDeps, type RunAgentResult, type SwarmRunContext } from "./run.js";

const ATOMIC_PER_CENT = 10_000n;
const DEFAULT_DRAW_USD = "2.00";
const DEFAULT_CONCURRENCY = 4;
const MAX_ERROR_DETAIL = 300;

export type SwarmRunMode = "lead" | "each";

export type RunSwarmOptions = {
  name: string;
  task: string;
  mode: SwarmRunMode;
  lead?: string;
  budgetUsd?: string;
  drawUsd?: string;
  concurrency?: number;
  runId?: string;
};

export type SwarmRunInput = Omit<RunSwarmOptions, "mode" | "concurrency" | "runId"> & {
  mode?: SwarmRunMode;
};

export type SwarmMemberTarget = {
  account: string;
  role: string;
  profile: AgentProfile;
};

export type MemberRunOptions = {
  runId: string;
  budget: RunBudget;
  runMeta: { swarm: string; member: string; parentRunId?: string };
  profile: AgentProfile;
  approvals: "tty" | "decline";
};

export type RunSwarmDeps = {
  home: string;
  store: WalletStore;
  capital: SwarmCapitalDeps;
  depsForMember(member: SwarmMemberTarget, runOpts: MemberRunOptions): Promise<RunAgentDeps>;
  status(name: string): Promise<SwarmStatusResult>;
  readProfile?: (account: string) => Promise<AgentProfile | undefined>;
  runAgent?: typeof runAgent;
  newRunId?: () => string;
  ledgerPath?: string;
  now?: () => Date;
};

export type SwarmRunMemberResult = {
  member: string;
  role: string;
  runId: string | null;
  parentRunId?: string;
  answer: string | null;
  stoppedBecause: { reason: string; detail?: string } | null;
  spentUsd: number | null;
  budgetUsd: number;
  status: "finished" | "stopped" | "error" | "skipped";
  reason?: string;
};

export type SwarmRunResult = {
  runId: string;
  mode: SwarmRunMode;
  members: SwarmRunMemberResult[];
  drawUsedUsd: number;
  drawLimitUsd: number;
  net: Array<{
    member: string;
    balanceUsd: string;
    allocatedInUsd: string;
    sweptOutUsd: string;
    netUsd: string;
  }>;
  netError?: string;
};

export class SwarmRunError extends Error {
  readonly name = "SwarmRunError";

  constructor(
    readonly code: "no_lead" | "invalid_lead" | "invalid_amount" | "no_eligible_members",
    message: string,
  ) {
    super(message);
  }
}

export type MemberAssessment =
  | { account: string; role: string; eligible: true; target: SwarmMemberTarget }
  | {
      account: string;
      role: string;
      eligible: false;
      reason: "not_linked" | "no_profile" | "paused";
    };

export async function runSwarm(opts: RunSwarmOptions, deps: RunSwarmDeps): Promise<SwarmRunResult> {
  if (opts.runId !== undefined && !isRunId(opts.runId)) {
    throw new Error(`Invalid swarm run id: ${opts.runId}.`);
  }
  const budgetAtomic = opts.budgetUsd === undefined ? undefined : amountAtomic(opts.budgetUsd);
  const drawLimitAtomic = amountAtomic(opts.drawUsd ?? DEFAULT_DRAW_USD);
  const swarm = await readSwarm(deps.home, opts.name);
  const assessments = await assessSwarmMembers(swarm, deps);
  const runId = opts.runId ?? (deps.newRunId ?? createRunId)();
  const draw = createRunBudget({ id: `${runId}-draw`, limitAtomic: drawLimitAtomic });
  const skipped = assessments.filter((assessment) => !assessment.eligible).map(skippedResult);
  const eligible = assessments.filter(
    (assessment): assessment is Extract<MemberAssessment, { eligible: true }> =>
      assessment.eligible,
  );
  const run = deps.runAgent ?? runAgent;
  let members: SwarmRunMemberResult[];

  if (opts.mode === "lead") {
    const selected = selectLead(opts, assessments);
    const childResults: SwarmRunMemberResult[] = [];
    const leadBudget = createRunBudget({
      id: runId,
      limitAtomic: await memberBudgetAtomic(selected.account, budgetAtomic, deps),
    });
    const leadMeta = { swarm: swarm.name, member: selected.account };
    const leadContext: SwarmRunContext = {
      name: swarm.name,
      treasury: swarm.treasury.account,
      member: selected.account,
      depth: 0,
      draw,
      async allocate(input) {
        const allocation = await allocateFromTreasury(
          {
            name: swarm.name,
            member: selected.account,
            amountUsd: input.amountUsd,
            reason: "allocate",
            requestId: input.requestId,
            draw,
          },
          deps.capital,
        );
        return allocateResult(allocation);
      },
      async delegate(input) {
        const target = delegationTarget(
          input.member,
          selected.account,
          swarm.treasury.account,
          assessments,
          swarm.name,
        );
        const allocation = await allocateFromTreasury(
          {
            name: swarm.name,
            member: target.account,
            amountUsd: input.budgetUsd,
            reason: "delegate",
            requestId: input.requestId,
            draw,
          },
          deps.capital,
        );
        const sentAtomic = sentMovementAtomic(allocation.movement);
        if (sentAtomic === 0n) throw delegationNotFunded(target.account, allocation);
        const movementId = allocation.movementId;
        if (movementId === null) {
          throw new Error("A funded delegation returned no movement id.");
        }

        const existingRecord = await readDelegationRecord(deps.home, movementId);
        if (existingRecord?.result !== undefined) {
          const childResult = recoveredMemberResult(
            target,
            recordedDelegateResult(existingRecord),
            input.parentRunId,
          );
          addChildResult(childResults, childResult);
          return delegateResult(childResult);
        }
        if (existingRecord !== undefined) {
          const childResult = recoveredMemberResult(
            target,
            interruptedDelegateResult(existingRecord),
            input.parentRunId,
          );
          addChildResult(childResults, childResult);
          return delegateResult(childResult);
        }

        const childRunId = (deps.newRunId ?? createRunId)();
        const delegationRecord: DelegationRecord = {
          v: 1,
          movementId,
          requestId: input.requestId,
          swarm: swarm.name,
          member: target.account,
          budgetUsd: allocation.sentUsd,
          childRunId,
          startedAt: (deps.now?.() ?? new Date()).toISOString(),
        };
        await writeDelegationRecord(deps.home, delegationRecord);
        const childBudget = createRunBudget({ id: childRunId, limitAtomic: sentAtomic });
        const childProfile = withoutTreasuryGrants(target.profile);
        const childMeta = {
          swarm: swarm.name,
          member: target.account,
          parentRunId: input.parentRunId,
        };
        const blockedMovement = async (): Promise<never> => {
          throw new Error("A delegated run cannot move treasury money.");
        };
        const childContext: SwarmRunContext = {
          name: swarm.name,
          treasury: swarm.treasury.account,
          member: target.account,
          depth: 1,
          draw,
          allocate: blockedMovement,
          delegate: blockedMovement,
        };

        let childResult: SwarmRunMemberResult;
        try {
          const provided = await deps.depsForMember(target, {
            runId: childRunId,
            budget: childBudget,
            runMeta: childMeta,
            profile: childProfile,
            approvals: "tty",
          });
          const childDeps: RunAgentDeps = {
            ...provided,
            profile: childProfile,
            budget: childBudget,
            runId: childRunId,
            runMeta: childMeta,
            swarm: childContext,
          };
          childResult = completedMemberResult(
            target,
            await run(input.task, childDeps),
            childBudget,
            input.parentRunId,
          );
        } catch (error) {
          childResult = failedMemberResult(
            target,
            childRunId,
            childBudget,
            error,
            input.parentRunId,
          );
        }
        childResults.push(childResult);
        try {
          await writeDelegationRecord(deps.home, {
            ...delegationRecord,
            result: delegationRecordResult(childResult),
          });
        } catch {
          // The child result is still returned; a later retry will conservatively report interruption.
        }
        return delegateResult(childResult);
      },
    };

    let leadResult: SwarmRunMemberResult;
    try {
      const provided = await deps.depsForMember(selected, {
        runId,
        budget: leadBudget,
        runMeta: leadMeta,
        profile: selected.profile,
        approvals: "tty",
      });
      const leadDeps: RunAgentDeps = {
        ...provided,
        profile: selected.profile,
        budget: leadBudget,
        runId,
        runMeta: leadMeta,
        swarm: leadContext,
      };
      leadResult = completedMemberResult(selected, await run(opts.task, leadDeps), leadBudget);
    } catch (error) {
      leadResult = failedMemberResult(selected, runId, leadBudget, error);
    }
    members = [leadResult, ...childResults, ...skipped];
  } else {
    if (eligible.length === 0) {
      throw new SwarmRunError(
        "no_eligible_members",
        `Swarm ${swarm.name} has no linked, active members with readable profiles.`,
      );
    }
    const jobs = await Promise.all(
      eligible.map(async ({ target }) => {
        const memberRunId = (deps.newRunId ?? createRunId)();
        return {
          target,
          runId: memberRunId,
          budget: createRunBudget({
            id: memberRunId,
            limitAtomic: await memberBudgetAtomic(target.account, budgetAtomic, deps),
          }),
        };
      }),
    );
    const completed = await mapConcurrent(jobs, concurrency(opts.concurrency), async (job) => {
      const profile = withoutTreasuryGrants(job.target.profile);
      const runMeta = {
        swarm: swarm.name,
        member: job.target.account,
        parentRunId: runId,
      };
      try {
        const provided = await deps.depsForMember(job.target, {
          runId: job.runId,
          budget: job.budget,
          runMeta,
          profile,
          approvals: "decline",
        });
        const memberDeps: RunAgentDeps = {
          ...provided,
          profile,
          budget: job.budget,
          runId: job.runId,
          runMeta,
          approve: async () => false,
          swarm: undefined,
        };
        return completedMemberResult(
          job.target,
          await run(opts.task, memberDeps),
          job.budget,
          runId,
        );
      } catch (error) {
        return failedMemberResult(job.target, job.runId, job.budget, error, runId);
      }
    });
    const byAccount = new Map(completed.map((result) => [result.member, result]));
    const skippedByAccount = new Map(skipped.map((result) => [result.member, result]));
    members = assessments.map((assessment) => {
      const result = byAccount.get(assessment.account) ?? skippedByAccount.get(assessment.account);
      if (result === undefined) throw new Error(`No run result for ${assessment.account}.`);
      return result;
    });
  }

  const base: SwarmRunResult = {
    runId,
    mode: opts.mode,
    members,
    drawUsedUsd: atomicUsd(draw.spentAtomic()),
    drawLimitUsd: atomicUsd(draw.limitAtomic),
    net: [],
  };
  try {
    const status = await deps.status(swarm.name);
    base.net = status.members.map((member) => ({
      member: member.account,
      balanceUsd: member.balanceUsd,
      allocatedInUsd: member.allocatedInUsd,
      sweptOutUsd: member.sweptOutUsd,
      netUsd: member.netUsd,
    }));
  } catch (error) {
    base.netError = safeErrorDetail(error);
  }
  return base;
}

export async function assessSwarmMembers(
  swarm: SwarmFile,
  deps: Pick<RunSwarmDeps, "home" | "store" | "readProfile">,
): Promise<MemberAssessment[]> {
  const readProfile = deps.readProfile ?? defaultProfileReader(deps.home);
  const assessments: MemberAssessment[] = [];
  for (const member of swarm.members) {
    if (deps.store.entry(member.account)?.link === undefined) {
      assessments.push({
        account: member.account,
        role: member.role,
        eligible: false,
        reason: "not_linked",
      });
      continue;
    }
    const profile = await readProfile(member.account);
    if (profile === undefined) {
      assessments.push({
        account: member.account,
        role: member.role,
        eligible: false,
        reason: "no_profile",
      });
      continue;
    }
    if (profile.paused) {
      assessments.push({
        account: member.account,
        role: member.role,
        eligible: false,
        reason: "paused",
      });
      continue;
    }
    assessments.push({
      account: member.account,
      role: member.role,
      eligible: true,
      target: {
        account: member.account,
        role: member.role,
        profile: { ...profile, wallet: member.account },
      },
    });
  }
  return assessments;
}

function amountAtomic(value: string): bigint {
  try {
    return parseWholeUsdCents(value) * ATOMIC_PER_CENT;
  } catch {
    throw new SwarmRunError("invalid_amount", "Enter a positive USDC amount in whole cents.");
  }
}

function parseWholeUsdCents(value: string): bigint {
  if (!/^\d+(?:\.\d{1,2})?$/u.test(value)) throw new Error("Invalid amount.");
  const [whole = "0", fraction = ""] = value.split(".");
  const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0") || "0");
  if (cents <= 0n) throw new Error("Invalid amount.");
  return cents;
}

function defaultProfileReader(
  home: string,
): (account: string) => Promise<AgentProfile | undefined> {
  return async (account) => {
    try {
      return await readAgentProfile(home, account, { schema: registeredAgentProfileSchema });
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === `No agent named ${account}. Create it with vapi agent create ${account}.`
      ) {
        return undefined;
      }
      throw error;
    }
  };
}

function skippedResult(
  assessment: Extract<MemberAssessment, { eligible: false }>,
): SwarmRunMemberResult {
  return {
    member: assessment.account,
    role: assessment.role,
    runId: null,
    answer: null,
    stoppedBecause: null,
    spentUsd: 0,
    budgetUsd: 0,
    status: "skipped",
    reason: assessment.reason,
  };
}

export function selectLead(
  opts: Pick<RunSwarmOptions, "name" | "lead">,
  assessments: readonly MemberAssessment[],
): SwarmMemberTarget {
  const assessment =
    opts.lead === undefined
      ? assessments.find((candidate) => candidate.role === "lead")
      : assessments.find((candidate) => candidate.account === opts.lead);
  if (assessment === undefined) {
    if (opts.lead === undefined) {
      throw new SwarmRunError("no_lead", `Swarm ${opts.name} has no lead member.`);
    }
    throw new SwarmRunError(
      "invalid_lead",
      `${opts.lead} is not an eligible member of swarm ${opts.name}.`,
    );
  }
  if (!assessment.eligible) {
    throw new SwarmRunError(
      "invalid_lead",
      `${assessment.account} is not an eligible member of swarm ${opts.name}.`,
    );
  }
  return assessment.target;
}

function delegationTarget(
  account: string,
  caller: string,
  treasury: string,
  assessments: readonly MemberAssessment[],
  swarm: string,
): SwarmMemberTarget {
  if (account === treasury) throw new Error(`Cannot delegate to swarm treasury ${treasury}.`);
  const assessment = assessments.find((candidate) => candidate.account === account);
  if (assessment === undefined) throw new Error(`Member ${account} is not in swarm ${swarm}.`);
  if (account === caller) throw new Error(`Member ${account} cannot delegate to itself.`);
  if (!assessment.eligible) {
    throw new Error(`Member ${account} is not eligible: ${assessment.reason}.`);
  }
  return assessment.target;
}

export async function memberBudgetAtomic(
  account: string,
  configured: bigint | undefined,
  deps: Pick<RunSwarmDeps, "home" | "store" | "ledgerPath" | "now">,
): Promise<bigint> {
  if (configured !== undefined) return configured;
  const caps = await spendCapsForWallet(deps.store, account);
  const ledger = await readSpendLedger(
    deps.ledgerPath ?? getVapiPaths(deps.home).ledger,
    deps.now?.() ?? new Date(),
    account,
  );
  const remaining = BigInt(caps.perDayAtomic) - BigInt(ledger.spentAtomic);
  return remaining < 0n ? 0n : remaining;
}

function withoutTreasuryGrants(profile: AgentProfile): AgentProfile {
  return {
    ...profile,
    grants: profile.grants.filter((grant) => grant !== "delegate" && grant !== "allocate"),
  };
}

function completedMemberResult(
  target: SwarmMemberTarget,
  result: RunAgentResult,
  budget: RunBudget,
  parentRunId?: string,
): SwarmRunMemberResult {
  return {
    member: target.account,
    role: target.role,
    runId: result.runId,
    ...(parentRunId === undefined ? {} : { parentRunId }),
    answer: result.answer === null ? null : redactSecretPatterns(result.answer),
    stoppedBecause: {
      reason: result.stoppedBecause.reason,
      ...(result.stoppedBecause.detail === undefined
        ? {}
        : {
            detail: redactSecretPatterns(result.stoppedBecause.detail).slice(0, MAX_ERROR_DETAIL),
          }),
    },
    spentUsd: atomicUsd(budget.spentAtomic()),
    budgetUsd: atomicUsd(budget.limitAtomic),
    status: result.stoppedBecause.reason === "finished" ? "finished" : "stopped",
  };
}

function failedMemberResult(
  target: SwarmMemberTarget,
  runId: string,
  budget: RunBudget,
  error: unknown,
  parentRunId?: string,
): SwarmRunMemberResult {
  return {
    member: target.account,
    role: target.role,
    runId,
    ...(parentRunId === undefined ? {} : { parentRunId }),
    answer: null,
    stoppedBecause: { reason: "error", detail: safeErrorDetail(error) },
    spentUsd: atomicUsd(budget.spentAtomic()),
    budgetUsd: atomicUsd(budget.limitAtomic),
    status: "error",
  };
}

function allocateResult(
  result: Awaited<ReturnType<typeof allocateFromTreasury>>,
): SwarmAllocateResult {
  return {
    status: result.status,
    movementId: result.movementId,
    sentUsd: result.sentUsd,
    blocked: result.blocked,
  };
}

function sentMovementAtomic(
  movement: Awaited<ReturnType<typeof allocateFromTreasury>>["movement"],
): bigint {
  return (
    movement?.legs.reduce(
      (total, leg) =>
        leg.status === "sent" ? total + parseWholeUsdCents(leg.amountUsd) * ATOMIC_PER_CENT : total,
      0n,
    ) ?? 0n
  );
}

function delegationNotFunded(
  member: string,
  allocation: Awaited<ReturnType<typeof allocateFromTreasury>>,
): Error {
  const blocked = allocation.blocked[0]?.reason;
  if (blocked !== undefined) {
    return new Error(`Delegation to ${member} was not funded: ${blocked}.`);
  }
  if (allocation.unknownUsd !== "0.00") {
    return new Error(
      `Delegation to ${member} has ${allocation.unknownUsd} USDC with unknown settlement; the child was not started.`,
    );
  }
  return new Error(`Delegation to ${member} was not funded: ${allocation.message}`);
}

function delegateResult(result: SwarmRunMemberResult): SwarmDelegateResult {
  return {
    member: result.member,
    runId: result.runId,
    answer: result.answer,
    stoppedBecause: result.stoppedBecause,
    spentUsd: result.spentUsd,
    budgetUsd: result.budgetUsd,
  };
}

function delegationRecordResult(
  result: SwarmRunMemberResult,
): NonNullable<DelegationRecord["result"]> {
  if (result.spentUsd === null) {
    throw new Error(`Delegated run ${result.runId ?? "unknown"} has unknown spending.`);
  }
  return {
    runId: result.runId,
    answer: result.answer,
    stoppedBecause: result.stoppedBecause,
    spentUsd: result.spentUsd,
    budgetUsd: result.budgetUsd,
  };
}

function recordedDelegateResult(record: DelegationRecord): SwarmDelegateResult {
  if (record.result === undefined) throw new Error("The delegation record has no result.");
  return { member: record.member, ...record.result };
}

function interruptedDelegateResult(record: DelegationRecord): SwarmDelegateResult {
  return {
    member: record.member,
    runId: record.childRunId,
    answer: null,
    stoppedBecause: {
      reason: "error",
      detail: `Delegated run ${record.childRunId} was interrupted before its final record was saved; spending and remaining budget are unknown. Inspect receipts for run ${record.childRunId} before allocating more.`,
    },
    spentUsd: null,
    budgetUsd: Number(record.budgetUsd),
  };
}

function recoveredMemberResult(
  target: SwarmMemberTarget,
  result: SwarmDelegateResult,
  parentRunId: string,
): SwarmRunMemberResult {
  return {
    member: result.member,
    role: target.role,
    runId: result.runId,
    parentRunId,
    answer: result.answer,
    stoppedBecause: result.stoppedBecause,
    spentUsd: result.spentUsd,
    budgetUsd: result.budgetUsd,
    status:
      result.stoppedBecause?.reason === "finished"
        ? "finished"
        : result.stoppedBecause?.reason === "error"
          ? "error"
          : "stopped",
  };
}

function addChildResult(childResults: SwarmRunMemberResult[], result: SwarmRunMemberResult): void {
  if (!childResults.some((candidate) => candidate.runId === result.runId)) {
    childResults.push(result);
  }
}

function atomicUsd(value: bigint): number {
  return Number(value) / 1_000_000;
}

function concurrency(value: number | undefined): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0
    ? value
    : DEFAULT_CONCURRENCY;
}

async function mapConcurrent<T, R>(
  values: readonly T[],
  limit: number,
  fn: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let next = 0;
  const worker = async () => {
    while (next < values.length) {
      const index = next;
      next += 1;
      results[index] = await fn(values[index]!);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, values.length) }, async () => await worker()),
  );
  return results;
}

function safeErrorDetail(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactSecretPatterns(message).slice(0, MAX_ERROR_DETAIL);
}

function redactSecretPatterns(value: string): string {
  const withoutStructuredSecrets = value
    .replace(/\b0x[0-9a-fA-F]{64}\b/gu, "[redacted private key]")
    .replace(/\bvapi_sk_[A-Za-z0-9_-]{16,128}\b/gu, "[redacted API key]")
    .replace(/\bBearer\s+\S+/giu, "Bearer [redacted]")
    .replace(
      /\b(?:private|secret|router|access|refresh|device)[A-Za-z0-9_-]{4,}\b/giu,
      "[redacted credential]",
    );
  return withoutStructuredSecrets.replace(
    /\b(?:[a-z]+\s+){23}[a-z]+\b|\b(?:[a-z]+\s+){11}[a-z]+\b/giu,
    (candidate) => (isRecoveryPhrase(candidate) ? "[redacted recovery phrase]" : candidate),
  );
}

function isRecoveryPhrase(value: string): boolean {
  try {
    validateRecoveryPhrase(value);
    return true;
  } catch {
    return false;
  }
}
