import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import {
  getVapiPaths,
  loadConfig,
  spendCapsForWallet,
  type SecretStore,
  type WalletStore,
} from "@vapi-network/core";
import {
  TASK_LIMITS,
  TASK_WATCH_STATES,
  TaskInputError,
  TaskOperationError,
  TasksChainError,
  TasksScopeCreationError,
  awardTask,
  createPendingTransactions,
  createTasksChain,
  createTasksClient,
  createTasksRpcFor,
  deliverTaskOperation,
  disputeTaskOperation,
  fundTaskOperation,
  messageTask,
  missingTasksChain,
  nextTaskEvents,
  parseTaskDuration,
  parseUsdToBaseUnits,
  postTask,
  proposeTask,
  publicNotFoundFetch,
  readTaskFile,
  refundTaskOperation,
  releaseTaskOperation,
  safeTasksChainError,
  resolveTaskBearer,
  searchTasks,
  showTask,
  signTaskScope,
  submitTask,
  taskEventState,
  taskPolicyForWallet,
  taskRequest,
  taskStateMatches,
  taskStatus,
  threadTask,
  type PendingTransactions,
  type TaskOperationContext,
  type TasksChain,
  type TasksClient,
  type TasksClientOptions,
} from "@vapi-network/core/tasks";
import { z } from "zod";

import { walletArgument } from "../actions/call.js";
import { registeredAgentProfileSchema } from "../actions/register.js";
import type { WalletSession } from "../wallet-session.js";

const id = z.uuid().toLowerCase();
const participant = { id, ...walletArgument };
const cursor = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
function usdWithinEscrow(value: string, positive = false): boolean {
  try {
    const amount = parseUsdToBaseUnits(value);
    return amount < 1n << 256n && (!positive || amount > 0n);
  } catch {
    return false;
  }
}
const decimal = z
  .string()
  .regex(/^\d+(?:\.\d{1,6})?$/u)
  .refine((value) => usdWithinEscrow(value));
const positiveUsd = decimal.refine((value) => usdWithinEscrow(value, true));
const httpsUrl = z.url().refine((value) => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}, "Expected an HTTPS URL without credentials.");
const localPath = z.string().min(1);

function descriptor<Shape extends z.ZodRawShape>(description: string, inputSchema: Shape) {
  return { description, inputSchema, strictInput: true as const };
}

