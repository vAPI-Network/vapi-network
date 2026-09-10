import { describe, expect, it } from "vitest";

import { discover, mergeListings, type Listing, type Source } from "./discovery.js";

function listing(url: string, source: string, fields: Partial<Listing> = {}): Listing {
  return {
    resource: { url },
    provenance: [{ source, ref: `${source}:${url}` }],
    ...fields,
  };
}

describe("discovery merge", () => {
  it("deduplicates on the normalized resource URL while retaining source provenance", () => {
    expect(
      mergeListings([
        [listing("https://api.example/pay", "vapi", { name: "Primary", price: "$0.01" })],
        [
          listing("HTTPS://API.EXAMPLE:443/pay#catalog-entry", "bazaar", {
            description: "Indexed through Bazaar",
            price: "$0.02",
          }),
        ],
      ]),
    ).toEqual([
      {
        resource: { url: "https://api.example/pay" },
        name: "Primary",
        description: "Indexed through Bazaar",
        price: "$0.01",
        provenance: [
          { source: "vapi", ref: "vapi:https://api.example/pay" },
          { source: "bazaar", ref: "bazaar:HTTPS://API.EXAMPLE:443/pay#catalog-entry" },
        ],
      },
    ]);
  });

  it("returns healthy source results and identifies a failed source", async () => {
    const good: Source = {
      id: "local",
      search: async () => [listing("https://api.example/pay", "local")],
      inspect: async () => null,
    };
    const failed: Source = {
      id: "offline",
      search: async () => {
        throw new Error("offline");
      },
      inspect: async () => null,
    };
    const result = await discover([good, failed], "weather");
    expect(result.listings).toHaveLength(1);
    expect(result.errors).toMatchObject([{ source: "offline" }]);
  });
});
