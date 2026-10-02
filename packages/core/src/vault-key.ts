import { randomBytes as cryptoRandomBytes } from "node:crypto";

import { privateKeyToAccount } from "viem/accounts";
import { z } from "zod";

import { deriveEvmPrivateKey, phraseToSeed, validateRecoveryPhrase } from "./hd.js";
import { decryptWithKey, deriveScryptKey, encryptWithKey } from "./keystore.js";
import type { SecretStore } from "./secret-store.js";
import {
  createVault,
  openVault,
  readVaultFileUnlocked,
  VaultError,
  withVaultLock,
  writeVaultFile,
  type StoredVaultFile,
  type Vault,
} from "./vault.js";

export const VAULT_KEY_ACCOUNT = "vault-key";
export const VAULT_SESSION_ACCOUNT = "vault-session";
export type VaultEnv = Record<string, string | undefined>;

const DEVICE_KEY_LENGTH = 32;
const DEFAULT_SESSION_HOURS = 8;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
let deviceKeyOperations: Promise<void> = Promise.resolve();
const sessionSchema = z
  .object({
    key: z.string().regex(BASE64_PATTERN),
    expiresAt: z.string().datetime(),
  })
  .strict();

export async function loadOrCreateDeviceKey(args: {
  secrets: SecretStore;
  randomBytes?: (size: number) => Uint8Array;
}): Promise<Uint8Array> {
  return await serializeDeviceKeyOperation(async () => {
    try {
      const stored = await args.secrets.get(VAULT_KEY_ACCOUNT);
      if (stored !== undefined) return decodeDeviceKey(stored);

      const key = randomKeyBytes(args.randomBytes);
      await args.secrets.set(VAULT_KEY_ACCOUNT, key.toString("base64"));
      return key;
    } catch (error) {
      throw asVaultError(error, "Unable to load or create the device vault key.");
    }
  });
}

export async function protectVault(args: {
  path: string;
  secrets: SecretStore;
  password?: string;
  env?: VaultEnv;
  randomBytes?: (size: number) => Uint8Array;
}): Promise<void> {
  let deviceKey: Buffer | undefined;
  let keyEncryptionKey: Buffer | undefined;
  let salt: Buffer | undefined;
  let nonce: Buffer | undefined;
  let ciphertext: Buffer | undefined;
  let tag: Buffer | undefined;
  try {
    const initial = await readVaultFileUnlocked(args.path);
    if (initial.protected) {
      throw new VaultError("already_protected", "The vault is already password protected.");
    }
    const password = requirePassword(args.password, args.env);
    const storedKey = await args.secrets.get(VAULT_KEY_ACCOUNT);
    if (storedKey === undefined) {
      throw new VaultError("not_found", "No device vault key was found in the secret store.");
    }
    deviceKey = decodeDeviceKey(storedKey);
    await openVault({ path: args.path, key: deviceKey });

    salt = randomKeyBytes(args.randomBytes);
    keyEncryptionKey = await deriveScryptKey(password, salt);
    ({ nonce, ciphertext, tag } = encryptWithKey(keyEncryptionKey, deviceKey));
    const wrappedKey = [salt, nonce, ciphertext, tag]
      .map((part) => part.toString("base64url"))
      .join(".");

    await withVaultLock(args.path, async () => {
      const current = await readVaultFileUnlocked(args.path);
      if (current.protected) {
        throw new VaultError("already_protected", "The vault is already password protected.");
      }
      await openVault({ path: args.path, key: deviceKey! });
      await writeVaultFile(args.path, { ...current, protected: true, wrappedKey });
      await args.secrets.remove(VAULT_KEY_ACCOUNT);
      await args.secrets.remove(VAULT_SESSION_ACCOUNT);
    });
  } catch (error) {
    throw asVaultError(error, "Unable to protect the vault.");
  } finally {
    deviceKey?.fill(0);
    keyEncryptionKey?.fill(0);
    salt?.fill(0);
    nonce?.fill(0);
    ciphertext?.fill(0);
    tag?.fill(0);
  }
}

