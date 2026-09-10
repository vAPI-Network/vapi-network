import {
  ARC_TESTNET_CAIP2,
  BASE_MAINNET_CAIP2,
  CANONICAL_X402_USDC_NETWORKS,
} from "./x402-networks.js";
import {
  createPublicClient,
  defineChain,
  formatUnits,
  getAddress,
  http,
  type Address,
  type Chain,
  type HttpTransport,
  type PublicClient,
} from "viem";

import { createPublicFetch, type LookupFn } from "./net-guard.js";

export { ARC_TESTNET_CAIP2, BASE_MAINNET_CAIP2 };
export const USDC_DECIMALS = 6;
export const DEFAULT_ARC_GAS_HEADROOM_ATOMIC = 50_000n;

export type NetworkDefinition = {
  chainId: number;
  name: string;
  usdc: Address;
  gasToken: "ETH" | "USDC";
  rpcEnv: string;
  publicRpcUrl?: string;
};

export type ConfiguredNetwork = {
  rpcUrl: string;
  usdc: Address;
};

export type NetworkTransportOptions = {
  allowPrivateNetwork?: boolean;
  fetch?: typeof fetch;
  lookup?: LookupFn;
};

export const NETWORKS = {
  [BASE_MAINNET_CAIP2]: {
    chainId: 8453,
    name: "Base mainnet",
    usdc: CANONICAL_X402_USDC_NETWORKS[BASE_MAINNET_CAIP2].usdc,
    gasToken: "ETH",
    rpcEnv: "BASE_RPC_URL",
    publicRpcUrl: "https://mainnet.base.org",
  },
  [ARC_TESTNET_CAIP2]: {
    chainId: 5_042_002,
    name: "Arc testnet",
    usdc: CANONICAL_X402_USDC_NETWORKS[ARC_TESTNET_CAIP2].usdc,
    gasToken: "USDC",
    rpcEnv: "ARC_TESTNET_RPC_URL",
  },
} as const satisfies Record<string, NetworkDefinition>;

export function parseEip155ChainId(network: string): number {
  const match = /^eip155:(\d+)$/.exec(network);
  if (!match) {
    throw new Error(`Unsupported network ${network}; expected eip155:<chainId>.`);
  }
  const chainId = Number(match[1]);
  if (!Number.isSafeInteger(chainId) || chainId <= 0) {
    throw new Error(`Invalid EVM chain ID in network ${network}.`);
  }
  return chainId;
}

export function getNetworkDefinition(network: string): NetworkDefinition {
  const known = NETWORKS[network as keyof typeof NETWORKS];
  if (known) {
    return known;
  }
  const chainId = parseEip155ChainId(network);
  return {
    chainId,
    name: network,
    usdc: getAddress("0x0000000000000000000000000000000000000000"),
    gasToken: "ETH",
    rpcEnv: "",
  };
}

export function requireRpcUrl(network: string, configured: ConfiguredNetwork): string {
  const definition = getNetworkDefinition(network);
  const envUrl = definition.rpcEnv ? process.env[definition.rpcEnv]?.trim() : undefined;
  const rpcUrl = envUrl || configured.rpcUrl.trim();
  if (rpcUrl) {
    return rpcUrl;
  }
  if (network === ARC_TESTNET_CAIP2) {
    throw new Error(
      "Arc testnet RPC is required. Set ARC_TESTNET_RPC_URL or add rpcUrl for eip155:5042002 in config.json.",
    );
  }
  throw new Error(`RPC URL is required for ${network}.`);
}

export function createChain(network: string, rpcUrl: string): Chain {
  const definition = getNetworkDefinition(network);
  return defineChain({
    id: definition.chainId,
    name: definition.name,
    nativeCurrency:
      definition.gasToken === "USDC"
        ? { name: "USDC", symbol: "USDC", decimals: USDC_DECIMALS }
        : { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: {
      default: { http: [rpcUrl] },
    },
  });
}

export function createNetworkPublicClient(
  network: string,
  configured: ConfiguredNetwork,
  options: NetworkTransportOptions = {},
): PublicClient {
  const rpcUrl = requireRpcUrl(network, configured);
  return createPublicClient({
    chain: createChain(network, rpcUrl),
    transport: createNetworkHttpTransport(rpcUrl, options),
  }) as PublicClient;
}

/** Create a JSON-RPC transport whose default fetch validates and pins destinations. */
export function createNetworkHttpTransport(
  rpcUrl: string,
  options: NetworkTransportOptions = {},
): HttpTransport {
  const fetchFn =
    options.fetch ??
    createPublicFetch({
      allowPrivateNetwork: options.allowPrivateNetwork ?? false,
      ...(options.lookup ? { lookup: options.lookup } : {}),
    });
  return http(rpcUrl, { fetchFn, fetchOptions: { redirect: "manual" } });
}

export function formatUsdc(amountAtomic: bigint): string {
  return formatUnits(amountAtomic, USDC_DECIMALS);
}
