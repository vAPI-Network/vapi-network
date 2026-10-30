import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { memorySecretStore, type WalletStore } from "@vapi-network/core";

import { createBackupService, type BackupCore } from "./backup.js";

const OWNER = "0x8617e340b3d01fa5f11f306f4090fd50e238070d" as const;
const API = "https://api-staging.vapinetwork.ai";
let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "vapi-backup-"));
});
afterEach(async () => {
  vi.useRealTimers();
  await rm(home, { recursive: true, force: true });
});

function payload(purpose: "enroll" | "restore") {
  return {
    format: "vapi-vault-relay-payload",
    v: 1,
    purpose,
    owner: OWNER,
    device: "vapi-desktop-test-mac",
    kdf: { name: "hkdf-sha256" as const, salt: "s".repeat(43) },
    key: new Uint8Array(32).fill(7),
    ...(purpose === "restore" ? { vault: { protected: true } } : {}),
  };
}

function fakes(overrides: Partial<BackupCore> = {}) {
  const calls: string[] = [];
  let enabled = false;
  const core: Partial<BackupCore> = {
    startRelay: vi.fn(async () => ({
      code: "123456",
      expiresAt: "2099-01-01T00:00:00.000Z",
      keyPair: { publicKey: new Uint8Array(32), privateKey: new Uint8Array(32) },
    })) as never,
    awaitRelay: vi.fn(async (options: { purpose: "enroll" | "restore" }) =>
      payload(options.purpose),
    ) as never,
    storeBackupKey: vi.fn(async () => {
      enabled = true;
      calls.push("store");
    }) as never,
    readCloudBackupState: vi.fn(async () =>
      enabled ? { enabled: true, lastUploadAt: "2026-10-27T10:00:00.000Z" } : { enabled: false },
    ) as never,
    uploadBackup: vi.fn(async () => {
      calls.push("upload");
      return {
        status: "uploaded",
        account: "claude",
        bytes: 10,
        uploadedAt: "2026-10-27T10:00:00.000Z",
      };
    }) as never,
    loadOrCreateDeviceKey: vi.fn(async () => new Uint8Array(32).fill(5)),
    protectVault: vi.fn(async () => undefined),
    readVaultFileUnlocked: vi.fn(async () => ({ protected: true })) as never,
    restoreFromOwner: vi.fn(async () => ({
      accounts: [{ name: "claude", address: "0x1" }],
    })) as never,
    ...overrides,
  };
  return { core, calls };
}

