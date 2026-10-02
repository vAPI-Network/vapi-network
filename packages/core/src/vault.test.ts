import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { verifyMessage } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { deriveEvmPrivateKey, phraseToSeed, validateRecoveryPhrase } from "./hd.js";
import { KeystoreError } from "./keystore.js";
import {
  createVault,
  exportMemberKey,
  exportVaultAccountKey,
  exportVaultPhrase,
  openVault,
  readVaultFileUnlocked,
  reinstateVaultAccount,
  VaultError,
  type VaultFile,
} from "./vault.js";

const TEST_PHRASE = "test test test test test test test test test test test junk";
const OTHER_PHRASE =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const TEST_PHRASE_ADDRESS_0 = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const TEST_PHRASE_ADDRESS_1 = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const VAULT_KEY = Buffer.alloc(32, 7);
const WRONG_VAULT_KEY = Buffer.alloc(32, 9);
const NOW = () => new Date("2026-09-28T12:00:00.000Z");
const IMPORT_KEY = "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const SEALED_FIELD_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u;
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryVaultPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "vapi-vault-"));
  temporaryDirectories.push(directory);
  return join(directory, "vault.json");
}

async function expectVaultCode(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toMatchObject({ code });
  await expect(promise).rejects.toBeInstanceOf(VaultError);
}

