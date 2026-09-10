import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
