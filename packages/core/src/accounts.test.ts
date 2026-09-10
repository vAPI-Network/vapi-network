import { describe, expect, it, vi } from "vitest";
import type { Address } from "viem";

import { listAccounts, type AccountNetworkAdapter } from "./accounts.js";
import { getDefaultConfig, type VapiConfig } from "./config.js";
import {
  ARC_TESTNET_CAIP2,
  BASE_MAINNET_CAIP2,
  NETWORKS,
  SOLANA_MAINNET_CAIP2,
} from "./networks.js";

const ADDRESS = "0x1111111111111111111111111111111111111111" as Address;
const SOLANA_ADDRESS = "11111111111111111111111111111111";

describe("account listing", () => {
  it("lists Base USDC and ETH balances with deposit instructions", async () => {
    const methods: string[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as { id: number; method: string };
      methods.push(request.method);
      return Response.json({
        jsonrpc: "2.0",
        id: request.id,
        result:
          request.method === "eth_call"
            ? uint256Hex(2_500_000n)
            : uint256Hex(1_000_000_000_000_000_000n),
      });
    });
    const config = baseConfig();

    await expect(listAccounts({ address: ADDRESS, config, fetchImpl })).resolves.toEqual([
      {
        caip2: BASE_MAINNET_CAIP2,
        name: "Base mainnet",
        address: ADDRESS,
        usdcBalance: { atomic: "2500000", formatted: "2.5" },
        gasTokenBalance: { symbol: "ETH", atomic: "1000000000000000000", formatted: "1" },
        depositInstructions: `Send USDC on Base to ${ADDRESS}.`,
      },
    ]);
    expect(methods).toEqual(["eth_call", "eth_getBalance"]);
  });

  it("uses Arc's USDC balance for gas and reads deposit metadata structurally", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as { id: number };
      return Response.json({ jsonrpc: "2.0", id: request.id, result: uint256Hex(1_000_000n) });
    });
    const configured = {
      rpcUrl: "https://arc-rpc.example",
      usdc: NETWORKS[ARC_TESTNET_CAIP2].usdc,
      depositUrl: "https://faucet.example/arc",
      depositInstructions: "Use the Arc testnet faucet.",
    };
    const config = {
      ...getDefaultConfig({}),
      networks: { [ARC_TESTNET_CAIP2]: configured },
    } as VapiConfig;

    await expect(listAccounts({ address: ADDRESS, config, fetchImpl })).resolves.toEqual([
      {
        caip2: ARC_TESTNET_CAIP2,
        name: "Arc testnet",
        address: ADDRESS,
        usdcBalance: { atomic: "1000000", formatted: "1" },
        gasTokenBalance: { symbol: "USDC", atomic: "1000000", formatted: "1" },
        depositUrl: "https://faucet.example/arc",
        depositInstructions: "Use the Arc testnet faucet.",
      },
    ]);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("returns a nonfatal entry when a network RPC fails", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new Error("RPC unavailable"));
    const config = baseConfig();

    const accounts = await listAccounts({ address: ADDRESS, config, fetchImpl });

    expect(accounts).toEqual([
      expect.objectContaining({
        caip2: BASE_MAINNET_CAIP2,
        name: "Base mainnet",
        address: ADDRESS,
        usdcBalance: null,
        gasTokenBalance: null,
        depositInstructions: `Send USDC on Base to ${ADDRESS}.`,
      }),
    ]);
    expect(accounts[0]?.error).toContain("RPC unavailable");
  });

  it("lists Solana USDC and SOL balances for the enabled local address", async () => {
    const methods: string[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as { id: number; method: string };
      methods.push(request.method);
      return Response.json({
        jsonrpc: "2.0",
        id: request.id,
        result:
          request.method === "getTokenAccountsByOwner"
            ? { context: { slot: 1 }, value: [] }
            : { context: { slot: 1 }, value: 500_000_000 },
      });
    });
    const config = {
      ...getDefaultConfig({}),
      networks: {
        [SOLANA_MAINNET_CAIP2]: {
          rpcUrl: "https://solana-rpc.example",
          usdc: NETWORKS[SOLANA_MAINNET_CAIP2].usdc,
        },
      },
    } as VapiConfig;

    await expect(
      listAccounts({ address: ADDRESS, solanaAddress: SOLANA_ADDRESS, config, fetchImpl }),
    ).resolves.toEqual([
      {
        caip2: SOLANA_MAINNET_CAIP2,
        name: "Solana mainnet",
        address: SOLANA_ADDRESS,
        usdcBalance: { atomic: "0", formatted: "0" },
        gasTokenBalance: { symbol: "SOL", atomic: "500000000", formatted: "0.5" },
        depositInstructions: `Send USDC on Solana mainnet to ${SOLANA_ADDRESS}.`,
      },
    ]);
    expect(methods.sort()).toEqual(["getBalance", "getTokenAccountsByOwner"]);
  });

  it("allows a custom adapter for a future Solana namespace", async () => {
    const adapter = vi.fn<AccountNetworkAdapter>().mockResolvedValue({
      name: "Solana devnet",
      address: "SolanaDepositAddress",
      usdcBalance: { atomic: "42000000", formatted: "42" },
      depositUrl: "https://faucet.example/solana",
      depositInstructions: "Use the Solana faucet.",
    });
    const configured = {
      rpcUrl: "https://solana-rpc.example",
      usdc: NETWORKS[BASE_MAINNET_CAIP2].usdc,
    };
    const config = {
      ...getDefaultConfig({}),
      networks: { "solana:devnet": configured },
    } as unknown as VapiConfig;

    await expect(
      listAccounts({ address: ADDRESS, config, adapters: { solana: adapter } }),
    ).resolves.toEqual([
      {
        caip2: "solana:devnet",
        name: "Solana devnet",
        address: "SolanaDepositAddress",
        usdcBalance: { atomic: "42000000", formatted: "42" },
        depositUrl: "https://faucet.example/solana",
        depositInstructions: "Use the Solana faucet.",
      },
    ]);
    expect(adapter).toHaveBeenCalledWith(
      expect.objectContaining({
        caip2: "solana:devnet",
        configured,
        defaultAddress: ADDRESS,
      }),
    );
  });
});

function baseConfig(): VapiConfig {
  return {
    ...getDefaultConfig({}),
    networks: {
      [BASE_MAINNET_CAIP2]: {
        rpcUrl: "https://base-rpc.example",
        usdc: NETWORKS[BASE_MAINNET_CAIP2].usdc,
      },
    },
  };
}

function uint256Hex(value: bigint): `0x${string}` {
  return `0x${value.toString(16).padStart(64, "0")}`;
}
