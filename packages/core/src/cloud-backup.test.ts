import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { privateKeyToAccount } from "viem/accounts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { agentSecretAccounts } from "./agent-link.js";
import { writeAgentProfile } from "./agent-profile.js";
import {
  createRelayKeyPair,
  exportBackupSource,
  openBackup,
  readBackupHeader,
  relayCode,
  sealTo,
  type BackupPlaintext,
  type BackupPlaintextV2,
} from "./backup.js";
import {
  awaitRelay,
  backupKeyAccount,
  backupStateAccount,
  CloudBackupError,
  forgetBackupKey,
  readBackupKey,
  readCloudBackupState,
  restoreFromOwner,
  startRelay,
  storeBackupKey,
  uploadBackup,
  type RelayPayload,
} from "./cloud-backup.js";
import { deriveEvmPrivateKey, phraseToSeed } from "./hd.js";
import type { SecretStore } from "./secret-store.js";
import {
  loadOrCreateDeviceKey,
  protectVault,
  unlockProtectedVault,
  VAULT_KEY_ACCOUNT,
} from "./vault-key.js";
import { exportVaultAccountKey, exportVaultPhrase, readVaultFileUnlocked } from "./vault.js";
import { WalletStore } from "./wallet-store.js";

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
const KDF = { name: "hkdf-sha256", salt: Buffer.from(BACKUP_SALT).toString("base64url") } as const;
const DIRECT_REQUEST_BODIES: string[] = [];
const TEMPORARY_DIRECTORIES: string[] = [];
const STDOUT_WRITES: string[] = [];
const STDERR_WRITES: string[] = [];

beforeEach(() => {
  vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
    STDOUT_WRITES.push(String(chunk));
    return true;
  }) as typeof process.stdout.write);
  vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
    STDERR_WRITES.push(String(chunk));
    return true;
  }) as typeof process.stderr.write);
});

afterEach(async () => {
  try {
    expectSecretFree(STDOUT_WRITES.join(""));
    expectSecretFree(STDERR_WRITES.join(""));
    for (const body of DIRECT_REQUEST_BODIES) {
      expectSecretFree(body);

      const value = JSON.parse(body) as Record<string, unknown>;
      if (value.format === "vapi-vault-backup") continue;
      expect(Object.keys(value)).toEqual(["publicKey", "code", "device", "purpose"]);
    }
    for (const directory of TEMPORARY_DIRECTORIES) {
      const audit = await readFile(join(directory, "audit.log"), "utf8").catch(() => "");
      expectSecretFree(audit);
    }
  } finally {
    DIRECT_REQUEST_BODIES.splice(0);
    STDOUT_WRITES.splice(0);
    STDERR_WRITES.splice(0);
    vi.restoreAllMocks();
    await Promise.all(
      TEMPORARY_DIRECTORIES.splice(0).map(async (directory) => {
        await rm(directory, { recursive: true, force: true });
      }),
    );
  }
});

