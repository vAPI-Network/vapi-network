import { randomUUID } from "node:crypto";
import { basename } from "node:path";

import {
  getAddress,
  isAddressEqual,
  recoverMessageAddress,
  verifyMessage,
  type Address,
  type Hex,
} from "viem";
import { z } from "zod";

import { getVapiPaths, type SpendCaps } from "../config.js";
import { decideFunding, decideRelease, type ReleaseDecision } from "../funding-policy.js";
import {
  escrowFundingDayRemainingAtomic,
  releaseSpend,
  reserveSpend,
  SpendCapError,
} from "../spend-policy.js";
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
import { taskFeeReservationKey } from "./dispute-fee.js";
import type { PendingTransactions } from "./pending-transactions.js";
import {
  freezeDeliveryManifest,
  prepareDeliveryManifest,
  sha256Hex,
  type FrozenDeliveryManifest,
} from "./delivery-manifest.js";
import { formatBaseUnitsUsd, parseFeeBp, taskMoney, type TaskMoney } from "./money.js";
import { freezeScopeTerms } from "./scope-terms.js";
import { createScopeBindings, type ScopeBinding, type ScopeBindings } from "./scope-bindings.js";
import {
  deliverEscrowInputSchema,
  disputeEscrowInputSchema,
  type GetOrderResponse,
  type SignScopeResponse,
  type UploadFileInput,
} from "./types.js";

