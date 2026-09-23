import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runCli, type CliIo } from "./cli.js";

const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const PAY_TO = "0x1111111111111111111111111111111111111111";
const URL_UNDER_TEST = "https://weather.example/v1/weather/paris";

type CheckJson = {
  status: number;
  extensions: string[];
  conformance: {
    declaredVersion: 1 | 2 | null;
    versionConformant: boolean;
    offerTransport: string;
    issues: string[];
  } | null;
  rules: { rule: string; result: string; detail: string; issues: string[] }[];
  summary: { pass: number; warn: number; fail: number };
};

function v2Offer(overrides: Record<string, unknown> = {}, accept: Record<string, unknown> = {}) {
  return {
    x402Version: 2,
    resource: { url: URL_UNDER_TEST, mimeType: "application/json" },
    accepts: [
      {
        scheme: "exact",
        network: "eip155:8453",
        amount: "2500",
        asset: BASE_USDC,
        payTo: PAY_TO,
        maxTimeoutSeconds: 60,
        extra: { name: "USD Coin", version: "2" },
        ...accept,
      },
    ],
    extensions: { bazaar: {} },
    ...overrides,
  };
}

const V1_OFFER = {
  x402Version: 1,
  accepts: [
    {
      scheme: "exact",
      network: "base",
      maxAmountRequired: "2500",
      resource: URL_UNDER_TEST,
      description: "Paris weather",
      mimeType: "application/json",
      payTo: PAY_TO,
      maxTimeoutSeconds: 300,
      asset: BASE_USDC,
      extra: { name: "USD Coin", version: "2" },
    },
  ],
};

const OPENAPI = {
  openapi: "3.1.0",
  servers: [{ url: "https://weather.example/v1" }],
  paths: {
    "/weather/{city}": {
      get: { operationId: "weather", "x-payment-info": { price: "0.0025", protocols: ["x402"] } },
    },
  },
};

type Route = { status?: number; body?: unknown; headers?: Record<string, string> };

/** The origin under test, as a routing table; anything unrouted is a 404. */
function origin(routes: Record<string, Route>) {
  const fetchImpl = vi.fn<typeof fetch>(async (input) => {
    const url = new URL(String(input));
    const route = routes[url.pathname];
    if (route === undefined) return new Response("not found", { status: 404 });
    const body =
      route.body === undefined
        ? null
        : typeof route.body === "string"
          ? route.body
          : JSON.stringify(route.body);
    return new Response(body, { status: route.status ?? 200, headers: route.headers });
  });
  return { fetchImpl, urls: () => fetchImpl.mock.calls.map(([input]) => String(input)) };
}

function paymentRequired(offer: unknown): Record<string, string> {
  return { "payment-required": Buffer.from(JSON.stringify(offer)).toString("base64") };
}

/** A conformant API, with any route overridden. */
function conformantOrigin(overrides: Record<string, Route> = {}) {
  return origin({
    "/v1/weather/paris": { status: 402, body: v2Offer(), headers: paymentRequired(v2Offer()) },
    "/.well-known/x402": { body: { version: 1, resources: [URL_UNDER_TEST] } },
    "/openapi.json": { body: OPENAPI },
    ...overrides,
  });
}

async function check(args: string[], fetchImpl: typeof fetch) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const io: CliIo = { stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) };
  const code = await runCli(["check", ...args], io, { fetchImpl, interactive: false, env: {} });
  return { code, stdout, stderr };
}

async function checkJson(fetchImpl: typeof fetch, extra: string[] = []) {
  const result = await check([URL_UNDER_TEST, ...extra, "--json"], fetchImpl);
  expect(result.stdout).toHaveLength(1);
  return { code: result.code, report: JSON.parse(result.stdout[0]!) as CheckJson };
}

function ruleResult(report: CheckJson, name: string) {
  return report.rules.find((rule) => rule.rule === name);
}

const originalHome = process.env.VAPI_HOME;
beforeEach(async () => {
  process.env.VAPI_HOME = await mkdtemp(join(tmpdir(), "vapi-check-"));
});
afterEach(() => {
  if (originalHome === undefined) delete process.env.VAPI_HOME;
  else process.env.VAPI_HOME = originalHome;
});

