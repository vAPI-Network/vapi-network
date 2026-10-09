import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { parseTransaction, type Address, type Hex } from "viem";
import { z } from "zod";

import { withFileLock, writeJsonAtomic } from "../atomic-file.js";
import { walletNameSchema } from "../wallet-name.js";
import { canonicalJson } from "./canonical-json.js";
import { TasksChainError } from "./chain-port.js";
import {
  tasksResponseSchemas,
  type FundEscrowInput,
  type ReconcileOperationResponse,
} from "./types.js";

export type PendingTransaction = {
  chainId: number;
  txHash: Hex;
  raw: Hex;
  signer: Address;
  nonce: number;
  createdAt: string;
};
export type RetainedSpendReservation = {
  id: string;
  wallet: string;
  amountAtomic: string;
  date: string;
  exposed?: boolean;
  invalidated?: boolean;
};
export type PendingPreparation = { idempotencyKey: string; inputs: unknown; operationId?: string };

export interface PendingTransactions {
  get(operationId: string, step: string): Promise<PendingTransaction | undefined>;
  put(operationId: string, step: string, entry: PendingTransaction): Promise<void>;
  remove(operationId: string, step: string): Promise<void>;
  withStepLock<T>(operationId: string, step: string, fn: () => Promise<T>): Promise<T>;
  withSignerLock<T>(chainId: number, signer: Address, fn: () => Promise<T>): Promise<T>;
  withFundingLock<T>(milestoneId: string, fn: () => Promise<T>): Promise<T>;
  nextNonce(chainId: number, signer: Address): Promise<number>;
  exposure(milestoneId: string): Promise<boolean>;
  markExposure(milestoneId: string): Promise<void>;
  preparation(milestoneId: string, verb: string): Promise<PendingPreparation | undefined>;
  putPreparation(milestoneId: string, verb: string, preparation: PendingPreparation): Promise<void>;
  bindPreparationOperation(milestoneId: string, verb: string, operationId: string): Promise<void>;
  completePreparation(milestoneId: string, verb: string): Promise<void>;
  reservationId(escrowId: string, generate: () => string): Promise<string>;
  existingReservationId?(escrowId: string): Promise<string | undefined>;
  retainedReservation?(escrowId: string): Promise<RetainedSpendReservation | undefined>;
  bindReservation?(escrowId: string, reservation: RetainedSpendReservation): Promise<void>;
  clearReservation?(escrowId: string): Promise<void>;
  invalidateReservation?(escrowId: string): Promise<void>;
  reconciled(operationId: string, step: string): Promise<ReconcileOperationResponse | undefined>;
  complete(operationId: string, step: string, response: ReconcileOperationResponse): Promise<void>;
  recoveryCursor(operationId: string, step: string): Promise<number>;
  advanceRecovery(operationId: string, step: string, cursor: number): Promise<void>;
  fundingAuthorization(
    escrowId: string,
    idempotencyKey: string,
    generate: () => Promise<NonNullable<FundEscrowInput["authorization"]>>,
  ): Promise<NonNullable<FundEscrowInput["authorization"]>>;
  savedFundingAuthorization(
    escrowId: string,
    idempotencyKey: string,
  ): Promise<NonNullable<FundEscrowInput["authorization"]> | undefined>;
}

const hex = z
  .string()
  .regex(/^0x(?:[0-9a-fA-F]{2})+$/)
  .transform((v) => v as Hex);
const hash = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/)
  .transform((v) => v as Hex);
const step = z.enum([
  "create-escrow",
  "approve-usdc",
  "deposit-funds",
  "fund-with-authorization",
  "submit-delivery",
  "release-funds",
  "refund-buyer",
  "raise-dispute",
  "timeout-refund",
  "finalize",
]);
const operationStepKey = z.string().refine((key) => {
  const separator = key.indexOf(":");
  return (
    separator > 0 &&
    z.uuid().safeParse(key.slice(0, separator)).success &&
    step.safeParse(key.slice(separator + 1)).success
  );
});
const uint256 = z
  .string()
  .regex(/^(0|[1-9][0-9]*)$/)
  .refine((value) => BigInt(value) < 1n << 256n);
const address = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/)
  .transform((v) => v as Address);