/** A milestone ID selects a tranche within this order; no implicit selection across tranches. */
export type TaskTarget = { orderId: string; escrowId?: string; counterparty?: string };
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
  pending?: PendingTransactions;
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
  const existingReservationId = input.pending?.existingReservationId
    ? await input.pending.existingReservationId(milestone.id)
    : undefined;
  const retainedReservation = input.pending?.retainedReservation
    ? await input.pending.retainedReservation(milestone.id)
    : undefined;
  const today = input.now().toISOString().slice(0, 10);
  const maxPerTaskAtomic = policyAtomic(input.policy.maxPerTaskUsd);
  const approveAboveAtomic = policyAtomic(input.policy.approveAboveUsd);
  const dayRemainingAtomic = await escrowFundingDayRemainingAtomic({
    caps: input.caps,
    ledgerPath: input.ledgerPath,
    wallet: input.wallet,
    now: input.now(),
    ...(existingReservationId ? { reservationId: existingReservationId } : {}),
  });
  const dayRemainingUsd = Number(formatBaseUnitsUsd(dayRemainingAtomic));
  const resumedFromPriorDay =
    retainedReservation?.date !== undefined &&
    retainedReservation.date !== today &&
    retainedReservation.exposed === true &&
    retainedReservation.invalidated !== true;
  const decision = decideFunding({
    amountUsd: Number(money.gross.usd),
    ...input.policy,
    dayRemainingUsd: resumedFromPriorDay ? Number(money.gross.usd) : dayRemainingUsd,
  });
  // The policy API uses numbers. Compare atomic units too, so floating-point
  // precision cannot bypass a cap or approval at large or fractional amounts.
  if (grossAtomic > maxPerTaskAtomic)
    return { outcome: "refused", reason: "policy.perTask", money };
  if (grossAtomic > dayRemainingAtomic && !resumedFromPriorDay)
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
  const performFunding = async (): Promise<FundTaskOutcome> => {
    const currentReservation = input.pending?.retainedReservation
      ? await input.pending.retainedReservation(milestone.id)
      : retainedReservation;
    const idempotencyKey = input.pending
      ? await input.pending.reservationId(milestone.id, () => operationKey(input))
      : operationKey(input);
    // Reserve only after policy, approval, and chain availability. A raced cap
    // failure propagates as SpendCapError; refusal outcomes above stay read-only.
    const reservation = await reserveSpend(grossAtomic, input.caps, {
      kind: "escrow-funding",
      maxPerTaskAtomic,
      wallet: input.wallet,
      ledgerPath: input.ledgerPath,
      now: input.now(),
      reservationId: idempotencyKey,
      reuseExistingEscrowReservation: input.pending !== undefined,
      ...(currentReservation?.exposed === true && currentReservation.invalidated !== true
        ? { resumeEscrowReservation: currentReservation }
        : {}),
    });
    await input.pending?.bindReservation?.(milestone.id, {
      id: idempotencyKey,
      wallet: input.wallet,
      amountAtomic: grossAtomic.toString(),
      date: reservation.date,
    });
    try {
      const fundingOperation = {
        orderId: milestone.workOrderId,
        escrowId: milestone.id,
        grossBaseUnits: grossAtomic,
        ...(input.counterparty ? { counterparty: input.counterparty } : {}),
        idempotencyKey,
      };
      const result = await input.chain.fund(fundingOperation);
      return { outcome: "done", money, result };
    } catch (error) {
      const exposed = input.pending ? await input.pending.exposure(milestone.id) : false;
      if (
        !reservation.reservationReused &&
        !exposed &&
        error instanceof TasksChainError &&
        !error.broadcast &&
        !error.authorizationExposed
      ) {
        try {
          await input.pending?.invalidateReservation?.(milestone.id);
          await releaseSpend(grossAtomic, {
            ledgerPath: input.ledgerPath,
            wallet: input.wallet,
            now: input.now(),
            reservedOn: reservation.date,
            reservationId: idempotencyKey,
          });
          await input.pending?.clearReservation?.(milestone.id);
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
  };
  return input.pending
    ? input.pending.withFundingLock(milestone.id, performFunding)
    : performFunding();
}

export type TaskDeliveryFile = ({ path: string; name?: never } | { name: string; path?: never }) & {
  bytes: Uint8Array;
  contentType: UploadFileInput["contentType"];
};

export type PrepareDeliveryInput = TaskTarget & {
  client: TasksClient;
  pending?: PendingTransactions;
  files: TaskDeliveryFile[];
  note: string;
};

export type PreparedTaskDelivery = {
  orderId: string;
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
  const saved = await input.pending?.preparation(milestone.id, "deliver");
  if (saved) {
    const inputs = z
      .object({
        manifestHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
        manifest: z.unknown(),
        note: z.string(),
      })
      .strict()
      .parse(saved.inputs);
    const manifest = freezeDeliveryManifest(inputs.manifest);
    if (manifest.manifestHash !== inputs.manifestHash || input.note !== inputs.note)
      throw new Error("The saved delivery preparation does not match the local delivery.");
    const localFiles = await Promise.all(
      input.files.map(async (file) => ({
        fileName: file.name ?? basename(file.path!),
        sha256: await sha256Hex(file.bytes),
        sizeBytes: file.bytes.byteLength,
      })),
    );
    const identity = (file: { fileName: string; sha256: string; sizeBytes: number }) =>
      `${file.fileName}\0${file.sha256.toLowerCase()}\0${file.sizeBytes}`;
    const localIdentities = localFiles.map(identity).sort();
    const savedIdentities = manifest.manifest.files.map(identity).sort();
    if (canonicalJson(localIdentities) !== canonicalJson(savedIdentities))
      throw new Error("The saved delivery preparation does not match the local delivery files.");
    return { orderId: milestone.workOrderId, escrowId: milestone.id, manifest, note: input.note };
  }
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
    orderId: milestone.workOrderId,
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
    const result = await input.chain.deliver({
      ...prepared,
      idempotencyKey: operationKey(input),
      ...(input.counterparty ? { counterparty: input.counterparty } : {}),
    });
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
    orderId: milestone.workOrderId,
    escrowId: milestone.id,
    ...(input.counterparty ? { counterparty: input.counterparty } : {}),
    idempotencyKey: operationKey(input),
  });
  return { money, result };
}

