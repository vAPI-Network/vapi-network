import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { basename, extname } from "node:path";

import {
  agentProfileSchema,
  createPublicFetch,
  DEFAULT_AUTO_RELEASE_BELOW_USD,
  DEFAULT_MAX_PER_TASK_USD,
  getVapiPaths,
  KeystoreError,
  listAgentProfiles,
  loadConfig,
  SpendCapError,
  spendCapsForWallet,
} from "@vapi-network/core";
import { agentAccessToken, AgentLinkError } from "@vapi-network/core/agent-link";
import {
  canonicalJson,
  createTasksClient,
  autoReleaseDecision,
  disputeTask,
  fundTask,
  missingTasksChain,
  parseFeeBp,
  parseUsdToBaseUnits,
  prepareDelivery,
  refundTask,
  releaseTask,
  signScope,
  taskMoney,
  TASKS_CLIENT_VERBS,
  TasksScopeCreationError,
  TasksChainUnavailableError,
  TasksClientError,
  type TasksChain,
  type TasksClient,
  type TasksClientOptions,
  type SubmissionProof,
  type UploadFileInput,
  submissionProofSchema,
  submitInputSchema,
  type CreateOrderInput,
  type GetOrderResponse,
  type TaskMoney,
  type ProposeInput,
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

Durations: 5s, 10m, 48h, 7d, or an ISO-8601 timestamp. Posting requires at least 10 minutes; proposal terms require at least one hour under the current contract.
Dispute accepts a precomputed evidence hash only; evidence-file hashing is still undecided upstream.
Watch requires an interval of at least 1s and a positive timeout. Auto-release uses the acting wallet's agent profile, or defaults, and releases only amounts strictly below the threshold.
Posting a task moves no money. The current create-order contract stores the title and brief; amount, deadline, intake, max awards and webhook are validated but not stored yet. JSON lists these as unsupportedFields.
The thread cursor is the previous page's nextBeforeSeq; --after reads older messages using beforeSeq.
Public board, status and submissions need a server release that supports them. Participant actions with a bearer token need a server release that accepts tokens on task routes; until then they return 401 or 403 and you need to sign in in the console.
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
const LANE_B_ROUTES: ReadonlySet<TaskRoute> = new Set([
  "board",
  "publicTask",
  "receipt",
  "events",
  "submit",
  "feed",
]);

export class TaskCommandError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "TaskCommandError";
  }
}

/** Relative milliseconds; timestamps are measured from the supplied clock. */
export function parseTaskDuration(text: string, now: Date): number {
  const match = /^(\d+)(s|m|h|d)$/u.exec(text);
  const units: Record<string, number> = { s: 1000, m: 60000, h: 3600000, d: 86400000 };
  let milliseconds: number;
  if (match) milliseconds = Number(match[1]) * units[match[2]!]!;
  else if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/u.test(text)) {
    const datePart = text.slice(0, 10);
    const day = new Date(`${datePart}T00:00:00Z`);
    if (!Number.isFinite(day.getTime()) || day.toISOString().slice(0, 10) !== datePart)
      throw new UsageError("Expected a valid ISO-8601 timestamp.");
    milliseconds = Date.parse(text) - now.getTime();
  } else
    throw new UsageError("Expected a duration such as 10m, 48h or 7d, or an ISO-8601 timestamp.");
  if (
    !Number.isSafeInteger(milliseconds) ||
    milliseconds <= 0 ||
    !Number.isFinite(now.getTime()) ||
    !Number.isFinite(new Date(now.getTime() + milliseconds).getTime())
  )
    throw new UsageError(
      "The duration or timestamp must be in the future and within the supported date range.",
    );
  return milliseconds;
}

