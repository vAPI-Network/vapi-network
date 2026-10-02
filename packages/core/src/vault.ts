import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { FileHandle } from "node:fs/promises";

import { privateKeyToAccount } from "viem/accounts";
import { z } from "zod";
import type { Hex } from "viem";

import {
  decryptWithKey,
  encryptWithKey,
  validatePrivateKey,
  type VapiPaymentAccount,
} from "./keystore.js";
import {
  deriveEvmPrivateKey,
  generateRecoveryPhrase,
  phraseToSeed,
  validateRecoveryPhrase,
} from "./hd.js";
import { walletNameSchema } from "./wallet-name.js";

export type VaultAccount =
  | {
      name: string;
      kind: "derived";
      index: number;
      address: `0x${string}`;
      createdAt: string;
    }
  | { name: string; kind: "imported"; address: `0x${string}`; createdAt: string };

export type VaultFile = {
  version: 2;
  kdf: "device-key";
  cipher: "aes-256-gcm";
  phrase: string;
  accounts: (VaultAccount & { key?: string })[];
  /** Monotonic high-water mark; absent in vaults written before account removal was supported. */
  nextDerivedIndex?: number;
  protected: boolean;
  wrappedKey?: string;
};

export type VaultErrorCode =
  | "not_found"
  | "name_taken"
  | "has_balance"
  | "bad_key"
  | "corrupt"
  | "already_protected"
  | "not_protected"
  | "password_required";

export class VaultError extends Error {
  readonly code: VaultErrorCode;

  constructor(code: VaultErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "VaultError";
    this.code = code;
  }
}

export type VaultOptions = {
  path: string;
  key: Uint8Array;
  /** Chain read used by removeAccount; removal fails closed when it is absent. */
  balanceOf?: (address: `0x${string}`) => Promise<bigint>;
  /** Injected clock for createdAt; defaults to () => new Date(). */
  now?: () => Date;
};

export interface Vault {
  accounts(): VaultAccount[];
  deriveAccount(name: string): Promise<VaultAccount>;
  importAccount(name: string, privateKey: `0x${string}`): Promise<VaultAccount>;
  removeAccount(name: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  signer(name: string): Promise<VapiPaymentAccount>;
  phrase(): Promise<string>;
  save(): Promise<void>;
}

type StoredDerivedAccount = Extract<VaultAccount, { kind: "derived" }>;
type StoredImportedAccount = Extract<VaultAccount, { kind: "imported" }> & { key: string };
type StoredAccount = StoredDerivedAccount | StoredImportedAccount;
export type StoredVaultFile = Omit<VaultFile, "accounts"> & { accounts: StoredAccount[] };
export type StoredVaultAccount = StoredVaultFile["accounts"][number];

const SEALED_FIELD_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u;
const WRAPPED_KEY_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u;
const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/u;
const VAULT_LOCK_TIMEOUT_MS = 2_000;
const STALE_VAULT_LOCK_MS = 30_000;
const sealedFieldSchema = z.string().regex(SEALED_FIELD_PATTERN);
const addressSchema = z.string().regex(ADDRESS_PATTERN);
const accountFields = {
  name: walletNameSchema,
  address: addressSchema,
  createdAt: z.string(),
};
const storedAccountSchema = z.discriminatedUnion("kind", [
  z
    .object({
      ...accountFields,
      kind: z.literal("derived"),
      index: z
        .number()
        .int()
        .nonnegative()
        .refine(Number.isSafeInteger, "Derived account index must be a safe integer."),
    })
    .strict(),
  z
    .object({
      ...accountFields,
      kind: z.literal("imported"),
      key: sealedFieldSchema,
    })
    .strict(),
]);
const vaultFileSchema = z
  .object({
    version: z.literal(2),
    kdf: z.literal("device-key"),
    cipher: z.literal("aes-256-gcm"),
    phrase: sealedFieldSchema,
    accounts: z.array(storedAccountSchema),
    nextDerivedIndex: z
      .number()
      .int()
      .nonnegative()
      .refine(Number.isSafeInteger, "Next derived account index must be a safe integer.")
      .optional(),
    protected: z.boolean(),
    wrappedKey: z.string().regex(WRAPPED_KEY_PATTERN).optional(),
  })
  .strict();

class DeviceVault implements Vault {
  private file: StoredVaultFile;
  private readonly path: string;
  private readonly key: Uint8Array;
  private readonly balanceOf: VaultOptions["balanceOf"];
  private readonly now: () => Date;

