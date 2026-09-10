import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  MARKETPLACE_DISCOVERY_PROTOCOL,
  MARKETPLACE_KINDS,
  MARKETPLACE_RANKING_VERSION,
  marketplaceDiscoveryInputSchema,
  marketplaceDiscoveryPageSchema,
  marketplaceHitSchema,
} from "./index.js";

const fixture = JSON.parse(
  readFileSync(
    new URL("../test/fixtures/marketplace-discovery-page.json", import.meta.url),
    "utf8",
  ),
) as unknown;

describe("marketplace discovery wire contract", () => {
  it("accepts the shared cross-runtime fixture", () => {
    const page = marketplaceDiscoveryPageSchema.parse(fixture);

    expect(page.protocol).toBe(MARKETPLACE_DISCOVERY_PROTOCOL);
    expect(page.rankingVersion).toBe(MARKETPLACE_RANKING_VERSION);
    expect(page.items.map((item) => item.kind)).toEqual([
      "api",
      "api",
      "service_offer",
      "open_request",
    ]);
    expect(
      page.items.slice(0, 2).map((item) => ("provenance" in item ? item.provenance : null)),
    ).toEqual(["self_listed", "indexed"]);
    expect(
      page.items.slice(0, 2).map((item) => ("execution" in item ? item.execution.mode : null)),
    ).toEqual(["direct", "direct"]);
  });

  it("keeps provenance and execution off Work kinds", () => {
    const [, , service, request] = marketplaceDiscoveryPageSchema.parse(fixture).items;

    for (const extra of [
      { provenance: "self_listed" },
      { provenance: "indexed" },
      { execution: { mode: "direct" } },
      { source: "vapi" },
    ]) {
      expect(() => marketplaceHitSchema.parse({ ...service, ...extra })).toThrow();
      expect(() => marketplaceHitSchema.parse({ ...request, ...extra })).toThrow();
    }
  });

  it("binds every marketplace kind to its one valid action and provenance policy", () => {
    const [api, externalApi, request] = (() => {
      const items = marketplaceDiscoveryPageSchema.parse(fixture).items;
      return [items[0], items[1], items[3]] as const;
    })();

    expect(() =>
      marketplaceHitSchema.parse({
        ...api,
        action: { type: "start_engagement", href: "/work/listings/weather" },
      }),
    ).toThrow();
    expect(() =>
      marketplaceHitSchema.parse({
        ...request,
        extraPrivateField: "must never cross the seam",
      }),
    ).toThrow();
    expect(() =>
      marketplaceHitSchema.parse({
        ...api,
        action: { type: "invoke_api", href: "http://insecure.example/pay" },
      }),
    ).toThrow();
    // A mirrored listing must carry its own target; a first-party card never does.
    expect(() => marketplaceHitSchema.parse({ ...api, provenance: "indexed" })).toThrow();
    expect(() =>
      marketplaceHitSchema.parse({ ...externalApi, provenance: "self_listed" }),
    ).toThrow();
    expect(() =>
      marketplaceHitSchema.parse({
        ...externalApi,
        execution: { mode: "direct" },
      }),
    ).toThrow();
  });

  it("allows a gateway execution mode only for first-party provenance", () => {
    const [api, externalApi] = marketplaceDiscoveryPageSchema.parse(fixture).items;

    expect(() =>
      marketplaceHitSchema.parse({ ...api, execution: { mode: "gateway" } }),
    ).not.toThrow();
    expect(() =>
      marketplaceHitSchema.parse({ ...api, provenance: "partner", execution: { mode: "gateway" } }),
    ).not.toThrow();
    // vAPI never fronts a listing it merely mirrored — ADR 0009.
    if (externalApi?.kind !== "api" || externalApi.provenance !== "indexed") {
      throw new Error("Expected the shared fixture to include a mirrored API hit");
    }
    expect(() =>
      marketplaceHitSchema.parse({
        ...externalApi,
        execution: { ...externalApi.execution, mode: "gateway" },
      }),
    ).toThrow();
  });

  it("rejects missing or malformed mirrored execution authority", () => {
    const external = marketplaceDiscoveryPageSchema.parse(fixture).items[1];
    if (external?.kind !== "api" || external.provenance !== "indexed") {
      throw new Error("Expected the shared fixture to include a mirrored API hit");
    }

    const withoutExecution: Partial<typeof external> = { ...external };
    Reflect.deleteProperty(withoutExecution, "execution");
    expect(() => marketplaceHitSchema.parse(withoutExecution)).toThrow();
    expect(() =>
      marketplaceHitSchema.parse({
        ...external,
        execution: { ...external.execution, method: null },
      }),
    ).not.toThrow();
    for (const execution of [
      {
        mode: "direct",
        url: "http://api.weather.example/pay",
        method: "GET",
        network: "eip155:8453",
      },
      {
        mode: "direct",
        url: "https://user:secret@api.weather.example/pay",
        method: "GET",
        network: "eip155:8453",
      },
      {
        mode: "direct",
        url: "https://api.weather.example/pay",
        method: "TRACE",
        network: "eip155:8453",
      },
      {
        mode: "direct",
        url: "https://api.weather.example/pay",
        method: null,
        network: "base",
      },
    ]) {
      expect(() => marketplaceHitSchema.parse({ ...external, execution })).toThrow();
    }
  });

  it("normalizes bounded input and rejects ambiguous kind lists", () => {
    expect(
      marketplaceDiscoveryInputSchema.parse({
        q: "  weather  ",
        kinds: [...MARKETPLACE_KINDS],
        network: "  eip155:8453 ",
        limit: 24,
        includeUnverified: true,
      }),
    ).toEqual({
      q: "weather",
      kinds: ["api", "service_offer", "open_request"],
      network: "eip155:8453",
      limit: 24,
      includeUnverified: true,
    });
    expect(() => marketplaceDiscoveryInputSchema.parse({ kinds: ["api", "api"] })).toThrow();
    expect(() => marketplaceDiscoveryInputSchema.parse({ limit: 51 })).toThrow();
    expect(() => marketplaceDiscoveryInputSchema.parse({ q: "x".repeat(201) })).toThrow();
  });
});