export type TaskContext = {
  client: TasksClient;
  chain: TasksChain;
  baseUrl: string;
  target?: WalletTarget;
  token?: string;
  randomUUID: () => string;
  sleep: (milliseconds: number) => Promise<void>;
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
  let token: string | undefined;
  if (!publicOnly && target?.entry.link !== undefined) {
    const link = target.entry.link;
    // A login bearer must never cross registry origins.
    if (new URL(target.entry.link.apiBase).origin !== new URL(baseUrl).origin)
      throw new TaskCommandError(
        "not_signed_in",
        "The acting wallet is linked to a different server. Run vapi login for this server.",
      );
    try {
      token = await agentAccessToken({
        secrets: getSecretStore(dependencies),
        wallets: target.store,
        wallet: target.name,
        ...(dependencies.fetchImpl === undefined ? {} : { fetchImpl: dependencies.fetchImpl }),
        ...(dependencies.now === undefined ? {} : { now: () => dependencies.now!().getTime() }),
      });
      const currentLink = target.store.entry(target.name)?.link;
      if (currentLink?.clientId !== link.clientId || currentLink.apiBase !== link.apiBase)
        throw new TaskCommandError(
          "not_signed_in",
          "The acting wallet's sign-in changed. Retry with its current server.",
        );
    } catch (error) {
      if (!(error instanceof AgentLinkError && error.code === "not_linked")) throw error;
    }
  }
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
    sleep:
      dependencies.tasks?.sleep ??
      ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))),
  };
}

/** C1 turns public 404s into null; preserve explicit missing entities and detect unmounted routes. */
function publicNotFoundFetch(fetchImpl: typeof fetch, baseUrl: string): typeof fetch {
  const base = baseUrl.replace(/\/+$/u, "");
  return async (input, init) => {
    const response = await fetchImpl(input, init);
    const url = input instanceof Request ? input.url : String(input);
    if (
      response.status !== 404 ||
      ![`${base}/api/tasks/`, `${base}/api/receipts/`].some((prefix) => url.startsWith(prefix))
    )
      return response;
    let body: unknown;
    try {
      body = await response.clone().json();
    } catch {
      /* Unmounted routes may return HTML. */
    }
    const record =
      typeof body === "object" && body !== null ? (body as Record<string, unknown>) : undefined;
    const nested =
      typeof record?.error === "object" && record.error !== null
        ? (record.error as Record<string, unknown>)
        : undefined;
    const code = nested?.code ?? record?.code;
    const message =
      typeof record?.error === "string" ? record.error : (nested?.message ?? record?.message);
    if (missingEntity(code, message)) return response;
    await response.body?.cancel();
    throw new TasksClientError(
      "http",
      "The public task route is unavailable.",
      404,
      typeof code === "string" ? code : undefined,
    );
  };
}

function missingEntity(code: unknown, message: unknown): boolean {
  return (
    (typeof code === "string" && /^(?:task|work_order|receipt|order)_not_found$/iu.test(code)) ||
    (typeof message === "string" &&
      /\b(?:task|work order|order|receipt)\b.*\bnot found\b/iu.test(message))
  );
}

