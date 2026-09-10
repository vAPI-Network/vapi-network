import { describe, expect, it } from "vitest";

import {
  CALLABLE_CATEGORIES,
  CALLABLE_CATEGORY_LABELS,
  DISCOVERY_CATEGORIES,
  discoveryResponseSchema,
  isCallableListing,
  listServicesResponseSchema,
  serviceSummarySchema,
} from "./index.js";

const validService = {
  id: "weather-call",
  name: "Weather Call",
  description: "Returns the current weather.",
  category: "data",
  tier: "verified",
  verified: true,
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
};

describe("public Call discovery contract", () => {
  it("accepts the current service and response wire shapes", () => {
    expect(serviceSummarySchema.parse(validService)).toEqual(validService);
    const response = { services: [validService] };
    expect(discoveryResponseSchema.parse(response)).toEqual(response);
    expect(listServicesResponseSchema.parse(response)).toEqual(response);
  });

  it("carries browser-playground request and response metadata without weakening the wire", () => {
    const endpoint = {
      ...validService.endpoints[0],
      operationId: "getWeather",
      requestContentType: "application/json",
      requestSchema: {
        type: "object",
        required: ["city"],
        properties: { city: { type: "string" } },
        additionalProperties: false,
      },
      responseContentType: "application/json",
      payment: {
        scheme: "exact",
        network: "eip155:8453",
        asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        payTo: "0x1111111111111111111111111111111111111111",
        checkedAt: "2026-08-17T12:00:00.000Z",
      },
    };

    const parsed = serviceSummarySchema.parse({
      ...validService,
      endpoints: [endpoint],
    });

    expect(parsed.endpoints[0]).toEqual(endpoint);
    expect(() =>
      serviceSummarySchema.parse({
        ...validService,
        endpoints: [{ ...endpoint, requestSchema: () => "not JSON" }],
      }),
    ).toThrow();
  });

  it("accepts the external wire category without adding it to provider policy", () => {
    expect(serviceSummarySchema.parse({ ...validService, category: "other" }).category).toBe(
      "other",
    );
    expect(DISCOVERY_CATEGORIES).toContain("other");
    expect(CALLABLE_CATEGORIES).not.toContain("other" as never);
    expect(isCallableListing("agent", "other")).toBe(false);
  });

  it("rejects unknown categories, non-callable endpoint URLs, and response extras", () => {
    expect(() => serviceSummarySchema.parse({ ...validService, category: "work" })).toThrow();
    expect(() =>
      serviceSummarySchema.parse({
        ...validService,
        endpoints: [{ ...validService.endpoints[0], url: "not-a-url" }],
      }),
    ).toThrow();
    expect(() => discoveryResponseSchema.parse({ services: [validService], total: 1 })).toThrow();
  });

  it("keeps category vocabulary, labels, and callable policy together", () => {
    expect(Object.keys(CALLABLE_CATEGORY_LABELS)).toEqual(CALLABLE_CATEGORIES);
    for (const category of CALLABLE_CATEGORIES) {
      expect(isCallableListing("agent", category)).toBe(true);
    }
    expect(isCallableListing("service", "search")).toBe(false);
    expect(isCallableListing("agent", "other")).toBe(false);
  });
});