const authorization = z
  .object({
    validAfter: uint256,
    validBefore: uint256,
    nonce: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
    signature: hex.refine((value) => value.length <= 32_770),
  })
  .strict()
  .refine((value) => BigInt(value.validBefore) > BigInt(value.validAfter));
const transaction = z
  .object({
    chainId: z.number().int().positive(),
    txHash: hash,
    raw: hex,
    signer: address,
    nonce: z.number().int().nonnegative().optional(),
    createdAt: z.iso.datetime(),
  })
  .strict();
const retainedReservation = z
  .object({
    id: z.uuid(),
    wallet: walletNameSchema,
    amountAtomic: z.string().regex(/^\d+$/),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    exposed: z.boolean().optional(),
    invalidated: z.boolean().optional(),
  })
  .strict();
const stateSchema = z
  .object({
    version: z.literal(1),
    transactions: z.record(operationStepKey, transaction),
    reservations: z.record(z.uuid(), z.uuid()),
    retainedReservations: z.record(z.uuid(), retainedReservation),
    checkpoints: z.record(operationStepKey, z.unknown()),
    recoveryCursors: z.record(operationStepKey, z.number().int().nonnegative()),
    authorizations: z.record(z.uuid(), z.record(z.uuid(), authorization)),
    exposures: z.record(z.uuid(), z.boolean()).default({}),
    preparations: z
      .record(
        z.string(),
        z
          .object({
            idempotencyKey: z.uuid(),
            inputs: z.unknown(),
            operationId: z.uuid().optional(),
          })
          .strict(),
      )
      .default({}),
  })
  .strict();
type State = z.infer<typeof stateSchema>;
const emptyState = (): State => ({
  version: 1,
  transactions: {},
  reservations: {},
  retainedReservations: {},
  checkpoints: {},
  recoveryCursors: {},
  authorizations: {},
  exposures: {},
  preparations: {},
});

function validCheckpointStep(storedStep: string, response: ReconcileOperationResponse): boolean {
  return (
    (response.operation.state === "confirmed" && response.operation.step === storedStep) ||
    (storedStep === "approve-usdc" &&
      response.operation.state === "prepared" &&
      response.operation.step === "deposit-funds")
  );
}

