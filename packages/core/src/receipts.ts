import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { z } from "zod";

import { runRefSchema, type RunRef } from "./agent-run.js";
import { withFileLock } from "./atomic-file.js";
import { getVapiPaths, isMissingFile } from "./config.js";
import type { ListingProvenance } from "./discovery.js";
import { explorerTransactionUrl } from "./networks.js";
import { DEFAULT_WALLET_NAME, walletNameSchema, type WalletName } from "./wallet-name.js";
import type { X402SettlementOutcome } from "./x402.js";

interface ReceiptTestHooks {
  beforeRenameReplace?: (path: string) => void | Promise<void>;
}

let receiptTestHooks: ReceiptTestHooks | undefined;

export function __setReceiptTestHooks(hooks: ReceiptTestHooks | undefined): void {
  receiptTestHooks = hooks;
}

const RECEIPT_JOURNAL_BUSY_MESSAGE =
  "The receipt journal is busy. Wait for the other vapi command to finish, then retry.";

/** Serializes every append and rewrite of one receipt journal. */
export async function withReceiptJournalLock<T>(
  path: string,
  operation: () => Promise<T>,
): Promise<T> {
  return await withFileLock(`${path}.lock`, operation, {
    lockedMessage: RECEIPT_JOURNAL_BUSY_MESSAGE,
  });
}

export interface Receipt {
  readonly id: string;
  readonly timestamp: string;
  readonly run?: Readonly<RunRef>;
  readonly kind?: "transfer";
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
  readonly transfer?: Readonly<{
    to: string;
    toName: string;
    toKind: "owner" | "account";
    amountAtomic: string;
    network: string;
    nonce: string;
    status: "sent" | "unknown" | "failed";
    txHash: string | null;
    replayed: boolean;
    reservedOn?: string;
    request?: Readonly<{
      authorization: Readonly<{
        from: string;
        to: string;
        value: string;
        validAfter: string;
        validBefore: string;
        nonce: string;
      }>;
      signature: string;
    }>;
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
  run: runRefSchema.optional(),
  kind: z.literal("transfer").optional(),
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
  transfer: z
    .strictObject({
      to: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
      toName: z.string().min(1),
      toKind: z.enum(["owner", "account"]),
      amountAtomic: z.string().regex(/^\d+$/),
      network: z.string().min(1),
      nonce: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
      status: z.enum(["sent", "unknown", "failed"]),
      txHash: z
        .string()
        .regex(/^0x[0-9a-fA-F]+$/)
        .nullable(),
      replayed: z.boolean(),
      reservedOn: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional(),
      request: z
        .strictObject({
          authorization: z.strictObject({
            from: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
            to: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
            value: z.string().regex(/^\d+$/),
            validAfter: z.string().regex(/^\d+$/),
            validBefore: z.string().regex(/^\d+$/),
            nonce: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
          }),
          signature: z.string().regex(/^0x[0-9a-fA-F]+$/),
        })
        .optional(),
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
  await withReceiptJournalLock(path, async () => {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const handle = await open(path, "a", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(parsed)}\n`, "utf8");
    } finally {
      await handle.close();
    }
  });
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
  const records = coalesceTransferReceiptRevisions(
    raw
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line, index) => {
        try {
          return parseReceipt(JSON.parse(line));
        } catch (error) {
          throw new Error(`Invalid receipt on JSONL line ${index + 1}.`, { cause: error });
        }
      }),
  );
  const filtered =
    options.wallet === undefined ? records : filterReceiptsByWallet(records, options.wallet);
  const limit = options.limit;
  if (limit === undefined) return filtered;
  if (!Number.isSafeInteger(limit) || limit < 0)
    throw new Error("Receipt limit must be a non-negative integer.");
  return limit === 0 ? [] : filtered.slice(-limit);
}

/**
 * A transfer writes its signed authorization before contacting the relay, then
 * appends the terminal outcome under the same receipt id. Keep the file
 * append-only while presenting those records as one logical receipt.
 */
function coalesceTransferReceiptRevisions(receipts: readonly Receipt[]): Receipt[] {
  const coalesced: Receipt[] = [];
  const transferIndexes = new Map<string, number>();
  for (const receipt of receipts) {
    const existing = receipt.kind === "transfer" ? transferIndexes.get(receipt.id) : undefined;
    if (existing === undefined) {
      if (receipt.kind === "transfer") transferIndexes.set(receipt.id, coalesced.length);
      coalesced.push(receipt);
    } else {
      coalesced[existing] = receipt;
    }
  }
  return coalesced;
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
  return await withReceiptJournalLock(path, async () => {
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
    await receiptTestHooks?.beforeRenameReplace?.(path);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporaryPath = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    await writeFile(temporaryPath, lines.join("\n"), {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await rename(temporaryPath, path);
    return changed;
  });
}
