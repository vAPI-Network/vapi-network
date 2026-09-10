import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  assertMaxPrice,
  BASE_MAINNET_CAIP2,
  BROWSER_ENABLED_X402_NETWORK_CONFIG,
  buildEip3009TypedData,
  buildX402Payment,
  classifySettlement,
  isSvmPaymentRequirements,
  parse402Challenge,
  parse402Response,
  parseSettlementResponse,
} from "./x402.js";
import {
  SOLANA_MAINNET_CAIP2,
  SOLANA_MAINNET_USDC,
  X402_SOLANA_MAINNET_CAIP2,
} from "./networks.js";

const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;
const ARC_USDC = "0x3600000000000000000000000000000000000000" as const;
const PAY_TO = "0x1111111111111111111111111111111111111111" as const;
const BUYER = "0xFCAd0B19bB29D4674531d6f115237E16AfCE377c" as const;
const NONCE = `0x${"11".repeat(32)}` as const;
const SIGNATURE = `0x${"22".repeat(65)}` as const;
const networks = { "eip155:8453": { usdc: USDC } };

const fixtures = JSON.parse(
  readFileSync(new URL("../test/fixtures/x402-fixtures.json", import.meta.url), "utf8"),
) as {
  challengeEnvelopes: Array<{ name: string; challenge: unknown }>;
  settlementEnvelopes: Array<{ name: string; header: string; payload: unknown }>;
};

