import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { decryptPrivateKey, encryptPrivateKey, KeystoreError, unlockKeystore } from "./keystore.js";

const PRIVATE_KEY = "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" as Hex;
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("vAPI keystore", () => {
  it("round-trips an encrypted key through the JSON keystore file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vapi-mcp-keystore-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "keystore.json");
    const keystore = await encryptPrivateKey(PRIVATE_KEY, "correct horse battery staple");
    await writeFile(path, JSON.stringify(keystore), { mode: 0o600 });

    const account = await unlockKeystore("correct horse battery staple", path);

    expect(account.address).toBe(privateKeyToAccount(PRIVATE_KEY).address);
    expect(await decryptPrivateKey(keystore, "correct horse battery staple")).toBe(PRIVATE_KEY);
    expect(keystore.crypto.kdfParams).toEqual({
      n: 2 ** 15,
      r: 8,
      p: 1,
      dkLen: 32,
    });
    expect(keystore.crypto.cipher).toBe("aes-256-gcm");
    expect(keystore).toMatchObject({
      version: 2,
      keys: {
        evm: { type: "secp256k1", address: privateKeyToAccount(PRIVATE_KEY).address },
      },
    });
    expect(JSON.stringify(keystore)).not.toContain(PRIVATE_KEY.slice(2));
  });

  it("migrates a v1 file to the encrypted v2 key bundle after a successful unlock", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vapi-keystore-v1-migration-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "keystore.json");
    await writeFile(path, JSON.stringify(LEGACY_V1_KEYSTORE), { mode: 0o600 });

    const account = await unlockKeystore("migration-passphrase", path);
    const migrated = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;

    expect(account.address).toBe(privateKeyToAccount(PRIVATE_KEY).address);
    expect(migrated).toMatchObject({
      version: 2,
      address: account.address,
      keys: { evm: { type: "secp256k1", address: account.address } },
    });
    expect(JSON.stringify(migrated)).not.toContain(PRIVATE_KEY.slice(2));
  });

  it("fails closed with a wrong passphrase", async () => {
    const keystore = await encryptPrivateKey(PRIVATE_KEY, "right passphrase");

    await expect(decryptPrivateKey(keystore, "wrong passphrase")).rejects.toBeInstanceOf(
      KeystoreError,
    );
    await expect(decryptPrivateKey(keystore, "wrong passphrase")).rejects.toThrow(
      "wrong passphrase or corrupt file",
    );
  });

  it("rejects a shortened AES-GCM authentication tag", async () => {
    const keystore = await encryptPrivateKey(PRIVATE_KEY, "right passphrase");
    const shortenedTag = Buffer.from(keystore.crypto.authTag, "base64").subarray(0, 12);

    await expect(
      decryptPrivateKey(
        {
          ...keystore,
          crypto: { ...keystore.crypto, authTag: shortenedTag.toString("base64") },
        },
        "right passphrase",
      ),
    ).rejects.toThrow("wrong passphrase or corrupt file");
  });
});

const LEGACY_V1_KEYSTORE = {
  version: 1,
  address: "0xFCAd0B19bB29D4674531d6f115237E16AfCE377c",
  crypto: {
    cipher: "aes-256-gcm",
    ciphertext:
      "itpP1e1eiE4eC41C82lYPVkrnzqP/8ec8zMZnXei6bP0vcnO6a05uK5CgGRYdgNFjJG/QhwHV7nkBkI+EdTlEA==",
    iv: "42UyghblMwQ+qKnt",
    authTag: "sQRKSSucPf9dDaxdChJQEw==",
    kdf: "scrypt",
    salt: "Nrqua6q962F2O5ubIEzZiyK6qIUOpZOYM0nDg0IS9Cw=",
    kdfParams: { n: 2 ** 15, r: 8, p: 1, dkLen: 32 },
  },
} as const;
