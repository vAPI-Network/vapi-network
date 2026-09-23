import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { z } from "zod";

import { getVapiPaths, isMissingFile } from "./config.js";
import type { ListingProvenance } from "./discovery.js";
import { explorerTransactionUrl } from "./networks.js";
import { DEFAULT_WALLET_NAME, walletNameSchema, type WalletName } from "./wallet-name.js";
import type { X402SettlementOutcome } from "./x402.js";

export interface Receipt {
  readonly id: string;
  readonly timestamp: string;
  /** The wallet that paid. Absent on receipts written before named wallets, which belong to `main`. */
  readonly wallet?: string;
  readonly resourceUrl: string;
  readonly method?: string;
  /** Primary discovery source retained for compatibility with early receipt writers. */
  readonly source?: string;
  readonly provenance?: readonly ListingProvenance[];
  readonly quote?: Readonly<{
    network: string;
    asset?: string;
    amountAtomic: string;
    payTo?: string;
  }>;
  readonly payer?: string;
  /**
   * The x402 payment-identifier id sent with this payment. Absent on receipts
   * written before it and when the server did not advertise payment-identifier.
   */
  readonly paymentId?: string;
  /**
   * The EIP-3009 authorization this call signed, kept so a payment whose
   * response was lost can be settled against the chain later with
   * `vapi pay --resume`. The token and the network are the quote's `asset` and
   * `network`. Absent on receipts written before 0.4.0, on Solana payments,
   * and on calls that signed no payment.
   */
  readonly authorization?: Readonly<{
    from: string;
    nonce: string;
    validBefore: string;
  }>;
  readonly settlement?: Readonly<{
    outcome: X402SettlementOutcome;
    transaction?: string;
    explorerUrl?: string;
    evidence?: unknown;
  }>;
  readonly latencyMs?: number;
  readonly status?: number;
  readonly error?: Readonly<{ code: string; message: string }>;
  readonly phases?: Readonly<{
    discoverMs?: number;
    quoteMs?: number;
    signMs?: number;
    requestMs?: number;
    settleMs?: number;
  }>;
  readonly listing?: Readonly<{
    name?: string;
    providerHost?: string;
    source: string;
  }>;
  readonly retry?: number;
  readonly policy?: Readonly<{
    maxPriceUsd?: string;
    capsApplied: boolean;
  }>;
  readonly client?: Readonly<{
    name: "vapi-network";
    version: string;
  }>;
  readonly outcome?:
    | "paid"
    | "signed_in"
    | "declined_policy"
    | "failed_request"
    | "settlement_rejected"
    | "settlement_unknown";
}

const durationSchema = z.number().nonnegative().finite();

const receiptSchema: z.ZodType<Receipt> = z.strictObject({
  id: z.string().min(1),
  timestamp: z.iso.datetime(),
  wallet: walletNameSchema.optional(),
  resourceUrl: z.url(),
  method: z.string().min(1).optional(),
  source: z.string().min(1).optional(),
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
      asset: z.string().optional(),
      amountAtomic: z.string().regex(/^\d+$/),
      payTo: z.string().optional(),
    })
    .optional(),
  payer: z.string().optional(),
  paymentId: z
    .string()
    .regex(/^[A-Za-z0-9_-]{16,128}$/)
    .optional(),
  authorization: z
    .strictObject({
      from: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
      nonce: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
      validBefore: z.string().regex(/^\d+$/),
    })
    .optional(),
  settlement: z
    .strictObject({
      outcome: z.enum(["succeeded", "rejected", "unknown"]),
      transaction: z.string().optional(),
      explorerUrl: z.url().optional(),
      evidence: z.unknown().optional(),
    })
    .optional(),
  latencyMs: z.number().nonnegative().finite().optional(),
  status: z.number().int().min(100).max(599).optional(),
  error: z.strictObject({ code: z.string(), message: z.string() }).optional(),
  phases: z
    .strictObject({
      discoverMs: durationSchema.optional(),
      quoteMs: durationSchema.optional(),
      signMs: durationSchema.optional(),
      requestMs: durationSchema.optional(),
      settleMs: durationSchema.optional(),
    })
    .optional(),
  listing: z
    .strictObject({
      name: z.string().min(1).optional(),
      providerHost: z.string().min(1).optional(),
      source: z.string().min(1),
    })
    .optional(),
  retry: z.number().int().nonnegative().optional(),
  policy: z
    .strictObject({
      maxPriceUsd: z
        .string()
        .regex(/^\d+(?:\.\d{1,6})?$/)
        .optional(),
      capsApplied: z.boolean(),
    })
    .optional(),
  client: z
    .strictObject({ name: z.literal("vapi-network"), version: z.string().min(1) })
    .optional(),
  outcome: z
    .enum([
      "paid",
      "signed_in",
      "declined_policy",
      "failed_request",
      "settlement_rejected",
      "settlement_unknown",
    ])
    .optional(),
});

