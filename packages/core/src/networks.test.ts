import { describe, expect, it, vi } from "vitest";
import { CANONICAL_X402_USDC_NETWORKS } from "./x402-networks.js";

import {
  ARC_TESTNET_CAIP2,
  areSamePaymentNetwork,
  BASE_MAINNET_CAIP2,
  createNetworkPublicClient,
  NETWORKS,
  SOLANA_MAINNET_CAIP2,
  SOLANA_MAINNET_USDC,
  X402_SOLANA_MAINNET_CAIP2,
} from "./networks.js";

describe("vAPI network definitions", () => {
  it("derives supported USDC assets from the shared x402 network authority", () => {
    expect(NETWORKS[BASE_MAINNET_CAIP2].usdc).toBe(
      CANONICAL_X402_USDC_NETWORKS[BASE_MAINNET_CAIP2].usdc,
    );
    expect(NETWORKS[ARC_TESTNET_CAIP2].usdc).toBe(
      CANONICAL_X402_USDC_NETWORKS[ARC_TESTNET_CAIP2].usdc,
    );
    expect(NETWORKS[SOLANA_MAINNET_CAIP2]).toMatchObject({
      family: "svm",
      usdc: SOLANA_MAINNET_USDC,
      gasToken: "SOL",
      publicRpcUrl: "https://api.mainnet-beta.solana.com",
    });
  });

  it("treats the persisted and x402 Solana identifiers as aliases only of each other", () => {
    expect(areSamePaymentNetwork(SOLANA_MAINNET_CAIP2, X402_SOLANA_MAINNET_CAIP2)).toBe(true);
    expect(areSamePaymentNetwork(SOLANA_MAINNET_CAIP2, BASE_MAINNET_CAIP2)).toBe(false);
  });

  it("guards configured JSON-RPC destinations before a network request", async () => {
    const lookup = vi.fn().mockResolvedValue(["127.0.0.1"]);
    const client = createNetworkPublicClient(
      BASE_MAINNET_CAIP2,
      { rpcUrl: "https://rpc.example", usdc: NETWORKS[BASE_MAINNET_CAIP2].usdc },
      { lookup },
    );

    await expect(client.getBlockNumber()).rejects.toThrow("allowPrivateNetwork true");
    expect(lookup).toHaveBeenCalled();
  });
});
