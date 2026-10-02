import { readFile, rm, stat, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { decryptWithKey, deriveScryptKey } from "./keystore.js";
import type { SecretStore } from "./secret-store.js";
import {
  loadOrCreateDeviceKey,
  lockVault,
  protectVault,
  restoreVault,
  unlockProtectedVault,
  unprotectVault,
  VAULT_KEY_ACCOUNT,
  VAULT_SESSION_ACCOUNT,
} from "./vault-key.js";
import { createVault, exportVaultPhrase, openVault, VaultError, type VaultFile } from "./vault.js";

const TEST_PHRASE = "test test test test test test test test test test test junk";
const TEST_PHRASE_ADDRESS_0 = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const TEST_PHRASE_ADDRESS_1 = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const DEVICE_KEY = Buffer.alloc(32, 7);
const WRONG_DEVICE_KEY = Buffer.alloc(32, 9);
const NOW = () => new Date("2026-09-28T12:00:00.000Z");
const WRAPPED_KEY_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u;
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function memoryStore(): SecretStore & { entries: Map<string, string> } {
  const entries = new Map<string, string>();
  return {
    entries,
    available: true,
    platform: "darwin",
    description: "a test store",
    async get(name) {
      return entries.get(name);
    },
    async has(name) {
      return entries.has(name);
    },
    async set(name, value) {
      entries.set(name, value);
    },
    async remove(name) {
      return entries.delete(name);
    },
  };
}

async function temporaryVaultPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "vapi-vault-key-"));
  temporaryDirectories.push(directory);
  return join(directory, "vault.json");
}

async function readVault(path: string): Promise<VaultFile> {
  return JSON.parse(await readFile(path, "utf8")) as VaultFile;
}

async function createStoredVault(
  store: SecretStore & { entries: Map<string, string> },
  path: string,
): Promise<void> {
  store.entries.set(VAULT_KEY_ACCOUNT, DEVICE_KEY.toString("base64"));
  await createVault({ path, key: DEVICE_KEY, phrase: TEST_PHRASE, now: NOW });
}

async function expectVaultCode(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toBeInstanceOf(VaultError);
  await expect(promise).rejects.toMatchObject({ code });
}