  constructor(options: VaultOptions, file: StoredVaultFile) {
    this.path = options.path;
    this.key = options.key;
    this.balanceOf = options.balanceOf;
    this.now = options.now ?? (() => new Date());
    this.file = file;
  }

  accounts(): VaultAccount[] {
    return this.file.accounts.map(copyAccount);
  }

  async deriveAccount(name: string): Promise<VaultAccount> {
    try {
      return await this.update(async (file) => {
        assertAvailableName(file, name);
        const index = nextDerivedIndex(file);
        const plaintext = decryptField(this.key, file.phrase);
        let seed: Uint8Array | undefined;
        let address: `0x${string}`;
        try {
          seed = phraseToSeed(plaintext.toString("utf8"));
          address = privateKeyToAccount(
            deriveEvmPrivateKey(seed, `m/44'/60'/0'/0/${index}`),
          ).address;
        } finally {
          seed?.fill(0);
          plaintext.fill(0);
        }
        const account: StoredDerivedAccount = {
          name,
          kind: "derived",
          index,
          address,
          createdAt: this.now().toISOString(),
        };
        file.accounts.push(account);
        file.nextDerivedIndex = index + 1;
        return copyAccount(account);
      });
    } catch (error) {
      throw asVaultError(error, "corrupt", "Unable to derive a vault account.");
    }
  }

  async importAccount(name: string, privateKey: `0x${string}`): Promise<VaultAccount> {
    try {
      return await this.update(async (file) => {
        assertAvailableName(file, name);
        let validated: Hex;
        let address: `0x${string}`;
        try {
          validated = validatePrivateKey(privateKey);
          address = privateKeyToAccount(validated).address;
        } catch (error) {
          throw new VaultError("bad_key", "The imported private key is not valid.", {
            cause: error,
          });
        }
        const plaintext = Buffer.from(validated.slice(2), "hex");
        let account: StoredImportedAccount;
        try {
          account = {
            name,
            kind: "imported",
            address,
            key: sealField(this.key, plaintext),
            createdAt: this.now().toISOString(),
          };
        } finally {
          plaintext.fill(0);
        }
        file.accounts.push(account);
        return copyAccount(account);
      });
    } catch (error) {
      throw asVaultError(error, "corrupt", "Unable to import a vault account.");
    }
  }

  async removeAccount(name: string): Promise<void> {
    try {
      await this.update(async (file) => {
        const account = file.accounts.find((candidate) => candidate.name === name);
        if (!account) {
          throw new VaultError("not_found", "No vault account has that name.");
        }
        if (!this.balanceOf) {
          throw new VaultError(
            "has_balance",
            "The account balance could not be verified, so the key was not removed.",
          );
        }
        if ((await this.balanceOf(account.address)) > 0n) {
          throw new VaultError(
            "has_balance",
            "This account still has a balance. Run vapi sweep before removing it.",
          );
        }
        // Vaults written before the high-water mark existed learn it before
        // the removed record becomes the only evidence of its derivation index.
        file.nextDerivedIndex = nextDerivedIndex(file);
        const currentIndex = file.accounts.findIndex((candidate) => candidate.name === name);
        if (currentIndex === -1) {
          throw new VaultError("not_found", "No vault account has that name.");
        }
        file.accounts.splice(currentIndex, 1);
      });
    } catch (error) {
      throw asVaultError(error, "corrupt", "Unable to remove the vault account.");
    }
  }

  async rename(from: string, to: string): Promise<void> {
    try {
      await this.update(async (file) => {
        const account = file.accounts.find((candidate) => candidate.name === from);
        if (!account) {
          throw new VaultError("not_found", "No vault account has that name.");
        }
        if (from === to) return;
        assertAccountName(to);
        if (file.accounts.some((candidate) => candidate.name === to)) {
          throw new VaultError("name_taken", "A vault account already has that name.");
        }
        account.name = to;
      });
    } catch (error) {
      throw asVaultError(error, "corrupt", "Unable to rename the vault account.");
    }
  }