describe("cloud backup relay", () => {
  it("starts a relay with the derived code and exact public request body", async () => {
    let sent: Record<string, unknown> | undefined;
    const fetchImpl = recordingFetch(async (_input, init) => {
      sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({ code: sent.code, expiresAt: EXPIRES_AT }, { status: 201 });
    });

    const started = await startRelay({
      apiBase: API_BASE,
      device: DEVICE,
      purpose: "enroll",
      fetchImpl,
      now: () => NOW,
      randomBytes: () => Uint8Array.from(X25519_PRIVATE_KEY),
    });

    expect(sent).toEqual({
      publicKey: Buffer.from(started.keyPair.publicKey).toString("base64url"),
      code: started.code,
      device: DEVICE,
      purpose: "enroll",
    });
    expect(started.code).toBe(relayCode(started.keyPair.publicKey));
    expect(started.expiresAt).toBe(EXPIRES_AT);
  });

  it.each([
    ["HTTP 400", async () => new Response(null, { status: 400 })],
    ["HTTP 409", async () => new Response(null, { status: 409 })],
    [
      "a network error",
      async () => {
        throw new Error("offline");
      },
    ],
    [
      "a malformed success response",
      async () => Response.json({ code: "wrong", expiresAt: EXPIRES_AT }, { status: 201 }),
    ],
  ])("maps %s while starting a relay to relay_create_failed", async (_name, response) => {
    await expectCloudError(
      startRelay({
        apiBase: API_BASE,
        device: DEVICE,
        purpose: "enroll",
        fetchImpl: recordingFetch(response),
        now: () => NOW,
        randomBytes: () => Uint8Array.from(X25519_PRIVATE_KEY),
      }),
      "relay_create_failed",
    );
  });

  it("polls a fake owner console and opens its sealed enrollment payload", async () => {
    let relay: Record<string, unknown> | undefined;
    let resultPolls = 0;
    const fetchImpl = recordingFetch(async (input, init) => {
      if (String(input).endsWith("/api/agents/backup-relays")) {
        relay = JSON.parse(String(init?.body)) as Record<string, unknown>;
        const publicKey = Buffer.from(String(relay.publicKey), "base64url");
        expect(relay.code).toBe(relayCode(publicKey));
        return Response.json({ code: relay.code, expiresAt: EXPIRES_AT }, { status: 201 });
      }
      resultPolls += 1;
      if (resultPolls === 1) return Response.json({ status: "pending" }, { status: 202 });
      const recipientPublicKey = Buffer.from(String(relay?.publicKey), "base64url");
      const sealed = sealTo({
        recipientPublicKey,
        plaintext: JSON.stringify(enrollPayload()),
        randomBytes: relaySealingRandom,
      });
      return Response.json({ sealed });
    });

    const started = await startRelay({
      apiBase: API_BASE,
      device: DEVICE,
      purpose: "enroll",
      fetchImpl,
      now: () => NOW,
      randomBytes: () => Uint8Array.from(X25519_PRIVATE_KEY),
    });
    const received = await awaitRelay({
      apiBase: API_BASE,
      code: started.code,
      keyPair: started.keyPair,
      expiresAt: started.expiresAt,
      expectedOwner: OWNER.toUpperCase().replace("0X", "0x"),
      device: DEVICE,
      purpose: "enroll",
      fetchImpl,
      now: () => NOW,
      sleep: async () => undefined,
    });

    expect(received).toEqual({
      ...enrollPayload(),
      key: BACKUP_KEY,
    });
    expect(resultPolls).toBe(2);
  });

  it.each([
    [
      "a different device",
      () => ({ ...enrollPayload(), device: "other-device" }),
      "payload_device_mismatch",
      "enroll",
      OWNER,
    ],
    [
      "a different purpose",
      () => ({ ...restorePayload(), purpose: "restore" }),
      "payload_purpose_mismatch",
      "enroll",
      OWNER,
    ],
    [
      "a different owner",
      () => ({ ...enrollPayload(), owner: OTHER_OWNER }),
      "payload_owner_mismatch",
      "enroll",
      OWNER,
    ],
    [
      "a 31-byte key",
      () => ({
        ...enrollPayload(),
        key: Buffer.from(BACKUP_KEY.subarray(0, 31)).toString("base64url"),
      }),
      "payload_invalid",
      "enroll",
      OWNER,
    ],
    [
      "an unknown field",
      () => ({ ...enrollPayload(), extra: true }),
      "payload_invalid",
      "enroll",
      OWNER,
    ],
    [
      "a vault on enrollment",
      () => ({ ...enrollPayload(), vault: validPlaintext() }),
      "payload_invalid",
      "enroll",
      OWNER,
    ],
    [
      "a restore without a vault",
      () => ({ ...enrollPayload(), purpose: "restore" }),
      "payload_invalid",
      "restore",
      OWNER,
    ],
  ] as const)("refuses %s without storing a key", async (_name, payload, code, purpose, owner) => {
    const secrets = memoryStore();
    await expectCloudError(awaitSealedPayload(payload(), { purpose, expectedOwner: owner }), code);
    expect(secrets.entries.size).toBe(0);
  });

  it.each([
    ["a missing relay result", () => new Response(null, { status: 404 }), () => NOW, 1],
    [
      "the local expiry deadline",
      () => {
        throw new Error("must not request");
      },
      () => new Date(EXPIRES_AT),
      0,
    ],
  ])("reports relay_expired for %s", async (_name, response, now, expectedRequests) => {
    const keyPair = fixedRelayKeyPair();
    const fetchImpl = vi.fn(recordingFetch(async () => response()));
    await expectCloudError(
      awaitRelay({
        apiBase: API_BASE,
        code: relayCode(keyPair.publicKey),
        keyPair,
        expiresAt: EXPIRES_AT,
        device: DEVICE,
        purpose: "enroll",
        fetchImpl,
        now,
        sleep: async () => undefined,
      }),
      "relay_expired",
    );
    expect(fetchImpl).toHaveBeenCalledTimes(expectedRequests);
  });
});

