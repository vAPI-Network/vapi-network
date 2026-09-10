import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { getAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { BASE_MAINNET_CAIP2, getDefaultConfig } from "@vapi-network/core";

import { VapiCallError, callService } from "./call.js";

const PRIVATE_KEY = "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" as Hex;
const PAY_TO = getAddress("0x1111111111111111111111111111111111111111");
const OTHER_PAYEE = getAddress("0x2222222222222222222222222222222222222222");
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("Agent Cash marketplace call boundary", () => {
  it("rejects a Work result before making a network request", async () => {
    const fetchImpl = vi.fn<typeof fetch>();

    await expect(
      callService({
        input: { id: "research-brief" },
        marketplaceHit: {
          ref: "research-brief",
          kind: "service_offer",
          card: {
            title: "Research brief",
            summary: "Evidence-backed market research.",
            badges: [],
            facts: [],
          },
          action: { type: "start_engagement", href: "/work/listings/research-brief" },
        },
        account: privateKeyToAccount(PRIVATE_KEY),
        config: getDefaultConfig(),
        fetchImpl,
      }),
    ).rejects.toThrow("only invokes API marketplace results");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("invokes an external-catalog API from structured execution metadata only", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    const result = await callService({
      input: { id: "https://93.184.216.34/weather", method: "POST" },
      marketplaceHit: {
        ref: "https://93.184.216.34/weather",
        kind: "api",
        provenance: "indexed",
        execution: {
          mode: "direct",
          url: "https://93.184.216.34/weather",
          method: "POST",
          network: BASE_MAINNET_CAIP2,
        },
        card: {
          title: "External weather API",
          summary: "Weather from the x402 catalog.",
          badges: [{ code: "external_catalog", label: "External catalog" }],
          facts: [{ label: "Method", value: "DELETE" }],
        },
        action: {
          type: "invoke_api",
          href: "/call/invoke?url=https%3A%2F%2F93.184.216.35%2Fwrong&method=DELETE",
        },
      },
      account: privateKeyToAccount(PRIVATE_KEY),
      config: getDefaultConfig(),
      fetchImpl,
    });

    expect(result).toEqual({ status: 200, body: { ok: true }, payment: null });
    expect(fetchImpl).toHaveBeenCalledOnce();
    const request = fetchImpl.mock.calls[0]![0] as Request;
    expect(request.url).toBe("https://93.184.216.34/weather");
    expect(request.method).toBe("POST");
  });

  it("rejects an initial HTTP API URL before sending a request body", async () => {
    const fetchImpl = vi.fn<typeof fetch>();

    await expect(
      callService({
        input: {
          url: "http://93.184.216.34/weather",
          method: "POST",
          body: { city: "Amsterdam" },
        },
        account: privateKeyToAccount(PRIVATE_KEY),
        config: getDefaultConfig(),
        fetchImpl,
      }),
    ).rejects.toThrow(/HTTPS/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects an HTTPS-to-HTTP redirect without forwarding a request body", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 307,
          headers: { location: "http://93.184.216.34/redirected" },
        }),
      )
      .mockResolvedValueOnce(Response.json({ shouldNotBeReached: true }));

    await expect(
      callService({
        input: {
          url: "https://93.184.216.34/weather",
          method: "POST",
          body: { city: "Amsterdam" },
        },
        account: privateKeyToAccount(PRIVATE_KEY),
        config: getDefaultConfig(),
        fetchImpl,
      }),
    ).rejects.toThrow(/HTTPS/);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("allows an HTTP localhost development target only with the private-network opt-in", async () => {
    const config = getDefaultConfig();
    config.allowPrivateNetwork = true;
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ local: true }));

    const result = await callService({
      input: { url: "http://localhost:5173/weather", method: "GET" },
      account: privateKeyToAccount(PRIVATE_KEY),
      config,
      fetchImpl,
    });

    expect(result).toMatchObject({ status: 200, body: { local: true } });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it.each([
    { status: 301, method: "POST", expectedMethod: "GET", preservesBody: false },
    { status: 301, method: "PUT", expectedMethod: "PUT", preservesBody: true },
    { status: 302, method: "POST", expectedMethod: "GET", preservesBody: false },
    { status: 302, method: "PUT", expectedMethod: "PUT", preservesBody: true },
    { status: 303, method: "POST", expectedMethod: "GET", preservesBody: false },
    { status: 303, method: "PUT", expectedMethod: "GET", preservesBody: false },
    { status: 307, method: "POST", expectedMethod: "POST", preservesBody: true },
    { status: 307, method: "PUT", expectedMethod: "PUT", preservesBody: true },
    { status: 308, method: "POST", expectedMethod: "POST", preservesBody: true },
    { status: 308, method: "PUT", expectedMethod: "PUT", preservesBody: true },
  ])(
    "follows HTTP $status for $method as $expectedMethod with Fetch body semantics",
    async ({ status, method, expectedMethod, preservesBody }) => {
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(
          new Response(null, {
            status,
            headers: { location: "https://93.184.216.34/redirected" },
          }),
        )
        .mockResolvedValueOnce(Response.json({ ok: true }));

      await callService({
        input: {
          url: "https://93.184.216.34/weather",
          method,
          body: { city: "Amsterdam" },
        },
        account: privateKeyToAccount(PRIVATE_KEY),
        config: getDefaultConfig(),
        fetchImpl,
      });

      const redirected = fetchImpl.mock.calls[1]![0] as Request;
      expect(redirected.url).toBe("https://93.184.216.34/redirected");
      expect(redirected.method).toBe(expectedMethod);
      expect(redirected.headers.get("content-type")).toBe(
        preservesBody ? "application/json" : null,
      );
      await expect(redirected.text()).resolves.toBe(
        preservesBody ? JSON.stringify({ city: "Amsterdam" }) : "",
      );
    },
  );

  it("rejects a method that conflicts with the external catalog action", async () => {
    const fetchImpl = vi.fn<typeof fetch>();

    await expect(
      callService({
        input: { id: "https://93.184.216.34/weather", method: "DELETE" },
        marketplaceHit: {
          ref: "https://93.184.216.34/weather",
          kind: "api",
          provenance: "indexed",
          execution: {
            mode: "direct",
            url: "https://93.184.216.34/weather",
            method: "GET",
            network: BASE_MAINNET_CAIP2,
          },
          card: {
            title: "External weather API",
            summary: "Weather from the x402 catalog.",
            badges: [{ code: "external_catalog", label: "External catalog" }],
            facts: [{ label: "Method", value: "GET" }],
          },
          action: {
            type: "invoke_api",
            href: "/call/invoke?url=https%3A%2F%2F93.184.216.34%2Fweather&method=GET",
          },
        },
        account: privateKeyToAccount(PRIVATE_KEY),
        config: getDefaultConfig(),
        fetchImpl,
        lookup: async () => ["93.184.216.34"],
      }),
    ).rejects.toThrow(/conflicting method override/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects an external network override that conflicts with execution metadata", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const config = getDefaultConfig({ ARC_TESTNET_RPC_URL: "https://arc-rpc.example" });

    await expect(
      callService({
        input: {
          id: "https://93.184.216.34/weather",
          method: "GET",
          network: "eip155:5042002",
        },
        marketplaceHit: {
          ref: "https://93.184.216.34/weather",
          kind: "api",
          provenance: "indexed",
          execution: {
            mode: "direct",
            url: "https://93.184.216.34/weather",
            method: "GET",
            network: BASE_MAINNET_CAIP2,
          },
          card: {
            title: "External weather API",
            summary: "Weather from the x402 catalog.",
            badges: [{ code: "external_catalog", label: "External catalog" }],
            facts: [],
          },
          action: { type: "invoke_api", href: "/call/invoke" },
        },
        account: privateKeyToAccount(PRIVATE_KEY),
        config,
        fetchImpl,
      }),
    ).rejects.toThrow(/requires eip155:8453.*requested network was eip155:5042002/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("requires an explicit method when external execution metadata publishes null", async () => {
    const fetchImpl = vi.fn<typeof fetch>();

    await expect(
      callService({
        input: { id: "https://93.184.216.34/weather" },
        marketplaceHit: {
          ref: "https://93.184.216.34/weather",
          kind: "api",
          provenance: "indexed",
          execution: {
            mode: "direct",
            url: "https://93.184.216.34/weather",
            method: null,
            network: BASE_MAINNET_CAIP2,
          },
          card: {
            title: "External weather API",
            summary: "Weather from the x402 catalog.",
            badges: [{ code: "external_catalog", label: "External catalog" }],
            facts: [],
          },
          action: { type: "invoke_api", href: "/call/invoke" },
        },
        account: privateKeyToAccount(PRIVATE_KEY),
        config: getDefaultConfig(),
        fetchImpl,
      }),
    ).rejects.toThrow(/require an explicit method/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects unsupported explicit HTTP methods", async () => {
    const fetchImpl = vi.fn<typeof fetch>();

    await expect(
      callService({
        input: { url: "https://93.184.216.34/weather", method: "TRACE" },
        account: privateKeyToAccount(PRIVATE_KEY),
        config: getDefaultConfig(),
        fetchImpl,
      }),
    ).rejects.toThrow(/method must be one of/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("resolves a native vAPI id through the Calls compatibility contract", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ services: [service()] }))
      .mockResolvedValueOnce(Response.json({ imported: true }));

    const result = await callService({
      input: { id: "imported-weather" },
      marketplaceHit: apiHit({
        ref: "imported-weather",
        href: "/call/imported-weather",
      }),
      account: privateKeyToAccount(PRIVATE_KEY),
      config: getDefaultConfig(),
      fetchImpl,
      lookup: async () => ["93.184.216.34"],
    });

    expect(result).toMatchObject({ status: 200, body: { imported: true } });
    expect((fetchImpl.mock.calls[1]![0] as Request).url).toBe("https://93.184.216.34/weather");
  });

  it("rejects a missing top-level required key before calling or signing for the endpoint", async () => {
    const requestSchema = {
      type: "object",
      required: ["authorization", "network"],
      properties: {
        authorization: { type: "string" },
        network: { type: "string" },
      },
    };
    const account = privateKeyToAccount(PRIVATE_KEY);
    const signSpy = vi.spyOn(account, "signTypedData");
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(
      Response.json({
        services: [
          service({
            endpoints: [endpoint({ requestContentType: "application/json", requestSchema })],
          }),
        ],
      }),
    );

    const error = await callService({
      input: {
        id: "imported-weather",
        body: { authorization: "signed-payload" },
      },
      marketplaceHit: apiHit({ ref: "imported-weather" }),
      account,
      config: getDefaultConfig(),
      fetchImpl,
      lookup: async () => ["93.184.216.34"],
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(VapiCallError);
    expect(error).toMatchObject({ code: "invalid_request" });
    expect((error as Error).message).toContain('missing required keys: "network"');
    expect((error as Error).message).toContain(JSON.stringify(requestSchema));
    expect((error as Error).message).toContain("application/json");
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(new URL(fetchImpl.mock.calls[0]![0] as URL).pathname).toBe("/api/network/services");
    expect(signSpy).not.toHaveBeenCalled();
  });

  it("calls through when the body contains every top-level required key", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          services: [
            service({
              endpoints: [
                endpoint({
                  requestContentType: "application/json",
                  requestSchema: {
                    type: "object",
                    required: ["authorization", "network"],
                  },
                }),
              ],
            }),
          ],
        }),
      )
      .mockResolvedValueOnce(Response.json({ decoded: true }));

    const result = await callService({
      input: {
        id: "imported-weather",
        body: { authorization: "signed-payload", network: "eip155:8453" },
      },
      marketplaceHit: apiHit({ ref: "imported-weather" }),
      account: privateKeyToAccount(PRIVATE_KEY),
      config: getDefaultConfig(),
      fetchImpl,
      lookup: async () => ["93.184.216.34"],
    });

    expect(result).toEqual({ status: 200, body: { decoded: true }, payment: null });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const request = fetchImpl.mock.calls[1]![0] as Request;
    await expect(request.json()).resolves.toEqual({
      authorization: "signed-payload",
      network: "eip155:8453",
    });
  });

  it("echoes the resolved listing's expected request contract on an HTTP 400", async () => {
    const requestSchema = {
      type: "object",
      required: ["authorization"],
      properties: { authorization: { type: "string" } },
    };
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          services: [
            service({
              endpoints: [endpoint({ requestContentType: "application/json", requestSchema })],
            }),
          ],
        }),
      )
      .mockResolvedValueOnce(
        Response.json({ error: "authorization was malformed" }, { status: 400 }),
      );

    const result = await callService({
      input: {
        id: "imported-weather",
        body: { authorization: "malformed-payload" },
      },
      marketplaceHit: apiHit({ ref: "imported-weather" }),
      account: privateKeyToAccount(PRIVATE_KEY),
      config: getDefaultConfig(),
      fetchImpl,
      lookup: async () => ["93.184.216.34"],
    });

    expect(result).toEqual({
      status: 400,
      body: { error: "authorization was malformed" },
      payment: null,
      expectedRequest: {
        contentType: "application/json",
        schema: requestSchema,
      },
    });
  });

  it("binds a registered API call to its confirmed payee before signing", async () => {
    const account = privateKeyToAccount(PRIVATE_KEY);
    const signSpy = vi.spyOn(account, "signTypedData");
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ services: [service()] }))
      .mockResolvedValueOnce(paymentRequired(OTHER_PAYEE));

    await expect(
      callService({
        input: { id: "imported-weather" },
        marketplaceHit: apiHit({ ref: "imported-weather" }),
        account,
        config: getDefaultConfig(),
        fetchImpl,
        lookup: async () => ["93.184.216.34"],
      }),
    ).rejects.toThrow(/No exact x402 payment option matches/);
    expect(signSpy).not.toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("rejects a network or method override that conflicts with the registered endpoint", async () => {
    for (const input of [
      { id: "imported-weather", network: "eip155:5042002" },
      { id: "imported-weather", method: "GET" },
    ]) {
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(Response.json({ services: [service()] }));
      await expect(
        callService({
          input,
          marketplaceHit: apiHit({ ref: "imported-weather" }),
          account: privateKeyToAccount(PRIVATE_KEY),
          config: getDefaultConfig(),
          fetchImpl,
        }),
      ).rejects.toThrow(/registered endpoint|not configured/);
      expect(fetchImpl).toHaveBeenCalledOnce();
    }
  });

  it("pays once when the live quote matches the registered network and payee", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vapi-mcp-marketplace-call-"));
    temporaryDirectories.push(directory);
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ services: [service()] }))
      .mockResolvedValueOnce(paymentRequired(PAY_TO))
      .mockResolvedValueOnce(Response.json({ paid: true }));

    const result = await callService({
      input: { id: "imported-weather", maxPriceUsd: "0.01" },
      marketplaceHit: apiHit({ ref: "imported-weather" }),
      account: privateKeyToAccount(PRIVATE_KEY),
      config: getDefaultConfig(),
      fetchImpl,
      lookup: async () => ["93.184.216.34"],
      ledgerPath: join(directory, "ledger.json"),
    });

    expect(result).toMatchObject({
      body: { paid: true },
      payment: { network: BASE_MAINNET_CAIP2, payTo: PAY_TO },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect((fetchImpl.mock.calls[2]![0] as Request).headers.has("payment-signature")).toBe(true);
  });

  it.each([403, 500])(
    "marks a paid HTTP %s without settlement evidence as ambiguous",
    async (status) => {
      const directory = await mkdtemp(join(tmpdir(), "vapi-mcp-marketplace-call-"));
      temporaryDirectories.push(directory);
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(Response.json({ services: [service()] }))
        .mockResolvedValueOnce(paymentRequired(PAY_TO))
        .mockResolvedValueOnce(new Response("provider failed", { status }));

      await expect(
        callService({
          input: { id: "imported-weather", maxPriceUsd: "0.01" },
          marketplaceHit: apiHit({ ref: "imported-weather" }),
          account: privateKeyToAccount(PRIVATE_KEY),
          config: getDefaultConfig(),
          fetchImpl,
          lookup: async () => ["93.184.216.34"],
          ledgerPath: join(directory, "ledger.json"),
        }),
      ).rejects.toMatchObject({
        code: "settlement_unknown",
        possibleSettlement: expect.objectContaining({ payTo: PAY_TO, amountAtomic: "2500" }),
      });
      expect(fetchImpl).toHaveBeenCalledTimes(3);
    },
  );

  it("preserves a JSON-compatible custom media type from a browser handoff", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ ok: true }));

    await callService({
      input: {
        url: "https://93.184.216.34/weather",
        method: "PATCH",
        body: { city: "Amsterdam" },
        contentType: "application/merge-patch+json",
      },
      account: privateKeyToAccount(PRIVATE_KEY),
      config: getDefaultConfig(),
      fetchImpl,
    });

    expect((fetchImpl.mock.calls[0]![0] as Request).headers.get("content-type")).toBe(
      "application/merge-patch+json",
    );
  });

  it("requires and applies a named endpoint selector for a multi-endpoint API", async () => {
    const multi = service({
      endpoints: [
        endpoint(),
        endpoint({
          name: "forecast",
          method: "GET",
          url: "https://93.184.216.34/forecast",
        }),
      ],
    });
    const ambiguousFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ services: [multi] }));
    await expect(
      callService({
        input: { id: "imported-weather" },
        marketplaceHit: apiHit({ ref: "imported-weather" }),
        account: privateKeyToAccount(PRIVATE_KEY),
        config: getDefaultConfig(),
        fetchImpl: ambiguousFetch,
      }),
    ).rejects.toThrow(/endpoint: forecast, weather/);

    const selectedFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ services: [multi] }))
      .mockResolvedValueOnce(Response.json({ forecast: true }));
    await callService({
      input: { id: "imported-weather", endpoint: "forecast" },
      marketplaceHit: apiHit({ ref: "imported-weather" }),
      account: privateKeyToAccount(PRIVATE_KEY),
      config: getDefaultConfig(),
      fetchImpl: selectedFetch,
      lookup: async () => ["93.184.216.34"],
    });
    const request = selectedFetch.mock.calls[1]![0] as Request;
    expect(request.url).toBe("https://93.184.216.34/forecast");
    expect(request.method).toBe("GET");
  });

  it("encodes a GET handoff body as query parameters", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ weather: true }));

    await callService({
      input: {
        url: "https://93.184.216.34/weather",
        method: "GET",
        body: { city: "Amsterdam", units: "metric" },
      },
      account: privateKeyToAccount(PRIVATE_KEY),
      config: getDefaultConfig(),
      fetchImpl,
    });

    expect((fetchImpl.mock.calls[0]![0] as Request).url).toBe(
      "https://93.184.216.34/weather?city=Amsterdam&units=metric",
    );
  });
});

