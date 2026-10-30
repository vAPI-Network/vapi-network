import { z } from "zod";

const WALLET_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;

export function isWalletName(value: string): boolean {
  return WALLET_NAME_PATTERN.test(value);
}

export const walletNameSchema = z
  .string()
  .regex(
    WALLET_NAME_PATTERN,
    "A wallet name is 1 to 32 characters of lowercase letters, digits and dashes, starting with a letter or digit.",
  );