export const tasksSearchTool = descriptor(
  "Does not move money. Search the public task board for bounties to take and earn.",
  {
    open: z.boolean().optional(),
    minUsd: decimal.optional(),
    tab: z.enum(TASK_LIMITS.searchTabs).optional(),
    limit: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  },
);
export const tasksShowTool = descriptor(
  "Does not move money. Read the private task order and receipts when signed in, otherwise the public task card.",
  participant,
);
export const tasksPostTool = descriptor(
  "Does not move money. Post a task with its market budget, deadline, intake, award limit and optional webhook.",
  {
    ...walletArgument,
    title: z.string().trim().min(TASK_LIMITS.titleMin).max(TASK_LIMITS.titleMax),
    brief: z.string().trim().min(TASK_LIMITS.briefMin).max(TASK_LIMITS.briefMax),
    amountUsd: positiveUsd,
    deadline: z.string(),
    intake: z.enum(["proposals", "submissions"]).optional(),
    maxAwards: z
      .number()
      .int()
      .min(TASK_LIMITS.maxAwardsMin)
      .max(TASK_LIMITS.maxAwardsMax)
      .optional(),
    webhookUrl: httpsUrl.optional(),
  },
);
export const tasksProposeTool = descriptor(
  "Does not move money. Sign proposed task terms locally as the selected worker wallet.",
  {
    ...participant,
    priceUsd: positiveUsd,
    duration: z.string(),
    note: z.string().trim().min(TASK_LIMITS.proposalNoteMin).max(TASK_LIMITS.proposalNoteMax),
  },
);
export const tasksSubmitTool = descriptor(
  "Does not move money. Sign task submission terms locally with HTTPS proof and optional local files.",
  {
    ...participant,
    proofUrls: z.array(httpsUrl).min(1),
    files: z.array(localPath).optional(),
  },
);
export const tasksAwardTool = descriptor(
  "Does not move money. Award a proposal for the poster's task.",
  { ...participant, proposalId: id },
);
export const tasksSignTool = descriptor(
  "Does not move money. Sign the current counterparty scope locally; a worker may also create the unfunded escrow with the local vault wallet.",
  participant,
);
export const tasksFundTool = descriptor(
  "Moves money: locks the task amount in USDC escrow subject to the acting wallet's policy and daily cap. MCP cannot grant human approval; amounts above the approval threshold are refused with approval:true.",
  participant,
);
export const tasksDeliverTool = descriptor(
  "Does not move money. Upload local delivery files, freeze the manifest and record delivery with the local vault wallet.",
  {
    ...participant,
    files: z.array(localPath).min(TASK_LIMITS.deliveryFilesMin).max(TASK_LIMITS.deliveryFilesMax),
    note: z
      .string()
      .max(TASK_LIMITS.deliveryNoteMax)
      .refine((value) => value.trim().length > 0),
  },
);
export const tasksReleaseTool = descriptor(
  "Moves money: pays the worker from escrow with the local vault wallet. Returns gross · fee · net using the deployed fee.",
  participant,
);
export const tasksRefundTool = descriptor(
  "Moves money: returns escrowed USDC to the poster with the local vault wallet. Returns gross · fee · net using the deployed fee.",
  participant,
);
export const tasksDisputeTool = descriptor(
  "Moves money: raises a dispute with the local vault wallet. This release refuses when the contract needs a fee approval. Accepts only a precomputed evidence hash and returns gross · fee · net using the deployed fee.",
  {
    ...participant,
    evidenceHash: z.string().regex(TASK_LIMITS.disputeEvidenceHash),
  },
);
export const tasksMessageTool = descriptor(
  "Does not move money. Send task thread text as the acting wallet.",
  {
    ...participant,
    text: z
      .string()
      .trim()
      .min(TASK_LIMITS.messageMin)
      .refine((value) => Array.from(value).length <= TASK_LIMITS.messageMax),
  },
);
export const tasksThreadTool = descriptor(
  "Does not move money. Read task messages; after is the previous page's nextBeforeSeq and reads older messages.",
  { ...participant, after: cursor.min(1).optional() },
);
export const tasksWatchTool = descriptor(
  "Does not move money. Poll task events for one bounded window of at most 25 seconds; a zero-second window returns immediately. It never moves money or releases escrow.",
  {
    ...participant,
    after: cursor.default(0),
    until: z.enum(TASK_WATCH_STATES).optional(),
    waitSeconds: z.number().int().min(0).max(25).default(25),
  },
);
export const tasksStatusTool = descriptor(
  "Does not move money. Read the public task card and receipt URL when settled; sign-in is not required.",
  { id },
);

export type TasksOverrides = {
  client?: TasksClient | ((options: TasksClientOptions) => TasksClient);
  chain?: TasksChain;
  randomUUID?: () => string;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
};
type TasksToolsOptions = TasksOverrides & {
  session: WalletSession;
  secrets: SecretStore;
  wallets?: WalletStore | undefined;
  fetchImpl: typeof fetch;
  apiBase: string;
  ledgerPath?: string | undefined;
};
type Input<T extends { inputSchema: z.ZodRawShape }> = z.infer<z.ZodObject<T["inputSchema"]>>;
const signInHint = "Call auth.link for the acting wallet.";

function lazyTasksChain(
  factory: () => Promise<TasksChain>,
  pending: PendingTransactions,
): TasksChain {
  let chain: Promise<TasksChain> | undefined;
  const get = () =>
    (chain ??= factory().catch((error: unknown) => {
      if (error instanceof TasksChainError) throw error;
      throw safeTasksChainError(error, false, false);
    }));
  return {
    available: true,
    createEscrow: async (input) => (await get()).createEscrow(input),
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
    dispute: async (input) => (await get()).dispute(input),
    signScopeMessage: async (message) => (await get()).signScopeMessage(message),
  };
}

