import {
  MARKETPLACE_KINDS,
  isMirroredHit,
  isSolanaAddress,
  isSupportedPaymentNetwork,
  listingConformanceSchema,
  listingFeeSchema,
  listingGroupSchema,
  listingIdentitySchema,
  listingLivenessSchema,
  listingVerificationSchema,
  marketplaceDiscoveryPageSchema,
  marketplaceKindSchema,
  walletNameSchema,
  type CeilingSweepHook,
  type MarketplaceHit,
  type RunBudget,
  type RunRef,
  type SpendCaps,
  type VapiConfig,
  type VapiPaymentAccount,
} from "@vapi-network/core";
import { z } from "zod";

import { callService, type CallToolInput, type CallToolResult } from "../tools/call.js";
import { inspectService, type InspectToolInput } from "../tools/inspect.js";
import { searchMarketplace, type MarketplaceSearchInput } from "../tools/search.js";
import { inspectionCacheKey, type CallPort } from "./context.js";
import { defineAction } from "./define.js";

export const MAX_CACHED_MARKETPLACE_REFS = 200;

export const walletArgument = {
  wallet: walletNameSchema
    .optional()
    .describe(
      "Account name. Without it: the session's active account, then VAPI_WALLET, then the machine default.",
    ),
};

export const callToolResultSchema = z.object({
  wallet: z.string(),
  status: z.number().int(),
  body: z.unknown(),
  resourceUrl: z.url().optional(),
  // Absent when the call went to an explicit URL, which has no listing.
  verification: listingVerificationSchema.optional(),
  payment: z
    .object({
      network: z.string(),
      amountAtomic: z.string(),
      amountUsd: z.string(),
      asset: z.string(),
      payTo: z.string(),
      settlement: z.unknown().nullable(),
      proof: z.string().nullable(),
    })
    .nullable(),
  outcome: z.literal("signed_in").optional(),
  expectedRequest: z
    .object({
      contentType: z.string().optional(),
      schema: z.unknown().optional(),
    })
    .optional(),
});

export const inspectToolResultSchema = z.object({
  name: z.string(),
  method: z.string().nullable(),
  url: z.url(),
  price: z.string(),
  description: z.string(),
  operationId: z.string().optional(),
  requestContentType: z.string().optional(),
  requestSchema: z.unknown().optional(),
  responseContentType: z.string().optional(),
  network: z.string().optional(),
  // Registry-owned listing disclosures, mirrored from call.search.
  group: listingGroupSchema.optional(),
  fee: listingFeeSchema.optional(),
  verification: listingVerificationSchema,
  liveness: listingLivenessSchema.optional(),
  conformance: listingConformanceSchema.optional(),
  identity: listingIdentitySchema.optional(),
  payment: z
    .object({
      scheme: z.literal("exact"),
      network: z.string(),
      asset: z.string(),
      payTo: z.string(),
      checkedAt: z.string(),
    })
    .nullable(),
});

export const callSearchInputSchema = z.object({
  query: z.string().trim().max(200).optional().describe("Capability, API, service, or request."),
  kinds: z
    .array(marketplaceKindSchema)
    .min(1)
    .max(MARKETPLACE_KINDS.length)
    .refine((values) => new Set(values).size === values.length, "Kinds must be unique.")
    .optional(),
  network: z.string().trim().min(1).max(160).optional(),
  limit: z.number().int().min(1).max(50).optional(),
  cursor: z.string().trim().min(1).max(4_096).optional(),
  includeUnverified: z
    .boolean()
    .optional()
    .describe(
      "Default results are vAPI-verified listings plus mirrored external catalogs; includeUnverified: true adds unverified self-listed APIs, which passed vAPI's automated x402 probe but were not reviewed.",
    ),
});

export const callInspectInputSchema = z.object({
  id: z.string().min(1).describe("API ref returned by call.search in this vAPI process."),
  endpoint: z.string().trim().min(1).optional().describe("Named endpoint to inspect."),
});

