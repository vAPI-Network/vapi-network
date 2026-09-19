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

/**
 * One day's spend for one wallet. A row without a wallet was written before
 * named wallets and belongs to `main`.
 */
const ledgerRowSchema = ledgerSchema.extend({ wallet: walletNameSchema.optional() });

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
export type SpendLedgerRow = SpendLedger & { wallet: WalletName };

export class SpendCapError extends Error {
  constructor(
    public readonly code: "per_call_cap_exceeded" | "per_day_cap_exceeded",
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

/** Today's spend of every wallet that has spent today. */
export async function readSpendLedgerRows(
  path = getAgentCashPaths().ledger,
  now = new Date(),
): Promise<SpendLedgerRow[]> {
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
    }));
}

/**
 * Reserves one payment against the caps of one wallet. Per-day totals are kept
 * per wallet, so an agent wallet cannot spend the owner's daily allowance.
 */
export async function reserveSpend(
  amountAtomic: bigint,
  caps: SpendCaps,
  options?: { ledgerPath?: string; now?: Date; wallet?: WalletName },
): Promise<SpendLedger> {
  if (amountAtomic < 0n) {
    throw new Error("Spend amount cannot be negative.");
  }

  const perCallAtomic = parseAtomicCap(caps.perCallAtomic, "per-call");
  const perDayAtomic = parseAtomicCap(caps.perDayAtomic, "per-day");
  if (amountAtomic > perCallAtomic) {
    throw new SpendCapError(
      "per_call_cap_exceeded",
      `Payment quote ${amountAtomic} atomic USDC exceeds the per-call cap ${perCallAtomic}. Refusing to sign.`,
    );
  }

  const ledgerPath = options?.ledgerPath ?? getAgentCashPaths().ledger;
  const now = options?.now ?? new Date();
  const wallet = options?.wallet ?? DEFAULT_WALLET_NAME;
  return await withLedgerLock(ledgerPath, async () => {
    const rows = await readSpendLedgerRows(ledgerPath, now);
    const spentAtomic = rows.find((row) => row.wallet === wallet)?.spentAtomic ?? "0";
    const nextSpent = BigInt(spentAtomic) + amountAtomic;
    if (nextSpent > perDayAtomic) {
      throw new SpendCapError(
        "per_day_cap_exceeded",
        `Payment quote ${amountAtomic} atomic USDC would raise today's spend to ${nextSpent} for wallet ${wallet}, above the per-day cap ${perDayAtomic}. Refusing to sign.`,
      );
    }
    const nextRow: SpendLedgerRow = {
      date: utcDateKey(now),
      spentAtomic: nextSpent.toString(),
      wallet,
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

async function writeLedgerAtomically(path: string, rows: readonly SpendLedgerRow[]) {
  const ledger =
    rows.length === 1 && rows[0]!.wallet === DEFAULT_WALLET_NAME
      ? { date: rows[0]!.date, spentAtomic: rows[0]!.spentAtomic }
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
