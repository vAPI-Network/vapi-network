import { createCipheriv, createDecipheriv, randomBytes, scrypt } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { stdin, stderr } from "node:process";

import { createKeyPairSignerFromPrivateKeyBytes, type KeyPairSigner } from "@solana/kit";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { z } from "zod";
import type { Hex } from "viem";

import { getVapiPaths, isMissingFile, migrateLegacyVapiHome } from "./config.js";

const SCRYPT_N = 2 ** 15;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 32;
const SCRYPT_MAX_MEMORY = 64 * 1024 * 1024;
const AUTH_TAG_LENGTH = 16;

const cryptoSchema = z.object({
  cipher: z.literal("aes-256-gcm"),
  ciphertext: z.string(),
  iv: z.string(),
  authTag: z.string(),
  kdf: z.literal("scrypt"),
  salt: z.string(),
  kdfParams: z.object({
    n: z.literal(SCRYPT_N),
    r: z.literal(SCRYPT_R),
    p: z.literal(SCRYPT_P),
    dkLen: z.literal(KEY_LENGTH),
  }),
});

const legacyKeystoreSchema = z.object({
  version: z.literal(1),
  address: z.string(),
  crypto: cryptoSchema,
});

const keystoreSchema = z.object({
  version: z.literal(2),
  address: z.string(),
  keys: z.object({
    evm: z.object({
      type: z.literal("secp256k1"),
      address: z.string(),
    }),
    solana: z
      .object({
        type: z.literal("ed25519"),
        address: z.string(),
      })
      .optional(),
  }),
  crypto: cryptoSchema,
});

export type VapiKeystore = z.infer<typeof keystoreSchema>;
export type LegacyVapiKeystore = z.infer<typeof legacyKeystoreSchema>;
/** @deprecated Use VapiKeystore. */
export type AgentCashKeystore = VapiKeystore;

export type VapiPaymentAccount = ReturnType<typeof privateKeyToAccount> & {
  readonly solana?: KeyPairSigner;
};

type AnyVapiKeystore = VapiKeystore | LegacyVapiKeystore;

const encryptedKeysSchema = z.object({
  keys: z.object({
    evm: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
    solana: z.string().optional(),
  }),
});

type EncryptedKeys = z.infer<typeof encryptedKeysSchema>["keys"];

export class KeystoreError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "KeystoreError";
  }
}

async function deriveKey(passphrase: string, salt: Buffer): Promise<Buffer> {
  return await new Promise<Buffer>((resolve, reject) => {
    scrypt(
      passphrase,
      salt,
      KEY_LENGTH,
      {
        N: SCRYPT_N,
        r: SCRYPT_R,
        p: SCRYPT_P,
        maxmem: SCRYPT_MAX_MEMORY,
      },
      (error, derivedKey) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(derivedKey);
      },
    );
  });
}

export async function encryptPrivateKey(
  privateKey: Hex,
  passphrase: string,
): Promise<VapiKeystore> {
  return await encryptKeys({ evm: privateKey }, passphrase);
}

async function encryptKeys(keys: EncryptedKeys, passphrase: string): Promise<VapiKeystore> {
  if (passphrase.length === 0) {
    throw new KeystoreError("Keystore passphrase cannot be empty.");
  }

  const salt = randomBytes(32);
  const iv = randomBytes(12);
  const key = await deriveKey(passphrase, salt);
  const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: AUTH_TAG_LENGTH });
  const plaintext = JSON.stringify({ keys });
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const account = privateKeyToAccount(keys.evm as Hex);
  const solana = keys.solana
    ? await createSolanaSigner(Buffer.from(keys.solana, "base64"))
    : undefined;

  key.fill(0);

  return {
    version: 2,
    address: account.address,
    keys: {
      evm: { type: "secp256k1", address: account.address },
      ...(solana ? { solana: { type: "ed25519", address: solana.address } } : {}),
    },
    crypto: {
      cipher: "aes-256-gcm",
      ciphertext: ciphertext.toString("base64"),
      iv: iv.toString("base64"),
      authTag: authTag.toString("base64"),
      kdf: "scrypt",
      salt: salt.toString("base64"),
      kdfParams: {
        n: SCRYPT_N,
        r: SCRYPT_R,
        p: SCRYPT_P,
        dkLen: KEY_LENGTH,
      },
    },
  };
}

