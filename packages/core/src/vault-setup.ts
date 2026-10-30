import { rm } from "node:fs/promises";
import { join } from "node:path";

import { KeystoreError } from "./keystore.js";
import type { SecretStore } from "./secret-store.js";
import { protectVault, VAULT_KEY_ACCOUNT } from "./vault-key.js";
import { WalletStore } from "./wallet-store.js";

/**
 * Creates the device vault with no account in it. The vault holds the recovery
 * phrase; accounts are created later by name, so `wallets.json` lists exactly
 * the accounts a person made. With a password the vault is protected at once,
 * which removes the device key from `secrets`.
 */
export async function createVault(
  home: string,
  options: { secrets: SecretStore; password?: string; now?: () => Date },
): Promise<void> {
  if (options.password === "") {
    throw new KeystoreError("A password cannot be empty.");
  }
  const store = await WalletStore.open(home, {
    secrets: options.secrets,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const hadDeviceKey =
    options.password !== undefined && (await options.secrets.has(VAULT_KEY_ACCOUNT));
  await store.createEmptyVault();
  if (options.password !== undefined) {
    const path = join(home, "vault.json");
    try {
      await protectVault({
        path,
        secrets: options.secrets,
        password: options.password,
      });
    } catch (error) {
      // Rollback is safe: this new vault has zero accounts and its phrase was never shown.
      // Attempt both cleanups even if one fails, preserving the protection error.
      await Promise.allSettled([
        rm(path, { force: true }),
        ...(hadDeviceKey ? [] : [options.secrets.remove(VAULT_KEY_ACCOUNT)]),
      ]);
      throw error;
    }
  }
}
