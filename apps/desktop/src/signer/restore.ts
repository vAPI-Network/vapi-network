// apps/desktop/src/signer/restore.ts
import { access, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  appendAudit,
  loadOrCreateDeviceKey,
  protectVault,
  restoreVault,
  validateRecoveryPhrase,
  type SecretStore,
} from "@vapi-network/core";

import { normalizePhrase } from "../shared/phrase.js";

export type RestoreErrorCode = "vault_exists" | "bad_phrase" | "probe_failed";

export class RestoreError extends Error {
  constructor(
    readonly code: RestoreErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "RestoreError";
  }
}

async function exists(path: string): Promise<boolean> {
  return await access(path).then(
    () => true,
    () => false,
  );
}

/**
 * Spec §8 "Derived wallets come back from the phrase": rebuild the vault from the Kit's words,
 * keep every account up to the last one with Base USDC (core's gap rule), protect it with the new
 * password, and roll back so a failed restore leaves the Welcome screen as it was.
 */
export async function restoreFromPhrase(args: {
  home: string;
  secrets: SecretStore;
  phrase: string;
  password: string;
  probe: (address: `0x${string}`) => Promise<boolean>;
  now?: () => Date;
}): Promise<{ wallets: string[] }> {
  const vaultPath = join(args.home, "vault.json");
  const walletsPath = join(args.home, "wallets.json");
  if (await exists(vaultPath)) {
    throw new RestoreError("vault_exists", "vAPI Desktop is already set up on this Mac.");
  }
  let phrase: string;
  try {
    phrase = validateRecoveryPhrase(normalizePhrase(args.phrase));
  } catch {
    throw new RestoreError(
      "bad_phrase",
      "Those words are not an Emergency Kit. Check the spelling and the order.",
    );
  }

  let wallets: string[];
  const key = await loadOrCreateDeviceKey({ secrets: args.secrets });
  try {
    const vault = await restoreVault({
      path: vaultPath,
      key,
      phrase,
      probe: args.probe,
      ...(args.now === undefined ? {} : { now: args.now }),
    });
    wallets = vault.accounts().map((account) => account.name);
  } catch {
    await rm(vaultPath, { force: true });
    throw new RestoreError(
      "probe_failed",
      "vAPI Desktop could not check Base for your agent wallets. Check your connection and try again.",
    );
  } finally {
    key.fill(0);
  }

  try {
    // Names, limits and links are not in the words; rebuild settings from the restored accounts.
    await rm(walletsPath, { force: true });
    await protectVault({ path: vaultPath, secrets: args.secrets, password: args.password });
  } catch (error) {
    await Promise.allSettled([rm(vaultPath, { force: true }), rm(walletsPath, { force: true })]);
    throw error;
  }
  await appendAudit(args.home, {
    event: "vault.restore",
    tty: false,
    detail: `${wallets.length} agent wallet(s) from the Emergency Kit`,
  });
  return { wallets };
}
