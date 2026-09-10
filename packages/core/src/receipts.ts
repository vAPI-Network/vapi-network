import { mkdir, open, readFile } from "node:fs/promises";
import { dirname } from "node:path";

import { z } from "zod";

import { getVapiPaths, isMissingFile } from "./config.js";
import type { ListingProvenance } from "./discovery.js";
import type { X402SettlementOutcome } from "./x402.js";

export interface Receipt {
  readonly id: string;
  readonly timestamp: string;
  readonly resourceUrl: string;
  readonly method?: string;
  readonly provenance?: readonly ListingProvenance[];
  readonly quote?: Readonly<{
    network: string;
    asset: string;
    amountAtomic: string;
    payTo: string;
  }>;
  readonly payer?: string;
  readonly settlement?: Readonly<{
    outcome: X402SettlementOutcome;
    transaction?: string;
    evidence?: unknown;
  }>;
  readonly latencyMs?: number;
  readonly status?: number;
  readonly error?: Readonly<{ code: string; message: string }>;
}

const receiptSchema: z.ZodType<Receipt> = z.strictObject({
  id: z.string().min(1),
  timestamp: z.iso.datetime(),
  resourceUrl: z.url(),
  method: z.string().min(1).optional(),
  provenance: z
    .array(
      z.strictObject({
        source: z.string().min(1),
        sourceUrl: z.string().optional(),
        ref: z.string().optional(),
      }),
    )
    .optional(),
  quote: z
    .strictObject({
      network: z.string(),
      asset: z.string(),
      amountAtomic: z.string().regex(/^\d+$/),
      payTo: z.string(),
    })
    .optional(),
  payer: z.string().optional(),
  settlement: z
    .strictObject({
      outcome: z.enum(["succeeded", "rejected", "unknown"]),
      transaction: z.string().optional(),
      evidence: z.unknown().optional(),
    })
    .optional(),
  latencyMs: z.number().nonnegative().finite().optional(),
  status: z.number().int().min(100).max(599).optional(),
  error: z.strictObject({ code: z.string(), message: z.string() }).optional(),
});

export function parseReceipt(value: unknown): Receipt {
  return receiptSchema.parse(value);
}

/** Append exactly one receipt as one JSONL record. Existing records are never rewritten. */
export async function appendReceipt(
  receipt: Receipt,
  path = getVapiPaths().receipts,
): Promise<Receipt> {
  const parsed = parseReceipt(receipt);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const handle = await open(path, "a", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(parsed)}\n`, "utf8");
  } finally {
    await handle.close();
  }
  return parsed;
}

export async function readReceipts(
  path = getVapiPaths().receipts,
  options: { limit?: number } = {},
): Promise<Receipt[]> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isMissingFile(error)) return [];
    throw error;
  }
  const records = raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line, index) => {
      try {
        return parseReceipt(JSON.parse(line));
      } catch (error) {
        throw new Error(`Invalid receipt on JSONL line ${index + 1}.`, { cause: error });
      }
    });
  const limit = options.limit;
  if (limit === undefined) return records;
  if (!Number.isSafeInteger(limit) || limit < 0)
    throw new Error("Receipt limit must be a non-negative integer.");
  return limit === 0 ? [] : records.slice(-limit);
}

/** Compatibility alias used by early CLI code. */
export const listReceipts = readReceipts;