const store = {} as WalletStore;
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("backup service", () => {
  it("enrolls through the console code, stores the key and uploads", async () => {
    const { core, calls } = fakes();
    const service = createBackupService({
      home,
      secrets: memorySecretStore(),
      apiBase: API,
      hostname: "test-mac",
      core,
      debounceMs: 0,
      store: async () => store,
    });
    const started = await service.start("enroll", OWNER);
    expect(started).toEqual({
      mode: "browser",
      code: "123456",
      url: `${API}/agents`,
      expiresAt: Date.parse("2099-01-01T00:00:00.000Z"),
    });
    expect(core.awaitRelay).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedOwner: OWNER,
        purpose: "enroll",
        device: "vapi-desktop-test-mac",
      }),
    );
    await tick();
    await tick();
    expect(service.poll()).toEqual({ state: "enrolled" });
    expect(service.poll()).toEqual({ state: "none" });
    expect(calls).toEqual(["store", "upload"]);
    expect(await service.status()).toEqual({
      enabled: true,
      lastUploadAt: "2026-10-27T10:00:00.000Z",
      failed: false,
    });
  });

  it("refuses to enroll without a linked owner", async () => {
    const { core } = fakes();
    const service = createBackupService({
      home,
      secrets: memorySecretStore(),
      apiBase: API,
      hostname: "test-mac",
      core,
      store: async () => store,
    });
    expect(await service.start("enroll")).toMatchObject({ mode: "error" });
    expect(core.startRelay).not.toHaveBeenCalled();
  });

  it("reports an expired code as failed", async () => {
    const { CloudBackupError } = await import("@vapi-network/core/cloud-backup");
    const { core } = fakes({
      awaitRelay: vi.fn(async () => {
        throw new CloudBackupError("relay_expired");
      }) as never,
    });
    const service = createBackupService({
      home,
      secrets: memorySecretStore(),
      apiBase: API,
      hostname: "test-mac",
      core,
      store: async () => store,
    });
    await service.start("enroll", OWNER);
    await tick();
    expect(service.poll()).toMatchObject({
      state: "failed",
      message: expect.stringContaining("expired"),
    });
  });

  it("marks a failed upload and clears it on the next success", async () => {
    let fail = true;
    const { core } = fakes({
      uploadBackup: vi.fn(async () =>
        fail
          ? { status: "skipped", reason: "network" }
          : {
              status: "uploaded",
              account: "claude",
              bytes: 1,
              uploadedAt: "2026-10-27T11:00:00.000Z",
            },
      ) as never,
      readCloudBackupState: vi.fn(async () => ({ enabled: true })) as never,
    });
    const service = createBackupService({
      home,
      secrets: memorySecretStore(),
      apiBase: API,
      hostname: "test-mac",
      core,
      store: async () => store,
    });
    await service.uploadNow();
    expect((await service.status()).failed).toBe(true);
    fail = false;
    await service.uploadNow();
    expect((await service.status()).failed).toBe(false);
  });

  it("does not upload or fail while backup is off", async () => {
    const { core } = fakes();
    const service = createBackupService({
      home,
      secrets: memorySecretStore(),
      apiBase: API,
      hostname: "test-mac",
      core,
      debounceMs: 0,
      store: async () => store,
    });
    service.schedule();
    await tick();
    await tick();
    expect(core.uploadBackup).not.toHaveBeenCalled();
    expect(await service.status()).toEqual({ enabled: false, failed: false });
  });

  it("restores only after the owner approved, with the new password", async () => {
    const restoreFromOwner = vi.fn(async () => ({
      accounts: [{ name: "claude", address: "0x1" }],
    }));
    const { core } = fakes({
      restoreFromOwner: restoreFromOwner as never,
      readVaultFileUnlocked: vi.fn(async () => ({ protected: true })) as never,
    });
    const service = createBackupService({
      home,
      secrets: memorySecretStore(),
      apiBase: API,
      hostname: "test-mac",
      core,
      store: async () => store,
    });
    await expect(service.restore("correct horse")).rejects.toThrow();
    await service.start("restore");
    await tick();
    expect(service.poll()).toEqual({ state: "approved", owner: OWNER });
    expect(await service.restore("correct horse")).toEqual({ wallets: ["claude"] });
    expect(restoreFromOwner).toHaveBeenCalledWith(
      expect.objectContaining({ password: "correct horse", home }),
    );
    expect(service.poll()).toEqual({ state: "none" });
  });

  it("protects an unprotected backup and clears keys after restore", async () => {
    const approved = payload("restore");
    const vaultKey = new Uint8Array(32).fill(5);
    const { core } = fakes({
      awaitRelay: vi.fn(async () => approved) as never,
      loadOrCreateDeviceKey: vi.fn(async () => vaultKey),
      readVaultFileUnlocked: vi.fn(async () => ({ protected: false })) as never,
    });
    const secrets = memorySecretStore();
    const service = createBackupService({
      home,
      secrets,
      apiBase: API,
      hostname: "test-mac",
      core,
      store: async () => store,
    });
    await service.start("restore");
    await tick();
    await service.restore("correct horse");
    expect(core.protectVault).toHaveBeenCalledWith({
      path: join(home, "vault.json"),
      secrets,
      password: "correct horse",
    });
    expect(vaultKey).toEqual(new Uint8Array(32));
    expect(approved.key).toEqual(new Uint8Array(32));
  });

  it("refuses an expired approval even without polling first", async () => {
    let now = new Date("2098-12-31T23:59:00.000Z");
    const approved = payload("restore");
    const { core } = fakes({ awaitRelay: vi.fn(async () => approved) as never });
    const service = createBackupService({
      home,
      secrets: memorySecretStore(),
      apiBase: API,
      hostname: "test-mac",
      core,
      store: async () => store,
      now: () => now,
    });
    await service.start("restore");
    await tick();
    now = new Date("2099-01-01T00:00:00.000Z");
    await expect(service.restore("correct horse")).rejects.toThrow("expired");
    expect(core.restoreFromOwner).not.toHaveBeenCalled();
    expect(approved.key).toEqual(new Uint8Array(32));
  });

  it.each(["enroll", "restore"] as const)(
    "discards late %s approvals after cancellation",
    async (purpose) => {
      const approved = payload(purpose);
      let approve!: (value: ReturnType<typeof payload>) => void;
      const { core } = fakes({
        awaitRelay: vi.fn(
          () =>
            new Promise((resolve) => {
              approve = resolve;
            }),
        ) as never,
      });
      const service = createBackupService({
        home,
        secrets: memorySecretStore(),
        apiBase: API,
        hostname: "test-mac",
        core,
        store: async () => store,
      });
      await service.start(purpose, OWNER);
      service.cancelAll();
      approve(approved);
      await tick();
      expect(service.poll()).toEqual({ state: "none" });
      expect(core.storeBackupKey).not.toHaveBeenCalled();
      expect(approved.key).toEqual(new Uint8Array(32));
    },
  );

  it("clears the approved key when loading a restore key fails", async () => {
    const approved = payload("restore");
    const { core } = fakes({
      awaitRelay: vi.fn(async () => approved) as never,
      loadOrCreateDeviceKey: vi.fn(async () => {
        throw new Error("unavailable");
      }),
    });
    const service = createBackupService({
      home,
      secrets: memorySecretStore(),
      apiBase: API,
      hostname: "test-mac",
      core,
      store: async () => store,
    });
    await service.start("restore");
    await tick();
    await expect(service.restore("correct horse")).rejects.toThrow("unavailable");
    expect(approved.key).toEqual(new Uint8Array(32));
    expect(service.poll()).toEqual({ state: "none" });
  });

  it("debounces changes, reads the current store at upload time and cancels scheduled work", async () => {
    vi.useFakeTimers();
    const currentStore = {} as WalletStore;
    const { core } = fakes({ readCloudBackupState: vi.fn(async () => ({ enabled: true })) });
    let selected = store;
    const service = createBackupService({
      home,
      secrets: memorySecretStore(),
      apiBase: API,
      hostname: "test-mac",
      core,
      store: async () => selected,
    });
    service.schedule();
    await vi.advanceTimersByTimeAsync(2_000);
    service.schedule();
    selected = currentStore;
    await vi.advanceTimersByTimeAsync(2_999);
    expect(core.uploadBackup).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(core.uploadBackup).toHaveBeenCalledTimes(1);
    expect(core.uploadBackup).toHaveBeenCalledWith(
      expect.objectContaining({ store: currentStore }),
    );
    service.schedule();
    service.cancelAll();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(core.uploadBackup).toHaveBeenCalledTimes(1);
  });

  it("runs one follow-up upload when changes arrive during an upload", async () => {
    let finish!: () => void;
    const uploadBackup = vi
      .fn<BackupCore["uploadBackup"]>()
      .mockImplementationOnce(async () => {
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
        return { status: "skipped", reason: "no_backup_key" };
      })
      .mockResolvedValue({ status: "skipped", reason: "no_backup_key" });
    const { core } = fakes({ uploadBackup });
    const service = createBackupService({
      home,
      secrets: memorySecretStore(),
      apiBase: API,
      hostname: "test-mac",
      core,
      store: async () => store,
    });
    const first = service.uploadNow();
    await tick();
    const next = service.uploadNow();
    const last = service.uploadNow();
    expect(uploadBackup).toHaveBeenCalledTimes(1);
    finish();
    await Promise.all([first, next, last]);
    expect(uploadBackup).toHaveBeenCalledTimes(2);
  });

  it("cancels a relay while its code is still being created", async () => {
    const keyPair = {
      publicKey: new Uint8Array(32).fill(3),
      privateKey: new Uint8Array(32).fill(4),
    };
    let finish!: (value: Awaited<ReturnType<BackupCore["startRelay"]>>) => void;
    const { core } = fakes({
      startRelay: vi.fn(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      ) as never,
    });
    const service = createBackupService({
      home,
      secrets: memorySecretStore(),
      apiBase: API,
      hostname: "test-mac",
      core,
      store: async () => store,
    });
    const starting = service.start("restore");
    service.cancelAll();
    finish({ code: "123456", expiresAt: "2099-01-01T00:00:00.000Z", keyPair });
    expect(await starting).toMatchObject({ mode: "error" });
    expect(service.poll()).toEqual({ state: "none" });
    expect(core.awaitRelay).not.toHaveBeenCalled();
    expect(keyPair.privateKey).toEqual(new Uint8Array(32));
    expect(keyPair.publicKey).toEqual(new Uint8Array(32));
  });

  it("uses Desktop copy for core restore failures and still clears the keys", async () => {
    const { CloudBackupError } = await import("@vapi-network/core/cloud-backup");
    const approved = payload("restore");
    const vaultKey = new Uint8Array(32).fill(5);
    const { core } = fakes({
      awaitRelay: vi.fn(async () => approved) as never,
      loadOrCreateDeviceKey: vi.fn(async () => vaultKey),
      restoreFromOwner: vi.fn(async () => {
        throw new CloudBackupError("restore_failed");
      }),
    });
    const service = createBackupService({
      home,
      secrets: memorySecretStore(),
      apiBase: API,
      hostname: "test-mac",
      core,
      store: async () => store,
    });
    await service.start("restore");
    await tick();
    await expect(service.restore("correct horse")).rejects.toThrow(
      "vAPI Desktop could not restore your encrypted backup. Try again.",
    );
    expect(vaultKey).toEqual(new Uint8Array(32));
    expect(approved.key).toEqual(new Uint8Array(32));
  });
});
