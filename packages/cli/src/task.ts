import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import {
  createPublicFetch,
  getCanonicalX402Usdc,
  getVapiPaths,
  KeystoreError,
  loadConfig,
  spendCapsForWallet,
} from "@vapi-network/core";
import {
  executeTaskV2,
  taskUsesV2,
  taskV2PreparedSchema,
  autoReleaseDecision,
  awardTask,
  cachedMoneyClient,
  createScopeBindings,
  createPendingTransactions,
  createTasksChain,
  createTasksRpcFor,
  deliverTaskOperation,
  disputeTaskOperation,
  counterEvidenceTaskOperation,
  resolveUnmatchedTaskOperation,
  fundTaskOperation,
  fundTaskWithX402,
  requireTaskMethod,
  formatBaseUnitsUsd,
  messageTask,
  missingTasksChain,
  nextTaskEvents,
  parseTaskDuration as parseCoreTaskDuration,
  parseUsdToBaseUnits,
  postTask,
  prepareTaskPost,
  parseTaskMilestone,
  parseTaskProof,
  checkinInputSchema,
  taskEventLine,
  proposeTask,
  publicNotFoundFetch,
  readTaskFile as readCoreTaskFile,
  refundTaskOperation,
  releaseTask,
  releaseTaskOperation,
  safeTasksChainError,
  resolveTaskBearer,
  searchTasks,
  showTask,
  signTaskScope,
  submitTask,
  taskEventState,
  taskMoney,
  taskFeeReservationKey,
  taskMoneySnapshot,
  taskPolicyForWallet,
  taskRequest as coreTaskRequest,
  taskStateMatches,
  taskStatus,
  threadTask,
  waitForMilestone,
  TASK_LIMITS,
  TASK_WATCH_STATES,
  TASKS_CLIENT_VERBS,
  TaskInputError,
  TaskOperationError,
  TasksScopeCreationError,
  TasksChainError,
  type TasksChain,
  type TasksClient,
  type TasksClientOptions,
  type PendingTransactions,
  type SubmissionProof,
  type UploadFileInput,
  type CreateOrderInput,
  type TaskMoney,
  type SignedScopeTerms,
  validTaskBrief,
} from "@vapi-network/core/tasks";
import { createHostedTasksClient, registeredAgentProfileSchema } from "@vapi-network/mcp";
import {
  getEnvironment,
  getLinePrompt,
  getSecretStore,
  parseArguments,
  registryBaseUrl,
  targetWallet,
  unlockTarget,
  UsageError,
  type CliDependencies,
  type CliIo,
  type WalletTarget,
} from "./cli.js";

import { taskV2Command } from "./task-v2.js";

export type TasksCommandDependencies = {
  client?: TasksClient | ((options: TasksClientOptions) => TasksClient);
  chain?: TasksChain;
  sleep?: (milliseconds: number) => Promise<void>;
  randomUUID?: () => string;
};

export const TASK_HELP = `Usage:
  vapi task search [--open] [--min <usd>] [--tab trending|new|closing|paid] [--limit <n>] [--json]
  vapi task show <id> [--account <name>] [--json]
  vapi task pending [--account <name>] [--json]
  vapi task checkin <id> --status on-track|blocked|need-input [--note <text>] [--link <url>] [--account <name>] [--json]
  vapi task post --title <text> --brief <file|-> --deadline <duration|ISO> [--shape task|bounty|pool] [--amount <usd>] [--milestone "amount|acceptance|deadline"...] [--proof <preset>[:mustContain]...] [--checkin none|6h|24h|72h|7d] [--winners <n> --reward-per-winner <usd> --choice-window <sec>] [--reward-per-claim <usd> --budget <usd> --gate open|proven --verifier poster|vapi --open-check allowlist|invite] [--fund] [--yes] [--no-wait] [--timeout 120s] [--intake proposals|submissions] [--max-awards <k>] [--webhook <https-url>] [--account <name>] [--json]
  vapi task propose <id> --price <usd> --duration <duration> --note <text> [--account <name>] [--json]
  vapi task submit <id> [--proof <https-url>...] [--file <path>...] [--withdraw] [--proposal-id <id>] [--account <name>] [--json]
  vapi task milestone <id> --index N submit|approve|reject|finalize [--proof <https-url>...] [--file <path>...] [--proof-json <file>] [--note <text>] [--reason <text>] [--json]
  vapi task cancel <id> offer|remainder|expire [--json]
  vapi task claim <id> --claimant <addr> [--json]
  vapi task award <id> [<proposalId>|--worker <addr>|--winners a,b,c] [--account <name>] [--json]
  vapi task sign <id> [--action award-consent|split-consent --index N --to-worker <base-units>] [--yes] [--no-wait] [--timeout 120s] [--counterparty <0x…>] [--account <name>] [--json]
  vapi task fund <id> [--yes] [--no-wait] [--timeout 120s] [--counterparty <0x…>] [--account <name>] [--json]
  vapi task deliver <id> --files <path...> --note <text> [--no-wait] [--timeout 120s] [--counterparty <0x…>] [--account <name>] [--json]
  vapi task release <id> [--no-wait] [--timeout 120s] [--counterparty <0x…>] [--account <name>] [--json]
  vapi task refund <id> [--counterparty <0x…>] [--account <name>] [--json]
  vapi task dispute <id> [--evidence-hash <0x + 64 hex>|--index N --evidence <text>] [--action raise|resolve-unmatched|split --to-worker <base-units>] [--yes] [--counterparty <0x…>] [--account <name>] [--json]
  vapi task counter-evidence <id> [--evidence-hash <0x + 64 hex>|--index N --evidence <text>] [--yes] [--counterparty <0x…>] [--account <name>] [--json]
  vapi task resolve-unmatched <id> [--index N] [--counterparty <0x…>] [--account <name>] [--json]
  vapi task message <id> <text> [--account <name>] [--json]
  vapi task thread <id> [--after <cursor>] [--account <name>] [--json]
  vapi task watch <id> [--until <state>] [--auto-release] [--timeout 7d] [--interval 5s] [--counterparty <0x…>] [--account <name>] [--json]
  vapi task status <id> [--operation <uuid> --step <v2-step> --recover|--abandon] [--account <name>] [--json]

Durations: 5s, 10m, 48h, 7d, or an ISO-8601 timestamp. Posting and proposal terms require at least 10 minutes.
V1 dispute accepts a precomputed evidence hash. V2 dispute accepts --index with --evidence text. C0 action indices are zero-based; declared milestone indices remain one-based.
Watch requires an interval of at least 1s and a positive timeout. Auto-release uses the acting wallet's agent profile, or defaults, and releases only amounts strictly below the threshold.
Posting without --fund moves no money. --fund applies task and daily caps before signing. Task reads require tasks:read and writes require tasks:write; write access includes reads.
The thread cursor is the previous page's nextBeforeSeq; --after reads older messages using beforeSeq.
Every command accepts --json. Watch and a partially completed sign may write more than one JSON value. Human diagnostics go to stderr.

Exit codes:
  0  ok
  1  error, including invalid usage, unavailable routes and chain failures
  2  policy refusal only (JSON ok:false with reason policy.perTask or policy.perDay)
  3  approval needed in non-interactive mode

Fund, deliver, release, refund, dispute, counter-evidence, resolve-unmatched and watch auto-release sign with the local vault wallet. The CLI waits for two confirmations and records pending transactions for recovery. It never retries a chain mutation automatically. Sign, fund, deliver and release wait up to 120s for vAPI to index a confirmed transaction unless --no-wait is set; an indexing timeout keeps exit code 0.`;