describe("cloud backup secret store", () => {
  it("stores, reads, reports, and forgets a per-device backup key without writing a file", async () => {
    const home = await temporaryHome();
    const secrets = memoryStore();
    await storeBackupKey({
      secrets,
      device: DEVICE,
      owner: OWNER,
      kdf: KDF,
      key: BACKUP_KEY,
    });

    await expect(readBackupKey({ secrets, device: DEVICE })).resolves.toEqual({
      owner: OWNER,
      device: DEVICE,
      kdf: KDF,
      key: BACKUP_KEY,
    });
    await secrets.set(
      backupStateAccount(DEVICE),
      JSON.stringify({ lastUploadAt: NOW.toISOString(), sizeBytes: 321 }),
    );
    await expect(readCloudBackupState({ secrets, device: DEVICE })).resolves.toEqual({
      enabled: true,
      lastUploadAt: NOW.toISOString(),
      sizeBytes: 321,
    });
    expect(await directoryContents(home)).not.toContain(
      Buffer.from(BACKUP_KEY).toString("base64url"),
    );
    expect(await readdir(home)).toEqual([]);
    await expect(forgetBackupKey({ secrets, device: DEVICE })).resolves.toBe(true);
    expect(secrets.entries.has(backupKeyAccount(DEVICE))).toBe(false);
    expect(secrets.entries.has(backupStateAccount(DEVICE))).toBe(false);
    await expect(readCloudBackupState({ secrets, device: DEVICE })).resolves.toEqual({
      enabled: false,
    });
  });

  it("refuses to store a backup key when the OS secret store is unavailable", async () => {
    await expectCloudError(
      storeBackupKey({
        secrets: unavailableStore(),
        device: DEVICE,
        owner: OWNER,
        kdf: KDF,
        key: BACKUP_KEY,
      }),
      "secret_store_unavailable",
    );
  });
});