describe("vapi check <url>", () => {
  it("passes a conformant v2 API and falls back to root OpenAPI", async () => {
    const api = conformantOrigin();

    const { code, report } = await checkJson(api.fetchImpl);

    expect(code).toBe(0);
    expect(report.summary).toEqual({ pass: 11, warn: 0, fail: 0 });
    expect(report.extensions).toEqual(["bazaar"]);
    expect(report.rules.map((rule) => rule.rule)).toEqual([
      "status",
      "transport",
      "version",
      "fields",
      "scheme",
      "asset",
      "pay_to",
      "timeout",
      "extensions",
      "discovery",
      "openapi",
    ]);
    expect(report.conformance).toEqual({
      declaredVersion: 2,
      versionConformant: true,
      offerTransport: "both",
      issues: [],
    });
    expect(api.urls()).toEqual([
      URL_UNDER_TEST,
      "https://weather.example/.well-known/x402",
      "https://weather.example/v1/weather/openapi.json",
      "https://weather.example/v1/openapi.json",
      "https://weather.example/openapi.json",
    ]);
    expect(ruleResult(report, "openapi")?.detail).toContain("https://weather.example/openapi.json");
  });

  it.each([
    ["relative", "/{city}"],
    ["full", "/v1/weather/{city}"],
  ])(
    "uses a path-adjacent OpenAPI document with a %s path before the root",
    async (_kind, path) => {
      const api = conformantOrigin({
        "/v1/weather/openapi.json": {
          body: {
            openapi: "3.1.0",
            paths: {
              [path]: {
                get: { "x-payment-info": { price: "0.0025", protocols: ["x402"] } },
              },
            },
          },
        },
      });

      const { report } = await checkJson(api.fetchImpl);

      expect(ruleResult(report, "openapi")).toMatchObject({ result: "pass", issues: [] });
      expect(ruleResult(report, "openapi")?.detail).toContain(
        "https://weather.example/v1/weather/openapi.json",
      );
      expect(api.urls()).toEqual([
        URL_UNDER_TEST,
        "https://weather.example/.well-known/x402",
        "https://weather.example/v1/weather/openapi.json",
      ]);
    },
  );

  it("continues past an unrelated path-adjacent OpenAPI document", async () => {
    const api = conformantOrigin({
      "/v1/weather/openapi.json": {
        body: { openapi: "3.1.0", paths: { "/health": { get: {} } } },
      },
    });

    const { report } = await checkJson(api.fetchImpl);

    expect(ruleResult(report, "openapi")).toMatchObject({ result: "pass", issues: [] });
    expect(ruleResult(report, "openapi")?.detail).toContain("https://weather.example/openapi.json");
    expect(api.urls()).toEqual([
      URL_UNDER_TEST,
      "https://weather.example/.well-known/x402",
      "https://weather.example/v1/weather/openapi.json",
      "https://weather.example/v1/openapi.json",
      "https://weather.example/openapi.json",
    ]);
  });

  it("continues through same-origin API catalog service-desc links in order", async () => {
    const api = conformantOrigin({
      "/openapi.json": { status: 404 },
      "/.well-known/api-catalog": {
        body: {
          linkset: [
            {
              anchor: "https://weather.example/",
              "service-desc": [
                { href: "https://elsewhere.example/openapi.json" },
                { href: "/openapi.json" },
                { href: "/specs/unrelated.json" },
                { href: "/specs/weather.json", type: "application/vnd.oai.openapi+json" },
              ],
            },
          ],
        },
      },
      "/specs/unrelated.json": {
        body: { openapi: "3.1.0", paths: { "/status": { get: {} } } },
      },
      "/specs/weather.json": { body: OPENAPI },
    });

    const { report } = await checkJson(api.fetchImpl);

    expect(ruleResult(report, "openapi")).toMatchObject({ result: "pass", issues: [] });
    expect(ruleResult(report, "openapi")?.detail).toContain(
      "https://weather.example/specs/weather.json (via the API catalog at https://weather.example/.well-known/api-catalog)",
    );
    expect(api.urls()).toEqual([
      URL_UNDER_TEST,
      "https://weather.example/.well-known/x402",
      "https://weather.example/v1/weather/openapi.json",
      "https://weather.example/v1/openapi.json",
      "https://weather.example/openapi.json",
      "https://weather.example/.well-known/api-catalog",
      "https://weather.example/specs/unrelated.json",
      "https://weather.example/specs/weather.json",
    ]);
    expect(api.urls()).not.toContain("https://elsewhere.example/openapi.json");
    const catalogRequest = api.fetchImpl.mock.calls.find(
      ([input]) => String(input) === "https://weather.example/.well-known/api-catalog",
    );
    expect(catalogRequest?.[1]?.headers).toEqual({
      accept: "application/linkset+json, application/json",
    });
  });

  it.each([
    ["missing linkset", {}],
    ["non-array linkset", { linkset: {} }],
    ["non-string href", { linkset: [{ "service-desc": [{ href: 42 }, null] }] }],
  ])("tolerates a malformed API catalog with %s", async (_label, catalog) => {
    const api = conformantOrigin({
      "/openapi.json": { status: 404 },
      "/.well-known/api-catalog": { body: catalog },
    });

    const { code, report } = await checkJson(api.fetchImpl);

    expect(code).toBe(0);
    expect(report.summary.fail).toBe(0);
    expect(ruleResult(report, "openapi")).toMatchObject({
      result: "warn",
      issues: ["openapi_missing"],
    });
    expect(ruleResult(report, "openapi")?.detail).toContain(
      "https://weather.example/.well-known/api-catalog",
    );
  });

  it("fails a header-only v2 offer with no resource, in the registry's codes", async () => {
    const offer = v2Offer({ resource: undefined });
    const api = conformantOrigin({
      "/v1/weather/paris": { status: 402, headers: paymentRequired(offer) },
    });

    const { code, report } = await checkJson(api.fetchImpl);

    expect(code).toBe(1);
    expect(ruleResult(report, "transport")).toMatchObject({
      result: "warn",
      issues: ["offer_header_only"],
    });
    expect(ruleResult(report, "fields")).toMatchObject({
      result: "fail",
      issues: ["v2_missing_resource"],
    });
    expect(report.conformance).toEqual({
      declaredVersion: 2,
      versionConformant: false,
      offerTransport: "header",
      issues: ["offer_header_only", "v2_missing_resource"],
    });
  });

  it("reads a v1 body behind a malformed v2 header", async () => {
    const api = conformantOrigin({
      "/v1/weather/paris": {
        status: 402,
        body: V1_OFFER,
        headers: { "payment-required": "not base64 json" },
      },
    });

    const { code, report } = await checkJson(api.fetchImpl);

    expect(code).toBe(1);
    expect(ruleResult(report, "transport")).toMatchObject({
      result: "fail",
      issues: ["v2_header_malformed"],
    });
    expect(ruleResult(report, "version")).toMatchObject({ result: "warn", issues: ["v1_legacy"] });
    expect(ruleResult(report, "fields")?.result).toBe("pass");
    // v1 names the network; `base` is Base mainnet.
    expect(ruleResult(report, "asset")?.result).toBe("pass");
    expect(report.conformance).toMatchObject({
      declaredVersion: 1,
      versionConformant: true,
      offerTransport: "body",
    });
  });

  it("reports known extensions from a header-carried offer in a stable order", async () => {
    const offer = v2Offer({
      extensions: {
        "auth-hints": {},
        unknown: {},
        "offer-and-receipt": {},
        bazaar: {},
        "builder-code": {},
      },
    });
    const api = conformantOrigin({
      "/v1/weather/paris": { status: 402, headers: paymentRequired(offer) },
    });

    const { code, report } = await checkJson(api.fetchImpl);

    expect(code).toBe(0);
    expect(report.extensions).toEqual([
      "bazaar",
      "builder-code",
      "offer-and-receipt",
      "auth-hints",
    ]);
    expect(ruleResult(report, "extensions")).toEqual({
      rule: "extensions",
      result: "pass",
      detail: "Advertises bazaar, builder-code, offer-and-receipt, auth-hints.",
      issues: [],
    });
  });

  it("warns about missing Bazaar metadata in a body-carried offer without failing", async () => {
    const offer = {
      ...V1_OFFER,
      extensions: {
        "auth-hints": {},
        "sign-in-with-x": {},
        "payment-identifier": {},
      },
    };
    const api = conformantOrigin({
      "/v1/weather/paris": { status: 402, body: offer },
    });

    const { code, report } = await checkJson(api.fetchImpl);

    expect(code).toBe(0);
    expect(report.summary.fail).toBe(0);
    expect(report.extensions).toEqual(["payment-identifier", "sign-in-with-x", "auth-hints"]);
    expect(ruleResult(report, "extensions")).toEqual({
      rule: "extensions",
      result: "warn",
      detail:
        "Advertises payment-identifier, sign-in-with-x, auth-hints. Adding Bazaar metadata makes the API discoverable in Coinbase's Bazaar and by Coinbase for Agents.",
      issues: ["bazaar_metadata_missing"],
    });
    expect(report.conformance?.issues).not.toContain("bazaar_metadata_missing");
  });

  it("names v1 field names inside a v2 offer as missing and mistyped v2 fields", async () => {
    const offer = v2Offer(
      {},
      { amount: undefined, maxAmountRequired: "2500", maxTimeoutSeconds: "60" },
    );
    const api = conformantOrigin({
      "/v1/weather/paris": { status: 402, body: offer, headers: paymentRequired(offer) },
    });

    const { report } = await checkJson(api.fetchImpl);

    expect(ruleResult(report, "fields")?.issues).toEqual([
      "v2_missing_amount",
      "v2_invalid_max_timeout_seconds",
    ]);
  });

  it("refuses a scheme other than exact", async () => {
    const offer = v2Offer({}, { scheme: "upto" });
    const api = conformantOrigin({
      "/v1/weather/paris": { status: 402, body: offer, headers: paymentRequired(offer) },
    });

    const { code, report } = await checkJson(api.fetchImpl);

    expect(code).toBe(1);
    expect(ruleResult(report, "scheme")).toMatchObject({
      result: "fail",
      issues: ["scheme_unsupported"],
    });
    expect(ruleResult(report, "asset")).toBeUndefined();
  });

  it.each([
    [{ asset: "0x2222222222222222222222222222222222222222" }, "asset_not_usdc"],
    [{ extra: { name: "USDC", version: "2" } }, "usdc_domain_mismatch"],
    [{ network: "eip155:137" }, "network_unknown"],
  ])("fails an offer that does not pay canonical USDC: %j", async (accept, issue) => {
    const offer = v2Offer({}, accept);
    const api = conformantOrigin({
      "/v1/weather/paris": { status: 402, body: offer, headers: paymentRequired(offer) },
    });

    const { report } = await checkJson(api.fetchImpl);

    expect(ruleResult(report, "asset")).toMatchObject({ result: "fail", issues: [issue] });
  });

  it("checks payTo and maxTimeoutSeconds", async () => {
    const offer = v2Offer(
      {},
      // A mixed-case address with a broken EIP-55 checksum, and a 5-second window.
      { payTo: "0x833589fcD6eDb6E08f4c7C32D4f71b54bdA02913", maxTimeoutSeconds: 5 },
    );
    const api = conformantOrigin({
      "/v1/weather/paris": { status: 402, body: offer, headers: paymentRequired(offer) },
    });

    const { report } = await checkJson(api.fetchImpl);

    expect(ruleResult(report, "pay_to")).toMatchObject({
      result: "fail",
      issues: ["pay_to_invalid"],
    });
    expect(ruleResult(report, "timeout")).toMatchObject({
      result: "warn",
      issues: ["max_timeout_short"],
    });
  });

  it("warns, but does not fail, without a discovery document or x-payment-info", async () => {
    const api = conformantOrigin({
      "/.well-known/x402": { status: 404 },
      "/openapi.json": { body: { openapi: "3.1.0", paths: { "/weather/{city}": { get: {} } } } },
    });

    const { code, report } = await checkJson(api.fetchImpl);

    expect(code).toBe(0);
    expect(ruleResult(report, "discovery")).toMatchObject({
      result: "warn",
      issues: ["discovery_missing"],
    });
    expect(ruleResult(report, "openapi")).toMatchObject({
      result: "warn",
      issues: ["openapi_payment_info_missing"],
    });
    expect(report.summary).toEqual({ pass: 9, warn: 2, fail: 0 });
  });

  it("fails a URL that answers without a 402, and grades nothing it did not get", async () => {
    const api = conformantOrigin({ "/v1/weather/paris": { status: 200, body: { ok: true } } });

    const { code, report } = await checkJson(api.fetchImpl);

    expect(code).toBe(1);
    expect(report.status).toBe(200);
    expect(report.conformance).toBeNull();
    expect(report.extensions).toEqual([]);
    expect(report.rules.map((rule) => [rule.rule, rule.result])).toEqual([
      ["status", "fail"],
      ["discovery", "pass"],
      ["openapi", "pass"],
    ]);
  });

  it("prints one line per rule for a person", async () => {
    const offer = v2Offer({ resource: undefined });
    const api = conformantOrigin({
      "/v1/weather/paris": { status: 402, headers: paymentRequired(offer) },
    });

    const { code, stdout } = await check([URL_UNDER_TEST], api.fetchImpl);

    expect(code).toBe(1);
    const text = stdout.join("\n");
    expect(text).toContain(`Check: GET ${URL_UNDER_TEST} — HTTP 402`);
    expect(text).toContain("  pass  status      HTTP 402 Payment Required.");
    expect(text).toMatch(/^ {2}warn {2}transport {2}.* \[offer_header_only\]$/mu);
    expect(text).toMatch(/^ {2}fail {2}fields {5}.* \[v2_missing_resource\]$/mu);
    expect(text).toContain("  pass  extensions  Advertises bazaar.");
    expect(text).toContain("9 passed, 1 warning, 1 failed.");
  });

  it("sends --method and refuses anything that is not a URL or a method", async () => {
    const api = conformantOrigin();
    expect((await check([URL_UNDER_TEST, "--method", "post", "--json"], api.fetchImpl)).code).toBe(
      0,
    );
    expect(api.fetchImpl.mock.calls[0]![1]?.method).toBe("POST");

    expect((await check(["weather.example"], api.fetchImpl)).code).toBe(2);
    expect((await check([URL_UNDER_TEST, "--method", "FETCH"], api.fetchImpl)).code).toBe(2);
  });
});
