// apps/desktop/src/signer/backup.ts
import { join } from "node:path";
import {
  appendAudit,
  loadOrCreateDeviceKey,
  protectVault,
  readVaultFileUnlocked,
  VaultError,
  type SecretStore,
  type WalletStore,
} from "@vapi-network/core";
import {
  awaitRelay,
  CloudBackupError,
  readCloudBackupState,
  restoreFromOwner,
  startRelay,
  storeBackupKey,
  uploadBackup,
  type RelayPayload,
} from "@vapi-network/core/cloud-backup";

import { desktopDeviceName } from "./device-name.js";
import type { BackupPollState, BackupPurpose, BackupStartResult, BackupState } from "./messages.js";

export type BackupCore = {
  startRelay: typeof startRelay;
  awaitRelay: typeof awaitRelay;
  storeBackupKey: typeof storeBackupKey;
  uploadBackup: typeof uploadBackup;
  readCloudBackupState: typeof readCloudBackupState;
  restoreFromOwner: typeof restoreFromOwner;
  loadOrCreateDeviceKey: typeof loadOrCreateDeviceKey;
  protectVault: typeof protectVault;
  readVaultFileUnlocked: typeof readVaultFileUnlocked;
};

type Pending = {
  purpose: BackupPurpose;
  controller: AbortController;
  code: string;
  url: string;
  expiresAt: number;
  outcome?:
    | { kind: "enrolled" }
    | { kind: "approved"; payload: RelayPayload }
    | { kind: "failed"; message: string };
};

/** Reasons that mean "backup is off here", not "backup failed". */
const QUIET_SKIPS = new Set(["no_backup_key", "no_vault"]);

function relayMessage(error: unknown): string {
  if (error instanceof CloudBackupError) {
    if (error.code === "relay_expired") return "The code expired. Start again for a new code.";
    if (error.code === "payload_owner_mismatch")
      return "A different vAPI account approved it. Approve with the account your agent wallets are linked to.";
    if (error.code === "relay_create_failed")
      return "vAPI Desktop could not reach vAPI. Try again.";
  }
  return "Encrypted backup could not be set up. Try again.";
}

/**
 * Encrypted backup (spec §8, ADR 0021). The owner approves in the console, which derives the
 * backup key and seals it to this Mac through a ten-minute relay; the signer stores the key in
 * the OS store and uploads only the envelope. The UI sees codes and states, never a key.
 */
