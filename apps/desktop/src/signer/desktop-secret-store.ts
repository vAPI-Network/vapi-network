// apps/desktop/src/signer/desktop-secret-store.ts
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  memorySecretStore,
  secretStore,
  VAULT_KEY_ACCOUNT,
  VAULT_SESSION_ACCOUNT,
  type SecretStore,
} from "@vapi-network/core";

/** Entries that unlock the vault: memory only, so a lock really forgets the key. */
const MEMORY_ONLY = new Set<string>([VAULT_KEY_ACCOUNT, VAULT_SESSION_ACCOUNT]);

export type DesktopSecretStoreOptions = {
  home: string;
  /** Where link tokens and Router keys live; core's OS store (macOS Keychain) by default. */
  os?: SecretStore;
  /** The CLI's home; entries there keep the CLI's names, so both see one link. */
  defaultHome?: string;
};

/**
 * What core asks the "OS secret store" for, answered the desktop way.
 * `vault-key` and `vault-session` live only in this process's memory. Agent
 * link tokens and Router keys go to the OS store so a link survives a restart.
 * Core names those entries by wallet only, so any home other than the CLI's
 * gets a prefix: a test home's `claude` never overwrites the CLI's `claude`.
 * The *password* is not in this store at all; `PasswordStore` owns it.
 */
export function desktopSecretStore(options: DesktopSecretStoreOptions): SecretStore {
  const memory = memorySecretStore();
  const os = options.os ?? secretStore();
  const home = resolve(options.home);
  const shared = home === resolve(options.defaultHome ?? join(homedir(), ".vapi"));
  const prefix = shared
    ? ""
    : `vapi-desktop.${createHash("sha256").update(home).digest("hex").slice(0, 12)}.`;
  const route = (name: string): { store: SecretStore; name: string } =>
    MEMORY_ONLY.has(name) ? { store: memory, name } : { store: os, name: `${prefix}${name}` };

  return {
    available: os.available,
    platform: os.platform,
    description: "vAPI Desktop",
    async get(name) {
      const target = route(name);
      return await target.store.get(target.name);
    },
    async has(name) {
      const target = route(name);
      return await target.store.has(target.name);
    },
    async set(name, value) {
      const target = route(name);
      await target.store.set(target.name, value);
    },
    async remove(name) {
      const target = route(name);
      return await target.store.remove(target.name);
    },
  };
}
