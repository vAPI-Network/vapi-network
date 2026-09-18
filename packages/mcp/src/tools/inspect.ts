import {
  DiscoveryCatalogError,
  type DiscoveryEndpoint,
  type ListingFee,
  type ListingGroup,
  type MarketplaceHit,
  type VapiConfig,
} from "@vapi-network/core";
import { findMarketplaceApiByRef, resolveServiceListing } from "./search.js";

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
    | "responseContentType"
  >,
  "method"
> & {
  method: string | null;
  network?: string;
  /** Registry-owned listing disclosures; absent when the registry omits them. */
  group?: ListingGroup;
  fee?: ListingFee;
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
    if (
      input.endpoint ||
      !(error instanceof DiscoveryCatalogError) ||
      error.code !== "service_not_found"
    ) {
      throw error;
    }
    const hit = await findMarketplaceApiByRef(input.id, config, fetchImpl);
    if (!hit || hit.kind !== "api" || hit.provenance !== "indexed") throw error;
    return inspectIndexedHit(hit);
  }
  const { endpoint, service } = listing;
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
    ...(endpoint.responseContentType === undefined
      ? {}
      : { responseContentType: endpoint.responseContentType }),
    ...(service.group === undefined ? {} : { group: service.group }),
    ...(service.fee === undefined ? {} : { fee: service.fee }),
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
    ...(hit.fee === undefined ? {} : { fee: hit.fee }),
    payment: null,
  } satisfies InspectToolResult;
}