export async function decryptPrivateKey(keystore: VapiKeystore, passphrase: string): Promise<Hex> {
  return (await decryptKeys(keystore, passphrase)).evm as Hex;
}

async function decryptKeys(keystore: AnyVapiKeystore, passphrase: string): Promise<EncryptedKeys> {
  const parsed = parseAnyKeystore(keystore);
  const salt = Buffer.from(parsed.crypto.salt, "base64");
  const iv = Buffer.from(parsed.crypto.iv, "base64");
  const authTag = Buffer.from(parsed.crypto.authTag, "base64");
  const ciphertext = Buffer.from(parsed.crypto.ciphertext, "base64");
  const key = await deriveKey(passphrase, salt);

  try {
    if (authTag.length !== AUTH_TAG_LENGTH) {
      throw new Error(`Expected a ${AUTH_TAG_LENGTH}-byte AES-GCM authentication tag.`);
    }
    const decipher = createDecipheriv("aes-256-gcm", key, iv, {
      authTagLength: AUTH_TAG_LENGTH,
    });
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString(
      "utf8",
    );
    const keys =
      parsed.version === 1
        ? ({ evm: `0x${plaintext}` } satisfies EncryptedKeys)
        : encryptedKeysSchema.parse(JSON.parse(plaintext)).keys;
    const account = privateKeyToAccount(keys.evm as Hex);
    if (account.address.toLowerCase() !== parsed.address.toLowerCase()) {
      throw new Error("Decrypted key does not match the stored address.");
    }
    if (
      parsed.version === 2 &&
      parsed.keys.evm.address.toLowerCase() !== account.address.toLowerCase()
    ) {
      throw new Error("Decrypted EVM key does not match the v2 key metadata.");
    }
    if (parsed.version === 2 && Boolean(parsed.keys.solana) !== Boolean(keys.solana)) {
      throw new Error("Encrypted Solana key does not match the v2 key metadata.");
    }
    if (keys.solana) {
      const signer = await createSolanaSigner(Buffer.from(keys.solana, "base64"));
      if (parsed.version === 2 && parsed.keys.solana?.address !== signer.address) {
        throw new Error("Decrypted Solana key does not match the v2 key metadata.");
      }
    }
    return keys;
  } catch (error) {
    throw new KeystoreError("Unable to unlock keystore: wrong passphrase or corrupt file.", {
      cause: error,
    });
  } finally {
    key.fill(0);
  }
}

export async function createKeystore(
  passphrase: string,
  path = getVapiPaths().keystore,
  options: { enableSolana?: boolean } = {},
): Promise<VapiPaymentAccount> {
  if (!process.env.VAPI_HOME?.trim() && path === getVapiPaths().keystore) {
    await migrateLegacyVapiHome({ targetDirectory: getVapiPaths().directory });
  }
  try {
    await stat(path);
    throw new KeystoreError(
      `Keystore already exists at ${path}. Refusing to replace the local payment key.`,
    );
  } catch (error) {
    if (!isMissingFile(error)) {
      throw error;
    }
  }

  const privateKey = generatePrivateKey();
  const solanaSeed = options.enableSolana ? randomBytes(32) : undefined;
  const keystore = await encryptKeys(
    {
      evm: privateKey,
      ...(solanaSeed ? { solana: solanaSeed.toString("base64") } : {}),
    },
    passphrase,
  );
  solanaSeed?.fill(0);
  await writeKeystore(path, keystore, true);
  return await paymentAccountFromKeys(await decryptKeys(keystore, passphrase));
}

export async function unlockKeystore(
  passphrase: string,
  path = getVapiPaths().keystore,
): Promise<VapiPaymentAccount> {
  if (!process.env.VAPI_HOME?.trim() && path === getVapiPaths().keystore) {
    await migrateLegacyVapiHome({ targetDirectory: getVapiPaths().directory });
  }
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isMissingFile(error)) {
      throw new KeystoreError(`No vAPI keystore found at ${path}. Run vapi init.`);
    }
    throw error;
  }
  const keystore = parseAnyKeystore(JSON.parse(raw));
  const keys = await decryptKeys(keystore, passphrase);
  if (keystore.version === 1) {
    await writeKeystore(path, await encryptKeys(keys, passphrase), false);
  }
  return await paymentAccountFromKeys(keys);
}

