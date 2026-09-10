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
    ).resolves.toEqual(marketplacePage);

    const url = new URL(fetchImpl.mock.calls[0]![0] as URL);
    expect(url.searchParams.get("q")).toBe("weather");
    expect(url.searchParams.getAll("kinds")).toEqual(["api"]);
    expect(url.searchParams.get("network")).toBe("eip155:8453");
    expect(url.searchParams.get("limit")).toBe("7");
    expect(url.searchParams.get("cursor")).toBe("opaque");
  });

  it("resolves executable endpoints through the compatibility API", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json(callsPage));

    await expect(resolveServiceEndpoint("weather-call", config, fetchImpl)).resolves.toMatchObject({
      name: "call",
      method: "POST",
      url: "https://weather.example/call",
    });
  });
});

describe("vAPI registry source", () => {
  it("maps native and indexed API hits into core listings", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (request) => {
      const url = new URL(request as URL);
      return url.pathname.endsWith("/api/marketplace/discovery")
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
