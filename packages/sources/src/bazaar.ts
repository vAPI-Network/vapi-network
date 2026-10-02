import type { Listing, Source } from "@vapi-network/core";

import {
  appendPath,
  asHttpResource,
  asRecord,
  asString,
  asStringArray,
  type GuardedSourceOptions,
  queryMatches,
  sourceFetch,
} from "./common.js";

export type BazaarSourceOptions = GuardedSourceOptions;

export function bazaarSource(facilitatorUrl: string, options: BazaarSourceOptions = {}): Source {
  const endpoint = appendPath(facilitatorUrl, "discovery/resources");
  const fetchImpl = sourceFetch(options);

  async function listings(): Promise<Listing[]> {
    const response = await fetchImpl(endpoint, {
      method: "GET",
      headers: { accept: "application/json" },
    });
    if (!response.ok) {
      throw new Error(
        `x402 Bazaar discovery returned HTTP ${response.status} ${response.statusText}.`,
      );
    }

    const body = asRecord(await response.json());
    const items = Array.isArray(body?.items) ? body.items : [];
    return items.flatMap((item) => {
      const listing = mapBazaarItem(item, endpoint.href);
      return listing === undefined ? [] : [listing];
    });
  }

  return {
    id: "bazaar",
    async search(query) {
      return (await listings()).filter((listing) =>
        queryMatches(
          query,
          listing.resource.url,
          listing.name,
          listing.description,
          listing.metadata,
        ),
      );
    },
    async inspect(ref) {
      return (
        (await listings()).find(
          (listing) =>
            listing.resource.url === ref ||
            listing.provenance.some((provenance) => provenance.ref === ref),
        ) ?? null
      );
    },
  };
}

export function mapBazaarItem(value: unknown, sourceUrl: string): Listing | undefined {
  const item = asRecord(value);
  const resource = asHttpResource(item?.resource);
  if (item === undefined || resource === undefined) return undefined;

  const accepts = Array.isArray(item.accepts) ? item.accepts : [];
  const firstAccept = asRecord(accepts[0]);
  const metadata = asRecord(item.metadata) ?? {};
  const extensions = asRecord(item.extensions);
  const bazaar = asRecord(extensions?.bazaar);
  const info = asRecord(bazaar?.info);
  const input = asRecord(info?.input);
  const tags = asStringArray(item.tags) ?? asStringArray(metadata.tags);

  const name =
    asString(item.serviceName) ??
    asString(metadata.serviceName) ??
    asString(metadata.name) ??
    hostname(resource.url);
  const description =
    asString(item.description) ?? resource.description ?? asString(metadata.description);
  const method = asString(input?.method)?.toUpperCase() ?? asString(metadata.method)?.toUpperCase();
  const network = asString(firstAccept?.network);
  const price = asString(firstAccept?.amount) ?? asString(firstAccept?.maxAmountRequired);

  const listingMetadata: Record<string, unknown> = {
    ...metadata,
    ...(item.type === undefined ? {} : { type: item.type }),
    ...(item.x402Version === undefined ? {} : { x402Version: item.x402Version }),
    ...(item.lastUpdated === undefined ? {} : { lastUpdated: item.lastUpdated }),
    ...(tags === undefined ? {} : { tags }),
    ...(item.iconUrl === undefined ? {} : { iconUrl: item.iconUrl }),
    ...(extensions === undefined ? {} : { extensions }),
    ...(item.quality === undefined ? {} : { quality: item.quality }),
  };

  return {
    resource: {
      ...resource,
      ...(description === undefined || resource.description !== undefined ? {} : { description }),
      ...(resource.serviceName !== undefined || name === undefined ? {} : { serviceName: name }),
      ...(resource.tags !== undefined || tags === undefined ? {} : { tags }),
      ...(resource.iconUrl !== undefined || asString(item.iconUrl) === undefined
        ? {}
        : { iconUrl: asString(item.iconUrl) }),
    },
    ...(name === undefined ? {} : { name }),
    ...(description === undefined ? {} : { description }),
    ...(method === undefined ? {} : { method }),
    ...(network === undefined ? {} : { network }),
    ...(price === undefined ? {} : { price }),
    accepts,
    ...(Object.keys(listingMetadata).length === 0 ? {} : { metadata: listingMetadata }),
    provenance: [{ source: "bazaar", sourceUrl, ref: resource.url }],
  };
}

function hostname(resourceUrl: string): string | undefined {
  try {
    return new URL(resourceUrl).hostname || undefined;
  } catch {
    return undefined;
  }
}