describe("device vault keys", () => {
  it("creates one device key, stores it as base64, and reuses it", async () => {
    const store = memoryStore();
    const set = vi.spyOn(store, "set");
    const random = vi.fn(() => Uint8Array.from(DEVICE_KEY));

    const first = await loadOrCreateDeviceKey({ secrets: store, randomBytes: random });
    const second = await loadOrCreateDeviceKey({ secrets: store, randomBytes: random });

    expect(first).toHaveLength(32);
    expect(first).toEqual(DEVICE_KEY);
    expect(second).toEqual(first);
    expect(store.entries.get(VAULT_KEY_ACCOUNT)).toHaveLength(44);
    expect(set).toHaveBeenCalledTimes(1);
    expect(random).toHaveBeenCalledTimes(1);
  });

  it("serializes concurrent device-key creation", async () => {
    const store = memoryStore();
    let generated = 0;
    const random = vi.fn(() => Buffer.alloc(32, (generated += 1)));

    const [first, second] = await Promise.all([
      loadOrCreateDeviceKey({ secrets: store, randomBytes: random }),
      loadOrCreateDeviceKey({ secrets: store, randomBytes: random }),
    ]);

    expect(first).toEqual(second);
    expect(Buffer.from(first).toString("base64")).toBe(store.entries.get(VAULT_KEY_ACCOUNT));
    expect(random).toHaveBeenCalledTimes(1);
  });

  it("rejects a stored device key with the wrong decoded length", async () => {
    const store = memoryStore();
    store.entries.set(VAULT_KEY_ACCOUNT, Buffer.alloc(31, 1).toString("base64"));

    await expectVaultCode(loadOrCreateDeviceKey({ secrets: store }), "corrupt");
  });

  it("protects a vault, removes its plain key, and refuses repeated protection", async () => {
    const path = await temporaryVaultPath();
    const store = memoryStore();
    await createStoredVault(store, path);

    await protectVault({ path, secrets: store, password: "pw" });
    const file = await readVault(path);

    expect(file.protected).toBe(true);
    expect(file.wrappedKey).toMatch(WRAPPED_KEY_PATTERN);
    expect(store.entries.has(VAULT_KEY_ACCOUNT)).toBe(false);
    expect(store.entries.has(VAULT_SESSION_ACCOUNT)).toBe(false);
    await expectVaultCode(openVault({ path, key: WRONG_DEVICE_KEY }), "bad_key");
    await expectVaultCode(
      protectVault({ path, secrets: store, password: "pw" }),
      "already_protected",
    );
  });

  it("requires a password to protect a vault", async () => {
    const path = await temporaryVaultPath();
    const store = memoryStore();
    await createStoredVault(store, path);

    await expectVaultCode(protectVault({ path, secrets: store }), "password_required");
    expect((await readVault(path)).protected).toBe(false);
    expect(store.entries.has(VAULT_KEY_ACCOUNT)).toBe(true);
  });

  it("protects with the injected password environment", async () => {
    const path = await temporaryVaultPath();
    const store = memoryStore();
    await createStoredVault(store, path);

    await protectVault({
      path,
      secrets: store,
      env: { VAPI_VAULT_PASSWORD: "pw" },
    });

    expect((await readVault(path)).protected).toBe(true);
  });

  it("preserves protection metadata when the Vault API rewrites the file", async () => {
    const path = await temporaryVaultPath();
    const store = memoryStore();
    store.entries.set(VAULT_KEY_ACCOUNT, DEVICE_KEY.toString("base64"));
    const vault = await createVault({ path, key: DEVICE_KEY, phrase: TEST_PHRASE, now: NOW });
    await protectVault({ path, secrets: store, password: "pw" });
    const wrappedKey = (await readVault(path)).wrappedKey;

    await vault.deriveAccount("account-1");
    const rewritten = await readVault(path);

    expect(rewritten.protected).toBe(true);
    expect(rewritten.wrappedKey).toBe(wrappedKey);
  });

  it("rejects inconsistent protected and wrapped-key metadata", async () => {
    const path = await temporaryVaultPath();
    const store = memoryStore();
    await createStoredVault(store, path);
    const unprotected = await readVault(path);

    await writeFile(path, JSON.stringify({ ...unprotected, protected: true }), { mode: 0o600 });
    await expectVaultCode(openVault({ path, key: DEVICE_KEY }), "corrupt");

    await writeFile(
      path,
      JSON.stringify({ ...unprotected, wrappedKey: "c2FsdA.bm9uY2U.Y2lwaGVydGV4dA.dGFn" }),
      { mode: 0o600 },
    );
    await expectVaultCode(openVault({ path, key: DEVICE_KEY }), "corrupt");
  });

  it("unlocks with a password and caches default and custom session expiries", async () => {
    const path = await temporaryVaultPath();
    const store = memoryStore();
    await createStoredVault(store, path);
    await protectVault({ path, secrets: store, password: "pw" });

    await expect(
      unlockProtectedVault({ path, secrets: store, password: "pw", now: NOW }),
    ).resolves.toEqual(DEVICE_KEY);
    expect(JSON.parse(store.entries.get(VAULT_SESSION_ACCOUNT)!)).toEqual({
      key: DEVICE_KEY.toString("base64"),
      expiresAt: "2026-09-28T20:00:00.000Z",
    });

    await unlockProtectedVault({
      path,
      secrets: store,
      password: "pw",
      sessionHours: 1,
      now: NOW,
    });
    expect(JSON.parse(store.entries.get(VAULT_SESSION_ACCOUNT)!)).toEqual({
      key: DEVICE_KEY.toString("base64"),
      expiresAt: "2026-09-28T13:00:00.000Z",
    });
  });

  it("rejects a wrong password without writing a session", async () => {
    const path = await temporaryVaultPath();
    const store = memoryStore();
    await createStoredVault(store, path);
    await protectVault({ path, secrets: store, password: "pw" });

    await expectVaultCode(
      unlockProtectedVault({ path, secrets: store, password: "wrong", now: NOW }),
      "bad_key",
    );
    expect(store.entries.has(VAULT_SESSION_ACCOUNT)).toBe(false);
  });

  it("uses a fresh session without a password and removes it after expiry", async () => {
    const path = await temporaryVaultPath();
    const store = memoryStore();
    await createStoredVault(store, path);
    await protectVault({ path, secrets: store, password: "pw" });
    await unlockProtectedVault({ path, secrets: store, password: "pw", now: NOW });

    await expect(unlockProtectedVault({ path, secrets: store, now: NOW })).resolves.toEqual(
      DEVICE_KEY,
    );
    await expectVaultCode(
      unlockProtectedVault({
        path,
        secrets: store,
        now: () => new Date("2026-09-28T20:00:00.001Z"),
      }),
      "password_required",
    );
    expect(store.entries.has(VAULT_SESSION_ACCOUNT)).toBe(false);
  });

  it("prefers an explicit password over an existing session", async () => {
    const path = await temporaryVaultPath();
    const store = memoryStore();
    await createStoredVault(store, path);
    await protectVault({ path, secrets: store, password: "pw" });
    await unlockProtectedVault({ path, secrets: store, password: "pw", now: NOW });

    await expectVaultCode(
      unlockProtectedVault({ path, secrets: store, password: "wrong", now: NOW }),
      "bad_key",
    );
  });

  it("discards an invalid session and requires a password", async () => {
    const path = await temporaryVaultPath();
    const store = memoryStore();
    await createStoredVault(store, path);
    await protectVault({ path, secrets: store, password: "pw" });
    store.entries.set(VAULT_SESSION_ACCOUNT, "not json");

    await expectVaultCode(
      unlockProtectedVault({ path, secrets: store, now: NOW }),
      "password_required",
    );
    expect(store.entries.has(VAULT_SESSION_ACCOUNT)).toBe(false);
  });

  it("locks a cached vault once and reports subsequent locks", async () => {
    const store = memoryStore();
    store.entries.set(VAULT_SESSION_ACCOUNT, "cached");

    await expect(lockVault({ secrets: store })).resolves.toBe(true);
    await expect(lockVault({ secrets: store })).resolves.toBe(false);
    expect(store.entries.has(VAULT_SESSION_ACCOUNT)).toBe(false);
  });

  it("refuses to unlock an unprotected vault", async () => {
    const path = await temporaryVaultPath();
    const store = memoryStore();
    await createStoredVault(store, path);

    await expectVaultCode(
      unlockProtectedVault({ path, secrets: store, password: "pw", now: NOW }),
      "not_protected",
    );
  });

  it("unprotects a vault, restores its device key, and clears its session", async () => {
    const path = await temporaryVaultPath();
    const store = memoryStore();
    await createStoredVault(store, path);
    await protectVault({ path, secrets: store, password: "pw" });
    await unlockProtectedVault({ path, secrets: store, password: "pw", now: NOW });

    await unprotectVault({ path, secrets: store, password: "pw" });
    const raw = await readFile(path, "utf8");
    const file = JSON.parse(raw) as VaultFile;

    expect(file.protected).toBe(false);
    expect(file).not.toHaveProperty("wrappedKey");
    expect(store.entries.get(VAULT_KEY_ACCOUNT)).toBe(DEVICE_KEY.toString("base64"));
    expect(store.entries.has(VAULT_SESSION_ACCOUNT)).toBe(false);
    await expect(openVault({ path, key: DEVICE_KEY })).resolves.toBeDefined();
  });

  it("keeps the wrapped key when restoring the device key fails", async () => {
    const path = await temporaryVaultPath();
    const store = memoryStore();
    await createStoredVault(store, path);
    await protectVault({ path, secrets: store, password: "pw" });
    const wrappedKey = (await readVault(path)).wrappedKey;
    store.set = async (name, value) => {
      if (name === VAULT_KEY_ACCOUNT) throw new Error("secret store unavailable");
      store.entries.set(name, value);
    };

    await expectVaultCode(unprotectVault({ path, secrets: store, password: "pw" }), "corrupt");

    expect(await readVault(path)).toMatchObject({ protected: true });
    expect((await readVault(path)).wrappedKey).toBe(wrappedKey);
    expect(store.entries.has(VAULT_KEY_ACCOUNT)).toBe(false);
    await expect(
      unlockProtectedVault({ path, secrets: store, password: "pw", now: NOW }),
    ).resolves.toEqual(DEVICE_KEY);
  });

  it("holds the vault lock while changing protection and stored keys", async () => {
    const path = await temporaryVaultPath();
    const store = memoryStore();
    await createStoredVault(store, path);
    const originalRemove = store.remove.bind(store);
    store.remove = async (name) => {
      if (name === VAULT_KEY_ACCOUNT) {
        await expect(stat(`${path}.lock`)).resolves.toBeDefined();
      }
      return await originalRemove(name);
    };

    await protectVault({ path, secrets: store, password: "pw" });
    const originalSet = store.set.bind(store);
    store.set = async (name, value) => {
      if (name === VAULT_KEY_ACCOUNT) {
        await expect(stat(`${path}.lock`)).resolves.toBeDefined();
      }
      await originalSet(name, value);
    };
    await unprotectVault({ path, secrets: store, password: "pw" });

    expect(await readVault(path)).toMatchObject({ protected: false });
    expect(store.entries.get(VAULT_KEY_ACCOUNT)).toBe(DEVICE_KEY.toString("base64"));
  });

  it("rejects a wrong unprotect password and an already unprotected vault", async () => {
    const protectedPath = await temporaryVaultPath();
    const protectedStore = memoryStore();
    await createStoredVault(protectedStore, protectedPath);
    await protectVault({ path: protectedPath, secrets: protectedStore, password: "pw" });

    await expectVaultCode(
      unprotectVault({ path: protectedPath, secrets: protectedStore, password: "wrong" }),
      "bad_key",
    );

    const plainPath = await temporaryVaultPath();
    const plainStore = memoryStore();
    await createStoredVault(plainStore, plainPath);
    await expectVaultCode(
      unprotectVault({ path: plainPath, secrets: plainStore, password: "pw" }),
      "not_protected",
    );
  });

  it("restores discovered accounts and the recovery phrase", async () => {
    const path = await temporaryVaultPath();
    const discovered = new Set([TEST_PHRASE_ADDRESS_0, TEST_PHRASE_ADDRESS_1]);

    const vault = await restoreVault({
      path,
      key: DEVICE_KEY,
      phrase: TEST_PHRASE,
      probe: async (address) => discovered.has(address),
      now: NOW,
    });

    expect(vault.accounts()).toEqual([
      {
        name: "account-1",
        kind: "derived",
        index: 0,
        address: TEST_PHRASE_ADDRESS_0,
        createdAt: "2026-09-28T12:00:00.000Z",
      },
      {
        name: "account-2",
        kind: "derived",
        index: 1,
        address: TEST_PHRASE_ADDRESS_1,
        createdAt: "2026-09-28T12:00:00.000Z",
      },
    ]);
    await expect(exportVaultPhrase({ path, key: DEVICE_KEY })).resolves.toBe(TEST_PHRASE);
  });

  it("always restores account one even when discovery finds nothing", async () => {
    const path = await temporaryVaultPath();
    const probe = vi.fn(async () => false);

    const vault = await restoreVault({
      path,
      key: DEVICE_KEY,
      phrase: TEST_PHRASE,
      probe,
      now: NOW,
    });

    expect(vault.accounts()).toEqual([
      expect.objectContaining({ name: "account-1", kind: "derived", index: 0 }),
    ]);
    expect(probe).toHaveBeenCalledOnce();
    expect(probe).toHaveBeenCalledWith(TEST_PHRASE_ADDRESS_0);
  });

  it("reports an invalid restore phrase as a corrupt vault", async () => {
    await expectVaultCode(
      restoreVault({
        path: await temporaryVaultPath(),
        key: DEVICE_KEY,
        phrase: "not a phrase",
        probe: async () => false,
        now: NOW,
      }),
      "corrupt",
    );
  });

  it("restores more than one hundred consecutively used accounts", async () => {
    let probes = 0;
    const vault = await restoreVault({
      path: await temporaryVaultPath(),
      key: DEVICE_KEY,
      phrase: TEST_PHRASE,
      probe: async () => (probes += 1) <= 101,
      now: NOW,
    });

    expect(vault.accounts()).toHaveLength(101);
    expect(vault.accounts()[100]).toMatchObject({ name: "account-101", index: 100 });
    expect(probes).toBe(102);
  }, 10_000);

  it("propagates a restore probe error without creating a partial vault", async () => {
    const path = await temporaryVaultPath();
    const probeError = new Error("probe unavailable");
    let probes = 0;

    await expect(
      restoreVault({
        path,
        key: DEVICE_KEY,
        phrase: TEST_PHRASE,
        probe: async () => {
          probes += 1;
          if (probes === 1) return true;
          throw probeError;
        },
        now: NOW,
      }),
    ).rejects.toBe(probeError);
    await expect(readFile(path, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("round-trips wrapped key bytes and uses a fresh salt for each vault", async () => {
    const firstPath = await temporaryVaultPath();
    const secondPath = await temporaryVaultPath();
    const firstStore = memoryStore();
    const secondStore = memoryStore();
    const salts = [Buffer.alloc(32, 1), Buffer.alloc(32, 2)];
    const randomBytes = vi.fn(() => salts.shift()!);
    await createStoredVault(firstStore, firstPath);
    await createStoredVault(secondStore, secondPath);

    await protectVault({
      path: firstPath,
      secrets: firstStore,
      password: "pw",
      randomBytes,
    });
    await protectVault({
      path: secondPath,
      secrets: secondStore,
      password: "pw",
      randomBytes,
    });
    const firstWrapped = (await readVault(firstPath)).wrappedKey!;
    const secondWrapped = (await readVault(secondPath)).wrappedKey!;
    const [salt, nonce, ciphertext, tag] = firstWrapped
      .split(".")
      .map((part) => Buffer.from(part, "base64url"));
    const keyEncryptionKey = await deriveScryptKey("pw", salt!);
    let unwrapped: Buffer | undefined;
    try {
      unwrapped = decryptWithKey(keyEncryptionKey, {
        nonce: nonce!,
        ciphertext: ciphertext!,
        tag: tag!,
      });
      expect(unwrapped).toEqual(DEVICE_KEY);
      expect(firstWrapped.split(".")[0]).not.toBe(secondWrapped.split(".")[0]);
    } finally {
      unwrapped?.fill(0);
      keyEncryptionKey.fill(0);
    }
  });
});
