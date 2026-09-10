// Extracted from @vapi/call-contracts; schema meaning intentionally unchanged.
import { z } from "zod";

export const CALLABLE_KIND = "agent" as const;
export const CALLABLE_CATEGORIES = ["ai", "data", "crypto", "compute", "search"] as const;

export const callableCategorySchema = z.enum(CALLABLE_CATEGORIES);
export type CallableCategory = z.infer<typeof callableCategorySchema>;

// Public discovery also federates API records whose provider catalog does not
// publish vAPI's internal category taxonomy. `other` belongs to the wire seam
// only; it is deliberately excluded from callable listing and publish policy.
export const DISCOVERY_CATEGORIES = [...CALLABLE_CATEGORIES, "other"] as const;
export const discoveryCategorySchema = z.enum(DISCOVERY_CATEGORIES);
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

export const serviceTierSchema = z.enum(["listed", "verified", "partner"]);
export type ServiceTier = z.infer<typeof serviceTierSchema>;

export const discoveryEndpointSchema = z.strictObject({
  name: z.string(),
  method: z.string(),
  url: z.url(),
  price: z.string(),
  description: z.string(),
  operationId: z.string().trim().min(1).optional(),
  requestContentType: z.string().trim().min(1).optional(),
  requestSchema: z.json().optional(),
  responseContentType: z.string().trim().min(1).optional(),
  pathTemplate: z.string().trim().min(1).optional(),
  pathParameters: z.array(z.string().trim().min(1)).optional(),
  payment: z
    .strictObject({
      scheme: z.literal("exact"),
      network: z.string().regex(/^eip155:\d+$/),
      asset: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
      payTo: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
      checkedAt: z.iso.datetime(),
    })
    .optional(),
});
export type DiscoveryEndpoint = z.infer<typeof discoveryEndpointSchema>;

export const serviceSummarySchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  category: discoveryCategorySchema,
  tier: serviceTierSchema,
  verified: z.boolean(),
  wrapped: z.boolean(),
  price: z.string(),
  networks: z.array(z.string()),
  endpoints: z.array(discoveryEndpointSchema),
});
export type ServiceSummary = z.infer<typeof serviceSummarySchema>;

// The public route is both the browse/list and query/search surface. The wire
// envelope is intentionally identical in both modes.
export const searchServicesResponseSchema = z.strictObject({
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
