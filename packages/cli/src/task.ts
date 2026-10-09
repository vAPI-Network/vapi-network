import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import {
  createPublicFetch,
  getVapiPaths,
  KeystoreError,
  loadConfig,
  spendCapsForWallet,
} from "@vapi-network/core";
import {
  autoReleaseDecision,
  awardTask,
  cachedMoneyClient,
  createTasksClient,
  deliverTaskOperation,
  disputeTaskOperation,
  fundTaskOperation,
  messageTask,
  missingTasksChain,
  nextTaskEvents,
  parseTaskDuration as parseCoreTaskDuration,
  parseUsdToBaseUnits,
  postTask,
  proposeTask,
  publicNotFoundFetch,
  readTaskFile as readCoreTaskFile,
  refundTaskOperation,
  releaseTask,
  releaseTaskOperation,
  resolveTaskBearer,
  searchTasks,
  showTask,
  signTaskScope,
  submitTask,
  taskEventState,
  taskMoney,
  taskMoneySnapshot,
  taskPolicyForWallet,
  taskRequest as coreTaskRequest,
  taskStateMatches,
  taskStatus,
  threadTask,
  TASK_LIMITS,
  TASK_WATCH_STATES,
  TASKS_CLIENT_VERBS,
  TaskInputError,
  TaskOperationError,
  TasksScopeCreationError,
  type TasksChain,
  type TasksClient,
  type TasksClientOptions,
  type SubmissionProof,
  type UploadFileInput,
  type CreateOrderInput,
  type TaskMoney,
  validTaskBrief,
} from "@vapi-network/core/tasks";
import { registeredAgentProfileSchema } from "@vapi-network/mcp";
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

export type TasksCommandDependencies = {
  client?: TasksClient | ((options: TasksClientOptions) => TasksClient);
  chain?: TasksChain;
  sleep?: (milliseconds: number) => Promise<void>;
  randomUUID?: () => string;
};

export const TASK_HELP = `Usage:
  vapi task search [--open] [--min <usd>] [--tab trending|new|closing|paid] [--limit <n>] [--json]
  vapi task show <id> [--account <name>] [--json]
  vapi task post --title <text> --brief <file|-> --amount <usd> --deadline <duration|ISO> [--intake proposals|submissions] [--max-awards <k>] [--webhook <https-url>] [--account <name>] [--json]
  vapi task propose <id> --price <usd> --duration <duration> --note <text> [--account <name>] [--json]
  vapi task submit <id> --proof <https-url> [--proof <https-url>...] [--file <path>...] [--account <name>] [--json]
  vapi task award <id> <proposalId> [--account <name>] [--json]
  vapi task sign <id> [--account <name>] [--json]
  vapi task fund <id> [--yes] [--account <name>] [--json]
  vapi task deliver <id> --files <path...> --note <text> [--account <name>] [--json]
  vapi task release <id> [--account <name>] [--json]
  vapi task refund <id> [--account <name>] [--json]
  vapi task dispute <id> --evidence-hash <0x + 64 hex> [--account <name>] [--json]
  vapi task message <id> <text> [--account <name>] [--json]
  vapi task thread <id> [--after <cursor>] [--account <name>] [--json]
  vapi task watch <id> [--until <state>] [--auto-release] [--timeout 7d] [--interval 5s] [--account <name>] [--json]
  vapi task status <id> [--account <name>] [--json]

Durations: 5s, 10m, 48h, 7d, or an ISO-8601 timestamp. Posting and proposal terms require at least 10 minutes.
Dispute accepts a precomputed evidence hash only; evidence-file hashing is still undecided upstream.
Watch requires an interval of at least 1s and a positive timeout. Auto-release uses the acting wallet's agent profile, or defaults, and releases only amounts strictly below the threshold.
Posting a task moves no money. Task reads require tasks:read and writes require tasks:write; write access includes reads.
The thread cursor is the previous page's nextBeforeSeq; --after reads older messages using beforeSeq.
Every command accepts --json. Watch and a partially completed sign may write more than one JSON value. Human diagnostics go to stderr.

Exit codes:
  0  ok
  1  error, including invalid usage, unavailable routes and 'chain operations need C2'
  2  policy refusal only (JSON ok:false with reason policy.perTask or policy.perDay)
  3  approval needed in non-interactive mode

Fund, deliver, release, refund, dispute and watch auto-release need the chain adapter, which is not in this release. The CLI never retries a chain mutation automatically.`;