const IMPLEMENTED_VERBS = TASKS_CLIENT_VERBS;
const USAGE = `Usage: vapi task <${IMPLEMENTED_VERBS.join("|")}>. Run vapi task --help.`;
type Parsed = ReturnType<typeof parseArguments>;
type TaskRoute = keyof TasksClient;

export class TaskCommandError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly manifestHash?: `0x${string}`,
    readonly prefixCode = false,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "TaskCommandError";
  }
}

function mapTaskError(error: unknown): unknown {
  if (error instanceof TaskInputError) return new UsageError(error.message);
  if (error instanceof TaskOperationError)
    return new TaskCommandError(error.code, error.message, error.manifestHash, true, error.details);
  return error;
}

async function mapped<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw mapTaskError(error);
  }
}

/** Relative milliseconds; timestamps are measured from the supplied clock. */
export function parseTaskDuration(text: string, now: Date): number {
  try {
    return parseCoreTaskDuration(text, now);
  } catch (error) {
    throw mapTaskError(error);
  }
}

export type TaskContext = {
  client: TasksClient;
  chain: TasksChain;
  pending?: PendingTransactions;
  baseUrl: string;
  target?: WalletTarget;
  token?: string;
  randomUUID: () => string;
  sleep: (milliseconds: number) => Promise<void>;
  signInHint: string;
};

function lazyTasksChain(
  factory: () => Promise<TasksChain>,
  pending: PendingTransactions,
  signingAddress?: SignedScopeTerms["self"],
): TasksChain {
  let chain: Promise<TasksChain> | undefined;
  const get = () =>
    (chain ??= factory().catch((error: unknown) => {
      if (error instanceof TasksChainError) throw error;
      throw safeTasksChainError(error, false, false);
    }));
  async function feeChain(
    action: "dispute" | "counter-evidence",
    input: Parameters<TasksChain["dispute"]>[0],
  ) {
    let initialized: TasksChain;
    try {
      initialized = await get();
    } catch (error) {
      let exposed = true;
      try {
        exposed = await pending.exposure(taskFeeReservationKey(input.escrowId, action));
      } catch {
        /* A failed read cannot prove rollback is safe. */
      }
      throw safeTasksChainError(
        error,
        error instanceof TasksChainError && error.broadcast,
        exposed,
      );
    }
    return action === "dispute" ? initialized.dispute(input) : initialized.counterEvidence(input);
  }
  return {
    available: true,
    executeV2: async (input) => {
      const initialized = await get();
      if (!initialized.executeV2)
        throw new TaskOperationError("chain_unavailable", "V2 signing is unavailable.");
      return initialized.executeV2(input);
    },
    ...(signingAddress === undefined ? {} : { signingAddress }),
    getSigningAddress: async () => {
      const initialized = await get();
      const address = initialized.signingAddress ?? (await initialized.getSigningAddress?.());
      if (!address)
        throw new TasksChainError(
          "A local signing wallet is required for accepted scope recovery.",
          false,
          { authorizationExposed: false },
        );
      return address;
    },
    createEscrow: async (input) => (await get()).createEscrow(input),
    validateFunding: async (input) => {
      const initialized = await get();
      if (!initialized.validateFunding)
        throw new TasksChainError("Local funding verification is unavailable.", false, {
          authorizationExposed: false,
        });
      return initialized.validateFunding(input);
    },
    fundingAuthorizationState: async (input) => {
      const initialized = await get();
      if (!initialized.fundingAuthorizationState)
        throw new TasksChainError("Authorization state verification is unavailable.", false, {
          authorizationExposed: false,
        });
      return initialized.fundingAuthorizationState(input);
    },
    fund: async (input) => {
      let initialized: TasksChain;
      try {
        initialized = await get();
      } catch (error) {
        let exposed = true;
        try {
          exposed = await pending.exposure(input.escrowId);
        } catch {
          // A failed exposure read cannot prove rollback is safe.
        }
        throw safeTasksChainError(
          error,
          error instanceof TasksChainError && error.broadcast,
          exposed,
        );
      }
      return initialized.fund(input);
    },
    deliver: async (input) => (await get()).deliver(input),
    release: async (input) => (await get()).release(input),
    refund: async (input) => (await get()).refund(input),
    dispute: async (input) => feeChain("dispute", input),
    disputeFee: async (input) => (await get()).disputeFee(input),
    counterEvidence: async (input) => feeChain("counter-evidence", input),
    resolveUnmatched: async (input) => (await get()).resolveUnmatched(input),
    bindScope: async (binding) => (await get()).bindScope?.(binding),
    signScopeMessage: async (message) => (await get()).signScopeMessage(message),
  };
}

/** Reuses wallet selection, registry configuration and device-link credentials. */
export async function taskContext(
  parsed: Parsed,
  io: CliIo,
  dependencies: CliDependencies,
  publicOnly = false,
): Promise<TaskContext> {
  const env = getEnvironment(dependencies);
  const config = await loadConfig(getVapiPaths().config, env, { notice: io.stderr });
  const baseUrl = registryBaseUrl(config);
  let target: WalletTarget | undefined;
  try {
    target = await targetWallet(parsed, dependencies);
  } catch (error) {
    if (!(
      error instanceof KeystoreError &&
      error.message === "No wallet yet. Run vapi init." &&
      parsed.one("--wallet") === undefined &&
      !env.VAPI_WALLET?.trim()
    ))
      throw error;
  }
  const token =
    publicOnly || target === undefined
      ? undefined
      : await mapped(() =>
          resolveTaskBearer({
            secrets: getSecretStore(dependencies),
            wallets: target.store as unknown as Parameters<typeof resolveTaskBearer>[0]["wallets"],
            wallet: target.name,
            baseUrl,
            signInHint: "Run vapi login for this server.",
            ...(dependencies.fetchImpl === undefined ? {} : { fetchImpl: dependencies.fetchImpl }),
            ...(dependencies.now === undefined ? {} : { now: () => dependencies.now!().getTime() }),
          }),
        );
  const options: TasksClientOptions = {
    baseUrl,
    ...(token === undefined ? {} : { token }),
    fetch: publicNotFoundFetch(
      dependencies.fetchImpl ?? createPublicFetch({ allowPrivateNetwork: false }),
      baseUrl,
    ),
  };
  const injected = dependencies.tasks?.client;
  const client =
    typeof injected === "function"
      ? injected(options)
      : (injected ?? createHostedTasksClient(options));
  const pending = createPendingTransactions(getVapiPaths().directory);
  const chain =
    dependencies.tasks?.chain ??
    (publicOnly || target === undefined
      ? missingTasksChain
      : lazyTasksChain(
          async () => {
            const { account } = await unlockTarget(target, dependencies);
            return createTasksChain({
              client,
              account,
              trustedFactories: config.tasksEscrowFactoryOverrides,
              trustedDurations: config.tasksEscrowDurationOverrides,
              bindings: createScopeBindings(getVapiPaths().directory),
              rpcFor: createTasksRpcFor(config, {
                env,
                ...(dependencies.fetchImpl === undefined ? {} : { fetch: dependencies.fetchImpl }),
              }),
              pending,
              ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
              ...(dependencies.tasks?.sleep === undefined
                ? {}
                : { sleep: dependencies.tasks.sleep }),
            });
          },
          pending,
          target.address as SignedScopeTerms["self"],
        ));
  return {
    client,
    baseUrl,
    ...(target === undefined ? {} : { target }),
    ...(token === undefined ? {} : { token }),
    chain,
    pending,
    randomUUID: dependencies.tasks?.randomUUID ?? randomUUID,
    signInHint: "Run vapi login for the acting wallet.",
    sleep:
      dependencies.tasks?.sleep ??
      ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))),
  };
}

