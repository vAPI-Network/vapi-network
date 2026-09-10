import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { getAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import {
  ARC_TESTNET_CAIP2,
  BASE_MAINNET_CAIP2,
  NETWORKS,
  getDefaultConfig,
} from "@vapi-network/core";
import { callService } from "./tools/call.js";
import {
  buildEip3009TypedData,
  buildX402Payment,
  parse402Challenge,
  parse402Response,
  parseSettlementResponse,
  type X402Quote,
} from "./x402.js";

const PAY_TO = getAddress("0x1111111111111111111111111111111111111111");
const PRIVATE_KEY = "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" as Hex;
const NONCE = `0x${"11".repeat(32)}` as Hex;
const temporaryDirectories: string[] = [];

type X402ContractFixtures = {
  version: number;
  challengeEnvelopes: Array<{
    name: string;
    transport: {
      kind: "header" | "body";
      header?: string;
      contentType?: string;
      encoding: "base64-json" | "json";
    };
    challenge: Record<string, unknown>;
  }>;
  paymentEnvelopes: Array<{
    name: string;
    header: "PAYMENT-SIGNATURE" | "X-PAYMENT";
    encoding: "base64-json" | "json";
    payload: unknown;
  }>;
  settlementEnvelopes: Array<{
    name: string;
    header: "PAYMENT-RESPONSE" | "X-PAYMENT-RESPONSE";
    encoding: "base64-json" | "json";
    payload: unknown;
  }>;
};

const x402Fixtures = JSON.parse(
  readFileSync(new URL("../../core/test/fixtures/x402-fixtures.json", import.meta.url), "utf8"),
) as X402ContractFixtures;

function fixtureByName<T extends { name: string }>(fixtures: T[], name: string): T {
  const fixture = fixtures.find((candidate) => candidate.name === name);
  if (!fixture) {
    throw new Error(`Missing x402 fixture ${name}.`);
  }
  return fixture;
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function challenge() {
  const config = getDefaultConfig();
  return {
    x402Version: 2,
    resource: {
      url: "https://vendor.example/paid",
      description: "Fixture endpoint",
      mimeType: "application/json",
    },
    accepts: [
      {
        scheme: "exact",
        network: "eip155:999999",
        amount: "1",
        asset: "0x2222222222222222222222222222222222222222",
        payTo: PAY_TO,
        maxTimeoutSeconds: 60,
        extra: { name: "USD Coin", version: "2" },
      },
      {
        scheme: "exact",
        network: BASE_MAINNET_CAIP2,
        amount: "2500",
        asset: config.networks[BASE_MAINNET_CAIP2]!.usdc,
        payTo: PAY_TO,
        maxTimeoutSeconds: 60,
        extra: { name: "USD Coin", version: "2" },
      },
    ],
  };
}

function arcChallenge() {
  return {
    x402Version: 2,
    resource: {
      url: "https://vendor.example/paid",
      description: "Arc fixture endpoint",
      mimeType: "application/json",
    },
    accepts: [
      {
        scheme: "exact",
        network: ARC_TESTNET_CAIP2,
        amount: "2000",
        asset: NETWORKS[ARC_TESTNET_CAIP2].usdc,
        payTo: PAY_TO,
        maxTimeoutSeconds: 60,
        extra: { name: "USDC", version: "2" },
      },
    ],
  };
}

describe("x402 v2 challenge parsing", () => {
  it("parses the shared official-header and legacy-body challenge fixtures", async () => {
    for (const name of ["exact-v2-payment-required", "legacy-body-challenge"]) {
      const fixture = fixtureByName(x402Fixtures.challengeEnvelopes, name);
      const response =
        fixture.transport.kind === "header"
          ? new Response(null, {
              status: 402,
              headers: {
                [fixture.transport.header ?? "PAYMENT-REQUIRED"]: Buffer.from(
                  JSON.stringify(fixture.challenge),
                  "utf8",
                ).toString("base64"),
              },
            })
          : new Response(JSON.stringify(fixture.challenge), {
              status: 402,
              headers: { "content-type": fixture.transport.contentType ?? "application/json" },
            });

      const quote = await parse402Response(response, getDefaultConfig().networks);
      const accepts = fixture.challenge.accepts as Array<Record<string, unknown>>;
      const accepted = accepts[0]!;
      const resource = (fixture.challenge.resource ?? accepted.resource) as { url: string };

      expect(quote.amountAtomic).toBe(
        BigInt(String(accepted.amount ?? accepted.maxAmountRequired)),
      );
      expect(quote.resource.url).toBe(resource.url);
      expect(quote.accepted.scheme).toBe("exact");
    }
  });

  it("keeps the shared upto requirement Go-upstream-only", async () => {
    const fixture = fixtureByName(x402Fixtures.challengeEnvelopes, "upto-v2-payment-required");
    const response = new Response(null, {
      status: 402,
      headers: {
        "payment-required": Buffer.from(JSON.stringify(fixture.challenge), "utf8").toString(
          "base64",
        ),
      },
    });

    await expect(parse402Response(response, getDefaultConfig().networks)).rejects.toThrow(
      "No exact x402 payment option matches",
    );
  });

  it("configures Base only by default and adds Arc only with a nonblank RPC", () => {
    vi.stubEnv("ARC_TESTNET_RPC_URL", "   ");
    expect(getDefaultConfig().networks[ARC_TESTNET_CAIP2]).toBeUndefined();

    vi.stubEnv("ARC_TESTNET_RPC_URL", "https://arc-rpc.example");
    expect(getDefaultConfig().networks[ARC_TESTNET_CAIP2]).toMatchObject({
      rpcUrl: "https://arc-rpc.example",
      usdc: NETWORKS[ARC_TESTNET_CAIP2].usdc,
    });
  });

  it("selects an Arc offer when Arc is explicitly configured", async () => {
    vi.stubEnv("ARC_TESTNET_RPC_URL", "https://arc-rpc.example");
    const response = new Response(JSON.stringify(arcChallenge()), {
      status: 402,
      headers: { "content-type": "application/json" },
    });

    const quote = await parse402Response(response, getDefaultConfig().networks);

    expect(quote.accepted.network).toBe(ARC_TESTNET_CAIP2);
  });

  it("requires a locally pinned token domain for a custom configured network", () => {
    const config = getDefaultConfig();
    const customNetwork = "eip155:31337";
    const customAsset = getAddress("0x3333333333333333333333333333333333333333");
    config.networks[customNetwork] = {
      rpcUrl: "https://rpc.example",
      usdc: customAsset,
      eip712Domain: { name: "Custom USDC", version: "1" },
    };

    const quote = parse402Challenge(
      {
        x402Version: 2,
        resource: { url: "https://vendor.example/custom" },
        accepts: [
          {
            scheme: "exact",
            network: customNetwork,
            amount: "1",
            asset: customAsset,
            payTo: PAY_TO,
            maxTimeoutSeconds: 60,
            extra: { name: "Custom USDC", version: "1" },
          },
        ],
      },
      config.networks,
    );

    expect(quote.accepted.extra).toMatchObject({ name: "Custom USDC", version: "1" });
  });

  it("does not select an Arc offer from a legacy config entry with a blank RPC", async () => {
    const config = getDefaultConfig();
    config.networks[ARC_TESTNET_CAIP2] = {
      rpcUrl: "   ",
      usdc: NETWORKS[ARC_TESTNET_CAIP2].usdc,
    };
    const response = new Response(JSON.stringify(arcChallenge()), {
      status: 402,
      headers: { "content-type": "application/json" },
    });

    await expect(parse402Response(response, config.networks)).rejects.toThrow(
      "No exact x402 payment option matches a configured network",
    );
  });

  it("parses a base64 payment-required header and selects a configured exact network", async () => {
    const encoded = Buffer.from(JSON.stringify(challenge()), "utf8").toString("base64");
    const response = new Response(null, {
      status: 402,
      headers: { "payment-required": encoded },
    });

    const quote = await parse402Response(response, getDefaultConfig().networks);

    expect(quote.accepted.network).toBe(BASE_MAINNET_CAIP2);
    expect(quote.amountAtomic).toBe(2500n);
    expect(quote.accepted.scheme).toBe("exact");
  });

  it("parses the JSON body accepts[] fallback", async () => {
    const response = new Response(JSON.stringify(challenge()), {
      status: 402,
      headers: { "content-type": "application/json" },
    });

    const quote = await parse402Response(response, getDefaultConfig().networks);

    expect(quote.resource.url).toBe("https://vendor.example/paid");
    expect(quote.accepted.payTo).toBe(PAY_TO);
  });

  it("rejects a quote above the cap before signing", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vapi-mcp-call-"));
    temporaryDirectories.push(directory);
    const config = getDefaultConfig();
    config.spendCaps = { perCallAtomic: "2499", perDayAtomic: "10000" };
    const account = privateKeyToAccount(PRIVATE_KEY);
    const signSpy = vi.spyOn(account, "signTypedData");
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify(challenge()), {
          status: 402,
          headers: { "content-type": "application/json" },
        }),
    ) as unknown as typeof fetch;

    await expect(
      callService({
        input: { url: "https://vendor.example/paid", body: { prompt: "hello" } },
        account,
        config,
        fetchImpl,
        lookup: async () => ["93.184.216.34"],
        ledgerPath: join(directory, "ledger.json"),
      }),
    ).rejects.toThrow("exceeds the per-call cap");
    expect(signSpy).not.toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("rejects an unconfigured required network before requesting or signing", async () => {
    vi.stubEnv("ARC_TESTNET_RPC_URL", "");
    const config = getDefaultConfig();
    const account = privateKeyToAccount(PRIVATE_KEY);
    const signSpy = vi.spyOn(account, "signTypedData");
    const fetchImpl = vi.fn() as unknown as typeof fetch;

    await expect(
      callService({
        input: { url: "https://vendor.example/paid", network: ARC_TESTNET_CAIP2 },
        account,
        config,
        fetchImpl,
      }),
    ).rejects.toThrow(`Network ${ARC_TESTNET_CAIP2} is not configured`);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(signSpy).not.toHaveBeenCalled();
  });

  it("rejects a redirect to a private destination before fetching it", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: "https://127.0.0.1/private" },
      }),
    );

    await expect(
      callService({
        input: { url: "https://93.184.216.34/redirect" },
        account: privateKeyToAccount(PRIVATE_KEY),
        config: getDefaultConfig(),
        fetchImpl,
      }),
    ).rejects.toThrow(/allowPrivateNetwork true/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does not sign an Arc offer when the call requires Base", async () => {
    const config = getDefaultConfig();
    config.networks[ARC_TESTNET_CAIP2] = {
      rpcUrl: "https://arc-rpc.example",
      usdc: NETWORKS[ARC_TESTNET_CAIP2].usdc,
    };
    const account = privateKeyToAccount(PRIVATE_KEY);
    const signSpy = vi.spyOn(account, "signTypedData");
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify(arcChallenge()), {
          status: 402,
          headers: { "content-type": "application/json" },
        }),
    ) as unknown as typeof fetch;

    await expect(
      callService({
        input: {
          url: "https://vendor.example/paid",
          network: BASE_MAINNET_CAIP2,
        },
        account,
        config,
        fetchImpl,
        lookup: async () => ["93.184.216.34"],
      }),
    ).rejects.toThrow(`required network ${BASE_MAINNET_CAIP2}`);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(signSpy).not.toHaveBeenCalled();
  });

  it("returns the raw vAPI payment proof with the paid call result", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vapi-mcp-call-"));
    temporaryDirectories.push(directory);
    const config = getDefaultConfig();
    const account = privateKeyToAccount(PRIVATE_KEY);
    const proof = Buffer.from(
      JSON.stringify({ version: 1, txHash: `0x${"22".repeat(32)}`, signature: "0xsigned" }),
      "utf8",
    ).toString("base64");
    const settlement = { success: true, transaction: `0x${"33".repeat(32)}` };
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(challenge()), {
          status: 402,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ echoed: true }), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "payment-response": Buffer.from(JSON.stringify(settlement), "utf8").toString("base64"),
            "x-vapi-payment-proof": proof,
          },
        }),
      ) as unknown as typeof fetch;

    const result = await callService({
      input: { url: "https://vendor.example/paid", body: { prompt: "hello" } },
      account,
      config,
      fetchImpl,
      lookup: async () => ["93.184.216.34"],
      ledgerPath: join(directory, "ledger.json"),
    });

    expect(result).toMatchObject({
      status: 200,
      body: { echoed: true },
      payment: {
        network: BASE_MAINNET_CAIP2,
        amountAtomic: "2500",
        settlement,
        proof,
      },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it.each([403, 500])(
    "treats a paid HTTP %s without settlement evidence as ambiguous",
    async (status) => {
      const directory = await mkdtemp(join(tmpdir(), "vapi-mcp-call-"));
      temporaryDirectories.push(directory);
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify(challenge()), {
            status: 402,
            headers: { "content-type": "application/json" },
          }),
        )
        .mockResolvedValueOnce(
          new Response("provider failed", { status }),
        ) as unknown as typeof fetch;

      await expect(
        callService({
          input: { url: "https://vendor.example/paid" },
          account: privateKeyToAccount(PRIVATE_KEY),
          config: getDefaultConfig(),
          fetchImpl,
          lookup: async () => ["93.184.216.34"],
          ledgerPath: join(directory, "ledger.json"),
        }),
      ).rejects.toMatchObject({
        code: "settlement_unknown",
        possibleSettlement: expect.objectContaining({ amountAtomic: "2500", payTo: PAY_TO }),
      });
    },
  );

  it.each([200, 402, 500])(
    "reports a decisive rejected settlement from paid HTTP %s",
    async (status) => {
      const directory = await mkdtemp(join(tmpdir(), "vapi-mcp-call-"));
      temporaryDirectories.push(directory);
      const rejection = { success: false, error: "settlement rejected" };
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify(challenge()), {
            status: 402,
            headers: { "content-type": "application/json" },
          }),
        )
        .mockResolvedValueOnce(
          new Response("provider failed", {
            status,
            headers: {
              "payment-response": Buffer.from(JSON.stringify(rejection), "utf8").toString("base64"),
            },
          }),
        ) as unknown as typeof fetch;

      await expect(
        callService({
          input: { url: "https://vendor.example/paid" },
          account: privateKeyToAccount(PRIVATE_KEY),
          config: getDefaultConfig(),
          fetchImpl,
          lookup: async () => ["93.184.216.34"],
          ledgerPath: join(directory, "ledger.json"),
        }),
      ).rejects.toMatchObject({
        code: "payment_rejected",
        possibleSettlement: undefined,
        paymentRejection: { httpStatus: status, receipt: rejection },
      });
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    },
  );

  it("returns a failed API response when its receipt proves settlement succeeded", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vapi-mcp-call-"));
    temporaryDirectories.push(directory);
    const settlement = { success: true, transaction: `0x${"44".repeat(32)}` };
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(challenge()), {
          status: 402,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response("provider failed", {
          status: 500,
          headers: {
            "payment-response": Buffer.from(JSON.stringify(settlement), "utf8").toString("base64"),
          },
        }),
      ) as unknown as typeof fetch;

    await expect(
      callService({
        input: { url: "https://vendor.example/paid" },
        account: privateKeyToAccount(PRIVATE_KEY),
        config: getDefaultConfig(),
        fetchImpl,
        lookup: async () => ["93.184.216.34"],
        ledgerPath: join(directory, "ledger.json"),
      }),
    ).resolves.toMatchObject({
      status: 500,
      body: "provider failed",
      payment: { settlement },
    });
  });

  it("returns a paid HTTP 402 response when its receipt proves settlement succeeded", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vapi-mcp-call-"));
    temporaryDirectories.push(directory);
    const settlement = { success: true, transaction: `0x${"55".repeat(32)}` };
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(challenge()), {
          status: 402,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response("provider returned payment required", {
          status: 402,
          headers: {
            "payment-response": Buffer.from(JSON.stringify(settlement), "utf8").toString("base64"),
          },
        }),
      ) as unknown as typeof fetch;

    await expect(
      callService({
        input: { url: "https://vendor.example/paid" },
        account: privateKeyToAccount(PRIVATE_KEY),
        config: getDefaultConfig(),
        fetchImpl,
        lookup: async () => ["93.184.216.34"],
        ledgerPath: join(directory, "ledger.json"),
      }),
    ).resolves.toMatchObject({
      status: 402,
      body: "provider returned payment required",
      payment: { settlement },
    });
  });

  it("returns a paid redirect without following it when settlement succeeded", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vapi-mcp-call-"));
    temporaryDirectories.push(directory);
    const settlement = { success: true, transaction: `0x${"88".repeat(32)}` };
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(challenge()), {
          status: 402,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response("use another endpoint", {
          status: 302,
          headers: {
            location: "https://127.0.0.1/private",
            "payment-response": Buffer.from(JSON.stringify(settlement), "utf8").toString("base64"),
          },
        }),
      ) as unknown as typeof fetch;

    await expect(
      callService({
        input: { url: "https://vendor.example/paid" },
        account: privateKeyToAccount(PRIVATE_KEY),
        config: getDefaultConfig(),
        fetchImpl,
        lookup: async () => ["93.184.216.34"],
        ledgerPath: join(directory, "ledger.json"),
      }),
    ).resolves.toMatchObject({
      status: 302,
      body: "use another endpoint",
      payment: { settlement },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it.each(["unreadable", "oversize"] as const)(
    "reports a confirmed settlement separately from an %s paid response body",
    async (failure) => {
      const directory = await mkdtemp(join(tmpdir(), "vapi-mcp-call-"));
      temporaryDirectories.push(directory);
      const settlement = { success: true, transaction: `0x${"66".repeat(32)}` };
      const headers = new Headers({
        "payment-response": Buffer.from(JSON.stringify(settlement), "utf8").toString("base64"),
      });
      const body =
        failure === "unreadable"
          ? new ReadableStream<Uint8Array>({
              start(controller) {
                controller.error(new Error("provider body failed"));
              },
            })
          : "provider body exceeds its declared display size";
      if (failure === "oversize") {
        headers.set("content-length", "1048577");
      }
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify(challenge()), {
            status: 402,
            headers: { "content-type": "application/json" },
          }),
        )
        .mockResolvedValueOnce(
          new Response(body, { status: 200, headers }),
        ) as unknown as typeof fetch;

      await expect(
        callService({
          input: { url: "https://vendor.example/paid" },
          account: privateKeyToAccount(PRIVATE_KEY),
          config: getDefaultConfig(),
          fetchImpl,
          lookup: async () => ["93.184.216.34"],
          ledgerPath: join(directory, "ledger.json"),
        }),
      ).rejects.toMatchObject({
        code: "response_unreadable",
        possibleSettlement: undefined,
        paymentRejection: undefined,
        confirmedSettlement: { httpStatus: 200, receipt: settlement },
      });
    },
  );

  it("times out an unreadable paid body as an ambiguous settlement", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vapi-mcp-call-"));
    temporaryDirectories.push(directory);
    const neverEndingBody = new ReadableStream<Uint8Array>({ pull() {} });
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(challenge()), {
          status: 402,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(neverEndingBody, { status: 200 }),
      ) as unknown as typeof fetch;

    await expect(
      callService({
        input: { url: "https://vendor.example/paid" },
        account: privateKeyToAccount(PRIVATE_KEY),
        config: getDefaultConfig(),
        fetchImpl,
        lookup: async () => ["93.184.216.34"],
        ledgerPath: join(directory, "ledger.json"),
        timeoutMs: 20,
      }),
    ).rejects.toMatchObject({ code: "settlement_unknown" });
  });
});

