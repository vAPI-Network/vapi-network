// Extracted from @vapi/marketplace-contracts; schema meaning intentionally unchanged.
import { z } from "zod";

export const MARKETPLACE_DISCOVERY_PROTOCOL = "vapi.marketplace.discovery/1" as const;
export const MARKETPLACE_RANKING_VERSION = "marketplace-ranking-v1" as const;
export const MARKETPLACE_KINDS = ["api", "service_offer", "open_request"] as const;
export const MARKETPLACE_EXECUTION_METHODS = [
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
] as const;
export const marketplaceExecutionMethodSchema = z.enum(MARKETPLACE_EXECUTION_METHODS);
export type MarketplaceExecutionMethod = z.infer<typeof marketplaceExecutionMethodSchema>;

export const marketplaceKindSchema = z.enum(MARKETPLACE_KINDS);
export type MarketplaceKind = z.infer<typeof marketplaceKindSchema>;

/**
 * The two orthogonal axes that describe an API listing, per
 * `docs/adr/0008-two-axis-call-taxonomy.md`. `executionMode` answers "is vAPI in
 * the request path"; `provenance` answers "where did this come from and what did
 * we vouch for". Neither implies the other, and only `kind: "api"` carries them —
 * Work kinds are first-party by construction and have no execution surface.
 */
export const EXECUTION_MODES = ["direct", "gateway"] as const;
export const executionModeSchema = z.enum(EXECUTION_MODES);
export type ExecutionMode = z.infer<typeof executionModeSchema>;

export const PROVENANCES = ["indexed", "self_listed", "partner"] as const;
export const provenanceSchema = z.enum(PROVENANCES);
export type Provenance = z.infer<typeof provenanceSchema>;

/** Provenances vAPI itself holds a record for, as opposed to mirrored catalog rows. */
export const FIRST_PARTY_PROVENANCES = ["self_listed", "partner"] as const;
export const firstPartyProvenanceSchema = z.enum(FIRST_PARTY_PROVENANCES);
export type FirstPartyProvenance = z.infer<typeof firstPartyProvenanceSchema>;

export const marketplaceBadgeCodeSchema = z.enum([
  "live_x402",
  "partner",
  "payout_wallet_confirmed",
  "vapi_verified",
  "external_catalog",
  "approved_vendor",
]);
export type MarketplaceBadgeCode = z.infer<typeof marketplaceBadgeCodeSchema>;

export const marketplaceBadgeSchema = z.strictObject({
  code: marketplaceBadgeCodeSchema,
  label: z.string().trim().min(1).max(80),
});
export type MarketplaceBadge = z.infer<typeof marketplaceBadgeSchema>;

export const marketplacePublicFactSchema = z.strictObject({
  label: z.string().trim().min(1).max(80),
  value: z.string().trim().min(1).max(160),
});
export type MarketplacePublicFact = z.infer<typeof marketplacePublicFactSchema>;

