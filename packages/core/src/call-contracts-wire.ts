// Extracted from @vapi/call-contracts; schema meaning intentionally unchanged.
//
// Every schema here describes a registry RESPONSE, so all of them are loose
// objects: additive server fields must never fail an installed client, and
// loose parsing passes them through to `--json` consumers unchanged.
import { z } from "zod";

import { listingDisclosureShape } from "./marketplace-contracts.js";
import { isSolanaAddress } from "./svm.js";
import { SOLANA_MAINNET_CAIP2 } from "./x402-networks.js";

export const CALLABLE_KIND = "agent" as const;
export const CALLABLE_CATEGORIES = ["ai", "data", "crypto", "compute", "search"] as const;

export const callableCategorySchema = z.enum(CALLABLE_CATEGORIES);
export type CallableCategory = z.infer<typeof callableCategorySchema>;

// Public discovery also federates API records whose provider catalog does not
// publish vAPI's internal category taxonomy. `other` belongs to the wire seam
// only; it is deliberately excluded from callable listing and publish policy.
export const DISCOVERY_CATEGORIES = [...CALLABLE_CATEGORIES, "other"] as const;
// Category and tier are labels used for display and filtering. Preserve future
// non-empty values so vocabulary growth cannot hide an executable service.
export const discoveryCategorySchema = z.string().trim().min(1);
export type DiscoveryCategory = z.infer<typeof discoveryCategorySchema>;

export const CALLABLE_CATEGORY_LABELS = {
  ai: { catalog: "AI / LLM", publish: "AI and models" },
  data: { catalog: "Data", publish: "Data" },
  crypto: { catalog: "Crypto", publish: "Crypto" },
  compute: { catalog: "Compute", publish: "Compute" },
  search: { catalog: "Search", publish: "Search" },
} as const satisfies Record<CallableCategory, { catalog: string; publish: string }>;

const CALLABLE_CATEGORY_SET = new Set<string>(CALLABLE_CATEGORIES);

export function isCallableListing(kind: string, category: string): boolean {
  return kind === CALLABLE_KIND && CALLABLE_CATEGORY_SET.has(category);
}

export const serviceTierSchema = z.string().trim().min(1);
export type ServiceTier = z.infer<typeof serviceTierSchema>;

export const discoveryEndpointSchema = z.looseObject({
  name: z.string(),
  method: z.string(),
  url: z.url(),
  price: z.string(),
  description: z.string(),
  operationId: z.string().trim().min(1).optional(),
  requestContentType: z.string().trim().min(1).optional(),
  requestSchema: z.json().optional(),
  responseSchema: z.json().optional().catch(undefined),
  exampleRequest: z
    .looseObject({
      query: z.record(z.string(), z.string()).optional().catch(undefined),
      body: z.json().optional(),
    })
    .optional()
    .catch(undefined),
  responseContentType: z.string().trim().min(1).optional(),
  pathTemplate: z.string().trim().min(1).optional(),
  pathParameters: z.array(z.string().trim().min(1)).optional(),
  payment: z
    .union([
      z.looseObject({
        scheme: z.literal("exact"),
        network: z.string().regex(/^eip155:\d+$/),
        asset: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
        payTo: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
        checkedAt: z.iso.datetime(),
      }),
      z.looseObject({
        scheme: z.literal("exact"),
        network: z.union([
          z.string().regex(/^solana:[-_a-zA-Z0-9]{1,32}$/),
          z.literal(SOLANA_MAINNET_CAIP2),
        ]),
        asset: z.string().refine(isSolanaAddress, "Expected a Solana base58 address."),
        payTo: z.string().refine(isSolanaAddress, "Expected a Solana base58 address."),
        checkedAt: z.iso.datetime(),
      }),
      z.looseObject({
        protocol: z.literal("mpp"),
        intent: z.enum(["charge", "authorize", "subscription"]).nullable(),
        method: z.string().trim().min(1).max(40).nullable(),
        checkedAt: z.iso.datetime(),
        // Keep common x402 properties readable on the union while making it
        // impossible for MPP metadata to masquerade as executable x402 terms.
        network: z.never().optional(),
        payTo: z.never().optional(),
      }),
      z.looseObject({
        // Future payment protocols remain visible to callers so the payment
        // layer can refuse them explicitly instead of discovery losing the row.
        protocol: z.string().trim().min(1).max(40),
        checkedAt: z.iso.datetime(),
        network: z.never().optional(),
        payTo: z.never().optional(),
      }),
    ])
    .optional(),
});
export type DiscoveryEndpoint = z.infer<typeof discoveryEndpointSchema>;

export const serviceSummarySchema = z.looseObject({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  category: discoveryCategorySchema,
  tier: serviceTierSchema,
  ...listingDisclosureShape,
  verified: z.boolean(),
  wrapped: z.boolean(),
  price: z.string(),
  networks: z.array(z.string()),
  endpoints: z.array(discoveryEndpointSchema),
});
export type ServiceSummary = z.infer<typeof serviceSummarySchema>;

// The public route is both the browse/list and query/search surface. The wire
// envelope is intentionally identical in both modes.
export const searchServicesResponseSchema = z.looseObject({
  services: z.array(serviceSummarySchema),
});
export type SearchServicesResponse = z.infer<typeof searchServicesResponseSchema>;

export const listServicesResponseSchema = searchServicesResponseSchema;
export type ListServicesResponse = z.infer<typeof listServicesResponseSchema>;

// Existing names retained for the Calls service and Agent Cash consumers.
export const discoveryServiceSchema = serviceSummarySchema;
export type DiscoveryService = ServiceSummary;
export const discoveryResponseSchema = searchServicesResponseSchema;
export type DiscoverServicesResult = SearchServicesResponse;