  async signer(name: string): Promise<VapiPaymentAccount> {
    try {
      const latest = await readVaultFile(this.path, this.key);
      this.file = latest;
      const stored = latest.accounts.find((account) => account.name === name);
      if (!stored) {
        throw new VaultError("not_found", "No vault account has that name.");
      }
      let account: VapiPaymentAccount;
      if (stored.kind === "derived") {
        const plaintext = decryptField(this.key, latest.phrase);
        let seed: Uint8Array | undefined;
        try {
          seed = phraseToSeed(plaintext.toString("utf8"));
          // viem requires an immutable hex string; every byte buffer holding the secret is zeroed.
          account = privateKeyToAccount(
            deriveEvmPrivateKey(seed, `m/44'/60'/0'/0/${stored.index}`),
          ) as VapiPaymentAccount;
        } finally {
          seed?.fill(0);
          plaintext.fill(0);
        }
      } else {
        const plaintext = decryptField(this.key, stored.key);
        try {
          if (plaintext.byteLength !== 32) {
            throw new VaultError("corrupt", "An imported vault key has the wrong length.");
          }
          // viem requires an immutable hex string; the decrypted private-key buffer is zeroed below.
          const privateKey = `0x${plaintext.toString("hex")}` as Hex;
          account = privateKeyToAccount(privateKey) as VapiPaymentAccount;
        } finally {
          plaintext.fill(0);
        }
      }
      if (account.address.toLowerCase() !== stored.address.toLowerCase()) {
        throw new VaultError("corrupt", "A vault key does not match its stored address.");
      }
      return account;
    } catch (error) {
      throw asVaultError(error, "corrupt", "Unable to open the vault account signer.");
    }
  }

  async phrase(): Promise<string> {
    const latest = await readVaultFile(this.path, this.key);
    this.file = latest;
    const plaintext = decryptField(this.key, latest.phrase);
    try {
      try {
        return validateRecoveryPhrase(plaintext.toString("utf8"));
      } catch (error) {
        throw new VaultError("corrupt", "The vault recovery phrase is not valid.", {
          cause: error,
        });
      }
    } finally {
      plaintext.fill(0);
    }
  }

  async save(): Promise<void> {
    try {
      await this.update(async () => undefined);
    } catch (error) {
      throw asVaultError(error, "corrupt", "Unable to save the vault.");
    }
  }

  private resealSecrets(file: StoredVaultFile): StoredVaultFile {
    const phrase = decryptField(this.key, file.phrase);
    try {
      const accounts = file.accounts.map((account): StoredAccount => {
        if (account.kind === "derived") return { ...account };
        const privateKey = decryptField(this.key, account.key);
        try {
          if (privateKey.byteLength !== 32) {
            throw new VaultError("corrupt", "An imported vault key has the wrong length.");
          }
          return { ...account, key: sealField(this.key, privateKey) };
        } finally {
          privateKey.fill(0);
        }
      });
      return {
        ...file,
        phrase: sealField(this.key, phrase),
        accounts,
      };
    } finally {
      phrase.fill(0);
    }
  }

