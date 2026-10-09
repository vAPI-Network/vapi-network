export {
  PENDING_SERVER_ROUTES,
  TASK_LIMITS,
  TASK_WATCH_STATES,
  TaskInputError,
  TaskOperationError,
  cachedMoneyClient,
  fundingRefusalReason,
  isMissingTaskEntity,
  nextTaskEvents,
  orderReceipts,
  parseTaskDuration,
  proposalTerms,
  publicNotFoundFetch,
  readTaskFile,
  resolveTaskBearer,
  taskEventState,
  taskMoneySnapshot,
  taskPolicyForWallet,
  taskRequest,
  taskStateMatches,
  validTaskBrief,
} from "./operation-support.js";
export type {
  MoneySnapshot,
  ProposalTerms,
  TaskOperationContext,
  TaskPolicy,
  TaskRoute,
  TaskUnlock,
} from "./operation-support.js";

import {
  disputeTask,
  counterEvidenceTask,
  resolveUnmatchedTask,
  fundTask,
  prepareDelivery,
  refundTask,
  releaseTask,
  signScope,
  type SignScopeActionResult,
  type FundTaskOutcome,
  type TaskDeliveryFile,
  type TaskFundingApproval,
} from "./actions.js";
import { canonicalJson } from "./canonical-json.js";
import { TasksChainUnavailableError, type TasksChain } from "./chain-port.js";
import type { TasksClient } from "./client.js";
import type { PendingTransactions } from "./pending-transactions.js";
import { parseFeeBp, taskMoney, type TaskMoney } from "./money.js";
import {
  TASK_LIMITS,
  TaskInputError,
  TaskOperationError,
  cachedMoneyClient,
  fundingRefusalReason,
  orderReceipts,
  proposalTerms,
  taskMoneySnapshot,
  taskRequest,
  validTaskBrief,
  type MoneySnapshot,
  type TaskOperationContext,
  type TaskPolicy,
  type TaskUnlock,
} from "./operation-support.js";
import type {
  BoardQuery,
  CreateOrderInput,
  CreateOrderResponse,
  GetOrderResponse,
  ProposeResponse,
  SubmissionProof,
  SubmitResponse,
  UploadFileInput,
} from "./types.js";
import { submissionProofSchema, submitInputSchema } from "./types.js";
import type { SpendCaps } from "../config.js";
import type { WalletName } from "../wallet-name.js";
export async function searchTasks(
  context: TaskOperationContext,
  input: { tab?: BoardQuery["tab"]; limit?: number; open?: boolean; min?: bigint },
) {
  const board = await taskRequest(
    "search",
    "board",
    () =>
      context.client.board({
        ...(input.tab ? { tab: input.tab } : {}),
        ...(input.limit === undefined ? {} : { limit: input.limit }),
      }),
    context,
  );
  const accepts = (task: (typeof board.cards)[number]) =>
    (!input.open || task.state === "open") &&
    (input.min === undefined || (task.amount !== null && BigInt(task.amount.gross) >= input.min));
  return {
    ...board,
    cards: board.cards.filter(accepts),
    pinned: board.pinned && accepts(board.pinned) ? board.pinned : null,
  };
}
export async function postTask(
  context: TaskOperationContext,
  input: {
    order: CreateOrderInput;
    amount: bigint;
    intake?: "proposals" | "submissions";
    maxAwards?: number;
    deadlineAt: string;
    webhook?: string;
    onFeeUnavailable?: () => void;
  },
): Promise<{
  result: CreateOrderResponse & { webhook?: Awaited<ReturnType<TasksClient["configureWebhook"]>> };
  money: TaskMoney;
  feeUnavailable: boolean;
  unsupportedFields: string[];
  postingMovesMoney: false;
}> {
  let deployment: Awaited<ReturnType<TasksClient["deployment"]>>;
  try {
    deployment = await context.client.deployment();
  } catch {
    input.onFeeUnavailable?.();
    throw new TaskOperationError(
      "deployment_unavailable",
      "The Tasks deployment is unavailable, so the market network cannot be selected.",
    );
  }
  const feeBp = parseFeeBp(deployment);
  const feeUnavailable = feeBp === null;
  if (feeUnavailable) input.onFeeUnavailable?.();
  const money = taskMoney(input.amount, feeBp);
  const result = await taskRequest(
    "post",
    "createOrder",
    () =>
      context.client.createOrder(
        {
          ...input.order,
          market: {
            intake: input.intake ?? "proposals",
            maxAwards: input.maxAwards ?? 1,
            audience: "anyone",
            proofKinds: input.intake === "submissions" ? ["url", "file"] : [],
            budget: {
              network: deployment.network,
              asset: "USDC",
              amountBaseUnits: input.amount.toString(),
            },
            deadlineAt: input.deadlineAt,
          },
        },
        { idempotencyKey: context.randomUUID() },
      ),
    context,
  );
  let webhook: Awaited<ReturnType<TasksClient["configureWebhook"]>> | undefined;
  if (input.webhook !== undefined) {
    try {
      webhook = await taskRequest(
        "post",
        "configureWebhook",
        () => context.client.configureWebhook(result.workOrder.id, { url: input.webhook! }),
        context,
      );
    } catch (error) {
      if (error instanceof TaskOperationError) {
        throw new TaskOperationError(
          error.code,
          `Task ${result.workOrder.id} was created, but its webhook was not configured: ${error.message}`,
          error.manifestHash,
        );
      }
      throw error;
    }
  }
  return {
    result: webhook === undefined ? result : { ...result, webhook },
    money,
    feeUnavailable,
    unsupportedFields: [],
    postingMovesMoney: false,
  };
}
export async function proposeTask(
  context: TaskOperationContext,
  input: { id: string; price: bigint; durationSeconds: number; note: string; unlock: TaskUnlock },
): Promise<ProposeResponse> {
  const { workOrder } = await taskRequest(
    "propose",
    "getOrder",
    () => context.client.getOrder(input.id),
    context,
  );
  if (workOrder.id !== input.id)
    throw new TaskOperationError("invalid_response", "The response belongs to a different task.");
  const deployment = await taskRequest(
    "propose",
    "deployment",
    () => context.client.deployment(),
    context,
  );
  if (!deployment.configured)
    throw new TaskOperationError("not_available", "Task escrow deployment is unavailable.");
  const account = await input.unlock();
  const terms = {
    title: workOrder.title,
    description:
      input.note.length >= TASK_LIMITS.briefMin
        ? input.note
        : `${workOrder.description}\n\n${input.note}`,
    amount: input.price,
    durationSeconds: input.durationSeconds,
  };
  const payload = proposalTerms(input.id, account.address, deployment, terms);
  if (!validTaskBrief(terms.title, terms.description))
    throw new TaskInputError("The proposal terms do not fit the current task contract.");
  const signature = await account.signMessage(canonicalJson(payload));
  return await taskRequest(
    "propose",
    "propose",
    () =>
      context.client.propose(
        input.id,
        { signedPayload: payload, signature },
        { idempotencyKey: context.randomUUID() },
      ),
    context,
  );
}
export async function submitTask(
  context: TaskOperationContext,
  input: { id: string; proof: SubmissionProof[]; files: UploadFileInput[]; unlock: TaskUnlock },
): Promise<SubmitResponse> {
  const task = await taskRequest(
    "submit",
    "publicTask",
    () => context.client.publicTask(input.id),
    context,
  );
  if (!task) throw new TaskOperationError("not_found", `Task ${input.id} was not found.`);
  if (task.id !== input.id)
    throw new TaskOperationError("invalid_response", "The response belongs to a different task.");
  const durationSeconds = task.durationSeconds;
  if (
    durationSeconds === null ||
    !Number.isInteger(durationSeconds) ||
    durationSeconds < TASK_LIMITS.proposalDurationMinMs / TASK_LIMITS.proposalDurationUnitMs ||
    durationSeconds > TASK_LIMITS.proposalDurationMaxMs / TASK_LIMITS.proposalDurationUnitMs
  )
    throw new TaskOperationError(
      "not_available",
      "The task needs a duration between 10 minutes and 90 days for signed submission terms.",
    );
  const deployment = await taskRequest(
    "submit",
    "deployment",
    () => context.client.deployment(),
    context,
  );
  if (!deployment.configured)
    throw new TaskOperationError("not_available", "Task escrow deployment is unavailable.");
  if (task.amount === null) {
    throw new TaskInputError("Task amount is unavailable.");
  }
  let amount: bigint;
  try {
    amount = BigInt(task.amount.gross);
  } catch {
    throw new TaskInputError("Task amount must be valid base units.");
  }
  if (amount === 0n || amount >= 1n << 256n)
    throw new TaskInputError("Task amount must be positive and fit an escrow amount.");
  const account = await input.unlock();
  const signedPayload = proposalTerms(input.id, account.address, deployment, {
    title: task.title,
    description: task.briefFull,
    amount,
    durationSeconds,
  });
  if (!validTaskBrief(task.title, task.briefFull))
    throw new TaskOperationError(
      "invalid_response",
      "The task terms do not fit the current submission contract.",
    );
  const proof = [...input.proof];
  for (const file of input.files) {
    const uploaded = await taskRequest(
      "submit",
      "uploadFile",
      () => context.client.uploadFile(file),
      context,
    );
    const item = submissionProofSchema.safeParse({
      kind: "file",
      value: uploaded.file.sha256.toLowerCase(),
      label: file.fileName,
    });
    if (!item.success)
      throw new TaskOperationError("invalid_response", "The uploaded proof has an invalid sha256.");
    proof.push(item.data);
  }
  const payload = { ...signedPayload, kind: "submission" as const, proof };
  const signature = await account.signMessage(canonicalJson(payload));
  if (!submitInputSchema.safeParse({ signedPayload: payload, signature }).success)
    throw new TaskInputError("The submission terms do not fit the current task contract.");
  return await taskRequest(
    "submit",
    "submit",
    () =>
      context.client.submit(
        input.id,
        { signedPayload: payload, signature },
        { idempotencyKey: context.randomUUID() },
      ),
    context,
  );
}
export type PrivateTaskView = GetOrderResponse & {
  receipts: ReturnType<typeof orderReceipts>;
  receiptUrl?: string;
  receiptUrlSource?: "escrow";
};
export type PublicTaskView = {
  task: NonNullable<Awaited<ReturnType<TasksClient["publicTask"]>>>;
  receiptUrl?: string;
  receiptUrlSource?: "server";
};
export function showTask(
  context: TaskOperationContext,
  input: { id: string; signedIn: true },
): Promise<PrivateTaskView>;
export function showTask(
  context: TaskOperationContext,
  input: { id: string; signedIn: false },
): Promise<PublicTaskView>;
export function showTask(
  context: TaskOperationContext,
  input: { id: string; signedIn: boolean },
): Promise<PrivateTaskView | PublicTaskView>;
export async function showTask(
  context: TaskOperationContext,
  input: { id: string; signedIn: boolean },
): Promise<PrivateTaskView | PublicTaskView> {
  if (input.signedIn) {
    const result = await taskRequest(
      "show",
      "getOrder",
      () => context.client.getOrder(input.id),
      context,
    );
    if (result.workOrder.id !== input.id)
      throw new TaskOperationError("invalid_response", "The response belongs to a different task.");
    const receipts = orderReceipts(result.workOrder, context.baseUrl);
    return { ...result, receipts, ...(receipts[0] ?? {}) };
  }
  const task = await taskRequest(
    "show",
    "publicTask",
    () => context.client.publicTask(input.id),
    context,
  );
  if (!task) throw new TaskOperationError("not_found", `Task ${input.id} was not found.`);
  if (task.id !== input.id)
    throw new TaskOperationError("invalid_response", "The response belongs to a different task.");
  return {
    task,
    ...(task.receiptUrl
      ? { receiptUrl: task.receiptUrl, receiptUrlSource: "server" as const }
      : {}),
  };
}
export async function taskStatus(context: TaskOperationContext, input: { id: string }) {
  const task = await taskRequest(
    "status",
    "publicTask",
    () => context.client.publicTask(input.id),
    context,
  );
  if (!task) throw new TaskOperationError("not_found", `Task ${input.id} was not found.`);
  if (task.id !== input.id)
    throw new TaskOperationError("invalid_response", "The response belongs to a different task.");
  return {
    task,
    ...(task.receiptUrl
      ? { receiptUrl: task.receiptUrl, receiptUrlSource: "server" as const }
      : {}),
  };
}
export async function awardTask(
  context: TaskOperationContext,
  input: { id: string; proposalId: string },
) {
  return await taskRequest(
    "award",
    "acceptProposal",
    () =>
      context.client.acceptProposal(
        input.id,
        { proposalId: input.proposalId },
        { idempotencyKey: context.randomUUID() },
      ),
    context,
  );
}
export async function messageTask(
  context: TaskOperationContext,
  input: { id: string; body: string },
) {
  return await taskRequest(
    "message",
    "sendMessage",
    () =>
      context.client.sendMessage(
        input.id,
        { body: input.body },
        { idempotencyKey: context.randomUUID() },
      ),
    context,
  );
}
export async function threadTask(
  context: TaskOperationContext,
  input: { id: string; cursor?: number },
) {
  return await taskRequest(
    "thread",
    "listMessages",
    () =>
      context.client.listMessages(
        input.id,
        input.cursor === undefined ? {} : { beforeSeq: input.cursor },
      ),
    context,
  );
}
export async function signTaskScope(
  context: TaskOperationContext,
  input: {
    id: string;
    counterparty?: string;
    signMessage: (message: string) => Promise<`0x${string}`>;
    bindings?: Parameters<typeof signScope>[0]["bindings"];
    onTerms?: Parameters<typeof signScope>[0]["onTerms"];
  },
): Promise<SignScopeActionResult> {
  const order = await taskRequest(
    "sign",
    "getOrder",
    () => context.client.getOrder(input.id),
    context,
  );
  if (order.workOrder.id !== input.id || order.workOrder.version !== "work-order-view-v1")
    throw new TaskOperationError(
      "invalid_response",
      "A private task order matching the requested ID is required.",
    );
  if (order.workOrder.role === "proposer")
    throw new TaskOperationError("wrong_role", "A proposer cannot sign this task scope.");
  const role = order.workOrder.role === "provider" ? "worker" : "poster";
  return await taskRequest(
    "sign",
    "signScope",
    () =>
      signScope({
        client: context.client,
        chain: context.chain,
        orderId: input.id,
        role,
        signMessage: input.signMessage,
        ...(input.counterparty === undefined ? {} : { counterparty: input.counterparty }),
        ...(input.bindings === undefined ? {} : { bindings: input.bindings }),
        ...(input.onTerms === undefined ? {} : { onTerms: input.onTerms }),
        idempotencyKey: context.randomUUID,
      }),
    context,
  );
}
export async function deliverTaskOperation(
  context: TaskOperationContext,
  input: {
    id: string;
    files: TaskDeliveryFile[];
    counterparty?: string;
    note: string;
    onPrepared?: (manifestHash: `0x${string}`) => void;
  },
) {
  const prepared = await taskRequest(
    "deliver",
    "getOrder",
    () =>
      prepareDelivery({
        client: context.client,
        ...(context.pending ? { pending: context.pending } : {}),
        orderId: input.id,
        files: input.files,
        note: input.note,
      }),
    context,
  );
  const manifestHash = prepared.manifest.manifestHash;
  input.onPrepared?.(manifestHash);
  const result = await taskRequest(
    "deliver",
    "deliverEscrow",
    async () => {
      if (!context.chain.available) throw new TasksChainUnavailableError(manifestHash);
      return await context.chain.deliver({
        ...prepared,
        ...(input.counterparty === undefined ? {} : { counterparty: input.counterparty }),
        idempotencyKey: context.randomUUID(),
      });
    },
    context,
  );
  return { ok: true as const, manifestHash, result };
}
export async function fundTaskOperation(
  context: TaskOperationContext & { pending?: PendingTransactions },
  input: {
    id: string;
    snapshot?: MoneySnapshot;
    policy: TaskPolicy;
    caps: SpendCaps;
    wallet: WalletName;
    ledgerPath: string;
    now: () => Date;
    approval?: TaskFundingApproval;
    idempotencyKey?: () => string;
    beforeChainFund?: () => void;
    counterparty?: string;
  },
) {
  const snapshot =
    input.snapshot ?? (await taskMoneySnapshot(context.client, input.id, undefined, context));
  const client = cachedMoneyClient(context.client, snapshot);
  const chain = new Proxy(context.chain, {
    get(target, property) {
      if (property === "fund")
        return async (value: Parameters<TasksChain["fund"]>[0]) => {
          input.beforeChainFund?.();
          return await target.fund(value);
        };
      const item = Reflect.get(target, property, target) as unknown;
      return typeof item === "function" ? item.bind(target) : item;
    },
  });
  let outcome;
  try {
    outcome = await taskRequest(
      "fund",
      "fundEscrow",
      () =>
        fundTask({
          client,
          chain,
          orderId: input.id,
          ...(input.counterparty === undefined ? {} : { counterparty: input.counterparty }),
          policy: input.policy,
          caps: input.caps,
          wallet: input.wallet,
          ledgerPath: input.ledgerPath,
          now: input.now,
          ...(context.pending === undefined ? {} : { pending: context.pending }),
          ...(input.approval ? { approval: input.approval } : {}),
          idempotencyKey: input.idempotencyKey ?? context.randomUUID,
        }),
      context,
    );
  } catch (error) {
    const reason = fundingRefusalReason(error);
    if (!reason) throw error;
    return {
      ok: false as const,
      reason,
      money: snapshot.money,
      policySource: input.policy.source,
      policyDecision: reason,
    };
  }
  if (outcome.outcome === "refused")
    return {
      ok: false as const,
      reason: outcome.reason,
      money: outcome.money,
      policySource: input.policy.source,
      policyDecision: outcome.reason,
    };
  if (outcome.outcome === "approval_needed")
    return {
      ok: false as const,
      approval: true as const,
      money: outcome.money,
      policySource: input.policy.source,
      policyDecision: "approval" as const,
    };
  if (outcome.outcome === "declined")
    return {
      ok: false as const,
      declined: true as const,
      money: outcome.money,
      policySource: input.policy.source,
      policyDecision: "declined" as const,
    };
  return {
    ok: true as const,
    money: outcome.money,
    policySource: input.policy.source,
    policyDecision: "ok" as const,
    result: outcome.result,
  };
}
export async function releaseTaskOperation(
  context: TaskOperationContext,
  input: { id: string; snapshot?: MoneySnapshot; escrowId?: string; counterparty?: string },
) {
  const snapshot =
    input.snapshot ?? (await taskMoneySnapshot(context.client, input.id, input.escrowId, context));
  return await taskRequest(
    "release",
    "releaseEscrow",
    () =>
      releaseTask({
        client: cachedMoneyClient(context.client, snapshot),
        chain: context.chain,
        orderId: input.id,
        escrowId: snapshot.escrowId,
        ...(input.counterparty === undefined ? {} : { counterparty: input.counterparty }),
        idempotencyKey: context.randomUUID,
      }),
    context,
  );
}
export async function refundTaskOperation(
  context: TaskOperationContext,
  input: { id: string; snapshot?: MoneySnapshot; escrowId?: string; counterparty?: string },
) {
  const snapshot =
    input.snapshot ?? (await taskMoneySnapshot(context.client, input.id, input.escrowId, context));
  return await taskRequest(
    "refund",
    "refundEscrow",
    () =>
      refundTask({
        client: cachedMoneyClient(context.client, snapshot),
        chain: context.chain,
        orderId: input.id,
        escrowId: snapshot.escrowId,
        ...(input.counterparty === undefined ? {} : { counterparty: input.counterparty }),
        idempotencyKey: context.randomUUID,
      }),
    context,
  );
}
export type TaskFeeOperationInput = {
  id: string;
  snapshot?: MoneySnapshot;
  escrowId?: string;
  counterparty?: string;
  evidenceHash: string;
  policy: TaskPolicy;
  caps: SpendCaps;
  wallet: WalletName;
  ledgerPath: string;
  now: () => Date;
  approval?: TaskFundingApproval;
  onFee?: (fee: bigint) => void;
};

