import { randomUUID } from "node:crypto";
import { basename } from "node:path";

import { z } from "zod";

import type { SpendCaps } from "../config.js";
import { decideFunding, decideRelease, type ReleaseDecision } from "../funding-policy.js";
import { escrowFundingDayRemainingAtomic, releaseSpend, reserveSpend } from "../spend-policy.js";
import type { WalletName } from "../wallet-name.js";
import { canonicalJson } from "./canonical-json.js";
import {
  TasksChainError,
  TasksChainUnavailableError,
  type TaskMilestone,
  type TasksChain,
  type TasksChainResult,
} from "./chain-port.js";
import type { TasksClient } from "./client.js";
import { prepareDeliveryManifest, type FrozenDeliveryManifest } from "./delivery-manifest.js";
import { formatBaseUnitsUsd, parseFeeBp, taskMoney, type TaskMoney } from "./money.js";
import { freezeScopeTerms } from "./scope-terms.js";
import {
  deliverEscrowInputSchema,
  disputeEscrowInputSchema,
  type GetOrderResponse,
  type SignScopeResponse,
  type UploadFileInput,
} from "./types.js";

/** A milestone ID selects a tranche within this order; no implicit selection across tranches. */
export type TaskTarget = { orderId: string; escrowId?: string };
export type TaskActionInput = TaskTarget & {
  client: TasksClient;
  chain: TasksChain;
  /** Retain one UUID across transport retries; reconcile an existing funding reservation separately. */
  idempotencyKey?: () => string;
};

export type FundingSummary = { money: TaskMoney; dayRemainingUsd: number };
/** Without approval, an amount above the threshold returns approval_needed. */
export type TaskFundingApproval =
  { granted: true } | { granted: false } | { ask: (summary: FundingSummary) => Promise<boolean> };

export type FundTaskInput = TaskActionInput & {
  policy: { maxPerTaskUsd: number; approveAboveUsd: number };
  caps: SpendCaps;
  wallet: WalletName;
  ledgerPath: string;
  now: () => Date;
  approval?: TaskFundingApproval;
};

export type FundTaskOutcome =
  | { outcome: "refused"; reason: "policy.perTask" | "policy.perDay"; money: TaskMoney }
  | { outcome: "approval_needed"; money: TaskMoney }
  | { outcome: "declined"; money: TaskMoney }
  | { outcome: "done"; money: TaskMoney; result: TasksChainResult };

export async function fundTask(input: FundTaskInput): Promise<FundTaskOutcome> {
  const milestone = await resolveMilestone(input);
  const money = await milestoneMoney(input.client, milestone);
  const grossAtomic = BigInt(money.gross.baseUnits);
  const maxPerTaskAtomic = policyAtomic(input.policy.maxPerTaskUsd);
  const approveAboveAtomic = policyAtomic(input.policy.approveAboveUsd);
  const dayRemainingAtomic = await escrowFundingDayRemainingAtomic({
    caps: input.caps,
    ledgerPath: input.ledgerPath,
    wallet: input.wallet,
    now: input.now(),
  });
  const dayRemainingUsd = Number(formatBaseUnitsUsd(dayRemainingAtomic));
  const decision = decideFunding({
    amountUsd: Number(money.gross.usd),
    ...input.policy,
    dayRemainingUsd,
  });
  // The policy API uses numbers. Compare atomic units too, so floating-point
  // precision cannot bypass a cap or approval at large or fractional amounts.
  if (grossAtomic > maxPerTaskAtomic)
    return { outcome: "refused", reason: "policy.perTask", money };
  if (grossAtomic > dayRemainingAtomic)
    return { outcome: "refused", reason: "policy.perDay", money };
  if ("ok" in decision && !decision.ok)
    return { outcome: "refused", reason: decision.reason, money };
  if ("approval" in decision || grossAtomic > approveAboveAtomic) {
    if (input.approval && "ask" in input.approval) {
      if (!(await input.approval.ask({ money, dayRemainingUsd })))
        return { outcome: "declined", money };
    } else if (!input.approval?.granted) {
      return { outcome: "approval_needed", money };
    }
  }
  requireChain(input.chain);
  const idempotencyKey = operationKey(input);
  // Reserve only after policy, approval, and chain availability. A raced cap
  // failure propagates as SpendCapError; refusal outcomes above stay read-only.
  const reservation = await reserveSpend(grossAtomic, input.caps, {
    kind: "escrow-funding",
    maxPerTaskAtomic,
    wallet: input.wallet,
    ledgerPath: input.ledgerPath,
    now: input.now(),
    reservationId: idempotencyKey,
  });
  try {
    const result = await input.chain.fund({
      escrowId: milestone.id,
      grossBaseUnits: grossAtomic,
      idempotencyKey,
    });
    return { outcome: "done", money, result };
  } catch (error) {
    if (error instanceof TasksChainError && !error.broadcast && !error.authorizationExposed) {
      try {
        await releaseSpend(grossAtomic, {
          ledgerPath: input.ledgerPath,
          wallet: input.wallet,
          now: input.now(),
          reservedOn: reservation.date,
          reservationId: idempotencyKey,
        });
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          "Task funding failed and its spend reservation could not be released.",
          { cause: error },
        );
      }
    }
    throw error;
  }
}

