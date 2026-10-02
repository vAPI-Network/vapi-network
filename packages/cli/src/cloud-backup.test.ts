import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  loadOrCreateDeviceKey,
  protectVault,
  readVaultFileUnlocked,
  unlockProtectedVault,
  WalletStore,
  writeDefaultConfig,
  type SecretStore,
} from "@vapi-network/core";
import { agentSecretAccounts } from "@vapi-network/core/agent-link";
import {
  createRelayKeyPair,
  exportBackupSource,
  openBackup,
  relayCode,
  restoreBackupPlaintext,
  sealTo,
  type BackupPlaintext,
  type BackupPlaintextV2,
} from "@vapi-network/core/backup";
import { backupKeyAccount, readBackupKey, storeBackupKey } from "@vapi-network/core/cloud-backup";

import {
  runCli,
  shouldAutoUploadAfterFailure,
  shouldAutoUploadBackup,
  type CliDependencies,
  type CliIo,
} from "./cli.js";

const API_BASE = "https://api.vapinetwork.ai";
const DEVICE = "test-device";
const OWNER = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266" as const;
const OTHER_OWNER = "0x0000000000000000000000000000000000000001" as const;
const NOW = new Date("2026-09-29T10:11:12.345Z");
const EXPIRES_AT = "2026-09-29T10:21:12.345Z";
const TEST_PHRASE = "test test test test test test test test test test test junk";
const IMPORTED_PRIVATE_KEY = `0x${"11".repeat(32)}` as const;
const VAULT_PASSWORD = "correct horse battery staple";
const BACKUP_KEY = Uint8Array.from({ length: 32 }, (_, index) => index + 80);
const BACKUP_SALT = Uint8Array.from({ length: 32 }, (_, index) => index + 16);
const X25519_PRIVATE_KEY = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const KDF = {
  name: "hkdf-sha256",
  salt: Buffer.from(BACKUP_SALT).toString("base64url"),
} as const;
const REQUEST_BODIES: string[] = [];
const OUTPUTS: string[] = [];
const HOMES: string[] = [];
const originalHome = process.env.VAPI_HOME;

afterEach(async () => {
  try {
    expectSecretFree(OUTPUTS.join("\n"));
    for (const body of REQUEST_BODIES) {
      expectSecretFree(body);
      const value = JSON.parse(body) as Record<string, unknown>;
      if (value.format === "vapi-vault-backup") continue;
      expect(Object.keys(value)).toEqual(["publicKey", "code", "device", "purpose"]);
    }
    for (const home of HOMES) {
      const audit = await readFile(join(home, "audit.log"), "utf8").catch(() => "");
      expectSecretFree(audit);
    }
  } finally {
    restoreEnvironment("VAPI_HOME", originalHome);
    REQUEST_BODIES.splice(0);
    OUTPUTS.splice(0);
    await Promise.all(HOMES.splice(0).map((home) => rm(home, { recursive: true, force: true })));
    vi.restoreAllMocks();
  }
});