  private async update<T>(operation: (file: StoredVaultFile) => Promise<T>): Promise<T> {
    return await withVaultLock(this.path, async () => {
      const latest = await readVaultFile(this.path, this.key);
      const result = await operation(latest);
      const rewritten = this.resealSecrets(latest);
      await writeVaultFile(this.path, rewritten);
      this.file = rewritten;
      return result;
    });
  }
}

export async function createVault(args: VaultOptions & { phrase?: string }): Promise<Vault> {
  assertVaultKey(args.key);
  let phrase: string;
  if (args.phrase === undefined) {
    try {
      phrase = generateRecoveryPhrase();
    } catch (error) {
      throw new VaultError("corrupt", "Unable to generate a vault recovery phrase.", {
        cause: error,
      });
    }
  } else {
    phrase = validateRecoveryPhrase(args.phrase);
  }
  try {
    return await withVaultLock(args.path, async () => {
      await refuseExistingVault(args.path);
      const plaintext = Buffer.from(phrase, "utf8");
      let sealedPhrase: string;
      try {
        sealedPhrase = sealField(args.key, plaintext);
      } finally {
        plaintext.fill(0);
      }
      const file: StoredVaultFile = {
        version: 2,
        kdf: "device-key",
        cipher: "aes-256-gcm",
        phrase: sealedPhrase,
        accounts: [],
        nextDerivedIndex: 0,
        protected: false,
      };
      await writeVaultFile(args.path, file);
      return new DeviceVault(args, file);
    });
  } catch (error) {
    throw asVaultError(error, "corrupt", "Unable to create the vault.");
  }
}

export async function openVault(args: VaultOptions): Promise<Vault> {
  assertVaultKey(args.key);
  return new DeviceVault(args, await readVaultFile(args.path, args.key));
}

/**
 * Puts a stored account record back into the vault under the vault lock: the exact
 * record `readVaultFileUnlocked` returned before `removeAccount` took it out.
 * Refuses (VaultError "name_taken") a name that is already present or, for a
 * derived record, an index already in use; refuses ("bad_key") an imported record
 * whose key does not decrypt to its address with this device key. Returns the
 * public VaultAccount.
 */
export async function reinstateVaultAccount(args: {
  path: string;
  key: Uint8Array;
  account: StoredVaultAccount;
}): Promise<VaultAccount> {
  const parsedAccount = storedAccountSchema.safeParse(args.account);
  if (!parsedAccount.success) {
    throw new VaultError("corrupt", "The stored vault account has an invalid structure.", {
      cause: parsedAccount.error,
    });
  }
  assertVaultKey(args.key);

  try {
    return await withVaultLock(args.path, async () => {
      const file = await readVaultFile(args.path, args.key);
      const account = parsedAccount.data as StoredVaultAccount;
      assertAvailableName(file, account.name);
      if (
        account.kind === "derived" &&
        file.accounts.some(
          (candidate) => candidate.kind === "derived" && candidate.index === account.index,
        )
      ) {
        throw new VaultError("name_taken", "A vault account already uses that derived index.");
      }
      if (account.kind === "derived") validateStoredDerivedAccount(args.key, file, account);
      else validateStoredImportedAccount(args.key, account);

      const updated = parseVaultFile(
        JSON.stringify({
          ...file,
          accounts: [...file.accounts, account],
          ...(account.kind === "derived"
            ? { nextDerivedIndex: Math.max(nextDerivedIndex(file), account.index + 1) }
            : {}),
        }),
      );
      await writeVaultFile(args.path, updated);
      return copyAccount(account);
    });
  } catch (error) {
    throw asVaultError(error, "corrupt", "Unable to reinstate the vault account.");
  }
}

/** Human-only: opens the vault and returns the recovery phrase. Re-exported ONLY from secrets.ts. */
export async function exportVaultPhrase(args: VaultOptions): Promise<string> {
  return await (await openVault(args)).phrase();
}

/** Human-only: decrypts one named account's private key. Re-exported ONLY from secrets.ts. */
export async function exportVaultAccountKey(args: {
  path: string;
  key: Uint8Array;
  name: string;
}): Promise<`0x${string}`> {
  assertVaultKey(args.key);
  try {
    const file = await readVaultFile(args.path, args.key);
    const account = file.accounts.find((candidate) => candidate.name === args.name);
    if (!account) {
      throw new VaultError("not_found", "No vault account has that name.");
    }

    let privateKey: `0x${string}`;
    if (account.kind === "derived") {
      const plaintext = decryptField(args.key, file.phrase);
      let seed: Uint8Array | undefined;
      try {
        seed = phraseToSeed(plaintext.toString("utf8"));
        privateKey = deriveEvmPrivateKey(seed, `m/44'/60'/0'/0/${account.index}`);
      } finally {
        seed?.fill(0);
        plaintext.fill(0);
      }
    } else {
      const plaintext = decryptField(args.key, account.key);
      try {
        if (plaintext.byteLength !== 32) {
          throw new VaultError("corrupt", "An imported vault key has the wrong length.");
        }
        privateKey = `0x${plaintext.toString("hex")}`;
      } finally {
        plaintext.fill(0);
      }
    }

    if (privateKeyToAccount(privateKey).address.toLowerCase() !== account.address.toLowerCase()) {
      throw new VaultError("corrupt", "A vault key does not match its stored address.");
    }
    return privateKey;
  } catch (error) {
    throw asVaultError(error, "corrupt", "Unable to export the vault account key.");
  }
}

/**
 * One swarm member's own private key, for a member bundle that runs it on a
 * remote sandbox. It is `exportVaultAccountKey` under the name the remote path
 * uses: one account, never the phrase. Which accounts may leave the machine is
 * the caller's policy; this function refuses nothing beyond an unknown name.
 */
export async function exportMemberKey(args: {
  path: string;
  key: Uint8Array;
  name: string;
}): Promise<`0x${string}`> {
  return await exportVaultAccountKey(args);
}

function assertVaultKey(key: Uint8Array): void {
  if (key.byteLength !== 32) {
    throw new VaultError("bad_key", "A device vault key must contain exactly 32 bytes.");
  }
}

function assertAccountName(name: string): void {
  const parsed = walletNameSchema.safeParse(name);
  if (!parsed.success) {
    throw new VaultError("name_taken", "The vault account name is not valid.", {
      cause: parsed.error,
    });
  }
}

function assertAvailableName(file: StoredVaultFile, name: string): void {
  assertAccountName(name);
  if (file.accounts.some((account) => account.name === name)) {
    throw new VaultError("name_taken", "A vault account already has that name.");
  }
}

function nextDerivedIndex(file: StoredVaultFile): number {
  let next = file.nextDerivedIndex ?? 0;
  for (const account of file.accounts) {
    if (account.kind === "derived") next = Math.max(next, account.index + 1);
  }
  return next;
}

function copyAccount(account: StoredAccount): VaultAccount {
  if (account.kind === "derived") return { ...account };
  return {
    name: account.name,
    kind: account.kind,
    address: account.address,
    createdAt: account.createdAt,
  };
}

function sealField(key: Uint8Array, plaintext: Uint8Array): string {
  const { nonce, ciphertext, tag } = encryptWithKey(key, plaintext);
  return [nonce, ciphertext, tag].map((part) => part.toString("base64url")).join(".");
}

function openField(key: Uint8Array, value: string): Buffer {
  const [nonce = "", ciphertext = "", tag = ""] = value.split(".");
  return decryptWithKey(key, {
    nonce: Buffer.from(nonce, "base64url"),
    ciphertext: Buffer.from(ciphertext, "base64url"),
    tag: Buffer.from(tag, "base64url"),
  });
}

function decryptField(key: Uint8Array, value: string): Buffer {
  try {
    return openField(key, value);
  } catch (error) {
    throw new VaultError("bad_key", "Unable to decrypt the vault with this device key.", {
      cause: error,
    });
  }
}

function decryptPhraseForOpen(key: Uint8Array, phrase: string): Buffer {
  try {
    return openField(key, phrase);
  } catch (error) {
    throw new VaultError("bad_key", "Unable to decrypt the vault with this device key.", {
      cause: error,
    });
  }
}

function validateStoredImportedAccount(key: Uint8Array, account: StoredImportedAccount): void {
  let plaintext: Buffer | undefined;
  try {
    plaintext = decryptField(key, account.key);
    if (plaintext.byteLength !== 32) {
      throw new VaultError("bad_key", "The stored imported key has the wrong length.");
    }
    let address: `0x${string}`;
    try {
      address = privateKeyToAccount(`0x${plaintext.toString("hex")}` as Hex).address;
    } catch (error) {
      throw new VaultError("bad_key", "The stored imported key is not valid.", {
        cause: error,
      });
    }
    if (address.toLowerCase() !== account.address.toLowerCase()) {
      throw new VaultError("bad_key", "The stored imported key does not match its address.");
    }
  } finally {
    plaintext?.fill(0);
  }
}

function validateStoredDerivedAccount(
  key: Uint8Array,
  file: StoredVaultFile,
  account: StoredDerivedAccount,
): void {
  const plaintext = decryptField(key, file.phrase);
  let seed: Uint8Array | undefined;
  try {
    seed = phraseToSeed(plaintext.toString("utf8"));
    const address = privateKeyToAccount(
      deriveEvmPrivateKey(seed, `m/44'/60'/0'/0/${account.index}`),
    ).address;
    if (address.toLowerCase() !== account.address.toLowerCase()) {
      throw new VaultError("bad_key", "The stored derived account does not match this vault.");
    }
  } finally {
    seed?.fill(0);
    plaintext.fill(0);
  }
}

function parseVaultFile(raw: string): StoredVaultFile {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new VaultError("corrupt", "The vault file is not valid JSON.", { cause: error });
  }
  const parsed = vaultFileSchema.safeParse(value);
  if (!parsed.success) {
    throw new VaultError("corrupt", "The vault file has an invalid structure.", {
      cause: parsed.error,
    });
  }
  if (parsed.data.protected !== (parsed.data.wrappedKey !== undefined)) {
    throw new VaultError("corrupt", "The vault protection metadata is inconsistent.");
  }
  const names = new Set<string>();
  const indexes = new Set<number>();
  for (const account of parsed.data.accounts) {
    if (names.has(account.name)) {
      throw new VaultError("corrupt", "The vault file contains duplicate account names.");
    }
    names.add(account.name);
    if (account.kind === "derived") {
      if (indexes.has(account.index)) {
        throw new VaultError("corrupt", "The vault file contains duplicate derived indexes.");
      }
      indexes.add(account.index);
    }
  }
  return parsed.data as StoredVaultFile;
}