export function createBackupService(deps: {
  home: string;
  secrets: SecretStore;
  apiBase: string;
  hostname: string;
  store: () => Promise<WalletStore>;
  core?: Partial<BackupCore>;
  now?: () => Date;
  debounceMs?: number;
}) {
  const core: BackupCore = {
    startRelay,
    awaitRelay,
    storeBackupKey,
    uploadBackup,
    readCloudBackupState,
    restoreFromOwner,
    loadOrCreateDeviceKey,
    protectVault,
    readVaultFileUnlocked,
    ...deps.core,
  };
  const device = desktopDeviceName(deps.hostname);
  const origin = new URL(deps.apiBase).origin;
  const vaultPath = join(deps.home, "vault.json");
  const now = () => deps.now?.() ?? new Date();
  let pending: Pending | undefined;
  let generation = 0;
  let lastFailure: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let uploading: Promise<void> | undefined;
  let again = false;

  function dropPending(): void {
    generation += 1;
    pending?.controller.abort();
    if (pending?.outcome?.kind === "approved") pending.outcome.payload.key.fill(0);
    pending = undefined;
  }

  async function status(): Promise<BackupState> {
    const state = await core.readCloudBackupState({ secrets: deps.secrets, device });
    return {
      enabled: state.enabled,
      ...(state.lastUploadAt === undefined ? {} : { lastUploadAt: state.lastUploadAt }),
      failed: state.enabled && lastFailure !== undefined,
    };
  }

  async function start(purpose: BackupPurpose, owner?: `0x${string}`): Promise<BackupStartResult> {
    if (purpose === "enroll" && owner === undefined) {
      return { mode: "error", message: "Connect your vAPI account first." };
    }
    dropPending();
    const startedGeneration = generation;
    let started: Awaited<ReturnType<BackupCore["startRelay"]>>;
    try {
      started = await core.startRelay({
        apiBase: deps.apiBase,
        device,
        purpose,
        ...(deps.now === undefined ? {} : { now: deps.now }),
      });
    } catch (error) {
      return { mode: "error", message: relayMessage(error) };
    }
    if (generation !== startedGeneration) {
      started.keyPair.privateKey.fill(0);
      started.keyPair.publicKey.fill(0);
      return { mode: "error", message: "The backup request was cancelled." };
    }
    const entry: Pending = {
      purpose,
      controller: new AbortController(),
      code: started.code,
      url: `${origin}/agents`,
      expiresAt: Date.parse(started.expiresAt),
    };
    pending = entry;
    void core
      .awaitRelay({
        apiBase: deps.apiBase,
        code: started.code,
        keyPair: started.keyPair,
        expiresAt: started.expiresAt,
        device,
        purpose,
        signal: entry.controller.signal,
        ...(owner === undefined ? {} : { expectedOwner: owner }),
        ...(deps.now === undefined ? {} : { now: deps.now }),
      })
      .then(async (payload) => {
        let retained = false;
        try {
          if (pending !== entry || entry.controller.signal.aborted) return;
          if (purpose === "restore") {
            entry.outcome = { kind: "approved", payload };
            retained = true;
            return;
          }
          await core.storeBackupKey({
            secrets: deps.secrets,
            device,
            owner: payload.owner,
            kdf: payload.kdf,
            key: payload.key,
          });
        } finally {
          if (!retained) payload.key.fill(0);
        }
        if (pending !== entry || entry.controller.signal.aborted) return;
        await uploadNow();
        entry.outcome = { kind: "enrolled" };
      })
      .catch((error: unknown) => {
        entry.outcome = { kind: "failed", message: relayMessage(error) };
      })
      .finally(() => {
        started.keyPair.privateKey.fill(0);
        started.keyPair.publicKey.fill(0);
      });
    return { mode: "browser", code: entry.code, url: entry.url, expiresAt: entry.expiresAt };
  }

  function poll(): BackupPollState {
    const entry = pending;
    if (entry === undefined) return { state: "none" };
    const outcome = entry.outcome;
    if (outcome === undefined) {
      return {
        state: "pending",
        purpose: entry.purpose,
        code: entry.code,
        url: entry.url,
        expiresAt: entry.expiresAt,
      };
    }
    if (outcome.kind === "approved") {
      if (now().getTime() >= entry.expiresAt) {
        dropPending();
        return { state: "failed", message: "The approval expired. Start again for a new code." };
      }
      return { state: "approved", owner: outcome.payload.owner };
    }
    pending = undefined;
    return outcome.kind === "enrolled"
      ? { state: "enrolled" }
      : { state: "failed", message: outcome.message };
  }

  async function uploadOnce(): Promise<void> {
    const result = await core.uploadBackup({
      store: await deps.store(),
      secrets: deps.secrets,
      device,
      apiBase: deps.apiBase,
      ...(deps.now === undefined ? {} : { now: deps.now }),
    });
    if (result.status === "uploaded") lastFailure = undefined;
    else if (!QUIET_SKIPS.has(result.reason)) lastFailure = result.reason;
  }

  /** Single flight: a change during an upload runs one more upload after it. */
  async function uploadNow(): Promise<void> {
    if (uploading !== undefined) {
      again = true;
      return await uploading;
    }
    uploading = (async () => {
      do {
        again = false;
        await uploadOnce();
      } while (again);
    })().finally(() => {
      uploading = undefined;
    });
    return await uploading;
  }

  function schedule(): void {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      void core
        .readCloudBackupState({ secrets: deps.secrets, device })
        .then((state) => (state.enabled ? uploadNow() : undefined))
        .catch(() => undefined);
    }, deps.debounceMs ?? 3_000);
  }

  async function restore(password: string): Promise<{ wallets: string[] }> {
    const entry = pending;
    const outcome = entry?.outcome;
    if (entry === undefined || outcome?.kind !== "approved") {
      throw new Error("Approve the restore in the console first.");
    }
    if (now().getTime() >= entry.expiresAt) {
      dropPending();
      throw new Error("The approval expired. Start again for a new code.");
    }
    // Consume the approval before awaiting so overlapping requests cannot restore it twice.
    pending = undefined;
    let vaultKey: Uint8Array | undefined;
    try {
      vaultKey = await core.loadOrCreateDeviceKey({ secrets: deps.secrets });
      const result = await core.restoreFromOwner({
        payload: outcome.payload,
        home: deps.home,
        vaultKey,
        secrets: deps.secrets,
        password,
        ...(deps.now === undefined ? {} : { now: deps.now }),
      });
      // vAPI Desktop always has a password, even when the backup came from an unprotected CLI vault.
      if (!(await core.readVaultFileUnlocked(vaultPath)).protected) {
        await core.protectVault({ path: vaultPath, secrets: deps.secrets, password });
      }
      await appendAudit(deps.home, {
        event: "vault.restore",
        tty: false,
        detail: `${result.accounts.length} agent wallet(s) from encrypted backup`,
      });
      return { wallets: result.accounts.map((account) => account.name) };
    } catch (error) {
      if (error instanceof CloudBackupError && error.code === "vault_exists") {
        throw new Error("vAPI Desktop is already set up on this Mac.");
      }
      if (error instanceof CloudBackupError || error instanceof VaultError) {
        throw new Error("vAPI Desktop could not restore your encrypted backup. Try again.");
      }
      throw error;
    } finally {
      vaultKey?.fill(0);
      outcome.payload.key.fill(0);
      entry.controller.abort();
    }
  }

  function cancelAll(): void {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    dropPending();
  }

  return { status, start, poll, schedule, uploadNow, restore, cancelAll };
}
