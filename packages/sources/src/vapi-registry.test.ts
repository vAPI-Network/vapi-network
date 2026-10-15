import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readSearchEvents } from "@vapi-network/core";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  resolveServiceEndpoint,
  searchMarketplace,
  vapiRegistrySource,
  type VapiRegistryConfig,
} from "./vapi-registry.js";

const config = {
  discoveryUrl: "https://console.vapinetwork.ai/api/network/services",
  marketplaceDiscoveryUrl: "https://console.vapinetwork.ai/api/marketplace/discovery",
} satisfies VapiRegistryConfig;

const temporaryDirectories: string[] = [];

const holderGraphFixture = JSON.parse(
  readFileSync(
    new URL("./__fixtures__/vapi-discovery-holder-graph-solana.json", import.meta.url),
    "utf8",
  ),
) as { items: Array<Record<string, unknown>> } & Record<string, unknown>;

// Synthetic client fixture copied from the public service shape exercised by
// apps/api/app/marketplace/server/adapters/calls-marketplace-source.server.test.ts;
// it contains no production request data.
const mppCallsFixture = JSON.parse(
  readFileSync(new URL("./__fixtures__/vapi-services-mpp.json", import.meta.url), "utf8"),
) as unknown;

// Synthetic representative output copied from the MPP/unverified case in
// apps/api/app/marketplace/server/adapters/calls-marketplace-source.server.test.ts;
// it contains no production request data.
const mppMarketplaceFixture = JSON.parse(
  readFileSync(
    new URL("./__fixtures__/vapi-marketplace-mpp-unverified.json", import.meta.url),
    "utf8",
  ),
) as unknown;

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

const marketplacePage = {
  protocol: "vapi.marketplace.discovery/1",
  items: [
    {
      ref: "weather-call",
      kind: "api",
      provenance: "self_listed",
      execution: { mode: "direct" },
      card: {
        title: "Weather Call",
        summary: "Returns current weather.",
        badges: [{ code: "live_x402", label: "Live x402" }],
        facts: [],
      },
      action: { type: "invoke_api", href: "/call/weather-call" },
    },
    {
      ref: "external-price",
      kind: "api",
      provenance: "indexed",
      execution: {
        mode: "direct",
        url: "https://external.example/prices",
        method: "GET",
        network: "eip155:8453",
      },
      card: {
        title: "External Price",
        summary: "A Bazaar price API.",
        badges: [{ code: "external_catalog", label: "External catalog" }],
        facts: [{ label: "Price", value: "$0.009" }],
      },
      action: { type: "invoke_api", href: "/call/external-price" },
    },
  ],
  nextCursor: null,
  unavailableKinds: [],
  rankingVersion: "marketplace-ranking-v1",
} as const;

const callsPage = {
  services: [
    {
      id: "weather-call",
      name: "Weather Call",
      description: "Returns current weather.",
      category: "data",
      tier: "listed",
      verified: false,
      wrapped: false,
      price: "$0.0021",
      networks: ["eip155:8453"],
      endpoints: [
        {
          name: "call",
          method: "POST",
          url: "https://weather.example/call",
          price: "$0.0021",
          description: "Return current weather.",
        },
      ],
    },
  ],
} as const;

