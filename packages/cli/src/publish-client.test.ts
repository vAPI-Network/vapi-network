import { describe, expect, it, vi } from "vitest";

import { privateKeyToAccount } from "viem/accounts";
import { verifyMessage, type Hex } from "viem";

import {
  apiKeyConsoleUrl,
  buildPayoutSiweMessage,
  createListingsClient,
  formatProbeSteps,
  listingsUrl,
  OriginClaimError,
  PAYOUT_STATEMENT,
  readProbeOperations,
  readProbeRejection,
  RegistryApiError,
  type ProbeOperation,
  type ProbeResult,
} from "./publish-client.js";

const BASE = "https://api.vapinetwork.ai";
const KEY = "vapi_sk_0123456789abcdefghij";
const PRIVATE_KEY = "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" as Hex;

type Reply = { status?: number; body?: unknown; headers?: Record<string, string> };

/** A registry that answers one canned reply, and records what it was asked. */
function registry(reply: Reply = { body: { ok: true } }) {
  const requests: { method: string; url: URL; headers: Headers; body: unknown }[] = [];
  const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    requests.push({
      method: init?.method ?? "GET",
      url,
      headers: new Headers(init?.headers as HeadersInit),
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    });
    return new Response(reply.body === undefined ? "" : JSON.stringify(reply.body), {
      status: reply.status ?? 200,
      headers: { "content-type": "application/json", ...reply.headers },
    });
  });
  return { fetchImpl, requests };
}

function client(reply?: Reply, baseUrl = BASE) {
  const { fetchImpl, requests } = registry(reply);
  return { requests, client: createListingsClient({ baseUrl, apiKey: KEY, fetchImpl }) };
}

describe("listingsUrl", () => {
  it("keeps a mount prefix and drops the query", () => {
    expect(listingsUrl(`${BASE}/`, "/api/call/listings").href).toBe(`${BASE}/api/call/listings`);
    expect(listingsUrl("https://registry.example/vapi?x=1", "/api/call/listings").href).toBe(
      "https://registry.example/vapi/api/call/listings",
    );
  });
});

describe("apiKeyConsoleUrl", () => {
  it.each([
    ["https://api.vapinetwork.ai", "https://api.vapinetwork.ai/connect?advanced=keys#api-keys"],
    ["https://api.vapinetwork.ai/", "https://api.vapinetwork.ai/connect?advanced=keys#api-keys"],
    ["https://example.test/vapi/", "https://example.test/vapi/connect?advanced=keys#api-keys"],
    [
      "https://api.vapinetwork.ai/?x=1#y",
      "https://api.vapinetwork.ai/connect?advanced=keys#api-keys",
    ],
  ])("builds the API keys link for %s", (base, expected) => {
    expect(apiKeyConsoleUrl(base).href).toBe(expected);
  });
});

describe("the listing write API", () => {
  it("sends the key as a bearer token on every route", async () => {
    const probe = client({ body: { operations: [] } });
    await probe.client.probe({ url: "https://weather.example", method: "POST", mode: "origin" });

    expect(probe.requests[0]?.method).toBe("POST");
    expect(probe.requests[0]?.url.pathname).toBe("/api/call/listings/probe");
    expect(probe.requests[0]?.headers.get("authorization")).toBe(`Bearer ${KEY}`);
    expect(probe.requests[0]?.headers.get("content-type")).toBe("application/json");
    expect(probe.requests[0]?.body).toEqual({
      url: "https://weather.example",
      method: "POST",
      mode: "origin",
    });
  });

  it("asks for a payout nonce by wallet", async () => {
    const nonce = client({ body: { nonce: "abcdef1234567890" } });
    await nonce.client.payoutNonce("0x1111111111111111111111111111111111111111");
    expect(nonce.requests[0]?.url.pathname).toBe("/api/call/listings/payout-nonce");
    expect(nonce.requests[0]?.url.searchParams.get("wallet")).toBe(
      "0x1111111111111111111111111111111111111111",
    );
  });

  it("creates a listing and moves its status", async () => {
    const created = client({ status: 201, body: { ok: true, listing: { slug: "weather" } } });
    const listing = await created.client.create({
      name: "Weather",
      description: "Forecasts.",
      category: "data",
      endpoints: [
        { name: "forecast", method: "GET", url: "https://weather.example/f", description: "f" },
      ],
      payoutWallet: "0x1111111111111111111111111111111111111111",
      siweMessage: "message",
      signature: "0xsig",
    });
    expect(listing).toEqual({ ok: true, listing: { slug: "weather" } });
    expect(created.requests[0]?.url.pathname).toBe("/api/call/listings");

    const status = client({ body: { ok: true, status: "active" } });
    await status.client.status("weather forecast", "activate");
    expect(status.requests[0]?.url.pathname).toBe("/api/call/listings/weather%20forecast/status");
    expect(status.requests[0]?.body).toEqual({ action: "activate" });

    const mine = client({ body: { listings: [] } });
    await mine.client.mine();
    expect(mine.requests[0]?.url.pathname).toBe("/api/call/listings/mine");
  });
});

