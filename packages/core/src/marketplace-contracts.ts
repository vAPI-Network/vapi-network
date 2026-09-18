// Extracted from @vapi/marketplace-contracts; schema meaning intentionally unchanged.
//
// Tolerance policy: every schema here that describes something the registry
// RETURNS is a loose object, so a registry that starts sending an additional
// field never breaks an installed client. Only `marketplaceDiscoveryInputSchema`
// — the request this client builds — stays strict. Loose parsing keeps unknown
// keys, so additive server fields also reach `--json` consumers untouched.
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

/**
 * The presentation group the registry assigns a Call listing, and the network
 * fee already inside its advertised price. Both are registry-owned disclosures
 * this client only displays, so both stay optional: a registry that predates
 * them omits them, and a newer one may extend the fee object.
 */
export const LISTING_GROUPS = ["vapi", "added", "partner", "external"] as const;
export const listingGroupSchema = z.enum(LISTING_GROUPS);
export type ListingGroup = z.infer<typeof listingGroupSchema>;

export const listingFeeSchema = z.looseObject({
  bps: z.number().int().min(0),
  label: z.string(),
});
export type ListingFee = z.infer<typeof listingFeeSchema>;

/** The group/fee pair the registry returns on every Call listing and discovery hit. */
export const listingDisclosureShape = {
  group: listingGroupSchema.optional(),
  fee: listingFeeSchema.optional(),
} as const;

export const marketplaceBadgeCodeSchema = z.enum([
  "live_x402",
  "partner",
  "payout_wallet_confirmed",
  "vapi_verified",
  "external_catalog",
  "approved_vendor",
]);
export type MarketplaceBadgeCode = z.infer<typeof marketplaceBadgeCodeSchema>;

export const marketplaceBadgeSchema = z.looseObject({
  code: marketplaceBadgeCodeSchema,
  label: z.string().trim().min(1).max(80),
});
export type MarketplaceBadge = z.infer<typeof marketplaceBadgeSchema>;

export const marketplacePublicFactSchema = z.looseObject({
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

const marketplaceCardSchema = z.looseObject({
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
  ...listingDisclosureShape,
} as const;

const invokeApiActionSchema = z.looseObject({
  type: z.literal("invoke_api"),
  href: marketplaceHrefSchema,
});

/**
 * A listing vAPI holds its own record for. The caller resolves the payable
 * target from `ref`, so no target is carried on the card. These may be fronted
 * by a vAPI gateway, hence the open `executionMode`.
 */
const firstPartyApiMarketplaceHitSchema = z.looseObject({
  ...marketplaceHitBase,
  kind: z.literal("api"),
  provenance: firstPartyProvenanceSchema,
  execution: z.looseObject({
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
const mirroredApiMarketplaceHitSchema = z.looseObject({
  ...marketplaceHitBase,
  kind: z.literal("api"),
  provenance: z.literal("indexed"),
  execution: z.looseObject({
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

export const serviceOfferMarketplaceHitSchema = z.looseObject({
  ...marketplaceHitBase,
  kind: z.literal("service_offer"),
  action: z.looseObject({
    type: z.literal("start_engagement"),
    href: marketplaceHrefSchema,
  }),
});
export type ServiceOfferMarketplaceHit = z.infer<typeof serviceOfferMarketplaceHitSchema>;

export const openRequestMarketplaceHitSchema = z.looseObject({
  ...marketplaceHitBase,
  kind: z.literal("open_request"),
  action: z.looseObject({
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

// The client builds this request, so it stays strict: a typo in a filter is a
// client bug and must fail here rather than travel to the registry unnoticed.
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

export const marketplaceDiscoveryPageSchema = z.looseObject({
  protocol: z.literal(MARKETPLACE_DISCOVERY_PROTOCOL),
  items: z.array(marketplaceHitSchema),
  nextCursor: z.string().min(1).max(4_096).nullable(),
  unavailableKinds: z.array(marketplaceKindSchema).max(MARKETPLACE_KINDS.length),
  rankingVersion: z.literal(MARKETPLACE_RANKING_VERSION),
});
export type MarketplaceDiscoveryPage = z.infer<typeof marketplaceDiscoveryPageSchema>;