describe("vapi backup --cloud", () => {
  it("enrolls through a fake owner console, stores the key off disk, and uploads an openable envelope", async () => {
    const fixture = await walletFixture();
    await writeDefaultConfig(join(fixture.home, "config.json"), {}, { networks: ["base", "arc"] });
    const server = relayServer(() => enrollPayload(), { pendingOnce: true });
    const captured = captureIo();

    expect(
      await runCli(["backup", "--cloud"], captured.io, dependencies(fixture, server.fetchImpl)),
    ).toBe(0);

    expect(server.relay).toMatchObject({ device: DEVICE, purpose: "enroll" });
    const publicKey = Buffer.from(String(server.relay?.publicKey), "base64url");
    expect(server.relay?.code).toBe(relayCode(publicKey));
    expect(server.puts).toHaveLength(1);
    expect(server.putAuthorization).toBe("Bearer access-token");
    const stored = await readBackupKey({ secrets: fixture.secrets, device: DEVICE });
    expect(stored).toMatchObject({ owner: OWNER, device: DEVICE, kdf: KDF, key: BACKUP_KEY });
    stored?.key.fill(0);
    expect(await openBackup({ envelope: server.puts[0]!, key: BACKUP_KEY })).toMatchObject({
      registry: { default: "cold", networks: ["eip155:5042", "eip155:8453"] },
    });
    expect(captured.stdout).toEqual([
      `Open ${API_BASE}/agents and enter code ${String(server.relay?.code)}.`,
      expect.stringMatching(
        /^Cloud backup on\. Uploaded \d+(?:\.\d)? (?:B|KB) at 2026-09-29 10:11 UTC\.$/u,
      ),
    ]);
    expect(captured.stderr).toEqual(["Waiting for the owner to approve…"]);
    expect(await directoryContents(fixture.home)).not.toContain(
      Buffer.from(BACKUP_KEY).toString("base64url"),
    );
    expect(await directoryContents(fixture.home)).not.toContain(
      Buffer.from(BACKUP_KEY).toString("hex"),
    );
  });

  it("reports omitted backup sections in JSON and on stderr", async () => {
    const fixture = await walletFixture();
    const server = relayServer(() => enrollPayload());
    const captured = captureIo();

    expect(
      await runCli(["backup", "--cloud", "--json"], captured.io, {
        ...dependencies(fixture, server.fetchImpl),
        cloudBackup: {
          ...dependencies(fixture, server.fetchImpl).cloudBackup,
          uploadBackup: async () => ({
            status: "uploaded",
            account: "main",
            bytes: 64_000,
            uploadedAt: NOW.toISOString(),
            omitted: ["agents", "swarms"],
          }),
        },
      }),
    ).toBe(0);

    expect(JSON.parse(captured.stdout[0]!)).toEqual({
      command: "backup",
      cloud: "on",
      device: DEVICE,
      bytes: 64_000,
      uploadedAt: NOW.toISOString(),
      omitted: ["agents", "swarms"],
    });
    expect(captured.stderr).toEqual([
      `Open ${API_BASE}/agents and enter code ${String(server.relay?.code)}.`,
      "Waiting for the owner to approve…",
      "Cloud backup left out agents, swarms: they do not fit the 64 KB backup limit.",
    ]);
  });

  it("warns for every agent profile skipped during export", async () => {
    const fixture = await walletFixture();
    const server = relayServer(() => enrollPayload());
    const captured = captureIo();

    expect(
      await runCli(["backup", "--cloud", "--json"], captured.io, {
        ...dependencies(fixture, server.fetchImpl),
        cloudBackup: {
          ...dependencies(fixture, server.fetchImpl).cloudBackup,
          uploadBackup: async () => ({
            status: "uploaded",
            account: "main",
            bytes: 1_024,
            uploadedAt: NOW.toISOString(),
            skipped: [
              { kind: "agent", name: "broken-one", reason: "invalid_profile" },
              { kind: "agent", name: "broken-two", reason: "invalid_profile" },
            ],
          }),
        },
      }),
    ).toBe(0);

    expect(JSON.parse(captured.stdout[0]!)).toMatchObject({
      command: "backup",
      skipped: [
        { kind: "agent", name: "broken-one", reason: "invalid_profile" },
        { kind: "agent", name: "broken-two", reason: "invalid_profile" },
      ],
    });
    expect(captured.stderr).toContain("Cloud backup skipped agent broken-one: invalid_profile.");
    expect(captured.stderr).toContain("Cloud backup skipped agent broken-two: invalid_profile.");
  });

  it.each([
    ["wrong device", () => ({ ...enrollPayload(), device: "other-device" })],
    ["wrong purpose", (vault: BackupPlaintext) => restorePayload(vault)],
    ["wrong owner", () => ({ ...enrollPayload(), owner: OTHER_OWNER })],
    [
      "a 31-byte key",
      () => ({
        ...enrollPayload(),
        key: Buffer.from(BACKUP_KEY.subarray(0, 31)).toString("base64url"),
      }),
    ],
    ["an unknown field", () => ({ ...enrollPayload(), unexpected: true })],
  ] as const)("refuses %s without storing or uploading", async (_name, makePayload) => {
    const fixture = await walletFixture();
    const vault = await exportedPlaintext(fixture);
    const server = relayServer(() => makePayload(vault));
    const captured = captureIo();

    expect(
      await runCli(["backup", "--cloud"], captured.io, dependencies(fixture, server.fetchImpl)),
    ).toBe(1);

    expect(fixture.secrets.entries.has(backupKeyAccount(DEVICE))).toBe(false);
    expect(server.puts).toEqual([]);
  });

  it("reports an expired relay result without storing or uploading", async () => {
    const fixture = await walletFixture();
    const server = relayServer(() => enrollPayload(), { resultStatus: 404 });
    const captured = captureIo();

    expect(
      await runCli(["backup", "--cloud"], captured.io, dependencies(fixture, server.fetchImpl)),
    ).toBe(1);

    expect(captured.stderr.join("\n")).toContain("backup code expired");
    expect(fixture.secrets.entries.has(backupKeyAccount(DEVICE))).toBe(false);
    expect(server.puts).toEqual([]);
  });

  it("checks the local relay deadline before polling", async () => {
    const fixture = await walletFixture();
    const keyPair = createRelayKeyPair({ randomBytes: () => Uint8Array.from(X25519_PRIVATE_KEY) });
    const fetchImpl = recordingFetch(async (input) => {
      if (new URL(String(input)).pathname.endsWith("/siblings")) {
        return Response.json({ owner: OWNER, siblings: [] });
      }
      throw new Error("the expired relay must not be polled");
    });
    const captured = captureIo();

    expect(
      await runCli(["backup", "--cloud"], captured.io, {
        ...dependencies(fixture, fetchImpl),
        now: () => new Date(EXPIRES_AT),
        cloudBackup: {
          ...dependencies(fixture, fetchImpl).cloudBackup,
          startRelay: async () => ({
            code: relayCode(keyPair.publicKey),
            expiresAt: EXPIRES_AT,
            keyPair,
          }),
        },
      }),
    ).toBe(1);

    expect(captured.stderr.join("\n")).toContain("backup code expired");
    expect(fixture.secrets.entries.has(backupKeyAccount(DEVICE))).toBe(false);
  });

  it("turns uploads off idempotently and points to the console", async () => {
    const fixture = await walletFixture();
    await storeFixtureBackupKey(fixture.secrets);
    const first = captureIo();
    const second = captureIo();

    expect(await runCli(["backup", "--cloud", "off"], first.io, dependencies(fixture))).toBe(0);
    expect(await runCli(["backup", "--cloud", "off"], second.io, dependencies(fixture))).toBe(0);

    const sentence = `Cloud backup uploads stopped; delete the stored copy in the console at ${API_BASE}/agents.`;
    expect(first.stdout).toEqual([sentence]);
    expect(second.stdout).toEqual([sentence]);
    expect(fixture.secrets.entries.has(backupKeyAccount(DEVICE))).toBe(false);
  });

  it("refuses a duplicate device name before creating a relay", async () => {
    const fixture = await walletFixture();
    const remoteAddress = `0x${"22".repeat(20)}` as const;
    const start = vi.fn(async () => {
      throw new Error("must not start");
    });
    const captured = captureIo();

    expect(
      await runCli(["backup", "--cloud"], captured.io, {
        ...dependencies(fixture),
        cloudBackup: {
          ...dependencies(fixture).cloudBackup,
          startRelay: start,
          fetchSiblings: async ({ account }) => ({
            owner: OWNER,
            source: { account },
            siblings: [
              {
                name: "remote",
                address: remoteAddress,
                device: DEVICE,
                status: "active",
                allowance: { routerPerDayUsd: null, perCallUsd: null, perDayUsd: null },
                self: false,
              },
            ],
          }),
        },
      }),
    ).toBe(1);

    expect(captured.stderr).toContain(
      `Device name "${DEVICE}" is already used on another device. Backups with the same name overwrite. Set VAPI_DEVICE or device in ~/.vapi/config.json to rename this device.`,
    );
    expect(start).not.toHaveBeenCalled();
  });
});