const marketplaceHrefSchema = z.union([
  z
    .string()
    .trim()
    .min(1)
    .max(2_048)
    .regex(/^\/(?!\/)/),
  z
    .url()
    .max(2_048)
    .regex(/^https:\/\//),
]);

const marketplaceCardSchema = z.strictObject({
  title: z.string().trim().min(1).max(160),
  summary: z.string().trim().min(1).max(1_000),
  byline: z.string().trim().min(1).max(160).optional(),
  bylineHref: marketplaceHrefSchema.optional(),
  badges: z.array(marketplaceBadgeSchema).max(8),
  facts: z.array(marketplacePublicFactSchema).max(12),
});

const marketplaceHitBase = {
  ref: z.string().trim().min(1).max(512),
  card: marketplaceCardSchema,
} as const;

const invokeApiActionSchema = z.strictObject({
  type: z.literal("invoke_api"),
  href: marketplaceHrefSchema,
});

/**
 * A listing vAPI holds its own record for. The caller resolves the payable
 * target from `ref`, so no target is carried on the card. These may be fronted
 * by a vAPI gateway, hence the open `executionMode`.
 */
const firstPartyApiMarketplaceHitSchema = z.strictObject({
  ...marketplaceHitBase,
  kind: z.literal("api"),
  provenance: firstPartyProvenanceSchema,
  execution: z.strictObject({
    mode: executionModeSchema,
  }),
  action: invokeApiActionSchema,
});

/**
 * A listing mirrored from an external catalog. It carries its payable target
 * inline because vAPI holds no resolvable record of it. `mode` is pinned to
 * `direct`: vAPI never fronts a listing it merely mirrored
 * (`docs/adr/0009-mirror-external-catalogs-into-the-call-registry.md`).
 */
const mirroredApiMarketplaceHitSchema = z.strictObject({
  ...marketplaceHitBase,
  kind: z.literal("api"),
  provenance: z.literal("indexed"),
  execution: z.strictObject({
    mode: z.literal("direct"),
    url: z
      .url()
      .max(2_048)
      .regex(/^https:\/\/(?![^/?#]*@)/),
    method: marketplaceExecutionMethodSchema.nullable(),
    network: z
      .string()
      .trim()
      .max(160)
      .regex(/^eip155:[1-9]\d*$/),
  }),
  action: invokeApiActionSchema,
});

export const apiMarketplaceHitSchema = z.discriminatedUnion("provenance", [
  firstPartyApiMarketplaceHitSchema,
  mirroredApiMarketplaceHitSchema,
]);
export type ApiMarketplaceHit = z.infer<typeof apiMarketplaceHitSchema>;

export const serviceOfferMarketplaceHitSchema = z.strictObject({
  ...marketplaceHitBase,
  kind: z.literal("service_offer"),
  action: z.strictObject({
    type: z.literal("start_engagement"),
    href: marketplaceHrefSchema,
  }),
});
export type ServiceOfferMarketplaceHit = z.infer<typeof serviceOfferMarketplaceHitSchema>;

export const openRequestMarketplaceHitSchema = z.strictObject({
  ...marketplaceHitBase,
  kind: z.literal("open_request"),
  action: z.strictObject({
    type: z.literal("propose_to_request"),
    href: marketplaceHrefSchema,
  }),
});
export type OpenRequestMarketplaceHit = z.infer<typeof openRequestMarketplaceHitSchema>;

export const marketplaceHitSchema = z.union([
  apiMarketplaceHitSchema,
  serviceOfferMarketplaceHitSchema,
  openRequestMarketplaceHitSchema,
]);
export type MarketplaceHit = z.infer<typeof marketplaceHitSchema>;

export const marketplaceDiscoveryInputSchema = z
  .strictObject({
    q: z.string().trim().max(200).optional(),
    kinds: z.array(marketplaceKindSchema).min(1).max(MARKETPLACE_KINDS.length).optional(),
    network: z.string().trim().min(1).max(160).optional(),
    cursor: z.string().trim().min(1).max(4_096).optional(),
    limit: z.number().int().min(1).max(50).optional(),
    includeUnverified: z.boolean().optional(),
  })
  .superRefine((input, context) => {
    if (input.kinds && new Set(input.kinds).size !== input.kinds.length) {
      context.addIssue({
        code: "custom",
        path: ["kinds"],
        message: "Marketplace kinds must be unique",
      });
    }
  });
export type MarketplaceDiscoveryInput = z.infer<typeof marketplaceDiscoveryInputSchema>;

/**
 * True when a hit was mirrored from an external catalog rather than held by
 * vAPI. The one predicate both ranking and presentation need, defined once here
 * so neither has to re-derive it from the union shape.
 */
export function isMirroredHit(hit: MarketplaceHit): boolean {
  return hit.kind === "api" && hit.provenance === "indexed";
}

export const marketplaceDiscoveryPageSchema = z.strictObject({
  protocol: z.literal(MARKETPLACE_DISCOVERY_PROTOCOL),
  items: z.array(marketplaceHitSchema),
  nextCursor: z.string().min(1).max(4_096).nullable(),
  unavailableKinds: z.array(marketplaceKindSchema).max(MARKETPLACE_KINDS.length),
  rankingVersion: z.literal(MARKETPLACE_RANKING_VERSION),
});
export type MarketplaceDiscoveryPage = z.infer<typeof marketplaceDiscoveryPageSchema>;
