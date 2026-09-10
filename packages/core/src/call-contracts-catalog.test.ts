import { describe, expect, it } from "vitest";

import { DiscoveryCatalogError, parseDiscovery, type DiscoveryCatalogErrorCode } from "./index.js";

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