describe("vapi restore --from-owner", () => {
  it("restores protected derived and imported accounts, metadata, caps, and the default", async () => {
    const source = await walletFixture();
    await protectVault({
      path: join(source.home, "vault.json"),
      secrets: source.secrets,
      password: VAULT_PASSWORD,
      randomBytes: () => Uint8Array.from({ length: 32 }, () => 9),
    });
    const sourceKey = await unlockProtectedVault({
      path: join(source.home, "vault.json"),
      secrets: source.secrets,
      password: VAULT_PASSWORD,
      now: () => NOW,
    });
    const sourceVault = await exportBackupSource({
      store: source.store,
      vaultKey: sourceKey,
      networks: ["eip155:1", "eip155:8453"],
    });
    sourceKey.fill(0);

    const target = await emptyFixture();
    const server = relayServer(() => restorePayload({ v: 2, ...sourceVault }));
    const captured = captureIo();

    expect(
      await runCli(["restore", "--from-owner", "--owner", OWNER], captured.io, {
        ...dependencies(target, server.fetchImpl),
        env: { VAPI_DEVICE: DEVICE, VAPI_VAULT_PASSWORD: VAULT_PASSWORD },
      }),
    ).toBe(0);

    const restored = await WalletStore.open(target.home, {
      secrets: target.secrets,
      env: { VAPI_VAULT_PASSWORD: VAULT_PASSWORD },
    });
    expect(restored.names()).toEqual(["main", "cold"]);
    expect(restored.defaultName).toBe("cold");
    expect(await restored.list()).toMatchObject([
      {
        name: "main",
        label: "Primary",
        spendCaps: { perCallAtomic: "10", perDayAtomic: "100" },
      },
      {
        name: "cold",
        label: "Offline",
        spendCaps: { perCallAtomic: "20", perDayAtomic: "200" },
      },
    ]);
    expect(await readVaultFileUnlocked(join(target.home, "vault.json"))).toMatchObject({
      protected: true,
      accounts: [
        { name: "main", kind: "derived" },
        { name: "cold", kind: "imported" },
      ],
    });
    expect(captured.stdout.at(-1)).toContain(
      "Cloud backups resume after vapi login links this device.",
    );
    expect(captured.stderr.at(-1)).toBe(
      "Cloud backup not updated: link this device with vapi login.",
    );
  });

  it("reports restored v2 sections and the movement resume command in human and JSON output", async () => {
    const source = await walletFixture();
    const vault = await exportedV2Plaintext(source);

    const humanTarget = await emptyFixture();
    const humanServer = relayServer(() => restorePayload(vault));
    const human = captureIo();
    expect(
      await runCli(["restore", "--from-owner", "--owner", OWNER], human.io, {
        ...dependencies(humanTarget, humanServer.fetchImpl),
        env: { VAPI_DEVICE: DEVICE },
      }),
    ).toBe(0);
    expect(human.stdout.at(-1)).toContain("Restored agents: researcher");
    expect(human.stdout.at(-1)).toContain("Restored swarms: team");
    expect(human.stdout.at(-1)).toContain(
      "Unfinished movement mv_cloud001 from main: vapi accounts distribute --resume mv_cloud001",
    );

    const jsonTarget = await emptyFixture();
    const jsonServer = relayServer(() => restorePayload(vault));
    const json = captureIo();
    expect(
      await runCli(["restore", "--from-owner", "--owner", OWNER, "--json"], json.io, {
        ...dependencies(jsonTarget, jsonServer.fetchImpl),
        env: { VAPI_DEVICE: DEVICE },
      }),
    ).toBe(0);
    expect(JSON.parse(json.stdout.at(-1)!)).toMatchObject({
      agents: ["researcher"],
      swarms: ["team"],
      movements: [{ id: "mv_cloud001", pendingLegs: 1, unknownLegs: 0 }],
      skipped: [],
      conflicts: [],
    });
  });

  it("resumes an interrupted restore through the public owner restore command", async () => {
    const source = await walletFixture();
    const vault = await exportedV2Plaintext(source);
    const target = await emptyFixture();
    const vaultKey = await loadOrCreateDeviceKey({ secrets: target.secrets });
    try {
      await expect(
        restoreBackupPlaintext({
          plaintext: vault,
          home: target.home,
          vaultKey,
          device: DEVICE,
          afterPublish: async (step) => {
            if (step.kind === "vault") throw new Error("interrupted after vault");
          },
        }),
      ).rejects.toThrow("interrupted after vault");
    } finally {
      vaultKey.fill(0);
    }

    const server = relayServer(() => restorePayload(vault));
    const captured = captureIo();
    const exitCode = await runCli(
      ["restore", "--from-owner", "--owner", OWNER],
      captured.io,
      dependencies(target, server.fetchImpl),
    );
    expect(exitCode, captured.stderr.join("\n")).toBe(0);

    expect(server.relay).toMatchObject({ device: DEVICE, purpose: "restore" });
    expect(await fileExists(join(target.home, "wallets.json"))).toBe(true);
    expect(await fileExists(join(target.home, ".backup-restore.json"))).toBe(false);
    expect(captured.stdout.at(-1)).toContain("Vault restored with 2 account(s)");
  });

  it("refuses an existing vault with no interrupted restore before contacting the owner", async () => {
    const target = await walletFixture();
    const existingVault = await readFile(join(target.home, "vault.json"));
    const server = relayServer(() => {
      throw new Error("the relay must not be reached");
    });
    const captured = captureIo();

    expect(
      await runCli(
        ["restore", "--from-owner", "--owner", OWNER],
        captured.io,
        dependencies(target, server.fetchImpl),
      ),
    ).toBe(1);

    expect(server.relay).toBeUndefined();
    expect(captured.stderr.join("\n")).toContain("A vault already exists in");
    await expect(readFile(join(target.home, "vault.json"))).resolves.toEqual(existingVault);
    expect(target.secrets.entries.has(backupKeyAccount(DEVICE))).toBe(false);
  });

  it("refuses an unrelated existing vault after authenticating the owner backup", async () => {
    const source = await walletFixture();
    const vault = await exportedPlaintext(source);
    const target = await walletFixture();
    await writeFile(join(target.home, ".backup-restore.json"), "{}", { mode: 0o600 });
    const existingVault = await readFile(join(target.home, "vault.json"));
    const server = relayServer(() => restorePayload(vault));
    const captured = captureIo();

    expect(
      await runCli(
        ["restore", "--from-owner", "--owner", OWNER],
        captured.io,
        dependencies(target, server.fetchImpl),
      ),
    ).toBe(1);

    expect(server.relay).toMatchObject({ device: DEVICE, purpose: "restore" });
    await expect(readFile(join(target.home, "vault.json"))).resolves.toEqual(existingVault);
    expect(target.secrets.entries.has(backupKeyAccount(DEVICE))).toBe(false);
  });

  it("refuses a restore payload from a different --owner", async () => {
    const source = await walletFixture();
    const vault = await exportedPlaintext(source);
    const target = await emptyFixture();
    const server = relayServer(() => ({ ...restorePayload(vault), owner: OTHER_OWNER }));
    const captured = captureIo();

    expect(
      await runCli(
        ["restore", "--from-owner", "--owner", OWNER],
        captured.io,
        dependencies(target, server.fetchImpl),
      ),
    ).toBe(1);

    expect(captured.stderr.join("\n")).toContain("another owner");
    expect(target.secrets.entries.has(backupKeyAccount(DEVICE))).toBe(false);
    expect(await fileExists(join(target.home, "vault.json"))).toBe(false);
    expect(server.puts).toEqual([]);
  });

  it("shows the owner and asks before an interactive restore", async () => {
    const source = await walletFixture();
    const vault = await exportedPlaintext(source);
    const target = await emptyFixture();
    const server = relayServer(() => restorePayload(vault));
    const prompted: string[] = [];
    const captured = captureIo();

    expect(
      await runCli(["restore", "--from-owner"], captured.io, {
        ...dependencies(target, server.fetchImpl),
        interactive: true,
        openUrl: vi.fn(() => true),
        prompts: {
          secret: async () => {
            throw new Error("no secret prompt expected");
          },
          line: async (prompt) => {
            prompted.push(prompt);
            return "yes";
          },
        },
      }),
    ).toBe(0);

    expect(captured.stdout).toContain(`Owner: ${OWNER}`);
    expect(prompted).toEqual(["Restore this owner's vault here? [y/N] "]);
  });

  it("requires --owner before a non-interactive relay starts", async () => {
    const target = await emptyFixture();
    const start = vi.fn(async () => {
      throw new Error("must not start");
    });
    const captured = captureIo();

    expect(
      await runCli(["restore", "--from-owner"], captured.io, {
        ...dependencies(target),
        cloudBackup: { ...dependencies(target).cloudBackup, startRelay: start },
      }),
    ).toBe(1);

    expect(captured.stderr).toEqual(["Non-interactive owner restore requires --owner <0x…>."]);
    expect(start).not.toHaveBeenCalled();
    expect(await fileExists(join(target.home, "vault.json"))).toBe(false);
  });
});

