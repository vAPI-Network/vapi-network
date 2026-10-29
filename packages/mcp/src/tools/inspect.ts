import {
  isDiscoveryCatalogError,
  formatListingFee,
  listingHealthSchema,
  type DiscoveryEndpoint,
  type ListingConformance,
  type ListingFee,
  type ListingGroup,
  type ListingHealth,
  type ListingIdentity,
  type ListingLiveness,
  type ListingVerification,
  type MarketplaceHit,
  type VapiConfig,
} from "@vapi-network/core";
import { findMarketplaceApiByRef, resolveServiceListing } from "./search.js";
import {
  assertSupportedListingNetwork,
  assertSupportedListingResolution,
  listingPaymentNetwork,
} from "./call.js";

export type InspectToolInput = {
  id: string;
  endpoint?: string;
};

export type InspectToolResult = Omit<
  Pick<
    DiscoveryEndpoint,
    | "name"
    | "method"
    | "url"
    | "price"
    | "description"
    | "operationId"
    | "requestContentType"
    | "requestSchema"
    | "responseSchema"
    | "exampleRequest"
    | "responseContentType"
  >,
  "method"
> & {
  method: string | null;
  network?: string;
  /** Registry-owned listing disclosures; absent when the registry omits them. */
  group?: ListingGroup;
  fee?: ListingFee;
  /** Human-readable fee including the percentage, while fee preserves wire metadata. */
  feeDisplay?: string;
  /**
   * How far the listing got through vAPI review. Reads as `none` for a registry
   * that predates the tier, and for every mirrored external row.
   */
  verification: ListingVerification;
  /** Seven days of the registry's hourly re-probe; absent when it sends none. */
  liveness?: ListingLiveness;
  health?: ListingHealth;
  /** How closely the listing's 402 follows its declared x402 version. */
  conformance?: ListingConformance;
  /** ERC-8004 agent identity on Base, when the registry has read one. */
  identity?: ListingIdentity;
  payment: DiscoveryEndpoint["payment"] | null;
};

export async function inspectService(
  input: InspectToolInput,
  config: VapiConfig,
  fetchImpl?: typeof fetch,
): Promise<InspectToolResult> {
  let listing: Awaited<ReturnType<typeof resolveServiceListing>>;
  try {
    listing = await resolveServiceListing(input.id, config, fetchImpl, input.endpoint);
  } catch (error) {
    assertSupportedListingResolution(error);
    if (input.endpoint || !isDiscoveryCatalogError(error) || error.code !== "service_not_found") {
      throw error;
    }
    const hit = await findMarketplaceApiByRef(input.id, config, fetchImpl);
    if (!hit || hit.kind !== "api" || hit.provenance !== "indexed") throw error;
    assertSupportedListingNetwork(hit.execution.network);
    return inspectIndexedHit(hit);
  }
  const { endpoint, service } = listing;
  assertSupportedListingNetwork(listingPaymentNetwork(endpoint.payment?.network, service.networks));
  return {
    name: endpoint.name,
    method: endpoint.method,
    url: endpoint.url,
    price: endpoint.price,
    description: endpoint.description,
    ...(endpoint.operationId === undefined ? {} : { operationId: endpoint.operationId }),
    ...(endpoint.requestContentType === undefined
      ? {}
      : { requestContentType: endpoint.requestContentType }),
    ...(endpoint.requestSchema === undefined ? {} : { requestSchema: endpoint.requestSchema }),
    ...(endpoint.responseSchema === undefined ? {} : { responseSchema: endpoint.responseSchema }),
    ...(endpoint.exampleRequest === undefined ? {} : { exampleRequest: endpoint.exampleRequest }),
    ...(endpoint.responseContentType === undefined
      ? {}
      : { responseContentType: endpoint.responseContentType }),
    ...(service.group === undefined ? {} : { group: service.group }),
    ...(service.fee === undefined
      ? {}
      : { fee: service.fee, feeDisplay: formatListingFee(service.fee) }),
    verification: service.verification,
    ...healthOf(service),
    payment: endpoint.payment ?? null,
  };
}

function inspectIndexedHit(hit: Extract<MarketplaceHit, { kind: "api"; provenance: "indexed" }>) {
  return {
    name: hit.card.title,
    method: hit.execution.method,
    url: hit.execution.url,
    price:
      hit.card.facts.find((fact) => fact.label.trim().toLocaleLowerCase() === "price")?.value ??
      "See live x402 quote",
    description: hit.card.summary,
    network: hit.execution.network,
    ...(hit.group === undefined ? {} : { group: hit.group }),
    ...(hit.fee === undefined ? {} : { fee: hit.fee, feeDisplay: formatListingFee(hit.fee) }),
    verification: hit.verification,
    ...healthOf(hit),
    payment: null,
  } satisfies InspectToolResult;
}

/** The registry's health, liveness, conformance, and identity records, when present. */
function healthOf(listing: {
  // Compatibility service records preserve additive fields as unknown values.
  health?: unknown;
  liveness?: ListingLiveness | undefined;
  conformance?: ListingConformance | undefined;
  identity?: ListingIdentity | undefined;
}): Pick<InspectToolResult, "health" | "liveness" | "conformance" | "identity"> {
  const health = listingHealthSchema.optional().catch(undefined).parse(listing.health);
  return {
    ...(health === undefined ? {} : { health }),
    ...(listing.liveness === undefined ? {} : { liveness: listing.liveness }),
    ...(listing.conformance === undefined ? {} : { conformance: listing.conformance }),
    ...(listing.identity === undefined ? {} : { identity: listing.identity }),
  };
}
