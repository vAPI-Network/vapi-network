import { describe, expect, it, vi } from "vitest";
import { CANONICAL_X402_USDC_NETWORKS } from "./x402-networks.js";

import {
  ARC_MAINNET_CAIP2,
  ARC_TESTNET_CAIP2,
  areSamePaymentNetwork,
  BASE_MAINNET_CAIP2,
  createNetworkPublicClient,
  createChain,
  explorerAddressUrl,
  explorerTransactionUrl,
  NETWORKS,
  requireRpcUrl,
  SOLANA_MAINNET_CAIP2,
  SOLANA_MAINNET_USDC,
  X402_SOLANA_MAINNET_CAIP2,
  usesUsdcGas,
} from "./networks.js";

describe("vAPI network definitions", () => {
  it("derives supported USDC assets from the shared x402 network authority", () => {
    expect(NETWORKS[BASE_MAINNET_CAIP2].usdc).toBe(
      CANONICAL_X402_USDC_NETWORKS[BASE_MAINNET_CAIP2].usdc,
    );
    expect(NETWORKS[ARC_TESTNET_CAIP2].usdc).toBe(
      CANONICAL_X402_USDC_NETWORKS[ARC_TESTNET_CAIP2].usdc,
    );
    expect(NETWORKS[ARC_MAINNET_CAIP2]).toMatchObject({
      family: "evm",
      chainId: 5042,
      gasToken: "USDC",
      rpcEnv: "ARC_RPC_URL",
      publicRpcUrl: "https://rpc.mainnet.arc.io",
      explorerUrl: "https://explorer.arc.io",
    });
    expect(NETWORKS[SOLANA_MAINNET_CAIP2]).toMatchObject({
      family: "svm",
      usdc: SOLANA_MAINNET_USDC,
      gasToken: "SOL",
      publicRpcUrl: "https://api.mainnet-beta.solana.com",
    });
  });

  it("creates the Arc mainnet chain with USDC gas and explorer metadata", () => {
    const chain = createChain(ARC_MAINNET_CAIP2, "https://rpc.example");
    expect(chain).toMatchObject({
      id: 5042,
      nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 6 },
      blockExplorers: { default: { url: "https://explorer.arc.io" } },
    });
  });

  it("prefers ARC_RPC_URL and exposes explorer links only for Arc mainnet", () => {
    vi.stubEnv("ARC_RPC_URL", "https://env.arc.example");
    expect(
      requireRpcUrl(ARC_MAINNET_CAIP2, { rpcUrl: "https://configured.example", usdc: "0x0" }),
    ).toBe("https://env.arc.example");
    vi.unstubAllEnvs();
    expect(explorerTransactionUrl(ARC_MAINNET_CAIP2, "0xabc")).toBe(
      "https://explorer.arc.io/tx/0xabc",
    );
    expect(explorerAddressUrl(ARC_MAINNET_CAIP2, "0xdef")).toBe(
      "https://explorer.arc.io/address/0xdef",
    );
    expect(explorerTransactionUrl(BASE_MAINNET_CAIP2, "0xabc")).toBeUndefined();
    expect(explorerAddressUrl(BASE_MAINNET_CAIP2, "0xdef")).toBeUndefined();
    expect(explorerTransactionUrl("garbage", "0xabc")).toBeUndefined();
  });

  it("identifies USDC-gas networks without throwing on garbage", () => {
    expect(usesUsdcGas(ARC_MAINNET_CAIP2)).toBe(true);
    expect(usesUsdcGas(ARC_TESTNET_CAIP2)).toBe(true);
    expect(usesUsdcGas(BASE_MAINNET_CAIP2)).toBe(false);
    expect(usesUsdcGas(SOLANA_MAINNET_CAIP2)).toBe(false);
    expect(usesUsdcGas("garbage")).toBe(false);
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