describe("registry errors", () => {
  it("turns 401 into the sentence that names vapi auth set-key", async () => {
    const { client: listings } = client({ status: 401, body: { error: "unknown key" } });
    const error = await listings.mine().catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(RegistryApiError);
    expect((error as RegistryApiError).status).toBe(401);
    expect((error as Error).message).toContain("The vAPI API key was rejected.");
    expect((error as Error).message).toContain("unknown key");
    expect((error as Error).message).toContain(`${BASE}/connect?advanced=keys#api-keys`);
    expect((error as Error).message).toContain("vapi auth set-key");
  });

  it("passes a 409 refusal through in the registry's own words", async () => {
    const { client: listings } = client({
      status: 409,
      body: {
        error: {
          message:
            "Set every endpoint's payTo to your payout wallet before activating this listing.",
        },
      },
    });
    await expect(listings.status("weather", "activate")).rejects.toThrow(
      "Set every endpoint's payTo to your payout wallet before activating this listing.",
    );
  });

  it("lists the fields a 422 named", async () => {
    const { client: listings } = client({
      status: 422,
      body: {
        message: "Listing is invalid.",
        issues: [{ path: ["endpoints", 0, "url"], message: "must be https" }],
      },
    });
    const error = await listings
      .create({
        name: "n",
        description: "d",
        category: "ai",
        endpoints: [],
        payoutWallet: "0x1111111111111111111111111111111111111111",
        siweMessage: "m",
        signature: "0xs",
      })
      .catch((reason: unknown) => reason as Error);

    expect(error.message).toContain("vAPI rejected the listing as invalid.");
    expect(error.message).toContain("endpoints.0.url: must be https");
  });

  it("says how long a 429 asked us to wait", async () => {
    const { client: listings } = client({ status: 429, headers: { "retry-after": "30" } });
    await expect(listings.mine()).rejects.toThrow("Try again in 30 seconds.");
  });

  it("names the status of anything else", async () => {
    const { client: listings } = client({ status: 503, body: { error: "upstream down" } });
    await expect(listings.mine()).rejects.toThrow(
      "vAPI listings API returned HTTP 503. upstream down",
    );
  });
});

describe("an origin claim", () => {
  const ORIGIN = "https://weather.example";
  const ACCOUNT = "0x1111111111111111111111111111111111111111";
  const FILE = {
    url: `${ORIGIN}/.well-known/vapi.json`,
    content: { version: 1, account: ACCOUNT },
  };

  async function refusal(reply: Reply): Promise<OriginClaimError> {
    const { client: listings } = client(reply);
    const error = await listings.claimByOrigin(ORIGIN).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(OriginClaimError);
    return error as OriginClaimError;
  }

  it("posts the origin and the proof kind, with no nonce and no signature", async () => {
    const { client: listings, requests } = client({ body: { claimed: ["weather-forecast"] } });

    expect(await listings.claimByOrigin(ORIGIN)).toEqual({ claimed: ["weather-forecast"] });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe("POST");
    expect(requests[0]?.url.href).toBe(`${BASE}/api/call/listings/claim`);
    expect(requests[0]?.headers.get("authorization")).toBe(`Bearer ${KEY}`);
    expect(requests[0]?.body).toEqual({ origin: ORIGIN, proof: "well-known" });
  });

  it.each([
    ["origin_proof_unreadable", 422, "vAPI could not read the proof file"],
    ["origin_proof_mismatch", 403, "names another vAPI account"],
  ])("carries a valid %s file with the code", async (code, status, sentence) => {
    const error = await refusal({ status, body: { error: code, message: "m", file: FILE } });

    expect(error.code).toBe(code);
    expect(error.file).toEqual(FILE);
    expect(error.message).toContain(sentence);
    expect(error.message).toContain(FILE.url);
    expect(error.message).toContain(JSON.stringify(FILE.content, null, 2));
    expect(error.message).toContain("then run the same command again");
  });

  it.each([
    ["a URL for another host", { ...FILE, url: "https://evil.example/.well-known/vapi.json" }],
    ["a URL with another path", { ...FILE, url: `${ORIGIN}/vapi.json` }],
    ["an http URL", { ...FILE, url: "http://weather.example/.well-known/vapi.json" }],
    ["a URL with a query", { ...FILE, url: `${FILE.url}?x=1` }],
    ["another version", { ...FILE, content: { version: 2, account: ACCOUNT } }],
    ["an account that is not an address", { ...FILE, content: { version: 1, account: "acct" } }],
    ["no content", { url: FILE.url }],
  ])("drops a file with %s", async (_label, file) => {
    const error = await refusal({
      status: 422,
      body: { error: "origin_proof_unreadable", message: "m", file },
    });

    expect(error.code).toBe("origin_proof_unreadable");
    expect(error.file).toBeUndefined();
    expect(error.message).toContain("vAPI could not read the proof file");
    expect(error.message).not.toContain("evil.example");
    expect(error.message).not.toContain('"version"');
  });

  it.each([
    [422, "account_wallet_required", "This vAPI account has no wallet address"],
    [404, "no_listings", "vAPI has no unclaimed listing served from https://weather.example."],
    [
      409,
      "already_owned",
      "The listings served from https://weather.example already have an owner.",
    ],
    [422, "no_evm_payee", "do not pay one EVM address"],
  ])("turns a %s %s into a sentence", async (status, code, sentence) => {
    const error = await refusal({ status, body: { error: code, message: "registry detail" } });

    expect(error.code).toBe(code);
    expect(error.status).toBe(status);
    expect(error.message).toContain(sentence);
    expect(error.message).not.toContain("rejected the listing as invalid");
  });

  it("says an older registry does not support origin claims", async () => {
    const { client: listings } = client({
      status: 400,
      body: {
        error: "invalid_request",
        issues: [{ path: ["proof"], message: "Unrecognized key" }],
      },
    });
    const error = await listings.claimByOrigin(ORIGIN).catch((reason: unknown) => reason as Error);

    expect(error.message).toContain("does not support origin claims yet");
    expect(error.message).not.toContain("Unrecognized key");
  });

  it("adds the origin claim to the payee refusal of a signed claim", async () => {
    const { client: listings } = client({ status: 403, body: { error: "not_payee" } });
    const error = await listings
      .claim({ origin: ORIGIN, message: "m", signature: "0xs" })
      .catch((reason: unknown) => reason as Error);

    expect(error.message).toContain(
      "This wallet is not the payee of the listings served from https://weather.example.",
    );
    expect(error.message).toContain(
      "If the payee is a payment processor's address, run vapi claim https://weather.example --well-known.",
    );
  });
});

