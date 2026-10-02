import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { privateKeyToAccount } from "viem/accounts";
import { afterEach, describe, expect, it } from "vitest";

import { appendAudit, auditLogPath, readAuditLog, type AuditRecord } from "./audit.js";
import {
  createKeystoreFromPrivateKey,
  createKeystoreWithPhrase,
  unlockKeystore,
} from "./keystore.js";
import { legacyKeystoreNames, migrateKeystores, MIGRATED_DIRECTORY } from "./vault-migrate.js";
import { createVault, openVault, type Vault } from "./vault.js";

const SLOW = 60_000;
const NOW = () => new Date("2026-09-28T12:00:00.000Z");
const VAULT_KEY = Buffer.alloc(32, 7);
const TEST_PHRASE = "test test test test test test test test test test test junk";
const IMPORT_KEY = "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const IMPORT_ADDRESS = privateKeyToAccount(IMPORT_KEY).address;
const PASSPHRASE = "migration-passphrase";
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "vapi-vault-migrate-"));
  temporaryDirectories.push(home);
  return home;
}

async function testVault(home: string): Promise<Vault> {
  return await createVault({
    path: join(home, "vault.json"),
    key: VAULT_KEY,
    phrase: TEST_PHRASE,
    now: NOW,
  });
}

async function writePrivateKeyKeystore(
  home: string,
  name: string,
  passphrase = PASSPHRASE,
): Promise<string> {
  const path = join(home, "wallets", `${name}.json`);
  await createKeystoreFromPrivateKey(passphrase, path, { privateKey: IMPORT_KEY });
  return path;
}

function resolver(passphrases: ReadonlyMap<string, string>) {
  return async (name: string) => passphrases.get(name);
}

