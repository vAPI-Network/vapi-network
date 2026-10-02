import { readFile } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

import { bazaarSource } from "./bazaar.js";

async function fixture(): Promise<unknown> {
  return JSON.parse(
    await readFile(new URL("./__fixtures__/bazaar-v2.json", import.meta.url), "utf8"),
  );
}

describe("Bazaar source", () => {
  it("maps the public v2 fixture and tolerates absent optional fields", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json(await fixture()));

    const source = bazaarSource("https://facilitator.example/platform/v2/x402", {
      fetch: fetchImpl,
    });
    const listings = await source.search();

    expect(listings).toHaveLength(2);
    expect(listings[0]).toMatchObject({
      resource: {
        url: "https://weather.example/forecast",
        description: "Real-time weather forecast data.",
      },
      name: "Weather API",
      description: "Real-time weather forecast data.",
      method: "POST",
      network: "eip155:8453",
      price: "1000",
      metadata: {
        category: "data",
        provider: "Example Labs",
        tags: ["weather", "data"],
      },
      provenance: [
        {
          source: "bazaar",
          sourceUrl: "https://facilitator.example/platform/v2/x402/discovery/resources",
          ref: "https://weather.example/forecast",
        },
      ],
    });
    expect(listings[0]?.accepts).toHaveLength(1);
    expect(listings[1]).toMatchObject({
      resource: {
        url: "https://minimal.example/data",
        mimeType: "application/json",
      },
      name: "minimal.example",
      accepts: [],
    });
    expect(new URL(fetchImpl.mock.calls[0]![0] as URL).pathname).toBe(
      "/platform/v2/x402/discovery/resources",
    );
  });

  it("filters locally and inspects by resource URL", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => Response.json(await fixture()));
    const source = bazaarSource("https://facilitator.example/discovery/resources", {
      fetch: fetchImpl,
    });

    await expect(source.search("weather")).resolves.toHaveLength(1);
    await expect(source.inspect("https://minimal.example/data")).resolves.toMatchObject({
      resource: { url: "https://minimal.example/data" },
    });
    await expect(source.inspect("missing")).resolves.toBeNull();
  });

  it("reports facilitator errors", async () => {
    const source = bazaarSource("https://facilitator.example", {
      fetch: vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(null, { status: 503, statusText: "Unavailable" })),
    });

    await expect(source.search()).rejects.toThrow(
      "x402 Bazaar discovery returned HTTP 503 Unavailable.",
    );
  });

  it("guards the default outbound transport", async () => {
    const source = bazaarSource("https://facilitator.example", {
      lookup: async () => ["127.0.0.1"],
    });

    await expect(source.search()).rejects.toThrow("allowPrivateNetwork true");
  });
});
