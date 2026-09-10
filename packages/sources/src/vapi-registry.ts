import {
  marketplaceDiscoveryInputSchema,
  marketplaceDiscoveryPageSchema,
  appendSearchEvent,
  createPublicFetch,
  DEFAULT_REGISTRY_FALLBACKS,
  DEFAULT_REGISTRY_URL,
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
  registryFallbacks?: ReadonlyArray<
    Readonly<{ discoveryUrl: string; marketplaceDiscoveryUrl: string }>
  >;
  allowPrivateNetwork?: boolean;
}>;

export type MarketplaceSearchOptions = Readonly<{
  searchesPath?: string;
  now?: Date;
  nowMs?: () => number;
  notice?: (message: string) => void;
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
  options: MarketplaceSearchOptions = {},
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
  const startedAt = options.now ?? new Date();
  const attempts: SearchAttempt[] = [];
  let mergedCount = 0;
  try {
    const response = await registryRequest({
      kind: "marketplace",
      config,
      request,
      attempts,
      nowMs: options.nowMs,
      notice: options.notice,
      configureUrl(url) {
        if (normalized.q !== undefined) url.searchParams.set("q", normalized.q);
        for (const kind of normalized.kinds ?? []) url.searchParams.append("kinds", kind);
        if (normalized.network !== undefined) url.searchParams.set("network", normalized.network);
        if (normalized.limit !== undefined) url.searchParams.set("limit", String(normalized.limit));
        if (normalized.cursor !== undefined) url.searchParams.set("cursor", normalized.cursor);
      },
    });
    const page = marketplaceDiscoveryPageSchema.parse(await response.json());
    mergedCount = page.items.length;
    const attempt = attempts.at(-1);
    if (attempt) attempt.count = mergedCount;
    return page;
  } finally {
    if (options.searchesPath) {
      await appendSearchEvent(
        {
          timestamp: startedAt.toISOString(),
          query: normalized.q ?? "",
          sources: attempts,
          mergedCount,
        },
        options.searchesPath,
      ).catch(() => undefined);
    }
  }
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
  const response = await registryRequest({
    kind: "services",
    config,
    request: fetchImpl,
    configureUrl(url) {
      url.searchParams.set("q", query);
    },
  });
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
      : path.endsWith("/api/call/discovery")
        ? supplied.href
        : path.endsWith("/api/call/services")
          ? replacePath(supplied, "/api/call/services", "/api/call/discovery").href
          : appendPath(supplied.href, "api/call/discovery").href;
  const callsDiscoveryUrl =
    discoveryUrl ??
    (path.endsWith("/api/marketplace/discovery")
      ? replacePath(supplied, "/api/marketplace/discovery", "/api/network/services").href
      : path.endsWith("/api/network/services")
        ? supplied.href
        : path.endsWith("/api/call/discovery")
          ? replacePath(supplied, "/api/call/discovery", "/api/call/services").href
          : path.endsWith("/api/call/services")
            ? supplied.href
            : appendPath(supplied.href, "api/call/services").href);
  return {
    marketplaceDiscoveryUrl,
    discoveryUrl: callsDiscoveryUrl,
    ...(supplied.origin === new URL(DEFAULT_REGISTRY_URL).origin
      ? { registryFallbacks: DEFAULT_REGISTRY_FALLBACKS }
      : {}),
    ...(allowPrivateNetwork === undefined ? {} : { allowPrivateNetwork }),
  };
}

type SearchAttempt = {
  source: string;
  latencyMs: number;
  count: number;
  error?: string;
};

const loggedFallbacks = new Set<string>();

async function registryRequest(args: {
  kind: "marketplace" | "services";
  config: VapiRegistryConfig;
  request: Fetch;
  configureUrl(url: URL): void;
  attempts?: SearchAttempt[];
  nowMs?: () => number;
  notice?: (message: string) => void;
}): Promise<Response> {
  const fallbacks = args.config.registryFallbacks ?? [];
  const endpoints = [
    args.kind === "marketplace" ? args.config.marketplaceDiscoveryUrl : args.config.discoveryUrl,
    ...fallbacks.map((fallback) =>
      args.kind === "marketplace" ? fallback.marketplaceDiscoveryUrl : fallback.discoveryUrl,
    ),
  ].filter((endpoint, index, values) => values.indexOf(endpoint) === index);
  const nowMs = args.nowMs ?? (() => performance.now());
  for (let index = 0; index < endpoints.length; index += 1) {
    const endpoint = endpoints[index]!;
    const url = new URL(endpoint);
    args.configureUrl(url);
    const started = nowMs();
    try {
      const response = await args.request(url, {
        method: "GET",
        headers: { accept: "application/json" },
      });
      args.attempts?.push({
        source: url.hostname,
        latencyMs: Math.max(0, nowMs() - started),
        count: 0,
        ...(!response.ok ? { error: `HTTP ${response.status}` } : {}),
      });
      if (response.ok) return response;
      if (response.status === 404 && index < endpoints.length - 1) {
        logFallbackOnce(endpoints[0]!, endpoints[index + 1]!, args.notice);
        continue;
      }
      const label = args.kind === "marketplace" ? "marketplace discovery" : "Calls discovery";
      throw new Error(`vAPI ${label} returned HTTP ${response.status} ${response.statusText}.`);
    } catch (error) {
      if (!args.attempts?.at(-1) || args.attempts.at(-1)?.source !== url.hostname) {
        args.attempts?.push({
          source: url.hostname,
          latencyMs: Math.max(0, nowMs() - started),
          count: 0,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      if (isEnotfound(error) && index < endpoints.length - 1) {
        logFallbackOnce(endpoints[0]!, endpoints[index + 1]!, args.notice);
        continue;
      }
      throw error;
    }
  }
  throw new Error("No vAPI registry endpoint was available.");
}

function logFallbackOnce(
  primary: string,
  fallback: string,
  notice?: (message: string) => void,
): void {
  const key = `${new URL(primary).origin}\u0000${new URL(fallback).origin}`;
  if (loggedFallbacks.has(key)) return;
  loggedFallbacks.add(key);
  const message = `vAPI registry ${new URL(primary).origin} was unavailable; using fallback ${new URL(fallback).origin}.`;
  (notice ?? ((value) => process.stderr.write(`${value}\n`)))(message);
}

function isEnotfound(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current instanceof Error; depth += 1) {
    if ("code" in current && current.code === "ENOTFOUND") return true;
    current = current.cause;
  }
  return false;
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