describe("automatic cloud backup", () => {
  it("uploads once after accounts add, rename, and caps when cloud backup is on", async () => {
    const fixture = await walletFixture();
    await storeFixtureBackupKey(fixture.secrets);
    const puts: string[] = [];
    const fetchImpl = uploadFetch(puts);

    expect(
      await runCli(
        ["accounts", "add", "new", "--no-link"],
        captureIo().io,
        dependencies(fixture, fetchImpl),
      ),
    ).toBe(0);
    expect(
      await runCli(
        ["accounts", "rename", "new", "renamed"],
        captureIo().io,
        dependencies(fixture, fetchImpl),
      ),
    ).toBe(0);
    expect(
      await runCli(
        ["accounts", "caps", "renamed", "--per-call", "0.01", "--per-day", "1"],
        captureIo().io,
        dependencies(fixture, fetchImpl),
      ),
    ).toBe(0);

    expect(puts).toHaveLength(3);
  });

  it("warns when an automatic upload leaves out backup sections", async () => {
    const fixture = await walletFixture();
    await storeFixtureBackupKey(fixture.secrets);
    const captured = captureIo();

    expect(
      await runCli(["accounts", "caps", "main", "--ceiling", "5"], captured.io, {
        ...dependencies(fixture),
        cloudBackup: {
          ...dependencies(fixture).cloudBackup,
          uploadBackup: async () => ({
            status: "uploaded",
            account: "main",
            bytes: 64_000,
            uploadedAt: NOW.toISOString(),
            omitted: ["agents"],
          }),
        },
      }),
    ).toBe(0);

    expect(captured.stderr).toEqual([
      "Cloud backup left out agents: they do not fit the 64 KB backup limit.",
    ]);
  });

  it("does not read a backup key or request an upload when cloud backup is off", async () => {
    const fixture = await walletFixture();
    const get = vi.spyOn(fixture.secrets, "get");
    const fetchImpl = vi.fn<typeof fetch>();

    expect(
      await runCli(
        ["accounts", "add", "new", "--no-link"],
        captureIo().io,
        dependencies(fixture, fetchImpl),
      ),
    ).toBe(0);

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(get.mock.calls.some(([name]) => name === backupKeyAccount(DEVICE))).toBe(false);
  });

  it("bounds a stalled secret-store probe after the account command completes", async () => {
    const fixture = await walletFixture();
    await storeFixtureBackupKey(fixture.secrets);
    const originalHas = fixture.secrets.has.bind(fixture.secrets);
    fixture.secrets.has = async (name) => {
      if (name === backupKeyAccount(DEVICE)) return await new Promise<boolean>(() => undefined);
      return await originalHas(name);
    };
    const captured = captureIo();

    expect(
      await runCli(
        ["accounts", "caps", "main", "--per-call", "0.01", "--per-day", "1"],
        captured.io,
        {
          ...dependencies(fixture),
          cloudBackup: { ...dependencies(fixture).cloudBackup, uploadTimeoutMs: 20 },
        },
      ),
    ).toBe(0);

    expect(captured.stderr).toEqual(["Cloud backup not updated: the upload timed out."]);
  });

  it("uploads an account created before a failed link attempt", async () => {
    const fixture = await walletFixture();
    await storeFixtureBackupKey(fixture.secrets);
    const puts: string[] = [];
    const captured = captureIo();

    expect(
      await runCli(["accounts", "add", "new"], captured.io, {
        ...dependencies(fixture, uploadFetch(puts)),
        agentLink: {
          startDeviceLink: async () => ({
            clientId: "new-client",
            deviceCode: "device-code",
            userCode: "ABCD-EFGH",
            verificationUri: `${API_BASE}/link`,
            verificationUriComplete: `${API_BASE}/link?code=ABCD-EFGH`,
            expiresIn: 600,
            interval: 5,
            autoApproved: true,
          }),
          pollDeviceLink: async () => {
            throw new Error("The owner denied the agent link.");
          },
        },
      }),
    ).toBe(1);

    expect(captured.stdout).toContainEqual(expect.stringContaining("Account new derived:"));
    expect(captured.stderr).toContain("The owner denied the agent link.");
    expect(puts).toHaveLength(1);
    await expect(openBackup({ envelope: puts[0]!, key: BACKUP_KEY })).resolves.toMatchObject({
      registry: { accounts: expect.arrayContaining([expect.objectContaining({ name: "new" })]) },
    });
  });

  it("uploads after setup links a restored device that already has a backup key", async () => {
    const fixture = await walletFixture();
    await fixture.store.clearLink("main");
    await storeFixtureBackupKey(fixture.secrets);
    const puts: string[] = [];

    expect(
      await runCli(["setup", "--no-cloud-backup"], captureIo().io, {
        ...dependencies(fixture, uploadFetch(puts)),
        agentLink: {
          startDeviceLink: async () => ({
            clientId: "restored-client",
            deviceCode: "device-code",
            userCode: "ABCD-EFGH",
            verificationUri: `${API_BASE}/link`,
            verificationUriComplete: `${API_BASE}/link?code=ABCD-EFGH`,
            expiresIn: 600,
            interval: 5,
            autoApproved: true,
          }),
          pollDeviceLink: async () => ({
            tokens: {
              accessToken: "restored-access-token",
              refreshToken: "restored-refresh-token",
              expiresAt: Number.MAX_SAFE_INTEGER,
              scopes: ["mcp:call"],
            },
            owner: OWNER,
          }),
        },
      }),
    ).toBe(0);

    expect(puts).toHaveLength(1);
  });

  it("includes every configured network in an automatic upload", async () => {
    const fixture = await walletFixture();
    await writeDefaultConfig(join(fixture.home, "config.json"), {}, { networks: ["base", "arc"] });
    await storeFixtureBackupKey(fixture.secrets);
    const puts: string[] = [];

    expect(
      await runCli(
        ["accounts", "caps", "main", "--per-call", "0.01", "--per-day", "1"],
        captureIo().io,
        dependencies(fixture, uploadFetch(puts)),
      ),
    ).toBe(0);

    await expect(openBackup({ envelope: puts[0]!, key: BACKUP_KEY })).resolves.toMatchObject({
      registry: { networks: ["eip155:5042", "eip155:8453"] },
    });
  });

  it.each([
    [
      "an HTTP rejection",
      async () => new Response(null, { status: 500 }),
      "the backup was rejected with HTTP 500",
    ],
    [
      "a network error",
      async () => {
        throw new Error("offline");
      },
      "the network request failed",
    ],
  ])("keeps exit zero and prints one line after %s", async (_name, response, reason) => {
    const fixture = await walletFixture();
    await storeFixtureBackupKey(fixture.secrets);
    const fetchImpl = recordingFetch(response);
    const captured = captureIo();

    expect(
      await runCli(
        ["accounts", "add", "new", "--no-link"],
        captured.io,
        dependencies(fixture, fetchImpl),
      ),
    ).toBe(0);

    expect(captured.stderr).toEqual([`Cloud backup not updated: ${reason}.`]);
  });
});