export const callPayInputSchema = z.object({
  ...walletArgument,
  id: z.string().min(1).optional().describe("API ref returned by call.search."),
  url: z.url().optional().describe("Explicit published API URL for a direct call."),
  method: z.string().min(1).optional(),
  endpoint: z.string().trim().min(1).optional().describe("Named endpoint to invoke."),
  body: z.unknown().optional(),
  contentType: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .regex(/^[^\r\n]+$/)
    .optional(),
  network: z
    .string()
    .refine(isSupportedPaymentNetwork, "Expected a supported EVM or Solana network identifier.")
    .optional(),
  expectedPayTo: z
    .string()
    .refine(
      (value) => /^0x[0-9a-fA-F]{40}$/.test(value) || isSolanaAddress(value),
      "Expected an EVM or Solana address.",
    )
    .optional(),
  maxPriceUsd: z
    .union([z.number().nonnegative(), z.string().regex(/^\d+(?:\.\d{1,6})?$/)])
    .optional(),
});

export const callSearch = defineAction<
  z.infer<typeof callSearchInputSchema>,
  z.infer<typeof marketplaceDiscoveryPageSchema>
>({
  name: "call.search",
  description:
    "Search the public vAPI Marketplace for APIs, services, and open requests. API results can be paid locally; other results continue at their web action. Search returns public cards, not request bodies — use call.inspect before call.pay whenever the request contract is not already known.",
  input: callSearchInputSchema,
  output: marketplaceDiscoveryPageSchema,
  money: "none",
  grant: "call",
  async run(input, ctx) {
    const page = await ctx.call.search(input);
    if (ctx.caller.run) {
      for (const item of page.items) ctx.caller.run.searchedRefs.add(item.ref);
    }
    return page;
  },
});

export const callInspect = defineAction<
  z.infer<typeof callInspectInputSchema>,
  z.infer<typeof inspectToolResultSchema>
>({
  name: "call.inspect",
  description:
    "Read a listing's executable request contract for free. Use this before call.pay whenever the required request body is not already known.",
  input: callInspectInputSchema,
  output: inspectToolResultSchema,
  money: "none",
  grant: "call",
  async run(input, ctx) {
    const cacheKey = inspectionCacheKey(input);
    const cached = ctx.caller.run?.inspected.get(cacheKey);
    if (cached) return cached as z.infer<typeof inspectToolResultSchema>;
    const result = await ctx.call.inspect(input);
    ctx.caller.run?.inspected.set(cacheKey, result);
    return result as z.infer<typeof inspectToolResultSchema>;
  },
});

export const callPay = defineAction<
  z.infer<typeof callPayInputSchema>,
  { wallet: string } & CallToolResult
>({
  name: "call.pay",
  description:
    "Call an API retained from this process's call.search, or an explicit x402 URL, and pay it directly from the local account. The account's own per-call and per-day spend caps are applied before anything is signed. Prefer a listing whose verification is \"verified\"; before paying one that is not, read its request contract and its price with call.inspect.",
  input: callPayInputSchema,
  output: callToolResultSchema,
  money: "spends",
  grant: "call",
  async run(input, ctx) {
    return await ctx.call.pay(input);
  },
});

export type PaymentResolution = {
  account: VapiPaymentAccount;
  wallet: string;
  runBudget?: RunBudget;
  run?: RunRef;
  spendCaps?: SpendCaps;
  ledgerPath: string;
  receiptsPath: string;
  fetchImpl?: typeof fetch;
  ceilingSweep?: CeilingSweepHook | false;
  now?: Date;
  allowanceExpiresAt?: Date;
};

export type CreateCallPortOptions = {
  config: VapiConfig;
  fetchImpl?: typeof fetch;
  searchesPath?: string;
  notice?: (message: string) => void;
  cacheMarketplaceHits?: boolean | "optional";
  resolvePayment: (wallet?: string) => Promise<PaymentResolution>;
};