export async function taskRequest<T>(
  verb: string,
  route: TaskRoute,
  operation: () => Promise<T>,
): Promise<T> {
  return await mapped(() =>
    coreTaskRequest(verb, route, operation, {
      signInHint: "Run vapi login for the acting wallet.",
    }),
  );
}

export function taskOutput(
  io: CliIo,
  json: boolean,
  context: TaskContext,
  verb: string,
  value: object,
  lines: string[],
): void {
  if (json) {
    io.stdout(
      JSON.stringify({
        command: `task ${verb}`,
        ...(context.target === undefined ? {} : { wallet: context.target.name }),
        ...value,
      }),
    );
    return;
  }
  if (context.target)
    io.stdout(
      `Wallet: ${context.target.name}${context.target.address ? ` (${context.target.address})` : ""}`,
    );
  for (const line of lines) io.stdout(line);
}

function signedIn(context: TaskContext): WalletTarget {
  if (!context.token || !context.target)
    throw new TaskCommandError(
      "not_signed_in",
      "Sign-in is needed for the acting wallet. Run vapi login.",
    );
  return context.target;
}

export async function taskCommand(
  argv: string[],
  json: boolean,
  io: CliIo,
  dependencies: CliDependencies,
): Promise<number | undefined> {
  return await mapped(() => taskCommandInner(argv, json, io, dependencies));
}