export function disputeTaskOperation(context: TaskOperationContext, input: TaskFeeOperationInput) {
  return feeTaskOperation("dispute", context, input);
}

export function counterEvidenceTaskOperation(
  context: TaskOperationContext,
  input: TaskFeeOperationInput,
) {
  return feeTaskOperation("counter-evidence", context, input);
}

async function feeTaskOperation(
  verb: "dispute" | "counter-evidence",
  context: TaskOperationContext,
  input: TaskFeeOperationInput,
) {
  const snapshot =
    input.snapshot ?? (await taskMoneySnapshot(context.client, input.id, input.escrowId, context));
  let feeMoney: TaskMoney | undefined;
  const chain = new Proxy(context.chain, {
    get(target, property) {
      if (property === "disputeFee")
        return async (value: Parameters<TasksChain["disputeFee"]>[0]) => {
          const fee = await target.disputeFee(value);
          feeMoney = taskMoney(fee, 0);
          input.onFee?.(fee);
          return fee;
        };
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  let outcome: FundTaskOutcome & { disputeFee: { baseUnits: string; usd: string } };
  try {
    outcome = await taskRequest(
      verb,
      verb === "dispute" ? "disputeEscrow" : "counterEvidenceEscrow",
      () =>
        (verb === "dispute" ? disputeTask : counterEvidenceTask)({
          client: cachedMoneyClient(context.client, snapshot),
          chain,
          orderId: input.id,
          escrowId: snapshot.escrowId,
          ...(input.counterparty === undefined ? {} : { counterparty: input.counterparty }),
          evidenceHash: input.evidenceHash,
          policy: input.policy,
          caps: input.caps,
          wallet: input.wallet,
          ledgerPath: input.ledgerPath,
          now: input.now,
          ...(context.pending === undefined ? {} : { pending: context.pending }),
          ...(input.approval === undefined ? {} : { approval: input.approval }),
          idempotencyKey: context.randomUUID,
        }),
      context,
    );
  } catch (error) {
    const reason = fundingRefusalReason(error);
    if (!reason || !feeMoney) throw error;
    return {
      ok: false as const,
      reason,
      money: feeMoney,
      disputeFee: feeMoney.gross,
      policySource: input.policy.source,
      policyDecision: reason,
    };
  }
  const common = {
    money: outcome.money,
    disputeFee: outcome.disputeFee,
    policySource: input.policy.source,
  };
  if (outcome.outcome === "refused")
    return {
      ...common,
      ok: false as const,
      reason: outcome.reason,
      policyDecision: outcome.reason,
    };
  if (outcome.outcome === "approval_needed")
    return {
      ...common,
      ok: false as const,
      approval: true as const,
      policyDecision: "approval" as const,
    };
  if (outcome.outcome === "declined")
    return {
      ...common,
      ok: false as const,
      declined: true as const,
      policyDecision: "declined" as const,
    };
  return { ...common, ok: true as const, result: outcome.result, policyDecision: "ok" as const };
}

export async function resolveUnmatchedTaskOperation(
  context: TaskOperationContext,
  input: { id: string; snapshot?: MoneySnapshot; escrowId?: string; counterparty?: string },
) {
  const snapshot =
    input.snapshot ?? (await taskMoneySnapshot(context.client, input.id, input.escrowId, context));
  return await taskRequest(
    "resolve-unmatched",
    "resolveUnmatchedEscrow",
    () =>
      resolveUnmatchedTask({
        client: cachedMoneyClient(context.client, snapshot),
        chain: context.chain,
        orderId: input.id,
        escrowId: snapshot.escrowId,
        ...(input.counterparty === undefined ? {} : { counterparty: input.counterparty }),
        idempotencyKey: context.randomUUID,
      }),
    context,
  );
}