type MemorySecretStore = SecretStore & { entries: Map<string, string> };

type Fixture = {
  home: string;
  store: WalletStore;
  secrets: MemorySecretStore;
};

async function walletFixture(): Promise<Fixture> {
  const fixture = await emptyFixture();
  await fixture.store.create("main", "", {
    phrase: TEST_PHRASE,
    label: "Primary",
    spendCaps: { perCallAtomic: "10", perDayAtomic: "100" },
  });
  await fixture.store.importKey("cold", "", IMPORTED_PRIVATE_KEY, {
    label: "Offline",
    spendCaps: { perCallAtomic: "20", perDayAtomic: "200" },
  });
  await fixture.store.setDefault("cold");
  await fixture.store.setLink("main", {
    apiBase: API_BASE,
    clientId: "cloud-backup-test",
    owner: OWNER,
    label: "Test device",
    scopes: ["mcp:call", "router.use"],
    linkedAt: NOW.toISOString(),
  });
  await fixture.secrets.set(
    agentSecretAccounts("main").tokens,
    JSON.stringify({
      accessToken: "access-token",
      refreshToken: "refresh-token",
      expiresAt: Number.MAX_SAFE_INTEGER,
      scopes: ["mcp:call", "router.use"],
    }),
  );
  return fixture;
}

