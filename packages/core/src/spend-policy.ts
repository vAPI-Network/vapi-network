import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { dirname } from "node:path";

import { z } from "zod";

import { getAgentCashPaths, isMissingFile, type SpendCaps } from "./config.js";
import { DEFAULT_WALLET_NAME, walletNameSchema, type WalletName } from "./wallet-name.js";

const ledgerSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  spentAtomic: z.string().regex(/^\d+$/),
});

const spendReservationSchema = z.object({
  id: z.string().min(1),
  amountAtomic: z.string().regex(/^\d+$/),
  kind: z.enum(["payment", "escrow-funding", "dispute-fee"]).optional(),
});

/**
 * One day's spend for one wallet. A row without a wallet was written before
 * named wallets and belongs to `main`.
 */
const ledgerRowSchema = ledgerSchema.extend({
  wallet: walletNameSchema.optional(),
  reservations: z.array(spendReservationSchema).optional(),
});

/**
 * The file holds either a single legacy row, or the multi-wallet form. A home
 * with only `main` keeps being written in the legacy shape, so a 0.2.x client
 * can still read its own ledger.
 */
const ledgerFileSchema = z.union([
  z.object({ version: z.literal(1), rows: z.array(ledgerRowSchema) }),
  ledgerRowSchema,
]);

export type SpendLedger = z.infer<typeof ledgerSchema>;
export type SpendKind = "payment" | "escrow-funding" | "dispute-fee";
export type SpendLedgerRow = SpendLedger & { wallet: WalletName };
type StoredSpendLedgerRow = SpendLedgerRow & {
  reservations?: Array<z.infer<typeof spendReservationSchema>>;
};

export class SpendCapError extends Error {
  constructor(
    public readonly code:
      "per_call_cap_exceeded" | "per_task_cap_exceeded" | "per_day_cap_exceeded",
    message: string,
  ) {
    super(message);
    this.name = "SpendCapError";
  }
}

export function utcDateKey(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** Today's spend for one wallet. Other wallets and older days read as zero. */
export async function readSpendLedger(
  path = getAgentCashPaths().ledger,
  now = new Date(),
  wallet: WalletName = DEFAULT_WALLET_NAME,
): Promise<SpendLedger> {
  const rows = await readSpendLedgerRows(path, now);
  const row = rows.find((candidate) => candidate.wallet === wallet);
  return { date: utcDateKey(now), spentAtomic: row?.spentAtomic ?? "0" };
}

/** Read-only funding headroom; never creates directories, writes, or takes a lock. */
export async function escrowFundingDayRemainingAtomic(input: {
  caps: SpendCaps;
  ledgerPath: string;
  now: Date;
  wallet: WalletName;
  reservationId?: string;
}): Promise<bigint> {
  const perDayAtomic = parseAtomicCap(input.caps.perDayAtomic, "per-day");
  const rows = await readStoredSpendLedgerRows(input.ledgerPath, input.now);
  const row = rows.find((candidate) => candidate.wallet === input.wallet);
  const reserved = input.reservationId
    ? row?.reservations?.find((candidate) => candidate.id === input.reservationId)
    : undefined;
  const remaining =
    perDayAtomic - BigInt(row?.spentAtomic ?? "0") + BigInt(reserved?.amountAtomic ?? "0");
  return remaining > 0n ? remaining : 0n;
}

/** Today's spend of every wallet that has spent today. */
export async function readSpendLedgerRows(
  path = getAgentCashPaths().ledger,
  now = new Date(),
): Promise<SpendLedgerRow[]> {
  return (await readStoredSpendLedgerRows(path, now)).map(({ date, spentAtomic, wallet }) => ({
    date,
    spentAtomic,
    wallet,
  }));
}

async function readStoredSpendLedgerRows(path: string, now: Date): Promise<StoredSpendLedgerRow[]> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isMissingFile(error)) return [];
    throw error;
  }
  const parsed = ledgerFileSchema.parse(JSON.parse(raw));
  const rows = "rows" in parsed ? parsed.rows : [parsed];
  const today = utcDateKey(now);
  return rows
    .filter((row) => row.date === today)
    .map((row) => ({
      date: row.date,
      spentAtomic: row.spentAtomic,
      wallet: row.wallet ?? DEFAULT_WALLET_NAME,
      ...(row.reservations === undefined ? {} : { reservations: row.reservations }),
    }));
}

/**
 * Reserves one payment or escrow funding against the caps of one wallet.
 * Per-day totals are kept per wallet, so an agent wallet cannot spend the
 * owner's daily allowance.
 */
