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
  // A registry that predates the verification tier sends no `verification`, so
  // every parse of `validService` answers with the safe default.
  const defaulted = { ...validService, verification: "none" };

  it("accepts the current service and response wire shapes", () => {
    expect(serviceSummarySchema.parse(validService)).toEqual(defaulted);
    expect(discoveryResponseSchema.parse({ services: [validService] })).toEqual({
      services: [defaulted],
    });
    expect(listServicesResponseSchema.parse({ services: [validService] })).toEqual({
      services: [defaulted],
    });
  });

  it("reads the verification tier of a listing, and defaults an unknown one to none", () => {
    for (const verification of ["none", "requested", "verified"]) {
      expect(serviceSummarySchema.parse({ ...validService, verification })).toMatchObject({
        verification,
      });
    }
    // A tier this client does not know must not read as a vAPI endorsement.
    expect(
      serviceSummarySchema.parse({ ...validService, verification: "platinum" }).verification,
    ).toBe("none");
    expect(serviceSummarySchema.parse({ ...validService, verification: null }).verification).toBe(
      "none",
    );
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

  it("rejects unknown categories and non-callable endpoint URLs", () => {
    expect(() => serviceSummarySchema.parse({ ...validService, category: "work" })).toThrow();
    expect(() =>
      serviceSummarySchema.parse({
        ...validService,
        endpoints: [{ ...validService.endpoints[0], url: "not-a-url" }],
      }),
    ).toThrow();
  });

  it("carries the registry's group and fee disclosure on a listing", () => {
    const listing = {
      ...validService,
      group: "vapi",
      fee: { bps: 500, label: "5% network fee, paid by the API's splitter" },
    };

    expect(serviceSummarySchema.parse(listing)).toEqual({ ...listing, verification: "none" });
    expect(
      serviceSummarySchema.parse({
        ...validService,
        group: "external",
        fee: { bps: 0, label: "No network fee" },
      }),
    ).toMatchObject({ group: "external", fee: { bps: 0 } });
    expect(() => serviceSummarySchema.parse({ ...validService, group: "affiliate" })).toThrow();
    expect(() =>
      serviceSummarySchema.parse({ ...validService, fee: { bps: 1.5, label: "half a bip" } }),
    ).toThrow();
  });

  it("tolerates additive registry fields instead of failing the whole response", () => {
    // A registry that starts sending a new field must never break an installed
    // client; loose parsing keeps the field so `--json` consumers still see it.
    expect(discoveryResponseSchema.parse({ services: [validService], total: 1 })).toEqual({
      services: [defaulted],
      total: 1,
    });
    expect(
      serviceSummarySchema.parse({
        ...validService,
        somethingTheRegistryAddedLater: true,
        endpoints: [{ ...validService.endpoints[0], newEndpointField: "ok" }],
      }),
    ).toMatchObject({
      somethingTheRegistryAddedLater: true,
      endpoints: [{ newEndpointField: "ok" }],
    });
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
