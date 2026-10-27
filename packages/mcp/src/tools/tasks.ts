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
  taskV2PreparedSchema,
  executeTaskV2,
  taskUsesV2,
  recoverTaskV2,
  taskV2ActionSchema,
  taskV2ConsentSchema,
  taskV2IndexSchema,
  taskV2ProofSchema,
  taskV2StepSchema,
  type TaskV2Action,
  type TaskV2Consent,
  TASK_LIMITS,
  TASK_WATCH_STATES,
  TaskInputError,
  TaskOperationError,
  TasksChainError,
  TasksScopeCreationError,
  awardTask,
  createPendingTransactions,
  createTasksChain,
  createScopeBindings,
  createTasksRpcFor,
  deliverTaskOperation,
  disputeTaskOperation,
  counterEvidenceTaskOperation,
  resolveUnmatchedTaskOperation,
  taskFeeReservationKey,
  fundTaskOperation,
  fundTaskWithX402,
  requireTaskMethod,
  taskMoneySnapshot,
  messageTask,
  missingTasksChain,
  nextTaskEvents,
  parseTaskDuration,
  parseUsdToBaseUnits,
  postTask,
  prepareTaskPost,
  taskTermsFields,
  checkinInputSchema,
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
  waitForMilestone,
  type PendingTransactions,
  type TaskOperationContext,
  type TasksChain,
  type TasksClient,
  type TasksClientOptions,
} from "@vapi-network/core/tasks";
import { z } from "zod";

import { createHostedTasksClient } from "../tasks-client.js";
import { walletArgument } from "../actions/call.js";
import { registeredAgentProfileSchema } from "../actions/register.js";
import type { WalletSession } from "../wallet-session.js";