async function emptyFixture(): Promise<Fixture> {
  const home = await temporaryHome();
  process.env.VAPI_HOME = home;
  const secrets = memoryStore();
  const store = await WalletStore.open(home, {
    secrets,
    now: () => NOW,
    audit: async () => undefined,
  });
  return { home, store, secrets };
}

function dependencies(
  fixture: Fixture,
  fetchImpl: typeof fetch = vi.fn<typeof fetch>(),
): CliDependencies {
  return {
    interactive: false,
    env: { VAPI_DEVICE: DEVICE },
    hostname: () => DEVICE,
    now: () => NOW,
    fetchImpl,
    secretStore: fixture.secrets,
    cloudBackup: {
      sleep: async () => undefined,
      randomBytes: cliRandom,
      uploadTimeoutMs: 2_000,
    },
  };
}

function relayServer(
  payload: () => Record<string, unknown>,
  options: { pendingOnce?: boolean; resultStatus?: number } = {},
): {
  fetchImpl: typeof fetch;
  relay?: Record<string, unknown>;
  puts: string[];
  putAuthorization?: string | null;
} {
  const server: {
    fetchImpl: typeof fetch;
    relay?: Record<string, unknown>;
    puts: string[];
    putAuthorization?: string | null;
  } = { fetchImpl: vi.fn<typeof fetch>(), puts: [] };
  let polls = 0;
  server.fetchImpl = recordingFetch(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname === "/api/agents/self/siblings") {
      return Response.json({ owner: OWNER, siblings: [] });
    }
    if (url.pathname === "/api/agents/backup-relays" && init?.method === "POST") {
      server.relay = JSON.parse(String(init.body)) as Record<string, unknown>;
      const publicKey = Buffer.from(String(server.relay.publicKey), "base64url");
      if (server.relay.code !== relayCode(publicKey)) {
        return new Response(null, { status: 400 });
      }
      return Response.json({ code: server.relay.code, expiresAt: EXPIRES_AT }, { status: 201 });
    }
    if (url.pathname.endsWith("/result")) {
      polls += 1;
      if (options.resultStatus !== undefined) {
        return new Response(null, { status: options.resultStatus });
      }
      if (options.pendingOnce && polls === 1) {
        return Response.json({ status: "pending" }, { status: 202 });
      }
      const recipientPublicKey = Buffer.from(String(server.relay?.publicKey), "base64url");
      return Response.json({
        sealed: sealTo({
          recipientPublicKey,
          plaintext: JSON.stringify(payload()),
          randomBytes: sealingRandom,
        }),
      });
    }
    if (url.pathname === "/api/agents/self/backup" && init?.method === "PUT") {
      server.puts.push(String(init.body));
      const headers = new Headers(input instanceof Request ? input.headers : init.headers);
      server.putAuthorization = headers.get("authorization");
      return new Response(null, { status: 204 });
    }
    throw new Error(`Unexpected request ${init?.method ?? "GET"} ${url.pathname}`);
  });
  return server;
}