async function taskCommandInner(
  argv: string[],
  json: boolean,
  io: CliIo,
  dependencies: CliDependencies,
): Promise<number | undefined> {
  const verb = argv[0];
  if (verb === "--help" || verb === "help") {
    if (argv.length !== 1) throw new UsageError("Usage: vapi task --help.");
    io.stdout(json ? JSON.stringify({ command: "task help", help: TASK_HELP }) : TASK_HELP);
    return;
  }
  if (!IMPLEMENTED_VERBS.includes(verb as (typeof IMPLEMENTED_VERBS)[number]))
    throw new UsageError(USAGE);
  const now = dependencies.now?.() ?? new Date();
  const commandArguments = verb === "deliver" ? expandDeliveryFiles(argv.slice(1)) : argv.slice(1);
  const parsed = parseArguments(commandArguments, {
    valueOptions: new Set([
      "--wallet",
      ...(["milestone", "dispute", "counter-evidence", "resolve-unmatched", "sign"].includes(verb!)
        ? ["--index"]
        : []),
      ...(verb === "milestone"
        ? ["--reason", "--proof", "--file", "--files", "--note", "--proof-json"]
        : []),
      ...(verb === "award" ? ["--worker", "--winners"] : []),
      ...(["sign", "dispute"].includes(verb!) ? ["--action", "--to-worker"] : []),
      ...(["dispute", "counter-evidence"].includes(verb!) ? ["--evidence"] : []),
      ...(verb === "claim" ? ["--claimant"] : []),
      ...(verb === "status" ? ["--operation", "--step"] : []),
      ...([
        "sign",
        "fund",
        "deliver",
        "release",
        "refund",
        "dispute",
        "counter-evidence",
        "resolve-unmatched",
        "watch",
      ].includes(verb!)
        ? ["--counterparty"]
        : []),
      ...(verb === "search"
        ? ["--min", "--tab", "--limit"]
        : verb === "post"
          ? [
              "--title",
              "--brief",
              "--amount",
              "--deadline",
              "--intake",
              "--max-awards",
              "--webhook",
              "--shape",
              "--milestone",
              "--proof",
              "--checkin",
              "--winners",
              "--reward-per-winner",
              "--choice-window",
              "--reward-per-claim",
              "--budget",
              "--gate",
              "--verifier",
              "--open-check",
              "--timeout",
            ]
          : verb === "checkin"
            ? ["--status", "--note", "--link"]
            : verb === "propose"
              ? ["--price", "--duration", "--note"]
              : verb === "submit"
                ? ["--proof", "--file", "--proposal-id"]
                : verb === "thread"
                  ? ["--after"]
                  : verb === "deliver"
                    ? ["--files", "--note"]
                    : ["dispute", "counter-evidence"].includes(verb!)
                      ? ["--evidence-hash"]
                      : verb === "watch"
                        ? ["--until", "--timeout", "--interval"]
                        : []),
      ...(["sign", "fund", "deliver", "release"].includes(verb!) ? ["--timeout"] : []),
    ]),
    booleanOptions: new Set([
      ...(verb === "search" ? ["--open"] : []),
      ...(verb === "status" ? ["--abandon", "--recover"] : []),
      ...(verb === "release" ? ["--finalize"] : []),
      ...(["milestone", "cancel", "award", "claim"].includes(verb!) ? ["--yes"] : []),
      ...(verb === "post" ? ["--fund", "--yes", "--no-wait"] : []),
      ...(verb === "submit" ? ["--withdraw"] : []),
      ...(["sign", "fund", "dispute", "counter-evidence"].includes(verb!) ? ["--yes"] : []),
      ...(["sign", "fund", "deliver", "release"].includes(verb!) ? ["--no-wait"] : []),
      ...(verb === "watch" ? ["--auto-release"] : []),
    ]),
    repeatableOptions: new Set([
      ...(["submit", "milestone"].includes(verb!) ? ["--proof", "--file"] : []),
      ...(verb === "milestone" ? ["--files"] : []),
      ...(verb === "deliver" ? ["--files"] : []),
      ...(verb === "post" ? ["--milestone", "--proof"] : []),
    ]),
    maximumPositionals: ["search", "post", "pending"].includes(verb!)
      ? 0
      : ["award", "message", "milestone", "cancel"].includes(verb!)
        ? 2
        : 1,
  });
  const id = ["search", "post", "pending"].includes(verb!)
    ? undefined
    : taskId(parsed.positionals[0]);
  if (id !== undefined) {
    const v2 = await taskV2Command(verb!, id, parsed, json, io, dependencies);
    if (v2 !== null) return v2;
  }
  if (
    [
      "sign",
      "fund",
      "deliver",
      "release",
      "refund",
      "dispute",
      "counter-evidence",
      "resolve-unmatched",
      "watch",
    ].includes(verb!)
  ) {
    return await escrowTaskCommand(verb!, id!, parsed, json, io, dependencies, now);
  }
  if (verb === "search") {
    const tab = parsed.one("--tab");
    if (tab !== undefined && !(TASK_LIMITS.searchTabs as readonly string[]).includes(tab))
      throw new UsageError("--tab must be trending, new, closing or paid.");
    const limit = optionalInteger(parsed.one("--limit"), "--limit");
    const min =
      parsed.one("--min") === undefined ? undefined : usd(parsed.one("--min")!, "--min", true);
    const context = await taskContext(parsed, io, dependencies, true);
    const board = await searchTasks(context, {
      ...(tab === undefined ? {} : { tab: tab as (typeof TASK_LIMITS.searchTabs)[number] }),
      ...(limit === undefined ? {} : { limit }),
      ...(parsed.has("--open") ? { open: true } : {}),
      ...(min === undefined ? {} : { min }),
    });
    const { cards, pinned } = board;
    taskOutput(io, json, context, verb, { ...board, cards, pinned }, [
      ...(pinned ? [`Pinned task: ${pinned.id} · ${pinned.title}`] : []),
      ...cards.map(
        (task) =>
          `${task.id} · ${task.title} · ${task.amount === null ? "amount unavailable" : taskMoney(task.amount.gross, task.amount.feeBp).line} · ${task.state}`,
      ),
      ...(cards.length || pinned ? [] : ["No tasks found."]),
    ]);
    return;
  }
  if (verb === "post") {
    if (parsed.has("--fund") && parseTaskDuration(parsed.one("--timeout") ?? "120s", now) <= 0)
      throw new UsageError("--timeout must be positive.");
    const title = required(parsed, "--title"),
      briefPath = required(parsed, "--brief");
    const prepared = prepareTaskPost(
      {
        shape: enumOption(parsed.one("--shape"), ["task", "bounty", "pool"], "--shape"),
        amountUsd: parsed.one("--amount"),
        deadline: required(parsed, "--deadline"),
        ...(parsed.many("--milestone").length
          ? {
              milestones: parsed
                .many("--milestone")
                .map((value, index) => parseTaskMilestone(value, index + 1, now)),
            }
          : {}),
        ...(parsed.many("--proof").length
          ? { proofSpec: parsed.many("--proof").map(parseTaskProof) }
          : {}),
        checkin: enumOption(
          parsed.one("--checkin"),
          ["none", "6h", "24h", "72h", "7d"],
          "--checkin",
        ),
        winners: optionalInteger(parsed.one("--winners"), "--winners"),
        rewardPerWinner: parsed.one("--reward-per-winner"),
        choiceWindowSeconds: optionalInteger(parsed.one("--choice-window"), "--choice-window"),
        rewardPerClaim: parsed.one("--reward-per-claim"),
        budget: parsed.one("--budget"),
        gate: enumOption(parsed.one("--gate"), ["open", "proven"], "--gate"),
        verifier: enumOption(parsed.one("--verifier"), ["poster", "vapi"], "--verifier"),
        openCheck: enumOption(parsed.one("--open-check"), ["allowlist", "invite"], "--open-check"),
      },
      now,
    );
    const { amount, deadlineAt } = prepared;
    const intake = parsed.one("--intake");
    if (intake !== undefined && !["proposals", "submissions"].includes(intake))
      throw new UsageError("--intake must be proposals or submissions.");
    const maxAwards = optionalInteger(parsed.one("--max-awards"), "--max-awards");
    if (maxAwards !== undefined && maxAwards > TASK_LIMITS.maxAwardsMax)
      throw new UsageError("--max-awards must be between 1 and 50.");
    if (parsed.one("--webhook") !== undefined) httpsUrl(parsed.one("--webhook")!, "--webhook");
    const brief =
      briefPath === "-"
        ? await (dependencies.readStdin ?? readProcessStdin)()
        : await readFile(briefPath, "utf8");
    const input: CreateOrderInput = {
      title: title.trim(),
      description: brief.trim(),
      policyFamily: "general-digital",
      ...(parsed.one("--shape") !== undefined ||
      parsed.many("--milestone").length ||
      parsed.many("--proof").length ||
      parsed.one("--checkin") !== undefined
        ? prepared.terms
        : {}),
    };
    if (!validTaskBrief(input.title, input.description))
      throw new UsageError(
        "--title must be 3 to 120 characters and the brief must be 10 to 8000 characters.",
      );
    const context = await taskContext(parsed, io, dependencies);
    signedIn(context);
    const outcome = await postTask(context, {
      order: input,
      amount,
      deadlineAt,
      ...(parsed.has("--fund") ? { fund: true } : {}),
      ...(intake === undefined ? {} : { intake: intake as "proposals" | "submissions" }),
      ...(maxAwards === undefined ? {} : { maxAwards }),
      ...(parsed.one("--webhook") === undefined ? {} : { webhook: parsed.one("--webhook")! }),
      onFeeUnavailable: () => io.stderr("The deployed fee is unavailable."),
    });
    if (parsed.has("--fund")) {
      if (outcome.funding?.error) {
        taskOutput(
          io,
          json,
          context,
          verb,
          { ...outcome.result, ok: false, funding: outcome.funding, postingMovesMoney: false },
          [
            `Posted task ${outcome.result.workOrder.id}.`,
            `Funding unavailable: ${outcome.funding.error}.`,
          ],
        );
        return 1;
      }
      try {
        const target = signedIn(context);
        const policy = await taskPolicyForWallet({
          directory: getVapiPaths().directory,
          wallet: target.name,
          schema: registeredAgentProfileSchema,
          warn: io.stderr,
        });
        const v2Prepared = taskV2PreparedSchema.safeParse(outcome.funding);
        if (v2Prepared.success && (await taskUsesV2(context, outcome.result.workOrder.id))) {
          const funding = await executeTaskV2(context, {
            id: outcome.result.workOrder.id,
            write: { action: "fund" },
            prepared: v2Prepared.data,
            expectedGrossBaseUnits: prepared.escrowAmount,
            policy,
            caps: await spendCapsForWallet(target.store, target.name),
            wallet: target.name,
            ledgerPath: getVapiPaths().ledger,
            approval: { granted: parsed.has("--yes") },
            onMoney: (money) => {
              io.stderr(money.line);
            },
          });
          taskOutput(
            io,
            json,
            context,
            verb,
            {
              ...outcome.result,
              ...funding,
              funding,
              postingMovesMoney: funding.ok,
            },
            [
              `Posted task ${outcome.result.workOrder.id}.`,
              funding.ok
                ? "Hosted funding confirmed."
                : "Funding requires policy approval or was refused.",
            ],
          );
          return funding.ok ? undefined : "approval" in funding ? 3 : 2;
        }
        const funding = await fundTaskOperation(context, {
          fundingIntent: outcome.funding,
          expectedGrossBaseUnits: prepared.escrowAmount,
          id: outcome.result.workOrder.id,
          policy,
          caps: await spendCapsForWallet(target.store, target.name),
          wallet: target.name,
          ledgerPath: getVapiPaths().ledger,
          now: dependencies.now ?? (() => new Date()),
          approval: { granted: parsed.has("--yes") },
        });
        const wait = funding.ok
          ? await waitForTaskIndex(
              context,
              dependencies,
              parsed,
              json,
              io,
              outcome.result.workOrder.id,
              funding.result,
              "locked",
              "funding",
              parsed.one("--timeout") ?? "120s",
              parseTaskDuration(parsed.one("--timeout") ?? "120s", now),
            )
          : null;
        taskOutput(
          io,
          json,
          context,
          verb,
          { ...outcome.result, ...funding, funding, wait, postingMovesMoney: funding.ok },
          [
            `Posted task ${outcome.result.workOrder.id}.`,
            funding.ok
              ? wait?.reached
                ? "escrow funded"
                : "Funding submitted; waiting for hosted confirmation."
              : `Policy: ${funding.policyDecision}.`,
          ],
        );
        return funding.ok ? undefined : "reason" in funding ? 2 : "approval" in funding ? 3 : 1;
      } catch (error) {
        const mapped = mapTaskError(error);
        const detail = {
          code:
            mapped instanceof TaskCommandError
              ? mapped.code
              : mapped instanceof UsageError
                ? "usage_error"
                : "task_error",
          message: mapped instanceof Error ? mapped.message : "Task funding failed.",
        };
        taskOutput(
          io,
          json,
          context,
          verb,
          { ...outcome.result, ok: false, error: detail, funding: { state: "unknown" } },
          [
            `Posted task ${outcome.result.workOrder.id}.`,
            `Funding did not complete: ${detail.message}`,
            `Check vapi task show ${outcome.result.workOrder.id} before another payment.`,
          ],
        );
        return 1;
      }
    }
    taskOutput(
      io,
      json,
      context,
      verb,
      {
        ...outcome.result,
        money: outcome.money,
        postingMovesMoney: false,
        unsupportedFields: outcome.unsupportedFields,
      },
      [
        `Posted task ${outcome.result.workOrder.id}.`,
        outcome.money.line,
        "Posting a task moves no money.",
      ],
    );
    return;
  }
  if (verb === "propose") {
    const price = usd(required(parsed, "--price"), "--price");
    const duration = parseTaskDuration(required(parsed, "--duration"), now);
    if (
      duration < TASK_LIMITS.proposalDurationMinMs ||
      duration > TASK_LIMITS.proposalDurationMaxMs ||
      duration % TASK_LIMITS.proposalDurationUnitMs !== 0
    )
      throw new UsageError("--duration must be whole seconds between 10 minutes and 90 days.");
    const note = required(parsed, "--note").trim();
    if (!note || note.length > TASK_LIMITS.proposalNoteMax)
      throw new UsageError("--note must be between 1 and 8000 characters.");
    const context = await taskContext(parsed, io, dependencies),
      target = signedIn(context);
    const result = await proposeTask(context, {
      id: id!,
      price,
      durationSeconds: duration / TASK_LIMITS.proposalDurationUnitMs,
      note,
      unlock: async () => {
        const { account } = await unlockTarget(target, dependencies);
        return {
          address: account.address,
          signMessage: (message) => account.signMessage({ message }),
        };
      },
    });
    taskOutput(io, json, context, verb, result, [`Proposed terms for task ${id}.`]);
    return;
  }
  if (verb === "submit") {
    const urls = parsed.many("--proof");
    if (parsed.one("--proposal-id") && !parsed.has("--withdraw"))
      throw new UsageError("--proposal-id requires --withdraw.");
    if (parsed.has("--withdraw") && (urls.length || parsed.many("--file").length))
      throw new UsageError("--withdraw cannot be combined with proof or files.");
    if (!parsed.has("--withdraw") && !urls.length)
      throw new UsageError("submit needs at least one --proof <https-url>.");
    const proof: SubmissionProof[] = urls.map((url) => {
      httpsUrl(url, "--proof");
      return { kind: "url", value: url };
    });
    // Check every local file before starting any uploads.
    const files = await Promise.all(parsed.many("--file").map(readTaskFile));
    const context = await taskContext(parsed, io, dependencies),
      target = signedIn(context);
    const result = await submitTask(context, {
      id: id!,
      ...(parsed.has("--withdraw")
        ? { withdraw: true, ...(target.address ? { address: target.address } : {}) }
        : {}),
      ...(parsed.one("--proposal-id")
        ? { proposalId: taskId(parsed.one("--proposal-id"), "proposalId") }
        : {}),
      proof,
      files,
      unlock: async () => {
        const { account } = await unlockTarget(target, dependencies);
        return {
          address: account.address,
          signMessage: (message) => account.signMessage({ message }),
        };
      },
    });
    taskOutput(io, json, context, verb, result, [
      parsed.has("--withdraw")
        ? `Withdrew submission for task ${id}.`
        : `Submitted proof for task ${id}.`,
    ]);
    return;
  }
  if (verb === "pending" || verb === "checkin") {
    const context = await taskContext(parsed, io, dependencies);
    signedIn(context);
    if (verb === "pending") {
      const result = await taskRequest(verb, "pending", () =>
        requireTaskMethod(context.client, "pending")(),
      );
      taskOutput(
        io,
        json,
        context,
        verb,
        result,
        result.pendingActions.length
          ? result.pendingActions.map(
              (item) =>
                `${item.title} · ${item.action} · ${item.amountBaseUnits ? `$${formatBaseUnitsUsd(item.amountBaseUnits)} USDC` : "amount unavailable"} · due ${item.dueAt ?? "unspecified"} · ${new URL(item.deepLink, context.baseUrl).href}`,
            )
          : ["No pending actions."],
      );
    } else {
      const status = required(parsed, "--status");
      const input = checkinInputSchema.safeParse({
        status,
        note: parsed.one("--note") ?? status.replaceAll("-", " "),
        ...(parsed.one("--link") ? { link: parsed.one("--link") } : {}),
      });
      if (!input.success) throw new UsageError(input.error.issues[0]!.message);
      const result = await taskRequest(verb, "checkin", () =>
        requireTaskMethod(context.client, "checkin")(id!, input.data, {
          idempotencyKey: context.randomUUID(),
        }),
      );
      taskOutput(io, json, context, verb, result, [`Check-in recorded: ${status}.`]);
    }
    return;
  }
  let proposalId: string | undefined, body: string | undefined, cursor: number | undefined;
  if (verb === "award") proposalId = taskId(parsed.positionals[1], "proposalId");
  if (verb === "message") {
    body = parsed.positionals[1]?.trim();
    if (!body || Array.from(body).length > TASK_LIMITS.messageMax)
      throw new UsageError("message needs text between 1 and 10000 characters.");
  }
  if (verb === "thread") cursor = optionalInteger(parsed.one("--after"), "--after");
  const context = await taskContext(parsed, io, dependencies);
  if (verb === "show" || verb === "status") {
    if (verb === "show" && context.token) {
      const result = await showTask(context, { id: id!, signedIn: true });
      const receipts = result.receipts;
      taskOutput(io, json, context, verb, { ...result, receipts, ...(receipts[0] ?? {}) }, [
        `${result.workOrder.title} · ${result.lifecycle?.state ?? result.workOrder.state}${result.lifecycle?.substate ? ` / ${result.lifecycle.substate}` : ""}`,
        ...taskDetailLines(result.lifecycle, result.nextAction, result.workOrder.terms),
        ...receipts.map((receipt) => `Receipt (from escrow): ${receipt.receiptUrl}`),
      ]);
    } else {
      const result =
        verb === "status"
          ? await taskStatus(context, { id: id!, signedIn: Boolean(context.token) })
          : await showTask(context, { id: id!, signedIn: false });
      if ("chainState" in result) {
        const milestoneLines = result.chainState.milestones.map((milestone) => {
          const ordinal =
            "ordinal" in milestone &&
            typeof milestone.ordinal === "number" &&
            Number.isFinite(milestone.ordinal)
              ? milestone.ordinal
              : milestone.milestoneId;
          const state = "state" in milestone.read ? ` ${milestone.read.state}` : "";
          const explorer = milestone.explorerUrl ? ` ${milestone.explorerUrl}` : "";
          return `milestone ${ordinal}: ${milestone.read.status}${state}${explorer}`;
        });
        const eventLines = (result.events ?? []).slice(-10).map((event) => {
          const createdAt =
            "createdAt" in event && typeof event.createdAt === "string"
              ? event.createdAt
              : event.at;
          return `${event.sequence} ${event.type} ${createdAt}`;
        });
        taskOutput(io, json, context, verb, result, [...milestoneLines, ...eventLines]);
        return;
      }
      const task = result.task;
      taskOutput(
        io,
        json,
        context,
        verb,
        {
          task,
          lifecycle: result.lifecycle,
          nextAction: result.nextAction,
          ...(task.receiptUrl ? { receiptUrl: task.receiptUrl, receiptUrlSource: "server" } : {}),
        },
        [
          `${task.title} · ${result.lifecycle?.state ?? task.state}`,
          ...taskDetailLines(result.lifecycle, result.nextAction, task.terms),
          ...(task.receiptUrl ? [`Receipt (from server): ${task.receiptUrl}`] : []),
        ],
      );
    }
    return;
  }
  signedIn(context);
  if (verb === "award") {
    const result = await awardTask(context, { id: id!, proposalId: proposalId! });
    taskOutput(io, json, context, verb, result, [`Awarded proposal ${proposalId} for task ${id}.`]);
  } else if (verb === "message") {
    const result = await messageTask(context, { id: id!, body: body! });
    taskOutput(io, json, context, verb, result, [`Message sent for task ${id}.`]);
  } else if (verb === "thread") {
    const result = await threadTask(context, {
      id: id!,
      ...(cursor === undefined ? {} : { cursor }),
    });
    taskOutput(
      io,
      json,
      context,
      verb,
      result,
      result.messages.length
        ? result.messages.map((message) => `${message.seq}: ${message.body}`)
        : ["No messages yet."],
    );
  }
}

