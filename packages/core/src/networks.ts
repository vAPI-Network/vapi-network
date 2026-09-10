import {
  ARC_MAINNET_CAIP2_PLACEHOLDER,
  ARC_TESTNET_CAIP2,
  BASE_MAINNET_CAIP2,
  CANONICAL_X402_USDC_NETWORKS,
  SOLANA_MAINNET_CAIP2,
  SOLANA_MAINNET_USDC,
  X402_SOLANA_MAINNET_CAIP2,
} from "./x402-networks.js";
import {
  createPublicClient,
  defineChain,
  formatUnits,
  getAddress,
  http,
  type Chain,
  type HttpTransport,
  type PublicClient,
} from "viem";

import { createPublicFetch, type LookupFn } from "./net-guard.js";

export {
  ARC_MAINNET_CAIP2_PLACEHOLDER,
  ARC_TESTNET_CAIP2,
  BASE_MAINNET_CAIP2,
  SOLANA_MAINNET_CAIP2,
  SOLANA_MAINNET_USDC,
  X402_SOLANA_MAINNET_CAIP2,
};
export const USDC_DECIMALS = 6;
export const DEFAULT_ARC_GAS_HEADROOM_ATOMIC = 50_000n;

export type NetworkDefinition = {
  family: "evm" | "svm";
  chainId?: number;
  name: string;
  usdc: string;
  gasToken: "ETH" | "USDC" | "SOL";
  rpcEnv: string;
  publicRpcUrl?: string;
};

export type ConfiguredNetwork = {
  rpcUrl: string;
  usdc: string;
};

export type NetworkTransportOptions = {
  allowPrivateNetwork?: boolean;
  fetch?: typeof fetch;
  lookup?: LookupFn;
};

export const NETWORKS = {
  [BASE_MAINNET_CAIP2]: {
    family: "evm",
    chainId: 8453,
    name: "Base mainnet",
    usdc: CANONICAL_X402_USDC_NETWORKS[BASE_MAINNET_CAIP2].usdc,
    gasToken: "ETH",
    rpcEnv: "BASE_RPC_URL",
    publicRpcUrl: "https://mainnet.base.org",
  },
  [ARC_TESTNET_CAIP2]: {
    family: "evm",
    chainId: 5_042_002,
    name: "Arc testnet",
    usdc: CANONICAL_X402_USDC_NETWORKS[ARC_TESTNET_CAIP2].usdc,
    gasToken: "USDC",
    rpcEnv: "ARC_TESTNET_RPC_URL",
  },
  [SOLANA_MAINNET_CAIP2]: {
    family: "svm",
    name: "Solana mainnet",
    usdc: SOLANA_MAINNET_USDC,
    gasToken: "SOL",
    rpcEnv: "SOLANA_RPC_URL",
    publicRpcUrl: "https://api.mainnet-beta.solana.com",
  },
  [X402_SOLANA_MAINNET_CAIP2]: {
    family: "svm",
    name: "Solana mainnet",
    usdc: SOLANA_MAINNET_USDC,
    gasToken: "SOL",
    rpcEnv: "SOLANA_RPC_URL",
    publicRpcUrl: "https://api.mainnet-beta.solana.com",
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

export function isSolanaNetwork(network: string): boolean {
  return network === SOLANA_MAINNET_CAIP2 || network === X402_SOLANA_MAINNET_CAIP2;
}

export function areSamePaymentNetwork(left: string, right: string): boolean {
  return left === right || (isSolanaNetwork(left) && isSolanaNetwork(right));
}

export function isSupportedPaymentNetwork(network: string): boolean {
  if (isSolanaNetwork(network)) return true;
  try {
    parseEip155ChainId(network);
    return true;
  } catch {
    return false;
  }
}

export function configuredNetworkFor(
  networks: Readonly<Record<string, ConfiguredNetwork>>,
  network: string,
): ConfiguredNetwork | undefined {
  const configured = networks[network];
  if (configured) return configured;
  if (network === X402_SOLANA_MAINNET_CAIP2) return networks[SOLANA_MAINNET_CAIP2];
  if (network === SOLANA_MAINNET_CAIP2) return networks[X402_SOLANA_MAINNET_CAIP2];
  return undefined;
}

export function getNetworkDefinition(network: string): NetworkDefinition {
  const known = NETWORKS[network as keyof typeof NETWORKS];
  if (known) {
    return known;
  }
  const chainId = parseEip155ChainId(network);
  return {
    family: "evm",
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
  if (definition.family !== "evm" || definition.chainId === undefined) {
    throw new Error(`Network ${network} is not an EVM chain.`);
  }
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