function apiHit(input: { ref: string; href?: string }) {
  return {
    ref: input.ref,
    kind: "api" as const,
    provenance: "self_listed" as const,
    execution: { mode: "direct" as const },
    card: {
      title: "Weather API",
      summary: "Weather through x402.",
      badges: [],
      facts: [],
    },
    action: { type: "invoke_api" as const, href: input.href ?? `/call/${input.ref}` },
  };
}

function endpoint(overrides: Record<string, unknown> = {}) {
  return {
    name: "weather",
    method: "POST",
    url: "https://93.184.216.34/weather",
    price: "$0.0025",
    description: "Current weather.",
    payment: {
      scheme: "exact",
      network: BASE_MAINNET_CAIP2,
      asset: getDefaultConfig().networks[BASE_MAINNET_CAIP2]!.usdc,
      payTo: PAY_TO,
      checkedAt: "2026-08-17T12:00:00.000Z",
    },
    ...overrides,
  };
}

function service(overrides: Record<string, unknown> = {}) {
  return {
    id: "imported-weather",
    name: "Imported weather",
    description: "Current weather.",
    category: "data",
    tier: "listed",
    verified: false,
    wrapped: false,
    price: "$0.0025",
    networks: [BASE_MAINNET_CAIP2],
    endpoints: [endpoint()],
    ...overrides,
  };
}

function paymentRequired(payTo: string) {
  const config = getDefaultConfig();
  return Response.json(
    {
      x402Version: 2,
      resource: { url: "https://93.184.216.34/weather" },
      accepts: [
        {
          scheme: "exact",
          network: BASE_MAINNET_CAIP2,
          amount: "2500",
          asset: config.networks[BASE_MAINNET_CAIP2]!.usdc,
          payTo,
          maxTimeoutSeconds: 60,
          extra: { name: "USD Coin", version: "2" },
        },
      ],
    },
    { status: 402 },
  );
}
