import {
  formatUsdc,
  getNetworkDefinition,
  isSolanaNetwork,
  readUsdcBalance,
  type LookupFn,
  type VapiPaymentAccount,
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
  account: Address | VapiPaymentAccount,
  config: VapiConfig,
  options: { fetchImpl?: typeof fetch; lookup?: LookupFn } = {},
): Promise<{ address: Address; balances: WalletBalance[] }> {
  const evmAddress = typeof account === "string" ? account : account.address;
  const balances = await Promise.all(
    Object.entries(config.networks).map(async ([network, configured]) => {
      const definition = getNetworkDefinition(network);
      try {
        const balanceAddress = isSolanaNetwork(network)
          ? typeof account === "string"
            ? undefined
            : account.solana?.address
          : evmAddress;
        if (!balanceAddress) {
          throw new Error(
            "Solana is not enabled in this keystore. Run vapi accounts --enable solana first.",
          );
        }
        const amount = await readUsdcBalance({
          network,
          configured,
          address: balanceAddress,
          allowPrivateNetwork: config.allowPrivateNetwork,
          ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
          ...(options.lookup ? { lookup: options.lookup } : {}),
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
  return { address: evmAddress, balances };
}