/** Lazily adds a locally generated Ed25519 seed without replacing the EVM key. */
export async function enableSolanaKey(
  passphrase: string,
  path = getVapiPaths().keystore,
): Promise<VapiPaymentAccount> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isMissingFile(error)) {
      throw new KeystoreError(`No vAPI keystore found at ${path}. Run vapi init.`);
    }
    throw error;
  }
  const existing = parseAnyKeystore(JSON.parse(raw));
  const keys = await decryptKeys(existing, passphrase);
  if (!keys.solana) {
    const seed = randomBytes(32);
    keys.solana = seed.toString("base64");
    seed.fill(0);
    await writeKeystore(path, await encryptKeys(keys, passphrase), false);
  } else if (existing.version === 1) {
    await writeKeystore(path, await encryptKeys(keys, passphrase), false);
  }
  return await paymentAccountFromKeys(keys);
}

function parseAnyKeystore(value: unknown): AnyVapiKeystore {
  const version =
    typeof value === "object" && value !== null ? Reflect.get(value, "version") : undefined;
  return version === 1 ? legacyKeystoreSchema.parse(value) : keystoreSchema.parse(value);
}

async function paymentAccountFromKeys(keys: EncryptedKeys): Promise<VapiPaymentAccount> {
  const account = privateKeyToAccount(keys.evm as Hex) as VapiPaymentAccount;
  if (keys.solana) {
    const solana = await createSolanaSigner(Buffer.from(keys.solana, "base64"));
    Object.defineProperty(account, "solana", {
      configurable: false,
      enumerable: false,
      writable: false,
      value: solana,
    });
  }
  return account;
}

async function createSolanaSigner(seed: Uint8Array): Promise<KeyPairSigner> {
  if (seed.byteLength !== 32) {
    throw new Error("Stored Solana Ed25519 seed must contain exactly 32 bytes.");
  }
  const privateKey = new Uint8Array(seed);
  try {
    return await createKeyPairSignerFromPrivateKeyBytes(privateKey);
  } finally {
    privateKey.fill(0);
    seed.fill(0);
  }
}

async function writeKeystore(path: string, keystore: VapiKeystore, exclusive: boolean) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(keystore, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  if (exclusive) {
    try {
      await stat(path);
      throw new KeystoreError(
        `Keystore already exists at ${path}. Refusing to replace the local payment key.`,
      );
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }
  }
  await rename(temporaryPath, path);
}

export async function getKeystorePassphrase(options?: { confirm?: boolean }): Promise<string> {
  const fromEnvironment = process.env.VAPI_KEYSTORE_PASSWORD;
  if (fromEnvironment !== undefined) {
    if (fromEnvironment.length === 0) {
      throw new KeystoreError("VAPI_KEYSTORE_PASSWORD cannot be empty.");
    }
    return fromEnvironment;
  }

  const first = await promptForPassphrase("Keystore passphrase: ");
  if (!first) {
    throw new KeystoreError("Keystore passphrase cannot be empty.");
  }
  if (options?.confirm) {
    const second = await promptForPassphrase("Confirm passphrase: ");
    if (first !== second) {
      throw new KeystoreError("Passphrases do not match.");
    }
  }
  return first;
}

async function promptForPassphrase(prompt: string): Promise<string> {
  if (!stdin.isTTY || typeof stdin.setRawMode !== "function") {
    throw new KeystoreError(
      "No interactive terminal is available for the keystore prompt. Set VAPI_KEYSTORE_PASSWORD.",
    );
  }

  stderr.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");

  return await new Promise<string>((resolve, reject) => {
    let value = "";
    const cleanup = () => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      stderr.write("\n");
    };
    const onData = (chunk: string) => {
      for (const character of chunk) {
        if (character === "\u0003") {
          cleanup();
          reject(new KeystoreError("Passphrase prompt cancelled."));
          return;
        }
        if (character === "\r" || character === "\n") {
          cleanup();
          resolve(value);
          return;
        }
        if (character === "\u007f" || character === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        if (character >= " ") {
          value += character;
        }
      }
    };
    stdin.on("data", onData);
  });
}