describe("device vault", () => {
  it("creates an encrypted empty version 2 vault", async () => {
    const path = await temporaryVaultPath();

    const vault = await createVault({ path, key: VAULT_KEY, phrase: TEST_PHRASE, now: NOW });
    const raw = await readFile(path, "utf8");
    const file = JSON.parse(raw) as VaultFile;

    expect(vault.accounts()).toEqual([]);
    expect(file).toMatchObject({
      version: 2,
      kdf: "device-key",
      cipher: "aes-256-gcm",
      accounts: [],
      protected: false,
    });
    expect(file.phrase).toMatch(SEALED_FIELD_PATTERN);
    expect(raw).not.toContain("junk");
    expect(raw).not.toContain("test test");
  });

  it("writes the vault with mode 0600 and leaves no temporary file", async () => {
    const path = await temporaryVaultPath();
    await createVault({ path, key: VAULT_KEY, phrase: TEST_PHRASE, now: NOW });

    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await readdir(join(path, ".."))).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("derives sequential MetaMask-compatible accounts", async () => {
    const path = await temporaryVaultPath();
    const seed = phraseToSeed(TEST_PHRASE);
    try {
      expect(privateKeyToAccount(deriveEvmPrivateKey(seed, "m/44'/60'/0'/0/0")).address).toBe(
        TEST_PHRASE_ADDRESS_0,
      );
    } finally {
      seed.fill(0);
    }
    const vault = await createVault({ path, key: VAULT_KEY, phrase: TEST_PHRASE, now: NOW });

    await expect(vault.deriveAccount("main")).resolves.toEqual({
      name: "main",
      kind: "derived",
      index: 0,
      address: TEST_PHRASE_ADDRESS_0,
      createdAt: "2026-09-28T12:00:00.000Z",
    });
    await expect(vault.deriveAccount("researcher")).resolves.toEqual({
      name: "researcher",
      kind: "derived",
      index: 1,
      address: TEST_PHRASE_ADDRESS_1,
      createdAt: "2026-09-28T12:00:00.000Z",
    });
  });

  it("serializes concurrent derivations across vault handles", async () => {
    const path = await temporaryVaultPath();
    const first = await createVault({ path, key: VAULT_KEY, phrase: TEST_PHRASE, now: NOW });
    const second = await openVault({ path, key: VAULT_KEY, now: NOW });

    const derived = await Promise.all([
      first.deriveAccount("main"),
      second.deriveAccount("researcher"),
    ]);
    const reopened = await openVault({ path, key: VAULT_KEY });

    expect(
      derived.map((account) => (account.kind === "derived" ? account.index : -1)).sort(),
    ).toEqual([0, 1]);
    expect(reopened.accounts()).toHaveLength(2);
  });

  it("imports a private key without exposing or storing it in cleartext", async () => {
    const path = await temporaryVaultPath();
    const vault = await createVault({ path, key: VAULT_KEY, phrase: TEST_PHRASE, now: NOW });

    const imported = await vault.importAccount("cold", IMPORT_KEY);
    const raw = await readFile(path, "utf8");
    const file = JSON.parse(raw) as VaultFile;
    const stored = file.accounts[0];

    expect(imported).toMatchObject({
      name: "cold",
      kind: "imported",
      address: privateKeyToAccount(IMPORT_KEY).address,
      createdAt: "2026-09-28T12:00:00.000Z",
    });
    expect(imported).not.toHaveProperty("key");
    expect(vault.accounts()[0]).not.toHaveProperty("key");
    expect(stored?.key).toMatch(SEALED_FIELD_PATTERN);
    expect(raw).not.toContain(IMPORT_KEY.slice(2));
  });

  it("rejects a malformed imported private key with bad_key", async () => {
    const path = await temporaryVaultPath();
    const vault = await createVault({ path, key: VAULT_KEY, phrase: TEST_PHRASE, now: NOW });

    await expectVaultCode(vault.importAccount("bad", "0x1234"), "bad_key");
    await expectVaultCode(
      vault.importAccount("zero", `0x${"00".repeat(32)}` as `0x${string}`),
      "bad_key",
    );
  });

  it("rejects duplicate and invalid account names", async () => {
    const path = await temporaryVaultPath();
    const vault = await createVault({ path, key: VAULT_KEY, phrase: TEST_PHRASE, now: NOW });
    await vault.deriveAccount("main");
    await vault.importAccount("cold", IMPORT_KEY);

    await expectVaultCode(vault.deriveAccount("main"), "name_taken");
    await expectVaultCode(vault.importAccount("main", IMPORT_KEY), "name_taken");
    await expectVaultCode(vault.rename("cold", "main"), "name_taken");
    await expectVaultCode(vault.deriveAccount("Not Valid!"), "name_taken");
  });

  it("renames an account persistently and rejects a missing source", async () => {
    const path = await temporaryVaultPath();
    const vault = await createVault({ path, key: VAULT_KEY, phrase: TEST_PHRASE, now: NOW });
    await vault.deriveAccount("main");

    await vault.rename("main", "primary");
    const reopened = await openVault({ path, key: VAULT_KEY, now: NOW });

    expect(reopened.accounts()).toEqual([
      expect.objectContaining({ name: "primary", kind: "derived", index: 0 }),
    ]);
    await expectVaultCode(reopened.rename("ghost", "x"), "not_found");
  });

  it("checks balance before removing an account and persists removal", async () => {
    const path = await temporaryVaultPath();
    const funded = await createVault({
      path,
      key: VAULT_KEY,
      phrase: TEST_PHRASE,
      now: NOW,
      balanceOf: async () => 1n,
    });
    await expectVaultCode(funded.removeAccount("ghost"), "not_found");
    await funded.deriveAccount("main");

    await expectVaultCode(funded.removeAccount("main"), "has_balance");
    expect(funded.accounts()).toHaveLength(1);

    const empty = await openVault({ path, key: VAULT_KEY, balanceOf: async () => 0n });
    await empty.removeAccount("main");
    expect((await openVault({ path, key: VAULT_KEY })).accounts()).toEqual([]);
  });

  it("fails closed when removal has no balance reader", async () => {
    const path = await temporaryVaultPath();
    const vault = await createVault({ path, key: VAULT_KEY, phrase: TEST_PHRASE, now: NOW });
    const imported = await vault.importAccount("cold", IMPORT_KEY);

    await expectVaultCode(vault.removeAccount("cold"), "has_balance");

    const reopened = await openVault({ path, key: VAULT_KEY });
    expect(reopened.accounts()).toEqual([imported]);
    await expect(reopened.signer("cold")).resolves.toMatchObject({ address: imported.address });
  });

  it("does not remove a funded neighbor during concurrent removals", async () => {
    const path = await temporaryVaultPath();
    const fundedAddress = privateKeyToAccount(IMPORT_KEY).address;
    const vault = await createVault({
      path,
      key: VAULT_KEY,
      phrase: TEST_PHRASE,
      now: NOW,
      balanceOf: async (address) => (address === fundedAddress ? 1n : 0n),
    });
    await vault.deriveAccount("empty");
    await vault.importAccount("funded", IMPORT_KEY);

    const results = await Promise.allSettled([
      vault.removeAccount("empty"),
      vault.removeAccount("empty"),
    ]);
    const reopened = await openVault({ path, key: VAULT_KEY });

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(reopened.accounts()).toEqual([
      expect.objectContaining({ name: "funded", address: fundedAddress }),
    ]);
  });

  it("rejects a wrong-sized key, a wrong key, and a missing vault", async () => {
    const path = await temporaryVaultPath();
    await createVault({ path, key: VAULT_KEY, phrase: TEST_PHRASE, now: NOW });

    await expectVaultCode(openVault({ path, key: WRONG_VAULT_KEY }), "bad_key");
    await expectVaultCode(openVault({ path, key: Buffer.alloc(16) }), "bad_key");
    await expectVaultCode(openVault({ path: `${path}.missing`, key: VAULT_KEY }), "not_found");
  });

  it("reports malformed files as corrupt but authenticated ciphertext tampering as bad_key", async () => {
    const path = await temporaryVaultPath();
    await createVault({ path, key: VAULT_KEY, phrase: TEST_PHRASE, now: NOW });
    const raw = await readFile(path, "utf8");

    await writeFile(path, raw.slice(0, Math.floor(raw.length / 2)), { mode: 0o600 });
    await expectVaultCode(openVault({ path, key: VAULT_KEY }), "corrupt");

    const wrongVersion = { ...(JSON.parse(raw) as VaultFile), version: 3 };
    await writeFile(path, JSON.stringify(wrongVersion), { mode: 0o600 });
    await expectVaultCode(openVault({ path, key: VAULT_KEY }), "corrupt");

    const tampered = JSON.parse(raw) as VaultFile;
    const [nonce, ciphertext, tag] = tampered.phrase.split(".");
    const flipped = `${ciphertext?.startsWith("A") ? "B" : "A"}${ciphertext?.slice(1)}`;
    tampered.phrase = `${nonce}.${flipped}.${tag}`;
    await writeFile(path, JSON.stringify(tampered), { mode: 0o600 });
    await expectVaultCode(openVault({ path, key: VAULT_KEY }), "bad_key");
  });

  it("round-trips derived and imported accounts through save and open", async () => {
    const path = await temporaryVaultPath();
    const vault = await createVault({ path, key: VAULT_KEY, phrase: TEST_PHRASE, now: NOW });
    await vault.deriveAccount("main");
    await vault.deriveAccount("researcher");
    await vault.importAccount("cold", IMPORT_KEY);
    const expected = vault.accounts();

    await vault.save();
    const reopened = await openVault({ path, key: VAULT_KEY, now: NOW });

    expect(reopened.accounts()).toEqual(expected);
    for (const account of reopened.accounts()) expect(account).not.toHaveProperty("key");
  });

  it("preserves newer accounts when a stale handle renames and saves", async () => {
    const path = await temporaryVaultPath();
    const created = await createVault({ path, key: VAULT_KEY, phrase: TEST_PHRASE, now: NOW });
    await created.deriveAccount("main");
    const first = await openVault({ path, key: VAULT_KEY, now: NOW });
    const stale = await openVault({ path, key: VAULT_KEY, now: NOW });

    await first.importAccount("cold", IMPORT_KEY);
    await stale.rename("main", "primary");
    await stale.save();

    expect((await openVault({ path, key: VAULT_KEY })).accounts()).toEqual([
      expect.objectContaining({ name: "primary", kind: "derived" }),
      expect.objectContaining({ name: "cold", kind: "imported" }),
    ]);
  });

  it("returns working signers for derived and imported accounts", async () => {
    const path = await temporaryVaultPath();
    const vault = await createVault({ path, key: VAULT_KEY, phrase: TEST_PHRASE, now: NOW });
    await vault.deriveAccount("main");
    await vault.importAccount("cold", IMPORT_KEY);

    const derived = await vault.signer("main");
    const signature = await derived.signMessage({ message: "hello" });

    expect(derived.address).toBe(TEST_PHRASE_ADDRESS_0);
    expect(signature).toMatch(/^0x[0-9a-f]{130}$/u);
    expect(signature).toHaveLength(132);
    await expect(
      verifyMessage({ address: derived.address, message: "hello", signature }),
    ).resolves.toBe(true);
    expect((await vault.signer("cold")).address).toBe(privateKeyToAccount(IMPORT_KEY).address);
    await expectVaultCode(vault.signer("ghost"), "not_found");
  });

  it("exports private keys for derived and imported accounts by name", async () => {
    const path = await temporaryVaultPath();
    const vault = await createVault({ path, key: VAULT_KEY, phrase: TEST_PHRASE, now: NOW });
    await vault.deriveAccount("main");
    await vault.importAccount("cold", IMPORT_KEY);

    const seed = phraseToSeed(TEST_PHRASE);
    let derivedKey: `0x${string}`;
    try {
      derivedKey = deriveEvmPrivateKey(seed, "m/44'/60'/0'/0/0");
    } finally {
      seed.fill(0);
    }

    await expect(exportVaultAccountKey({ path, key: VAULT_KEY, name: "main" })).resolves.toBe(
      derivedKey,
    );
    await expect(exportVaultAccountKey({ path, key: VAULT_KEY, name: "cold" })).resolves.toBe(
      IMPORT_KEY,
    );
    await expectVaultCode(
      exportVaultAccountKey({ path, key: VAULT_KEY, name: "ghost" }),
      "not_found",
    );
  });

  it("exports one member key, identical to the account key export", async () => {
    const path = await temporaryVaultPath();
    const vault = await createVault({ path, key: VAULT_KEY, phrase: TEST_PHRASE, now: NOW });
    await vault.deriveAccount("main");
    const member = await vault.deriveAccount("member");
    await vault.importAccount("cold", IMPORT_KEY);

    const memberKey = await exportMemberKey({ path, key: VAULT_KEY, name: "member" });

    expect(memberKey).toMatch(/^0x[0-9a-f]{64}$/u);
    expect(memberKey).toBe(await exportVaultAccountKey({ path, key: VAULT_KEY, name: "member" }));
    expect(privateKeyToAccount(memberKey).address).toBe(member.address);
    expect(member.address).toBe(TEST_PHRASE_ADDRESS_1);
    await expect(exportMemberKey({ path, key: VAULT_KEY, name: "cold" })).resolves.toBe(IMPORT_KEY);
    await expectVaultCode(exportMemberKey({ path, key: VAULT_KEY, name: "ghost" }), "not_found");
  });

  it("uses a fresh nonce for every phrase write and imported key", async () => {
    const path = await temporaryVaultPath();
    const vault = await createVault({ path, key: VAULT_KEY, phrase: TEST_PHRASE, now: NOW });
    await vault.save();
    const firstPhrase = (JSON.parse(await readFile(path, "utf8")) as VaultFile).phrase;
    await vault.save();
    const secondPhrase = (JSON.parse(await readFile(path, "utf8")) as VaultFile).phrase;

    expect(firstPhrase.split(".")[0]).not.toBe(secondPhrase.split(".")[0]);

    await vault.importAccount("one", IMPORT_KEY);
    await vault.importAccount("two", IMPORT_KEY);
    const file = JSON.parse(await readFile(path, "utf8")) as VaultFile;
    expect(file.accounts[0]?.key).toMatch(SEALED_FIELD_PATTERN);
    expect(file.accounts[1]?.key).toMatch(SEALED_FIELD_PATTERN);
    expect(file.accounts[0]?.key).not.toBe(file.accounts[1]?.key);
  });

  it("refuses to overwrite a vault and preserves KeystoreError for an invalid phrase", async () => {
    const path = await temporaryVaultPath();
    await createVault({ path, key: VAULT_KEY, phrase: TEST_PHRASE, now: NOW });

    await expectVaultCode(
      createVault({ path, key: VAULT_KEY, phrase: TEST_PHRASE, now: NOW }),
      "corrupt",
    );
    await expect(
      createVault({ path: await temporaryVaultPath(), key: VAULT_KEY, phrase: "not a phrase" }),
    ).rejects.toBeInstanceOf(KeystoreError);
  });

  it("allows only one concurrent creator without overwriting its vault", async () => {
    const path = await temporaryVaultPath();
    const results = await Promise.allSettled([
      createVault({ path, key: VAULT_KEY, phrase: TEST_PHRASE, now: NOW }),
      createVault({ path, key: VAULT_KEY, phrase: OTHER_PHRASE, now: NOW }),
    ]);
    const reopened = await openVault({ path, key: VAULT_KEY });

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect([TEST_PHRASE, OTHER_PHRASE]).toContain(await reopened.phrase());
  });

  it("returns imported and generated recovery phrases on demand", async () => {
    const path = await temporaryVaultPath();
    const vault = await createVault({ path, key: VAULT_KEY, phrase: TEST_PHRASE, now: NOW });

    await expect(vault.phrase()).resolves.toBe(TEST_PHRASE);
    await expect(exportVaultPhrase({ path, key: VAULT_KEY })).resolves.toBe(TEST_PHRASE);

    const generatedPath = await temporaryVaultPath();
    const generated = await createVault({ path: generatedPath, key: VAULT_KEY, now: NOW });
    const phrase = await generated.phrase();
    expect(phrase.split(" ")).toHaveLength(12);
    expect(validateRecoveryPhrase(phrase)).toBe(phrase);
  });
});

describe("reinstateVaultAccount", () => {
  it("round-trips a derived record and preserves the next derivation index", async () => {
    const path = await temporaryVaultPath();
    const vault = await createVault({
      path,
      key: VAULT_KEY,
      phrase: TEST_PHRASE,
      now: NOW,
      balanceOf: async () => 0n,
    });
    await vault.deriveAccount("a");
    const original = await vault.deriveAccount("b");
    const stored = (await readVaultFileUnlocked(path)).accounts[1]!;

    await vault.removeAccount("b");
    await expect(reinstateVaultAccount({ path, key: VAULT_KEY, account: stored })).resolves.toEqual(
      original,
    );

    const reopened = await openVault({ path, key: VAULT_KEY, now: NOW });
    await expect(reopened.signer("b")).resolves.toMatchObject({ address: original.address });
    await expect(reopened.deriveAccount("c")).resolves.toMatchObject({
      kind: "derived",
      index: 2,
    });
  });

  it("refuses a derived record from a vault with a different phrase", async () => {
    const sourcePath = await temporaryVaultPath();
    const source = await createVault({
      path: sourcePath,
      key: VAULT_KEY,
      phrase: TEST_PHRASE,
      now: NOW,
    });
    await source.deriveAccount("main");
    const stored = (await readVaultFileUnlocked(sourcePath)).accounts[0]!;
    const targetPath = await temporaryVaultPath();
    await createVault({
      path: targetPath,
      key: VAULT_KEY,
      phrase: OTHER_PHRASE,
      now: NOW,
    });

    await expectVaultCode(
      reinstateVaultAccount({ path: targetPath, key: VAULT_KEY, account: stored }),
      "bad_key",
    );
  });

  it("round-trips an imported record after checking its address", async () => {
    const path = await temporaryVaultPath();
    const vault = await createVault({
      path,
      key: VAULT_KEY,
      phrase: TEST_PHRASE,
      now: NOW,
      balanceOf: async () => 0n,
    });
    const original = await vault.importAccount("cold", IMPORT_KEY);
    const stored = (await readVaultFileUnlocked(path)).accounts[0]!;

    await vault.removeAccount("cold");
    await expectVaultCode(
      reinstateVaultAccount({
        path,
        key: VAULT_KEY,
        account: { ...stored, address: "0x0000000000000000000000000000000000000001" },
      }),
      "bad_key",
    );
    await expect(reinstateVaultAccount({ path, key: VAULT_KEY, account: stored })).resolves.toEqual(
      original,
    );

    await expect((await openVault({ path, key: VAULT_KEY })).signer("cold")).resolves.toMatchObject(
      {
        address: privateKeyToAccount(IMPORT_KEY).address,
      },
    );
  });

  it("refuses a record whose name is already taken", async () => {
    const path = await temporaryVaultPath();
    const vault = await createVault({ path, key: VAULT_KEY, phrase: TEST_PHRASE, now: NOW });
    await vault.deriveAccount("main");
    const stored = (await readVaultFileUnlocked(path)).accounts[0]!;

    await expectVaultCode(
      reinstateVaultAccount({ path, key: VAULT_KEY, account: stored }),
      "name_taken",
    );
  });

  it("refuses a derived record whose index is already taken", async () => {
    const path = await temporaryVaultPath();
    const vault = await createVault({
      path,
      key: VAULT_KEY,
      phrase: TEST_PHRASE,
      now: NOW,
      balanceOf: async () => 0n,
    });
    await vault.deriveAccount("a");
    await vault.deriveAccount("b");
    const stored = (await readVaultFileUnlocked(path)).accounts[1]!;
    await vault.removeAccount("b");
    await reinstateVaultAccount({ path, key: VAULT_KEY, account: { ...stored, name: "other" } });

    await expectVaultCode(
      reinstateVaultAccount({ path, key: VAULT_KEY, account: stored }),
      "name_taken",
    );
  });

  it("refuses an imported record sealed with a different device key", async () => {
    const path = await temporaryVaultPath();
    await createVault({ path, key: VAULT_KEY, phrase: TEST_PHRASE, now: NOW });
    const otherPath = await temporaryVaultPath();
    const otherVault = await createVault({
      path: otherPath,
      key: WRONG_VAULT_KEY,
      phrase: TEST_PHRASE,
      now: NOW,
    });
    await otherVault.importAccount("cold", IMPORT_KEY);
    const stored = (await readVaultFileUnlocked(otherPath)).accounts[0]!;

    await expectVaultCode(
      reinstateVaultAccount({ path, key: VAULT_KEY, account: stored }),
      "bad_key",
    );
  });
});