export function parseReceipt(value: unknown): Receipt {
  const receipt = receiptSchema.parse(value);
  const transaction = receipt.settlement?.transaction;
  const network = receipt.quote?.network;
  const explorerUrl =
    transaction === undefined || network === undefined
      ? undefined
      : explorerTransactionUrl(network, transaction);
  if (explorerUrl === undefined || receipt.settlement?.explorerUrl === explorerUrl) {
    return receipt;
  }
  return {
    ...receipt,
    settlement: {
      outcome: receipt.settlement!.outcome,
      ...(receipt.settlement!.transaction ? { transaction: receipt.settlement!.transaction } : {}),
      explorerUrl,
      ...(receipt.settlement!.evidence === undefined
        ? {}
        : { evidence: receipt.settlement!.evidence }),
    },
  };
}

/**
 * Append exactly one receipt as one JSONL record. Existing records are never
 * rewritten. `options.wallet` names the wallet that paid when the receipt does
 * not already carry one.
 */
export async function appendReceipt(
  receipt: Receipt,
  path = getVapiPaths().receipts,
  options: { wallet?: string } = {},
): Promise<Receipt> {
  const parsed = parseReceipt(
    receipt.wallet === undefined && options.wallet !== undefined
      ? { ...receipt, wallet: options.wallet }
      : receipt,
  );
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
  options: { limit?: number; wallet?: string } = {},
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
  const filtered =
    options.wallet === undefined ? records : filterReceiptsByWallet(records, options.wallet);
  const limit = options.limit;
  if (limit === undefined) return filtered;
  if (!Number.isSafeInteger(limit) || limit < 0)
    throw new Error("Receipt limit must be a non-negative integer.");
  return limit === 0 ? [] : filtered.slice(-limit);
}

/** The wallet a receipt belongs to; rows written before named wallets are `main`. */
export function receiptWallet(receipt: Receipt): WalletName {
  return receipt.wallet ?? DEFAULT_WALLET_NAME;
}

/** Keeps the receipts of one wallet, counting rows without a wallet as `main`. */
export function filterReceiptsByWallet(receipts: readonly Receipt[], name: WalletName): Receipt[] {
  return receipts.filter((receipt) => receiptWallet(receipt) === name);
}

/**
 * Rewrites the wallet field of every matching row after a wallet is renamed.
 * Rows of other wallets keep their exact bytes, and the file is replaced in one
 * atomic rename. Returns how many rows changed.
 */
export async function renameReceiptWallet(
  from: WalletName,
  to: WalletName,
  path = getVapiPaths().receipts,
): Promise<number> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isMissingFile(error)) return 0;
    throw error;
  }
  let changed = 0;
  const lines = raw.split("\n").map((line, index) => {
    if (line.trim().length === 0) return line;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      throw new Error(`Invalid receipt on JSONL line ${index + 1}.`, { cause: error });
    }
    const current =
      typeof parsed === "object" && parsed !== null ? Reflect.get(parsed, "wallet") : undefined;
    if ((typeof current === "string" ? current : DEFAULT_WALLET_NAME) !== from) return line;
    changed += 1;
    return JSON.stringify(parseReceipt({ ...(parsed as Receipt), wallet: to }));
  });
  if (changed === 0) return 0;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(temporaryPath, lines.join("\n"), {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  await rename(temporaryPath, path);
  return changed;
}
