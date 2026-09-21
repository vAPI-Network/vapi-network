import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { verifyMessage } from "viem";

import { API_KEY_SECRET_ACCOUNT } from "@vapi-network/core/api-key";
import type { AuditEntry, SecretStore } from "@vapi-network/core";

import { runCli, type CliDependencies, type CliIo, type CliPrompts } from "./cli.js";

const KEY = "vapi_sk_0123456789abcdefghij";
const WALLET = /^0x[0-9a-fA-F]{40}$/u;

/** A person at a terminal. The empty environment stands in for "no agent marker". */
const HUMAN: CliDependencies = { interactive: true, env: {} };
/** Anything else: a pipe, a script, an agent. */
const AGENT: CliDependencies = { interactive: false, env: {} };

const originalHome = process.env.VAPI_HOME;
const originalPassword = process.env.VAPI_KEYSTORE_PASSWORD;
const originalApiKey = process.env.VAPI_API_KEY;
const homes: string[] = [];

afterEach(async () => {
  restoreEnvironment("VAPI_HOME", originalHome);
  restoreEnvironment("VAPI_KEYSTORE_PASSWORD", originalPassword);
  restoreEnvironment("VAPI_API_KEY", originalApiKey);
  await Promise.all(homes.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

/** The probe of an API that is ready to be listed. */
const PROBE_BODY = {
  name: "Weather Call",
  description: "Current weather and severe-weather alerts.",
  accepts: [{ network: "eip155:8453", maxAmountRequired: "2500" }],
  operations: [
    {
      name: "forecast",
      method: "GET",
      url: "https://weather.example/forecast",
      description: "Current forecast for one place.",
      operationId: "getForecast",
      requestSchema: { type: "object" },
    },
    {
      name: "alerts",
      method: "POST",
      url: "https://weather.example/alerts",
      description: "Severe weather alerts.",
      requestContentType: "application/json",
    },
  ],
  diagnostics: {
    steps: [
      { name: "fetch", status: "ok", detail: "402 Payment Required" },
      { name: "accepts", status: "ok", detail: "1 x402 accept on eip155:8453" },
    ],
    rejection: null,
  },
};

const NONCE_BODY = { nonce: "a1b2c3d4e5f60718" };

const LISTING_BODY = {
  ok: true,
  listing: { slug: "weather-call", status: "draft", verification: "none" },
};

const SPLITTERS_BODY = {
  feeBp: 500,
  networkStates: [
    {
      network: "eip155:8453",
      name: "Base",
      chainId: 8453,
      factoryAddress: "0x2222222222222222222222222222222222222222",
      splitterAddress: "0x3333333333333333333333333333333333333333",
      deployed: false,
      balanceWei: "0",
    },
  ],
};

type Reply = { status?: number; body?: unknown; headers?: Record<string, string> };
type Recorded = { method: string; path: string; query: string; headers: Headers; body: unknown };

/**
 * The registry, as a routing table. Every publish route is explicit, so a
 * request the client should not have made shows up as a 404 in the recording
 * rather than as a silently accepted call.
 */
function registryFetch(routes: Record<string, Reply>) {
  const calls: Recorded[] = [];
  const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    calls.push({
      method,
      path: url.pathname,
      query: url.search,
      headers: new Headers(init?.headers as HeadersInit),
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    });
    const reply = routes[`${method} ${url.pathname}`];
    if (reply === undefined) {
      return new Response(JSON.stringify({ error: `no route for ${method} ${url.pathname}` }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(reply.body === undefined ? "" : JSON.stringify(reply.body), {
      status: reply.status ?? 200,
      headers: { "content-type": "application/json", ...reply.headers },
    });
  });
  return { fetchImpl, calls, paths: () => calls.map((call) => `${call.method} ${call.path}`) };
}

/** The four routes a successful `vapi publish <url>` walks through. */
function happyRegistry(overrides: Record<string, Reply> = {}) {
  return registryFetch({
    "POST /api/call/listings/probe": { body: PROBE_BODY },
    "GET /api/call/listings/payout-nonce": { body: NONCE_BODY },
    "POST /api/call/listings": { status: 201, body: LISTING_BODY },
    "GET /api/call/listings/splitters": { body: SPLITTERS_BODY },
    ...overrides,
  });
}

describe("vapi publish <url>", () => {
  it("probes, signs the payout line, creates the listing and reports the splitter", async () => {
    await initializedHome("vapi-publish-json-");
    process.env.VAPI_API_KEY = KEY;
    const registry = happyRegistry();
    const captured = captureIo();

    const code = await runCli(
      [
        "publish",
        "https://weather.example",
        "--select",
        "forecast,alerts",
        "--category",
        "data",
        "--json",
      ],
      captured.io,
      { ...AGENT, fetchImpl: registry.fetchImpl, prompts: refusingPrompts() },
    );

    expect(code).toBe(0);
    expect(registry.paths()).toEqual([
      "POST /api/call/listings/probe",
      "GET /api/call/listings/payout-nonce",
      "POST /api/call/listings",
      "GET /api/call/listings/splitters",
    ]);
    for (const call of registry.calls) {
      expect(call.headers.get("authorization")).toBe(`Bearer ${KEY}`);
    }
    expect(registry.calls[0]?.body).toEqual({ url: "https://weather.example" });

    const created = registry.calls[2]?.body as {
      name: string;
      description: string;
      category: string;
      payoutWallet: string;
      siweMessage: string;
      signature: `0x${string}`;
      endpoints: Record<string, unknown>[];
    };
    expect(created.name).toBe("Weather Call");
    expect(created.description).toBe("Current weather and severe-weather alerts.");
    expect(created.category).toBe("data");
    expect(created.payoutWallet).toMatch(WALLET);
    expect(created.endpoints).toEqual([
      {
        name: "forecast",
        method: "GET",
        url: "https://weather.example/forecast",
        description: "Current forecast for one place.",
        operationId: "getForecast",
        requestSchema: { type: "object" },
      },
      {
        name: "alerts",
        method: "POST",
        url: "https://weather.example/alerts",
        description: "Severe weather alerts.",
        requestContentType: "application/json",
      },
    ]);

    // The wallet signed exactly the line it was shown, and the registry can
    // recover the payout address from it.
    expect(created.siweMessage).toContain("api.vapinetwork.ai wants you to sign in");
    expect(created.siweMessage).toContain("Confirm this wallet receives vAPI Call payouts");
    expect(created.siweMessage).toContain("Chain ID: 8453");
    expect(created.siweMessage).toContain(`Nonce: ${NONCE_BODY.nonce}`);
    expect(
      await verifyMessage({
        address: created.payoutWallet as `0x${string}`,
        message: created.siweMessage,
        signature: created.signature,
      }),
    ).toBe(true);

    // --json is the raw responses, one object, and nothing else on stdout.
    expect(captured.stdout).toHaveLength(1);
    const value = JSON.parse(captured.stdout[0]!) as Record<string, unknown>;
    expect(value.wallet).toBe("main");
    expect(value.probe).toEqual(PROBE_BODY);
    expect(value.listing).toEqual(LISTING_BODY);
    expect(value.splitters).toEqual(SPLITTERS_BODY);
    expect(nonceWallet(registry)).toMatch(WALLET);
  });

  it("signs the registry's own message when it sends one", async () => {
    await initializedHome("vapi-publish-supplied-message-");
    process.env.VAPI_API_KEY = KEY;
    const registry = happyRegistry({
      "GET /api/call/listings/payout-nonce": {
        body: { nonce: "a1b2c3d4e5f60718", message: "sign exactly this" },
      },
    });
    const captured = captureIo();

    expect(
      await runCli(
        ["publish", "https://weather.example", "--yes", "--category", "data", "--json"],
        captured.io,
        { ...AGENT, fetchImpl: registry.fetchImpl, prompts: refusingPrompts() },
      ),
    ).toBe(0);

    const created = registry.calls[2]?.body as { siweMessage: string };
    expect(created.siweMessage).toBe("sign exactly this");
  });

  it("tells a person what to do next, in words", async () => {
    await initializedHome("vapi-publish-human-");
    process.env.VAPI_API_KEY = KEY;
    const registry = happyRegistry();
    const captured = captureIo();

    expect(
      await runCli(
        ["publish", "https://weather.example", "--select", "forecast", "--category", "data"],
        captured.io,
        { ...AGENT, fetchImpl: registry.fetchImpl, prompts: refusingPrompts() },
      ),
    ).toBe(0);

    const text = captured.stdout.join("\n");
    expect(text).toContain("Probe: https://weather.example");
    expect(text).toContain("fetch — ok — 402 Payment Required");
    expect(text).toMatch(/^Wallet: main \(0x[0-9a-fA-F]{40}\)$/mu);
    expect(text).toContain("Listed Weather Call as weather-call with 1 endpoint.");
    expect(text).toContain("Status: draft · verification: none");
    expect(text).toContain("Splitters (vAPI fee 5%):");
    expect(text).toContain("0x3333333333333333333333333333333333333333");
    expect(text).toContain("not deployed");
    expect(text).toContain(
      "Deploy the FeeSplitter from your wallet in the console at https://api.vapinetwork.ai/providers, then run `vapi publish activate weather-call`.",
    );
    expect(captured.stderr).toEqual([]);
  });

  it("keeps the slug when the splitter lookup fails", async () => {
    await initializedHome("vapi-publish-splitter-down-");
    process.env.VAPI_API_KEY = KEY;
    const registry = happyRegistry({
      "GET /api/call/listings/splitters": { status: 503, body: { error: "upstream down" } },
    });
    const captured = captureIo();

    expect(
      await runCli(
        ["publish", "https://weather.example", "--yes", "--category", "data"],
        captured.io,
        { ...AGENT, fetchImpl: registry.fetchImpl, prompts: refusingPrompts() },
      ),
    ).toBe(0);

    const text = captured.stdout.join("\n");
    expect(text).toContain("Listed Weather Call as weather-call");
    expect(text).toContain("Could not read your splitters:");
    expect(text).toContain("vapi publish activate weather-call");
  });

  it("stops at exit 2 on a probe the registry rejects, before anything is signed", async () => {
    await initializedHome("vapi-publish-rejected-");
    process.env.VAPI_API_KEY = KEY;
    const rejection = {
      diagnostics: {
        steps: [{ name: "fetch", status: "ok", detail: "200 OK" }],
        rejection: {
          code: "no_x402",
          message: "https://weather.example answered 200, not 402.",
          hint: "Put the endpoint behind an x402 paywall, then run vapi publish again.",
        },
      },
    };
    const registry = happyRegistry({ "POST /api/call/listings/probe": { body: rejection } });
    const captured = captureIo();

    expect(
      await runCli(
        ["publish", "https://weather.example", "--yes", "--category", "data"],
        captured.io,
        { ...AGENT, fetchImpl: registry.fetchImpl, prompts: refusingPrompts() },
      ),
    ).toBe(2);

    expect(registry.paths()).toEqual(["POST /api/call/listings/probe"]);
    expect(captured.stdout.join("\n")).toContain("fetch — ok — 200 OK");
    expect(captured.stderr.join("\n")).toBe(
      [
        "Probe rejected: no_x402",
        "https://weather.example answered 200, not 402.",
        "Hint: Put the endpoint behind an x402 paywall, then run vapi publish again.",
      ].join("\n"),
    );
  });

  it("emits the raw probe and exits 2 on a rejection in --json", async () => {
    await initializedHome("vapi-publish-rejected-json-");
    process.env.VAPI_API_KEY = KEY;
    const body = { diagnostics: { steps: [], rejection: { code: "private_host" } } };
    const registry = happyRegistry({ "POST /api/call/listings/probe": { body } });
    const captured = captureIo();

    expect(
      await runCli(
        ["publish", "https://weather.example", "--yes", "--category", "data", "--json"],
        captured.io,
        { ...AGENT, fetchImpl: registry.fetchImpl, prompts: refusingPrompts() },
      ),
    ).toBe(2);

    expect(captured.stdout).toHaveLength(1);
    expect(JSON.parse(captured.stdout[0]!)).toEqual({ probe: body });
    expect(captured.stderr).toEqual([]);
  });

  it("refuses to choose endpoints for a run nobody is watching", async () => {
    await initializedHome("vapi-publish-no-tty-");
    process.env.VAPI_API_KEY = KEY;
    const registry = happyRegistry();
    const captured = captureIo();

    expect(
      await runCli(["publish", "https://weather.example", "--category", "data"], captured.io, {
        ...AGENT,
        fetchImpl: registry.fetchImpl,
        prompts: refusingPrompts(),
      }),
    ).toBe(2);

    expect(registry.paths()).toEqual(["POST /api/call/listings/probe"]);
    expect(captured.stderr.join("\n")).toContain(
      "vapi publish needs a terminal to choose endpoints.",
    );
  });

  it("asks a person which endpoints to list and what to call them", async () => {
    await initializedHome("vapi-publish-interactive-");
    process.env.VAPI_API_KEY = KEY;
    const registry = happyRegistry({
      "POST /api/call/listings/probe": {
        body: { ...PROBE_BODY, name: undefined, description: undefined },
      },
    });
    const captured = captureIo();
    const answers = ["2", "Weather Alerts", "Severe weather alerts only.", "Data"];
    const prompts: CliPrompts = {
      secret: async () => "test-only-passphrase",
      line: async () => answers.shift()!,
    };

    expect(
      await runCli(["publish", "https://weather.example"], captured.io, {
        ...HUMAN,
        fetchImpl: registry.fetchImpl,
        prompts,
      }),
    ).toBe(0);

    const text = captured.stdout.join("\n");
    expect(text).toContain("Endpoints found:");
    expect(text).toContain("1  forecast\tGET\thttps://weather.example/forecast");
    expect(text).toContain("2  alerts\tPOST\thttps://weather.example/alerts");
    const created = registry.calls[2]?.body as {
      name: string;
      description: string;
      category: string;
      endpoints: { name: string }[];
    };
    expect(created.endpoints.map((endpoint) => endpoint.name)).toEqual(["alerts"]);
    expect(created.name).toBe("Weather Alerts");
    expect(created.description).toBe("Severe weather alerts only.");
    expect(created.category).toBe("data");
  });

  it("names the endpoints the probe found when --select misses", async () => {
    await initializedHome("vapi-publish-bad-select-");
    process.env.VAPI_API_KEY = KEY;
    const registry = happyRegistry();
    const captured = captureIo();

    expect(
      await runCli(
        ["publish", "https://weather.example", "--select", "radar", "--category", "data"],
        captured.io,
        { ...AGENT, fetchImpl: registry.fetchImpl, prompts: refusingPrompts() },
      ),
    ).toBe(2);

    expect(captured.stderr.join("\n")).toContain(
      'No endpoint named "radar". The probe found forecast, alerts.',
    );
  });

  it("insists on a category a script did not supply", async () => {
    await initializedHome("vapi-publish-no-category-");
    process.env.VAPI_API_KEY = KEY;
    const registry = happyRegistry();
    const captured = captureIo();

    expect(
      await runCli(["publish", "https://weather.example", "--yes"], captured.io, {
        ...AGENT,
        fetchImpl: registry.fetchImpl,
        prompts: refusingPrompts(),
      }),
    ).toBe(2);

    expect(captured.stderr.join("\n")).toContain(
      "vapi publish needs a category: --category <ai|data|crypto|compute|search>.",
    );
  });

  it("refuses anything that is not an http URL", async () => {
    await initializedHome("vapi-publish-bad-url-");
    process.env.VAPI_API_KEY = KEY;
    const registry = happyRegistry();
    const captured = captureIo();

    expect(
      await runCli(["publish", "weather.example"], captured.io, {
        ...AGENT,
        fetchImpl: registry.fetchImpl,
      }),
    ).toBe(2);

    expect(registry.calls).toEqual([]);
    expect(captured.stderr.join("\n")).toContain("vapi publish takes the http(s) URL");
  });

  it("sends --method and --mode through to the probe", async () => {
    await initializedHome("vapi-publish-mode-");
    process.env.VAPI_API_KEY = KEY;
    const registry = happyRegistry();
    const captured = captureIo();

    expect(
      await runCli(
        [
          "publish",
          "https://weather.example/openapi.json",
          "--mode",
          "openapi",
          "--method",
          "POST",
          "--yes",
          "--category",
          "data",
          "--json",
        ],
        captured.io,
        { ...AGENT, fetchImpl: registry.fetchImpl, prompts: refusingPrompts() },
      ),
    ).toBe(0);

    expect(registry.calls[0]?.body).toEqual({
      url: "https://weather.example/openapi.json",
      method: "POST",
      mode: "openapi",
    });
  });

  it("refuses a mode the registry does not have", async () => {
    await initializedHome("vapi-publish-bad-mode-");
    process.env.VAPI_API_KEY = KEY;
    const captured = captureIo();

    expect(
      await runCli(["publish", "https://weather.example", "--mode", "guess"], captured.io, AGENT),
    ).toBe(2);
    expect(captured.stderr.join("\n")).toContain("--mode must be one of origin, endpoint, openapi");
  });

  it("writes one audit line naming the listing it created", async () => {
    const home = await initializedHome("vapi-publish-audit-");
    process.env.VAPI_API_KEY = KEY;
    const registry = happyRegistry();

    expect(
      await runCli(
        ["publish", "https://weather.example", "--yes", "--category", "data", "--json"],
        captureIo().io,
        { ...AGENT, fetchImpl: registry.fetchImpl, prompts: refusingPrompts() },
      ),
    ).toBe(0);

    const entries = await readAuditLog(home);
    expect(entries.at(-1)).toMatchObject({
      event: "listing.publish",
      wallet: "main",
      detail: "weather-call",
    });
  });
});

describe("vapi publish activate, verify-request and list", () => {
  it("activates a listing and says what comes next", async () => {
    await initializedHome("vapi-publish-activate-");
    process.env.VAPI_API_KEY = KEY;
    const registry = registryFetch({
      "POST /api/call/listings/weather-call/status": {
        body: { ok: true, status: "active", verification: "none" },
      },
    });
    const captured = captureIo();

    expect(
      await runCli(["publish", "activate", "weather-call"], captured.io, {
        ...AGENT,
        fetchImpl: registry.fetchImpl,
      }),
    ).toBe(0);

    expect(registry.calls[0]?.body).toEqual({ action: "activate" });
    expect(captured.stdout.join("\n")).toContain(
      "Listing weather-call: active · verification: none",
    );
    expect(captured.stdout.join("\n")).toContain(
      "Ask for review with vapi publish verify-request weather-call.",
    );
  });

  it("asks for verification and returns the raw response in --json", async () => {
    await initializedHome("vapi-publish-verify-");
    process.env.VAPI_API_KEY = KEY;
    const body = { ok: true, status: "active", verification: "requested" };
    const registry = registryFetch({
      "POST /api/call/listings/weather-call/status": { body },
    });
    const captured = captureIo();

    expect(
      await runCli(["publish", "verify-request", "weather-call", "--json"], captured.io, {
        ...AGENT,
        fetchImpl: registry.fetchImpl,
      }),
    ).toBe(0);

    expect(registry.calls[0]?.body).toEqual({ action: "request_verification" });
    expect(JSON.parse(captured.stdout[0]!)).toEqual(body);
  });

  it("passes a 409 refusal on, with the registry's own sentence", async () => {
    await initializedHome("vapi-publish-activate-409-");
    process.env.VAPI_API_KEY = KEY;
    const registry = registryFetch({
      "POST /api/call/listings/weather-call/status": {
        status: 409,
        body: { error: "Deploy the FeeSplitter on Base before activating." },
      },
    });
    const captured = captureIo();

    expect(
      await runCli(["publish", "activate", "weather-call"], captured.io, {
        ...AGENT,
        fetchImpl: registry.fetchImpl,
      }),
    ).toBe(1);
    expect(captured.stderr.join("\n")).toBe("Deploy the FeeSplitter on Base before activating.");
  });

  it("lists what this key owns", async () => {
    await initializedHome("vapi-publish-list-");
    process.env.VAPI_API_KEY = KEY;
    const registry = registryFetch({
      "GET /api/call/listings/mine": {
        body: {
          listings: [
            { slug: "weather-call", status: "active", verification: "requested", name: "Weather" },
          ],
        },
      },
    });
    const captured = captureIo();

    expect(
      await runCli(["publish", "list"], captured.io, { ...AGENT, fetchImpl: registry.fetchImpl }),
    ).toBe(0);
    expect(captured.stdout[0]).toBe(
      ["SLUG\tSTATUS\tVERIFICATION\tNAME", "weather-call\tactive\trequested\tWeather"].join("\n"),
    );
  });

  it("says so when there is nothing listed yet", async () => {
    await initializedHome("vapi-publish-list-empty-");
    process.env.VAPI_API_KEY = KEY;
    const registry = registryFetch({ "GET /api/call/listings/mine": { body: { listings: [] } } });
    const captured = captureIo();

    expect(
      await runCli(["publish", "list"], captured.io, { ...AGENT, fetchImpl: registry.fetchImpl }),
    ).toBe(0);
    expect(captured.stdout[0]).toBe("No listings yet. Create one with vapi publish <url>.");
  });

  it("turns a rejected key into the sentence that repairs it", async () => {
    await initializedHome("vapi-publish-401-");
    process.env.VAPI_API_KEY = KEY;
    const registry = registryFetch({
      "GET /api/call/listings/mine": { status: 401, body: { error: "unknown key" } },
    });
    const captured = captureIo();

    expect(
      await runCli(["publish", "list", "--json"], captured.io, {
        ...AGENT,
        fetchImpl: registry.fetchImpl,
      }),
    ).toBe(1);
    const value = JSON.parse(captured.stdout[0]!) as { error: string; exitCode: number };
    expect(value.exitCode).toBe(1);
    expect(value.error).toContain("The vAPI API key was rejected.");
    expect(value.error).toContain("vapi auth set-key");
  });

  it("says how long a rate limit asked us to wait", async () => {
    await initializedHome("vapi-publish-429-");
    process.env.VAPI_API_KEY = KEY;
    const registry = registryFetch({
      "GET /api/call/listings/mine": { status: 429, headers: { "retry-after": "60" } },
    });
    const captured = captureIo();

    expect(
      await runCli(["publish", "list"], captured.io, { ...AGENT, fetchImpl: registry.fetchImpl }),
    ).toBe(1);
    expect(captured.stderr.join("\n")).toContain("Try again in 60 seconds.");
  });

  it("names the fields a 422 refused", async () => {
    await initializedHome("vapi-publish-422-");
    process.env.VAPI_API_KEY = KEY;
    const registry = happyRegistry({
      "POST /api/call/listings": {
        status: 422,
        body: { message: "Listing is invalid.", issues: [{ path: ["name"], message: "too long" }] },
      },
    });
    const captured = captureIo();

    expect(
      await runCli(
        ["publish", "https://weather.example", "--yes", "--category", "data"],
        captured.io,
        { ...AGENT, fetchImpl: registry.fetchImpl, prompts: refusingPrompts() },
      ),
    ).toBe(1);
    expect(captured.stderr.join("\n")).toContain("vAPI rejected the listing as invalid.");
    expect(captured.stderr.join("\n")).toContain("name: too long");
  });

  it("asks for a key before it asks for anything else", async () => {
    await initializedHome("vapi-publish-no-key-");
    delete process.env.VAPI_API_KEY;
    const registry = registryFetch({});
    const captured = captureIo();

    expect(
      await runCli(["publish", "list"], captured.io, {
        ...AGENT,
        fetchImpl: registry.fetchImpl,
        secretStore: secretStoreStub(),
      }),
    ).toBe(1);

    expect(registry.calls).toEqual([]);
    const message = captured.stderr.join("\n");
    expect(message).toContain("No vAPI API key on this machine.");
    expect(message).toContain("https://api.vapinetwork.ai/account");
    expect(message).toContain("vapi auth set-key");
    expect(message).toContain("VAPI_API_KEY");
  });
});

describe("vapi auth", () => {
  it("never takes the key from the command line", async () => {
    await initializedHome("vapi-auth-argv-");
    const captured = captureIo();

    expect(
      await runCli(["auth", "set-key", KEY], captured.io, { ...HUMAN, prompts: refusingPrompts() }),
    ).toBe(2);
    expect(
      await runCli(["auth", "set-key", "--api-key", KEY], captured.io, {
        ...HUMAN,
        prompts: refusingPrompts(),
      }),
    ).toBe(2);
    expect(captured.stderr.join("\n")).toContain(
      "vapi auth set-key reads the key from a prompt. Never pass an API key as an argument",
    );
  });

  it("refuses to take a key from anything but a terminal", async () => {
    const home = await initializedHome("vapi-auth-agent-");
    const captured = captureIo();

    expect(
      await runCli(["auth", "set-key"], captured.io, {
        interactive: false,
        env: { CLAUDECODE: "1" },
        prompts: refusingPrompts(),
        secretStore: secretStoreStub(),
      }),
    ).toBe(1);

    expect(captured.stderr.join("\n")).toContain(
      "Type the API key yourself in a terminal; an agent must never be handed one.",
    );
    expect((await readAuditLog(home)).at(-1)).toMatchObject({ event: "auth.key.set" });
    expect((await readAuditLog(home)).at(-1)?.detail).toContain("refused");
  });

  it("stores the key in the OS secret store, and never prints it", async () => {
    const home = await initializedHome("vapi-auth-set-");
    const entries: Record<string, string> = {};
    const captured = captureIo();

    expect(
      await runCli(["auth", "set-key"], captured.io, {
        ...HUMAN,
        prompts: { secret: async () => KEY },
        secretStore: secretStoreStub(entries),
      }),
    ).toBe(0);

    expect(entries[API_KEY_SECRET_ACCOUNT]).toBe(KEY);
    expect(captured.stdout.join("\n")).toContain(
      "The vAPI API key vapi_sk_…ghij is stored in the macOS Keychain.",
    );
    expect(captured.stdout.join("\n")).not.toContain(KEY);
    expect(await readFile(join(home, "config.json"), "utf8")).not.toContain(KEY);
    expect((await readAuditLog(home)).at(-1)).toMatchObject({
      event: "auth.key.set",
      detail: "secret-store",
    });
  });

  it("refuses a key that is not a registry key", async () => {
    await initializedHome("vapi-auth-bad-key-");
    const captured = captureIo();

    expect(
      await runCli(["auth", "set-key"], captured.io, {
        ...HUMAN,
        prompts: { secret: async () => "sk-live-nope" },
        secretStore: secretStoreStub(),
      }),
    ).toBe(1);
    expect(captured.stderr.join("\n")).toContain("A vAPI API key starts with vapi_sk_");
  });

  it("says where a key comes from, masked", async () => {
    await initializedHome("vapi-auth-status-");
    delete process.env.VAPI_API_KEY;
    const store = secretStoreStub({ [API_KEY_SECRET_ACCOUNT]: KEY });
    const stored = captureIo();

    expect(
      await runCli(["auth", "status", "--json"], stored.io, { ...AGENT, secretStore: store }),
    ).toBe(0);
    expect(JSON.parse(stored.stdout[0]!)).toEqual({
      present: true,
      source: "secret-store",
      location: "the macOS Keychain",
      key: "vapi_sk_…ghij",
      message: "The vAPI API key vapi_sk_…ghij is read from the macOS Keychain.",
    });

    process.env.VAPI_API_KEY = KEY;
    const fromEnv = captureIo();
    expect(await runCli(["auth", "status"], fromEnv.io, { ...AGENT, secretStore: store })).toBe(0);
    expect(fromEnv.stdout.join("\n")).toContain("read from the VAPI_API_KEY environment variable");
  });

  it("reports an empty machine with the link that fixes it", async () => {
    await initializedHome("vapi-auth-status-empty-");
    delete process.env.VAPI_API_KEY;
    const captured = captureIo();

    expect(
      await runCli(["auth", "status"], captured.io, {
        ...AGENT,
        secretStore: secretStoreStub(),
      }),
    ).toBe(0);
    expect(captured.stdout.join("\n")).toContain("No vAPI API key on this machine.");
    expect(captured.stdout.join("\n")).toContain("https://api.vapinetwork.ai/account");
  });

  it("clears the key and warns that the environment still has one", async () => {
    const home = await initializedHome("vapi-auth-clear-");
    process.env.VAPI_API_KEY = KEY;
    const entries: Record<string, string> = { [API_KEY_SECRET_ACCOUNT]: KEY };
    const captured = captureIo();

    expect(
      await runCli(["auth", "clear"], captured.io, {
        ...AGENT,
        secretStore: secretStoreStub(entries),
      }),
    ).toBe(0);

    expect(entries[API_KEY_SECRET_ACCOUNT]).toBeUndefined();
    const text = captured.stdout.join("\n");
    expect(text).toContain("Removed the vAPI API key from the macOS Keychain.");
    expect(text).toContain("VAPI_API_KEY is still set in this environment");
    expect((await readAuditLog(home)).at(-1)).toMatchObject({ event: "auth.key.clear" });
  });

  it("says so when there was nothing to clear", async () => {
    await initializedHome("vapi-auth-clear-empty-");
    delete process.env.VAPI_API_KEY;
    const captured = captureIo();

    expect(
      await runCli(["auth", "clear", "--json"], captured.io, {
        ...AGENT,
        secretStore: secretStoreStub(),
      }),
    ).toBe(0);
    expect(JSON.parse(captured.stdout[0]!)).toMatchObject({
      cleared: [],
      envStillSet: false,
      message: "No vAPI API key was stored on this machine.",
    });
  });

  it("names an unknown subcommand without claiming auth does not exist", async () => {
    await initializedHome("vapi-auth-unknown-");
    const captured = captureIo();

    expect(await runCli(["auth", "rotate"], captured.io, AGENT)).toBe(2);
    expect(captured.stderr.join("\n")).toContain('Unknown auth subcommand "rotate"');
    expect(captured.stderr.join("\n")).not.toContain("Unknown command");
  });
});

/** The wallet the payout nonce was requested for. */
function nonceWallet(registry: { calls: Recorded[] }): string {
  const call = registry.calls.find((entry) => entry.path.endsWith("/payout-nonce"));
  return new URLSearchParams(call?.query ?? "").get("wallet") ?? "";
}

function secretStoreStub(entries: Record<string, string> = {}): SecretStore {
  return {
    available: true,
    platform: "darwin",
    description: "the macOS Keychain",
    get: async (name) => entries[name],
    has: async (name) => entries[name] !== undefined,
    set: async (name, value) => {
      entries[name] = value;
    },
    remove: async (name) => {
      if (entries[name] === undefined) return false;
      delete entries[name];
      return true;
    },
  };
}

function refusingPrompts(): CliPrompts {
  const refuse = async (prompt: string): Promise<string> => {
    throw new Error(`Unexpected prompt ${JSON.stringify(prompt)}.`);
  };
  return { secret: refuse, line: refuse };
}

function captureIo(): { io: CliIo; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      stdout: (message) => stdout.push(message),
      stderr: (message) => stderr.push(message),
    },
  };
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

async function readAuditLog(home: string): Promise<AuditEntry[]> {
  const raw = await readFile(join(home, "audit.log"), "utf8");
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as AuditEntry);
}

/** A home with the wallet `main`, created without reaching a real RPC. */
async function initializedHome(prefix: string): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), prefix));
  homes.push(home);
  process.env.VAPI_HOME = home;
  process.env.VAPI_KEYSTORE_PASSWORD = "test-only-passphrase";
  delete process.env.VAPI_API_KEY;
  expect(
    await runCli(["init", "--json"], captureIo().io, { ...AGENT, fetchImpl: zeroBalanceRpc() }),
  ).toBe(0);
  return home;
}

function zeroBalanceRpc() {
  return vi.fn<typeof fetch>(async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as { id: number; method: string };
    return Response.json({
      jsonrpc: "2.0",
      id: request.id,
      result: request.method === "eth_call" ? `0x${"0".repeat(64)}` : "0x0",
    });
  });
}