describe("vault keystore migration", () => {
  it(
    "imports a 0.5 keystore as an imported account with the same name and address, moves the file and audits names and addresses only",
    async () => {
      const home = await temporaryHome();
      const vault = await testVault(home);
      const source = await writePrivateKeyKeystore(home, "main");
      const audits: AuditRecord[] = [];

      const migration = await migrateKeystores({
        home,
        vault,
        resolvePassphrase: resolver(new Map([["main", PASSPHRASE]])),
        now: NOW,
        audit: async (record) => {
          audits.push(record);
          return await appendAudit(home, record, { now: NOW });
        },
      });

      expect(migration).toEqual({ imported: ["main"], skipped: [] });
      expect(
        (await openVault({ path: join(home, "vault.json"), key: VAULT_KEY })).accounts(),
      ).toEqual([
        expect.objectContaining({ name: "main", kind: "imported", address: IMPORT_ADDRESS }),
      ]);
      expect((await lstat(source)).isSymbolicLink()).toBe(true);
      expect(await readlink(source)).toBe(join("..", MIGRATED_DIRECTORY, "main.json"));
      const migrated = join(home, MIGRATED_DIRECTORY, "main.json");
      expect((await stat(migrated)).mode & 0o777).toBe(0o600);
      expect(audits).toEqual([
        { event: "vault.migrate", wallet: "main", tty: false, detail: IMPORT_ADDRESS },
      ]);
      expect(await readAuditLog(home)).toEqual([
        {
          time: "2026-09-28T12:00:00.000Z",
          event: "vault.migrate",
          wallet: "main",
          tty: false,
          detail: IMPORT_ADDRESS,
        },
      ]);
    },
    SLOW,
  );

  it(
    "skips a keystore whose passphrase cannot be resolved and leaves the file where it was",
    async () => {
      const home = await temporaryHome();
      const vault = await testVault(home);
      const source = await writePrivateKeyKeystore(home, "main");
      const before = await readFile(source);

      await expect(
        migrateKeystores({
          home,
          vault,
          resolvePassphrase: async () => undefined,
          now: NOW,
        }),
      ).resolves.toEqual({
        imported: [],
        skipped: [{ name: "main", reason: "passphrase_needed" }],
      });
      expect(await readFile(source)).toEqual(before);
    },
    SLOW,
  );

  it(
    "treats a wrong passphrase as passphrase_needed and a corrupt file as unreadable",
    async () => {
      const home = await temporaryHome();
      const vault = await testVault(home);
      await writePrivateKeyKeystore(home, "wrong");
      await writeFile(join(home, "wallets", "corrupt.json"), "not json\n", { mode: 0o600 });

      await expect(
        migrateKeystores({
          home,
          vault,
          resolvePassphrase: resolver(new Map([["wrong", "incorrect"]])),
          now: NOW,
        }),
      ).resolves.toEqual({
        imported: [],
        skipped: [
          { name: "corrupt", reason: "unreadable" },
          { name: "wrong", reason: "passphrase_needed" },
        ],
      });
      await expect(stat(join(home, "wallets", "wrong.json"))).resolves.toBeDefined();
      await expect(stat(join(home, "wallets", "corrupt.json"))).resolves.toBeDefined();
    },
    SLOW,
  );

  it(
    "skips a name the vault already has",
    async () => {
      const home = await temporaryHome();
      const vault = await testVault(home);
      await vault.deriveAccount("main");
      const source = await writePrivateKeyKeystore(home, "main");
      const before = await readFile(source);

      await expect(
        migrateKeystores({
          home,
          vault,
          resolvePassphrase: resolver(new Map([["main", PASSPHRASE]])),
          now: NOW,
        }),
      ).resolves.toEqual({
        imported: [],
        skipped: [{ name: "main", reason: "name_taken" }],
      });
      expect(await readFile(source)).toEqual(before);
    },
    SLOW,
  );

  it(
    "skips a matching address whose name the vault already has without resolving its passphrase",
    async () => {
      const home = await temporaryHome();
      const vault = await testVault(home);
      await vault.importAccount("main", IMPORT_KEY);
      const source = await writePrivateKeyKeystore(home, "main");
      const before = await readFile(source);
      let resolutions = 0;

      await expect(
        migrateKeystores({
          home,
          vault,
          resolvePassphrase: async () => {
            resolutions += 1;
            return PASSPHRASE;
          },
          now: NOW,
        }),
      ).resolves.toEqual({
        imported: [],
        skipped: [{ name: "main", reason: "name_taken" }],
      });
      expect(resolutions).toBe(0);
      expect(await readFile(source)).toEqual(before);
    },
    SLOW,
  );

  it(
    "is idempotent: a second run imports nothing and reports nothing",
    async () => {
      const home = await temporaryHome();
      const vault = await testVault(home);
      await writePrivateKeyKeystore(home, "main");
      const options = {
        home,
        vault,
        resolvePassphrase: resolver(new Map([["main", PASSPHRASE]])),
        now: NOW,
      };

      await expect(migrateKeystores(options)).resolves.toEqual({ imported: ["main"], skipped: [] });
      await expect(migrateKeystores(options)).resolves.toEqual({ imported: [], skipped: [] });
    },
    SLOW,
  );

  it(
    "keeps the keystore recoverable and reports name_taken after an audit failure",
    async () => {
      const home = await temporaryHome();
      const vault = await testVault(home);
      const source = await writePrivateKeyKeystore(home, "main");
      let auditFails = true;
      const options = {
        home,
        vault,
        resolvePassphrase: resolver(new Map([["main", PASSPHRASE]])),
        now: NOW,
        audit: async (record: AuditRecord) => {
          if (auditFails) throw new Error("audit unavailable");
          return await appendAudit(home, record, { now: NOW });
        },
      };

      await expect(migrateKeystores(options)).rejects.toThrow("audit unavailable");
      expect(vault.accounts()).toEqual([
        expect.objectContaining({ name: "main", address: IMPORT_ADDRESS }),
      ]);
      await expect(stat(source)).resolves.toBeDefined();

      auditFails = false;
      await expect(migrateKeystores(options)).resolves.toEqual({
        imported: [],
        skipped: [{ name: "main", reason: "name_taken" }],
      });
      expect((await lstat(source)).isFile()).toBe(true);
      expect(await readAuditLog(home)).toHaveLength(0);
    },
    SLOW,
  );

  it(
    "migrates only the names it is asked for",
    async () => {
      const home = await temporaryHome();
      const vault = await testVault(home);
      await writePrivateKeyKeystore(home, "alpha");
      await writePrivateKeyKeystore(home, "beta");

      await expect(
        migrateKeystores({
          home,
          vault,
          resolvePassphrase: resolver(
            new Map([
              ["alpha", PASSPHRASE],
              ["beta", PASSPHRASE],
            ]),
          ),
          now: NOW,
          only: ["beta"],
        }),
      ).resolves.toEqual({ imported: ["beta"], skipped: [] });
      await expect(stat(join(home, "wallets", "alpha.json"))).resolves.toBeDefined();
      expect((await lstat(join(home, "wallets", "beta.json"))).isSymbolicLink()).toBe(true);
    },
    SLOW,
  );

  it(
    "removes the 0.2.x keystore.json symlink that pointed at a migrated file and leaves other links alone",
    async () => {
      const home = await temporaryHome();
      const vault = await testVault(home);
      await writePrivateKeyKeystore(home, "main");
      await writePrivateKeyKeystore(home, "other");
      const compatibilityPath = join(home, "keystore.json");
      await symlink(join("wallets", "main.json"), compatibilityPath);

      await migrateKeystores({
        home,
        vault,
        resolvePassphrase: resolver(
          new Map([
            ["main", PASSPHRASE],
            ["other", PASSPHRASE],
          ]),
        ),
        now: NOW,
        only: ["main"],
      });
      await expect(lstat(compatibilityPath)).rejects.toMatchObject({ code: "ENOENT" });

      await symlink(join("wallets", "elsewhere.json"), compatibilityPath);
      await migrateKeystores({
        home,
        vault,
        resolvePassphrase: resolver(new Map([["other", PASSPHRASE]])),
        now: NOW,
        only: ["other"],
      });
      expect(await readlink(compatibilityPath)).toBe(join("wallets", "elsewhere.json"));
    },
    SLOW,
  );

  it(
    "migrates a v3 keystore while preserving its Solana signer at the compatibility path",
    async () => {
      const home = await temporaryHome();
      const vault = await testVault(home);
      const path = join(home, "wallets", "phrase.json");
      const created = await createKeystoreWithPhrase(PASSPHRASE, path, {
        enableSolana: true,
        phrase: TEST_PHRASE,
      });

      await expect(
        migrateKeystores({
          home,
          vault,
          resolvePassphrase: resolver(new Map([["phrase", PASSPHRASE]])),
          now: NOW,
        }),
      ).resolves.toEqual({ imported: ["phrase"], skipped: [] });

      const signer = await (
        await openVault({ path: join(home, "vault.json"), key: VAULT_KEY })
      ).signer("phrase");
      expect(signer.address).toBe(created.account.address);
      expect((await unlockKeystore(PASSPHRASE, path)).solana?.address).toBe(
        created.account.solana?.address,
      );
    },
    SLOW,
  );

  it(
    "never writes a passphrase, phrase or private key to the audit log",
    async () => {
      const home = await temporaryHome();
      const vault = await testVault(home);
      await writePrivateKeyKeystore(home, "imported");
      const phrasePassphrase = "phrase-migration-passphrase";
      await createKeystoreWithPhrase(phrasePassphrase, join(home, "wallets", "phrase.json"), {
        phrase: TEST_PHRASE,
      });

      await migrateKeystores({
        home,
        vault,
        resolvePassphrase: resolver(
          new Map([
            ["imported", PASSPHRASE],
            ["phrase", phrasePassphrase],
          ]),
        ),
        now: NOW,
      });

      const raw = await readFile(auditLogPath(home), "utf8");
      expect(raw).toContain(IMPORT_ADDRESS);
      expect(raw).not.toContain(IMPORT_KEY.slice(2));
      expect(raw).not.toContain(PASSPHRASE);
      expect(raw).not.toContain(phrasePassphrase);
      expect(raw).not.toMatch(/\b(?:[a-z]+ ){11}[a-z]+\b/u);
    },
    SLOW,
  );

  it("lists only well-formed keystore files", async () => {
    const home = await temporaryHome();
    const wallets = join(home, "wallets");
    await mkdir(join(wallets, ".trash"), { recursive: true });
    await mkdir(join(wallets, "folder.json"));
    await Promise.all([
      writeFile(join(wallets, "main.json"), "{}"),
      writeFile(join(wallets, "alpha.json"), "{}"),
      writeFile(join(wallets, "x.tmp"), "{}"),
      writeFile(join(wallets, "main.entry.json"), "{}"),
      writeFile(join(wallets, "Bad.json"), "{}"),
    ]);
    await symlink("main.json", join(wallets, "linked.json"));

    await expect(legacyKeystoreNames(home)).resolves.toEqual(["alpha", "main"]);
    await expect(legacyKeystoreNames(join(home, "missing"))).resolves.toEqual([]);
  });
});
