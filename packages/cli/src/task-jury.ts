import { getVapiPaths, loadConfig, spendCapsForWallet } from "@vapi-network/core";
import {
  createTasksRpcFor,
  executeTaskV2,
  readTaskV2ReviewerStatus,
  runTaskV2Jury,
  runTaskV2Vote,
  TASK_V2_JURY_STEPS,
  TASK_V2_VOTE_OUTCOMES,
  taskPolicyForWallet,
  taskV2IndexSchema,
  type TaskV2JuryStep,
} from "@vapi-network/core/tasks";
import { registeredAgentProfileSchema } from "@vapi-network/mcp";

import {
  getEnvironment,
  parseArguments,
  UsageError,
  type CliDependencies,
  type CliIo,
} from "./cli.js";
import { taskContext, TaskCommandError } from "./task.js";

type Parsed = ReturnType<typeof parseArguments>;

/** Jury, vote and reviewer verbs: hosted prepare/confirm, local plan guard, local signing. */
export const TASK_JURY_VERBS = [
  "jury",
  "vote",
  "approve-bond",
  "claim-owed",
  "reviewer-status",
] as const;

const ADDRESS = /^0x[0-9a-fA-F]{40}$/u;

function index(parsed: Parsed): number {
  const raw = parsed.one("--index");
  const value = raw !== undefined && /^\d+$/u.test(raw) ? Number(raw) : NaN;
  if (!taskV2IndexSchema.safeParse(value).success)
    throw new UsageError("--index must be a zero-based C0 index from 0 to 4.");
  return value;
}

export async function taskJuryCommand(
  verb: (typeof TASK_JURY_VERBS)[number],
  id: string | undefined,
  parsed: Parsed,
  json: boolean,
  io: CliIo,
  dependencies: CliDependencies,
): Promise<number | undefined> {
  if (verb === "reviewer-status") return await reviewerStatus(parsed, json, io, dependencies);
  // Validate every flag before any wallet, network or vault access.
  let run: "jury" | "vote" | "write";
  let step: TaskV2JuryStep | undefined;
  let vote:
    | { action: "commit"; outcome: (typeof TASK_V2_VOTE_OUTCOMES)[number]; toWorker?: string }
    | { action: "reveal" }
    | undefined;
  let i = 0;
  let to: string | undefined;
  if (verb === "jury") {
    run = "jury";
    i = index(parsed);
    const value = parsed.one("--step");
    if (!value || !(value in TASK_V2_JURY_STEPS))
      throw new UsageError("--step must be open, draw, rearm or resolve.");
    step = value as TaskV2JuryStep;
  } else if (verb === "vote") {
    run = "vote";
    i = index(parsed);
    const commit = parsed.one("--commit");
    const toWorker = parsed.one("--to-worker");
    if (Boolean(commit) === parsed.has("--reveal"))
      throw new UsageError("Vote takes exactly one of --commit worker|poster|split or --reveal.");
    if (commit) {
      if (!(TASK_V2_VOTE_OUTCOMES as readonly string[]).includes(commit))
        throw new UsageError("--commit must be worker, poster or split.");
      if (commit === "split" && !/^[1-9][0-9]*$/u.test(toWorker ?? ""))
        throw new UsageError("A split vote needs --to-worker in USDC base units.");
      if (commit !== "split" && toWorker !== undefined)
        throw new UsageError("Only a split vote takes --to-worker.");
      vote = {
        action: "commit",
        outcome: commit as (typeof TASK_V2_VOTE_OUTCOMES)[number],
        ...(toWorker === undefined ? {} : { toWorker }),
      };
    } else {
      if (toWorker !== undefined)
        throw new UsageError("Reveal reads the sealed local ballot; it takes no --to-worker.");
      vote = { action: "reveal" };
    }
  } else {
    run = "write";
    to = parsed.one("--to");
    if (to !== undefined && !ADDRESS.test(to)) throw new UsageError("--to must be a 0x address.");
  }
  const context = await taskContext(parsed, io, dependencies);
  const target = context.target;
  if (!context.token || !target)
    throw new TaskCommandError(
      "not_signed_in",
      "Sign-in is needed for the acting wallet. Run vapi login.",
    );
  const base = {
    id: id!,
    policy: await taskPolicyForWallet({
      directory: getVapiPaths().directory,
      wallet: target.name,
      schema: registeredAgentProfileSchema,
    }),
    caps: await spendCapsForWallet(target.store, target.name),
    wallet: target.name,
    ledgerPath: getVapiPaths().ledger,
    approval: { granted: parsed.has("--yes") },
    onMoney: (money: { line: string }) => {
      io.stderr(money.line);
    },
  };
  const result =
    run === "jury"
      ? await runTaskV2Jury(context, { ...base, i, step: step! })
      : run === "vote"
        ? await runTaskV2Vote(context, { ...base, i, ...vote! })
        : await executeTaskV2(context, {
            ...base,
            write:
              verb === "approve-bond"
                ? { action: "approve-bond" }
                : {
                    action: "claim-owed",
                    ...(to === undefined ? {} : { to: to.toLowerCase() as `0x${string}` }),
                  },
          });
  const state = "operation" in result && result.operation ? result.operation.state : "pending";
  const ballot =
    run === "vote"
      ? (result as { ballot?: { commitment: string; path: string } }).ballot
      : undefined;
  const lines = !result.ok
    ? [`Task action refused: ${"reason" in result ? result.reason : "approval required"}.`]
    : verb === "jury"
      ? [
          `Jury step ${step} for task ${id} milestone ${i}: ${state}.`,
          ...("caseState" in result && result.caseState
            ? [`Case state: ${result.caseState}.`]
            : []),
        ]
      : ballot
        ? vote!.action === "commit"
          ? [
              `Vote committed for task ${id} milestone ${i}: ${state}. Commitment ${ballot.commitment}.`,
              `The sealed ballot stays on this machine at ${ballot.path}. Reveal it after the commit window with vapi task vote ${id} --index ${i} --reveal.`,
            ]
          : [`Vote revealed for task ${id} milestone ${i}: ${state}.`]
        : [`Hosted ${state} for task ${id}.`];
  io.stdout(
    json
      ? JSON.stringify({ command: `task ${verb}`, wallet: target.name, ...result })
      : lines.join("\n"),
  );
  return result.ok ? undefined : "approval" in result ? 3 : 2;
}