export async function reserveSpend(
  amountAtomic: bigint,
  caps: SpendCaps,
  options?: {
    ledgerPath?: string;
    now?: Date;
    wallet?: WalletName;
    reservationId?: string;
    kind?: SpendKind;
    maxPerTaskAtomic?: bigint;
    reuseExistingEscrowReservation?: boolean;
    resumeEscrowReservation?: {
      id: string;
      wallet: WalletName;
      amountAtomic: string;
      date: string;
      exposed?: boolean;
      invalidated?: boolean;
    };
  },
): Promise<SpendLedger & { reservationReused?: boolean }> {
  if (amountAtomic < 0n) {
    throw new Error("Spend amount cannot be negative.");
  }

  const kind = options?.kind ?? "payment";
  let perDayAtomic: bigint;
  if (kind === "escrow-funding" || kind === "dispute-fee") {
    const maxPerTaskAtomic = options?.maxPerTaskAtomic;
    if (maxPerTaskAtomic === undefined || maxPerTaskAtomic < 0n) {
      throw new Error("Escrow funding requires a non-negative per-task cap.");
    }
    if (amountAtomic > maxPerTaskAtomic) {
      throw new SpendCapError(
        "per_task_cap_exceeded",
        `Escrow funding ${amountAtomic} atomic USDC exceeds the per-task cap ${maxPerTaskAtomic}. Refusing to sign.`,
      );
    }
    perDayAtomic = parseAtomicCap(caps.perDayAtomic, "per-day");
  } else {
    const perCallAtomic = parseAtomicCap(caps.perCallAtomic, "per-call");
    perDayAtomic = parseAtomicCap(caps.perDayAtomic, "per-day");
    if (amountAtomic > perCallAtomic) {
      throw new SpendCapError(
        "per_call_cap_exceeded",
        `Payment quote ${amountAtomic} atomic USDC exceeds the per-call cap ${perCallAtomic}. Refusing to sign.`,
      );
    }
  }

  const ledgerPath = options?.ledgerPath ?? getAgentCashPaths().ledger;
  const now = options?.now ?? new Date();
  const wallet = options?.wallet ?? DEFAULT_WALLET_NAME;
  return await withLedgerLock(ledgerPath, async () => {
    const rows = await readStoredSpendLedgerRows(ledgerPath, now);
    const current = rows.find((row) => row.wallet === wallet);
    if (options?.reservationId !== undefined) {
      const existing = current?.reservations?.find(
        (reservation) => reservation.id === options.reservationId,
      );
      if (existing && options.reuseExistingEscrowReservation) {
        if (
          (kind !== "escrow-funding" && kind !== "dispute-fee") ||
          existing.kind !== kind ||
          existing.amountAtomic !== amountAtomic.toString()
        )
          throw new Error(
            `Spend reservation ${options.reservationId} does not match this funding.`,
          );
        return {
          date: current!.date,
          spentAtomic: current!.spentAtomic,
          reservationReused: true,
        };
      }
      if (existing) {
        throw new Error(`Spend reservation ${options.reservationId} already exists.`);
      }
      if (options.resumeEscrowReservation) {
        const resumed = options.resumeEscrowReservation;
        if (
          (kind !== "escrow-funding" && kind !== "dispute-fee") ||
          resumed.id !== options.reservationId ||
          resumed.wallet !== wallet ||
          resumed.amountAtomic !== amountAtomic.toString() ||
          resumed.date >= utcDateKey(now) ||
          resumed.exposed !== true ||
          resumed.invalidated === true
        )
          throw new Error(
            `Spend reservation ${options.reservationId} does not match this funding.`,
          );
        return {
          date: resumed.date,
          spentAtomic: current?.spentAtomic ?? "0",
          reservationReused: true,
        };
      }
    }
    const spentAtomic = current?.spentAtomic ?? "0";
    const nextSpent = BigInt(spentAtomic) + amountAtomic;
    if (nextSpent > perDayAtomic) {
      throw new SpendCapError(
        "per_day_cap_exceeded",
        `${kind === "escrow-funding" ? "Escrow funding" : "Payment quote"} ${amountAtomic} atomic USDC would raise today's spend to ${nextSpent} for wallet ${wallet}, above the per-day cap ${perDayAtomic}. Refusing to sign.`,
      );
    }
    const nextRow: StoredSpendLedgerRow = {
      date: utcDateKey(now),
      spentAtomic: nextSpent.toString(),
      wallet,
      ...((current?.reservations?.length ?? 0) === 0 && options?.reservationId === undefined
        ? {}
        : {
            reservations: [
              ...(current?.reservations ?? []),
              ...(options?.reservationId === undefined
                ? []
                : [
                    {
                      id: options.reservationId,
                      amountAtomic: amountAtomic.toString(),
                      ...(kind !== "payment" ? { kind } : {}),
                    },
                  ]),
            ],
          }),
    };
    const nextRows = [...rows.filter((row) => row.wallet !== wallet), nextRow].sort((a, b) =>
      a.wallet.localeCompare(b.wallet),
    );
    await writeLedgerAtomically(ledgerPath, nextRows);
    return { date: nextRow.date, spentAtomic: nextRow.spentAtomic };
  });
}

