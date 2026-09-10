import { describe, expect, it, vi } from "vitest";

import type { VapiConfig } from "@vapi-network/core";
import { resolveServiceEndpoint, searchMarketplace } from "./search.js";

const config = {
  discoveryUrl: "https://console.vapinetwork.ai/api/network/services",
  marketplaceDiscoveryUrl: "https://console.vapinetwork.ai/api/marketplace/discovery",
  networks: {},
  spendCaps: { perCallAtomic: "100000", perDayAtomic: "1000000" },
} satisfies VapiConfig;

const apiService = {
  id: "weather-call",
  name: "Weather Call",
  description: "Returns the current weather.",
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
      description: "Return the current weather.",
    },
  ],
} as const;

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
        summary: "Returns the current weather.",
        badges: [{ code: "live_x402", label: "Live x402" }],
        facts: [{ label: "Network", value: "eip155:8453" }],
      },
      action: { type: "invoke_api", href: "/call/weather-call" },
    },
    {
      ref: "research-brief",
      kind: "service_offer",
      card: {
        title: "Research brief",
        summary: "Evidence-backed market research.",
        badges: [{ code: "approved_vendor", label: "Approved vendor" }],
        facts: [],
      },
      action: { type: "start_engagement", href: "/work/listings/research-brief" },
    },
    {
      ref: "pricing-study",
      kind: "open_request",
      card: {
        title: "Pricing study",
        summary: "Compare competitor pricing.",
        badges: [],
        facts: [],
      },
      action: { type: "propose_to_request", href: "/orders/pricing-study" },
    },
  ],
  nextCursor: "opaque-next",
  unavailableKinds: [],
  rankingVersion: "marketplace-ranking-v1",
} as const;

describe("Agent Cash marketplace discovery", () => {
  it("preserves app ranking and forwards every marketplace filter", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify(marketplacePage), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await expect(
      searchMarketplace(
        {
          query: "weather",
          kinds: ["api", "open_request"],
          network: "eip155:8453",
          limit: 7,
          cursor: "opaque-cursor",
        },
        config,
        fetchImpl,
      ),
    ).resolves.toEqual(marketplacePage);

    const requestUrl = new URL(fetchImpl.mock.calls[0]![0] as URL);
    expect(requestUrl.pathname).toBe("/api/marketplace/discovery");
    expect(requestUrl.searchParams.get("q")).toBe("weather");
    expect(requestUrl.searchParams.getAll("kinds")).toEqual(["api", "open_request"]);
    expect(requestUrl.searchParams.get("network")).toBe("eip155:8453");
    expect(requestUrl.searchParams.get("limit")).toBe("7");
    expect(requestUrl.searchParams.get("cursor")).toBe("opaque-cursor");
  });

  it("rejects a kind/action mismatch from the app", async () => {
    const malformed = {
      ...marketplacePage,
      items: [
        {
          ...marketplacePage.items[0],
          action: { type: "start_engagement", href: "/work/listings/weather" },
        },
      ],
    };
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify(malformed), { status: 200 }));

    await expect(searchMarketplace({ query: "weather" }, config, fetchImpl)).rejects.toThrow();
  });

  it("resolves a vAPI API endpoint through the legacy Calls compatibility route", async () => {
    const aliasedService = {
      ...apiService,
      endpoints: [
        {
          ...apiService.endpoints[0],
          name: "weather_lookup",
          description: "Weather lookup alias.",
        },
        apiService.endpoints[0],
      ],
    };
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ services: [aliasedService] }), { status: 200 }),
      );

    await expect(resolveServiceEndpoint(apiService.id, config, fetchImpl)).resolves.toEqual({
      ...apiService.endpoints[0],
      method: "POST",
    });
    expect(new URL(fetchImpl.mock.calls[0]![0] as URL).pathname).toBe("/api/network/services");
  });
});