export async function refundTask(input: TaskActionInput): Promise<TaskMoneyResult> {
  const milestone = await resolveMilestone(input);
  const money = await milestoneMoney(input.client, milestone);
  requireChain(input.chain);
  const result = await input.chain.refund({
    orderId: milestone.workOrderId,
    escrowId: milestone.id,
    ...(input.counterparty ? { counterparty: input.counterparty } : {}),
    idempotencyKey: operationKey(input),
  });
  return { money, result };
}

export type DisputeTaskInput = FundTaskInput & { evidenceHash: string };
export type DisputeTaskResult = FundTaskOutcome & {
  disputeFee: { baseUnits: string; usd: string };
};

export function disputeTask(input: DisputeTaskInput): Promise<DisputeTaskResult> {
  return feeTask(input, "dispute");
}

export function counterEvidenceTask(input: DisputeTaskInput): Promise<DisputeTaskResult> {
  return feeTask(input, "counter-evidence");
}

/** Fee reservations are separate for each party action and serialize with milestone funding. */
async function feeTask(
  input: DisputeTaskInput,
  action: "dispute" | "counter-evidence",
): Promise<DisputeTaskResult> {
  const { evidenceHash } = disputeEscrowInputSchema.parse({ evidenceHash: input.evidenceHash });
  const milestone = await resolveMilestone(input);
  requireChain(input.chain);
  const perform = async (): Promise<DisputeTaskResult> => {
    const operation = {
      orderId: milestone.workOrderId,
      escrowId: milestone.id,
      ...(input.counterparty ? { counterparty: input.counterparty } : {}),
      evidenceHash,
    };
    const feeAtomic = await input.chain.disputeFee({
      ...operation,
      idempotencyKey: operationKey(input),
    });
    const fee = { baseUnits: feeAtomic.toString(), usd: formatBaseUnitsUsd(feeAtomic) };
    const money = { ...taskMoney(feeAtomic.toString(), 0), line: `dispute fee $${fee.usd} USDC` };
    const reservationKey = taskFeeReservationKey(milestone.id, action);
    const retained = await input.pending?.retainedReservation?.(reservationKey);
    const preparation = await input.pending?.preparation(milestone.id, action);
    const submitted =
      milestone.chainOperation?.kind ===
        (action === "dispute" ? "escrow-dispute" : "escrow-counter-evidence") &&
      milestone.chainOperation.state !== "prepared";
    const resume =
      preparation !== undefined ||
      submitted ||
      (retained?.exposed === true && retained.invalidated !== true);
    const existingId = await input.pending?.existingReservationId?.(reservationKey);
    if (
      retained &&
      (retained.wallet !== input.wallet || retained.amountAtomic !== feeAtomic.toString())
    )
      throw new TasksChainError(
        "The retained dispute fee does not match this wallet and verified fee.",
        false,
        { authorizationExposed: retained.exposed === true },
      );
    let approvalGranted =
      input.approval !== undefined && "granted" in input.approval && input.approval.granted;
    const checkPolicy = async (reservationId?: string): Promise<DisputeTaskResult | undefined> => {
      const remaining = await escrowFundingDayRemainingAtomic({
        caps: input.caps,
        ledgerPath: input.ledgerPath,
        wallet: input.wallet,
        now: input.now(),
        ...(reservationId ? { reservationId } : {}),
      });
      if (feeAtomic > policyAtomic(input.policy.maxPerTaskUsd))
        return { outcome: "refused", reason: "policy.perTask", money, disputeFee: fee };
      if (feeAtomic > remaining)
        return { outcome: "refused", reason: "policy.perDay", money, disputeFee: fee };
      if (feeAtomic > policyAtomic(input.policy.approveAboveUsd) && !approvalGranted) {
        if (input.approval && "ask" in input.approval) {
          approvalGranted = await input.approval.ask({
            money,
            dayRemainingUsd: Number(formatBaseUnitsUsd(remaining)),
          });
          if (!approvalGranted) return { outcome: "declined", money, disputeFee: fee };
        } else return { outcome: "approval_needed", money, disputeFee: fee };
      }
      return undefined;
    };
    if (!resume) {
      const refusal = await checkPolicy(existingId);
      if (refusal) return refusal;
    }
    const idempotencyKey = existingId ?? preparation?.idempotencyKey ?? operationKey(input);
    let reservation: { date: string; reservationReused?: boolean } | undefined =
      retained && retained.invalidated !== true
        ? { date: retained.date, reservationReused: true }
        : undefined;
    const ensureReservation = async () => {
      if (
        reservation &&
        (reservation.date === input.now().toISOString().slice(0, 10) || retained?.exposed === true)
      )
        return;
      if (reservation) await input.pending?.clearReservation?.(reservationKey);
      await input.pending?.reservationId(reservationKey, () => idempotencyKey);
      reservation = await reserveSpend(feeAtomic, input.caps, {
        kind: "dispute-fee",
        maxPerTaskAtomic: policyAtomic(input.policy.maxPerTaskUsd),
        wallet: input.wallet,
        ledgerPath: input.ledgerPath,
        now: input.now(),
        reservationId: idempotencyKey,
        reuseExistingEscrowReservation: input.pending !== undefined,
      });
      await input.pending?.bindReservation?.(reservationKey, {
        id: idempotencyKey,
        wallet: input.wallet,
        amountAtomic: feeAtomic.toString(),
        date: reservation.date,
      });
    };
    if (!resume) await ensureReservation();
    let preflightOutcome: DisputeTaskResult | undefined;
    try {
      const method =
        action === "dispute"
          ? input.chain.dispute.bind(input.chain)
          : input.chain.counterEvidence.bind(input.chain);
      const result = await method({
        ...operation,
        idempotencyKey,
        feeBaseUnits: feeAtomic,
        beforeSign: async () => {
          preflightOutcome = await checkPolicy(idempotencyKey);
          if (preflightOutcome)
            throw new TasksChainError(
              "The task dispute fee requires spend policy approval before a new signature.",
              false,
              { authorizationExposed: false },
            );
          try {
            await ensureReservation();
          } catch (error) {
            if (error instanceof SpendCapError)
              preflightOutcome = {
                outcome: "refused",
                reason: error.code === "per_day_cap_exceeded" ? "policy.perDay" : "policy.perTask",
                money,
                disputeFee: fee,
              };
            throw error;
          }
        },
      });
      return { outcome: "done", money, disputeFee: fee, result };
    } catch (error) {
      const exposed = await input.pending?.exposure(reservationKey);
      if (
        reservation &&
        !exposed &&
        error instanceof TasksChainError &&
        !error.broadcast &&
        !error.authorizationExposed
      ) {
        await input.pending?.invalidateReservation?.(reservationKey);
        await releaseSpend(feeAtomic, {
          ledgerPath: input.ledgerPath,
          wallet: input.wallet,
          now: input.now(),
          reservedOn: reservation.date,
          reservationId: idempotencyKey,
        });
        await input.pending?.clearReservation?.(reservationKey);
      }
      if (preflightOutcome) return preflightOutcome;
      throw error;
    }
  };
  return input.pending ? input.pending.withFundingLock(milestone.id, perform) : perform();
}

