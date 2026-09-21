import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  MARKETPLACE_DISCOVERY_PROTOCOL,
  MARKETPLACE_KINDS,
  MARKETPLACE_RANKING_VERSION,
  apiMarketplaceHitSchema,
  isMirroredHit,
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
      page.items.slice(0, 2).map((item) => (item.kind === "api" ? item.execution.mode : null)),
    ).toEqual(["direct", "direct"]);
  });

  it("never promotes a Work kind to an API hit, whatever extra axes ride along", () => {
    const [, , service, request] = marketplaceDiscoveryPageSchema.parse(fixture).items;

    for (const extra of [
      { provenance: "self_listed" },
      { provenance: "indexed" },
      { execution: { mode: "direct" } },
      { source: "vapi" },
    ]) {
      // Additive keys are tolerated so a newer registry cannot break a client,
      // but they never make a Work listing payable: only `kind` decides that.
      expect(marketplaceHitSchema.parse({ ...service, ...extra }).kind).toBe("service_offer");
      expect(marketplaceHitSchema.parse({ ...request, ...extra }).kind).toBe("open_request");
      expect(() => apiMarketplaceHitSchema.parse({ ...service, ...extra })).toThrow();
      expect(() => apiMarketplaceHitSchema.parse({ ...request, ...extra })).toThrow();
    }
  });

  it("carries the registry's group and fee disclosures on every kind of hit", () => {
    const page = marketplaceDiscoveryPageSchema.parse({
      ...(fixture as { items: unknown[] }),
      items: (fixture as { items: Record<string, unknown>[] }).items.map((item, index) => ({
        ...item,
        group: ["vapi", "external", "partner", "added"][index],
        fee:
          index === 0
            ? { bps: 500, label: "5% network fee, paid by the API's splitter" }
            : { bps: 0, label: "No network fee" },
      })),
    });

    expect(page.items.map((item) => item.group)).toEqual(["vapi", "external", "partner", "added"]);
    expect(page.items[0]?.fee).toEqual({
      bps: 500,
      label: "5% network fee, paid by the API's splitter",
    });
    expect(page.items.map((item) => item.fee?.bps)).toEqual([500, 0, 0, 0]);
    // The vocabulary is closed, and bps stays a non-negative integer.
    expect(() => marketplaceHitSchema.parse({ ...page.items[0], group: "affiliate" })).toThrow();
    expect(() =>
      marketplaceHitSchema.parse({ ...page.items[0], fee: { bps: -1, label: "negative" } }),
    ).toThrow();
    expect(() => marketplaceHitSchema.parse({ ...page.items[0], fee: { bps: 500 } })).toThrow();
  });

  it("carries the verification tier on every kind of hit, defaulting to none", () => {
    const page = fixture as { items: Record<string, unknown>[] };

    // The shared fixture predates the tier, so every hit reads as `none`.
    expect(
      marketplaceDiscoveryPageSchema.parse(fixture).items.map((item) => item.verification),
    ).toEqual(["none", "none", "none", "none"]);

    const tiered = marketplaceDiscoveryPageSchema.parse({
      ...page,
      items: page.items.map((item, index) => ({
        ...item,
        verification: ["verified", "none", "requested", "verified"][index],
      })),
    });
    expect(tiered.items.map((item) => item.verification)).toEqual([
      "verified",
      "none",
      "requested",
      "verified",
    ]);

    // A tier this client does not know must never read as a vAPI endorsement.
    for (const unknown of ["platinum", null, 7, ""]) {
      expect(
        marketplaceHitSchema.parse({ ...page.items[0], verification: unknown }).verification,
      ).toBe("none");
    }
  });

  it("tolerates additive registry fields and passes them through untouched", () => {
    const page = fixture as { items: Record<string, unknown>[] };
    const parsed = marketplaceDiscoveryPageSchema.parse({
      ...page,
      experimentalRanking: "rrf-v2",
      items: page.items.map((item) => ({
        ...item,
        somethingTheRegistryAddedLater: { nested: true },
        card: { ...(item.card as Record<string, unknown>), highlight: "new" },
      })),
    });

    expect(parsed).toMatchObject({ experimentalRanking: "rrf-v2" });
    expect(parsed.items[0]).toMatchObject({
      somethingTheRegistryAddedLater: { nested: true },
      card: { highlight: "new" },
    });
  });

  it("binds every marketplace kind to its one valid action and provenance policy", () => {
    const [api, externalApi] = (() => {
      const items = marketplaceDiscoveryPageSchema.parse(fixture).items;
      return [items[0], items[1]] as const;
    })();

    expect(() =>
      marketplaceHitSchema.parse({
        ...api,
        action: { type: "start_engagement", href: "/work/listings/weather" },
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
    // The reverse now parses — an inline target is just an extra key on a
    // first-party card — but provenance, not the key, decides what is payable:
    // only a mirrored hit is ever called at its inline URL.
    const relabelled = marketplaceHitSchema.parse({
      ...externalApi,
      provenance: "self_listed",
    });
    expect(isMirroredHit(relabelled)).toBe(false);
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
    // The request this client builds stays strict: a garbage trust switch is a
    // client bug and must fail here, not travel to the registry.
    expect(() => marketplaceDiscoveryInputSchema.parse({ includeUnverified: "yes" })).toThrow();
    expect(marketplaceDiscoveryInputSchema.parse({})).toEqual({});
  });
});