export type TaskDeliveryFile = ({ path: string; name?: never } | { name: string; path?: never }) & {
  bytes: Uint8Array;
  contentType: UploadFileInput["contentType"];
};

export type PrepareDeliveryInput = TaskTarget & {
  client: TasksClient;
  files: TaskDeliveryFile[];
  note: string;
};

export type PreparedTaskDelivery = {
  escrowId: string;
  manifest: FrozenDeliveryManifest;
  note: string;
};

export async function prepareDelivery(input: PrepareDeliveryInput): Promise<PreparedTaskDelivery> {
  // Validate before creating uploads; file IDs are only known after finalization.
  deliverEscrowInputSchema.shape.note.parse(input.note);
  if (input.files.length < 1 || input.files.length > 20)
    throw new Error("Upload between one and twenty delivery files.");
  const milestone = await resolveMilestone(input);
  const metadata = [];
  for (const file of input.files) {
    const uploaded = await input.client.uploadFile({
      fileName: file.name ?? basename(file.path!),
      bytes: file.bytes,
      contentType: file.contentType,
      purpose: "delivery",
    });
    metadata.push({
      fileId: uploaded.file.id,
      fileName: uploaded.file.fileName,
      sha256: uploaded.file.sha256,
      sizeBytes: uploaded.file.sizeBytes,
    });
  }
  return {
    escrowId: milestone.id,
    manifest: await prepareDeliveryManifest(metadata, input.note),
    note: input.note,
  };
}

export type DeliverTaskInput = PrepareDeliveryInput &
  Pick<TaskActionInput, "chain" | "idempotencyKey">;
export type DeliverTaskResult = PreparedTaskDelivery & {
  manifestHash: `0x${string}`;
  result: TasksChainResult;
};

export async function deliverTask(input: DeliverTaskInput): Promise<DeliverTaskResult> {
  const prepared = await prepareDelivery(input);
  requireChain(input.chain, prepared.manifest.manifestHash);
  try {
    const result = await input.chain.deliver({ ...prepared, idempotencyKey: operationKey(input) });
    return { ...prepared, manifestHash: prepared.manifest.manifestHash, result };
  } catch (error) {
    if (error instanceof TasksChainUnavailableError)
      throw new TasksChainUnavailableError(prepared.manifest.manifestHash);
    throw error;
  }
}

export type TaskMoneyResult = { money: TaskMoney; result: TasksChainResult };

export async function releaseTask(input: TaskActionInput): Promise<TaskMoneyResult> {
  const milestone = await resolveMilestone(input);
  const money = await milestoneMoney(input.client, milestone);
  requireChain(input.chain);
  const result = await input.chain.release({
    escrowId: milestone.id,
    idempotencyKey: operationKey(input),
  });
  return { money, result };
}

export async function refundTask(input: TaskActionInput): Promise<TaskMoneyResult> {
  const milestone = await resolveMilestone(input);
  const money = await milestoneMoney(input.client, milestone);
  requireChain(input.chain);
  const result = await input.chain.refund({
    escrowId: milestone.id,
    idempotencyKey: operationKey(input),
  });
  return { money, result };
}

export type DisputeTaskInput = TaskActionInput & { evidenceHash: string };
export type DisputeTaskResult = TaskMoneyResult & { disputeFee: null; disputeFeeNote: string };