async function escrowTaskCommand(
  verb: string,
  id: string,
  parsed: Parsed,
  json: boolean,
  io: CliIo,
  dependencies: CliDependencies,
  now: Date,
): Promise<number | undefined> {
  taskCounterparty(parsed);
  if (verb === "watch") return await watchTask(id, parsed, json, io, dependencies, now);
  const waitsForIndex = ["sign", "fund", "deliver", "release"].includes(verb);
  const waitTimeoutText = parsed.one("--timeout") ?? "120s";
  const waitTimeoutMs = waitsForIndex ? parseTaskDuration(waitTimeoutText, now) : undefined;
  if (waitTimeoutMs !== undefined && waitTimeoutMs <= 0)
    throw new UsageError("--timeout must be positive.");
  const disputeEvidenceHash = ["dispute", "counter-evidence"].includes(verb)
    ? required(parsed, "--evidence-hash")
    : undefined;
  const counterparty = taskCounterparty(parsed);
  if (
    disputeEvidenceHash !== undefined &&
    !TASK_LIMITS.disputeEvidenceHash.test(disputeEvidenceHash)
  )
    throw new UsageError("--evidence-hash must be 0x followed by 64 hexadecimal characters.");
  let delivery:
    | {
        files: Array<{
          name: string;
          bytes: Uint8Array;
          contentType: UploadFileInput["contentType"];
        }>;
        note: string;
      }
    | undefined;
  if (verb === "deliver") {
    const paths = parsed.many("--files");
    if (paths.length < TASK_LIMITS.deliveryFilesMin || paths.length > TASK_LIMITS.deliveryFilesMax)
      throw new UsageError("--files needs between one and twenty delivery files.");
    const note = required(parsed, "--note");
    if (!note.trim() || note.length > TASK_LIMITS.deliveryNoteMax)
      throw new UsageError("--note must be nonblank and at most 32000 characters.");
    const files = (await Promise.all(paths.map(readTaskFile))).map(
      ({ fileName: name, bytes, contentType }) => ({ name, bytes, contentType }),
    );
    delivery = { files, note };
  }
  const context = await taskContext(parsed, io, dependencies);
  const target = signedIn(context);

  if (verb === "sign") {
    const displayContext = { ...context };
    delete displayContext.target;
    try {
      const result = await signTaskScope(context, {
        id,
        ...(counterparty === undefined ? {} : { counterparty }),
        ...(target.address === undefined ? {} : { signerAddress: target.address as `0x${string}` }),
        bindings: createScopeBindings(getVapiPaths().directory),
        onTerms: async (terms) => {
          if (!json) {
            const amount = await scopeTermsAmount(context.client, terms);
            io.stdout("Scope confirmation:");
            io.stdout(
              terms.role === "client"
                ? `You are the poster: you will fund ${amount} into escrow for worker ${terms.counterparty}`
                : `You are the worker: you will deliver to poster ${terms.counterparty} and be paid ${amount}`,
            );
            io.stdout(`Deadline: ${terms.deadline}`);
            io.stdout(`Local signer: ${terms.self}`);
          }
          if (parsed.has("--yes")) return;
          if (!taskInteractive(json, dependencies)) throw new ScopeApprovalNeeded(terms);
          const answer = (await getLinePrompt(dependencies)("Sign this scope? [y/N] "))
            .trim()
            .toLowerCase();
          if (answer !== "y" && answer !== "yes")
            throw new TaskCommandError("not_approved", "Not approved; nothing was signed.");
        },
        signMessage: async (message) => {
          const { account } = await unlockTarget(target, dependencies);
          return await account.signMessage({ message });
        },
      });
      if (!json && result.escrowCreation?.resumedFromServer)
        io.stdout("The server had already prepared escrow creation; resumed from it.");
      const wait = result.escrowCreation
        ? await waitForTaskIndex(
            context,
            dependencies,
            parsed,
            json,
            io,
            id,
            result.escrowCreation,
            "created",
            "escrow creation",
            waitTimeoutText,
            waitTimeoutMs!,
          )
        : null;
      taskOutput(io, json, displayContext, verb, { ...result, wait }, [
        `Accepted scope for task ${id}.`,
        ...(result.escrowCreation && (wait === null || wait.reached) ? ["escrow created"] : []),
      ]);
      return;
    } catch (error) {
      if (error instanceof ScopeApprovalNeeded) {
        taskOutput(
          io,
          json,
          context,
          verb,
          { ok: false, approval: true, reason: "approval_needed", terms: error.terms },
          ["Approval is needed before signing this scope."],
        );
        return 3;
      }
      if (!(error instanceof TasksScopeCreationError)) throw error;
      taskOutput(io, json, displayContext, verb, error.acceptance, [
        `Accepted scope for task ${id}.`,
      ]);
      return await taskRequest(verb, "createEscrow", async () => {
        throw error.cause;
      });
    }
  }

  if (verb === "deliver") {
    const outcome = await deliverTaskOperation(context, {
      id,
      ...delivery!,
      ...(counterparty === undefined ? {} : { counterparty }),
      onPrepared: (manifestHash) => {
        if (!json)
          taskOutput(io, false, context, verb, {}, [`Prepared delivery manifest ${manifestHash}.`]);
      },
    });
    const wait = await waitForTaskIndex(
      context,
      dependencies,
      parsed,
      json,
      io,
      id,
      outcome.result,
      "delivered",
      "delivery",
      waitTimeoutText,
      waitTimeoutMs!,
    );
    taskOutput(io, json, context, verb, { ...outcome, wait }, [
      ...(wait === null || wait.reached ? ["delivery recorded"] : []),
      ...(outcome.result.resumedFromServer === true
        ? ["The server had already recorded this delivery; resumed from it."]
        : []),
    ]);
    return;
  }

  const snapshot = await taskMoneySnapshot(context.client, id, undefined, {
    signInHint: context.signInHint,
  });
  if (!json) io.stdout(snapshot.money.line);

  if (["fund", "dispute", "counter-evidence"].includes(verb)) {
    const policy = await taskPolicyForWallet({
      directory: getVapiPaths().directory,
      wallet: target.name,
      schema: registeredAgentProfileSchema,
      warn: io.stderr,
    });
    const caps = await spendCapsForWallet(target.store, target.name);
    const interactive = taskInteractive(json, dependencies);
    const approval = parsed.has("--yes")
      ? ({ granted: true } as const)
      : interactive
        ? {
            ask: async ({ money }: { money: TaskMoney }) => {
              io.stdout("Policy: approval needed.");
              const answer = (
                await getLinePrompt(dependencies)(
                  `${verb === "fund" ? money.line : `dispute fee $${money.gross.usd} USDC`}. Approve ${verb === "fund" ? "funding" : "dispute fee"}? [y/N] `,
                )
              )
                .trim()
                .toLowerCase();
              return answer === "y" || answer === "yes";
            },
          }
        : ({ granted: false } as const);
    const common = {
      id,
      snapshot,
      policy,
      caps,
      wallet: target.name,
      ledgerPath: getVapiPaths().ledger,
      now: dependencies.now ?? (() => new Date()),
      approval,
      ...(counterparty === undefined ? {} : { counterparty }),
    };
    if (verb === "fund") {
      const payment = await fundTaskWithX402(context, {
        ...common,
        config: await loadConfig(getVapiPaths().config, getEnvironment(dependencies)),
        unlock: async () => (await unlockTarget(target, dependencies)).account,
        ...(dependencies.fetchImpl ? { fetchImpl: dependencies.fetchImpl } : {}),
      });
      if (payment) {
        const wait =
          payment.ok && !parsed.has("--no-wait")
            ? await waitForMilestone(context.client, {
                orderId: id,
                milestoneId: payment.milestoneId,
                target: "locked",
                timeoutMs: waitTimeoutMs!,
                sleep: context.sleep,
                now: dependencies.now ?? (() => new Date()),
              })
            : null;
        taskOutput(io, json, context, verb, { ...payment, wait }, [
          payment.ok
            ? wait?.reached
              ? "escrow funded"
              : `Payment submitted; waiting for hosted confirmation. Run vapi task show ${id}.`
            : "approval" in payment
              ? "Policy: approval needed."
              : "Policy: refused.",
        ]);
        return payment.ok ? undefined : "reason" in payment ? 2 : "approval" in payment ? 3 : 1;
      }
    }
    const outcome =
      verb === "fund"
        ? await fundTaskOperation(context, {
            ...common,
            idempotencyKey: context.randomUUID,
            beforeChainFund: () => {
              if (!json) io.stdout("Policy: approved.");
            },
          })
        : await (verb === "dispute" ? disputeTaskOperation : counterEvidenceTaskOperation)(
            context,
            {
              ...common,
              evidenceHash: disputeEvidenceHash!,
              onFee: (fee) => {
                if (!json) io.stdout(`dispute fee $${formatBaseUnitsUsd(fee)} USDC`);
              },
            },
          );
    if (!outcome.ok && "reason" in outcome) {
      if (json) taskOutput(io, true, context, verb, outcome, []);
      else io.stderr(`Policy: refused (${outcome.reason}).`);
      return 2;
    }
    if (!outcome.ok && "approval" in outcome) {
      taskOutput(io, json, context, verb, outcome, ["Policy: approval needed."]);
      return 3;
    }
    if (!outcome.ok && "declined" in outcome)
      throw new TaskCommandError("not_approved", "Not approved; nothing was signed.");
    if (!json && outcome.result.resumedFromServer)
      io.stdout("The server had already prepared this task operation; resumed from it.");
    const wait =
      verb === "fund"
        ? await waitForTaskIndex(
            context,
            dependencies,
            parsed,
            json,
            io,
            id,
            outcome.result,
            "locked",
            "funding",
            waitTimeoutText,
            waitTimeoutMs!,
          )
        : undefined;
    taskOutput(
      io,
      json,
      context,
      verb,
      wait === undefined ? outcome : { ...outcome, wait },
      verb === "fund"
        ? wait?.reached
          ? ["escrow funded"]
          : []
        : [`Completed task ${verb} for ${id}.`],
    );
    return;
  }

  if (!json) io.stdout("Policy: explicit user instruction.");
  const settlementInput = { id, snapshot, ...(counterparty === undefined ? {} : { counterparty }) };
  const result =
    verb === "release"
      ? await releaseTaskOperation(context, settlementInput)
      : verb === "refund"
        ? await refundTaskOperation(context, settlementInput)
        : await resolveUnmatchedTaskOperation(context, settlementInput);
  if (!json && result.result.resumedFromServer)
    io.stdout("The server had already prepared this task operation; resumed from it.");
  const wait =
    verb === "release"
      ? await waitForTaskIndex(
          context,
          dependencies,
          parsed,
          json,
          io,
          id,
          result.result,
          "released",
          "release",
          waitTimeoutText,
          waitTimeoutMs!,
        )
      : undefined;
  taskOutput(
    io,
    json,
    context,
    verb,
    wait === undefined ? result : { ...result, wait },
    verb === "release"
      ? wait === null || wait?.reached
        ? ["funds released"]
        : []
      : [`Completed task ${verb} for ${id}.`],
  );
}

