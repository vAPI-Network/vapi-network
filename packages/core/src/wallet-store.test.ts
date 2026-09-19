import {
  lstat,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { DEFAULT_SPEND_CAPS, getVapiPaths } from "./config.js";
import {
  createKeystoreWithPhrase,
  encryptPrivateKey,
  KeystoreError,
  unlockKeystore,
} from "./keystore.js";
import {
  appendReceipt,
  filterReceiptsByWallet,
  readReceipts,
  renameReceiptWallet,
  type Receipt,
} from "./receipts.js";
import { readSpendLedger, readSpendLedgerRows, reserveSpend } from "./spend-policy.js";
import { assertWalletName, spendCapsForWallet, WalletStore } from "./wallet-store.js";

const PASSPHRASE = "correct horse battery staple";
const PRIVATE_KEY = "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" as Hex;
const LEGACY_ADDRESS = privateKeyToAccount(PRIVATE_KEY).address;
const SLOW = 60_000;

const temporaryDirectories: string[] = [];

afterEach(async () => {
  delete process.env.VAPI_WALLET;
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function makeHome(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "vapi-wallet-store-"));
  temporaryDirectories.push(directory);
  return directory;
}

/** A 0.2.x home: one keystore.json, one config.json, one receipts.jsonl. */
async function legacyHome(
  options: { spendCaps?: { perCallAtomic: string; perDayAtomic: string } } = {},
) {
  const home = await makeHome();
  const paths = getVapiPaths(home);
  const keystore = await encryptPrivateKey(PRIVATE_KEY, PASSPHRASE);
  await writeFile(paths.keystore, `${JSON.stringify(keystore, null, 2)}\n`, { mode: 0o600 });
  await writeFile(
    paths.config,
    `${JSON.stringify(
      {
        discoveryUrl: "https://api.vapinetwork.ai/api/call/services",
        networks: {},
        ...(options.spendCaps ? { spendCaps: options.spendCaps } : {}),
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  return { home, paths };
}

function receipt(id: string, wallet?: string): Receipt {
  return {
    id,
    timestamp: "2026-09-18T10:00:00.000Z",
    resourceUrl: "https://api.example.com/echo",
    ...(wallet === undefined ? {} : { wallet }),
  };
}

async function fileMode(path: string): Promise<number> {
  return (await stat(path)).mode & 0o777;
}

async function temporaryFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory);
  return entries.filter((entry) => entry.endsWith(".tmp"));
}

describe("wallet layout migration", () => {
  it(
    "moves a 0.2.x keystore v2 into wallets/main.json and leaves a symlink behind",
    async () => {
      const { home, paths } = await legacyHome({
        spendCaps: { perCallAtomic: "250000", perDayAtomic: "2500000" },
      });

      const store = await WalletStore.open(home);

      const mainPath = join(home, "wallets", "main.json");
      expect(await fileMode(mainPath)).toBe(0o600);
      expect(await fileMode(join(home, "wallets"))).toBe(0o700);
      expect((await lstat(paths.keystore)).isSymbolicLink()).toBe(true);
      expect(await readlink(paths.keystore)).toBe(join("wallets", "main.json"));
      expect(await fileMode(join(home, "wallets.json"))).toBe(0o600);

      const registry = store.snapshot();
      expect(registry.version).toBe(1);
      expect(registry.default).toBe("main");
      expect(registry.wallets.main?.spendCaps).toEqual({
        perCallAtomic: "250000",
        perDayAtomic: "2500000",
      });
      expect(Date.parse(registry.wallets.main!.createdAt)).toBeGreaterThan(0);

      // The keystore contents were moved, never rewritten.
      const moved: unknown = JSON.parse(await readFile(mainPath, "utf8"));
      expect(Reflect.get(moved as object, "version")).toBe(2);
      expect(Reflect.get(moved as object, "address")).toBe(LEGACY_ADDRESS);

      // Both the new path and the 0.2.x path still unlock the same wallet.
      expect((await unlockKeystore(PASSPHRASE, paths.keystore)).address).toBe(LEGACY_ADDRESS);
      expect((await store.unlock("main", PASSPHRASE)).address).toBe(LEGACY_ADDRESS);
      expect(await temporaryFiles(home)).toEqual([]);
    },
    SLOW,
  );

  it(
    "keeps the Solana account of a keystore v3 and is idempotent",
    async () => {
      const home = await makeHome();
      const paths = getVapiPaths(home);
      const created = await createKeystoreWithPhrase(PASSPHRASE, paths.keystore, {
        enableSolana: true,
      });

      const first = await WalletStore.open(home);
      const migration = await first.migrateLegacyLayout();
      const store = await WalletStore.open(home);

      expect(migration.moved).toBe(false);
      const [main] = await store.list();
      expect(main).toMatchObject({
        name: "main",
        isDefault: true,
        address: created.account.address,
        solanaAddress: created.account.solana?.address,
        keystoreVersion: 3,
        spendCaps: { ...DEFAULT_SPEND_CAPS },
      });
      expect(await readlink(paths.keystore)).toBe(join("wallets", "main.json"));
      expect((await readdir(join(home, "wallets"))).sort()).toEqual(["main.json"]);
    },
    SLOW,
  );

  it(
    "does nothing when keystore.json is already a symlink or absent",
    async () => {
      const empty = await makeHome();
      expect((await WalletStore.open(empty)).snapshot()).toEqual({ version: 1, wallets: {} });
      expect(await readdir(empty)).toEqual([]);

      const home = await makeHome();
      const paths = getVapiPaths(home);
      const store = await WalletStore.open(home);
      const created = await store.create("main", PASSPHRASE);
      await symlink(join("wallets", "main.json"), paths.keystore);

      expect((await WalletStore.open(home)).snapshot().wallets.main?.createdAt).toBe(
        created.entry.createdAt,
      );
      expect((await lstat(paths.keystore)).isSymbolicLink()).toBe(true);
    },
    SLOW,
  );

  it(
    "treats legacy receipts without a wallet as main",
    async () => {
      const { home, paths } = await legacyHome();
      await appendReceipt(receipt("legacy-1"), paths.receipts);
      await appendReceipt(receipt("agent-1", "agent"), paths.receipts);

      await WalletStore.open(home);

      const rows = await readReceipts(paths.receipts);
      expect(filterReceiptsByWallet(rows, "main").map((row) => row.id)).toEqual(["legacy-1"]);
      expect(
        (await readReceipts(paths.receipts, { wallet: "agent" })).map((row) => row.id),
      ).toEqual(["agent-1"]);
    },
    SLOW,
  );
});

describe("wallet names", () => {
  it("accepts names that are safe as file names and rejects the rest", () => {
    expect(assertWalletName("main")).toBe("main");
    expect(assertWalletName("agent-claude-2")).toBe("agent-claude-2");
    expect(assertWalletName("a".repeat(32))).toHaveLength(32);

    for (const invalid of [".", "..", "a/b", "a\\b", "../escape", "wallets/main"]) {
      expect(() => assertWalletName(invalid)).toThrow(KeystoreError);
      expect(() => assertWalletName(invalid)).toThrow(/wallet name/i);
    }
    for (const invalid of ["", "Main", "-main", "main_2", "main.json", "a".repeat(33), "café"]) {
      expect(() => assertWalletName(invalid)).toThrow(KeystoreError);
    }
  });
});

describe("wallet selection", () => {
  it(
    "prefers an explicit name, then VAPI_WALLET, then the default",
    async () => {
      const home = await makeHome();
      const store = await WalletStore.open(home);
      await store.create("main", PASSPHRASE);
      await store.create("agent", PASSPHRASE);

      expect(store.resolve().name).toBe("main");
      process.env.VAPI_WALLET = "agent";
      expect(store.resolve().name).toBe("agent");
      expect(store.resolve({ name: "main" }).name).toBe("main");
      delete process.env.VAPI_WALLET;
      expect(store.resolve({ env: { VAPI_WALLET: "agent" } }).name).toBe("agent");
      expect(store.resolve().path).toBe(join(home, "wallets", "main.json"));
    },
    SLOW,
  );

  it(
    "names the wallets that do exist when one does not",
    async () => {
      const home = await makeHome();
      const store = await WalletStore.open(home);
      await store.create("main", PASSPHRASE);

      expect(() => store.resolve({ name: "agent" })).toThrow(/No wallet named agent.*main/s);
      expect(() => store.resolve({ name: "../escape" })).toThrow(KeystoreError);
    },
    SLOW,
  );

  it("asks for vapi init when there is no wallet at all", async () => {
    const store = await WalletStore.open(await makeHome());
    expect(() => store.resolve()).toThrow("No wallet yet. Run vapi init.");
    expect(() => store.resolve({ name: "main" })).toThrow("No wallet yet. Run vapi init.");
  });
});

describe("wallet store", () => {
  it(
    "creates, imports, lists, unlocks and re-labels wallets",
    async () => {
      const home = await makeHome();
      const store = await WalletStore.open(home, {
        now: () => new Date("2026-09-19T12:00:00.000Z"),
      });

      const main = await store.create("main", PASSPHRASE, { label: "Owner" });
      expect(main.recoveryPhrase.split(" ")).toHaveLength(12);
      expect(store.defaultName).toBe("main");
      expect(main.entry).toEqual({
        createdAt: "2026-09-19T12:00:00.000Z",
        label: "Owner",
        spendCaps: { ...DEFAULT_SPEND_CAPS },
      });

      const agent = await store.importKey("agent", PASSPHRASE, PRIVATE_KEY, {
        spendCaps: { perCallAtomic: "1000", perDayAtomic: "5000" },
      });
      expect(agent.account.address).toBe(LEGACY_ADDRESS);
      expect(store.defaultName).toBe("main");

      await expect(store.create("main", PASSPHRASE)).rejects.toThrow(/already exists/);
      await expect(store.importKey("agent", PASSPHRASE, PRIVATE_KEY)).rejects.toThrow(
        /already exists/,
      );

      expect(await store.readAddress("agent")).toBe(LEGACY_ADDRESS);
      expect((await store.unlock("agent", PASSPHRASE)).address).toBe(LEGACY_ADDRESS);
      await expect(store.unlock("agent", "wrong passphrase")).rejects.toThrow(KeystoreError);

      expect((await store.list()).map((entry) => [entry.name, entry.isDefault])).toEqual([
        ["main", true],
        ["agent", false],
      ]);

      await store.setDefault("agent");
      expect(store.defaultName).toBe("agent");
      expect((await WalletStore.open(home)).defaultName).toBe("agent");

      expect(await store.setSpendCaps("agent", { perCallAtomic: "7", perDayAtomic: "9" })).toEqual({
        createdAt: "2026-09-19T12:00:00.000Z",
        spendCaps: { perCallAtomic: "7", perDayAtomic: "9" },
      });
      expect(await spendCapsForWallet(store, "agent")).toEqual({
        perCallAtomic: "7",
        perDayAtomic: "9",
      });
      await expect(
        store.setSpendCaps("agent", { perCallAtomic: "-1", perDayAtomic: "9" }),
      ).rejects.toThrow();

      expect((await store.setLabel("agent", "Claude")).label).toBe("Claude");
      expect((await store.setLabel("agent", undefined)).label).toBeUndefined();
      expect(store.entry("agent")?.label).toBeUndefined();

      expect(await fileMode(join(home, "wallets.json"))).toBe(0o600);
      expect(await fileMode(join(home, "wallets", "agent.json"))).toBe(0o600);
      expect(await temporaryFiles(home)).toEqual([]);
      expect(await temporaryFiles(join(home, "wallets"))).toEqual([]);
    },
    SLOW,
  );

  it(
    "renames the keystore file, the registry entry and the receipts of a wallet",
    async () => {
      const home = await makeHome();
      const paths = getVapiPaths(home);
      const store = await WalletStore.open(home);
      await store.create("main", PASSPHRASE);
      const agent = await store.importKey("agent", PASSPHRASE, PRIVATE_KEY);
      await appendReceipt(receipt("legacy-1"), paths.receipts);
      await appendReceipt(receipt("agent-1"), paths.receipts, { wallet: "agent" });

      const renamed = await store.rename("agent", "agent-claude");

      expect(renamed.path).toBe(join(home, "wallets", "agent-claude.json"));
      expect((await readdir(join(home, "wallets"))).sort()).toEqual([
        "agent-claude.json",
        "main.json",
      ]);
      expect(store.has("agent")).toBe(false);
      expect(store.entry("agent-claude")).toEqual(agent.entry);
      expect((await store.unlock("agent-claude", PASSPHRASE)).address).toBe(LEGACY_ADDRESS);

      const rows = await readReceipts(paths.receipts);
      expect(rows.map((row) => [row.id, row.wallet])).toEqual([
        ["legacy-1", undefined],
        ["agent-1", "agent-claude"],
      ]);
      expect(await temporaryFiles(home)).toEqual([]);

      await expect(store.rename("agent-claude", "main")).rejects.toThrow(/already exists/);
      await expect(store.rename("main", "NOPE")).rejects.toThrow(KeystoreError);
    },
    SLOW,
  );

  it(
    "repoints the 0.2.x compatibility symlink when the migrated wallet is renamed",
    async () => {
      const { home, paths } = await legacyHome();
      const store = await WalletStore.open(home);

      await store.rename("main", "owner");

      expect(await readlink(paths.keystore)).toBe(join("wallets", "owner.json"));
      expect((await unlockKeystore(PASSPHRASE, paths.keystore)).address).toBe(LEGACY_ADDRESS);
    },
    SLOW,
  );

  it(
    "refuses to remove the default wallet or a funded one, and restores from the trash",
    async () => {
      const home = await makeHome();
      const store = await WalletStore.open(home);
      await store.create("main", PASSPHRASE);
      await store.importKey("agent", PASSPHRASE, PRIVATE_KEY, { label: "Claude" });
      const entry = store.entry("agent");

      await expect(store.remove("main")).rejects.toThrow(/default wallet/);
      await expect(
        store.remove("agent", { balanceReader: async () => 2_500_000n }),
      ).rejects.toThrow(/still holds 2500000 atomic USDC/);
      expect(store.has("agent")).toBe(true);

      const removed = await store.remove("agent", {
        force: true,
        balanceReader: async () => 2_500_000n,
      });

      expect(store.has("agent")).toBe(false);
      expect(removed.path.startsWith(join(home, "wallets", ".trash"))).toBe(true);
      expect(await fileMode(removed.path)).toBe(0o600);
      expect((await readdir(join(home, "wallets"))).sort()).toEqual([".trash", "main.json"]);
      expect((await store.listTrash()).map((item) => item.name)).toEqual(["agent"]);
      await expect(store.unlock("agent", PASSPHRASE)).rejects.toThrow(/No wallet named agent/);

      const restored = await store.restore("agent");

      expect(restored.entry).toEqual(entry);
      expect((await store.unlock("agent", PASSPHRASE)).address).toBe(LEGACY_ADDRESS);
      expect(await store.listTrash()).toEqual([]);
      await expect(store.restore("agent")).rejects.toThrow(/already exists/);
      await expect(store.restore("ghost")).rejects.toThrow(/No removed wallet named ghost/);

      const unfunded = await store.remove("agent", { balanceReader: async () => 0n });
      expect(unfunded.entry).toEqual(entry);
      expect(await temporaryFiles(join(home, "wallets", ".trash"))).toEqual([]);
    },
    SLOW,
  );

  it(
    "falls back to the legacy config caps when a home has no registry",
    async () => {
      const { home } = await legacyHome({
        spendCaps: { perCallAtomic: "11", perDayAtomic: "22" },
      });
      const opened = await WalletStore.open(home);
      expect(await spendCapsForWallet(opened, "main")).toEqual({
        perCallAtomic: "11",
        perDayAtomic: "22",
      });
      expect(await spendCapsForWallet(opened, "unknown")).toEqual({
        perCallAtomic: "11",
        perDayAtomic: "22",
      });
      expect(await spendCapsForWallet(await WalletStore.open(await makeHome()))).toEqual({
        ...DEFAULT_SPEND_CAPS,
      });
    },
    SLOW,
  );
});

describe("per-wallet spend ledger", () => {
  it("keeps each wallet's daily total apart and counts legacy rows as main", async () => {
    const home = await makeHome();
    const ledgerPath = getVapiPaths(home).ledger;
    const caps = { perCallAtomic: "10", perDayAtomic: "15" };
    const now = new Date("2026-09-19T08:00:00.000Z");

    await writeFile(ledgerPath, `${JSON.stringify({ date: "2026-09-19", spentAtomic: "10" })}\n`, {
      mode: 0o600,
    });
    expect(await readSpendLedger(ledgerPath, now)).toEqual({
      date: "2026-09-19",
      spentAtomic: "10",
    });
    expect(await readSpendLedger(ledgerPath, now, "agent")).toEqual({
      date: "2026-09-19",
      spentAtomic: "0",
    });

    // The legacy row is main's, so main is nearly out of allowance ...
    await expect(reserveSpend(10n, caps, { ledgerPath, now })).rejects.toMatchObject({
      code: "per_day_cap_exceeded",
    });
    // ... while a second wallet starts its own day at zero.
    expect(await reserveSpend(10n, caps, { ledgerPath, now, wallet: "agent" })).toEqual({
      date: "2026-09-19",
      spentAtomic: "10",
    });
    expect(await reserveSpend(5n, caps, { ledgerPath, now })).toEqual({
      date: "2026-09-19",
      spentAtomic: "15",
    });

    expect(await readSpendLedgerRows(ledgerPath, now)).toEqual([
      { date: "2026-09-19", spentAtomic: "10", wallet: "agent" },
      { date: "2026-09-19", spentAtomic: "15", wallet: "main" },
    ]);
    expect(await readSpendLedgerRows(ledgerPath, new Date("2026-09-20T08:00:00.000Z"))).toEqual([]);
    expect(await fileMode(ledgerPath)).toBe(0o600);
    expect(await temporaryFiles(home)).toEqual([]);
  });

  it("writes a single main wallet in the shape 0.2.x reads", async () => {
    const home = await makeHome();
    const ledgerPath = getVapiPaths(home).ledger;
    const now = new Date("2026-09-19T08:00:00.000Z");

    await reserveSpend(3n, { perCallAtomic: "10", perDayAtomic: "15" }, { ledgerPath, now });

    expect(JSON.parse(await readFile(ledgerPath, "utf8"))).toEqual({
      date: "2026-09-19",
      spentAtomic: "3",
    });
  });
});

describe("receipts per wallet", () => {
  it("rewrites only the rows of the renamed wallet", async () => {
    const home = await makeHome();
    const path = getVapiPaths(home).receipts;
    await appendReceipt(receipt("legacy-1"), path);
    await appendReceipt(receipt("agent-1"), path, { wallet: "agent" });
    await appendReceipt(receipt("owner-1"), path, { wallet: "owner" });
    const before = await readFile(path, "utf8");

    expect(await renameReceiptWallet("agent", "agent-claude", path)).toBe(1);

    const lines = (await readFile(path, "utf8")).split("\n");
    expect(lines[0]).toBe(before.split("\n")[0]);
    expect(lines[2]).toBe(before.split("\n")[2]);
    expect(await fileMode(path)).toBe(0o600);
    expect(await temporaryFiles(home)).toEqual([]);

    // A rename of main also claims the rows that predate named wallets.
    expect(await renameReceiptWallet("main", "owner-2", path)).toBe(1);
    expect((await readReceipts(path, { wallet: "owner-2" })).map((row) => row.id)).toEqual([
      "legacy-1",
    ]);
    expect(await renameReceiptWallet("ghost", "other", path)).toBe(0);
    expect(await renameReceiptWallet("ghost", "other", join(home, "missing.jsonl"))).toBe(0);
  });

  it("keeps the wallet a receipt already names", async () => {
    const home = await makeHome();
    const path = getVapiPaths(home).receipts;
    await appendReceipt(receipt("agent-1", "agent"), path, { wallet: "main" });
    expect((await readReceipts(path))[0]?.wallet).toBe("agent");
    await expect(appendReceipt(receipt("bad", "NOPE"), path)).rejects.toThrow();
  });
});