export function createCallPort(options: CreateCallPortOptions): CallPort {
  const searchedMarketplaceHits = options.cacheMarketplaceHits
    ? new Map<string, MarketplaceHit[]>()
    : undefined;
  return {
    async search(input: MarketplaceSearchInput) {
      const page = await searchMarketplace(input, options.config, options.fetchImpl, {
        ...(options.searchesPath === undefined ? {} : { searchesPath: options.searchesPath }),
        ...(options.notice === undefined ? {} : { notice: options.notice }),
      });
      if (searchedMarketplaceHits) rememberMarketplaceHits(searchedMarketplaceHits, page.items);
      return page;
    },
    async inspect(input: InspectToolInput) {
      return await inspectService(input, options.config, options.fetchImpl);
    },
    async pay(input: CallToolInput & { wallet?: string }) {
      const { wallet, ...call } = input;
      const payment = await options.resolvePayment(wallet);
      const result = await callService({
        input: call,
        ...(searchedMarketplaceHits
          ? {
              marketplaceHit: cachedMarketplaceHit(
                searchedMarketplaceHits,
                call.id,
                options.cacheMarketplaceHits === "optional",
              ),
            }
          : {}),
        account: payment.account,
        config: options.config,
        ledgerPath: payment.ledgerPath,
        receiptsPath: payment.receiptsPath,
        wallet: payment.wallet,
        ...(payment.runBudget === undefined ? {} : { runBudget: payment.runBudget }),
        ...(payment.run === undefined ? {} : { run: payment.run }),
        ...(payment.spendCaps === undefined ? {} : { spendCaps: payment.spendCaps }),
        ...(payment.fetchImpl === undefined ? {} : { fetchImpl: payment.fetchImpl }),
        ...(payment.ceilingSweep === undefined ? {} : { ceilingSweep: payment.ceilingSweep }),
        ...(payment.now === undefined ? {} : { now: payment.now }),
        ...(payment.allowanceExpiresAt === undefined
          ? {}
          : { allowanceExpiresAt: payment.allowanceExpiresAt }),
      });
      return { wallet: payment.wallet, ...result };
    },
  };
}

function indexMarketplaceHits(items: MarketplaceHit[]): Map<string, MarketplaceHit[]> {
  const indexed = new Map<string, MarketplaceHit[]>();
  for (const item of items) {
    const matches = indexed.get(item.ref) ?? [];
    matches.push(item);
    indexed.set(item.ref, matches);
  }
  return indexed;
}

function rememberMarketplaceHits(
  indexed: Map<string, MarketplaceHit[]>,
  items: MarketplaceHit[],
): void {
  for (const [ref, incoming] of indexMarketplaceHits(items)) {
    const incomingIdentities = new Set(incoming.map(marketplaceHitIdentity));
    const retained = (indexed.get(ref) ?? []).filter(
      (hit) => !incomingIdentities.has(marketplaceHitIdentity(hit)),
    );
    indexed.delete(ref);
    indexed.set(ref, [...retained, ...incoming]);
  }
  while (indexed.size > MAX_CACHED_MARKETPLACE_REFS) {
    const oldestRef = indexed.keys().next().value;
    if (oldestRef === undefined) break;
    indexed.delete(oldestRef);
  }
}

function marketplaceHitIdentity(hit: MarketplaceHit): string {
  return `${hit.kind}\u0000${isMirroredHit(hit) ? "external" : "first_party"}`;
}

function cachedMarketplaceHit(
  indexed: Map<string, MarketplaceHit[]>,
  id: string | undefined,
  allowMissing = false,
): MarketplaceHit | undefined {
  if (!id) return undefined;
  const matches = indexed.get(id) ?? [];
  if (matches.length === 0) {
    if (allowMissing) return undefined;
    throw new Error(
      `Marketplace result ${JSON.stringify(id)} is not retained by this vAPI process; run call.search again or call its published URL directly.`,
    );
  }
  if (matches.length > 1) {
    throw new Error(
      `Marketplace ref ${JSON.stringify(id)} is ambiguous across result sources or kinds; use the result's canonical action instead.`,
    );
  }
  return matches[0];
}
