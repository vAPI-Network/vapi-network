// apps/desktop/src/renderer/resume.ts
import type { AppStatus } from "../shared/apps.js";
import type { RecoveryState, WalletLinkState } from "../signer/messages.js";

export type Resume = "welcome" | "protect" | "unlock" | "custody" | "home";

/**
 * Spec §4 resume rule: open the first unfinished *required* step ("You are in
 * control", then "Protect"); when both are done, open home. Everything optional
 * that was skipped becomes a home card or a wallet pill instead.
 */
export function resumeScreen(input: {
  vault: "none" | "locked" | "unlocked";
  custodyAccepted: boolean;
}): Resume {
  if (input.vault === "none") return input.custodyAccepted ? "protect" : "welcome";
  if (input.vault === "locked") return "unlock";
  return input.custodyAccepted ? "home" : "custody";
}

export type HomeCard =
  | "firstWallet"
  | "emergencyKit"
  | "connectAccount"
  | "backup"
  | "backupFailed"
  | "connectApp"
  | "addMoney";

/**
 * Optional setup lives here: Emergency Kit, account connection, encrypted backup, apps and money.
 * Failed backups get a card; unknown recovery state adds none. A `null` balance is a failed
 * read, not zero, so it never asks for money.
 */
export function homeCards(input: {
  owner: `0x${string}` | null;
  wallets: { link?: WalletLinkState; balanceAtomic: string | null }[];
  apps: { state: AppStatus["state"] }[];
  recovery: RecoveryState | null;
}): HomeCard[] {
  const kit = input.recovery !== null && !input.recovery.kit ? (["emergencyKit"] as const) : [];
  if (input.wallets.length === 0) return ["firstWallet", ...kit];
  const cards: HomeCard[] = [...kit];
  const connected =
    input.owner !== null && input.wallets.some((wallet) => wallet.link === "linked");
  if (!connected) cards.push("connectAccount");
  const backup = input.recovery?.backup;
  if (connected && backup !== undefined && !backup.enabled) cards.push("backup");
  if (backup?.enabled && backup.failed) cards.push("backupFailed");
  if (!input.apps.some((app) => app.state === "connected")) cards.push("connectApp");
  const empty = input.wallets.every(
    (wallet) => wallet.balanceAtomic !== null && BigInt(wallet.balanceAtomic) === 0n,
  );
  if (empty) cards.push("addMoney");
  return cards;
}