export async function taskRequest<T>(
  verb: string,
  route: TaskRoute,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (
      error instanceof TasksChainUnavailableError ||
      (error instanceof Error && "code" in error && error.code === "chain_unavailable")
    )
      throw new TaskCommandError("chain_unavailable", "chain operations need C2");
    if (error instanceof TasksClientError) {
      if (error.code === "invalid_input") throw new UsageError(error.message);
      if (
        error.status === 404 &&
        LANE_B_ROUTES.has(route) &&
        !missingEntity(error.serverCode, error.message)
      )
        throw new TaskCommandError("not_available", `${verb} is not available on this server yet.`);
      if (
        (error.status === 401 || error.status === 403) &&
        !["board", "publicTask", "receipt", "feed", "deployment"].includes(route)
      )
        throw new TaskCommandError(
          "not_signed_in",
          route === "createOrder" || route === "propose"
            ? `${verb} needs sign-in. Run vapi login for the acting wallet.`
            : `${verb} needs sign-in. This server does not accept bearer tokens on task routes yet; sign in in the console.`,
        );
      throw new TaskCommandError(error.serverCode ?? error.code, error.message);
    }
    throw error;
  }
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
    if (tab !== undefined && !["trending", "new", "closing", "paid"].includes(tab))
      throw new UsageError("--tab must be trending, new, closing or paid.");
    const limit = optionalInteger(parsed.one("--limit"), "--limit");
    const min =
      parsed.one("--min") === undefined ? undefined : usd(parsed.one("--min")!, "--min", true);
    const context = await taskContext(parsed, io, dependencies, true);
    const board = await taskRequest(verb, "board", () =>
      context.client.board({
        ...(tab === undefined ? {} : { tab: tab as "trending" | "new" | "closing" | "paid" }),
        ...(limit === undefined ? {} : { limit }),
      }),
    );
    const accepts = (task: (typeof board.cards)[number]) =>
      (!parsed.has("--open") || task.state === "open") &&
      (min === undefined || parseUsdToBaseUnits(task.amount.gross) >= min);
    const cards = board.cards.filter(accepts),
      pinned = board.pinned && accepts(board.pinned) ? board.pinned : null;
    taskOutput(io, json, context, verb, { ...board, cards, pinned }, [
      ...(pinned ? [`Pinned task: ${pinned.id} · ${pinned.title}`] : []),
      ...cards.map(
        (task) =>
          `${task.id} · ${task.title} · ${taskMoney(parseUsdToBaseUnits(task.amount.gross), parseFeeBp(board.numbers)).line} · ${task.state}`,
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
    if (duration < 600000) throw new UsageError("--deadline must be at least 10 minutes from now.");
    const intake = parsed.one("--intake");
    if (intake !== undefined && !["proposals", "submissions"].includes(intake))
      throw new UsageError("--intake must be proposals or submissions.");
    const maxAwards = optionalInteger(parsed.one("--max-awards"), "--max-awards");
    if (maxAwards !== undefined && maxAwards > 50)
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
    if (!validBrief(input.title, input.description))
      throw new UsageError(
        "--title must be 3 to 120 characters and the brief must be 10 to 8000 characters.",
      );
    const context = await taskContext(parsed, io, dependencies);
    signedIn(context);
    let feeBp: number | null = null;
    try {
      feeBp = parseFeeBp(await context.client.deployment());
    } catch {
      io.stderr("The deployed fee is unavailable.");
    }
    const money = taskMoney(amount, feeBp);
    const result = await taskRequest(verb, "createOrder", () =>
      context.client.createOrder(input, { idempotencyKey: context.randomUUID() }),
    );
    const unsupportedFields = [
      "amount",
      "deadline",
      ...(intake === undefined ? [] : ["intake"]),
      ...(maxAwards === undefined ? [] : ["maxAwards"]),
      ...(parsed.one("--webhook") === undefined ? [] : ["webhook"]),
    ];
    io.stderr(
      "The current create-order contract does not store amount, deadline, intake, max awards or webhook yet.",
    );
    taskOutput(
      io,
      json,
      context,
      verb,
      { ...result, money, postingMovesMoney: false, unsupportedFields },
      [`Posted task ${result.workOrder.id}.`, money.line, "Posting a task moves no money."],
    );
    return;
  }
  if (verb === "propose") {
    const price = usd(required(parsed, "--price"), "--price");
    const duration = parseTaskDuration(required(parsed, "--duration"), now);
    if (duration < 3600000 || duration > 7776000000 || duration % 1000 !== 0)
      throw new UsageError(
        "--duration must be whole seconds between one hour and 90 days under the current contract.",
      );
    const note = required(parsed, "--note").trim();
    if (!note || note.length > 8000)
      throw new UsageError("--note must be between 1 and 8000 characters.");
    const context = await taskContext(parsed, io, dependencies),
      target = signedIn(context);
    const { workOrder } = await taskRequest(verb, "getOrder", () => context.client.getOrder(id!));
    if (workOrder.id !== id)
      throw new TaskCommandError("invalid_response", "The response belongs to a different task.");
    const input = await proposalInput(context, dependencies, target, id!, {
      title: workOrder.title,
      description: note.length >= 10 ? note : `${workOrder.description}\n\n${note}`,
      amount: price,
      durationSeconds: duration / 1000,
    });
    const result = await taskRequest(verb, "propose", () =>
      context.client.propose(id!, input, { idempotencyKey: context.randomUUID() }),
    );
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
    const task = await taskRequest(verb, "publicTask", () => context.client.publicTask(id!));
    if (!task) throw new TaskCommandError("not_found", `Task ${id} was not found.`);
    if (task.id !== id)
      throw new TaskCommandError("invalid_response", "The response belongs to a different task.");
    const durationSeconds = task.durationSeconds;
    if (
      durationSeconds === null ||
      !Number.isInteger(durationSeconds) ||
      durationSeconds < 3600 ||
      durationSeconds > 7776000
    )
      throw new TaskCommandError(
        "not_available",
        "The task needs a duration between one hour and 90 days for signed submission terms.",
      );
    const deployment = await taskRequest(verb, "deployment", () => context.client.deployment());
    if (!deployment.configured)
      throw new TaskCommandError("not_available", "Task escrow deployment is unavailable.");
    const { account } = await unlockTarget(target, dependencies);
    const signedPayload = proposalTerms(id!, account.address, deployment, {
      title: task.title,
      description: task.briefFull,
      amount: usd(task.amount.gross, "Task amount"),
      durationSeconds,
    });
    if (!validBrief(task.title, task.briefFull))
      throw new TaskCommandError(
        "invalid_response",
        "The task terms do not fit the current submission contract.",
      );
    for (const file of files) {
      const uploaded = await taskRequest(verb, "uploadFile", () => context.client.uploadFile(file));
      const item = submissionProofSchema.safeParse({
        kind: "file",
        value: uploaded.file.sha256.toLowerCase(),
        label: file.fileName,
      });
      if (!item.success)
        throw new TaskCommandError("invalid_response", "The uploaded proof has an invalid sha256.");
      proof.push(item.data);
    }
    const payload = { ...signedPayload, kind: "submission" as const, proof };
    const signature = await account.signMessage({ message: canonicalJson(payload) });
    const input = submitInputSchema.safeParse({ signedPayload: payload, signature });
    if (!input.success)
      throw new UsageError("The submission terms do not fit the current task contract.");
    const result = await taskRequest(verb, "submit", () =>
      context.client.submit(
        id!,
        { signedPayload: payload, signature },
        { idempotencyKey: context.randomUUID() },
      ),
    );
    taskOutput(io, json, context, verb, result, [`Submitted proof for task ${id}.`]);
    return;
  }
  let proposalId: string | undefined, body: string | undefined, cursor: number | undefined;
  if (verb === "award") proposalId = taskId(parsed.positionals[1], "proposalId");
  if (verb === "message") {
    body = parsed.positionals[1]?.trim();
    if (!body || Array.from(body).length > 10000)
      throw new UsageError("message needs text between 1 and 10000 characters.");
  }
  if (verb === "thread") cursor = optionalInteger(parsed.one("--after"), "--after");
  const context = await taskContext(parsed, io, dependencies, verb === "status");
  if (verb === "show" || verb === "status") {
    if (verb === "show" && context.token) {
      const result = await taskRequest(verb, "getOrder", () => context.client.getOrder(id!));
      if (result.workOrder.id !== id)
        throw new TaskCommandError("invalid_response", "The response belongs to a different task.");
      const receipts = orderReceipts(result.workOrder, context.baseUrl);
      taskOutput(io, json, context, verb, { ...result, receipts, ...(receipts[0] ?? {}) }, [
        `${result.workOrder.title} · ${result.workOrder.state}`,
        ...receipts.map((receipt) => `Receipt (from escrow): ${receipt.receiptUrl}`),
      ]);
    } else {
      const task = await taskRequest(verb, "publicTask", () => context.client.publicTask(id!));
      if (!task) throw new TaskCommandError("not_found", `Task ${id} was not found.`);
      if (task.id !== id)
        throw new TaskCommandError("invalid_response", "The response belongs to a different task.");
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
    const result = await taskRequest(verb, "acceptProposal", () =>
      context.client.acceptProposal(
        id!,
        { proposalId: proposalId! },
        { idempotencyKey: context.randomUUID() },
      ),
    );
    taskOutput(io, json, context, verb, result, [`Awarded proposal ${proposalId} for task ${id}.`]);
  } else if (verb === "message") {
    const result = await taskRequest(verb, "sendMessage", () =>
      context.client.sendMessage(id!, { body: body! }, { idempotencyKey: context.randomUUID() }),
    );
    taskOutput(io, json, context, verb, result, [`Message sent for task ${id}.`]);
  } else if (verb === "thread") {
    const result = await taskRequest(verb, "listMessages", () =>
      context.client.listMessages(id!, cursor === undefined ? {} : { beforeSeq: cursor }),
    );
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

type TaskPolicy = {
  maxPerTaskUsd: number;
  approveAboveUsd: number;
  autoReleaseBelowUsd: number;
  source: "agent-profile" | "defaults";
};

type MoneySnapshot = {
  order: GetOrderResponse;
  escrowId: string;
  money: TaskMoney;
  readiness:
    | { ok: true; value: Awaited<ReturnType<TasksClient["deployment"]>> }
    | { ok: false; error: unknown };
};

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
  if (disputeEvidenceHash !== undefined && !/^0x[0-9a-fA-F]{64}$/u.test(disputeEvidenceHash))
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
    if (paths.length < 1 || paths.length > 20)
      throw new UsageError("--files needs between one and twenty delivery files.");
    const note = required(parsed, "--note");
    if (!note.trim() || note.length > 32_000)
      throw new UsageError("--note must be nonblank and at most 32000 characters.");
    const files = (await Promise.all(paths.map(readTaskFile))).map(
      ({ fileName: name, bytes, contentType }) => ({ name, bytes, contentType }),
    );
    delivery = { files, note };
  }
  const context = await taskContext(parsed, io, dependencies);
  const target = signedIn(context);

  if (verb === "sign") {
    const order = await taskRequest(verb, "getOrder", () => context.client.getOrder(id));
    if (order.workOrder.id !== id || order.workOrder.version !== "work-order-view-v1")
      throw new TaskCommandError(
        "invalid_response",
        "A private task order matching the requested ID is required.",
      );
    if (order.workOrder.role === "proposer")
      throw new TaskCommandError("wrong_role", "A proposer cannot sign this task scope.");
    const role = order.workOrder.role === "provider" ? "worker" : "poster";
    try {
      const result = await taskRequest(verb, "signScope", () =>
        signScope({
          client: context.client,
          chain: context.chain,
          orderId: id,
          role,
          signMessage: async (message) => {
            const { account } = await unlockTarget(target, dependencies);
            return await account.signMessage({ message });
          },
          idempotencyKey: context.randomUUID,
        }),
      );
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
    const prepared = await taskRequest(verb, "getOrder", () =>
      prepareDelivery({ client: context.client, orderId: id, ...delivery! }),
    );
    const manifestHash = prepared.manifest.manifestHash;
    if (!json)
      taskOutput(io, false, context, verb, {}, [`Prepared delivery manifest ${manifestHash}.`]);
    const result = await taskRequest(verb, "deliverEscrow", async () => {
      if (!context.chain.available) throw new TasksChainUnavailableError(manifestHash);
      return await context.chain.deliver({ ...prepared, idempotencyKey: context.randomUUID() });
    });
    taskOutput(io, json, context, verb, { ok: true, manifestHash, result }, [
      `Delivered task ${id}.`,
    ]);
    return;
  }

  const snapshot = await taskMoneySnapshot(context.client, id);
  const client = cachedMoneyClient(context.client, snapshot);
  if (!json) io.stdout(snapshot.money.line);

  if (verb === "fund") {
    const policy = await policyForWallet(target.name, io);
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
    const chain = new Proxy(context.chain, {
      get(chainTarget, property) {
        if (property === "fund")
          return async (input: Parameters<TasksChain["fund"]>[0]) => {
            if (!json) io.stdout("Policy: approved.");
            return await chainTarget.fund(input);
          };
        const value = Reflect.get(chainTarget, property, chainTarget) as unknown;
        return typeof value === "function" ? value.bind(chainTarget) : value;
      },
    });
    let outcome: Awaited<ReturnType<typeof fundTask>>;
    try {
      outcome = await taskRequest(verb, "fundEscrow", () =>
        fundTask({
          client,
          chain,
          orderId: id,
          policy,
          caps,
          wallet: target.name,
          ledgerPath: getVapiPaths().ledger,
          now: dependencies.now ?? (() => new Date()),
          approval,
          idempotencyKey: context.randomUUID,
        }),
      );
    } catch (error) {
      const reason = fundingRefusalReason(error);
      if (reason === undefined) throw error;
      if (json)
        taskOutput(
          io,
          true,
          context,
          verb,
          {
            ok: false,
            reason,
            money: snapshot.money,
            policySource: policy.source,
            policyDecision: reason,
          },
          [],
        );
      else io.stderr(`Policy: refused (${reason}).`);
      return 2;
    }
    if (outcome.outcome === "refused") {
      const value = {
        ok: false,
        reason: outcome.reason,
        money: outcome.money,
        policySource: policy.source,
        policyDecision: outcome.reason,
      };
      if (json) taskOutput(io, true, context, verb, value, []);
      else io.stderr(`Policy: refused (${outcome.reason}).`);
      return 2;
    }
    if (outcome.outcome === "approval_needed") {
      taskOutput(
        io,
        json,
        context,
        verb,
        {
          ok: false,
          approval: true,
          money: outcome.money,
          policySource: policy.source,
          policyDecision: "approval",
        },
        ["Policy: approval needed."],
      );
      return 3;
    }
    if (outcome.outcome === "declined")
      throw new TaskCommandError("not_approved", "Not approved; nothing was signed.");
    taskOutput(
      io,
      json,
      context,
      verb,
      {
        ok: true,
        money: outcome.money,
        policySource: policy.source,
        policyDecision: "ok",
        result: outcome.result,
      },
      [`Funded task ${id}.`],
    );
    return;
  }

  let result: Awaited<ReturnType<typeof releaseTask>> | Awaited<ReturnType<typeof disputeTask>>;
  if (!json) io.stdout("Policy: explicit user instruction.");
  if (verb === "release") {
    result = await taskRequest(verb, "releaseEscrow", () =>
      releaseTask({
        client,
        chain: context.chain,
        orderId: id,
        idempotencyKey: context.randomUUID,
      }),
    );
  } else if (verb === "refund") {
    result = await taskRequest(verb, "refundEscrow", () =>
      refundTask({ client, chain: context.chain, orderId: id, idempotencyKey: context.randomUUID }),
    );
  } else {
    const disputeFeeNote = "The contract charges a dispute fee; the amount is unavailable.";
    if (!json) io.stdout(disputeFeeNote);
    result = await taskRequest(verb, "disputeEscrow", () =>
      disputeTask({
        client,
        chain: context.chain,
        orderId: id,
        evidenceHash: disputeEvidenceHash!,
        idempotencyKey: context.randomUUID,
      }),
    );
  }
  taskOutput(io, json, context, verb, result, [`Completed task ${verb} for ${id}.`]);
}

function fundingRefusalReason(error: unknown): "policy.perTask" | "policy.perDay" | undefined {
  // Separate bundled core entry points can carry distinct copies of this class.
  if (!(
    error instanceof SpendCapError ||
    (error instanceof Error && error.name === "SpendCapError")
  ))
    return undefined;
  const code = "code" in error ? error.code : undefined;
  if (code === "per_task_cap_exceeded") return "policy.perTask";
  if (code === "per_day_cap_exceeded") return "policy.perDay";
  return undefined;
}

async function taskMoneySnapshot(
  client: TasksClient,
  orderId: string,
  escrowId?: string,
): Promise<MoneySnapshot> {
  const order = await taskRequest("task money", "getOrder", () => client.getOrder(orderId));
  const workOrder = order.workOrder;
  if (workOrder.id !== orderId || workOrder.version !== "work-order-view-v1")
    throw new TaskCommandError(
      "invalid_response",
      "A private task order matching the requested ID is required.",
    );
  const matches = escrowId
    ? workOrder.milestones.filter((milestone) => milestone.id === escrowId)
    : workOrder.milestones;
  if (matches.length !== 1)
    throw new TaskCommandError("invalid_response", "Select one task milestone by escrow ID.");
  const milestone = matches[0]!;
  if (milestone.workOrderId !== orderId)
    throw new TaskCommandError("invalid_response", "The milestone belongs to a different task.");
  let readiness: MoneySnapshot["readiness"];
  try {
    readiness = { ok: true, value: await client.deployment() };
  } catch (error) {
    readiness = { ok: false, error };
  }
  const feeBp = readiness.ok ? parseFeeBp(readiness.value) : null;
  return {
    order,
    escrowId: milestone.id,
    money: taskMoney(milestone.amountBaseUnits, feeBp),
    readiness,
  };
}

function cachedMoneyClient(client: TasksClient, snapshot: MoneySnapshot): TasksClient {
  return new Proxy(client, {
    get(target, property) {
      if (property === "getOrder")
        return async (id: string) => {
          if (id !== snapshot.order.workOrder.id)
            throw new Error("The cached task order does not match the requested ID.");
          return snapshot.order;
        };
      if (property === "deployment")
        return async () => {
          if (snapshot.readiness.ok) return snapshot.readiness.value;
          throw snapshot.readiness.error;
        };
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function policyForWallet(wallet: string, io: CliIo): Promise<TaskPolicy> {
  let invalid = false;
  const profiles = await listAgentProfiles(getVapiPaths().directory, {
    schema: registeredAgentProfileSchema,
    warn: io.stderr,
    onInvalid: () => {
      invalid = true;
    },
  });
  if (invalid) throw new UsageError("An invalid agent profile prevents task policy selection.");
  const matches = profiles.filter((profile) => profile.wallet === wallet);
  if (matches.length > 1)
    throw new UsageError(
      `More than one agent profile uses wallet ${wallet}; task policy is ambiguous.`,
    );
  const profile = matches[0];
  return profile
    ? {
        maxPerTaskUsd: profile.maxPerTaskUsd,
        approveAboveUsd: profile.approveAboveUsd,
        autoReleaseBelowUsd: profile.autoReleaseBelowUsd,
        source: "agent-profile",
      }
    : {
        maxPerTaskUsd: DEFAULT_MAX_PER_TASK_USD,
        approveAboveUsd: agentProfileSchema.shape.approveAboveUsd.parse(undefined),
        autoReleaseBelowUsd: DEFAULT_AUTO_RELEASE_BELOW_USD,
        source: "defaults",
      };
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
  if (interval < 1000) throw new UsageError("--interval must be at least 1s.");
  const timeout = parseTaskDuration(parsed.one("--timeout") ?? "7d", now);
  const until = parsed.one("--until");
  const states = new Set([
    "open",
    "awarded",
    "funded",
    "delivered",
    "paid",
    "released",
    "refunded",
    "disputed",
    "expired",
    "closed",
    "completed",
    "cancelled",
  ]);
  if (until !== undefined && !states.has(until))
    throw new UsageError(`--until must be one of ${[...states].join(", ")}.`);
  const context = await taskContext(parsed, io, dependencies);
  const target = signedIn(context);
  const autoRelease = parsed.has("--auto-release");
  const policy = autoRelease ? await policyForWallet(target.name, io) : undefined;
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
    if (!Number.isSafeInteger(page.nextAfter) || page.nextAfter < cursor)
      throw new TaskCommandError(
        "invalid_response",
        "The task event cursor regressed or is malformed.",
      );
    const events = [...page.events].sort((left, right) => left.sequence - right.sequence);
    for (const event of events) {
      if (!Number.isSafeInteger(event.sequence) || event.sequence < 0)
        throw new TaskCommandError("invalid_response", "A task event sequence is malformed.");
      if (event.sequence <= cursor) continue;
      taskOutput(io, json, context, "watch", { event }, [`${event.sequence}: ${event.type}`]);
      const state = eventState(event);
      if (autoRelease && state === "delivered") {
        const milestoneId =
          typeof event.payload.milestoneId === "string" ? event.payload.milestoneId : undefined;
        const snapshot = await taskMoneySnapshot(context.client, id, milestoneId);
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
      if (until !== undefined && stateMatches(until, state)) {
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

function eventState(event: { type: string; payload: Record<string, unknown> }): string {
  if (typeof event.payload.state === "string") return event.payload.state.toLowerCase();
  return event.type.split(".").at(-1)?.toLowerCase() ?? event.type.toLowerCase();
}

function stateMatches(until: string, state: string): boolean {
  return until === state || (until === "paid" && state === "released");
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

type ProposalTerms = {
  title: string;
  description: string;
  amount: bigint;
  durationSeconds: number;
};
type ConfiguredDeployment = Extract<
  Awaited<ReturnType<TasksClient["deployment"]>>,
  { configured: true }
>;
function proposalTerms(
  id: string,
  address: `0x${string}`,
  deployment: ConfiguredDeployment,
  terms: ProposalTerms,
): ProposeInput["signedPayload"] {
  return {
    version: "work-proposal-v1",
    workOrderId: id,
    providerAddress: address,
    pricingModel: "fixed",
    milestones: [
      {
        version: "work-milestone-terms-v1",
        title: terms.title,
        description: terms.description,
        acceptanceCriteria: ["Complete the task described in these terms."],
        workDurationSeconds: terms.durationSeconds,
        acceptanceWindowSeconds: 604800,
        budget: {
          network: deployment.network as `eip155:${number}`,
          asset: `${deployment.network}/erc20:${deployment.usdc}`,
          amountBaseUnits: terms.amount.toString(),
        },
        escrow: { protocol: "escrow-v1", contract: deployment.escrowContract },
        evidenceRules: { acceptedInputs: ["text", "private-file"], exactCommitRequired: false },
      },
    ],
  };
}

async function proposalInput(
  context: TaskContext,
  dependencies: CliDependencies,
  target: WalletTarget,
  id: string,
  terms: ProposalTerms,
): Promise<ProposeInput> {
  const deployment = await taskRequest("propose", "deployment", () => context.client.deployment());
  if (!deployment.configured)
    throw new TaskCommandError("not_available", "Task escrow deployment is unavailable.");
  const { account } = await unlockTarget(target, dependencies);
  const payload = proposalTerms(id, account.address, deployment, terms);
  if (!validBrief(terms.title, terms.description))
    throw new UsageError("The proposal terms do not fit the current task contract.");
  const signature = await account.signMessage({ message: canonicalJson(payload) });
  // C1 validates without replacing the exact values covered by the signature.
  return { signedPayload: payload, signature };
}

function validBrief(title: string, description: string): boolean {
  return (
    title.trim().length >= 3 &&
    title.trim().length <= 120 &&
    description.trim().length >= 10 &&
    description.trim().length <= 8000
  );
}

function orderReceipts(
  order: GetOrderResponse["workOrder"],
  baseUrl: string,
): { receiptUrl: string; receiptUrlSource: "escrow" }[] {
  if (order.version !== "work-order-view-v1") return [];
  return order.milestones
    .filter(
      (milestone) =>
        ["released", "refunded"].includes(milestone.state) ||
        (milestone.escrowState === "resolved" && milestone.resolution !== null),
    )
    .map((milestone) => ({
      receiptUrl: `${baseUrl.replace(/\/+$/u, "")}/receipts/${milestone.escrowContract}`,
      receiptUrlSource: "escrow",
    }));
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
  let details;
  try {
    details = await stat(path);
  } catch {
    throw new UsageError(`Task file ${JSON.stringify(path)} could not be read.`);
  }
  if (!details.isFile())
    throw new UsageError(
      `Task file ${JSON.stringify(path)} must be a regular file, not a directory.`,
    );
  const types: Record<string, UploadFileInput["contentType"]> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".pdf": "application/pdf",
    ".zip": "application/zip",
    ".txt": "text/plain",
    ".md": "text/markdown",
    ".json": "application/json",
    ".csv": "text/csv",
  };
  const contentType = types[extname(path).toLowerCase()];
  if (!contentType)
    throw new UsageError("Task files must be images, PDF, ZIP, text, Markdown, JSON or CSV.");
  const bytes = await readFile(path);
  if (!bytes.length || bytes.length > 50 * 1024 * 1024)
    throw new UsageError("Task files must contain between 1 byte and 50 MiB.");
  return {
    fileName: basename(path),
    bytes: Uint8Array.from(bytes),
    contentType,
    purpose: "delivery",
  };
}
async function readProcessStdin(): Promise<string> {
  process.stdin.setEncoding("utf8");
  let input = "";
  for await (const chunk of process.stdin) input += String(chunk);
  return input;
}