export function createTasksTools(options: TasksToolsOptions) {
  const now = options.now ?? (() => new Date());
  const home = getVapiPaths(options.session.home).directory;
  const pending = createPendingTransactions(home);
  const sleep = (ms: number, signal: AbortSignal) =>
    options.sleep ? options.sleep(ms) : delay(ms, undefined, { signal });

  async function context(wallet?: string, publicOnly = false, signal?: AbortSignal) {
    if (!publicOnly) await options.wallets?.reload();
    signal?.throwIfAborted();
    const guardedFetch = signal ? abortableFetch(options.fetchImpl, signal) : options.fetchImpl;
    const selected = publicOnly ? undefined : options.session.resolve(wallet);
    const token =
      selected && options.wallets
        ? await resolveTaskBearer({
            secrets: options.secrets,
            wallets: options.wallets as unknown as Parameters<
              typeof resolveTaskBearer
            >[0]["wallets"],
            wallet: selected.name,
            baseUrl: options.apiBase,
            signInHint,
            fetchImpl: guardedFetch,
            now: () => now().getTime(),
          })
        : undefined;
    signal?.throwIfAborted();
    const clientOptions: TasksClientOptions = {
      baseUrl: options.apiBase,
      fetch: publicNotFoundFetch(guardedFetch, options.apiBase),
      ...(token === undefined ? {} : { token }),
    };
    const injected = options.client;
    const client =
      typeof injected === "function"
        ? injected(clientOptions)
        : (injected ?? createTasksClient(clientOptions));
    return {
      client,
      chain:
        options.chain ??
        (selected === undefined
          ? missingTasksChain
          : lazyTasksChain(async () => {
              const { account } = await options.session.payment(selected.name);
              const config = await loadConfig(getVapiPaths(home).config);
              return createTasksChain({
                client,
                account,
                trustedFactories: config.tasksEscrowFactoryOverrides,
                rpcFor: createTasksRpcFor(config, { fetch: guardedFetch }),
                pending,
                now,
                ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
              });
            }, pending)),
      pending,
      baseUrl: options.apiBase,
      randomUUID: options.randomUUID ?? randomUUID,
      signInHint,
      selected,
      token,
    };
  }

  async function acting(wallet?: string, signal?: AbortSignal) {
    const result = await context(wallet, false, signal);
    if (!result.token || !result.selected)
      throw new TaskOperationError(
        "not_signed_in",
        "Sign-in is needed for the acting wallet. Call auth.link.",
      );
    return { ...result, selected: result.selected };
  }

  function unlock(wallet: string) {
    return async () => {
      const { account } = await options.session.payment(wallet);
      return {
        address: account.address,
        signMessage: (message: string) => account.signMessage({ message }),
      };
    };
  }

  return {
    async search(input: Input<typeof tasksSearchTool>) {
      return taskResult(
        await searchTasks(await context(undefined, true), {
          ...input,
          ...(input.minUsd === undefined ? {} : { min: parseUsdToBaseUnits(input.minUsd) }),
        }),
      );
    },
    async show(input: Input<typeof tasksShowTool>) {
      await options.wallets?.reload();
      const publicOnly =
        input.wallet === undefined &&
        options.session.activeName === undefined &&
        options.wallets !== undefined &&
        options.wallets.names().length === 0;
      const ctx = await context(input.wallet, publicOnly);
      return taskResult(await showTask(ctx, { id: input.id, signedIn: Boolean(ctx.token) }));
    },
    async post(input: Input<typeof tasksPostTool>) {
      const postedAt = now();
      const deadlineDuration = parseTaskDuration(input.deadline, postedAt);
      if (deadlineDuration < TASK_LIMITS.postDeadlineMinMs)
        throw new TaskInputError("deadline must be at least 10 minutes from now.");
      const ctx = await acting(input.wallet);
      const outcome = await postTask(ctx, {
        order: { title: input.title, description: input.brief, policyFamily: "general-digital" },
        amount: parseUsdToBaseUnits(input.amountUsd),
        deadlineAt: new Date(postedAt.getTime() + deadlineDuration).toISOString(),
        ...(input.intake === undefined ? {} : { intake: input.intake }),
        ...(input.maxAwards === undefined ? {} : { maxAwards: input.maxAwards }),
        ...(input.webhookUrl === undefined ? {} : { webhook: input.webhookUrl }),
      });
      return taskResult({
        ...outcome.result,
        money: outcome.money,
        feeUnavailable: outcome.feeUnavailable,
        unsupportedFields: outcome.unsupportedFields,
        postingMovesMoney: false,
      });
    },
    async propose(input: Input<typeof tasksProposeTool>) {
      const duration = parseTaskDuration(input.duration, now());
      if (
        duration < TASK_LIMITS.proposalDurationMinMs ||
        duration > TASK_LIMITS.proposalDurationMaxMs ||
        duration % TASK_LIMITS.proposalDurationUnitMs !== 0
      )
        throw new TaskInputError("duration must be whole seconds between 10 minutes and 90 days.");
      const ctx = await acting(input.wallet);
      return taskResult(
        await proposeTask(ctx, {
          id: input.id,
          price: parseUsdToBaseUnits(input.priceUsd),
          durationSeconds: duration / TASK_LIMITS.proposalDurationUnitMs,
          note: input.note,
          unlock: unlock(ctx.selected.name),
        }),
      );
    },
    async submit(input: Input<typeof tasksSubmitTool>) {
      const files = await Promise.all((input.files ?? []).map(readTaskFile));
      const ctx = await acting(input.wallet);
      return taskResult(
        await submitTask(ctx, {
          id: input.id,
          proof: input.proofUrls.map((value) => ({ kind: "url", value })),
          files,
          unlock: unlock(ctx.selected.name),
        }),
      );
    },
    async award(input: Input<typeof tasksAwardTool>) {
      return taskResult(
        await awardTask(await acting(input.wallet), { id: input.id, proposalId: input.proposalId }),
      );
    },
    async sign(input: Input<typeof tasksSignTool>) {
      const ctx = await acting(input.wallet);
      try {
        return taskResult(
          await signTaskScope(ctx, {
            id: input.id,
            signMessage: async (message) =>
              (await unlock(ctx.selected.name)()).signMessage(message),
          }),
        );
      } catch (error) {
        if (!(error instanceof TasksScopeCreationError)) throw error;
        try {
          await taskRequest(
            "sign",
            "createEscrow",
            async () => {
              throw error.cause;
            },
            ctx,
          );
        } catch (cause) {
          return tasksErrorResult(cause, { acceptance: error.acceptance });
        }
        throw error;
      }
    },
    async fund(input: Input<typeof tasksFundTool>) {
      const ctx = await acting(input.wallet);
      const policy = await taskPolicyForWallet({
        directory: getVapiPaths(options.session.home).directory,
        wallet: ctx.selected.name,
        schema: registeredAgentProfileSchema,
      });
      const outcome = await fundTaskOperation(ctx, {
        id: input.id,
        policy,
        caps: await spendCapsForWallet(options.wallets!, ctx.selected.name),
        wallet: ctx.selected.name,
        ledgerPath: options.ledgerPath ?? getVapiPaths().ledger,
        now,
        // Stdio has no human approval channel. Model arguments cannot grant approval.
        approval: { granted: false },
      });
      return taskResult(outcome, !outcome.ok);
    },
    async deliver(input: Input<typeof tasksDeliverTool>) {
      const files = (await Promise.all(input.files.map(readTaskFile))).map(
        ({ fileName: name, bytes, contentType }) => ({ name, bytes, contentType }),
      );
      return taskResult(
        await deliverTaskOperation(await acting(input.wallet), {
          id: input.id,
          files,
          note: input.note,
        }),
      );
    },
    async release(input: Input<typeof tasksReleaseTool>) {
      return taskResult(await releaseTaskOperation(await acting(input.wallet), { id: input.id }));
    },
    async refund(input: Input<typeof tasksRefundTool>) {
      return taskResult(await refundTaskOperation(await acting(input.wallet), { id: input.id }));
    },
    async dispute(input: Input<typeof tasksDisputeTool>) {
      return taskResult(
        await disputeTaskOperation(await acting(input.wallet), {
          id: input.id,
          evidenceHash: input.evidenceHash,
        }),
      );
    },
    async message(input: Input<typeof tasksMessageTool>) {
      return taskResult(
        await messageTask(await acting(input.wallet), { id: input.id, body: input.text }),
      );
    },
    async thread(input: Input<typeof tasksThreadTool>) {
      return taskResult(
        await threadTask(await acting(input.wallet), {
          id: input.id,
          ...(input.after === undefined ? {} : { cursor: input.after }),
        }),
      );
    },
    async watch(input: Input<typeof tasksWatchTool>) {
      if (input.waitSeconds === 0) {
        options.session.resolve(input.wallet);
        return taskResult({ events: [], nextCursor: input.after, timedOut: true });
      }
      const controller = new AbortController();
      const deadline = now().getTime() + input.waitSeconds * 1000;
      const progress = { cursor: input.after };
      const timedOut = () => ({ events: [], nextCursor: progress.cursor, timedOut: true });
      const alarm = sleep(input.waitSeconds * 1000, controller.signal).then(
        () => {
          controller.abort();
          return timedOut();
        },
        (error: unknown) => {
          if (!controller.signal.aborted) throw error;
          return timedOut();
        },
      );
      const polling = async () => {
        const ctx = await acting(input.wallet, controller.signal);
        return await watchEvents(ctx, input, now, sleep, deadline, controller.signal, progress);
      };
      try {
        return taskResult(await Promise.race([alarm, polling()]));
      } finally {
        // Cancel the default deadline timer and any pending transport after an early result.
        controller.abort();
      }
    },
    async status(input: Input<typeof tasksStatusTool>) {
      return taskResult(await taskStatus(await context(undefined, true), { id: input.id }));
    },
  };
}

