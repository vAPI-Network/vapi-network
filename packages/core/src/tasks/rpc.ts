import { createPublicClient, type PublicClient } from "viem";

import type { AgentCashConfig } from "../config.js";
import {
  createChain,
  createNetworkHttpTransport,
  type NetworkTransportOptions,
} from "../networks.js";
import { TasksChainError } from "./chain-port.js";

/** Resolve the server-selected Tasks deployment through guarded JSON-RPC. */
export function createTasksRpcFor(
  config: AgentCashConfig,
  options: NetworkTransportOptions & { env?: NodeJS.ProcessEnv } = {},
): (chainId: number) => PublicClient {
  const clients = new Map<number, PublicClient>();
  return (chainId) => {
    try {
      if (![8453, 84532, 5042002].includes(chainId))
        throw new Error(`Unsupported Tasks chain ID ${chainId}.`);
      const existing = clients.get(chainId);
      if (existing) return existing;
      const network = `eip155:${chainId}`;
      const configured = config.networks[network];
      const env = options.env ?? process.env;
      const rpcUrl =
        chainId === 84532
          ? env.BASE_SEPOLIA_RPC_URL?.trim() || "https://sepolia.base.org"
          : chainId === 8453
            ? env.BASE_RPC_URL?.trim() || configured?.rpcUrl.trim() || "https://mainnet.base.org"
            : env.ARC_TESTNET_RPC_URL?.trim() || configured?.rpcUrl.trim() || "";
      if (!rpcUrl)
        throw new Error(
          "Arc testnet RPC is required. Set ARC_TESTNET_RPC_URL or add rpcUrl for eip155:5042002 in config.json.",
        );
      const client = createPublicClient({
        chain: createChain(network, rpcUrl),
        transport: createNetworkHttpTransport(rpcUrl, {
          ...options,
          allowPrivateNetwork: options.allowPrivateNetwork ?? config.allowPrivateNetwork,
        }),
      }) as PublicClient;
      clients.set(chainId, client);
      return client;
    } catch (cause) {
      throw new TasksChainError(
        cause instanceof Error ? cause.message : "Tasks RPC is unavailable.",
        false,
        { cause, authorizationExposed: false },
      );
    }
  };
}
