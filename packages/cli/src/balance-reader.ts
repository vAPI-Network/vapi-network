import {
  BASE_MAINNET_CAIP2,
  KeystoreError,
  listAccounts,
  type VapiConfig,
  type WalletBalanceReader,
} from "@vapi-network/core";
import { type CliDependencies } from "./cli-context.js";

/**
 * The Base USDC balance of an address, read the way `vapi accounts` reads it,
 * so removing a wallet can refuse to walk away from money.
 */
export function baseUsdcBalanceReader(
  config: VapiConfig,
  dependencies: CliDependencies,
): WalletBalanceReader {
  return async (address: string) => {
    const accounts = await listAccounts({
      address,
      config,
      ...(dependencies.fetchImpl ? { fetchImpl: dependencies.fetchImpl } : {}),
    });
    const base = accounts.find((account) => account.caip2 === BASE_MAINNET_CAIP2);
    if (!base?.usdcBalance) {
      throw new KeystoreError(
        [
          `Could not read the USDC balance of ${address} on Base${base?.error ? `: ${base.error}` : "."}`,
          "Re-run with --force to remove the wallet anyway.",
        ].join("\n"),
      );
    }
    return BigInt(base.usdcBalance.atomic);
  };
}