export async function disputeTask(input: DisputeTaskInput): Promise<DisputeTaskResult> {
  const { evidenceHash } = disputeEscrowInputSchema.parse({ evidenceHash: input.evidenceHash });
  const milestone = await resolveMilestone(input);
  const money = await milestoneMoney(input.client, milestone);
  requireChain(input.chain);
  const result = await input.chain.dispute({
    escrowId: milestone.id,
    evidenceHash,
    idempotencyKey: operationKey(input),
  });
  return {
    money,
    result,
    disputeFee: null,
    disputeFeeNote: "The contract charges a dispute fee; the amount is unavailable.",
  };
}

export function autoReleaseDecision(input: {
  amountUsd: number;
  autoReleaseBelowUsd: number;
}): ReleaseDecision {
  return decideRelease(input);
}

export type SignScopeActionInput = {
  client: TasksClient;
  chain: TasksChain;
  orderId: string;
  role: "poster" | "worker";
  /** Local EIP-191 signer, invoked only after validating the current scope. */
  signMessage?: (message: string) => Promise<`0x${string}`>;
  idempotencyKey?: () => string;
};
export type SignedScopeTerms = {
  amountBaseUnits: string;
  asset: string;
  network: `eip155:${number}`;
  deadline: string;
  deliverables: string[];
  title: string;
};
export type SignScopeAcceptance = SignScopeResponse & { terms: SignedScopeTerms };
export type SignScopeActionResult = SignScopeAcceptance & {
  escrowCreation: TasksChainResult | null;
};

/** The acceptance response arrived; inspect it before retrying a follow-up separately. */
export class TasksScopeCreationError extends Error {
  readonly broadcast: boolean;

  constructor(
    readonly acceptance: SignScopeAcceptance,
    cause: unknown,
  ) {
    super("The accepted scope follow-up failed.", { cause });
    this.name = "TasksScopeCreationError";
    this.broadcast = mayHaveBroadcast(cause);
  }
}

export async function signScope(input: SignScopeActionInput): Promise<SignScopeActionResult> {
  const order = await privateOrder(input.client, input.orderId);
  const actingRole = input.role === "poster" ? "client" : "provider";
  if (order.role !== actingRole) throw new Error("The acting party does not match the task role.");
  const { scopes } = await input.client.getScopes(input.orderId);
  const current = new Map<number, (typeof scopes)[number]>();
  for (const scope of scopes) {
    if (scope.workOrderId !== input.orderId)
      throw new Error("The scope belongs to a different task.");
    const previous = current.get(scope.trancheOrdinal);
    if (!previous || scope.version > previous.version) current.set(scope.trancheOrdinal, scope);
    else if (scope.version === previous.version)
      throw new Error("The task has ambiguous scope versions.");
  }
  const candidates = [...current.values()].filter(
    (scope) => scope.state === "proposed" && scope.proposedByRole !== actingRole,
  );
  if (candidates.length !== 1)
    throw new Error("Select a task with one current counterparty scope.");
  const scope = candidates[0]!;
  const payload = scope.signingPayload;
  if (
    payload.workOrderId !== input.orderId ||
    payload.trancheOrdinal !== scope.trancheOrdinal ||
    payload.scopeVersion !== scope.version ||
    payload.termsHash !== scope.termsHash
  ) {
    throw new Error("The scope signing payload does not match the current task scope.");
  }
  let frozen;
  try {
    frozen = freezeScopeTerms(scope.structuredTerms, scope.brief);
    const expectedTermsHash = payload.termsHash ?? scope.termsHash;
    if (frozen.termsHash !== expectedTermsHash) throw new Error("Scope terms hash mismatch");
  } catch {
    throw new Error("The scope terms do not match their hash; refusing to sign.");
  }
  const terms: SignedScopeTerms = {
    amountBaseUnits: frozen.structured.budget.amountBaseUnits,
    asset: frozen.structured.budget.asset,
    network: frozen.structured.budget.network,
    deadline: frozen.structured.deadline,
    deliverables: frozen.structured.deliverables,
    title: frozen.structured.title,
  };
  const idempotencyKey = operationKey(input);
  const message = canonicalJson(payload);
  let signature: `0x${string}`;
  if (input.signMessage) signature = await input.signMessage(message);
  else {
    requireChain(input.chain);
    signature = await input.chain.signScopeMessage(message);
  }
  const acceptance = await input.client.signScope(
    scope.id,
    { signedPayload: payload, signature },
    { idempotencyKey },
  );
  const accepted = { ...acceptance, terms };
  try {
    if (
      acceptance.scope.id !== scope.id ||
      acceptance.scope.workOrderId !== input.orderId ||
      acceptance.scope.state !== "accepted" ||
      acceptance.scope.milestoneId !== acceptance.milestone.id ||
      acceptance.milestone.workOrderId !== input.orderId ||
      acceptance.milestone.ordinal !== scope.trancheOrdinal ||
      acceptance.milestone.termsHash !== payload.termsHash ||
      canonicalJson(acceptance.scope.signingPayload) !== canonicalJson(payload)
    ) {
      throw new Error("The accepted scope response does not match the task.");
    }
    if (input.role === "poster") return { ...accepted, escrowCreation: null };
    const fresh = await privateOrder(input.client, input.orderId);
    const milestone = fresh.milestones.find(
      (candidate) => candidate.id === acceptance.milestone.id,
    );
    if (
      !milestone ||
      milestone.workOrderId !== input.orderId ||
      milestone.ordinal !== scope.trancheOrdinal ||
      milestone.termsHash !== payload.termsHash
    )
      throw new Error("The accepted scope milestone is unavailable.");
    if (milestone.escrowState !== null) return { ...accepted, escrowCreation: null };
    // The prepare route chooses the earliest uncreated milestone. Do not create
    // a different tranche accidentally if older scope work is still pending.
    const earliest = fresh.milestones
      .filter((candidate) => candidate.escrowState === null)
      .sort((a, b) => a.ordinal - b.ordinal)[0];
    if (earliest?.id !== milestone.id)
      throw new Error("An earlier task milestone still needs escrow creation.");
    requireChain(input.chain);
    const escrowCreation = await input.chain.createEscrow({
      orderId: input.orderId,
      idempotencyKey: operationKey(input),
    });
    return { ...accepted, escrowCreation };
  } catch (error) {
    throw new TasksScopeCreationError(accepted, error);
  }
}

