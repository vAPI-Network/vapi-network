import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { dirname } from "node:path";

import { z } from "zod";

import { getAgentCashPaths, isMissingFile, type SpendCaps } from "./config.js";

const ledgerSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  spentAtomic: z.string().regex(/^\d+$/),
});

export type SpendLedger = z.infer<typeof ledgerSchema>;

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

export async function readSpendLedger(
  path = getAgentCashPaths().ledger,
  now = new Date(),
): Promise<SpendLedger> {
  try {
    const parsed = ledgerSchema.parse(JSON.parse(await readFile(path, "utf8")));
    if (parsed.date === utcDateKey(now)) {
      return parsed;
    }
  } catch (error) {
    if (!isMissingFile(error)) {
      throw error;
    }
  }
  return { date: utcDateKey(now), spentAtomic: "0" };
}

export async function reserveSpend(
  amountAtomic: bigint,
  caps: SpendCaps,
  options?: { ledgerPath?: string; now?: Date },
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
  return await withLedgerLock(ledgerPath, async () => {
    const ledger = await readSpendLedger(ledgerPath, now);
    const nextSpent = BigInt(ledger.spentAtomic) + amountAtomic;
    if (nextSpent > perDayAtomic) {
      throw new SpendCapError(
        "per_day_cap_exceeded",
        `Payment quote ${amountAtomic} atomic USDC would raise today's spend to ${nextSpent}, above the per-day cap ${perDayAtomic}. Refusing to sign.`,
      );
    }
    const nextLedger = {
      date: utcDateKey(now),
      spentAtomic: nextSpent.toString(),
    };
    await writeLedgerAtomically(ledgerPath, nextLedger);
    return nextLedger;
  });
}

function parseAtomicCap(value: string, label: string): bigint {
  if (!/^\d+$/.test(value)) {
    throw new Error(`Invalid ${label} spend cap ${JSON.stringify(value)}.`);
  }
  return BigInt(value);
}

async function writeLedgerAtomically(path: string, ledger: SpendLedger) {
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