describe("vAPI registry helpers", () => {
  it("returns every valid row from the holder graph Solana fixture", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json(holderGraphFixture));

    const page = await searchMarketplace({ query: "holder graph" }, config, fetchImpl);

    expect(page.items).toHaveLength(2);
    expect(page.items[1]).toMatchObject({
      ref: "https://api.deepnets.ai/api/token/holder-graph",
      execution: { network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" },
    });
  });

  it("keeps the server's MPP and unverified marketplace row without a drop diagnostic", async () => {
    const debug = vi.fn();
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json(mppMarketplaceFixture));

    const page = await searchMarketplace(
      { query: "email", includeUnverified: true },
      config,
      fetchImpl,
      { debug },
    );

    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.card.badges).toEqual([
      { code: "mpp", label: "MPP (Stripe/Tempo), not payable here" },
      { code: "payout_wallet_confirmed", label: "Payout wallet confirmed" },
      { code: "unverified", label: "Unverified" },
    ]);
    expect(page.items[0]).toMatchObject({
      group: "added",
      fee: { bps: 500 },
      verification: "none",
      card: {
        byline: "api.example.test",
        facts: [
          { label: "Price", value: "$0.01" },
          { label: "Payment", value: "MPP (Stripe/Tempo), not payable here" },
          { label: "Network", value: "eip155:8453" },
          { label: "Settled calls (30d)", value: "128" },
          { label: "Checked", value: "2026-08-27T10:00:00.000Z" },
          { label: "Freshness", value: "Checked 2h ago" },
          { label: "Category", value: "Data" },
          { label: "Method", value: "POST, GET" },
        ],
      },
    });
    expect(debug).not.toHaveBeenCalled();
  });

  it("drops malformed rows, logs their count, and emits one debug message", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vapi-registry-dropped-"));
    temporaryDirectories.push(directory);
    const searchesPath = join(directory, "searches.jsonl");
    const debug = vi.fn();
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        ...holderGraphFixture,
        items: [
          marketplacePage.items[1],
          holderGraphFixture.items[1],
          {
            ...marketplacePage.items[1],
            execution: { ...marketplacePage.items[1].execution, network: "garbage" },
          },
        ],
      }),
    );

    const page = await searchMarketplace({ query: "mixed" }, config, fetchImpl, {
      searchesPath,
      now: new Date("2026-10-15T12:00:00.000Z"),
      debug,
    });

    expect(page.items).toHaveLength(2);
    expect(debug).toHaveBeenCalledOnce();
    expect(debug).toHaveBeenCalledWith(
      "vAPI marketplace discovery dropped invalid row at index 2.",
    );
    expect(await readSearchEvents(searchesPath)).toEqual([
      {
        timestamp: "2026-10-15T12:00:00.000Z",
        query: "mixed",
        sources: [
          { source: "console.vapinetwork.ai", latencyMs: expect.any(Number), count: 2, dropped: 1 },
        ],
        mergedCount: 2,
      },
    ]);
  });

  it("continues discovery when the debug callback throws", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        ...holderGraphFixture,
        items: [holderGraphFixture.items[1], { malformed: true }],
      }),
    );

    await expect(
      searchMarketplace({ query: "holder graph" }, config, fetchImpl, {
        debug() {
          throw new Error("debug sink failed");
        },
      }),
    ).resolves.toMatchObject({
      items: [{ ref: "https://api.deepnets.ai/api/token/holder-graph" }],
    });
  });

  it("falls back on a primary 404, logs once, and records both search attempts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vapi-registry-search-"));
    temporaryDirectories.push(directory);
    const searchesPath = join(directory, "searches.jsonl");
    const fallbackConfig: VapiRegistryConfig = {
      discoveryUrl: "https://primary.example/api/call/services",
      marketplaceDiscoveryUrl: "https://primary.example/api/call/discovery",
      registryFallbacks: [
        {
          discoveryUrl: "https://fallback.example/api/network/services",
          marketplaceDiscoveryUrl: "https://fallback.example/api/marketplace/discovery",
        },
      ],
    };
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(Response.json(marketplacePage))
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(Response.json(marketplacePage));
    const notice = vi.fn();
    const ticks = [0, 5, 10, 20];

    await searchMarketplace({ query: "weather" }, fallbackConfig, fetchImpl, {
      searchesPath,
      now: new Date("2026-09-10T10:00:00.000Z"),
      nowMs: () => ticks.shift() ?? 20,
      notice,
    });
    await searchMarketplace({ query: "weather again" }, fallbackConfig, fetchImpl, { notice });

    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(notice).toHaveBeenCalledOnce();
    expect(await readSearchEvents(searchesPath)).toEqual([
      {
        timestamp: "2026-09-10T10:00:00.000Z",
        query: "weather",
        sources: [
          { source: "primary.example", latencyMs: 5, count: 0, error: "HTTP 404" },
          { source: "fallback.example", latencyMs: 10, count: 2 },
        ],
        mergedCount: 2,
      },
    ]);
  });

  it("falls back when the primary hostname cannot be resolved", async () => {
    const dnsError = Object.assign(new Error("getaddrinfo ENOTFOUND primary.example"), {
      code: "ENOTFOUND",
    });
    const fallbackConfig: VapiRegistryConfig = {
      discoveryUrl: "https://dns-primary.example/api/call/services",
      marketplaceDiscoveryUrl: "https://dns-primary.example/api/call/discovery",
      registryFallbacks: [
        {
          discoveryUrl: "https://dns-fallback.example/api/network/services",
          marketplaceDiscoveryUrl: "https://dns-fallback.example/api/marketplace/discovery",
        },
      ],
    };
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(dnsError)
      .mockResolvedValueOnce(Response.json(callsPage));

    await expect(
      resolveServiceEndpoint("weather-call", fallbackConfig, fetchImpl),
    ).resolves.toMatchObject({ url: "https://weather.example/call" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("preserves marketplace ranking and forwards filters", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json(marketplacePage));
    await expect(
      searchMarketplace(
        {
          query: "weather",
          kinds: ["api"],
          network: "eip155:8453",
          limit: 7,
          cursor: "opaque",
        },
        config,
        fetchImpl,
      ),
      // The fixture predates the verification tier, so every hit reads as `none`.
    ).resolves.toEqual({
      ...marketplacePage,
      items: marketplacePage.items.map((item) => ({ ...item, verification: "none" })),
    });

    const url = new URL(fetchImpl.mock.calls[0]![0] as URL);
    expect(url.searchParams.get("q")).toBe("weather");
    expect(url.searchParams.getAll("kinds")).toEqual(["api"]);
    expect(url.searchParams.get("network")).toBe("eip155:8453");
    expect(url.searchParams.get("limit")).toBe("7");
    expect(url.searchParams.get("cursor")).toBe("opaque");
  });

  it("reads the verification tier the registry sends", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        ...marketplacePage,
        items: [
          { ...marketplacePage.items[0], verification: "verified" },
          { ...marketplacePage.items[1], verification: "requested" },
        ],
      }),
    );

    const page = await searchMarketplace({ query: "weather" }, config, fetchImpl);

    expect(page.items.map((item) => item.verification)).toEqual(["verified", "requested"]);
  });

  it("sends includeUnverified only when it is asked for", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => Response.json(marketplacePage));

    await searchMarketplace({ query: "weather" }, config, fetchImpl);
    await searchMarketplace({ query: "weather", includeUnverified: false }, config, fetchImpl);
    await searchMarketplace({ query: "weather", includeUnverified: true }, config, fetchImpl);

    const switches = fetchImpl.mock.calls.map((call) =>
      new URL(call[0] as URL).searchParams.get("includeUnverified"),
    );
    expect(switches).toEqual([null, null, "true"]);
  });

  it("rejects a non-boolean includeUnverified before it reaches the registry", async () => {
    const fetchImpl = vi.fn<typeof fetch>();

    await expect(
      searchMarketplace(
        { query: "weather", includeUnverified: "yes" as unknown as boolean },
        config,
        fetchImpl,
      ),
    ).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("threads the source search option through to the registry query string", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ ...marketplacePage, items: [] }))
      .mockResolvedValueOnce(Response.json({ ...marketplacePage, items: [] }));
    const source = vapiRegistrySource("https://console.vapinetwork.ai", { fetch: fetchImpl });

    await source.search("weather");
    await source.search("weather", { includeUnverified: true });

    const switches = fetchImpl.mock.calls.map((call) =>
      new URL(call[0] as URL).searchParams.get("includeUnverified"),
    );
    expect(switches).toEqual([null, "true"]);
  });

  it("carries the verification tier onto a mirrored listing", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        ...marketplacePage,
        items: [{ ...marketplacePage.items[1], verification: "none" }],
      }),
    );
    const source = vapiRegistrySource("https://console.vapinetwork.ai", { fetch: fetchImpl });

    const listings = await source.search("prices");

    expect(listings).toHaveLength(1);
    expect(listings[0]!.verification).toBe("none");
  });

  it("resolves one exact ref even when it was never verified", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json(callsPage));
    const source = vapiRegistrySource("https://console.vapinetwork.ai", { fetch: fetchImpl });

    const listing = await source.inspect("weather-call");

    expect(listing?.verification).toBe("none");
    expect(new URL(fetchImpl.mock.calls[0]![0] as URL).searchParams.get("includeUnverified")).toBe(
      "true",
    );
  });

  it("resolves executable endpoints through the compatibility API", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json(callsPage));

    await expect(resolveServiceEndpoint("weather-call", config, fetchImpl)).resolves.toMatchObject({
      name: "call",
      method: "POST",
      url: "https://weather.example/call",
    });
  });

  it("keeps an MPP compatibility row inspectable without inventing an x402 network", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json(mppCallsFixture));

    const endpoint = await resolveServiceEndpoint("email-count-mpp", config, fetchImpl);

    expect(endpoint.payment).toEqual({
      protocol: "mpp",
      intent: "charge",
      method: "tempo",
      checkedAt: "2026-08-19T10:30:00.000Z",
    });
    expect(endpoint.payment).not.toHaveProperty("network");
  });
});

