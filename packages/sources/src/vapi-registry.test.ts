import { describe, expect, it, vi } from "vitest";

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
      if (url.pathname.endsWith("/api/network/services")) {
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