async function privateOrder(
  client: TasksClient,
  orderId: string,
): Promise<Extract<GetOrderResponse["workOrder"], { version: "work-order-view-v1" }>> {
  const { workOrder } = await client.getOrder(orderId);
  if (workOrder.id !== orderId || workOrder.version !== "work-order-view-v1")
    throw new Error("A private task order matching the requested ID is required.");
  return workOrder;
}

async function resolveMilestone(
  input: TaskTarget & { client: TasksClient },
): Promise<TaskMilestone> {
  const workOrder = await privateOrder(input.client, input.orderId);
  const matches =
    input.escrowId === undefined
      ? workOrder.milestones
      : workOrder.milestones.filter((milestone) => milestone.id === input.escrowId);
  if (matches.length !== 1) throw new Error("Select one task milestone by escrow ID.");
  const milestone = matches[0]!;
  if (milestone.workOrderId !== input.orderId)
    throw new Error("The milestone belongs to a different task.");
  // The frozen amount is getOrder.workOrder.milestones[].amountBaseUnits.
  // /v1/escrows/:id uses milestone.id, not the onchain escrowContract address.
  return milestone;
}

async function milestoneMoney(client: TasksClient, milestone: TaskMilestone): Promise<TaskMoney> {
  let deployment: unknown;
  try {
    deployment = await client.deployment();
  } catch {
    /* Readiness failure leaves the fee unavailable. */
  }
  return taskMoney(milestone.amountBaseUnits, parseFeeBp(deployment));
}

function requireChain(chain: TasksChain, manifestHash?: `0x${string}`): void {
  if (!chain.available) throw new TasksChainUnavailableError(manifestHash);
}

function operationKey(input: { idempotencyKey?: () => string }): string {
  return z.uuid().parse((input.idempotencyKey ?? randomUUID)());
}

function mayHaveBroadcast(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && "broadcast" in error && error.broadcast === true
  );
}

/** Floor policy USD to atomic units, including scientific notation, never round a cap up. */
function policyAtomic(value: number): bigint {
  if (!Number.isFinite(value) || value < 0)
    throw new Error("Task policy USD amounts must be finite and non-negative.");
  const [mantissa = "0", exponent = "0"] = value.toString().split("e");
  const [whole = "0", fraction = ""] = mantissa.split(".");
  const digits = BigInt(whole + fraction);
  const scale = 6 + Number(exponent) - fraction.length;
  return scale >= 0 ? digits * 10n ** BigInt(scale) : digits / 10n ** BigInt(-scale);
}
