import { createKeyPairSignerFromPrivateKeyBytes } from "@solana/kit";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { describe, expect, it, vi } from "vitest";

import { SOLANA_MAINNET_CAIP2, SOLANA_MAINNET_USDC } from "./networks.js";
import { buildX402Payment, parse402Challenge } from "./x402.js";

const EVM_ADDRESS = "0xFCAd0B19bB29D4674531d6f115237E16AfCE377c" as const;
const PAY_TO = "11111111111111111111111111111111";
const FEE_PAYER = "SysvarRent111111111111111111111111111111111";

const RECENT_BLOCKHASH = "11111111111111111111111111111111";

describe("x402 SVM payloads", () => {
  it("builds a real @x402/svm exact payload from a fixed v2 challenge", async () => {
    const solana = await createKeyPairSignerFromPrivateKeyBytes(new Uint8Array(32).fill(7));
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const body = init?.body ?? (input instanceof Request ? await input.clone().text() : "");
      const request = JSON.parse(String(body)) as { id: string | number; method: string };
      expect(request.method).toBe("getAccountInfo");
      return Response.json({
        jsonrpc: "2.0",
        id: request.id,
        result: {
          context: { apiVersion: "3.0.6", slot: 365_123_456 },
          value: {
            data: [mintAccountBase64(), "base64"],
            executable: false,
            lamports: 1_461_600,
            owner: TOKEN_PROGRAM_ADDRESS,
            rentEpoch: 0,
            space: 82,
          },
        },
      });
    });
    const quote = parse402Challenge(
      {
        x402Version: 2,
        resource: { url: "https://api.example/paid" },
        accepts: [
          {
            scheme: "exact",
            network: SOLANA_MAINNET_CAIP2,
            amount: "2500",
            asset: SOLANA_MAINNET_USDC,
            payTo: PAY_TO,
            maxTimeoutSeconds: 60,
            extra: {
              feePayer: FEE_PAYER,
              recentBlockhash: RECENT_BLOCKHASH,
              lastValidBlockHeight: "365123999",
              memo: "fixed-vapi-test",
            },
          },
        ],
      },
      {
        [SOLANA_MAINNET_CAIP2]: {
          usdc: SOLANA_MAINNET_USDC,
          rpcUrl: "https://rpc.example",
        },
      },
    );

    const payment = await buildX402Payment({
      signer: {
        address: EVM_ADDRESS,
        signTypedData: async () => {
          throw new Error("EVM signing must not run for a Solana challenge.");
        },
        solana,
      },
      quote,
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(payment.payload.payload).toHaveProperty("transaction");
    if (!("transaction" in payment.payload.payload)) throw new Error("Expected SVM payload.");
    expect(Buffer.from(payment.payload.payload.transaction, "base64").byteLength).toBeGreaterThan(
      100,
    );
    expect(payment.payload).toMatchObject({
      x402Version: 2,
      accepted: { network: SOLANA_MAINNET_CAIP2 },
      payload: { transaction: expect.any(String) },
    });
    expect(
      JSON.parse(Buffer.from(payment.headers["PAYMENT-SIGNATURE"], "base64").toString("utf8")),
    ).toEqual(payment.payload);
  });
});

function mintAccountBase64(): string {
  const data = Buffer.alloc(82);
  data[44] = 6;
  data[45] = 1;
  return data.toString("base64");
}
