import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  assertMaxPrice,
  ARC_MAINNET_CAIP2,
  BASE_MAINNET_CAIP2,
  BROWSER_ENABLED_X402_NETWORK_CONFIG,
  buildCompatibleX402Payment,
  buildEip3009TypedData,
  buildX402Payment,
  classifySettlement,
  createPaymentId,
  isValidPaymentId,
  isSvmPaymentRequirements,
  parse402Challenge,
  parse402Response,
  parseSettlementResponse,
  X402Error,
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
    expect(decodePaymentSignature(payment.headers["PAYMENT-SIGNATURE"]).extensions).toEqual({
      "builder-code": { info: { s: ["vapi"] } },
    });
    expect(payment.paymentId).toBeUndefined();
  });

  it("normalizes builder-code while preserving other server extensions", async () => {
    const valid = await buildPaymentWithExtensions({
      bazaar: { info: { input: "weather" } },
      "builder-code": {
        info: {
          a: "weather_app",
          s: [
            "server_one",
            "vapi",
            "INVALID-CODE",
            "server_one",
            "server_two",
            "server_three",
            "server_four",
            "server_five",
            "server_six",
          ],
          w: "must-not-echo",
        },
        schema: { type: "object" },
      },
    });
    const validExtensions = decodePaymentSignature(valid.headers["PAYMENT-SIGNATURE"]).extensions;
    expect(validExtensions).toEqual({
      bazaar: { info: { input: "weather" } },
      "builder-code": {
        info: {
          a: "weather_app",
          s: ["vapi", "server_one", "server_two", "server_three", "server_four", "server_five"],
        },
        schema: { type: "object" },
      },
    });
    expect(
      (validExtensions?.["builder-code"] as { info: Record<string, unknown> }).info,
    ).not.toHaveProperty("w");

    const invalid = await buildPaymentWithExtensions({
      "builder-code": { info: { a: "Invalid app", s: "server_code" } },
    });
    expect(decodePaymentSignature(invalid.headers["PAYMENT-SIGNATURE"]).extensions).toEqual({
      "builder-code": { info: { s: ["vapi", "server_code"] } },
    });
  });

  it("adds an advertised payment-identifier and reuses a supplied id", async () => {
    const paymentId = createPaymentId((bytes) => bytes.fill(0xab));
    expect(paymentId).toBe(`pay_${"ab".repeat(16)}`);
    expect(isValidPaymentId(paymentId)).toBe(true);
    const extensions = {
      bazaar: { info: { input: "weather" } },
      "payment-identifier": {
        info: { required: true, purpose: "dedupe" },
        schema: { type: "object", required: ["id"] },
      },
    };

    const first = await buildPaymentWithExtensions(extensions, paymentId);
    const second = await buildPaymentWithExtensions(extensions, paymentId);
    for (const payment of [first, second]) {
      const sent = decodePaymentSignature(payment.headers["PAYMENT-SIGNATURE"]);
      expect(payment.paymentId).toBe(paymentId);
      expect(sent.extensions).toEqual({
        bazaar: { info: { input: "weather" } },
        "builder-code": { info: { s: ["vapi"] } },
        "payment-identifier": {
          schema: { type: "object", required: ["id"] },
          info: { required: true, purpose: "dedupe", id: paymentId },
        },
      });
    }
  });

  it("includes payment extensions in the compatibility header", async () => {
    const paymentId = `pay_${"cd".repeat(16)}`;
    const quote = parse402Challenge(
      {
        ...exactChallenge({}),
        extensions: {
          "builder-code": { info: { a: "weather_app" }, schema: { type: "object" } },
          "payment-identifier": {
            info: { required: true },
            schema: { type: "object", required: ["id"] },
          },
        },
      },
      networks,
    );

    const payment = await buildCompatibleX402Payment({
      account: { address: BUYER, signTypedData: async () => SIGNATURE },
      quote,
      nonce: NONCE,
      nowSeconds: 1_700_000_000,
      paymentId,
    });
    const canonical = decodePaymentSignature(payment.headers["PAYMENT-SIGNATURE"]);
    const compatible = JSON.parse(payment.headers["X-PAYMENT"]) as {
      extensions?: Record<string, unknown>;
    };

    expect(compatible.extensions).toEqual(canonical.extensions);
    expect(compatible.extensions).toMatchObject({
      "builder-code": { info: { a: "weather_app", s: ["vapi"] } },
      "payment-identifier": { info: { required: true, id: paymentId } },
    });
  });

  it("rejects a malformed supplied payment id only when payment-identifier is advertised", async () => {
    await expect(
      buildPaymentWithExtensions(
        {
          "payment-identifier": {
            info: { required: true },
            schema: { type: "object" },
          },
        },
        "bad id",
      ),
    ).rejects.toBeInstanceOf(X402Error);
    expect(isValidPaymentId("a".repeat(16))).toBe(true);
    expect(isValidPaymentId("a".repeat(128))).toBe(true);
    expect(isValidPaymentId("a".repeat(15))).toBe(false);
    expect(isValidPaymentId("a".repeat(129))).toBe(false);
    expect(isValidPaymentId("pay_not.valid".padEnd(16, "x"))).toBe(false);

    const withoutAdvertisement = await buildPaymentWithExtensions(undefined, "bad id");
    expect(withoutAdvertisement.paymentId).toBeUndefined();
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

  it("parses a 402 whose response was cloned first, without waiting on the tee", async () => {
    const challenge = exactChallenge({});
    const header = Buffer.from(JSON.stringify(challenge)).toString("base64");
    const response = new Response(JSON.stringify(challenge), {
      status: 402,
      headers: { "content-type": "application/json", "payment-required": header },
    });
    const clone = response.clone();

    const quote = await Promise.race([
      parse402Response(response, networks),
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error("parse402Response hung on a cloned body")), 2_000),
      ),
    ]);
    expect(quote.accepted.amount).toBeDefined();
    expect(clone.bodyUsed).toBe(false);
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

  it("keeps payment extensions when unrelated discovery metadata exceeds its limits", async () => {
    const challenge = exactChallenge({});
    const builderCode = {
      info: { a: "weather_app" },
      schema: { type: "object" },
    };
    const paymentIdentifier = {
      info: { required: true },
      schema: { type: "object", required: ["id"] },
    };
    challenge.extensions = {
      bazaar: { info: { examples: Array.from({ length: 65 }, (_, index) => index) } },
      "builder-code": builderCode,
      "payment-identifier": paymentIdentifier,
    };

    const quote = parse402Challenge(challenge, networks);
    expect(quote.extensions).toEqual({
      "builder-code": builderCode,
      "payment-identifier": paymentIdentifier,
    });

    const paymentId = `pay_${"ef".repeat(16)}`;
    const payment = await buildX402Payment({
      signer: { address: BUYER, signTypedData: async () => SIGNATURE },
      quote,
      nonce: NONCE,
      nowSeconds: 1_700_000_000,
      paymentId,
    });
    expect(decodePaymentSignature(payment.headers["PAYMENT-SIGNATURE"]).extensions).toMatchObject({
      "builder-code": { info: { a: "weather_app", s: ["vapi"] } },
      "payment-identifier": { info: { required: true, id: paymentId } },
    });
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

  it("accepts Arc mainnet's canonical USDC and rejects another asset", () => {
    const arcNetworks = { [ARC_MAINNET_CAIP2]: { usdc: ARC_USDC } };
    const quote = parse402Challenge(
      exactChallenge({
        network: ARC_MAINNET_CAIP2,
        asset: ARC_USDC,
        extra: { name: "USDC", version: "2" },
      }),
      arcNetworks,
    );
    expect(quote.accepted.extra).toMatchObject({ name: "USDC", version: "2" });
    expect(
      buildEip3009TypedData({
        from: BUYER,
        quote,
        nonce: NONCE,
        nowSeconds: 1_700_000_000,
      }).typedData.domain,
    ).toEqual({
      name: "USDC",
      version: "2",
      chainId: 5042,
      verifyingContract: ARC_USDC,
    });
    expect(() =>
      parse402Challenge(
        exactChallenge({
          network: ARC_MAINNET_CAIP2,
          asset: USDC,
          extra: { name: "USDC", version: "2" },
        }),
        arcNetworks,
      ),
    ).toThrow(/No exact x402 payment option matches/);
  });

  it("skips Circle Gateway's batched Arc offer and pays the plain EIP-3009 one", () => {
    // Shape of a live Arc 402 (api.exa.ai, 2026-09-23): the Gateway offer comes
    // first and needs a Gateway deposit, the EIP-3009 offer second.
    const arcNetworks = { [ARC_MAINNET_CAIP2]: { usdc: ARC_USDC } };
    const challenge = exactChallenge({
      network: ARC_MAINNET_CAIP2,
      asset: ARC_USDC,
      maxTimeoutSeconds: 3600,
      extra: {
        name: "GatewayWalletBatched",
        version: "1",
        verifyingContract: "0x77777777dcc4d5a8b6e418fd04d8997ef11000ee",
      },
    });
    challenge.accepts.push({
      ...challenge.accepts[0],
      extra: { assetTransferMethod: "eip3009", name: "USDC", version: "2" },
    });
    const quote = parse402Challenge(challenge, arcNetworks);
    expect(quote.accepted.extra).toMatchObject({ name: "USDC", version: "2" });
  });

  it("refuses an offer whose verifying contract is not the token", () => {
    const arcNetworks = { [ARC_MAINNET_CAIP2]: { usdc: ARC_USDC } };
    expect(() =>
      parse402Challenge(
        exactChallenge({
          network: ARC_MAINNET_CAIP2,
          asset: ARC_USDC,
          extra: {
            name: "USDC",
            version: "2",
            verifyingContract: "0x77777777dcc4d5a8b6e418fd04d8997ef11000ee",
          },
        }),
        arcNetworks,
      ),
    ).toThrow(/No exact x402 payment option matches/);
    expect(
      parse402Challenge(
        exactChallenge({
          network: ARC_MAINNET_CAIP2,
          asset: ARC_USDC,
          extra: { name: "USDC", version: "2", verifyingContract: ARC_USDC.toLowerCase() },
        }),
        arcNetworks,
      ).accepted.asset,
    ).toBe(ARC_USDC);
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

function decodePaymentSignature(value: string): {
  extensions?: Record<string, unknown>;
} {
  return JSON.parse(Buffer.from(value, "base64").toString("utf8")) as {
    extensions?: Record<string, unknown>;
  };
}

async function buildPaymentWithExtensions(
  extensions: Record<string, unknown> | undefined,
  paymentId?: string,
) {
  const quote = parse402Challenge(
    {
      ...exactChallenge({}),
      ...(extensions ? { extensions } : {}),
    },
    networks,
  );
  return await buildX402Payment({
    signer: { address: BUYER, signTypedData: async () => SIGNATURE },
    quote,
    nonce: NONCE,
    nowSeconds: 1_700_000_000,
    ...(paymentId ? { paymentId } : {}),
  });
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
