import {
  marketplaceDiscoveryInputSchema,
  marketplaceDiscoveryPageSchema,
  createPublicFetch,
  DiscoveryCatalogError,
  parseDiscovery,
  type DiscoveryCatalog,
  type DiscoveryEndpoint,
  type Listing,
  type MarketplaceDiscoveryPage,
  type MarketplaceHit,
  type MarketplaceKind,
  type Source,
} from "@vapi-network/core";

import { appendPath, type Fetch, type GuardedSourceOptions, sourceFetch } from "./common.js";

export type MarketplaceSearchInput = {
  query?: string;
  kinds?: MarketplaceKind[];
  network?: string;
  limit?: number;
  cursor?: string;
};

export type VapiRegistryConfig = Readonly<{
  discoveryUrl: string;
  marketplaceDiscoveryUrl: string;
  allowPrivateNetwork?: boolean;
}>;

export type VapiRegistrySourceOptions = GuardedSourceOptions &
  Readonly<{
    discoveryUrl?: string;
  }>;

/**
 * Search the public marketplace while preserving its validation, filter, and
 * ranking behavior from the original vAPI MCP adapter.
 */
export async function searchMarketplace(
  input: MarketplaceSearchInput,
  config: VapiRegistryConfig,
  fetchImpl?: Fetch,
): Promise<MarketplaceDiscoveryPage> {
  const request =
    fetchImpl ?? createPublicFetch({ allowPrivateNetwork: config.allowPrivateNetwork ?? false });
  const normalized = marketplaceDiscoveryInputSchema.parse({
    q: input.query,
    kinds: input.kinds,
    network: input.network,
    limit: input.limit,
    cursor: input.cursor,
  });
  const url = new URL(config.marketplaceDiscoveryUrl);
  if (normalized.q !== undefined) url.searchParams.set("q", normalized.q);
  for (const kind of normalized.kinds ?? []) url.searchParams.append("kinds", kind);
  if (normalized.network !== undefined) url.searchParams.set("network", normalized.network);
  if (normalized.limit !== undefined) url.searchParams.set("limit", String(normalized.limit));
  if (normalized.cursor !== undefined) url.searchParams.set("cursor", normalized.cursor);

  const response = await request(url, {
    method: "GET",
    headers: { accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(
      `vAPI marketplace discovery returned HTTP ${response.status} ${response.statusText}.`,
    );
  }
  return marketplaceDiscoveryPageSchema.parse(await response.json());
}

/** Resolve a registry ref through the executable Calls compatibility API. */
export async function resolveServiceEndpoint(
  id: string,
  config: VapiRegistryConfig,
  fetchImpl?: Fetch,
  endpointName?: string,
): Promise<DiscoveryEndpoint> {
  const request =
    fetchImpl ?? createPublicFetch({ allowPrivateNetwork: config.allowPrivateNetwork ?? false });
  return (await fetchCallsDiscovery(id, config, request)).resolve(id, endpointName);
}

/** Resolve one exact API ref from marketplace discovery across fresh CLI processes. */
export async function findMarketplaceApiByRef(
  ref: string,
  config: VapiRegistryConfig,
  fetchImpl?: Fetch,
): Promise<MarketplaceHit | null> {
  const page = await searchMarketplace(
    { query: ref, kinds: ["api"], limit: 50 },
    config,
    fetchImpl,
  );
  const matches = page.items.filter((item) => item.kind === "api" && item.ref === ref);
  if (matches.length > 1) {
    throw new Error(`Marketplace ref ${JSON.stringify(ref)} is ambiguous.`);
  }
  return matches[0] ?? null;
}

export function vapiRegistrySource(
  baseUrl: string,
  options: VapiRegistrySourceOptions = {},
): Source {
  const config = registryConfig(baseUrl, options.discoveryUrl, options.allowPrivateNetwork);
  const fetchImpl = sourceFetch(options);

  return {
    id: "vapi",
    async search(query) {
      const page = await searchMarketplace({ query, kinds: ["api"] }, config, fetchImpl);
      const mapped = await Promise.all(
        page.items.map(async (hit): Promise<Listing | null> => {
          if (hit.kind !== "api") return null;
          if (hit.provenance === "indexed") {
            return {
              resource: { url: hit.execution.url, description: hit.card.summary },
              name: hit.card.title,
              description: hit.card.summary,
              ...(hit.execution.method === null ? {} : { method: hit.execution.method }),
              network: hit.execution.network,
              ...optionalPrice(hit.card.facts),
              metadata: { card: hit.card, action: hit.action, execution: hit.execution },
              provenance: [
                {
                  source: "vapi",
                  sourceUrl: config.marketplaceDiscoveryUrl,
                  ref: hit.ref,
                },
              ],
            };
          }

          try {
            const endpoint = await resolveServiceEndpoint(hit.ref, config, fetchImpl);
            return endpointListing(endpoint, hit.ref, config, {
              card: hit.card,
              action: hit.action,
              execution: hit.execution,
              registryProvenance: hit.provenance,
            });
          } catch (error) {
            // Marketplace cards deliberately omit executable targets. A stale or
            // ambiguous compatibility record cannot form a valid core Listing.
            if (!(error instanceof DiscoveryCatalogError)) throw error;
            return null;
          }
        }),
      );
      return mapped.filter((listing): listing is Listing => listing !== null);
    },
    async inspect(ref) {
      try {
        const endpoint = await resolveServiceEndpoint(ref, config, fetchImpl);
        return endpointListing(endpoint, ref, config);
      } catch (resolutionError) {
        if (
          !(resolutionError instanceof DiscoveryCatalogError) ||
          resolutionError.code !== "service_not_found"
        ) {
          throw resolutionError;
        }
        const page = await searchMarketplace({ query: ref, kinds: ["api"] }, config, fetchImpl);
        const hit = page.items.find((item) => item.kind === "api" && item.ref === ref);
        if (hit?.kind === "api" && hit.provenance === "indexed") {
          return {
            resource: { url: hit.execution.url, description: hit.card.summary },
            name: hit.card.title,
            description: hit.card.summary,
            ...(hit.execution.method === null ? {} : { method: hit.execution.method }),
            network: hit.execution.network,
            ...optionalPrice(hit.card.facts),
            metadata: { card: hit.card, action: hit.action, execution: hit.execution },
            provenance: [
              {
                source: "vapi",
                sourceUrl: config.marketplaceDiscoveryUrl,
                ref: hit.ref,
              },
            ],
          };
        }
        if (page.items.some((item) => item.kind === "api" && item.ref === ref)) {
          throw resolutionError;
        }
        return null;
      }
    },
  };
}

async function fetchCallsDiscovery(
  query: string,
  config: VapiRegistryConfig,
  fetchImpl: Fetch,
): Promise<DiscoveryCatalog> {
  const url = new URL(config.discoveryUrl);
  url.searchParams.set("q", query);
  const response = await fetchImpl(url, {
    method: "GET",
    headers: { accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(
      `vAPI Calls discovery returned HTTP ${response.status} ${response.statusText}.`,
    );
  }
  return parseDiscovery(await response.json());
}

function endpointListing(
  endpoint: DiscoveryEndpoint,
  ref: string,
  config: VapiRegistryConfig,
  metadata: Readonly<Record<string, unknown>> = {},
): Listing {
  return {
    resource: {
      url: endpoint.url,
      description: endpoint.description,
      ...(endpoint.responseContentType === undefined
        ? {}
        : { mimeType: endpoint.responseContentType }),
    },
    name: endpoint.name,
    description: endpoint.description,
    method: endpoint.method,
    ...(endpoint.payment?.network === undefined ? {} : { network: endpoint.payment.network }),
    price: endpoint.price,
    metadata: {
      ...metadata,
      ...(endpoint.operationId === undefined ? {} : { operationId: endpoint.operationId }),
      ...(endpoint.requestContentType === undefined
        ? {}
        : { requestContentType: endpoint.requestContentType }),
      ...(endpoint.requestSchema === undefined ? {} : { requestSchema: endpoint.requestSchema }),
      ...(endpoint.responseContentType === undefined
        ? {}
        : { responseContentType: endpoint.responseContentType }),
      ...(endpoint.payment === undefined ? {} : { payment: endpoint.payment }),
    },
    provenance: [{ source: "vapi", sourceUrl: config.marketplaceDiscoveryUrl, ref }],
  };
}

function registryConfig(
  baseUrl: string,
  discoveryUrl?: string,
  allowPrivateNetwork?: boolean,
): VapiRegistryConfig {
  const supplied = new URL(baseUrl);
  const path = supplied.pathname.replace(/\/+$/, "");
  const marketplaceDiscoveryUrl = path.endsWith("/api/marketplace/discovery")
    ? supplied.href
    : path.endsWith("/api/network/services")
      ? replacePath(supplied, "/api/network/services", "/api/marketplace/discovery").href
      : appendPath(supplied.href, "api/marketplace/discovery").href;
  const callsDiscoveryUrl =
    discoveryUrl ??
    (path.endsWith("/api/marketplace/discovery")
      ? replacePath(supplied, "/api/marketplace/discovery", "/api/network/services").href
      : path.endsWith("/api/network/services")
        ? supplied.href
        : appendPath(supplied.href, "api/network/services").href);
  return {
    marketplaceDiscoveryUrl,
    discoveryUrl: callsDiscoveryUrl,
    ...(allowPrivateNetwork === undefined ? {} : { allowPrivateNetwork }),
  };
}

function replacePath(url: URL, suffix: string, replacement: string): URL {
  const replaced = new URL(url);
  replaced.pathname = replaced.pathname.replace(
    new RegExp(`${escapeRegex(suffix)}/*$`),
    replacement,
  );
  replaced.search = "";
  replaced.hash = "";
  return replaced;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function optionalPrice(
  facts: readonly Readonly<{ label: string; value: string }>[],
): Readonly<{ price?: string }> {
  const price = facts.find((fact) => fact.label.trim().toLocaleLowerCase() === "price")?.value;
  return price === undefined ? {} : { price };
}