describe("the payout signature", () => {
  it("builds the canonical EIP-4361 message and the local key signs it", async () => {
    const account = privateKeyToAccount(PRIVATE_KEY);
    const message = buildPayoutSiweMessage({
      baseUrl: `${BASE}/`,
      address: account.address,
      nonce: "abcdef1234567890",
      issuedAt: "2026-09-21T10:00:00.000Z",
    });

    expect(message).toBe(
      [
        "api.vapinetwork.ai wants you to sign in with your Ethereum account:",
        account.address,
        "",
        PAYOUT_STATEMENT,
        "",
        `URI: ${BASE}`,
        "Version: 1",
        "Chain ID: 8453",
        "Nonce: abcdef1234567890",
        "Issued At: 2026-09-21T10:00:00.000Z",
      ].join("\n"),
    );

    const signature = await account.signMessage({ message });
    expect(await verifyMessage({ address: account.address, message, signature })).toBe(true);
  });

  it("binds the message to a self-hosted registry's own host", () => {
    const message = buildPayoutSiweMessage({
      baseUrl: "https://registry.example:8443/vapi",
      address: "0x9858EfFD232B4033E47d90003D41EC34EcaEda94",
      nonce: "abcdef1234567890",
      issuedAt: "2026-09-21T10:00:00.000Z",
    });

    expect(message).toContain("registry.example:8443 wants you to sign in");
    expect(message).toContain("URI: https://registry.example:8443");
  });
});

describe("reading a probe", () => {
  const probe: ProbeResult = {
    operations: [
      { name: "forecast", method: "get", url: "https://weather.example/f" },
      { name: "", url: "https://weather.example/nameless" },
      "not an operation" as unknown as { name: string },
    ],
    diagnostics: {
      steps: [
        "resolved https://weather.example",
        { name: "x402", status: "ok", detail: "402 with one accept" },
        { step: "schema", ok: false },
      ],
      rejection: null,
    },
  };

  it("keeps only the operations that carry a name", () => {
    expect(readProbeOperations(probe).map((operation) => operation.name)).toEqual(["forecast"]);
    expect(readProbeOperations({})).toEqual([]);
  });

  it("reads a single payable endpoint the registry answers in `endpoint`", () => {
    const endpoint = {
      name: "GET weather.example/f",
      method: "GET",
      url: "https://weather.example/f",
    };
    expect(readProbeOperations({ endpoint, operations: [] })).toEqual([endpoint]);
    expect(
      readProbeOperations({
        endpoint: { url: "https://weather.example/f" } as unknown as ProbeOperation,
      }),
    ).toEqual([]);
    expect(
      readProbeOperations({ endpoint, operations: [{ name: "forecast" }] }).map(
        (operation) => operation.name,
      ),
    ).toEqual(["forecast"]);
  });

  it("formats whatever shape the steps arrive in", () => {
    expect(formatProbeSteps(probe)).toEqual([
      "  resolved https://weather.example",
      "  x402 — ok — 402 with one accept",
      "  schema — failed",
    ]);
  });

  it("reads a rejection only when there is one", () => {
    expect(readProbeRejection(probe)).toBeUndefined();
    expect(readProbeRejection({ diagnostics: { rejection: { code: "no_x402" } } })).toEqual({
      code: "no_x402",
    });
  });
});