async function waitForTaskIndex(
  context: TaskContext,
  dependencies: CliDependencies,
  parsed: Parsed,
  json: boolean,
  io: CliIo,
  orderId: string,
  result: { blockNumber?: string; milestone: { id: string } },
  target: "created" | "locked" | "delivered" | "released",
  description: "escrow creation" | "funding" | "delivery" | "release",
  timeoutText: string,
  timeoutMs: number,
) {
  if (parsed.has("--no-wait")) return null;
  if (!json)
    io.stdout(
      `confirmed on chain${result.blockNumber === undefined ? "" : ` in block ${result.blockNumber}`}, waiting for vAPI to index…`,
    );
  const wait = await taskRequest(description, "getOrder", () =>
    waitForMilestone(context.client, {
      orderId,
      milestoneId: result.milestone.id,
      target,
      timeoutMs,
      intervalMs: 3_000,
      sleep: context.sleep,
      now: dependencies.now ?? (() => new Date()),
    }),
  );
  if (!wait.reached)
    io.stderr(
      `vAPI has not indexed the ${description} yet after ${timeoutText}; run vapi task status ${orderId} later.`,
    );
  return wait;
}

class ScopeApprovalNeeded extends Error {
  constructor(readonly terms: SignedScopeTerms) {
    super("Approval is needed before signing this scope.");
    this.name = "ScopeApprovalNeeded";
  }
}

