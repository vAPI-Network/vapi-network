import type { X402Resource } from "./x402.js";

export type ListingProvenance = Readonly<{
  /** Stable adapter identifier such as `vapi`, `bazaar`, or `local`. */
  source: string;
  /** Catalog endpoint used to obtain the listing, when applicable. */
  sourceUrl?: string;
  /** Source-native reference that can be passed back to inspect(). */
  ref?: string;
}>;

export interface Listing {
  readonly resource: X402Resource;
  readonly name?: string;
  readonly description?: string;
  readonly method?: string;
  readonly network?: string;
  readonly price?: string;
  /** Raw x402 accepts entries; source adapters intentionally tolerate new schemes. */
  readonly accepts?: readonly unknown[];
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly provenance: readonly ListingProvenance[];
}

/** Discovery adapter seam. A null inspect result means the reference is unknown. */
export interface Source {
  readonly id: string;
  search(query?: string): Promise<Listing[]>;
  inspect(ref: string): Promise<Listing | null>;
}

/**
 * Merge source result sets in preference order. Listings with the same resource
 * URL become one result; earlier sources win fields and all provenance is kept.
 */
export function mergeListings(groups: Iterable<readonly Listing[]>): Listing[] {
  const merged = new Map<string, Listing>();
  for (const group of groups) {
    for (const listing of group) {
      const key = normalizeResourceUrl(listing.resource.url);
      const existing = merged.get(key);
      if (!existing) {
        merged.set(key, cloneListing(listing));
        continue;
      }
      merged.set(key, mergeListing(existing, listing));
    }
  }
  return [...merged.values()];
}

/** Canonical key used for discovery de-duplication without changing the published URL. */
export function normalizeResourceUrl(value: string): string {
  try {
    const url = new URL(value);
    url.hash = "";
    return url.href;
  } catch {
    return value.trim();
  }
}

/** Search all sources without letting one unavailable catalog hide the others. */
export async function discover(
  sources: readonly Source[],
  query?: string,
): Promise<{ listings: Listing[]; errors: ReadonlyArray<{ source: string; error: unknown }> }> {
  const settled = await Promise.allSettled(sources.map((source) => source.search(query)));
  const groups: Listing[][] = [];
  const errors: Array<{ source: string; error: unknown }> = [];
  settled.forEach((result, index) => {
    if (result.status === "fulfilled") groups.push(result.value);
    else errors.push({ source: sources[index]!.id, error: result.reason });
  });
  return { listings: mergeListings(groups), errors };
}

function cloneListing(listing: Listing): Listing {
  return {
    ...listing,
    resource: {
      ...listing.resource,
      ...(listing.resource.tags ? { tags: [...listing.resource.tags] } : {}),
    },
    ...(listing.accepts ? { accepts: [...listing.accepts] } : {}),
    ...(listing.metadata ? { metadata: { ...listing.metadata } } : {}),
    provenance: dedupeProvenance(listing.provenance),
  };
}

function mergeListing(first: Listing, next: Listing): Listing {
  const accepts =
    first.accepts && first.accepts.length > 0
      ? first.accepts
      : next.accepts && next.accepts.length > 0
        ? next.accepts
        : undefined;
  return {
    resource: {
      url: first.resource.url,
      ...optionalResource("description", first.resource.description, next.resource.description),
      ...optionalResource("mimeType", first.resource.mimeType, next.resource.mimeType),
      ...optionalResource("serviceName", first.resource.serviceName, next.resource.serviceName),
      ...optionalResource("iconUrl", first.resource.iconUrl, next.resource.iconUrl),
      ...(first.resource.tags?.length || next.resource.tags?.length
        ? {
            tags: [
              ...(first.resource.tags?.length ? first.resource.tags : (next.resource.tags ?? [])),
            ],
          }
        : {}),
    },
    ...optional("name", preferred(first.name, next.name)),
    ...optional("description", preferred(first.description, next.description)),
    ...optional("method", preferred(first.method, next.method)),
    ...optional("network", preferred(first.network, next.network)),
    ...optional("price", preferred(first.price, next.price)),
    ...(accepts ? { accepts: [...accepts] } : {}),
    ...(first.metadata || next.metadata
      ? { metadata: { ...(next.metadata ?? {}), ...(first.metadata ?? {}) } }
      : {}),
    provenance: dedupeProvenance([...first.provenance, ...next.provenance]),
  };
}

function preferred(first: string | undefined, next: string | undefined): string | undefined {
  return first && first.length > 0 ? first : next;
}

function optionalResource<Key extends "description" | "mimeType" | "serviceName" | "iconUrl">(
  key: Key,
  first: string | undefined,
  next: string | undefined,
): Partial<Record<Key, string>> {
  return optional(key, preferred(first, next));
}

function optional<Key extends string>(
  key: Key,
  value: string | undefined,
): Partial<Record<Key, string>> {
  return value === undefined || value === "" ? {} : ({ [key]: value } as Record<Key, string>);
}

function dedupeProvenance(values: readonly ListingProvenance[]): ListingProvenance[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = `${value.source}\u0000${value.sourceUrl ?? ""}\u0000${value.ref ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