export async function resolveUnmatchedTask(input: TaskActionInput): Promise<TaskMoneyResult> {
  const milestone = await resolveMilestone(input);
  const money = await milestoneMoney(input.client, milestone);
  requireChain(input.chain);
  const result = await input.chain.resolveUnmatched({
    orderId: milestone.workOrderId,
    escrowId: milestone.id,
    idempotencyKey: operationKey(input),
    ...(input.counterparty ? { counterparty: input.counterparty } : {}),
  });
  return { money, result };
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
  counterparty?: string;
  bindings?: ScopeBindings;
  onTerms?: (terms: SignedScopeTerms) => Promise<void> | void;
  /** Local EIP-191 signer, invoked only after validating the current scope. */
  signMessage?: (message: string) => Promise<`0x${string}`>;
  idempotencyKey?: () => string;
};
export type SignedScopeTerms = {
  counterparty: Address;
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
  let candidates = [...current.values()].filter(
    (scope) => scope.state === "proposed" && scope.proposedByRole !== actingRole,
  );
  const recoveringAccepted = candidates.length === 0 && input.role === "worker";
  if (recoveringAccepted) {
    candidates = [...current.values()].filter(
      (scope) =>
        scope.state === "accepted" &&
        order.milestones.some(
          (milestone) => milestone.id === scope.milestoneId && milestone.escrowState === null,
        ),
    );
  }
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
  const message = canonicalJson(payload);
  let recoverySelf: Address | undefined;
  let recoveryBinding: ScopeBinding | undefined;
  if (recoveringAccepted) {
    requireChain(input.chain);
    recoverySelf = input.chain.signingAddress ?? (await input.chain.getSigningAddress?.());
    if (!recoverySelf)
      throw new Error("A local signing wallet is required for accepted scope recovery.");
    recoveryBinding = await (input.bindings ?? createScopeBindings(getVapiPaths().directory)).get({
      orderId: input.orderId,
      trancheOrdinal: scope.trancheOrdinal,
      scopeVersion: scope.version,
      termsHash: frozen.termsHash,
      self: recoverySelf,
    });
    if (!input.counterparty && !recoveryBinding)
      throw new Error(
        "The task parties are not bound on this machine. Re-run with --counterparty <address> to confirm who you are working with.",
      );
    if (
      recoveryBinding &&
      (recoveryBinding.role !== "provider" ||
        !isAddressEqual(recoveryBinding.self, recoverySelf) ||
        (input.counterparty &&
          !isAddressEqual(recoveryBinding.counterparty, getAddress(input.counterparty))))
    )
      throw new Error("The confirmed parties do not match the existing local provider binding.");
  }
  const counterparty = getAddress(
    recoveringAccepted
      ? (input.counterparty ?? recoveryBinding!.counterparty)
      : scope.proposerAddress,
  );
  if (
    !recoveringAccepted &&
    input.counterparty &&
    !isAddressEqual(getAddress(input.counterparty), counterparty)
  )
    throw new Error("The confirmed counterparty does not match the verified scope proposer.");
  if (recoveringAccepted) {
    requireChain(input.chain);
    const self = recoverySelf;
    if (
      !self ||
      !scope.counterpartyAddress ||
      !scope.counterpartySignature ||
      isAddressEqual(self, counterparty) ||
      ![scope.proposerAddress, scope.counterpartyAddress].every(
        (address) => isAddressEqual(address, self) || isAddressEqual(address, counterparty),
      ) ||
      isAddressEqual(scope.proposerAddress, scope.counterpartyAddress)
    )
      throw new Error(
        "Both accepted scope signatures must belong to the local wallet and confirmed counterparty.",
      );
    let valid = false;
    try {
      const checks = await Promise.all([
        verifyMessage({
          address: scope.proposerAddress,
          message,
          signature: scope.proposerSignature as Hex,
        }),
        verifyMessage({
          address: scope.counterpartyAddress,
          message,
          signature: scope.counterpartySignature as Hex,
        }),
      ]);
      valid = checks.every(Boolean);
    } catch {
      /* A malformed accepted signature cannot authorize creation. */
    }
    if (!valid)
      throw new Error("Both accepted scope signatures must verify before escrow recovery.");
  }
  let validCounterparty = false;
  try {
    validCounterparty = await verifyMessage({
      address: counterparty,
      message,
      signature: (recoveringAccepted && !isAddressEqual(counterparty, scope.proposerAddress)
        ? scope.counterpartySignature!
        : scope.proposerSignature) as Hex,
    });
  } catch {
    /* Invalid signatures are a local refusal, never a reason to invoke the signer. */
  }
  if (!validCounterparty)
    throw new Error("The counterparty scope signature does not verify; refusing to sign.");
  if (input.chain.signingAddress && isAddressEqual(input.chain.signingAddress, counterparty))
    throw new Error("The scope counterparty must differ from the local signing wallet.");
  const terms: SignedScopeTerms = {
    counterparty,
    amountBaseUnits: frozen.structured.budget.amountBaseUnits,
    asset: frozen.structured.budget.asset,
    network: frozen.structured.budget.network,
    deadline: frozen.structured.deadline,
    deliverables: frozen.structured.deliverables,
    title: frozen.structured.title,
  };
  const idempotencyKey = operationKey(input);
  await input.onTerms?.(terms);
  if (recoveringAccepted) {
    const milestone = order.milestones.find((candidate) => candidate.id === scope.milestoneId);
    const earliest = order.milestones
      .filter((candidate) => candidate.escrowState === null)
      .sort((a, b) => a.ordinal - b.ordinal)[0];
    if (
      !milestone ||
      milestone.workOrderId !== input.orderId ||
      milestone.ordinal !== scope.trancheOrdinal ||
      milestone.termsHash !== payload.termsHash ||
      !milestone.termsFrozenAt ||
      earliest?.id !== milestone.id
    )
      throw new Error(
        "The accepted scope milestone is unavailable or an earlier milestone still needs escrow creation.",
      );
    const accepted: SignScopeAcceptance = {
      scope,
      milestone: {
        id: milestone.id,
        workOrderId: milestone.workOrderId,
        ordinal: milestone.ordinal,
        termsHash: milestone.termsHash,
        termsFrozenAt: milestone.termsFrozenAt,
      },
      terms,
    };
    await persistScopeBinding(input, {
      orderId: input.orderId,
      trancheOrdinal: scope.trancheOrdinal,
      scopeVersion: scope.version,
      termsHash: frozen.termsHash,
      role: "provider",
      self: getAddress(recoverySelf!),
      counterparty,
      signedAt: new Date().toISOString(),
    });
    try {
      const escrowCreation = await input.chain.createEscrow({
        orderId: input.orderId,
        counterparty,
        idempotencyKey,
      });
      return { ...accepted, escrowCreation };
    } catch (error) {
      throw new TasksScopeCreationError(accepted, error);
    }
  }
  let signature: `0x${string}`;
  if (input.signMessage) signature = await input.signMessage(message);
  else {
    requireChain(input.chain);
    signature = await input.chain.signScopeMessage(message);
  }
  const self = getAddress(await recoverMessageAddress({ message, signature }));
  if (
    isAddressEqual(self, counterparty) ||
    (input.chain.signingAddress && !isAddressEqual(self, input.chain.signingAddress))
  )
    throw new Error("The local scope signature does not match the signing wallet.");
  const binding: ScopeBinding = {
    orderId: input.orderId,
    trancheOrdinal: scope.trancheOrdinal,
    scopeVersion: scope.version,
    termsHash: frozen.termsHash,
    role: actingRole,
    self,
    counterparty,
    signedAt: new Date().toISOString(),
  };
  // Persist consent before the signature can leave the machine.
  await persistScopeBinding(input, binding);
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
      ...(input.counterparty ? { counterparty: input.counterparty } : {}),
      idempotencyKey: operationKey(input),
    });
    return { ...accepted, escrowCreation };
  } catch (error) {
    throw new TasksScopeCreationError(accepted, error);
  }
}

async function persistScopeBinding(
  input: SignScopeActionInput,
  binding: ScopeBinding,
): Promise<void> {
  if (input.bindings) await input.bindings.put(binding);
  else if (input.chain.bindScope) await input.chain.bindScope(binding);
  else await createScopeBindings(getVapiPaths().directory).put(binding);
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