export function createPendingTransactions(home: string): PendingTransactions {
  const path = join(home, "tasks", "pending.json");
  const lockPath = `${path}.lock`;
  const read = async (): Promise<State> => {
    try {
      const state = stateSchema.parse(JSON.parse(await readFile(path, "utf8")));
      for (const [key, value] of Object.entries(state.checkpoints)) {
        const separator = key.indexOf(":");
        const operationId = key.slice(0, separator);
        const operationStep = key.slice(separator + 1);
        const response = tasksResponseSchemas.reconcileOperation.parse(value);
        if (
          separator < 1 ||
          !z.uuid().safeParse(operationId).success ||
          !step.safeParse(operationStep).success ||
          response.operation.id !== operationId ||
          !validCheckpointStep(operationStep, response)
        )
          throw new Error(`Invalid task reconciliation checkpoint ${key}.`);
        state.checkpoints[key] = response;
      }
      return state;
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
        return emptyState();
      throw error;
    }
  };
  const locked = <T>(fn: (state: State) => Promise<T>) =>
    withFileLock(lockPath, async () => fn(await read()));
  const save = (state: State) => writeJsonAtomic(path, state, { mode: 0o600 });
  const transactionKey = (operationId: string, operationStep: string) => {
    z.uuid().parse(operationId);
    step.parse(operationStep);
    return `${operationId}:${operationStep}`;
  };
  const milestoneKey = (milestoneId: string) => z.uuid().parse(milestoneId);
  const preparationKey = (milestoneId: string, verb: string) => {
    milestoneKey(milestoneId);
    if (!verb) throw new Error("A preparation verb is required.");
    return `${milestoneId}:${verb}`;
  };
  return {
    async get(operationId, step) {
      const value = (await read()).transactions[transactionKey(operationId, step)];
      if (!value) return undefined;
      if (value.nonce !== undefined) return value as PendingTransaction;
      const decoded = parseTransaction(value.raw);
      if (decoded.nonce === undefined || decoded.nonce > BigInt(Number.MAX_SAFE_INTEGER))
        throw new Error(`Pending transaction ${operationId}/${step} has no safe nonce.`);
      return { ...value, nonce: Number(decoded.nonce) };
    },
    async put(operationId, step, entry) {
      await locked(async (state) => {
        const key = transactionKey(operationId, step);
        const existing = state.transactions[key];
        if (existing) {
          if (existing.raw !== entry.raw)
            throw new Error(`Pending transaction ${operationId}/${step} is immutable.`);
          return;
        }
        state.transactions[key] = transaction.parse(entry);
        await save(state);
      });
    },
    async remove(operationId, step) {
      await locked(async (state) => {
        const key = transactionKey(operationId, step);
        if (!state.transactions[key]) return;
        delete state.transactions[key];
        await save(state);
      });
    },
    withStepLock(operationId, step, fn) {
      return withFileLock(
        join(
          home,
          "tasks",
          `step-${encodeURIComponent(operationId)}-${encodeURIComponent(step)}.lock`,
        ),
        fn,
      );
    },
    withSignerLock(chainId, signer, fn) {
      z.number().int().positive().parse(chainId);
      address.parse(signer);
      return withFileLock(
        join(home, "tasks", `signer-${chainId}-${signer.toLowerCase()}.lock`),
        fn,
      );
    },
    withFundingLock(milestoneId, fn) {
      milestoneKey(milestoneId);
      return withFileLock(join(home, "tasks", `fund-${milestoneId}.lock`), fn);
    },
    async nextNonce(chainId, signer) {
      z.number().int().positive().parse(chainId);
      address.parse(signer);
      let highest = -1;
      for (const value of Object.values((await read()).transactions)) {
        if (value.chainId !== chainId || value.signer.toLowerCase() !== signer.toLowerCase())
          continue;
        let nonce = value.nonce;
        if (nonce === undefined) {
          try {
            const decoded = parseTransaction(value.raw);
            if (decoded.nonce !== undefined && decoded.nonce <= BigInt(Number.MAX_SAFE_INTEGER))
              nonce = Number(decoded.nonce);
          } catch (error) {
            throw new Error("A legacy pending transaction has no safe nonce.", { cause: error });
          }
        }
        if (nonce === undefined) throw new Error("A legacy pending transaction has no safe nonce.");
        highest = Math.max(highest, nonce);
      }
      return highest + 1;
    },
    async exposure(milestoneId) {
      milestoneKey(milestoneId);
      const state = await read();
      return (
        state.exposures[milestoneId] === true ||
        state.retainedReservations[milestoneId]?.exposed === true ||
        Object.keys(state.authorizations[milestoneId] ?? {}).length > 0
      );
    },
    async markExposure(milestoneId) {
      await locked(async (state) => {
        milestoneKey(milestoneId);
        state.exposures[milestoneId] = true;
        const reservation = state.retainedReservations[milestoneId];
        if (reservation) reservation.exposed = true;
        await save(state);
      });
    },
    async preparation(milestoneId, verb) {
      return (await read()).preparations[preparationKey(milestoneId, verb)];
    },
    async putPreparation(milestoneId, verb, preparation) {
      await locked(async (state) => {
        const key = preparationKey(milestoneId, verb);
        const parsed = z
          .object({
            idempotencyKey: z.uuid(),
            inputs: z.unknown(),
            operationId: z.uuid().optional(),
          })
          .strict()
          .parse(preparation);
        const existing = state.preparations[key];
        if (
          existing &&
          (existing.idempotencyKey !== parsed.idempotencyKey ||
            canonicalJson(existing.inputs) !== canonicalJson(parsed.inputs))
        )
          throw new Error(`Preparation ${milestoneId}/${verb} is immutable.`);
        if (!existing) {
          state.preparations[key] = parsed;
          await save(state);
        }
      });
    },
    async bindPreparationOperation(milestoneId, verb, operationId) {
      await locked(async (state) => {
        const key = preparationKey(milestoneId, verb);
        const parsedOperationId = z.uuid().parse(operationId);
        const existing = state.preparations[key];
        if (!existing)
          throw new TasksChainError(`Preparation ${milestoneId}/${verb} is unavailable.`, true);
        if (existing.operationId && existing.operationId !== parsedOperationId)
          throw new TasksChainError(
            `Preparation ${milestoneId}/${verb} returned a different operation.`,
            true,
          );
        if (!existing.operationId) {
          existing.operationId = parsedOperationId;
          await save(state);
        }
      });
    },
    async completePreparation(milestoneId, verb) {
      await locked(async (state) => {
        const key = preparationKey(milestoneId, verb);
        if (!state.preparations[key]) return;
        delete state.preparations[key];
        await save(state);
      });
    },
    reservationId(escrowId, generate) {
      return locked(async (state) => {
        const existing = state.reservations[escrowId];
        if (existing) return existing;
        const created = z.uuid().parse(generate());
        state.reservations[escrowId] = created;
        await save(state);
        return created;
      });
    },
    async existingReservationId(escrowId) {
      z.uuid().parse(escrowId);
      return (await read()).reservations[escrowId];
    },
    async retainedReservation(escrowId) {
      z.uuid().parse(escrowId);
      const state = await read();
      const reservation = state.retainedReservations[escrowId];
      if (!reservation) return undefined;
      const exposed =
        state.exposures[escrowId] === true ||
        Object.keys(state.authorizations[escrowId] ?? {}).length > 0;
      return exposed ? { ...reservation, exposed: true } : reservation;
    },
    async bindReservation(escrowId, reservation) {
      await locked(async (state) => {
        z.uuid().parse(escrowId);
        const parsed = retainedReservation.parse(reservation);
        const existing = state.retainedReservations[escrowId];
        if (
          existing &&
          (existing.id !== parsed.id ||
            existing.wallet !== parsed.wallet ||
            existing.amountAtomic !== parsed.amountAtomic ||
            existing.date !== parsed.date)
        )
          throw new Error(`Retained reservation for escrow ${escrowId} does not match.`);
        state.retainedReservations[escrowId] = {
          ...parsed,
          ...(existing?.invalidated === true ? { invalidated: true } : {}),
          ...(existing?.exposed === true ? { exposed: true } : {}),
          ...(state.exposures[escrowId] ? { exposed: true } : {}),
        };
        await save(state);
      });
    },
    async clearReservation(escrowId) {
      await locked(async (state) => {
        z.uuid().parse(escrowId);
        if (!state.retainedReservations[escrowId]) return;
        delete state.retainedReservations[escrowId];
        await save(state);
      });
    },
    async invalidateReservation(escrowId) {
      await locked(async (state) => {
        milestoneKey(escrowId);
        const reservation = state.retainedReservations[escrowId];
        if (!reservation) return;
        reservation.invalidated = true;
        await save(state);
      });
    },
    async reconciled(operationId, operationStep) {
      const value = (await read()).checkpoints[transactionKey(operationId, operationStep)];
      return value === undefined ? undefined : tasksResponseSchemas.reconcileOperation.parse(value);
    },
    async complete(operationId, operationStep, response) {
      await locked(async (state) => {
        const key = transactionKey(operationId, operationStep);
        const parsed = tasksResponseSchemas.reconcileOperation.parse(response);
        if (parsed.operation.id !== operationId || !validCheckpointStep(operationStep, parsed))
          throw new Error(`Reconciliation checkpoint ${key} does not match its operation.`);
        if (state.checkpoints[key] === undefined)
          state.checkpoints[key] = {
            operation: parsed.operation,
            milestone: { id: parsed.milestone.id, workOrderId: parsed.milestone.workOrderId },
          };
        delete state.transactions[key];
        await save(state);
      });
    },
    async recoveryCursor(operationId, operationStep) {
      return (await read()).recoveryCursors[transactionKey(operationId, operationStep)] ?? 0;
    },
    async advanceRecovery(operationId, operationStep, cursor) {
      await locked(async (state) => {
        const key = transactionKey(operationId, operationStep);
        const parsed = z.number().int().nonnegative().parse(cursor);
        state.recoveryCursors[key] = Math.max(state.recoveryCursors[key] ?? 0, parsed + 1);
        await save(state);
      });
    },
    fundingAuthorization(escrowId, idempotencyKey, generate) {
      return locked(async (state) => {
        const existing = state.authorizations[escrowId]?.[idempotencyKey];
        if (existing) return existing;
        const created = authorization.parse(await generate());
        state.authorizations[escrowId] = {
          ...state.authorizations[escrowId],
          [idempotencyKey]: created,
        };
        await save(state);
        return created;
      });
    },
    async savedFundingAuthorization(escrowId, idempotencyKey) {
      milestoneKey(escrowId);
      z.uuid().parse(idempotencyKey);
      return (await read()).authorizations[escrowId]?.[idempotencyKey];
    },
  };
}
