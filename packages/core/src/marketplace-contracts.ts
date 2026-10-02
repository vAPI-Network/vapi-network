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

/**
 * How far a listing got through vAPI review, per
 * `docs/adr/0018-open-listing-and-verification-tiers.md`. Listing is
 * permissionless, so this is a tier rather than a gate: `none` passed the
 * automated x402 probe and nothing more, `requested` is waiting for review, and
 * `verified` was reviewed by vAPI. Rows mirrored from an external catalog are
 * always `none` — vAPI reviewed nothing it merely mirrored.
 */
export const LISTING_VERIFICATIONS = ["none", "requested", "verified"] as const;
export const listingVerificationSchema = z.enum(LISTING_VERIFICATIONS);
export type ListingVerification = z.infer<typeof listingVerificationSchema>;

/**
 * The verification field as it is read off the wire. A registry that predates
 * the tier omits it and a later one may add a tier this client does not know;
 * both read as `none`, which is the safe answer for "we cannot show that vAPI
 * vouched for this".
 */
export const listingVerificationFieldSchema = listingVerificationSchema
  .default("none")
  .catch("none");

/**
 * How a listing answered vAPI's hourly re-probe over the last seven days. p95
 * rather than p99: about 168 samples a week would make p99 two data points.
 */
export const listingLivenessSchema = z.looseObject({
  uptime7d: z.number().min(0).max(1),
  latencyP50Ms: z.number().nonnegative().nullable(),
  latencyP95Ms: z.number().nonnegative().nullable(),
  checks7d: z.number().int().nonnegative(),
});
export type ListingLiveness = z.infer<typeof listingLivenessSchema>;

/**
 * How closely the listing's 402 follows the x402 version it declares, as the
 * registry's probe read it. `issues` are stable snake_case codes, the same
 * ones `vapi check` reports.
 */
export const listingConformanceSchema = z.looseObject({
  declaredVersion: z.union([z.literal(1), z.literal(2)]).nullable(),
  versionConformant: z.boolean(),
  offerTransport: z.enum(["body", "header", "both"]),
  issues: z.array(z.string()),
});
export type ListingConformance = z.infer<typeof listingConformanceSchema>;

/**
 * ERC-8004 agent identity on Base as the registry read it. This is newer than
 * most registries, so a missing or malformed value reads as absent.
 */
export const listingIdentitySchema = z.looseObject({
  erc8004Id: z.string().trim().min(1),
  reputation: z
    .looseObject({
      score: z.number().finite(),
      count: z.number().int().nonnegative(),
    })
    .optional()
    .catch(undefined),
});
export type ListingIdentity = z.infer<typeof listingIdentitySchema>;

/**
 * The disclosures the registry returns on every Call listing and discovery hit.
 * `liveness` and `conformance` are newer than most registries, so a missing or
 * malformed value reads as absent instead of failing the listing around it.
 */
export const listingDisclosureShape = {
  group: listingGroupSchema.optional(),
  fee: listingFeeSchema.optional(),
  verification: listingVerificationFieldSchema,
  liveness: listingLivenessSchema.optional().catch(undefined),
  conformance: listingConformanceSchema.optional().catch(undefined),
  identity: listingIdentitySchema.optional().catch(undefined),
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