/**
 * Releases a reservation made earlier on the same UTC day. A reservation from
 * a prior day has already rolled out of the active ledger and is left alone.
 */
export async function releaseSpend(
  amountAtomic: bigint,
  options: {
    reservedOn: string;
    ledgerPath?: string;
    now?: Date;
    wallet?: WalletName;
    reservationId?: string;
  },
): Promise<SpendLedger> {
  if (amountAtomic < 0n) {
    throw new Error("Spend amount cannot be negative.");
  }

  const ledgerPath = options.ledgerPath ?? getAgentCashPaths().ledger;
  const now = options.now ?? new Date();
  const wallet = options.wallet ?? DEFAULT_WALLET_NAME;
  return await withLedgerLock(ledgerPath, async () => {
    const today = utcDateKey(now);
    const rows = await readStoredSpendLedgerRows(ledgerPath, now);
    const current = rows.find((row) => row.wallet === wallet);
    if (options.reservedOn !== today) {
      return { date: today, spentAtomic: current?.spentAtomic ?? "0" };
    }

    const reservation =
      options.reservationId === undefined
        ? undefined
        : current?.reservations?.find((candidate) => candidate.id === options.reservationId);
    if (options.reservationId !== undefined && reservation === undefined) {
      return { date: today, spentAtomic: current?.spentAtomic ?? "0" };
    }
    if (reservation !== undefined && reservation.amountAtomic !== amountAtomic.toString()) {
      throw new Error(`Spend reservation ${options.reservationId} has a different amount.`);
    }

    const spentAtomic = BigInt(current?.spentAtomic ?? "0");
    const releasedAmount =
      reservation === undefined ? amountAtomic : BigInt(reservation.amountAtomic);
    const nextSpent = spentAtomic > releasedAmount ? spentAtomic - releasedAmount : 0n;
    const remainingReservations = current?.reservations?.filter(
      (candidate) => candidate.id !== options.reservationId,
    );
    const nextRow: StoredSpendLedgerRow = {
      date: today,
      spentAtomic: nextSpent.toString(),
      wallet,
      ...(remainingReservations === undefined || remainingReservations.length === 0
        ? {}
        : { reservations: remainingReservations }),
    };
    const nextRows = [...rows.filter((row) => row.wallet !== wallet), nextRow].sort((a, b) =>
      a.wallet.localeCompare(b.wallet),
    );
    await writeLedgerAtomically(ledgerPath, nextRows);
    return { date: nextRow.date, spentAtomic: nextRow.spentAtomic };
  });
}

function parseAtomicCap(value: string, label: string): bigint {
  if (!/^\d+$/.test(value)) {
    throw new Error(`Invalid ${label} spend cap ${JSON.stringify(value)}.`);
  }
  return BigInt(value);
}

async function writeLedgerAtomically(path: string, rows: readonly StoredSpendLedgerRow[]) {
  const ledger =
    rows.length === 1 && rows[0]!.wallet === DEFAULT_WALLET_NAME
      ? {
          date: rows[0]!.date,
          spentAtomic: rows[0]!.spentAtomic,
          ...(rows[0]!.reservations === undefined ? {} : { reservations: rows[0]!.reservations }),
        }
      : { version: 1 as const, rows };
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(ledger, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  await rename(temporaryPath, path);
}

async function withLedgerLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const lockPath = `${path}.lock`;
  const deadline = Date.now() + 2_000;
  let handle: FileHandle | undefined;

  while (!handle) {
    try {
      handle = await open(lockPath, "wx", 0o600);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) {
        throw error;
      }
      await removeStaleLock(lockPath);
      if (Date.now() >= deadline) {
        throw new Error("Timed out waiting for the spend ledger lock.");
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  try {
    return await operation();
  } finally {
    await handle.close();
    await unlink(lockPath).catch(() => undefined);
  }
}

async function removeStaleLock(path: string) {
  try {
    const metadata = await stat(path);
    if (Date.now() - metadata.mtimeMs > 30_000) {
      await unlink(path);
    }
  } catch (error) {
    if (!isMissingFile(error)) {
      throw error;
    }
  }
}
