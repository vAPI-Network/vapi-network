import { describe, expect, it, vi } from "vitest";

import type { VapiConfig } from "@vapi-network/core";
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

describe("Agent Cash listing inspection", () => {
  it("returns a listing endpoint's executable request contract for free", async () => {
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

    await expect(
      inspectService({ id: "decodepaymentauthorization" }, config, fetchImpl),
    ).resolves.toEqual({
      name: "decode",
      method: "POST",
      url: "https://decode.example/decode",
      price: "$0.005",
      description: "Decode an authorization payload.",
      operationId: "decodePaymentAuthorization",
      requestContentType: "application/json",
      requestSchema,
      responseContentType: "application/json",
      payment: {
        scheme: "exact",
        network: "eip155:8453",
        asset: "0x1111111111111111111111111111111111111111",
        payTo: "0x2222222222222222222222222222222222222222",
        checkedAt: "2026-09-08T12:00:00.000Z",
      },
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
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
