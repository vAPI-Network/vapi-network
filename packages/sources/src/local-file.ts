import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { Listing, Source } from "@vapi-network/core";

import { normalizeListing, queryMatches } from "./common.js";

export function localFileSource(path: string): Source {
  const absolutePath = resolve(path);

  async function listings(): Promise<Listing[]> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(absolutePath, "utf8"));
    } catch (error) {
      throw new Error(`Could not read local discovery source ${JSON.stringify(absolutePath)}.`, {
        cause: error,
      });
    }
    if (!Array.isArray(parsed)) {
      throw new Error(
        `Local discovery source ${JSON.stringify(absolutePath)} must contain a JSON array.`,
      );
    }

    return parsed.flatMap((value, index) => {
      const listing = normalizeListing(value, {
        source: "local",
        sourceUrl: absolutePath,
        ref: String(index),
      });
      return listing === undefined ? [] : [listing];
    });
  }

  return {
    id: `local:${absolutePath}`,
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