async function watchEvents(
  ctx: TaskOperationContext,
  input: Input<typeof tasksWatchTool>,
  now: () => Date,
  sleep: (ms: number, signal: AbortSignal) => Promise<void>,
  deadline: number,
  signal: AbortSignal,
  progress: { cursor: number },
) {
  for (;;) {
    signal.throwIfAborted();
    const page = await taskRequest(
      "watch",
      "events",
      () => ctx.client.events(input.id, { after: progress.cursor, wait: 0 }, { signal }),
      ctx,
    );
    signal.throwIfAborted();
    // Do not advance past events that arrived outside the caller's window.
    if (now().getTime() >= deadline)
      return { events: [], nextCursor: progress.cursor, timedOut: true };
    const next = nextTaskEvents(page, progress.cursor);
    progress.cursor = next.nextCursor;
    const reached =
      input.until !== undefined &&
      next.events.some((event) => taskStateMatches(input.until!, taskEventState(event)));
    if (next.events.length || reached)
      return { ...next, ...(reached ? { reached: input.until } : {}), timedOut: false };
    const remaining = deadline - now().getTime();
    if (remaining <= 0) return { ...next, timedOut: true };
    await sleep(Math.min(TASK_LIMITS.watchIntervalMinMs, remaining), signal);
    if (now().getTime() >= deadline)
      return { events: [], nextCursor: progress.cursor, timedOut: true };
  }
}

function abortableFetch(fetchImpl: typeof fetch, signal: AbortSignal): typeof fetch {
  return async (input, init) => {
    signal.throwIfAborted();
    const original = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    const response = await fetchImpl(input, {
      ...init,
      signal: original ? AbortSignal.any([original, signal]) : signal,
    });
    signal.throwIfAborted();
    return response;
  };
}

function taskResult(value: object, isError = false) {
  return {
    ...(isError ? { isError: true as const } : {}),
    structuredContent: { ...value },
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
  };
}

export function tasksErrorResult(error: unknown, extra: Record<string, unknown> = {}) {
  const code =
    error instanceof z.ZodError
      ? "invalid_input"
      : error instanceof Error && "code" in error && typeof error.code === "string"
        ? error.code
        : "task_error";
  const value = {
    code,
    message: error instanceof Error ? error.message : String(error),
    ...(error instanceof TaskOperationError && error.manifestHash
      ? { manifestHash: error.manifestHash }
      : {}),
    ...extra,
  };
  return {
    isError: true as const,
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
  };
}