const id = z.uuid().toLowerCase();
const participant = { id, ...walletArgument };
const moneyParticipant = {
  ...participant,
  counterparty: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/u)
    .describe(
      "Checksummed 0x address of the other party, taken from tasks.show (the poster's clientAddress when you are the worker; the accepted proposal's providerAddress when you are the poster). The human must supply it; it is compared with the signed scope and stored as local consent. Without it tasks.sign refuses and no local party binding is created, so tasks.fund/deliver/release cannot run from this machine.",
    )
    .optional(),
};
const waitForIndexer = z
  .boolean()
  .default(true)
  .describe("Wait up to 60 seconds for vAPI to index the chain result before returning.");
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
export const tasksPendingTool = descriptor(
  "Does not move money. Read the acting wallet's pending task actions, amounts, due times and deep links.",
  { ...walletArgument, role: z.enum(["poster", "worker"]).optional() },
);
export const tasksCheckinTool = descriptor(
  "Does not move money. Record the worker's check-in status, note and optional link.",
  { ...participant, ...checkinInputSchema.shape, note: checkinInputSchema.shape.note.optional() },
);
export const tasksPostTool = descriptor(
  "Posts a task with a budget. Optional fund uses the local vault within the configured task and daily policy; amounts requiring human approval return approval:true. Fresh posts may return a funding error until the hosted signing path is available.",
  {
    ...walletArgument,
    title: z.string().trim().min(TASK_LIMITS.titleMin).max(TASK_LIMITS.titleMax),
    brief: z.string().trim().min(TASK_LIMITS.briefMin).max(TASK_LIMITS.briefMax),
    ...taskTermsFields,
    fund: z.boolean().optional(),
    amountUsd: positiveUsd.optional(),
    winners: z.number().int().min(1).max(50).optional(),
    rewardPerWinner: positiveUsd.optional(),
    choiceWindowSeconds: z.number().int().positive().optional(),
    rewardPerClaim: positiveUsd.optional(),
    budget: positiveUsd.optional(),
    gate: z.enum(["open", "proven"]).optional(),
    verifier: z.enum(["poster", "vapi"]).optional(),
    openCheck: z.enum(["allowlist", "invite"]).optional(),
    deadline: z.string(),
    intake: z.enum(["proposals", "submissions"]).optional(),
    maxAwards: z
      .number()
      .int()
      .min(TASK_LIMITS.maxAwardsMin)
      .max(TASK_LIMITS.maxAwardsMax)
      .optional(),
    webhookUrl: httpsUrl.optional(),
    vendor: z
      .string()
      .regex(/^0x[0-9a-fA-F]{40}$/u)
      .describe(
        "Optional 0x address of a worker to invite directly; the task is addressed to that wallet and shows up for them. Anyone may still propose.",
      )
      .optional(),
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
  "Does not move money. Sign task submission terms locally with HTTPS proof and optional local files, or withdraw an existing bounty submission without a signature.",
  {
    ...participant,
    proofUrls: z.array(httpsUrl).min(1).optional(),
    withdraw: z.boolean().optional(),
    proposalId: id.optional(),
    files: z.array(localPath).optional(),
  },
);
export const tasksMilestoneTool = descriptor(
  "Execute a hosted-prepared V2 milestone action. C0 index i is zero-based (0–4). Returns hosted operation state and gross · fee · net; local spend policy applies.",
  {
    ...participant,
    action: z.enum(["submit", "approve", "reject", "finalize"]),
    i: taskV2IndexSchema,
    proof: taskV2ProofSchema.optional(),
    reason: z.string().min(1).max(8000).optional(),
  },
);
export const tasksCancelTool = descriptor(
  "Execute the hosted-prepared V2 cancellation: offer, unpaid remainder or expiry. Refunds have no fee.",
  { ...participant, scope: z.enum(["offer", "remainder", "expire"]) },
);
export const tasksClaimTool = descriptor(
  "Pay a stored pool claim as its verifier through the hosted-prepared V2 payout plan. Returns gross · fee · net. Admission remains separate.",
  { ...participant, action: z.literal("pay"), claimant: z.string().regex(/^0x[0-9a-fA-F]{40}$/u) },
);
export const tasksAwardTool = descriptor(
  "Award a V1 proposal, select a V2 worker, or pay V2 bounty winners in one hosted-prepared transaction. Returns gross · fee · net.",
  {
    ...participant,
    proposalId: id.optional(),
    worker: z
      .string()
      .regex(/^0x[0-9a-fA-F]{40}$/u)
      .optional(),
    winners: z
      .array(z.string().regex(/^0x[0-9a-fA-F]{40}$/u))
      .min(1)
      .max(50)
      .optional(),
  },
);
export const tasksSignTool = descriptor(
  "Signs the user's own task scope locally with the user's vault wallet after the human confirms the money direction via counterparty; a worker may also create the unfunded escrow; nothing is custodial. Does not move money. Waits up to 60 seconds for vAPI to index a created escrow by default.",
  {
    ...moneyParticipant,
    wait: waitForIndexer,
    action: z.enum(["award-consent", "split-consent"]).optional(),
    i: taskV2IndexSchema.optional(),
    toWorker: z.string().regex(/^\d+$/u).optional(),
  },
);
export const tasksFundTool = descriptor(
  "Executes the user's own funding of this task from the user's vault wallet, within the spend policy the user configured; nothing is custodial. MCP cannot grant human approval; amounts above the approval threshold are refused with approval:true. Waits up to 60 seconds for vAPI to index the locked escrow by default.",
  { ...moneyParticipant, wait: waitForIndexer },
);
export const tasksDeliverTool = descriptor(
  "Does not move money. Upload local delivery files, freeze the manifest and record delivery with the local vault wallet. Waits up to 60 seconds for vAPI to index the delivery by default.",
  {
    ...moneyParticipant,
    wait: waitForIndexer,
    files: z
      .array(localPath)
      .min(TASK_LIMITS.deliveryFilesMin)
      .max(TASK_LIMITS.deliveryFilesMax)
      .optional(),
    proof: taskV2ProofSchema.optional(),
    note: z
      .string()
      .max(TASK_LIMITS.deliveryNoteMax)
      .refine((value) => value.trim().length > 0)
      .optional(),
  },
);
export const tasksReleaseTool = descriptor(
  "Executes the user's own payment to the worker from task escrow with the user's vault wallet; nothing is custodial. Returns gross · fee · net using the deployed fee. Waits up to 60 seconds for vAPI to index the release by default.",
  { ...moneyParticipant, wait: waitForIndexer, finalize: z.boolean().optional() },
);
export const tasksRefundTool = descriptor(
  "Executes the user's own refund of escrowed USDC to the poster with the user's vault wallet; nothing is custodial. Returns gross · fee · net using the deployed fee.",
  moneyParticipant,
);
export const tasksDisputeTool = descriptor(
  "Executes the user's own approval of the verified dispute fee and raises a dispute with the user's vault wallet; nothing is custodial. Applies task and daily caps; MCP refuses human approval with approval:true. Accepts a precomputed evidence hash.",
  {
    ...moneyParticipant,
    evidenceHash: z.string().regex(TASK_LIMITS.disputeEvidenceHash).optional(),
    i: taskV2IndexSchema.optional(),
    evidence: z.string().min(1).max(8000).optional(),
    action: z.enum(["raise", "resolve-unmatched", "split"]).optional(),
    toWorker: z.string().regex(/^\d+$/u).optional(),
  },
);
export const tasksCounterEvidenceTool = descriptor(
  "Executes the user's own counter-evidence submission and approval of the verified dispute fee with the user's vault wallet as the non-opener before the onchain deadline; nothing is custodial. Applies task and daily caps; MCP refuses human approval with approval:true.",
  {
    ...moneyParticipant,
    evidenceHash: z.string().regex(TASK_LIMITS.disputeEvidenceHash).optional(),
    i: taskV2IndexSchema.optional(),
    evidence: z.string().min(1).max(8000).optional(),
  },
);
export const tasksResolveUnmatchedTool = descriptor(
  "Executes the user's own resolution of an unmatched dispute with the user's vault wallet after the onchain counter-evidence deadline when no counter-evidence was submitted; nothing is custodial.",
  { ...moneyParticipant, i: taskV2IndexSchema.optional() },
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
  "Does not move money. Read signed-in chain state and participant events, or the public task card without sign-in.",
  {
    ...participant,
    operationId: z.uuid().optional(),
    step: taskV2StepSchema.optional(),
    abandon: z.boolean().optional(),
  },
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
        : (injected ?? createHostedTasksClient(clientOptions));
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
                trustedDurations: config.tasksEscrowDurationOverrides,
                bindings: createScopeBindings(home),
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

  async function waitAfterChain(
    ctx: TaskOperationContext,
    orderId: string,
    milestoneId: string,
    target: "created" | "locked" | "delivered" | "released",
  ) {
    return await taskRequest(
      target,
      "getOrder",
      () =>
        waitForMilestone(ctx.client, {
          orderId,
          milestoneId,
          target,
          timeoutMs: 60_000,
          intervalMs: 3_000,
          ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
          now,
        }),
      ctx,
    );
  }

  async function feeAction(
    verb: "dispute" | "counter-evidence",
    input: Input<typeof tasksDisputeTool>,
  ) {
    const ctx = await acting(input.wallet);
    const policy = await taskPolicyForWallet({
      directory: home,
      wallet: ctx.selected.name,
      schema: registeredAgentProfileSchema,
    });
    const outcome = await (
      verb === "dispute" ? disputeTaskOperation : counterEvidenceTaskOperation
    )(ctx, {
      id: input.id,
      evidenceHash: input.evidenceHash!,
      ...(input.counterparty === undefined ? {} : { counterparty: input.counterparty }),
      policy,
      caps: await spendCapsForWallet(options.wallets!, ctx.selected.name),
      wallet: ctx.selected.name,
      ledgerPath: options.ledgerPath ?? getVapiPaths(home).ledger,
      now,
      approval: { granted: false },
    });
    return taskResult(outcome, !outcome.ok);
  }

  async function v2(
    input: { id: string; wallet?: string },
    write?: TaskV2Action,
    consent?: TaskV2Consent,
  ) {
    const ctx = await acting(input.wallet);
    const result = await executeTaskV2(ctx, {
      id: input.id,
      ...(write ? { write } : {}),
      ...(consent ? { consent } : {}),
      policy: await taskPolicyForWallet({
        directory: home,
        wallet: ctx.selected.name,
        schema: registeredAgentProfileSchema,
      }),
      caps: await spendCapsForWallet(options.wallets!, ctx.selected.name),
      wallet: ctx.selected.name,
      ledgerPath: options.ledgerPath ?? getVapiPaths(home).ledger,
      approval: { granted: false },
    });
    return taskResult(result, !result.ok);
  }
  async function maybeV2(input: { id: string; wallet?: string }, write: TaskV2Action) {
    const ctx = await acting(input.wallet);
    if (!(await taskUsesV2(ctx, input.id))) return null;
    try {
      return await v2(input, write);
    } catch (error) {
      if (
        error instanceof TaskOperationError &&
        ["v1_order", "v2_writes_disabled"].includes(error.code)
      )
        return null;
      throw error;
    }
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
    async pending(input: Input<typeof tasksPendingTool>) {
      const ctx = await acting(input.wallet);
      const result = await taskRequest(
        "pending",
        "pending",
        () => requireTaskMethod(ctx.client, "pending")(),
        ctx,
      );
      return taskResult({
        pendingActions: input.role
          ? result.pendingActions.filter((item) => item.role === input.role)
          : result.pendingActions,
      });
    },
    async checkin(input: Input<typeof tasksCheckinTool>) {
      const ctx = await acting(input.wallet);
      const body = checkinInputSchema.parse({
        status: input.status,
        note: input.note ?? input.status.replaceAll("-", " "),
        ...(input.link === undefined ? {} : { link: input.link }),
      });
      return taskResult(
        await taskRequest(
          "checkin",
          "checkin",
          () =>
            requireTaskMethod(ctx.client, "checkin")(input.id, body, {
              idempotencyKey: ctx.randomUUID(),
            }),
          ctx,
        ),
      );
    },
    async post(input: Input<typeof tasksPostTool>) {
      const postedAt = now();
      const prepared = prepareTaskPost(input, postedAt);
      const ctx = await acting(input.wallet);
      const outcome = await postTask(ctx, {
        order: {
          title: input.title,
          description: input.brief,
          policyFamily: "general-digital",
          ...(input.shape !== undefined || input.milestones || input.proofSpec || input.checkin
            ? prepared.terms
            : {}),
          ...(input.vendor === undefined ? {} : { invitedProviderAddress: input.vendor }),
        },
        amount: prepared.amount,
        deadlineAt: prepared.deadlineAt,
        ...(input.fund ? { fund: true } : {}),
        ...(input.intake === undefined ? {} : { intake: input.intake }),
        ...(input.maxAwards === undefined ? {} : { maxAwards: input.maxAwards }),
        ...(input.webhookUrl === undefined ? {} : { webhook: input.webhookUrl }),
      });
      if (input.fund) {
        if (outcome.funding?.error)
          return taskResult(
            { ...outcome.result, ok: false, funding: outcome.funding, postingMovesMoney: false },
            true,
          );
        try {
          const policy = await taskPolicyForWallet({
            directory: home,
            wallet: ctx.selected.name,
            schema: registeredAgentProfileSchema,
          });
          const v2Prepared = taskV2PreparedSchema.safeParse(outcome.funding);
          if (v2Prepared.success && (await taskUsesV2(ctx, outcome.result.workOrder.id))) {
            const funding = await executeTaskV2(ctx, {
              id: outcome.result.workOrder.id,
              write: { action: "fund" },
              prepared: v2Prepared.data,
              preparationKey: outcome.fundingIdempotencyKey,
              expectedGrossBaseUnits: prepared.escrowAmount,
              policy,
              caps: await spendCapsForWallet(options.wallets!, ctx.selected.name),
              wallet: ctx.selected.name,
              ledgerPath: options.ledgerPath ?? getVapiPaths(home).ledger,
              approval: { granted: false },
            });
            return taskResult(
              {
                ...outcome.result,
                ...funding,
                funding,
                postingMovesMoney: funding.ok,
              },
              !funding.ok,
            );
          }
          const funding = await fundTaskOperation(ctx, {
            fundingIntent: outcome.funding,
            expectedGrossBaseUnits: prepared.escrowAmount,
            id: outcome.result.workOrder.id,
            policy,
            caps: await spendCapsForWallet(options.wallets!, ctx.selected.name),
            wallet: ctx.selected.name,
            ledgerPath: options.ledgerPath ?? getVapiPaths(home).ledger,
            now,
            approval: { granted: false },
          });
          const wait = funding.ok
            ? await waitAfterChain(
                ctx,
                outcome.result.workOrder.id,
                funding.result.milestone.id,
                "locked",
              )
            : null;
          return taskResult(
            { ...outcome.result, ...funding, funding, wait, postingMovesMoney: funding.ok },
            !funding.ok,
          );
        } catch (error) {
          return tasksErrorResult(error, { ...outcome.result, funding: { state: "unknown" } });
        }
      }
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
      if (input.withdraw && (input.proofUrls?.length || input.files?.length))
        throw new TaskInputError("withdraw cannot be combined with proof or files.");
      if (!input.withdraw && !input.proofUrls?.length)
        throw new TaskInputError("submit needs proofUrls or withdraw:true.");
      if (!input.withdraw && input.proposalId)
        throw new TaskInputError("proposalId requires withdraw:true.");
      const files = await Promise.all((input.files ?? []).map(readTaskFile));
      const ctx = await acting(input.wallet);
      return taskResult(
        await submitTask(ctx, {
          id: input.id,
          ...(input.withdraw
            ? {
                withdraw: true,
                ...(input.proposalId
                  ? {}
                  : { address: (await options.session.addressesFor(ctx.selected.name)).address }),
              }
            : {}),
          ...(input.proposalId ? { proposalId: input.proposalId } : {}),
          proof: (input.proofUrls ?? []).map((value) => ({ kind: "url", value })),
          files,
          unlock: unlock(ctx.selected.name),
        }),
      );
    },
    async milestone(input: Input<typeof tasksMilestoneTool>) {
      return v2(
        input,
        taskV2ActionSchema.parse({
          action: input.action,
          i: input.i,
          ...(input.action === "submit" ? { proof: input.proof } : {}),
          ...(input.action === "reject" ? { reason: input.reason } : {}),
        }),
      );
    },
    async cancel(input: Input<typeof tasksCancelTool>) {
      return v2(
        input,
        taskV2ActionSchema.parse({
          action: input.scope === "expire" ? "expire" : `cancel-${input.scope}`,
        }),
      );
    },
    async claim(input: Input<typeof tasksClaimTool>) {
      return v2(input, taskV2ActionSchema.parse({ action: "pay-claim", claimant: input.claimant }));
    },
    async award(input: Input<typeof tasksAwardTool>) {
      if (input.worker || input.winners) {
        if (input.proposalId || Boolean(input.worker) === Boolean(input.winners))
          throw new TaskInputError("Choose worker, winners or proposalId.");
        return v2(
          input,
          taskV2ActionSchema.parse(
            input.worker
              ? { action: "award", worker: input.worker }
              : { action: "award-bounty", winners: input.winners },
          ),
        );
      }
      if (!input.proposalId) throw new TaskInputError("proposalId, worker or winners is required.");
      return taskResult(
        await awardTask(await acting(input.wallet), { id: input.id, proposalId: input.proposalId }),
      );
    },
    async sign(input: Input<typeof tasksSignTool>) {
      if (input.action)
        return v2(
          input,
          undefined,
          taskV2ConsentSchema.parse({
            action: input.action,
            ...(input.action === "split-consent" ? { i: input.i, toWorker: input.toWorker } : {}),
          }),
        );
      if (input.counterparty === undefined)
        return tasksErrorResult(
          new TaskOperationError(
            "counterparty_required",
            "Supply counterparty from tasks.show to confirm the task's money direction before signing.",
          ),
        );
      const ctx = await acting(input.wallet);
      const signerAddress = (await options.session.addressesFor(ctx.selected.name)).address;
      try {
        const outcome = await signTaskScope(ctx, {
          id: input.id,
          counterparty: input.counterparty,
          signerAddress,
          bindings: createScopeBindings(home),
          signMessage: async (message) => (await unlock(ctx.selected.name)()).signMessage(message),
        });
        const wait =
          input.wait && outcome.escrowCreation
            ? await waitAfterChain(ctx, input.id, outcome.escrowCreation.milestone.id, "created")
            : null;
        return taskResult({ ...outcome, wait });
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
      const prepared = await maybeV2(input, { action: "fund" });
      if (prepared) return prepared;
      const ctx = await acting(input.wallet);
      const policy = await taskPolicyForWallet({
        directory: getVapiPaths(options.session.home).directory,
        wallet: ctx.selected.name,
        schema: registeredAgentProfileSchema,
      });
      const snapshot = await taskMoneySnapshot(ctx.client, input.id, undefined, ctx);
      const payment = await fundTaskWithX402(ctx, {
        id: input.id,
        ...(input.counterparty === undefined ? {} : { counterparty: input.counterparty }),
        snapshot,
        policy,
        caps: await spendCapsForWallet(options.wallets!, ctx.selected.name),
        wallet: ctx.selected.name,
        ledgerPath: options.ledgerPath ?? getVapiPaths(home).ledger,
        config: await loadConfig(getVapiPaths(home).config),
        now,
        unlock: async () => (await options.session.payment(ctx.selected.name)).account,
        fetchImpl: options.fetchImpl,
        approval: { granted: false },
      });
      if (payment) {
        const wait =
          input.wait && payment.ok
            ? await waitAfterChain(ctx, input.id, payment.milestoneId, "locked")
            : null;
        return taskResult({ ...payment, wait }, !payment.ok);
      }
      const outcome = await fundTaskOperation(ctx, {
        id: input.id,
        snapshot,
        ...(input.counterparty === undefined ? {} : { counterparty: input.counterparty }),
        policy,
        caps: await spendCapsForWallet(options.wallets!, ctx.selected.name),
        wallet: ctx.selected.name,
        ledgerPath: options.ledgerPath ?? getVapiPaths(home).ledger,
        now,
        // Stdio has no human approval channel. Model arguments cannot grant approval.
        approval: { granted: false },
      });
      const wait =
        input.wait && outcome.ok
          ? await waitAfterChain(ctx, input.id, outcome.result.milestone.id, "locked")
          : null;
      return taskResult({ ...outcome, wait }, !outcome.ok);
    },
    async deliver(input: Input<typeof tasksDeliverTool>) {
      const ctx = await acting(input.wallet);
      if (input.proof || (await taskUsesV2(ctx, input.id))) {
        const view = await ctx.client.getOrder(input.id);
        if (view.workOrder.terms?.milestones?.length !== 1)
          throw new TaskInputError("Use tasks.milestone for multiple milestones.");
        const proof =
          input.proof ??
          (await Promise.all(
            (input.files ?? []).map(async (path) => {
              const file = await readTaskFile(path);
              const uploaded = await ctx.client.uploadFile(file);
              return { preset: "file" as const, value: uploaded.file.sha256 };
            }),
          ));
        const result = await maybeV2(input, { action: "submit", i: 0, proof });
        if (result) return result;
      }
      if (!input.files?.length || !input.note)
        throw new TaskInputError("Delivery files and note are required.");
      const files = (await Promise.all(input.files.map(readTaskFile))).map(
        ({ fileName: name, bytes, contentType }) => ({ name, bytes, contentType }),
      );
      const outcome = await deliverTaskOperation(ctx, {
        id: input.id,
        ...(input.counterparty === undefined ? {} : { counterparty: input.counterparty }),
        files,
        note: input.note,
      });
      const wait = input.wait
        ? await waitAfterChain(ctx, input.id, outcome.result.milestone.id, "delivered")
        : null;
      return taskResult({ ...outcome, wait });
    },
    async release(input: Input<typeof tasksReleaseTool>) {
      const ctx = await acting(input.wallet);
      if (await taskUsesV2(ctx, input.id)) {
        const view = await ctx.client.getOrder(input.id);
        if (view.workOrder.terms?.milestones?.length !== 1)
          throw new TaskInputError("Use tasks.milestone for multiple milestones.");
        const result = await maybeV2(input, {
          action: input.finalize ? "finalize" : "approve",
          i: 0,
        });
        if (result) return result;
      }
      const outcome = await releaseTaskOperation(ctx, {
        id: input.id,
        ...(input.counterparty === undefined ? {} : { counterparty: input.counterparty }),
      });
      const wait = input.wait
        ? await waitAfterChain(ctx, input.id, outcome.result.milestone.id, "released")
        : null;
      return taskResult({ ...outcome, wait });
    },
    async refund(input: Input<typeof tasksRefundTool>) {
      const prepared = await maybeV2(input, { action: "refund" });
      if (prepared) return prepared;
      return taskResult(
        await refundTaskOperation(await acting(input.wallet), {
          id: input.id,
          ...(input.counterparty === undefined ? {} : { counterparty: input.counterparty }),
        }),
      );
    },
    async dispute(input: Input<typeof tasksDisputeTool>) {
      if (input.i !== undefined)
        return v2(
          input,
          taskV2ActionSchema.parse({
            action:
              input.action === "split"
                ? "split"
                : input.action === "resolve-unmatched"
                  ? "resolve-unmatched"
                  : "raise-dispute",
            i: input.i,
            ...(input.action === "split"
              ? { toWorker: input.toWorker }
              : input.action === "resolve-unmatched"
                ? {}
                : { evidence: input.evidence }),
          }),
        );
      if (!input.evidenceHash)
        throw new TaskInputError("V1 evidenceHash or V2 i and evidence is required.");
      return feeAction("dispute", input);
    },
    async counterEvidence(input: Input<typeof tasksCounterEvidenceTool>) {
      if (input.i !== undefined)
        return v2(
          input,
          taskV2ActionSchema.parse({
            action: "counter-evidence",
            i: input.i,
            evidence: input.evidence,
          }),
        );
      if (!input.evidenceHash)
        throw new TaskInputError("V1 evidenceHash or V2 i and evidence is required.");
      return feeAction("counter-evidence", input);
    },
    async resolveUnmatched(input: Input<typeof tasksResolveUnmatchedTool>) {
      if (input.i !== undefined) return v2(input, { action: "resolve-unmatched", i: input.i });
      return taskResult(
        await resolveUnmatchedTaskOperation(await acting(input.wallet), {
          id: input.id,
          ...(input.counterparty === undefined ? {} : { counterparty: input.counterparty }),
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
      if (input.operationId) {
        if (!input.step) throw new TaskInputError("A V2 step is required with operationId.");
        return taskResult(
          await recoverTaskV2(
            { ...(await acting(input.wallet)), ...(options.sleep ? { sleep: options.sleep } : {}) },
            {
              id: input.id,
              operationId: input.operationId,
              step: input.step,
              abandon: input.abandon,
            },
          ),
        );
      }
      await options.wallets?.reload();
      const publicOnly =
        input.wallet === undefined &&
        options.session.activeName === undefined &&
        options.wallets !== undefined &&
        options.wallets.names().length === 0;
      const candidate = await context(input.wallet, publicOnly);
      const ctx = candidate.token || publicOnly ? candidate : await context(undefined, true);
      return taskResult(await taskStatus(ctx, { id: input.id, signedIn: Boolean(ctx.token) }));
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
    ...(error instanceof TaskOperationError ? error.details : {}),
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
