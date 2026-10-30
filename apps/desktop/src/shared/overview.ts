import type { AppStatus } from "./apps.js";
import type { RecoveryState, WalletSummary } from "../signer/messages.js";

/** What main hands the renderer for the home screen; type-only so both builds share it. */
export type ActivityItem = {
  id: string;
  timestamp: string;
  wallet: string;
  host: string;
  amountAtomic: string | null;
  outcome: "paid" | "blocked" | "failed" | "unknown";
  explorerUrl?: string;
};

export type OverviewWallet = WalletSummary & {
  /** USDC on Base; `null` when the read failed, which is not the same as zero. */
  balanceAtomic: string | null;
};

export type Overview = {
  /** The vAPI account the wallets are linked to; null before the first link. */
  owner: `0x${string}` | null;
  /** Emergency Kit and encrypted backup state; null when the signer could not answer. */
  recovery: RecoveryState | null;
  wallets: OverviewWallet[];
  activity: ActivityItem[];
  apps: AppStatus[];
};