const IMPLEMENTED_VERBS = TASKS_CLIENT_VERBS;
const USAGE = `Usage: vapi task <${IMPLEMENTED_VERBS.join("|")}>. Run vapi task --help.`;
type Parsed = ReturnType<typeof parseArguments>;
type TaskRoute = keyof TasksClient;

export class TaskCommandError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly manifestHash?: `0x${string}`,
  ) {
    super(message);
    this.name = "TaskCommandError";
  }
}

function mapTaskError(error: unknown): unknown {
  if (error instanceof TaskInputError) return new UsageError(error.message);
  if (error instanceof TaskOperationError)
    return new TaskCommandError(error.code, error.message, error.manifestHash);
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
  baseUrl: string;
  target?: WalletTarget;
  token?: string;
  randomUUID: () => string;
  sleep: (milliseconds: number) => Promise<void>;
  signInHint: string;
};

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
  return {
    client:
      typeof injected === "function" ? injected(options) : (injected ?? createTasksClient(options)),
    baseUrl,
    ...(target === undefined ? {} : { target }),
    ...(token === undefined ? {} : { token }),
    chain: dependencies.tasks?.chain ?? missingTasksChain,
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
            ]
          : verb === "propose"
            ? ["--price", "--duration", "--note"]
            : verb === "submit"
              ? ["--proof", "--file"]
              : verb === "thread"
                ? ["--after"]
                : verb === "deliver"
                  ? ["--files", "--note"]
                  : verb === "dispute"
                    ? ["--evidence-hash"]
                    : verb === "watch"
                      ? ["--until", "--timeout", "--interval"]
                      : []),
    ]),
    booleanOptions: new Set([
      ...(verb === "search" ? ["--open"] : []),
      ...(verb === "fund" ? ["--yes"] : []),
      ...(verb === "watch" ? ["--auto-release"] : []),
    ]),
    repeatableOptions: new Set([
      ...(verb === "submit" ? ["--proof", "--file"] : []),
      ...(verb === "deliver" ? ["--files"] : []),
    ]),
    maximumPositionals: ["search", "post"].includes(verb!)
      ? 0
      : ["award", "message"].includes(verb!)
        ? 2
        : 1,
  });
  const id = ["search", "post"].includes(verb!) ? undefined : taskId(parsed.positionals[0]);
  if (["sign", "fund", "deliver", "release", "refund", "dispute", "watch"].includes(verb!)) {
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
    const title = required(parsed, "--title"),
      briefPath = required(parsed, "--brief");
    const amount = usd(required(parsed, "--amount"), "--amount");
    const duration = parseTaskDuration(required(parsed, "--deadline"), now);
    if (duration < TASK_LIMITS.postDeadlineMinMs)
      throw new UsageError("--deadline must be at least 10 minutes from now.");
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
      deadlineAt: new Date(now.getTime() + duration).toISOString(),
      ...(intake === undefined ? {} : { intake: intake as "proposals" | "submissions" }),
      ...(maxAwards === undefined ? {} : { maxAwards }),
      ...(parsed.one("--webhook") === undefined ? {} : { webhook: parsed.one("--webhook")! }),
      onFeeUnavailable: () => io.stderr("The deployed fee is unavailable."),
    });
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
    if (!urls.length) throw new UsageError("submit needs at least one --proof <https-url>.");
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
    taskOutput(io, json, context, verb, result, [`Submitted proof for task ${id}.`]);
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
  const context = await taskContext(parsed, io, dependencies, verb === "status");
  if (verb === "show" || verb === "status") {
    if (verb === "show" && context.token) {
      const result = await showTask(context, { id: id!, signedIn: true });
      const receipts = result.receipts;
      taskOutput(io, json, context, verb, { ...result, receipts, ...(receipts[0] ?? {}) }, [
        `${result.workOrder.title} · ${result.workOrder.state}`,
        ...receipts.map((receipt) => `Receipt (from escrow): ${receipt.receiptUrl}`),
      ]);
    } else {
      const result =
        verb === "status"
          ? await taskStatus(context, { id: id! })
          : await showTask(context, { id: id!, signedIn: false });
      const task = result.task;
      taskOutput(
        io,
        json,
        context,
        verb,
        {
          task,
          ...(task.receiptUrl ? { receiptUrl: task.receiptUrl, receiptUrlSource: "server" } : {}),
        },
        [
          `${task.title} · ${task.state}`,
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
  if (verb === "watch") return await watchTask(id, parsed, json, io, dependencies, now);
  const disputeEvidenceHash = verb === "dispute" ? required(parsed, "--evidence-hash") : undefined;
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
    try {
      const result = await signTaskScope(context, {
        id,
        signMessage: async (message) => {
          const { account } = await unlockTarget(target, dependencies);
          return await account.signMessage({ message });
        },
      });
      taskOutput(io, json, context, verb, result, [
        `Accepted scope for task ${id}.`,
        ...(result.escrowCreation ? ["Created the task escrow."] : []),
      ]);
      return;
    } catch (error) {
      if (!(error instanceof TasksScopeCreationError)) throw error;
      taskOutput(io, json, context, verb, error.acceptance, [`Accepted scope for task ${id}.`]);
      return await taskRequest(verb, "createEscrow", async () => {
        throw error.cause;
      });
    }
  }

  if (verb === "deliver") {
    const outcome = await deliverTaskOperation(context, {
      id,
      ...delivery!,
      onPrepared: (manifestHash) => {
        if (!json)
          taskOutput(io, false, context, verb, {}, [`Prepared delivery manifest ${manifestHash}.`]);
      },
    });
    taskOutput(io, json, context, verb, outcome, [`Delivered task ${id}.`]);
    return;
  }

  const snapshot = await taskMoneySnapshot(context.client, id, undefined, {
    signInHint: context.signInHint,
  });
  if (!json) io.stdout(snapshot.money.line);

  if (verb === "fund") {
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
                await getLinePrompt(dependencies)(`${money.line}. Approve funding? [y/N] `)
              )
                .trim()
                .toLowerCase();
              return answer === "y" || answer === "yes";
            },
          }
        : ({ granted: false } as const);
    const outcome = await fundTaskOperation(context, {
      id,
      snapshot,
      policy,
      caps,
      wallet: target.name,
      ledgerPath: getVapiPaths().ledger,
      now: dependencies.now ?? (() => new Date()),
      approval,
      idempotencyKey: context.randomUUID,
      beforeChainFund: () => {
        if (!json) io.stdout("Policy: approved.");
      },
    });
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
    taskOutput(io, json, context, verb, outcome, [`Funded task ${id}.`]);
    return;
  }

  let result:
    | Awaited<ReturnType<typeof releaseTaskOperation>>
    | Awaited<ReturnType<typeof disputeTaskOperation>>;
  if (!json) io.stdout("Policy: explicit user instruction.");
  if (verb === "release") {
    result = await releaseTaskOperation(context, { id, snapshot });
  } else if (verb === "refund") {
    result = await refundTaskOperation(context, { id, snapshot });
  } else {
    const disputeFeeNote = "The contract charges a dispute fee; the amount is unavailable.";
    if (!json) io.stdout(disputeFeeNote);
    result = await disputeTaskOperation(context, {
      id,
      snapshot,
      evidenceHash: disputeEvidenceHash!,
    });
  }
  taskOutput(io, json, context, verb, result, [`Completed task ${verb} for ${id}.`]);
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
      taskOutput(io, json, context, "watch", { event }, [`${event.sequence}: ${event.type}`]);
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
