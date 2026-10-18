import { describe, expect, it, vi } from "vitest";

import type { VapiConfig } from "@vapi-network/core";
import { callSearchInputSchema, inspectToolResultSchema } from "../actions/call.js";
import { inspectService } from "./inspect.js";

const config = {
  discoveryUrl: "https://console.vapinetwork.ai/api/network/services",
  marketplaceDiscoveryUrl: "https://console.vapinetwork.ai/api/marketplace/discovery",
  networks: {},
  spendCaps: { perCallAtomic: "100000", perDayAtomic: "1000000" },
} satisfies VapiConfig;

const requestSchema = {
  type: "object",
  required: ["authorization"],
  properties: { authorization: { type: "string" } },
} as const;

const responseSchema = {
  type: "object",
  properties: { decoded: { type: "string" } },
};
const exampleRequest = { query: { format: "json" }, body: { authorization: "example" } };
const health = {
  state: "healthy",
  uptime7d: 0.99,
  latencyP50Ms: 212,
  latencyP95Ms: 480,
  checks7d: 168,
};

describe("Agent Cash listing inspection", () => {
  it.each([false, true])("returns the endpoint contract (new fields: %s)", async (newFields) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        services: [
          {
            id: "decodepaymentauthorization",
            name: "Decode Payment Authorization",
            description: "Decode an x402 payment authorization.",
            category: "crypto",
            tier: "verified",
            verified: true,
            wrapped: false,
            price: "$0.005",
            networks: ["eip155:8453"],
            ...(newFields ? { health } : {}),
            endpoints: [
              {
                name: "decode",
                method: "POST",
                url: "https://decode.example/decode",
                price: "$0.005",
                description: "Decode an authorization payload.",
                operationId: "decodePaymentAuthorization",
                requestContentType: "application/json",
                requestSchema,
                ...(newFields ? { responseSchema, exampleRequest } : {}),
                responseContentType: "application/json",
                payment: {
                  scheme: "exact",
                  network: "eip155:8453",
                  asset: "0x1111111111111111111111111111111111111111",
                  payTo: "0x2222222222222222222222222222222222222222",
                  checkedAt: "2026-09-08T12:00:00.000Z",
                },
              },
            ],
          },
        ],
      }),
    );

    const result = await inspectService({ id: "decodepaymentauthorization" }, config, fetchImpl);
    expect(result).toEqual({
      name: "decode",
      method: "POST",
      url: "https://decode.example/decode",
      price: "$0.005",
      description: "Decode an authorization payload.",
      operationId: "decodePaymentAuthorization",
      requestContentType: "application/json",
      requestSchema,
      ...(newFields ? { responseSchema, exampleRequest, health } : {}),
      responseContentType: "application/json",
      // The registry sent no tier, so the client shows the safe default.
      verification: "none",
      payment: {
        scheme: "exact",
        network: "eip155:8453",
        asset: "0x1111111111111111111111111111111111111111",
        payTo: "0x2222222222222222222222222222222222222222",
        checkedAt: "2026-09-08T12:00:00.000Z",
      },
    });
    expect(inspectToolResultSchema.omit({ hints: true }).parse(result)).toEqual(result);
    if (!newFields) {
      for (const field of ["responseSchema", "exampleRequest", "health"]) {
        expect(result).not.toHaveProperty(field);
      }
    }
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it.each([health, undefined, "malformed"])(
    "carries optional health from a mirrored API: %j",
    async (value) => {
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(Response.json({ services: [] }))
        .mockResolvedValueOnce(
          Response.json({
            protocol: "vapi.marketplace.discovery/1",
            items: [
              {
                ref: "external-api",
                kind: "api",
                provenance: "indexed",
                execution: {
                  mode: "direct",
                  url: "https://external.example/api",
                  method: "GET",
                  network: "eip155:8453",
                },
                card: {
                  title: "External API",
                  summary: "External endpoint.",
                  badges: [],
                  facts: [],
                },
                action: { type: "invoke_api", href: "/call/external-api" },
                ...(value === undefined ? {} : { health: value }),
              },
            ],
            nextCursor: null,
            unavailableKinds: [],
            rankingVersion: "marketplace-ranking-v1",
          }),
        );
      const result = await inspectService({ id: "external-api" }, config, fetchImpl);
      if (value === health) expect(result.health).toEqual(health);
      else expect(result).not.toHaveProperty("health");
      expect(result).not.toHaveProperty("responseSchema");
      expect(result).not.toHaveProperty("exampleRequest");
      expect(inspectToolResultSchema.omit({ hints: true }).parse(result)).toEqual(result);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(
        fetchImpl.mock.calls.map(([url]) => new URL(url as URL).searchParams.get("includeOutage")),
      ).toEqual(["true", "true"]);
    },
  );

  it("exposes includeOutage as an optional boolean MCP search argument", () => {
    expect(callSearchInputSchema.parse({ includeOutage: true })).toEqual({ includeOutage: true });
    expect(callSearchInputSchema.parse({})).toEqual({});
    expect(() => callSearchInputSchema.parse({ includeOutage: "true" })).toThrow();
  });

  it.each([
    { bps: 0, label: "Outdated fee label", display: "No network fee" },
    {
      bps: 500,
      label: "Network fee kept by this API's legacy payout splitter",
      display: "Network fee kept by this API's legacy payout splitter (5%)",
    },
  ])(
    "reports $bps basis points alongside the request contract",
    async ({ bps, label, display }) => {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
        Response.json({
          services: [
            {
              id: "decodepaymentauthorization",
              name: "Decode Payment Authorization",
              description: "Decode an x402 payment authorization.",
              category: "crypto",
              tier: "verified",
              group: "vapi",
              fee: { bps, label },
              verified: true,
              wrapped: false,
              price: "$0.005",
              networks: ["eip155:8453"],
              somethingTheRegistryAddedLater: "tolerated",
              endpoints: [
                {
                  name: "decode",
                  method: "POST",
                  url: "https://decode.example/decode",
                  price: "$0.005",
                  description: "Decode an authorization payload.",
                },
              ],
            },
          ],
        }),
      );

      await expect(
        inspectService({ id: "decodepaymentauthorization" }, config, fetchImpl),
      ).resolves.toEqual({
        name: "decode",
        method: "POST",
        url: "https://decode.example/decode",
        price: "$0.005",
        description: "Decode an authorization payload.",
        group: "vapi",
        fee: { bps, label },
        feeDisplay: display,
        verification: "none",
        payment: null,
      });
    },
  );

  it.each([
    { fee: undefined, display: undefined },
    { fee: { bps: 0, label: "Outdated fee label" }, display: "No network fee" },
    { fee: { bps: 500, label: "Legacy payout fee" }, display: "Legacy payout fee (5%)" },
  ])("displays indexed fees without changing wire metadata: $display", async ({ fee, display }) => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      if (new URL(String(input)).pathname === "/api/network/services") {
        return Response.json({ services: [] });
      }
      return Response.json({
        protocol: "vapi.marketplace.discovery/1",
        items: [
          {
            ref: "indexed-weather",
            kind: "api",
            provenance: "indexed",
            fee,
            execution: {
              mode: "direct",
              method: "GET",
              url: "https://weather.example/forecast",
              network: "eip155:8453",
            },
            card: { title: "Weather", summary: "Forecast", badges: [], facts: [] },
            action: { type: "invoke_api", href: "/call/invoke" },
          },
        ],
        nextCursor: null,
        unavailableKinds: [],
        rankingVersion: "marketplace-ranking-v1",
      });
    });
    const result = await inspectService({ id: "indexed-weather" }, config, fetchImpl);
    expect(result.fee).toEqual(fee);
    expect(result.feeDisplay).toBe(display);
    if (fee === undefined) expect(result).not.toHaveProperty("feeDisplay");
  });

  it("reports the listing's verification tier", async () => {
    const respondWith = (verification?: string) =>
      vi.fn<typeof fetch>().mockResolvedValue(
        Response.json({
          services: [
            {
              id: "decodepaymentauthorization",
              name: "Decode Payment Authorization",
              description: "Decode an x402 payment authorization.",
              category: "crypto",
              tier: "verified",
              ...(verification === undefined ? {} : { verification }),
              verified: true,
              wrapped: false,
              price: "$0.005",
              networks: ["eip155:8453"],
              endpoints: [
                {
                  name: "decode",
                  method: "POST",
                  url: "https://decode.example/decode",
                  price: "$0.005",
                  description: "Decode an authorization payload.",
                },
              ],
            },
          ],
        }),
      );

    for (const verification of ["verified", "requested", "none"]) {
      await expect(
        inspectService({ id: "decodepaymentauthorization" }, config, respondWith(verification)),
      ).resolves.toMatchObject({ verification });
    }
    // A registry that predates the tier omits the field entirely.
    await expect(
      inspectService({ id: "decodepaymentauthorization" }, config, respondWith()),
    ).resolves.toMatchObject({ verification: "none" });
  });

  it("carries the registry's liveness and conformance, and drops a malformed record", async () => {
    const liveness = { uptime7d: 0.994, latencyP50Ms: 212, latencyP95Ms: 480, checks7d: 168 };
    const conformance = {
      declaredVersion: 2,
      versionConformant: false,
      offerTransport: "header",
      issues: ["v2_missing_resource", "offer_header_only"],
    };
    const respondWith = (health: Record<string, unknown>) =>
      vi.fn<typeof fetch>().mockResolvedValue(
        Response.json({
          services: [
            {
              id: "decodepaymentauthorization",
              name: "Decode Payment Authorization",
              description: "Decode an x402 payment authorization.",
              category: "crypto",
              tier: "verified",
              verified: true,
              wrapped: false,
              price: "$0.005",
              networks: ["eip155:8453"],
              ...health,
              endpoints: [
                {
                  name: "decode",
                  method: "POST",
                  url: "https://decode.example/decode",
                  price: "$0.005",
                  description: "Decode an authorization payload.",
                },
              ],
            },
          ],
        }),
      );

    await expect(
      inspectService(
        { id: "decodepaymentauthorization" },
        config,
        respondWith({ liveness, conformance }),
      ),
    ).resolves.toMatchObject({ liveness, conformance });

    // An uptime above 1 is not a fraction; the listing still resolves, silently.
    const malformed = await inspectService(
      { id: "decodepaymentauthorization" },
      config,
      respondWith({ liveness: { ...liveness, uptime7d: 99.4 }, conformance, health: "malformed" }),
    );
    expect(malformed).not.toHaveProperty("liveness");
    expect(malformed).not.toHaveProperty("health");
    expect(malformed.conformance).toEqual(conformance);
  });

  it("carries identity when present and omits it when absent", async () => {
    const identity = { erc8004Id: "42", reputation: { score: 4.567, count: 1 } };
    const respondWith = (overrides: Record<string, unknown>) =>
      vi.fn<typeof fetch>().mockResolvedValue(
        Response.json({
          services: [
            {
              id: "decodepaymentauthorization",
              name: "Decode Payment Authorization",
              description: "Decode an x402 payment authorization.",
              category: "crypto",
              tier: "verified",
              verified: true,
              wrapped: false,
              price: "$0.005",
              networks: ["eip155:8453"],
              ...overrides,
              endpoints: [
                {
                  name: "decode",
                  method: "POST",
                  url: "https://decode.example/decode",
                  price: "$0.005",
                  description: "Decode an authorization payload.",
                },
              ],
            },
          ],
        }),
      );

    await expect(
      inspectService({ id: "decodepaymentauthorization" }, config, respondWith({ identity })),
    ).resolves.toMatchObject({ identity });
    await expect(
      inspectService({ id: "decodepaymentauthorization" }, config, respondWith({})),
    ).resolves.not.toHaveProperty("identity");
  });

  it("reports an unknown listing id without calling a provider endpoint", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (request) =>
      new URL(request instanceof Request ? request.url : request).pathname.endsWith(
        "/api/marketplace/discovery",
      )
        ? Response.json({
            protocol: "vapi.marketplace.discovery/1",
            items: [],
            nextCursor: null,
            unavailableKinds: [],
            rankingVersion: "marketplace-ranking-v1",
          })
        : Response.json({ services: [] }),
    );

    await expect(inspectService({ id: "unknown-api" }, config, fetchImpl)).rejects.toThrow(
      'No payable endpoint found for service "unknown-api".',
    );
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(new URL(fetchImpl.mock.calls[0]![0] as URL).pathname).toBe("/api/network/services");
  });
});
