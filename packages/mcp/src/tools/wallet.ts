import {
  formatUsdc,
  getNetworkDefinition,
  readUsdcBalance,
  type VapiConfig,
} from "@vapi-network/core";
import type { Address } from "viem";

export type WalletBalance = {
  network: string;
  name: string;
  usdcAtomic: string | null;
  usdc: string | null;
  error?: string;
};

export async function getWallet(
  address: Address,
  config: VapiConfig,
): Promise<{ address: Address; balances: WalletBalance[] }> {
  const balances = await Promise.all(
    Object.entries(config.networks).map(async ([network, configured]) => {
      const definition = getNetworkDefinition(network);
      try {
        const amount = await readUsdcBalance({
          network,
          configured,
          address,
          allowPrivateNetwork: config.allowPrivateNetwork,
        });
        return {
          network,
          name: definition.name,
          usdcAtomic: amount.toString(),
          usdc: formatUsdc(amount),
        } satisfies WalletBalance;
      } catch (error) {
        return {
          network,
          name: definition.name,
          usdcAtomic: null,
          usdc: null,
          error: error instanceof Error ? error.message : String(error),
        } satisfies WalletBalance;
      }
    }),
  );
  return { address, balances };
}
