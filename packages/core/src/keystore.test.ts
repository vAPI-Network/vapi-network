import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { createKeyPairSignerFromBytes, getBase58Encoder } from "@solana/kit";

import {
  createKeystore,
  createKeystoreWithPhrase,
  decryptPrivateKey,
  enableSolanaKey,
  encryptPrivateKey,
  exportKeystoreKeys,
  exportRecoveryPhrase,
  KeystoreError,
  readKeystoreAddress,
  unlockKeystore,
} from "./keystore.js";

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

describe("keystore export", () => {
  it("exports the EVM key as hex and the Solana key as a base58 64-byte secret", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vapi-keystore-export-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "keystore.json");
    const account = await createKeystore("export-passphrase", path, { enableSolana: true });

    const exported = await exportKeystoreKeys("export-passphrase", path);

    expect(exported.evm.address).toBe(account.address);
    expect(privateKeyToAccount(exported.evm.privateKey).address).toBe(account.address);
    expect(exported.solana?.address).toBe(account.solana?.address);
    const secretKey = Uint8Array.from(getBase58Encoder().encode(exported.solana?.secretKey ?? ""));
    expect(secretKey).toHaveLength(64);
    const signer = await createKeyPairSignerFromBytes(secretKey);
    expect(signer.address).toBe(account.solana?.address);
  });

  it("omits Solana when the keystore has no Ed25519 seed and refuses a wrong passphrase", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vapi-keystore-export-evm-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "keystore.json");
    await createKeystore("export-passphrase", path);

    expect((await exportKeystoreKeys("export-passphrase", path)).solana).toBeUndefined();
    await expect(exportKeystoreKeys("wrong-passphrase", path)).rejects.toThrow(KeystoreError);
    await expect(
      exportKeystoreKeys("export-passphrase", join(directory, "absent.json")),
    ).rejects.toThrow(/Run vapi init/);
  });

  it("reads the stored address without the passphrase", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vapi-keystore-address-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "keystore.json");
    const account = await createKeystore("address-passphrase", path);

    expect(await readKeystoreAddress(path)).toBe(account.address);
    expect(await readKeystoreAddress(join(directory, "absent.json"))).toBeUndefined();
    await writeFile(join(directory, "broken.json"), "{not json", { mode: 0o600 });
    expect(await readKeystoreAddress(join(directory, "broken.json"))).toBeUndefined();
  });
});

/** The phrase every wallet documents its derivation with; see hd.test.ts. */
const TEST_PHRASE =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const TEST_PHRASE_EVM_ADDRESS = "0x9858EfFD232B4033E47d90003D41EC34EcaEda94";
const TEST_PHRASE_SOLANA_ADDRESS = "HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk";

async function temporaryKeystorePath(name: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), `vapi-keystore-${name}-`));
  temporaryDirectories.push(directory);
  return join(directory, "keystore.json");
}

