import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readlink,
  readdir,
  rename,
  symlink,
  unlink,
} from "node:fs/promises";
import { join, resolve } from "node:path";

import type { Hex } from "viem";

import { appendAudit, type AuditRecord } from "./audit.js";
import { isMissingFile } from "./config.js";
import { decryptPrivateKey, KeystoreError, parseAnyKeystore } from "./keystore.js";
import { VaultError, type Vault, type VaultAccount } from "./vault.js";
import { isWalletName } from "./wallet-name.js";

export const MIGRATED_DIRECTORY = "wallets.migrated";
export type MigrationSkipReason = "passphrase_needed" | "unreadable" | "name_taken";
export type KeystoreMigration = {
  imported: string[];
  skipped: { name: string; reason: MigrationSkipReason }[];
};
/** Returns the 0.5 passphrase for one wallet name, or undefined when it cannot be obtained without a person. */
export type PassphraseResolver = (name: string) => Promise<string | undefined>;

/**
 * Names of the 0.5 keystores still under `<home>/wallets/`. Only regular files
 * named for a valid wallet are returned.
 */
export async function legacyKeystoreNames(home: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(join(home, "wallets"), { withFileTypes: true });
  } catch (error) {
    if (isMissingFile(error)) return [];
    throw error;
  }

  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name.slice(0, -".json".length))
    .filter(isWalletName)
    .sort();
}

export async function migrateKeystores(args: {
  home: string;
  vault: Vault;
  resolvePassphrase: PassphraseResolver;
  /** Audit writer; defaults to appendAudit(home, record, { now }). Injected so tests can capture lines. */
  audit?: (record: AuditRecord) => Promise<unknown>;
  now?: () => Date;
  /** When given, only these names are considered (the store uses it to migrate one keystore on unlock). */
  only?: readonly string[];
}): Promise<KeystoreMigration> {
  const now = args.now ?? (() => new Date());
  const audit = args.audit ?? (async (record) => await appendAudit(args.home, record, { now }));
  const only = args.only === undefined ? undefined : new Set(args.only);
  const names = (await legacyKeystoreNames(args.home)).filter(
    (name) => only === undefined || only.has(name),
  );
  const result: KeystoreMigration = { imported: [], skipped: [] };

  for (const name of names) {
    const source = join(args.home, "wallets", `${name}.json`);
    if (args.vault.accounts().some((account) => account.name === name)) {
      result.skipped.push({ name, reason: "name_taken" });
      continue;
    }

    let parsed: ReturnType<typeof parseAnyKeystore>;
    try {
      parsed = parseAnyKeystore(JSON.parse(await readFile(source, "utf8")));
    } catch {
      result.skipped.push({ name, reason: "unreadable" });
      continue;
    }

    const passphrase = await args.resolvePassphrase(name);
    if (!passphrase) {
      result.skipped.push({ name, reason: "passphrase_needed" });
      continue;
    }

    let privateKey: Hex;
    try {
      privateKey = await decryptPrivateKey(parsed, passphrase);
    } catch {
      result.skipped.push({ name, reason: "passphrase_needed" });
      continue;
    }
    let imported: VaultAccount;
    try {
      imported = await args.vault.importAccount(name, privateKey);
    } catch (error) {
      if (error instanceof VaultError && error.code === "name_taken") {
        result.skipped.push({ name, reason: "name_taken" });
        continue;
      }
      throw error;
    }
    if (imported.address.toLowerCase() !== parsed.address.toLowerCase()) {
      throw new KeystoreError(`Migrated wallet ${name} does not match its stored address.`);
    }

    const migratedDirectory = join(args.home, MIGRATED_DIRECTORY);
    const destination = join(migratedDirectory, `${name}.json`);
    await mkdir(migratedDirectory, { recursive: true, mode: 0o700 });
    await archiveExistingDestination(destination, migratedDirectory, name, now);
    await rename(source, destination);
    await chmod(destination, 0o600);
    try {
      await removeCompatibilityLink(args.home, source);
      // Legacy CLI and MCP callers still open WalletStore.path directly. A
      // symlink preserves that one-release compatibility without making a
      // second migration run treat the archived file as pending work.
      await symlink(join("..", MIGRATED_DIRECTORY, `${name}.json`), source);
      await audit({
        event: "vault.migrate",
        wallet: name,
        tty: false,
        detail: imported.address,
      });
    } catch (error) {
      try {
        await unlink(source).catch((unlinkError: unknown) => {
          if (!isMissingFile(unlinkError)) throw unlinkError;
        });
        await rename(destination, source);
      } catch (rollbackError) {
        throw new KeystoreError(
          `Migrated wallet ${name}, but its audit record failed and the keystore could not be restored for retry.`,
          { cause: new AggregateError([error, rollbackError]) },
        );
      }
      throw error;
    }

    result.imported.push(name);
  }

  return result;
}

async function archiveExistingDestination(
  destination: string,
  directory: string,
  name: string,
  now: () => Date,
): Promise<void> {
  if (!(await pathExists(destination))) return;

  const timestamp = now().toISOString();
  let archive = join(directory, `${name}.${timestamp}.json`);
  let suffix = 1;
  while (await pathExists(archive)) {
    archive = join(directory, `${name}.${timestamp}.${suffix}.json`);
    suffix += 1;
  }
  await rename(destination, archive);
}

async function removeCompatibilityLink(home: string, migratedSource: string): Promise<void> {
  const compatibilityPath = join(home, "keystore.json");
  let metadata;
  try {
    metadata = await lstat(compatibilityPath);
  } catch (error) {
    if (isMissingFile(error)) return;
    throw error;
  }
  if (!metadata.isSymbolicLink()) return;
  if (resolve(home, await readlink(compatibilityPath)) === migratedSource) {
    await unlink(compatibilityPath);
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isMissingFile(error)) return false;
    throw error;
  }
}