export async function unprotectVault(args: {
  path: string;
  secrets: SecretStore;
  password?: string;
  env?: VaultEnv;
}): Promise<void> {
  let deviceKey: Buffer | undefined;
  try {
    const initial = await readVaultFileUnlocked(args.path);
    if (!initial.protected) {
      throw new VaultError("not_protected", "The vault is not password protected.");
    }
    const password = requirePassword(args.password, args.env);
    deviceKey = await unwrapDeviceKey(initial.wrappedKey, password);
    await openVault({ path: args.path, key: deviceKey });

    await withVaultLock(args.path, async () => {
      const current = await readVaultFileUnlocked(args.path);
      if (!current.protected) {
        throw new VaultError("not_protected", "The vault is not password protected.");
      }
      if (current.wrappedKey !== initial.wrappedKey) {
        throw new VaultError("corrupt", "The vault protection changed while it was being removed.");
      }
      await args.secrets.set(VAULT_KEY_ACCOUNT, deviceKey!.toString("base64"));
      const unprotected: StoredVaultFile = { ...current, protected: false };
      delete unprotected.wrappedKey;
      await writeVaultFile(args.path, unprotected);
      await args.secrets.remove(VAULT_SESSION_ACCOUNT);
    });
  } catch (error) {
    throw asVaultError(error, "Unable to remove vault password protection.");
  } finally {
    deviceKey?.fill(0);
  }
}

export async function unlockProtectedVault(args: {
  path: string;
  secrets: SecretStore;
  password?: string;
  env?: VaultEnv;
  sessionHours?: number;
  now?: () => Date;
}): Promise<Uint8Array> {
  try {
    const file = await readVaultFileUnlocked(args.path);
    if (!file.protected) {
      throw new VaultError("not_protected", "The vault is not password protected.");
    }
    const now = args.now ?? (() => new Date());
    const password = resolvePassword(args.password, args.env);
    if (password !== undefined) {
      const deviceKey = await unwrapDeviceKey(file.wrappedKey, password);
      try {
        const expiresAt = new Date(
          now().getTime() + (args.sessionHours ?? DEFAULT_SESSION_HOURS) * 60 * 60 * 1_000,
        ).toISOString();
        await args.secrets.set(
          VAULT_SESSION_ACCOUNT,
          JSON.stringify({ key: deviceKey.toString("base64"), expiresAt }),
        );
        return Buffer.from(deviceKey);
      } finally {
        deviceKey.fill(0);
      }
    }

    const session = await args.secrets.get(VAULT_SESSION_ACCOUNT);
    if (session !== undefined) {
      const parsed = sessionSchema.safeParse(parseJson(session));
      if (parsed.success && new Date(parsed.data.expiresAt).getTime() > now().getTime()) {
        const deviceKey = Buffer.from(parsed.data.key, "base64");
        try {
          if (deviceKey.byteLength === DEVICE_KEY_LENGTH) return Buffer.from(deviceKey);
        } finally {
          deviceKey.fill(0);
        }
      }
      await args.secrets.remove(VAULT_SESSION_ACCOUNT);
    }
    throw passwordRequiredError();
  } catch (error) {
    throw asVaultError(error, "Unable to unlock the protected vault.");
  }
}

export async function lockVault(args: { secrets: SecretStore }): Promise<boolean> {
  try {
    return await args.secrets.remove(VAULT_SESSION_ACCOUNT);
  } catch (error) {
    throw asVaultError(error, "Unable to lock the vault.");
  }
}