async function scopeTermsAmount(client: TasksClient, terms: SignedScopeTerms): Promise<string> {
  const token = terms.asset.split("/erc20:")[1];
  const canonical = getCanonicalX402Usdc(terms.network);
  let isUsdc =
    token !== undefined &&
    canonical !== undefined &&
    token.toLowerCase() === canonical.usdc.toLowerCase();
  if (!isUsdc && token !== undefined) {
    try {
      const deployment = await client.deployment();
      isUsdc =
        deployment.configured &&
        deployment.network === terms.network &&
        deployment.usdc.toLowerCase() === token.toLowerCase();
    } catch {
      // A failed display-only token lookup leaves the amount in base units.
    }
  }
  return isUsdc
    ? `$${formatBaseUnitsUsd(terms.amountBaseUnits)} USDC`
    : `${terms.amountBaseUnits} base units (${terms.asset})`;
}

function taskInteractive(json: boolean, dependencies: CliDependencies): boolean {
  return (
    !json &&
    getEnvironment(dependencies).CI === undefined &&
    (dependencies.interactive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY))
  );
}

async function watchTask(
  id: string,
  parsed: Parsed,
  json: boolean,
  io: CliIo,
  dependencies: CliDependencies,
  now: Date,
): Promise<number | undefined> {
  const interval = parseTaskDuration(parsed.one("--interval") ?? "5s", now);
  if (interval < TASK_LIMITS.watchIntervalMinMs)
    throw new UsageError("--interval must be at least 1s.");
  const timeout = parseTaskDuration(parsed.one("--timeout") ?? "7d", now);
  const until = parsed.one("--until");
  const states = new Set<string>(TASK_WATCH_STATES);
  if (until !== undefined && !states.has(until))
    throw new UsageError(`--until must be one of ${[...states].join(", ")}.`);
  const context = await taskContext(parsed, io, dependencies);
  const target = signedIn(context);
  const autoRelease = parsed.has("--auto-release");
  const policy = autoRelease
    ? await taskPolicyForWallet({
        directory: getVapiPaths().directory,
        wallet: target.name,
        schema: registeredAgentProfileSchema,
        warn: io.stderr,
      })
    : undefined;
  const interactive = taskInteractive(json, dependencies);
  const clock = dependencies.now ?? (() => new Date());
  const deadline = now.getTime() + timeout;
  let cursor = 0;
  const released = new Set<string>();
  for (;;) {
    if (clock().getTime() >= deadline)
      throw new TaskCommandError(
        "timeout",
        `Task watch timed out after ${parsed.one("--timeout") ?? "7d"}.`,
      );
    const page = await taskRequest("watch", "events", () =>
      context.client.events(id, { after: cursor, wait: 0 }),
    );
    if (clock().getTime() >= deadline)
      throw new TaskCommandError(
        "timeout",
        `Task watch timed out after ${parsed.one("--timeout") ?? "7d"}.`,
      );
    nextTaskEvents({ ...page, events: [] }, cursor);
    const events = [...page.events].sort((left, right) => left.sequence - right.sequence);
    for (const rawEvent of events) {
      // Validate one event at a time so earlier output and --until still precede later bad events.
      const eventPage = nextTaskEvents(
        { ...page, events: [rawEvent], nextAfter: Math.max(cursor, page.nextAfter) },
        cursor,
      );
      if (!eventPage.events.length) continue;
      const event = eventPage.events[0]!;
      taskOutput(io, json, context, "watch", { event }, [taskEventLine(event)]);
      const state = taskEventState(event);
      if (autoRelease && state === "delivered") {
        const milestoneId =
          typeof event.payload.milestoneId === "string" ? event.payload.milestoneId : undefined;
        const snapshot = await taskMoneySnapshot(context.client, id, milestoneId, {
          signInHint: context.signInHint,
        });
        if (clock().getTime() >= deadline)
          throw new TaskCommandError(
            "timeout",
            `Task watch timed out after ${parsed.one("--timeout") ?? "7d"}.`,
          );
        if (snapshot.order.workOrder.version !== "work-order-view-v1")
          throw new TaskCommandError("invalid_response", "A private task order is required.");
        const currentMilestone = snapshot.order.workOrder.milestones.find(
          (milestone) => milestone.id === snapshot.escrowId,
        );
        const releasable =
          currentMilestone?.state === "delivered" && currentMilestone.escrowState === "submitted";
        if (releasable && !released.has(snapshot.escrowId)) {
          released.add(snapshot.escrowId);
          const decision = autoReleaseDecision({
            amountUsd: Number(snapshot.money.gross.usd),
            autoReleaseBelowUsd: policy!.autoReleaseBelowUsd,
          });
          taskOutput(
            io,
            json,
            context,
            "watch",
            { money: snapshot.money, decision, policySource: policy!.source },
            [
              snapshot.money.line,
              "auto" in decision ? "Policy: approved." : "Policy: approval needed.",
            ],
          );
          if ("approval" in decision) {
            if (!interactive) {
              taskOutput(
                io,
                json,
                context,
                "watch",
                { ok: false, approval: true, money: snapshot.money, policySource: policy!.source },
                ["Approval is needed before release."],
              );
              return 3;
            }
            const answer = (
              await getLinePrompt(dependencies)(`${snapshot.money.line}. Approve release? [y/N] `)
            )
              .trim()
              .toLowerCase();
            if (answer !== "y" && answer !== "yes")
              throw new TaskCommandError("not_approved", "Not approved; nothing was signed.");
          }
          if (clock().getTime() >= deadline)
            throw new TaskCommandError(
              "timeout",
              `Task watch timed out after ${parsed.one("--timeout") ?? "7d"}.`,
            );
          const client = cachedMoneyClient(context.client, snapshot);
          const releasedResult = await taskRequest("watch", "releaseEscrow", () =>
            releaseTask({
              client,
              chain: context.chain,
              orderId: id,
              escrowId: snapshot.escrowId,
              ...(taskCounterparty(parsed) === undefined
                ? {}
                : { counterparty: taskCounterparty(parsed)! }),
              idempotencyKey: context.randomUUID,
            }),
          );
          taskOutput(
            io,
            json,
            context,
            "watch",
            { ok: true, step: "released", ...releasedResult },
            [`Released task milestone ${snapshot.escrowId}.`],
          );
        }
      }
      cursor = Math.max(cursor, event.sequence);
      if (until !== undefined && taskStateMatches(until, state)) {
        taskOutput(io, json, context, "watch", { ok: true, until, cursor }, [
          `Task reached ${until}.`,
        ]);
        return;
      }
    }
    cursor = Math.max(cursor, page.nextAfter, ...events.map((event) => event.sequence));
    const remaining = deadline - clock().getTime();
    if (remaining <= 0)
      throw new TaskCommandError(
        "timeout",
        `Task watch timed out after ${parsed.one("--timeout") ?? "7d"}.`,
      );
    await context.sleep(Math.min(interval, remaining));
  }
}