describe("browser-neutral x402 client", () => {
  it("parses the shared exact-v2 fixture from challenge and HTTP response", async () => {
    const fixture = fixtures.challengeEnvelopes.find(
      (candidate) => candidate.name === "exact-v2-payment-required",
    )!;
    const quote = parse402Challenge(fixture.challenge, networks);
    expect(quote).toMatchObject({
      amountAtomic: 105n,
      accepted: { network: "eip155:8453", asset: USDC, payTo: PAY_TO },
    });

    const header = encodeBase64(fixture.challenge);
    const responseQuote = await parse402Response(
      new Response("", { status: 402, headers: { "payment-required": header } }),
      networks,
    );
    expect(responseQuote.amountAtomic).toBe(105n);
  });

  it("builds deterministic typed data and both v2 payment headers with an injected signer", async () => {
    const quote = parse402Challenge(
      fixtures.challengeEnvelopes.find(
        (candidate) => candidate.name === "exact-v2-payment-required",
      )!.challenge,
      networks,
    );
    const built = buildEip3009TypedData({
      from: BUYER,
      quote,
      nonce: NONCE,
      nowSeconds: 1_700_000_000,
    });
    expect(built.typedData.domain).toEqual({
      name: "USD Coin",
      version: "2",
      chainId: 8453,
      verifyingContract: USDC,
    });

    const payment = await buildX402Payment({
      signer: { address: BUYER, signTypedData: async () => SIGNATURE },
      quote,
      nonce: NONCE,
      nowSeconds: 1_700_000_000,
    });
    expect(payment.payload.payload).toHaveProperty("authorization");
    if (!("authorization" in payment.payload.payload)) throw new Error("Expected EVM payload.");
    expect(payment.payload.payload.authorization).toMatchObject({
      from: BUYER,
      to: PAY_TO,
      value: "105",
      nonce: NONCE,
    });
    expect(payment.headers["PAYMENT-SIGNATURE"]).toBeTruthy();
    expect(Object.keys(payment.headers)).toEqual(["PAYMENT-SIGNATURE"]);
  });

  it("does not extend authorization beyond a short provider timeout", () => {
    const parsed = parse402Challenge(
      fixtures.challengeEnvelopes.find(
        (candidate) => candidate.name === "exact-v2-payment-required",
      )!.challenge,
      networks,
    );
    const quote = {
      ...parsed,
      accepted: { ...parsed.accepted, maxTimeoutSeconds: 15 },
    };

    const built = buildEip3009TypedData({
      from: BUYER,
      quote,
      nonce: NONCE,
      nowSeconds: 1_700_000_000,
    });

    expect(built.authorization.validBefore).toBe("1700000015");
  });

  it("enforces the buyer cap and decodes settlement evidence", () => {
    expect(() => assertMaxPrice(1_000_001n, "1")).toThrow(/exceeds/);
    expect(() => assertMaxPrice(1_000_000n, "1")).not.toThrow();

    const settlement = fixtures.settlementEnvelopes.find(
      (candidate) => candidate.name === "canonical-payment-response",
    )!;
    const headers = new Headers({
      [settlement.header]: encodeBase64(settlement.payload),
    });
    expect(parseSettlementResponse(headers)).toEqual(settlement.payload);
    expect(classifySettlement({ success: true })).toBe("succeeded");
    expect(classifySettlement({ success: false })).toBe("rejected");
    expect(classifySettlement({ transaction: "0xabc" })).toBe("unknown");
    expect(classifySettlement(null)).toBe("unknown");
  });

  it("skips malformed supported options and can bind selection to an expected payee", () => {
    const valid = fixtures.challengeEnvelopes.find(
      (candidate) => candidate.name === "exact-v2-payment-required",
    )!.challenge as { accepts: Array<Record<string, unknown>>; [key: string]: unknown };
    const expected = "0x2222222222222222222222222222222222222222";
    const second = { ...valid.accepts[0], payTo: expected };
    const quote = parse402Challenge(
      {
        ...valid,
        accepts: [{ ...valid.accepts[0], maxTimeoutSeconds: undefined }, second],
      },
      networks,
      "",
      undefined,
      expected,
    );

    expect(quote.accepted.payTo).toBe(expected);
  });

  it("rejects a zero-value exact payment requirement", () => {
    expect(() => parse402Challenge(exactChallenge({ amount: "0" }), networks)).toThrow(
      /No exact x402 payment option matches/,
    );
  });

  it("rejects an exact payment amount above uint256", () => {
    expect(() =>
      parse402Challenge(exactChallenge({ amount: (1n << 256n).toString() }), networks),
    ).toThrow(/No exact x402 payment option matches/);
  });

  it("rejects a hostile oversized decimal amount", () => {
    expect(() =>
      parse402Challenge(exactChallenge({ amount: "9".repeat(100_000) }), networks),
    ).toThrow(/No exact x402 payment option matches/);
  });

  it.each([
    { name: "USDC", version: "2" },
    { name: "USD Coin", version: "1" },
  ])("rejects a non-canonical supported-token domain ($name/$version)", (extra) => {
    expect(() => parse402Challenge(exactChallenge({ extra }), networks)).toThrow(
      /No exact x402 payment option matches/,
    );
  });

  it("rejects deeply nested payment metadata", () => {
    expect(() =>
      parse402Challenge(
        exactChallenge({
          extra: {
            name: "USD Coin",
            version: "2",
            metadata: nestedMetadata(40),
          },
        }),
        networks,
      ),
    ).toThrow(/No exact x402 payment option matches/);
  });

  it("keeps realistic discovery extensions such as a Bazaar schema", () => {
    const challenge = exactChallenge({});
    challenge.extensions = {
      bazaar: { info: { input: { type: "http", method: "POST" } }, schema: nestedMetadata(12) },
    };

    expect(parse402Challenge(challenge, networks).extensions).toEqual(challenge.extensions);
  });

  it("drops challenge extensions that exceed the metadata limits instead of refusing to pay", () => {
    const challenge = exactChallenge({});
    challenge.extensions = { metadata: nestedMetadata(40) };

    const quote = parse402Challenge(challenge, networks);
    expect(quote.extensions).toBeUndefined();
    expect(quote.accepted.amount).toBeDefined();
  });

  it("rejects oversized payment metadata and challenge extensions", () => {
    expect(() =>
      parse402Challenge(
        exactChallenge({
          extra: { name: "USD Coin", version: "2", metadata: "x".repeat(16_385) },
        }),
        networks,
      ),
    ).toThrow(/No exact x402 payment option matches/);

    const challenge = exactChallenge({});
    challenge.extensions = { metadata: "x".repeat(16_385) };
    expect(parse402Challenge(challenge, networks).extensions).toBeUndefined();
  });

  it("uses the Arc USDC token's canonical domain", () => {
    const arcNetworks = { "eip155:5042002": { usdc: ARC_USDC } };
    const quote = parse402Challenge(
      exactChallenge({
        network: "eip155:5042002",
        asset: ARC_USDC,
        extra: { name: "USDC", version: "2" },
      }),
      arcNetworks,
    );

    expect(quote.accepted.extra).toMatchObject({ name: "USDC", version: "2" });
    expect(() =>
      parse402Challenge(
        exactChallenge({
          network: "eip155:5042002",
          asset: ARC_USDC,
          extra: { name: "USD Coin", version: "2" },
        }),
        arcNetworks,
      ),
    ).toThrow(/No exact x402 payment option matches/);
  });

  it("dispatches exact challenges by EVM versus Solana network namespace", () => {
    const quote = parse402Challenge(
      {
        x402Version: 2,
        resource: { url: "https://api.example/solana" },
        accepts: [
          {
            scheme: "exact",
            network: X402_SOLANA_MAINNET_CAIP2,
            amount: "2500",
            asset: SOLANA_MAINNET_USDC,
            payTo: "11111111111111111111111111111111",
            maxTimeoutSeconds: 60,
            extra: { feePayer: "SysvarRent111111111111111111111111111111111" },
          },
        ],
      },
      {
        [SOLANA_MAINNET_CAIP2]: {
          usdc: SOLANA_MAINNET_USDC,
          rpcUrl: "https://api.mainnet-beta.solana.com",
        },
      },
      "",
      SOLANA_MAINNET_CAIP2,
    );

    expect(isSvmPaymentRequirements(quote.accepted)).toBe(true);
    expect(quote).toMatchObject({
      amountAtomic: 2500n,
      accepted: {
        network: X402_SOLANA_MAINNET_CAIP2,
        asset: SOLANA_MAINNET_USDC,
        extra: { feePayer: "SysvarRent111111111111111111111111111111111" },
      },
      rpcUrl: "https://api.mainnet-beta.solana.com",
    });
  });

  it("rejects a configured override of a canonical network's token authority", () => {
    const mutableView = BROWSER_ENABLED_X402_NETWORK_CONFIG as Record<
      string,
      { usdc: string; eip712Domain: { name: string; version: string } }
    >;
    expect(() => {
      mutableView[BASE_MAINNET_CAIP2]!.usdc = PAY_TO;
    }).toThrow(TypeError);

    expect(() =>
      parse402Challenge(
        exactChallenge({
          asset: PAY_TO,
          extra: { name: "Attacker Coin", version: "99" },
        }),
        {
          [BASE_MAINNET_CAIP2]: {
            usdc: PAY_TO,
            eip712Domain: { name: "Attacker Coin", version: "99" },
          },
        },
      ),
    ).toThrow(/No exact x402 payment option matches/);
  });

  it("cancels an unused response body after accepting the payment-required header", async () => {
    const challenge = fixtures.challengeEnvelopes.find(
      (candidate) => candidate.name === "exact-v2-payment-required",
    )!.challenge;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array([1]));
      },
      cancel() {
        cancelled = true;
      },
    });

    await parse402Response(
      new Response(body, {
        status: 402,
        headers: { "payment-required": encodeBase64(challenge) },
      }),
      networks,
    );

    expect(cancelled).toBe(true);
  });

  it("cancels a chunked challenge body when it crosses the size bound", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(128 * 1024));
      },
      cancel() {
        cancelled = true;
      },
    });

    await expect(parse402Response(new Response(body, { status: 402 }), networks)).rejects.toThrow(
      /neither a valid payment-required header/,
    );
    expect(cancelled).toBe(true);
  });
});

function encodeBase64(value: unknown) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

function exactChallenge(overrides: Record<string, unknown>) {
  const fixture = fixtures.challengeEnvelopes.find(
    (candidate) => candidate.name === "exact-v2-payment-required",
  )!;
  const challenge = structuredClone(fixture.challenge) as {
    accepts: Array<Record<string, unknown>>;
    [key: string]: unknown;
  };
  challenge.accepts[0] = { ...challenge.accepts[0], ...overrides };
  return challenge;
}

function nestedMetadata(depth: number): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  let current = root;
  for (let index = 0; index < depth; index += 1) {
    const next: Record<string, unknown> = {};
    current.next = next;
    current = next;
  }
  return root;
}