describe("keystore version 3", () => {
  it("creates a wallet from a recovery phrase and unlocks it again", async () => {
    const path = await temporaryKeystorePath("v3");

    const created = await createKeystoreWithPhrase("v3-passphrase", path);
    const unlocked = await unlockKeystore("v3-passphrase", path);
    const file = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;

    expect(created.recoveryPhrase.split(" ")).toHaveLength(12);
    expect(unlocked.address).toBe(created.account.address);
    expect(unlocked.solana).toBeUndefined();
    expect(file).toMatchObject({
      version: 3,
      address: created.account.address,
      keys: {
        evm: {
          type: "secp256k1",
          address: created.account.address,
          path: "m/44'/60'/0'/0/0",
        },
      },
    });
    expect(file.keys).not.toHaveProperty("solana");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("keeps both accounts on one phrase and restores them from the words", async () => {
    const path = await temporaryKeystorePath("v3-solana");

    const created = await createKeystoreWithPhrase("v3-passphrase", path, {
      phrase: TEST_PHRASE,
      enableSolana: true,
    });
    const unlocked = await unlockKeystore("v3-passphrase", path);
    const file = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;

    expect(created.recoveryPhrase).toBe(TEST_PHRASE);
    expect(created.account.address).toBe(TEST_PHRASE_EVM_ADDRESS);
    expect(created.account.solana?.address).toBe(TEST_PHRASE_SOLANA_ADDRESS);
    expect(unlocked.address).toBe(TEST_PHRASE_EVM_ADDRESS);
    expect(unlocked.solana?.address).toBe(TEST_PHRASE_SOLANA_ADDRESS);
    expect(file).toMatchObject({
      keys: {
        solana: {
          type: "ed25519",
          address: TEST_PHRASE_SOLANA_ADDRESS,
          path: "m/44'/501'/0'/0'",
        },
      },
    });
    expect(await readKeystoreAddress(path)).toBe(TEST_PHRASE_EVM_ADDRESS);
  });

  it("normalises an imported phrase and refuses an invalid one", async () => {
    const path = await temporaryKeystorePath("v3-import");

    const created = await createKeystoreWithPhrase("v3-passphrase", path, {
      phrase: `  ${TEST_PHRASE.toUpperCase()}  `,
    });

    expect(created.recoveryPhrase).toBe(TEST_PHRASE);
    expect(created.account.address).toBe(TEST_PHRASE_EVM_ADDRESS);
    await expect(
      createKeystoreWithPhrase("v3-passphrase", await temporaryKeystorePath("v3-bad"), {
        phrase: "abandon abandon abandon",
      }),
    ).rejects.toThrow(KeystoreError);
  });

  it("adds the Solana account from the phrase it already has", async () => {
    const path = await temporaryKeystorePath("v3-enable");
    await createKeystoreWithPhrase("v3-passphrase", path, { phrase: TEST_PHRASE });

    const enabled = await enableSolanaKey("v3-passphrase", path);
    const again = await enableSolanaKey("v3-passphrase", path);

    expect(enabled.address).toBe(TEST_PHRASE_EVM_ADDRESS);
    expect(enabled.solana?.address).toBe(TEST_PHRASE_SOLANA_ADDRESS);
    expect(again.solana?.address).toBe(TEST_PHRASE_SOLANA_ADDRESS);
    expect(await exportRecoveryPhrase("v3-passphrase", path)).toBe(TEST_PHRASE);
  });

  it("exports both private keys and the recovery phrase", async () => {
    const path = await temporaryKeystorePath("v3-export");
    const created = await createKeystoreWithPhrase("v3-passphrase", path, { enableSolana: true });

    const exported = await exportKeystoreKeys("v3-passphrase", path);

    expect(exported.evm.address).toBe(created.account.address);
    expect(privateKeyToAccount(exported.evm.privateKey).address).toBe(created.account.address);
    expect(exported.solana?.address).toBe(created.account.solana?.address);
    const secretKey = Uint8Array.from(getBase58Encoder().encode(exported.solana?.secretKey ?? ""));
    expect(secretKey).toHaveLength(64);
    expect((await createKeyPairSignerFromBytes(secretKey)).address).toBe(
      created.account.solana?.address,
    );
    expect(await exportRecoveryPhrase("v3-passphrase", path)).toBe(created.recoveryPhrase);
  });

  it("fails closed on a wrong passphrase and never writes a secret in clear", async () => {
    const path = await temporaryKeystorePath("v3-secrets");
    const created = await createKeystoreWithPhrase("v3-passphrase", path, {
      phrase: TEST_PHRASE,
      enableSolana: true,
    });
    const exported = await exportKeystoreKeys("v3-passphrase", path);
    const file = await readFile(path, "utf8");

    await expect(unlockKeystore("wrong-passphrase", path)).rejects.toThrow(KeystoreError);
    await expect(exportRecoveryPhrase("wrong-passphrase", path)).rejects.toThrow(
      "wrong passphrase or corrupt file",
    );
    for (const word of new Set(created.recoveryPhrase.split(" "))) {
      expect(file).not.toContain(word);
    }
    expect(file).not.toContain(exported.evm.privateKey.slice(2));
    expect(file).not.toContain(exported.solana?.secretKey ?? "never-present");
  });

  it("tells an older wallet that it has no phrase to write down", async () => {
    const path = await temporaryKeystorePath("v2-backup");
    await writeFile(path, JSON.stringify(await encryptPrivateKey(PRIVATE_KEY, "v2-passphrase")), {
      mode: 0o600,
    });

    await expect(exportRecoveryPhrase("v2-passphrase", path)).rejects.toThrow(KeystoreError);
    await expect(exportRecoveryPhrase("v2-passphrase", path)).rejects.toThrow(
      /keystore version 2.*vapi export-key/su,
    );
    expect((await unlockKeystore("v2-passphrase", path)).address).toBe(
      privateKeyToAccount(PRIVATE_KEY).address,
    );

    const legacyPath = await temporaryKeystorePath("v1-backup");
    await writeFile(legacyPath, JSON.stringify(LEGACY_V1_KEYSTORE), { mode: 0o600 });
    await expect(exportRecoveryPhrase("migration-passphrase", legacyPath)).rejects.toThrow(
      /keystore version 1/u,
    );
  });

  it("refuses to replace an existing keystore", async () => {
    const path = await temporaryKeystorePath("v3-exists");
    await createKeystore("v3-passphrase", path);

    await expect(createKeystoreWithPhrase("other-passphrase", path)).rejects.toThrow(
      /Refusing to replace/u,
    );
  });
});