function expandDeliveryFiles(argv: string[]): string[] {
  const expanded: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument !== "--files") {
      expanded.push(argument);
      continue;
    }
    expanded.push(argument);
    if (index + 1 < argv.length) expanded.push(argv[++index]!);
    while (index + 1 < argv.length && !argv[index + 1]!.startsWith("--")) {
      expanded.push("--files", argv[++index]!);
    }
  }
  return expanded;
}

function required(parsed: Parsed, option: string): string {
  const value = parsed.one(option);
  if (!value) throw new UsageError(`Missing ${option}. Run vapi task --help.`);
  return value;
}
function taskId(value: string | undefined, name = "id"): string {
  if (!value) throw new UsageError(`Missing <${name}>. Run vapi task --help.`);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value))
    throw new UsageError(`<${name}> must be a UUID.`);
  return value.toLowerCase();
}
function usd(value: string, option: string, allowZero = false): bigint {
  let amount: bigint;
  try {
    amount = parseUsdToBaseUnits(value);
  } catch {
    throw new UsageError(`${option} must be a decimal USD amount with at most six decimal places.`);
  }
  if ((!allowZero && amount === 0n) || amount >= 1n << 256n)
    throw new UsageError(`${option} must be positive and fit an escrow amount.`);
  return amount;
}
function optionalInteger(value: string | undefined, option: string): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/u.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) <= 0)
    throw new UsageError(`${option} must be a positive integer.`);
  return Number(value);
}
function httpsUrl(value: string, option: string): void {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) throw new Error();
  } catch {
    throw new UsageError(`${option} must be an HTTPS URL without credentials.`);
  }
}
export async function readTaskFile(path: string): Promise<UploadFileInput> {
  try {
    return await readCoreTaskFile(path);
  } catch (error) {
    throw mapTaskError(error);
  }
}
async function readProcessStdin(): Promise<string> {
  process.stdin.setEncoding("utf8");
  let input = "";
  for await (const chunk of process.stdin) input += String(chunk);
  return input;
}

function taskCounterparty(parsed: Parsed): string | undefined {
  const value = parsed.one("--counterparty");
  if (value !== undefined && !/^0x[0-9a-fA-F]{40}$/u.test(value))
    throw new UsageError("--counterparty must be 0x followed by 40 hexadecimal characters.");
  return value?.toLowerCase();
}

function enumOption<const T extends string>(
  value: string | undefined,
  options: readonly T[],
  flag: string,
): T | undefined {
  if (value === undefined) return undefined;
  if (!options.includes(value as T)) throw new UsageError(`${flag} must be ${options.join("|")}.`);
  return value as T;
}
function taskDetailLines(
  lifecycle: import("@vapi-network/core/tasks").TaskLifecycle | null | undefined,
  nextAction: import("@vapi-network/core/tasks").TaskNextAction | undefined,
  terms: import("@vapi-network/core/tasks").TaskTerms | undefined,
): string[] {
  const milestones = terms?.milestones;
  return [
    ...(milestones?.length
      ? [
          "Milestone | Amount (USDC) | Acceptance | Deadline | State",
          ...milestones.map(
            (item) =>
              `${item.index} | ${formatBaseUnitsUsd(item.amountBaseUnits)} | ${item.acceptance} | ${item.deadlineAt} | ${lifecycle?.shape === "task" ? (lifecycle.milestones[item.index - 1]?.status ?? "pending") : "pending"}`,
          ),
        ]
      : []),
    `Next action: ${nextAction?.action ?? "none"}${nextAction?.dueAt ? ` · due ${nextAction.dueAt}` : ""}`,
  ];
}
