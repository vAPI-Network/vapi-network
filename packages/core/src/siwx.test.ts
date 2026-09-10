import { describe, expect, it, vi } from "vitest";
import type { Address, Hex } from "viem";

import {
  buildSIWxProof,
  createSIWxMessage,
  parseSIWxChallenge,
  parseSIWxResponse,
  type SIWxSigner,
} from "./siwx.js";

const ADDRESS = "0xFCAd0B19bB29D4674531d6f115237E16AfCE377c" as Address;
const SIGNATURE = `0x${"22".repeat(65)}` as Hex;
const NETWORKS = {
  "eip155:8453": {
    usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address,
  },
};
const RESPONSE_URL = "https://vendor.example/paid";

describe("Sign-In-With-X", () => {
  it("selects a configured EVM chain and builds the canonical personal-sign proof", async () => {
    const challenge = parseSIWxChallenge(paymentRequired(), NETWORKS, RESPONSE_URL);
    expect(challenge).not.toBeNull();
    const signMessage = vi.fn().mockResolvedValue(SIGNATURE);

    const proof = await buildSIWxProof({
      signer: { address: ADDRESS, signMessage } satisfies SIWxSigner,
      challenge: challenge!,
      responseUrl: RESPONSE_URL,
    });

    const expectedMessage = [
      "vendor.example wants you to sign in with your Ethereum account:",
      ADDRESS,
      "",
      "Sign in to view this resource",
      "",
      "URI: https://vendor.example/paid",
      "Version: 1",
      "Chain ID: 8453",
      "Nonce: abcdefgh",
      "Issued At: 2026-09-10T08:00:00.000Z",
      "Expiration Time: 2026-09-10T08:05:00.000Z",
      "Request ID: request-1",
      "Resources:",
      "- https://vendor.example/paid",
    ].join("\n");
    expect(createSIWxMessage(challenge!, ADDRESS)).toBe(expectedMessage);
    expect(signMessage).toHaveBeenCalledOnce();
    expect(signMessage).toHaveBeenCalledWith({ message: expectedMessage });
    expect(proof.payload).toEqual({
      domain: "vendor.example",
      address: ADDRESS,
      statement: "Sign in to view this resource",
      uri: RESPONSE_URL,
      version: "1",
      chainId: "eip155:8453",
      type: "eip191",
      nonce: "abcdefgh",
      issuedAt: "2026-09-10T08:00:00.000Z",
      expirationTime: "2026-09-10T08:05:00.000Z",
      requestId: "request-1",
      resources: [RESPONSE_URL],
      signatureScheme: "eip191",
      signature: SIGNATURE,
    });
    expect(
      JSON.parse(Buffer.from(proof.headers["SIGN-IN-WITH-X"], "base64").toString("utf8")),
    ).toEqual(proof.payload);
  });

  it("reads an auth-only accepts:[] challenge from PAYMENT-REQUIRED", async () => {
    const encoded = Buffer.from(JSON.stringify(paymentRequired()), "utf8").toString("base64");
    const parsed = await parseSIWxResponse(
      new Response(null, { status: 402, headers: { "payment-required": encoded } }),
      NETWORKS,
      RESPONSE_URL,
      "eip155:8453",
    );

    expect(parsed).toMatchObject({ chain: { chainId: "eip155:8453", type: "eip191" } });
  });

  it("refuses a different domain before requesting a signature", async () => {
    const hostile = paymentRequired();
    hostile.extensions["sign-in-with-x"].info.domain = "attacker.example";
    const signMessage = vi.fn().mockResolvedValue(SIGNATURE);

    expect(() => parseSIWxChallenge(hostile, NETWORKS, RESPONSE_URL)).toThrow(
      /does not match resource host.*Refusing to sign/,
    );

    const valid = parseSIWxChallenge(paymentRequired(), NETWORKS, RESPONSE_URL)!;
    await expect(
      buildSIWxProof({
        signer: { address: ADDRESS, signMessage },
        challenge: { ...valid, info: { ...valid.info, domain: "attacker.example" } },
        responseUrl: RESPONSE_URL,
      }),
    ).rejects.toThrow(/does not match resource host.*Refusing to sign/);
    expect(signMessage).not.toHaveBeenCalled();
  });

  it("refuses a different URI origin and unsupported chains", () => {
    const hostile = paymentRequired();
    hostile.extensions["sign-in-with-x"].info.uri = "https://attacker.example/paid";
    expect(() => parseSIWxChallenge(hostile, NETWORKS, RESPONSE_URL)).toThrow(
      /uri origin.*does not match resource origin/,
    );

    const unsupported = paymentRequired();
    unsupported.extensions["sign-in-with-x"].supportedChains = [
      { chainId: "solana:mainnet", type: "ed25519" },
    ];
    expect(() => parseSIWxChallenge(unsupported, NETWORKS, RESPONSE_URL)).toThrow(
      /No x402 SIWX chain matches a configured EVM network/,
    );
  });

  it("returns null for a normal payment challenge without SIWX", () => {
    expect(
      parseSIWxChallenge(
        { x402Version: 2, accepts: [{ network: "eip155:8453" }] },
        NETWORKS,
        RESPONSE_URL,
      ),
    ).toBeNull();
  });
});

function paymentRequired() {
  return {
    x402Version: 2,
    accepts: [],
    extensions: {
      "sign-in-with-x": {
        info: {
          domain: "vendor.example",
          uri: RESPONSE_URL,
          statement: "Sign in to view this resource",
          version: "1",
          nonce: "abcdefgh",
          issuedAt: "2026-09-10T08:00:00.000Z",
          expirationTime: "2026-09-10T08:05:00.000Z",
          requestId: "request-1",
          resources: [RESPONSE_URL],
        },
        supportedChains: [
          { chainId: "eip155:999999", type: "eip191" },
          { chainId: "eip155:8453", type: "eip191", signatureScheme: "eip191" },
        ],
        schema: { type: "object" },
      },
    },
  };
}