describe("cloud backup upload", () => {
  it("does not upload an incoherent movement snapshot and asks for a retry", async () => {
    const fixture = await walletFixture();
    await storeFixtureBackupKey(fixture.secrets);
    const directory = join(fixture.home, "movements");
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, "mv_cloudrace1.json"),
      `${JSON.stringify({
        v: 2,
        id: "mv_cloudrace1",
        reason: "send",
        from: "main",
        network: "eip155:8453",
        createdAt: NOW.toISOString(),
        legs: [
          {
            from: "main",
            to: "cold",
            amountUsd: "1.00",
            purpose: "send",
            nonce: `0x${"ab".repeat(32)}`,
            status: "unknown",
          },
        ],
      })}\n`,
    );
    let requested = false;

    await expect(
      uploadBackup({
        store: fixture.store,
        secrets: fixture.secrets,
        device: DEVICE,
        fetchImpl: async () => {
          requested = true;
          return new Response(null, { status: 204 });
        },
        now: () => NOW,
        randomBytes: envelopeRandom,
      }),
    ).resolves.toEqual({ status: "skipped", reason: "snapshot_busy" });
    expect(requested).toBe(false);
  });

  it("uploads an openable envelope with the linked account and writes upload state", async () => {
    const fixture = await walletFixture();
    await storeFixtureBackupKey(fixture.secrets);
    let envelope: string | undefined;
    const fetchImpl = recordingFetch(async (input, init) => {
      expect(String(input)).toBe(`${API_BASE}/api/agents/self/backup`);
      expect(init?.method).toBe("PUT");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer access-token");
      envelope = String(init?.body);
      return new Response(null, { status: 204 });
    });

    await expect(
      uploadBackup({
        store: fixture.store,
        secrets: fixture.secrets,
        device: DEVICE,
        apiBase: API_BASE,
        networks: ["eip155:8453", "eip155:1"],
        fetchImpl,
        now: () => NOW,
        randomBytes: envelopeRandom,
      }),
    ).resolves.toEqual({
      status: "uploaded",
      account: "main",
      bytes: expect.any(Number),
      uploadedAt: NOW.toISOString(),
    });

    expect(envelope).toBeDefined();
    expect(readBackupHeader(envelope!)).toMatchObject({ owner: OWNER, device: DEVICE, kdf: KDF });
    const plaintext = await openBackup({ envelope: envelope!, key: BACKUP_KEY });
    expect(plaintext.registry).toMatchObject({
      default: "cold",
      accounts: [
        { name: "main", label: "Primary" },
        { name: "cold", label: "Offline" },
      ],
      networks: ["eip155:1", "eip155:8453"],
    });
    expect(plaintext.accounts.map((account) => account.kind)).toEqual(["derived", "imported"]);
    await expect(
      readCloudBackupState({ secrets: fixture.secrets, device: DEVICE }),
    ).resolves.toEqual({
      enabled: true,
      lastUploadAt: NOW.toISOString(),
      sizeBytes: Buffer.byteLength(envelope!),
    });
  });

  it("surfaces omitted sections when large agent profiles do not fit", async () => {
    const fixture = await walletFixture();
    await storeFixtureBackupKey(fixture.secrets);
    for (let index = 0; index < 4; index += 1) {
      await writeAgentProfile(fixture.home, largeAgentProfile(index));
    }
    let envelope: string | undefined;
    const fetchImpl = recordingFetch(async (_input, init) => {
      envelope = String(init?.body);
      return new Response(null, { status: 204 });
    });

    await expect(
      uploadBackup({
        store: fixture.store,
        secrets: fixture.secrets,
        device: DEVICE,
        fetchImpl,
        now: () => NOW,
        randomBytes: envelopeRandom,
      }),
    ).resolves.toEqual({
      status: "uploaded",
      account: "main",
      bytes: expect.any(Number),
      uploadedAt: NOW.toISOString(),
      omitted: ["agents"],
    });

    const plaintext = await openBackup({ envelope: envelope!, key: BACKUP_KEY });
    expect(plaintext.v).toBe(1);
    expect(plaintext).not.toHaveProperty("agents");
  });

  it("reports agent profiles rejected by the normal loader", async () => {
    const fixture = await walletFixture();
    await storeFixtureBackupKey(fixture.secrets);
    await mkdir(join(fixture.home, "agents"), { recursive: true });
    await writeFile(
      join(fixture.home, "agents", "broken.json"),
      JSON.stringify({
        version: 1,
        name: "broken",
        wallet: "main",
        model: "",
        instructions: "Invalid model.",
        createdAt: NOW.toISOString(),
      }),
    );
    const fetchImpl = recordingFetch(async () => new Response(null, { status: 204 }));

    await expect(
      uploadBackup({
        store: fixture.store,
        secrets: fixture.secrets,
        device: DEVICE,
        fetchImpl,
        now: () => NOW,
        randomBytes: envelopeRandom,
      }),
    ).resolves.toEqual({
      status: "uploaded",
      account: "main",
      bytes: expect.any(Number),
      uploadedAt: NOW.toISOString(),
      skipped: [{ kind: "agent", name: "broken", reason: "invalid_profile" }],
    });
  });

  it("serializes the whole snapshot per device across different linked accounts", async () => {
    const fixture = await walletFixture();
    await storeFixtureBackupKey(fixture.secrets);
    await fixture.store.setLink("cold", {
      apiBase: API_BASE,
      clientId: "cloud-backup-cold",
      owner: OWNER,
      label: "Cold",
      scopes: ["mcp:call"],
      linkedAt: NOW.toISOString(),
    });
    fixture.secrets.entries.set(
      agentSecretAccounts("cold").tokens,
      JSON.stringify({
        accessToken: "cold-access-token",
        refreshToken: "cold-refresh-token",
        expiresAt: Number.MAX_SAFE_INTEGER,
        scopes: ["mcp:call"],
      }),
    );

    let releaseFirst!: () => void;
    let markFirstRequest!: () => void;
    const firstRequest = new Promise<void>((resolve) => {
      markFirstRequest = resolve;
    });
    const firstResponse = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const envelopes: string[] = [];
    const fetchImpl = recordingFetch(async (_input, init) => {
      envelopes.push(String(init?.body));
      if (envelopes.length === 1) {
        markFirstRequest();
        await firstResponse;
      }
      return new Response(null, { status: 204 });
    });

    const first = uploadBackup({
      store: fixture.store,
      secrets: fixture.secrets,
      device: DEVICE,
      account: "main",
      fetchImpl,
      now: () => NOW,
      randomBytes: envelopeRandom,
    });
    await firstRequest;
    await fixture.store.create("newer", "");
    const second = uploadBackup({
      store: fixture.store,
      secrets: fixture.secrets,
      device: DEVICE,
      account: "cold",
      fetchImpl,
      now: () => NOW,
      randomBytes: envelopeRandom,
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(envelopes).toHaveLength(1);
    releaseFirst();
    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ status: "uploaded", account: "main" }),
      expect.objectContaining({ status: "uploaded", account: "cold" }),
    ]);
    expect(envelopes).toHaveLength(2);
    await expect(openBackup({ envelope: envelopes[0]!, key: BACKUP_KEY })).resolves.toMatchObject({
      registry: {
        accounts: expect.not.arrayContaining([expect.objectContaining({ name: "newer" })]),
      },
    });
    await expect(openBackup({ envelope: envelopes[1]!, key: BACKUP_KEY })).resolves.toMatchObject({
      registry: { accounts: expect.arrayContaining([expect.objectContaining({ name: "newer" })]) },
    });
  });

  it("skips upload without a backup key and makes no request", async () => {
    const fixture = await walletFixture();
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(
      uploadBackup({
        store: fixture.store,
        secrets: fixture.secrets,
        device: DEVICE,
        fetchImpl,
      }),
    ).resolves.toEqual({ status: "skipped", reason: "no_backup_key" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("skips upload when no matching linked account exists", async () => {
    const fixture = await walletFixture();
    await storeFixtureBackupKey(fixture.secrets);
    await fixture.store.clearLink("main");
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(
      uploadBackup({
        store: fixture.store,
        secrets: fixture.secrets,
        device: DEVICE,
        fetchImpl,
        now: () => NOW,
        randomBytes: envelopeRandom,
      }),
    ).resolves.toEqual({ status: "skipped", reason: "not_linked" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("maps HTTP 409 to device_unknown without throwing", async () => {
    const fixture = await walletFixture();
    await storeFixtureBackupKey(fixture.secrets);
    await expect(
      uploadBackup({
        store: fixture.store,
        secrets: fixture.secrets,
        device: DEVICE,
        fetchImpl: recordingFetch(async () =>
          Response.json({ error: "device_unknown" }, { status: 409 }),
        ),
        now: () => NOW,
        randomBytes: envelopeRandom,
      }),
    ).resolves.toEqual({ status: "skipped", reason: "device_unknown" });
  });

  it("maps a rejected request to network without throwing", async () => {
    const fixture = await walletFixture();
    await storeFixtureBackupKey(fixture.secrets);
    await expect(
      uploadBackup({
        store: fixture.store,
        secrets: fixture.secrets,
        device: DEVICE,
        fetchImpl: recordingFetch(async () => {
          throw new Error("offline");
        }),
        now: () => NOW,
        randomBytes: envelopeRandom,
      }),
    ).resolves.toEqual({ status: "skipped", reason: "network" });
  });

  it("skips a protected vault without a password or live session", async () => {
    const fixture = await walletFixture();
    await storeFixtureBackupKey(fixture.secrets);
    await protectVault({
      path: join(fixture.home, "vault.json"),
      secrets: fixture.secrets,
      password: VAULT_PASSWORD,
      randomBytes: () => Uint8Array.from({ length: 32 }, () => 7),
    });
    const fetchImpl = vi.fn<typeof fetch>();

    await expect(
      uploadBackup({
        store: fixture.store,
        secrets: fixture.secrets,
        device: DEVICE,
        env: {},
        fetchImpl,
        now: () => NOW,
        randomBytes: envelopeRandom,
      }),
    ).resolves.toEqual({ status: "skipped", reason: "vault_locked" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("owner restore", () => {
  it("restores a v2 relay payload with an agent, rewritten swarm, and resumable movement", async () => {
    const plaintext = validV2Plaintext();
    const payload = await awaitSealedPayload(
      { ...enrollPayload(), purpose: "restore", vault: plaintext },
      { purpose: "restore", expectedOwner: OWNER },
    );
    const home = await temporaryHome();
    const secrets = memoryStore();
    const vaultKey = Uint8Array.from({ length: 32 }, (_, index) => index + 120);

    const restored = await restoreFromOwner({ payload, home, vaultKey, secrets, now: () => NOW });

    expect(restored).toMatchObject({
      agents: ["researcher"],
      swarms: ["team"],
      movements: [
        {
          id: "mv_cloud001",
          from: "main",
          pendingLegs: 0,
          unknownLegs: 1,
        },
      ],
      skipped: [],
      conflicts: [],
    });
    expect(JSON.parse(await readFile(join(home, "agents", "researcher.json"), "utf8"))).toEqual(
      plaintext.agents?.[0],
    );
    expect(JSON.parse(await readFile(join(home, "swarms", "team.json"), "utf8"))).toEqual({
      ...plaintext.swarms?.[0],
      device: DEVICE,
    });
    expect(
      JSON.parse(await readFile(join(home, "movements", "mv_cloud001.json"), "utf8")),
    ).toMatchObject({ legs: [{ status: "unknown", nonce: cloudMovementNonce() }] });
    expect(await readFile(join(home, "receipts.jsonl"), "utf8")).toContain("cloud-transfer");
  });

  it("restores protected derived and imported accounts with registry metadata and stores the new key", async () => {
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
    const exported = await exportBackupSource({
      store: source.store,
      vaultKey: sourceKey,
      networks: ["eip155:1", "eip155:8453"],
    });
    sourceKey.fill(0);
    expect(exported.protected).toBe(true);

    const home = await temporaryHome();
    const secrets = memoryStore();
    const vaultKey = Uint8Array.from({ length: 32 }, (_, index) => index + 120);
    secrets.entries.set(VAULT_KEY_ACCOUNT, Buffer.from(vaultKey).toString("base64"));
    const payload: RelayPayload = {
      format: "vapi-vault-relay-payload",
      v: 1,
      purpose: "restore",
      owner: OWNER,
      device: DEVICE,
      kdf: KDF,
      key: Uint8Array.from(BACKUP_KEY),
      vault: { v: 2, ...exported },
    };

    const restored = await restoreFromOwner({
      payload,
      home,
      vaultKey,
      secrets,
      password: VAULT_PASSWORD,
      now: () => NOW,
    });
    expect(restored).toMatchObject({
      default: "cold",
      protected: true,
      networks: ["eip155:1", "eip155:8453"],
    });
    expect(restored.accounts.map(({ name, kind }) => ({ name, kind }))).toEqual([
      { name: "main", kind: "derived" },
      { name: "cold", kind: "imported" },
    ]);
    await expect(
      exportVaultPhrase({ path: join(home, "vault.json"), key: vaultKey }),
    ).resolves.toBe(TEST_PHRASE);
    await expect(
      exportVaultAccountKey({ path: join(home, "vault.json"), key: vaultKey, name: "cold" }),
    ).resolves.toBe(IMPORTED_PRIVATE_KEY);
    expect(await readVaultFileUnlocked(join(home, "vault.json"))).toMatchObject({
      protected: true,
    });
    expect(JSON.parse(await readFile(join(home, "wallets.json"), "utf8"))).toMatchObject({
      default: "cold",
      wallets: {
        main: { label: "Primary", spendCaps: { perCallAtomic: "10", perDayAtomic: "100" } },
        cold: { label: "Offline", spendCaps: { perCallAtomic: "20", perDayAtomic: "200" } },
      },
    });
    await expect(readBackupKey({ secrets, device: DEVICE })).resolves.toMatchObject({
      owner: OWNER,
      device: DEVICE,
      kdf: KDF,
      key: BACKUP_KEY,
    });

    await expectCloudError(
      restoreFromOwner({
        payload,
        home,
        vaultKey,
        secrets,
        password: VAULT_PASSWORD,
        now: () => NOW,
      }),
      "vault_exists",
    );
  });

  it("publishes nothing when storing the backup key fails and can be retried", async () => {
    const home = await temporaryHome();
    const secrets = memoryStore();
    const firstVaultKey = Uint8Array.from({ length: 32 }, (_, index) => index + 120);
    secrets.entries.set(VAULT_KEY_ACCOUNT, Buffer.from(firstVaultKey).toString("base64"));
    const payload: RelayPayload = {
      format: "vapi-vault-relay-payload",
      v: 1,
      purpose: "restore",
      owner: OWNER,
      device: DEVICE,
      kdf: KDF,
      key: Uint8Array.from(BACKUP_KEY),
      vault: validPlaintext(),
    };
    const set = secrets.set.bind(secrets);
    let denyBackupKey = true;
    secrets.set = async (name, value) => {
      if (denyBackupKey && name === backupKeyAccount(DEVICE)) throw new Error("denied");
      await set(name, value);
    };

    await expectCloudError(
      restoreFromOwner({
        payload,
        home,
        vaultKey: firstVaultKey,
        secrets,
        password: VAULT_PASSWORD,
        now: () => NOW,
      }),
      "secret_store_unavailable",
    );
    await expect(readFile(join(home, "vault.json"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(readFile(join(home, "wallets.json"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });

    denyBackupKey = false;
    const retryVaultKey = await loadOrCreateDeviceKey({ secrets });
    try {
      await expect(
        restoreFromOwner({
          payload,
          home,
          vaultKey: retryVaultKey,
          secrets,
          password: VAULT_PASSWORD,
          now: () => NOW,
        }),
      ).resolves.toMatchObject({ protected: true });
      await expect(readVaultFileUnlocked(join(home, "vault.json"))).resolves.toMatchObject({
        protected: true,
      });
    } finally {
      retryVaultKey.fill(0);
    }
  });
});

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

function restorePayload(): Record<string, unknown> {
  return { ...enrollPayload(), purpose: "restore", vault: validPlaintext() };
}

function validPlaintext(): BackupPlaintext {
  const seed = phraseToSeed(TEST_PHRASE);
  try {
    const derivedPrivateKey = deriveEvmPrivateKey(seed, "m/44'/60'/0'/0/0");
    return {
      v: 1,
      phrase: TEST_PHRASE,
      nextDerivedIndex: 1,
      accounts: [
        {
          name: "main",
          kind: "derived",
          index: 0,
          address: privateKeyToAccount(derivedPrivateKey).address,
          createdAt: NOW.toISOString(),
        },
        {
          name: "cold",
          kind: "imported",
          address: privateKeyToAccount(IMPORTED_PRIVATE_KEY).address,
          privateKey: IMPORTED_PRIVATE_KEY,
          createdAt: NOW.toISOString(),
        },
      ],
      registry: {
        default: "cold",
        accounts: [
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
        ],
        networks: ["eip155:1", "eip155:8453"],
      },
      protected: true,
    };
  } finally {
    seed.fill(0);
  }
}

function validV2Plaintext(): BackupPlaintextV2 {
  const base = validPlaintext();
  if (base.v !== 1) throw new Error("Expected the v1 test fixture.");
  const main = base.accounts[0]!;
  const nonce = cloudMovementNonce();
  return {
    ...base,
    v: 2,
    protected: false,
    registry: {
      ...base.registry,
      accounts: base.registry.accounts.map((account) => ({
        ...account,
        ceilingAtomic: account.name === "main" ? "5000000" : null,
      })),
    },
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
            nonce,
            status: "planned",
          },
        ],
      },
    ],
    transferReceipts: [
      {
        id: "cloud-transfer",
        timestamp: NOW.toISOString(),
        kind: "transfer",
        wallet: "main",
        resourceUrl: "https://router.example.test/transfer",
        quote: {
          network: "eip155:8453",
          asset: "0x3333333333333333333333333333333333333333",
          amountAtomic: "1000000",
        },
        transfer: {
          to: "0x2222222222222222222222222222222222222222",
          toName: "owner",
          toKind: "owner",
          amountAtomic: "1000000",
          network: "eip155:8453",
          nonce,
          status: "unknown",
          txHash: null,
          replayed: false,
          reservedOn: "2026-09-29",
          request: {
            authorization: {
              from: main.address,
              to: "0x2222222222222222222222222222222222222222",
              value: "1000000",
              validAfter: "0",
              validBefore: "1790676672",
              nonce,
            },
            signature: `0x${"ab".repeat(65)}`,
          },
        },
      },
    ],
  };
}

function largeAgentProfile(index: number): NonNullable<BackupPlaintextV2["agents"]>[number] {
  return {
    version: 1 as const,
    name: `large-${index}`,
    wallet: "main",
    model: "openai/gpt-5-mini",
    instructions: String(index).repeat(19_000),
    verifiedOnly: true,
    approveAboveUsd: 0.5,
    maxSteps: 12,
    paused: false,
    createdAt: NOW.toISOString(),
    tools: ["call.search", "call.inspect", "call.pay"],
  };
}

function cloudMovementNonce(): `0x${string}` {
  return `0x${"44".repeat(32)}`;
}

async function awaitSealedPayload(
  payload: Record<string, unknown>,
  options: { purpose: "enroll" | "restore"; expectedOwner?: string },
): Promise<RelayPayload> {
  const keyPair = fixedRelayKeyPair();
  const sealed = sealTo({
    recipientPublicKey: keyPair.publicKey,
    plaintext: JSON.stringify(payload),
    randomBytes: relaySealingRandom,
  });
  return await awaitRelay({
    apiBase: API_BASE,
    code: relayCode(keyPair.publicKey),
    keyPair,
    expiresAt: EXPIRES_AT,
    device: DEVICE,
    purpose: options.purpose,
    expectedOwner: options.expectedOwner,
    fetchImpl: recordingFetch(async () => Response.json({ sealed })),
    now: () => NOW,
    sleep: async () => undefined,
  });
}

function fixedRelayKeyPair(): { publicKey: Uint8Array; privateKey: Uint8Array } {
  return createRelayKeyPair({ randomBytes: () => Uint8Array.from(X25519_PRIVATE_KEY) });
}

async function walletFixture(): Promise<{
  home: string;
  store: WalletStore;
  secrets: MemorySecretStore;
}> {
  const home = await temporaryHome();
  const secrets = memoryStore();
  const store = await WalletStore.open(home, {
    secrets,
    now: () => NOW,
    audit: async () => undefined,
  });
  await store.create("main", "", {
    phrase: TEST_PHRASE,
    label: "Primary",
    spendCaps: { perCallAtomic: "10", perDayAtomic: "100" },
  });
  await store.importKey("cold", "", IMPORTED_PRIVATE_KEY, {
    label: "Offline",
    spendCaps: { perCallAtomic: "20", perDayAtomic: "200" },
  });
  await store.setDefault("cold");
  await store.setLink("main", {
    apiBase: API_BASE,
    clientId: "cloud-backup-test",
    owner: OWNER,
    label: "Test device",
    scopes: ["mcp:call", "router.use"],
    linkedAt: NOW.toISOString(),
  });
  secrets.entries.set(
    agentSecretAccounts("main").tokens,
    JSON.stringify({
      accessToken: "access-token",
      refreshToken: "refresh-token",
      expiresAt: Number.MAX_SAFE_INTEGER,
      scopes: ["mcp:call", "router.use"],
    }),
  );
  return { home, store, secrets };
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

type MemorySecretStore = SecretStore & { entries: Map<string, string> };

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

function unavailableStore(): SecretStore {
  const refuse = async (): Promise<never> => await Promise.reject(new Error("unavailable"));
  return {
    available: false,
    platform: "linux",
    description: "no OS secret store",
    get: refuse,
    has: refuse,
    set: refuse,
    remove: refuse,
  };
}

function recordingFetch(
  handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (typeof init?.body === "string") DIRECT_REQUEST_BODIES.push(init.body);
    return await handler(input, init);
  }) as typeof fetch;
}

function relaySealingRandom(length: number): Uint8Array {
  return Uint8Array.from({ length }, (_, index) => index + (length === 32 ? 33 : 99));
}

function envelopeRandom(length: number): Uint8Array {
  return Uint8Array.from({ length }, (_, index) => index + 7);
}

async function expectCloudError(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toBeInstanceOf(CloudBackupError);
  await expect(promise).rejects.toMatchObject({ code });
}

async function temporaryHome(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "vapi-cloud-backup-"));
  TEMPORARY_DIRECTORIES.push(directory);
  return directory;
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