export async function restoreVault(args: {
  path: string;
  key: Uint8Array;
  phrase: string;
  probe: (address: `0x${string}`) => Promise<boolean>;
  now?: () => Date;
}): Promise<Vault> {
  let phrase: string;
  try {
    phrase = validateRecoveryPhrase(args.phrase);
  } catch (error) {
    throw new VaultError("corrupt", "That recovery phrase is not valid.", { cause: error });
  }

  let seed: Uint8Array | undefined;
  let discoveredAccounts = 0;
  try {
    seed = phraseToSeed(phrase);
  } catch (error) {
    throw asVaultError(error, "Unable to derive an account while restoring the vault.");
  }

  try {
    for (let index = 0; ; index += 1) {
      let address: `0x${string}`;
      try {
        address = privateKeyToAccount(deriveEvmPrivateKey(seed, `m/44'/60'/0'/0/${index}`)).address;
      } catch (error) {
        throw asVaultError(error, "Unable to derive an account while restoring the vault.");
      }
      if (!(await args.probe(address))) break;
      discoveredAccounts += 1;
    }
  } finally {
    seed.fill(0);
  }

  let vault: Vault;
  try {
    vault = await createVault({ path: args.path, key: args.key, phrase, now: args.now });
    const accountCount = Math.max(1, discoveredAccounts);
    for (let index = 0; index < accountCount; index += 1) {
      await vault.deriveAccount(`account-${index + 1}`);
    }
  } catch (error) {
    throw asVaultError(error, "Unable to create the restored vault.");
  }
  return vault;
}

function serializeDeviceKeyOperation<T>(operation: () => Promise<T>): Promise<T> {
  const result = deviceKeyOperations.then(
    async () => await operation(),
    async () => await operation(),
  );
  deviceKeyOperations = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function resolvePassword(
  password: string | undefined,
  env: VaultEnv | undefined,
): string | undefined {
  return password || env?.VAPI_VAULT_PASSWORD || undefined;
}

function requirePassword(password: string | undefined, env: VaultEnv | undefined): string {
  const resolved = resolvePassword(password, env);
  if (resolved === undefined) throw passwordRequiredError();
  return resolved;
}

function passwordRequiredError(): VaultError {
  return new VaultError(
    "password_required",
    "A vault password is needed. Pass it or set VAPI_VAULT_PASSWORD.",
  );
}

function randomKeyBytes(randomBytes: ((size: number) => Uint8Array) | undefined): Buffer {
  const key = Buffer.from((randomBytes ?? cryptoRandomBytes)(DEVICE_KEY_LENGTH));
  if (key.byteLength !== DEVICE_KEY_LENGTH) {
    key.fill(0);
    throw new VaultError("corrupt", "A generated device vault key has the wrong length.");
  }
  return key;
}

function decodeDeviceKey(value: string): Buffer {
  const key = Buffer.from(value, "base64");
  if (key.byteLength !== DEVICE_KEY_LENGTH) {
    key.fill(0);
    throw new VaultError("corrupt", "The stored device vault key has the wrong length.");
  }
  return key;
}

async function unwrapDeviceKey(wrappedKey: string | undefined, password: string): Promise<Buffer> {
  if (wrappedKey === undefined) {
    throw new VaultError("corrupt", "The protected vault has no wrapped device key.");
  }
  const [salt = "", nonce = "", ciphertext = "", tag = ""] = wrappedKey.split(".");
  const keyEncryptionKey = await deriveScryptKey(password, Buffer.from(salt, "base64url"));
  let deviceKey: Buffer;
  try {
    try {
      deviceKey = decryptWithKey(keyEncryptionKey, {
        nonce: Buffer.from(nonce, "base64url"),
        ciphertext: Buffer.from(ciphertext, "base64url"),
        tag: Buffer.from(tag, "base64url"),
      });
    } catch (error) {
      throw new VaultError("bad_key", "Wrong vault password.", { cause: error });
    }
  } finally {
    keyEncryptionKey.fill(0);
  }
  if (deviceKey.byteLength !== DEVICE_KEY_LENGTH) {
    deviceKey.fill(0);
    throw new VaultError("corrupt", "The wrapped device vault key has the wrong length.");
  }
  return deviceKey;
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function asVaultError(error: unknown, message: string): VaultError {
  return error instanceof VaultError ? error : new VaultError("corrupt", message, { cause: error });
}