function uploadFetch(puts: string[]): typeof fetch {
  return recordingFetch(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname !== "/api/agents/self/backup") {
      throw new Error(`Unexpected request ${url.pathname}`);
    }
    puts.push(String(init?.body));
    return new Response(null, { status: 204 });
  });
}

function recordingFetch(
  handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (typeof init?.body === "string") REQUEST_BODIES.push(init.body);
    return await handler(input, init);
  }) as typeof fetch;
}

function enrollPayload(): Record<string, unknown> {
  return {
    format: "vapi-vault-relay-payload",
    v: 1,
    purpose: "enroll",
    owner: OWNER,
    device: DEVICE,
    kdf: KDF,
    key: Buffer.from(BACKUP_KEY).toString("base64url"),
  };
}

function restorePayload(vault: BackupPlaintext): Record<string, unknown> {
  return { ...enrollPayload(), purpose: "restore", vault };
}

async function exportedPlaintext(fixture: Fixture): Promise<BackupPlaintext> {
  const key = await loadOrCreateDeviceKey({ secrets: fixture.secrets });
  try {
    return {
      v: 2,
      ...(await exportBackupSource({
        store: fixture.store,
        vaultKey: key,
        networks: ["eip155:8453"],
      })),
    };
  } finally {
    key.fill(0);
  }
}

async function exportedV2Plaintext(fixture: Fixture): Promise<BackupPlaintextV2> {
  const key = await loadOrCreateDeviceKey({ secrets: fixture.secrets });
  try {
    const source = await exportBackupSource({
      store: fixture.store,
      vaultKey: key,
      networks: ["eip155:8453"],
    });
    const main = source.accounts.find((account) => account.name === "main")!;
    return {
      v: 2,
      ...source,
      agents: [
        {
          version: 1,
          name: "researcher",
          wallet: "main",
          model: "openai/gpt-5-mini",
          instructions: "Research carefully.",
          verifiedOnly: true,
          approveAboveUsd: 0.5,
          maxSteps: 12,
          paused: false,
          createdAt: NOW.toISOString(),
          tools: ["call.search", "call.inspect", "call.pay"],
        },
      ],
      swarms: [
        {
          v: 1,
          name: "team",
          device: "old-device",
          network: "eip155:8453",
          createdAt: NOW.toISOString(),
          treasury: {
            account: "main",
            address: main.address,
            steps: { creating: false, created: true, capped: true, linked: true },
          },
          members: [],
          policy: {
            strategy: "targets",
            treasuryCaps: { perCallAtomic: "5000000", perDayAtomic: "20000000" },
          },
        },
      ],
      movements: [
        {
          v: 2,
          id: "mv_cloud001",
          reason: "distribute",
          from: "main",
          network: "eip155:8453",
          createdAt: NOW.toISOString(),
          legs: [
            {
              from: "main",
              to: "0x2222222222222222222222222222222222222222",
              amountUsd: "1.00",
              purpose: "send",
              nonce: `0x${"44".repeat(32)}`,
              status: "planned",
            },
          ],
        },
      ],
      transferReceipts: [],
    };
  } finally {
    key.fill(0);
  }
}

