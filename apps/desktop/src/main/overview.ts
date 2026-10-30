import { join } from "node:path";
import {
  BASE_MAINNET_CAIP2,
  configuredNetworkFor,
  loadConfig,
  readReceipts,
  readUsdcBalance,
  receiptWallet,
  type Receipt,
} from "@vapi-network/core";

import type { AppStatus } from "../shared/apps.js";
import type { RecoveryState, WalletSummary } from "../signer/messages.js";
import type { ActivityItem, Overview } from "../shared/overview.js";

export type OverviewDeps = {
  home: string;
  wallets: WalletSummary[];
  readBalance: (address: `0x${string}`) => Promise<bigint>;
  apps: () => Promise<AppStatus[]>;
  owner: `0x${string}` | null;
  recovery: RecoveryState | null;
};

function outcomeOf(receipt: Receipt): ActivityItem["outcome"] {
  switch (receipt.outcome) {
    case "paid":
    case "signed_in":
      return "paid";
    case "declined_policy":
      return "blocked";
    case "failed_request":
    case "settlement_rejected":
      return "failed";
    case "settlement_unknown":
      return "unknown";
    default:
      return receipt.settlement?.outcome === "succeeded" ? "paid" : "unknown";
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function toActivity(receipt: Receipt): ActivityItem {
  const explorerUrl = receipt.settlement?.explorerUrl;
  return {
    id: receipt.id,
    timestamp: receipt.timestamp,
    wallet: receiptWallet(receipt),
    host: hostOf(receipt.resourceUrl),
    amountAtomic: receipt.quote?.amountAtomic ?? null,
    outcome: outcomeOf(receipt),
    ...(explorerUrl === undefined ? {} : { explorerUrl }),
  };
}

/** Everything the home screen shows, read without touching a key. */
export async function readOverview(deps: OverviewDeps): Promise<Overview> {
  const [wallets, receipts, apps] = await Promise.all([
    Promise.all(
      deps.wallets.map(async (wallet) => {
        try {
          return { ...wallet, balanceAtomic: (await deps.readBalance(wallet.address)).toString() };
        } catch {
          return { ...wallet, balanceAtomic: null };
        }
      }),
    ),
    readReceipts(join(deps.home, "receipts.jsonl"), { limit: 50 }).catch(() => []),
    Promise.resolve()
      .then(() => deps.apps())
      .catch(() => []),
  ]);
  return {
    owner: deps.owner,
    recovery: deps.recovery,
    wallets,
    activity: receipts.map(toActivity).reverse(),
    apps,
  };
}

/** Reads USDC on Base through the RPC in `<home>/config.json` (core's default when absent). */
export async function baseBalanceReader(
  home: string,
): Promise<(address: `0x${string}`) => Promise<bigint>> {
  const config = await loadConfig(join(home, "config.json"));
  const configured = configuredNetworkFor(config.networks, BASE_MAINNET_CAIP2);
  if (configured === undefined) throw new Error("Base is not configured.");
  return async (address) =>
    await readUsdcBalance({ network: BASE_MAINNET_CAIP2, configured, address });
}