describe("EIP-3009 exact payment construction", () => {
  it("emits the official v2 and stable Agent Cash compatibility envelopes", async () => {
    const challengeFixture = fixtureByName(
      x402Fixtures.challengeEnvelopes,
      "exact-v2-payment-required",
    );
    const officialFixture = fixtureByName(
      x402Fixtures.paymentEnvelopes,
      "exact-v2-payment-signature",
    );
    const legacyFixture = fixtureByName(x402Fixtures.paymentEnvelopes, "legacy-x-payment");
    const quote = parse402Challenge(challengeFixture.challenge, getDefaultConfig().networks);
    const account = privateKeyToAccount(PRIVATE_KEY);

    const payment = await buildX402Payment({
      account,
      quote,
      nonce: NONCE,
      nowSeconds: 1_700_000_000,
    });

    expect(payment.payload).toEqual(officialFixture.payload);
    expect(JSON.parse(payment.headers[legacyFixture.header])).toEqual(legacyFixture.payload);
  });

  it("constructs and signs the expected typed data fixture", async () => {
    const config = getDefaultConfig();
    const parsedResponse = new Response(JSON.stringify(challenge()), { status: 402 });
    const quote: X402Quote = await parse402Response(parsedResponse, config.networks);
    const account = privateKeyToAccount(PRIVATE_KEY);
    const fixture = buildEip3009TypedData({
      from: account.address,
      quote,
      nonce: NONCE,
      nowSeconds: 1_700_000_000,
    });

    expect(fixture.typedData.domain).toEqual({
      name: "USD Coin",
      version: "2",
      chainId: 8453,
      verifyingContract: config.networks[BASE_MAINNET_CAIP2]!.usdc,
    });
    expect(fixture.typedData.types.TransferWithAuthorization).toEqual([
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" },
      { name: "nonce", type: "bytes32" },
    ]);
    expect(fixture.typedData.message).toEqual({
      from: account.address,
      to: PAY_TO,
      value: 2500n,
      validAfter: 0n,
      validBefore: 1_700_000_060n,
      nonce: NONCE,
    });

    const payment = await buildX402Payment({
      account,
      quote,
      nonce: NONCE,
      nowSeconds: 1_700_000_000,
    });
    expect(payment.payload.payload.signature).toMatch(/^0x[0-9a-f]{130}$/i);
    expect(payment.payload.payload.authorization).toEqual({
      from: account.address,
      to: PAY_TO,
      value: "2500",
      validAfter: "0",
      validBefore: "1700000060",
      nonce: NONCE,
    });
    const canonical = JSON.parse(
      Buffer.from(payment.headers["PAYMENT-SIGNATURE"], "base64").toString("utf8"),
    ) as { x402Version: number; accepted: { network: string } };
    expect(canonical).toMatchObject({
      x402Version: 2,
      accepted: { network: BASE_MAINNET_CAIP2 },
    });
  });

  it("does not extend a short provider authorization window", () => {
    const config = getDefaultConfig();
    const paymentChallenge = challenge();
    paymentChallenge.accepts[1]!.maxTimeoutSeconds = 30;
    const quote = parse402Challenge(paymentChallenge, config.networks);
    const account = privateKeyToAccount(PRIVATE_KEY);

    const fixture = buildEip3009TypedData({
      from: account.address,
      quote,
      nonce: NONCE,
      nowSeconds: 1_700_000_000,
    });

    expect(fixture.authorization.validBefore).toBe("1700000030");
  });

  it("honors the advertised authorization window", () => {
    const config = getDefaultConfig();
    const paymentChallenge = challenge();
    paymentChallenge.accepts[1]!.maxTimeoutSeconds = 120;
    const quote = parse402Challenge(paymentChallenge, config.networks);
    const account = privateKeyToAccount(PRIVATE_KEY);

    const fixture = buildEip3009TypedData({
      from: account.address,
      quote,
      nonce: NONCE,
      nowSeconds: 1_700_000_000,
    });

    expect(fixture.authorization.validBefore).toBe("1700000120");
  });

  it("applies the 600-second authorization window ceiling", () => {
    const config = getDefaultConfig();
    const paymentChallenge = challenge();
    paymentChallenge.accepts[1]!.maxTimeoutSeconds = 9_999;
    const quote = parse402Challenge(paymentChallenge, config.networks);
    const account = privateKeyToAccount(PRIVATE_KEY);

    const fixture = buildEip3009TypedData({
      from: account.address,
      quote,
      nonce: NONCE,
      nowSeconds: 1_700_000_000,
    });

    expect(fixture.authorization.validBefore).toBe("1700000600");
  });
});

describe("x402 settlement compatibility", () => {
  it("parses both shared settlement-header spellings", () => {
    for (const fixture of x402Fixtures.settlementEnvelopes) {
      const encoded =
        fixture.encoding === "base64-json"
          ? Buffer.from(JSON.stringify(fixture.payload), "utf8").toString("base64")
          : JSON.stringify(fixture.payload);

      expect(parseSettlementResponse(new Headers({ [fixture.header]: encoded }))).toEqual(
        fixture.payload,
      );
    }
  });
});