describe("vAPI registry source", () => {
  it("maps native and indexed API hits into core listings", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (request) => {
      const url = new URL(request as URL);
      return url.pathname.endsWith("/api/call/discovery")
        ? Response.json(marketplacePage)
        : Response.json(callsPage);
    });
    const source = vapiRegistrySource("https://console.vapinetwork.ai/api/marketplace/discovery", {
      fetch: fetchImpl,
    });

    await expect(source.search("weather")).resolves.toMatchObject([
      {
        resource: { url: "https://weather.example/call" },
        name: "call",
        method: "POST",
        price: "$0.0021",
        provenance: [{ source: "vapi", ref: "weather-call" }],
      },
      {
        resource: { url: "https://external.example/prices" },
        name: "External Price",
        method: "GET",
        network: "eip155:8453",
        price: "$0.009",
        provenance: [{ source: "vapi", ref: "external-price" }],
      },
    ]);
  });

  it("inspects a native ref and returns null for an unknown ref", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (request) => {
      const url = new URL(request as URL);
      if (url.pathname.endsWith("/api/call/services")) {
        return Response.json(
          url.searchParams.get("q") === "weather-call" ? callsPage : { services: [] },
        );
      }
      return Response.json({ ...marketplacePage, items: [] });
    });
    const source = vapiRegistrySource("https://console.vapinetwork.ai", { fetch: fetchImpl });

    await expect(source.inspect("weather-call")).resolves.toMatchObject({
      resource: { url: "https://weather.example/call" },
    });
    await expect(source.inspect("unknown")).resolves.toBeNull();
  });
});