async function reviewerStatus(
  parsed: Parsed,
  json: boolean,
  io: CliIo,
  dependencies: CliDependencies,
): Promise<undefined> {
  const requested = parsed.one("--address");
  if (requested !== undefined && !ADDRESS.test(requested))
    throw new UsageError("--address must be a 0x address.");
  const context = await taskContext(parsed, io, dependencies, true);
  const wallet = requested ?? context.target?.address;
  if (!wallet) throw new UsageError("Pass --address or select a local account.");
  const deployment = await context.client.deployment();
  const env = getEnvironment(dependencies);
  const rpcFor =
    dependencies.tasks?.rpcFor ??
    createTasksRpcFor(await loadConfig(getVapiPaths().config, env, { notice: () => {} }), {
      env,
      ...(dependencies.fetchImpl === undefined ? {} : { fetch: dependencies.fetchImpl }),
    });
  const status = await readTaskV2ReviewerStatus({
    chainId: deployment.chainId,
    wallet,
    rpcFor,
    env,
    onV2UntrustedOverride: io.stderr,
  });
  io.stdout(
    json
      ? JSON.stringify({ command: "task reviewer-status", ...status })
      : [
          `Reviewer ${status.wallet} on chain ${status.chainId} (resolver ${status.resolver}).`,
          `Registry seat: ${status.isReviewer ? "yes" : "no"} · vAPI ID: ${status.hasId ? "yes" : "no"} · stake ${status.staked} of ${status.threshold} (${status.meetsStake ? "meets" : "below"} the gate) · gate eligible: ${status.eligible ? "yes" : "no"}.`,
          `Available: ${status.available ? "yes" : "no"} · suspended: ${status.suspended ? "yes" : "no"} · missed reveals: ${status.missedReveals} · claimable fees: ${status.claimable} base units.`,
          status.ready ? "Ready to be drawn." : "Not ready to be drawn.",
        ].join("\n"),
  );
  return undefined;
}
