import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { KeystoreError } from "./keystore.js";
import { memorySecretStore } from "./secret-store.js";
import { unlockProtectedVault, VAULT_KEY_ACCOUNT } from "./vault-key.js";
import { createVault } from "./vault-setup.js";
import { readVaultFileUnlocked, VaultError } from "./vault.js";
import { WalletStore } from "./wallet-store.js";

const PASSWORD = "correct horse battery staple";
const homes: string[] = [];

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

async function freshHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "vapi-vault-setup-"));
  homes.push(home);
  return home;
}

describe("createVault", () => {
  it("rejects an empty password before creating any files or secrets", async () => {
    const home = await freshHome();
    const secrets = memorySecretStore();
    const creation = createVault(home, { secrets, password: "" });

    await expect(creation).rejects.toBeInstanceOf(KeystoreError);
    await expect(creation).rejects.toThrow("A password cannot be empty.");
    expect(await readdir(home)).toEqual([]);
    expect(await secrets.has(VAULT_KEY_ACCOUNT)).toBe(false);
  });

  it.each(["get", "remove"] as const)(
    "rolls back a protection %s failure and allows retry",
    async (operation) => {
      const home = await freshHome();
      const secrets = memorySecretStore();
      const failure = new VaultError("corrupt", "Secret store unavailable during protection.");
      let calls = 0;
      if (operation === "get") {
        const get = secrets.get;
        secrets.get = async (name) => {
          // Creation reads the key first; protection reads it again.
          if (++calls === 2) throw failure;
          return await get(name);
        };
      } else {
        const remove = secrets.remove;
        secrets.remove = async (name) => {
          if (++calls === 1) throw failure;
          return await remove(name);
        };
      }

      await expect(createVault(home, { secrets, password: PASSWORD })).rejects.toBe(failure);
      expect(await readdir(home)).not.toContain("vault.json");
      expect(await secrets.has(VAULT_KEY_ACCOUNT)).toBe(false);

      await createVault(home, { secrets, password: PASSWORD });
      const key = await unlockProtectedVault({
        path: join(home, "vault.json"),
        secrets,
        password: PASSWORD,
      });
      key.fill(0);
    },
  );

  it("preserves the protection error when secret cleanup also fails", async () => {
    const home = await freshHome();
    const secrets = memorySecretStore();
    const remove = secrets.remove;
    const failure = new VaultError("corrupt", "Secret store cannot remove entries.");
    secrets.remove = async () => {
      throw failure;
    };

    await expect(createVault(home, { secrets, password: PASSWORD })).rejects.toBe(failure);
    expect(await readdir(home)).not.toContain("vault.json");

    secrets.remove = remove;
    await createVault(home, { secrets, password: PASSWORD });
    expect((await readVaultFileUnlocked(join(home, "vault.json"))).protected).toBe(true);
    expect(await secrets.has(VAULT_KEY_ACCOUNT)).toBe(false);
  });

  it("keeps a device key that existed before setup when protection fails", async () => {
    const home = await freshHome();
    const deviceKey = Buffer.alloc(32, 7).toString("base64");
    const secrets = memorySecretStore({ [VAULT_KEY_ACCOUNT]: deviceKey });
    const get = secrets.get;
    const failure = new VaultError("corrupt", "Secret store unavailable during protection.");
    let reads = 0;
    secrets.get = async (name) => {
      if (++reads === 2) throw failure;
      return await get(name);
    };

    await expect(createVault(home, { secrets, password: PASSWORD })).rejects.toBe(failure);
    expect(await readdir(home)).not.toContain("vault.json");
    expect(await secrets.get(VAULT_KEY_ACCOUNT)).toBe(deviceKey);
  });

  it("creates a protected vault with zero accounts that unlocks with the password", async () => {
    const home = await freshHome();
    const secrets = memorySecretStore();
    await createVault(home, { secrets, password: PASSWORD });

    const file = await readVaultFileUnlocked(join(home, "vault.json"));
    expect(file.protected).toBe(true);
    expect(file.accounts).toEqual([]);
    expect(await secrets.has(VAULT_KEY_ACCOUNT)).toBe(false);

    const key = await unlockProtectedVault({
      path: join(home, "vault.json"),
      secrets,
      password: PASSWORD,
    });
    expect(key.byteLength).toBeGreaterThan(0);
    key.fill(0);
    const store = await WalletStore.open(home, { secrets });
    expect(store.names()).toEqual([]);
    expect(store.defaultName).toBeUndefined();
  });

  it("lets the first named account follow, and that account becomes the default", async () => {
    const home = await freshHome();
    const secrets = memorySecretStore();
    await createVault(home, { secrets });
    const store = await WalletStore.open(home, { secrets });
    await store.create("claude", "");
    expect(store.names()).toEqual(["claude"]);
    expect(store.defaultName).toBe("claude");
  });

  it("refuses to create a second vault in the same home", async () => {
    const home = await freshHome();
    const secrets = memorySecretStore();
    await createVault(home, { secrets });
    const duplicate = createVault(home, { secrets });
    await expect(duplicate).rejects.toBeInstanceOf(KeystoreError);
    await expect(duplicate).rejects.toThrow("A vault already exists in this home.");
  });
});

describe("WalletStore#createEmptyVault", () => {
  it("releases the cached vault and raw device key before returning", async () => {
    const home = await freshHome();
    const secrets = memorySecretStore();
    const store = await WalletStore.open(home, { secrets });
    await store.createEmptyVault();

    expect(Reflect.get(store, "cachedVault")).toBeUndefined();
    expect(Reflect.get(store, "vaultKey")).toBeUndefined();
    expect(await secrets.has(VAULT_KEY_ACCOUNT)).toBe(true);
    await store.create("claude", "");
    expect(store.names()).toEqual(["claude"]);
    expect(store.defaultName).toBe("claude");
  });
});