async function readVaultFile(path: string, key: Uint8Array): Promise<StoredVaultFile> {
  const file = await readVaultFileUnlocked(path);
  const plaintext = decryptPhraseForOpen(key, file.phrase);
  try {
    try {
      validateRecoveryPhrase(plaintext.toString("utf8"));
    } catch (error) {
      throw new VaultError("corrupt", "The vault recovery phrase is not valid.", {
        cause: error,
      });
    }
  } finally {
    plaintext.fill(0);
  }
  return file;
}

export async function readVaultFileUnlocked(path: string): Promise<StoredVaultFile> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isMissingFile(error)) {
      throw new VaultError("not_found", "No vault file was found at the requested path.", {
        cause: error,
      });
    }
    throw new VaultError("corrupt", "Unable to read the vault file.", { cause: error });
  }
  return parseVaultFile(raw);
}

async function refuseExistingVault(path: string): Promise<void> {
  try {
    await stat(path);
  } catch (error) {
    if (isMissingFile(error)) return;
    throw new VaultError("corrupt", "Unable to check whether the vault already exists.", {
      cause: error,
    });
  }
  throw new VaultError("corrupt", "A vault already exists at the requested path.");
}

export async function writeVaultFile(path: string, file: StoredVaultFile): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(file, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** Serializes vault read-modify-write transactions across CLI and MCP processes. */
export async function withVaultLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const lockPath = `${path}.lock`;
  const deadline = Date.now() + VAULT_LOCK_TIMEOUT_MS;
  let handle: FileHandle | undefined;

  while (!handle) {
    try {
      handle = await open(lockPath, "wx", 0o600);
    } catch (error) {
      if (!isExistingFile(error)) throw error;
      await removeStaleVaultLock(lockPath);
      if (Date.now() >= deadline) {
        throw new VaultError("corrupt", "Timed out waiting for the vault lock.");
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  try {
    return await operation();
  } finally {
    await handle.close();
    await unlink(lockPath).catch(() => undefined);
  }
}

async function removeStaleVaultLock(path: string): Promise<void> {
  try {
    const metadata = await stat(path);
    if (Date.now() - metadata.mtimeMs > STALE_VAULT_LOCK_MS) await unlink(path);
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    Reflect.get(error, "code") === "ENOENT"
  );
}

function isExistingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    Reflect.get(error, "code") === "EEXIST"
  );
}

function asVaultError(error: unknown, code: VaultErrorCode, message: string): VaultError {
  return error instanceof VaultError ? error : new VaultError(code, message, { cause: error });
}
