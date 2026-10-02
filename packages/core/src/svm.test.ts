import { describe, expect, it, vi } from "vitest";

import { NETWORKS, SOLANA_MAINNET_CAIP2 } from "./networks.js";
import { readSolanaUsdcBalance } from "./svm.js";

const OWNER = "11111111111111111111111111111111";
const TOKEN_ACCOUNT = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";

describe("Solana USDC RPC", () => {
  it("parses and sums atomic balances from a recorded getTokenAccountsByOwner response", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        jsonrpc: "2.0",
        id: 1,
        result: {
          context: { apiVersion: "3.0.6", slot: 365_123_456 },
          value: [
            tokenAccount("1200000"),
            { ...tokenAccount("34"), pubkey: "SysvarRent111111111111111111111111111111111" },
          ],
        },
      }),
    );

    await expect(
      readSolanaUsdcBalance({
        network: SOLANA_MAINNET_CAIP2,
        configured: {
          rpcUrl: NETWORKS[SOLANA_MAINNET_CAIP2].publicRpcUrl,
          usdc: NETWORKS[SOLANA_MAINNET_CAIP2].usdc,
        },
        address: OWNER,
        fetchImpl,
      }),
    ).resolves.toBe(1_200_034n);
    const request = JSON.parse(String(fetchImpl.mock.calls[0]![1]?.body)) as {
      method: string;
      params: unknown[];
    };
    expect(request.method).toBe("getTokenAccountsByOwner");
    expect(request.params).toEqual([
      OWNER,
      { mint: NETWORKS[SOLANA_MAINNET_CAIP2].usdc },
      { encoding: "jsonParsed", commitment: "confirmed" },
    ]);
  });
});

function tokenAccount(amount: string) {
  return {
    pubkey: TOKEN_ACCOUNT,
    account: {
      data: {
        parsed: {
          info: {
            mint: NETWORKS[SOLANA_MAINNET_CAIP2].usdc,
            owner: OWNER,
            tokenAmount: { amount, decimals: 6 },
          },
        },
      },
    },
  };
}