async function storeFixtureBackupKey(secrets: SecretStore): Promise<void> {
  await storeBackupKey({
    secrets,
    device: DEVICE,
    owner: OWNER,
    kdf: KDF,
    key: BACKUP_KEY,
  });
}

function memoryStore(): MemorySecretStore {
  const entries = new Map<string, string>();
  return {
    entries,
    available: true,
    platform: "darwin",
    description: "the test keychain",
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

function captureIo(): { io: CliIo; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      stdout: (message) => {
        stdout.push(message);
        OUTPUTS.push(message);
      },
      stderr: (message) => {
        stderr.push(message);
        OUTPUTS.push(message);
      },
    },
  };
}

function cliRandom(length: number): Uint8Array {
  return length === 32
    ? Uint8Array.from(X25519_PRIVATE_KEY)
    : Uint8Array.from({ length }, (_, index) => index + 7);
}

function sealingRandom(length: number): Uint8Array {
  return Uint8Array.from({ length }, (_, index) => index + (length === 32 ? 33 : 99));
}

async function temporaryHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "vapi-cli-cloud-backup-"));
  HOMES.push(home);
  return home;
}

async function directoryContents(directory: string): Promise<string> {
  const names = await readdir(directory, { recursive: true });
  const contents: string[] = [];
  for (const name of names) {
    try {
      contents.push(await readFile(join(directory, name), "utf8"));
    } catch {
      // Directories have no UTF-8 contents.
    }
  }
  return contents.join("\n");
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

function expectSecretFree(value: string): void {
  expect(value).not.toContain(TEST_PHRASE);
  expect(value).not.toContain(IMPORTED_PRIVATE_KEY);
  expect(value).not.toContain(IMPORTED_PRIVATE_KEY.slice(2));
  expect(value).not.toContain(Buffer.from(BACKUP_KEY).toString("base64url"));
  expect(value).not.toContain(Buffer.from(BACKUP_KEY).toString("hex"));
  expect(value).not.toContain(Buffer.from(X25519_PRIVATE_KEY).toString("base64url"));
  expect(value).not.toContain(Buffer.from(X25519_PRIVATE_KEY).toString("hex"));
  expect(value).not.toContain(VAULT_PASSWORD);
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

describe("automatic cloud backup after swarm commands", () => {
  it("uploads after every mutating swarm command, also when it ends unfinished", () => {
    for (const subcommand of ["create", "add", "fund", "rebalance", "remove", "dissolve"]) {
      expect(shouldAutoUploadBackup(["swarm", subcommand, "team"])).toBe(true);
      expect(shouldAutoUploadAfterFailure(["swarm", subcommand, "team"])).toBe(true);
    }
    expect(shouldAutoUploadBackup(["swarm", "status", "team"])).toBe(false);
    expect(shouldAutoUploadAfterFailure(["swarm", "status", "team"])).toBe(false);
  });

  it("uploads after account distribution, including an unfinished result", () => {
    expect(shouldAutoUploadBackup(["accounts", "distribute", "1", "--from", "main"])).toBe(true);
    expect(shouldAutoUploadAfterFailure(["accounts", "distribute", "1", "--from", "main"])).toBe(
      true,
    );
    expect(shouldAutoUploadBackup(["wallet", "distribute", "1", "--from", "main"])).toBe(false);
    expect(shouldAutoUploadAfterFailure(["wallet", "distribute", "1", "--from", "main"])).toBe(
      false,
    );
  });

  it.each(["create", "pause", "resume", "revoke"])(
    "uploads after agent %s only when the command succeeds",
    (subcommand) => {
      expect(shouldAutoUploadBackup(["agent", subcommand, "researcher"])).toBe(true);
      expect(shouldAutoUploadAfterFailure(["agent", subcommand, "researcher"])).toBe(false);
    },
  );

  it("uploads after changing automatic Router refill settings", () => {
    expect(shouldAutoUploadBackup(["router", "buy", "--auto", "5", "--below", "1"])).toBe(true);
    expect(shouldAutoUploadBackup(["router", "buy", "5"])).toBe(false);
    expect(shouldAutoUploadAfterFailure(["router", "buy", "--auto", "5", "--below", "1"])).toBe(
      false,
    );
  });
});
