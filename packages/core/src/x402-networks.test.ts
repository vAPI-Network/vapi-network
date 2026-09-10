import { describe, expect, it } from "vitest";

import {
  ARC_MAINNET_CAIP2_PLACEHOLDER,
  ARC_TESTNET_CAIP2,
  BASE_MAINNET_CAIP2,
  BROWSER_ENABLED_X402_NETWORK_CONFIG,
  CANONICAL_X402_USDC_NETWORKS,
  getCanonicalX402Usdc,
  SOLANA_MAINNET_CAIP2,
  SOLANA_MAINNET_USDC,
  X402_SOLANA_MAINNET_CAIP2,
} from "./x402-networks.js";

const ATTACKER_ASSET = "0x1111111111111111111111111111111111111111";

describe("canonical x402 USDC identities", () => {
  it("publishes checksummed token addresses and canonical signing domains", () => {
    expect(CANONICAL_X402_USDC_NETWORKS).toEqual({
      [BASE_MAINNET_CAIP2]: {
        usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        eip712Domain: { name: "USD Coin", version: "2" },
      },
      [ARC_TESTNET_CAIP2]: {
        usdc: "0x3600000000000000000000000000000000000000",
        eip712Domain: { name: "USDC", version: "2" },
      },
    });
    expect(getCanonicalX402Usdc("eip155:1")).toBeUndefined();
    expect(ARC_MAINNET_CAIP2_PLACEHOLDER).toBeNull();
    expect(SOLANA_MAINNET_CAIP2).toBe("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d");
    expect(X402_SOLANA_MAINNET_CAIP2).toBe("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp");
    expect(SOLANA_MAINNET_USDC).toBe("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
  });

  it("deep-freezes token, domain, and browser-enablement authority", () => {
    const base = CANONICAL_X402_USDC_NETWORKS[BASE_MAINNET_CAIP2];
    const browserBase = BROWSER_ENABLED_X402_NETWORK_CONFIG[BASE_MAINNET_CAIP2]!;

    expect(Object.isFrozen(CANONICAL_X402_USDC_NETWORKS)).toBe(true);
    expect(Object.isFrozen(base)).toBe(true);
    expect(Object.isFrozen(base.eip712Domain)).toBe(true);
    expect(Object.isFrozen(BROWSER_ENABLED_X402_NETWORK_CONFIG)).toBe(true);
    expect(Object.isFrozen(browserBase)).toBe(true);
    expect(Object.isFrozen(browserBase.eip712Domain)).toBe(true);

    expect(() => {
      (base as { usdc: string }).usdc = ATTACKER_ASSET;
    }).toThrow(TypeError);
    expect(() => {
      (base.eip712Domain as { name: string }).name = "Attacker Coin";
    }).toThrow(TypeError);
    expect(() => {
      (browserBase as { usdc: string }).usdc = ATTACKER_ASSET;
    }).toThrow(TypeError);

    expect(base.usdc).toBe("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
    expect(base.eip712Domain).toEqual({ name: "USD Coin", version: "2" });
    expect(browserBase.usdc).toBe(base.usdc);
    expect(browserBase.eip712Domain).toBe(base.eip712Domain);
  });
});
