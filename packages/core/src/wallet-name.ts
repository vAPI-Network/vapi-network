import { z } from "zod";

/**
 * The wallet a record belongs to when it predates named wallets. Receipts and
 * spend-ledger rows written before 0.3.0 carry no wallet, and the 0.2.x
 * keystore becomes this wallet during the layout migration.
 */
export const DEFAULT_WALLET_NAME = "main";

/**
 * A wallet name is also a file name under `~/.vapi/wallets/`, so it stays in
 * the small set that is safe on every filesystem and unambiguous in a shell:
 * lowercase letters, digits and dashes, 1 to 32 characters, never starting
 * with a dash.
 */
export const WALLET_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;

export type WalletName = string;

export const walletNameSchema = z
  .string()
  .regex(
    WALLET_NAME_PATTERN,
    "A wallet name is 1 to 32 characters of lowercase letters, digits and dashes, starting with a letter or digit.",
  );

export function isWalletName(value: string): boolean {
  return WALLET_NAME_PATTERN.test(value);
}
