import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  DiscoveryCatalogError,
  parseDiscovery,
  searchServicesResponseSchema,
  type DiscoveryCatalogErrorCode,
} from "./index.js";

const birdeyeFixture = JSON.parse(
  readFileSync(
    new URL("../../sources/src/__fixtures__/vapi-services-birdeye-solana.json", import.meta.url),
    "utf8",
  ),
) as unknown;

const service = {
  id: "private-inference",
  name: "Private Inference",
  description: "OpenAI-compatible private inference.",
  category: "ai",
  tier: "partner",
  verified: true,
  wrapped: true,
  price: "Variable",
  networks: ["eip155:8453"],
  endpoints: [
    {
      name: "private_inference",
      method: "post",
      url: "https://gw.vapi.network/v/private-inference",
      price: "Variable",
      description: "Private inference alias.",
    },
    {
      name: "chat",
      method: "POST",
      url: "https://gw.vapi.network/v/private-inference",
      price: "Variable",
      description: "Chat completion alias.",
    },
  ],
};

describe("semantic Call discovery catalog", () => {
  it("parses Solana payment metadata without weakening EVM validation", () => {
    const parsed = searchServicesResponseSchema.parse(birdeyeFixture);
    expect(parsed.services[0]?.endpoints[0]?.payment).toMatchObject({
      network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
      asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      payTo: "3Wuj6VjJXuCmQZjGRhW56xbEk6TzCyMEUVRZgLBYNE2Z",
    });

    const raw = birdeyeFixture as {
      services: Array<{ endpoints: Array<Record<string, unknown>> }>;
    };
    const endpoint = raw.services[0]!.endpoints[0]!;
    expect(() =>
      searchServicesResponseSchema.parse({
        services: [
          {
            ...raw.services[0],
            endpoints: [
              {
                ...endpoint,
                payment: {
                  ...(endpoint.payment as Record<string, unknown>),
                  payTo: "0x0000000000000000000000000000000000000001",
                },
              },
            ],
          },
        ],
      }),
    ).toThrow();

    expect(() =>
      searchServicesResponseSchema.parse({
        services: [
          {
            ...service,
            endpoints: [
              {
                ...service.endpoints[0],
                payment: {
                  scheme: "exact",
                  network: "eip155:8453",
                  asset: "0x0000000000000000000000000000000000000001",
                  payTo: "0x0000000000000000000000000000000000000002",
                  checkedAt: "2026-10-15T11:11:05.026Z",
                },
              },
            ],
          },
        ],
      }),
    ).not.toThrow();
  });

  it("preserves payment networks only when every ambiguous endpoint declares one", () => {
    const assertAmbiguous = (raw: unknown, expectedNetworks: readonly string[] | undefined) => {
      try {
        parseDiscovery(raw).resolve("birdeye");
        expect.fail("Expected Birdeye's distinct endpoints to require a selector.");
      } catch (error) {
        expect(error).toBeInstanceOf(DiscoveryCatalogError);
        expect(error).toMatchObject({
          code: "ambiguous_default",
          serviceId: "birdeye",
          paymentNetworks: expectedNetworks,
        });
      }
    };

    const parsed = searchServicesResponseSchema.parse(birdeyeFixture);
    assertAmbiguous(
      birdeyeFixture,
      parsed.services[0]!.endpoints.map(({ payment }) => payment!.network),
    );

    const incomplete = structuredClone(parsed);
    Reflect.deleteProperty(incomplete.services[0]!.endpoints[0]!, "payment");
    assertAmbiguous(incomplete, undefined);
  });

  it("resolves duplicate named aliases to one order-independent payable target", () => {
    const catalog = parseDiscovery({ services: [service] });

    expect(catalog.resolve(service.id)).toEqual({
      name: "chat",
      method: "POST",
      url: "https://gw.vapi.network/v/private-inference",
      price: "Variable",
      description: "Chat completion alias.",
    });
  });

  it("requires each alias name to be unique within its service", () => {
    expect(() =>
      parseDiscovery({
        services: [
          {
            ...service,
            endpoints: service.endpoints.map((endpoint) => ({ ...endpoint, name: "chat" })),
          },
        ],
      }),
    ).toThrow(expect.objectContaining({ code: "duplicate_endpoint_name" }));
  });

  it.each([
    [{ ...service, id: "weather-call", endpoints: [] }, "no_endpoint"],
    [
      {
        ...service,
        id: "weather-call",
        endpoints: [{ ...service.endpoints[0], method: "   " }],
      },
      "blank_method",
    ],
    [
      {
        ...service,
        id: "weather-call",
        endpoints: [
          { ...service.endpoints[0], name: "call" },
          {
            ...service.endpoints[0],
            name: "forecast",
            url: "https://weather.example/forecast",
          },
        ],
      },
      "ambiguous_default",
    ],
    [
      {
        ...service,
        id: "weather-call",
        endpoints: [{ ...service.endpoints[0], url: "not-an-absolute-url" }],
      },
      "malformed_url",
    ],
  ] satisfies [unknown, DiscoveryCatalogErrorCode][])(
    "rejects invalid discovery with the shared %s discriminator",
    (invalidService, code) => {
      const raw = { services: [invalidService] };
      try {
        parseDiscovery(raw).resolve("weather-call");
        expect.fail("Expected the invalid discovery fixture to be rejected.");
      } catch (error) {
        expect(error).toBeInstanceOf(DiscoveryCatalogError);
        expect(error).toMatchObject({ code, serviceId: "weather-call" });
      }
    },
  );

  it("requires an endpoint selector for distinct transports and resolves the named route", () => {
    const catalog = parseDiscovery({
      services: [
        {
          ...service,
          endpoints: [
            service.endpoints[0],
            {
              ...service.endpoints[1],
              name: "embeddings",
              url: "https://gw.vapi.network/v/private-inference/embeddings",
            },
          ],
        },
      ],
    });

    expect(() => catalog.resolve(service.id)).toThrow(/endpoint: embeddings, private_inference/);
    expect(catalog.resolve(service.id, "embeddings")).toMatchObject({
      name: "embeddings",
      method: "POST",
      url: "https://gw.vapi.network/v/private-inference/embeddings",
    });
  });
});
