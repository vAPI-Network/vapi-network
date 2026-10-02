/**
 * `@vapi-network/core/cloud-backup` keeps cloud backup keys on the device.
 *
 * The owner sends a backup key through an X25519 sealed relay. Storage receives
 * only the encrypted backup envelope.
 */
import { join } from "node:path";

import {
  BackupError,
  createBackup,
  createRelayKeyPair,
  exportBackupSource,
  openSealed,
  parseBackupPlaintext,
  relayCode,
  restoreBackupPlaintext,
  type BackupKdf,
  type BackupExportSkipped,
  type BackupOmittedSection,
  type BackupPlaintext,
  type BackupRestoreResult,
} from "./backup.js";
import type { AgentProfileParser } from "./agent-profile.js";
import { AgentLinkError, agentFetch, withAgentCredentialLock } from "./agent-link.js";
import { DEVICE_NAME_PATTERN } from "./device.js";
import { createPublicFetch } from "./net-guard.js";
import type { SecretStore } from "./secret-store.js";
import {
  loadOrCreateDeviceKey,
  protectVault,
  unlockProtectedVault,
  type VaultEnv,
} from "./vault-key.js";
import { readVaultFileUnlocked, VaultError } from "./vault.js";
import type { AgentLink, WalletName, WalletStore } from "./wallet-store.js";

export type RelayPurpose = "enroll" | "restore";

export type RelayKeyPair = {
  publicKey: Uint8Array;
  privateKey: Uint8Array;
};

export type RelayPayload = {
  format: "vapi-vault-relay-payload";
  v: 1;
  purpose: RelayPurpose;
  owner: `0x${string}`;
  device: string;
  kdf: BackupKdf;
  key: Uint8Array;
  vault?: BackupPlaintext;
};

export type CloudBackupErrorCode =
  | "relay_create_failed"
  | "relay_expired"
  | "relay_aborted"
  | "payload_invalid"
  | "payload_device_mismatch"
  | "payload_purpose_mismatch"
  | "payload_owner_mismatch"
  | "secret_store_unavailable"
  | "vault_exists"
  | "restore_failed";

const ERROR_MESSAGES: Record<CloudBackupErrorCode, string> = {
  relay_create_failed: "The backup approval request could not be started. Try again.",
  relay_expired:
    "The backup code expired before the owner approved it. Run the command again for a new code.",
  relay_aborted: "Waiting for owner approval was canceled.",
  payload_invalid: "The owner sent an invalid backup response.",
  payload_device_mismatch: "The backup response was created for another device.",
  payload_purpose_mismatch: "The backup response was created for another request.",
  payload_owner_mismatch: "The backup response came from another owner.",
  secret_store_unavailable: "The backup key could not be stored in the OS secret store.",
  vault_exists: "A vault already exists.",
  restore_failed: "The vault could not be restored from the owner backup.",
};

export class CloudBackupError extends Error {
  readonly code: CloudBackupErrorCode;

  constructor(code: CloudBackupErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "CloudBackupError";
    this.code = code;
  }
}

export type StoredBackupKey = {
  owner: `0x${string}`;
  device: string;
  kdf: BackupKdf;
  key: Uint8Array;
};

export type CloudBackupState = {
  enabled: boolean;
  lastUploadAt?: string;
  sizeBytes?: number;
};

export type UploadBackupResult =
  | {
      status: "uploaded";
      account: string;
      bytes: number;
      uploadedAt: string;
      omitted?: BackupOmittedSection[];
      skipped?: BackupExportSkipped[];
    }
  | {
      status: "skipped";
      reason:
        | "no_backup_key"
        | "no_vault"
        | "vault_locked"
        | "not_linked"
        | "device_unknown"
        | "snapshot_busy"
        | "rejected"
        | "network"
        | "timeout";
      httpStatus?: number;
    };

type RandomBytes = (length: number) => Uint8Array;

const RELAY_PAYLOAD_FORMAT = "vapi-vault-relay-payload";
const OWNER_PATTERN = /^0x[0-9a-f]{40}$/u;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]*$/u;
const ISO_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const HKDF_KEYS = ["name", "salt"] as const;
const SCRYPT_KEYS = ["name", "salt", "N", "r", "p"] as const;
const ENROLL_PAYLOAD_KEYS = ["format", "v", "purpose", "owner", "device", "kdf", "key"] as const;
const RESTORE_PAYLOAD_KEYS = [...ENROLL_PAYLOAD_KEYS, "vault"] as const;
const STORED_KEY_KEYS = ["owner", "device", "kdf", "key"] as const;
const RELAY_RESULT_KEYS = ["sealed"] as const;
const RELAY_START_KEYS = ["code", "expiresAt"] as const;
const STATE_KEYS = ["lastUploadAt", "sizeBytes"] as const;
const publicFetch = createPublicFetch({ allowPrivateNetwork: false });

export async function startRelay(options: {
  apiBase: string;
  device: string;
  purpose: RelayPurpose;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  randomBytes?: RandomBytes;
}): Promise<{ code: string; expiresAt: string; keyPair: RelayKeyPair }> {
  let keyPair: RelayKeyPair | undefined;
  try {
    if (!DEVICE_NAME_PATTERN.test(options.device) || !isRelayPurpose(options.purpose)) {
      throw new Error();
    }
    keyPair = createRelayKeyPair(
      options.randomBytes === undefined ? {} : { randomBytes: options.randomBytes },
    );
    const code = relayCode(keyPair.publicKey);
    const body = {
      publicKey: encodeBase64Url(keyPair.publicKey),
      code,
      device: options.device,
      purpose: options.purpose,
    };
    const response = await (options.fetchImpl ?? publicFetch)(
      apiEndpoint(options.apiBase, "/api/agents/backup-relays"),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    if (response.status !== 201) throw new Error();
    const value: unknown = await response.json();
    if (
      !isRecord(value) ||
      !hasExactKeys(value, RELAY_START_KEYS) ||
      value.code !== code ||
      typeof value.expiresAt !== "string" ||
      !isIsoUtc(value.expiresAt) ||
      new Date(value.expiresAt).getTime() <= readNow(options.now).getTime()
    ) {
      throw new Error();
    }
    return { code, expiresAt: value.expiresAt, keyPair };
  } catch {
    keyPair?.privateKey.fill(0);
    keyPair?.publicKey.fill(0);
    throw new CloudBackupError("relay_create_failed");
  }
}

export async function awaitRelay(options: {
  apiBase: string;
  code: string;
  keyPair: RelayKeyPair;
  expiresAt: string;
  expectedOwner?: string;
  device: string;
  purpose: RelayPurpose;
  signal?: AbortSignal;
  pollMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}): Promise<RelayPayload> {
  const deadline = new Date(options.expiresAt).getTime();
  const now = options.now ?? (() => new Date());
  const sleep = options.sleep ?? sleepFor;
  const pollMs = options.pollMs ?? 2_000;
  if (!Number.isFinite(deadline)) throw new CloudBackupError("relay_expired");

  while (true) {
    if (isAborted(options.signal)) throw new CloudBackupError("relay_aborted");
    const remaining = deadline - readNow(now).getTime();
    if (remaining <= 0) throw new CloudBackupError("relay_expired");

    let response: Response | undefined;
    const requestDeadline = AbortSignal.timeout(Math.max(1, remaining));
    const requestSignal =
      options.signal === undefined
        ? requestDeadline
        : AbortSignal.any([options.signal, requestDeadline]);
    try {
      response = await (options.fetchImpl ?? publicFetch)(
        apiEndpoint(
          options.apiBase,
          `/api/agents/backup-relays/${encodeURIComponent(options.code)}/result`,
        ),
        { method: "GET", signal: requestSignal },
      );
    } catch {
      if (isAborted(options.signal)) throw new CloudBackupError("relay_aborted");
      if (requestDeadline.aborted) throw new CloudBackupError("relay_expired");
    }

    if (response?.status === 404) throw new CloudBackupError("relay_expired");
    if (response?.status === 200) {
      return await readRelayResult(response, options);
    }

    try {
      await sleep(Math.min(Math.max(0, pollMs), remaining), options.signal);
    } catch {
      if (isAborted(options.signal)) throw new CloudBackupError("relay_aborted");
    }
  }
}

export function backupKeyAccount(device: string): string {
  return `vapi.backup.${device}.key`;
}

export function backupStateAccount(device: string): string {
  return `vapi.backup.${device}.state`;
}

export async function storeBackupKey(options: {
  secrets: SecretStore;
  device: string;
  owner: string;
  kdf: BackupKdf;
  key: Uint8Array;
}): Promise<void> {
  if (!options.secrets.available) throw new CloudBackupError("secret_store_unavailable");
  const encodedKey = encodeSecretKey(options.key);
  let parsed: StoredBackupKey | undefined;
  try {
    parsed = parseStoredBackupKey({
      owner: options.owner,
      device: options.device,
      kdf: options.kdf,
      key: encodedKey,
    });
    if (parsed === undefined) throw new Error();
    await options.secrets.set(
      backupKeyAccount(options.device),
      JSON.stringify({
        owner: parsed.owner,
        device: parsed.device,
        kdf: parsed.kdf,
        key: encodedKey,
      }),
    );
  } catch {
    throw new CloudBackupError("secret_store_unavailable");
  } finally {
    parsed?.key.fill(0);
  }
}

export async function readBackupKey(options: {
  secrets: SecretStore;
  device: string;
}): Promise<StoredBackupKey | undefined> {
  if (!options.secrets.available) return undefined;
  try {
    const stored = await options.secrets.get(backupKeyAccount(options.device));
    if (stored === undefined) return undefined;
    const value: unknown = JSON.parse(stored);
    const parsed = parseStoredBackupKey(value);
    if (parsed?.device !== options.device) {
      parsed?.key.fill(0);
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

export async function forgetBackupKey(options: {
  secrets: SecretStore;
  device: string;
}): Promise<boolean> {
  if (!options.secrets.available) throw new CloudBackupError("secret_store_unavailable");
  try {
    const existed = await options.secrets.remove(backupKeyAccount(options.device));
    await options.secrets.remove(backupStateAccount(options.device));
    return existed;
  } catch {
    throw new CloudBackupError("secret_store_unavailable");
  }
}

export async function readCloudBackupState(options: {
  secrets: SecretStore;
  device: string;
}): Promise<CloudBackupState> {
  if (!options.secrets.available) return { enabled: false };
  let enabled: boolean;
  try {
    enabled = await options.secrets.has(backupKeyAccount(options.device));
  } catch {
    return { enabled: false };
  }
  if (!enabled) return { enabled: false };
  try {
    const stored = await options.secrets.get(backupStateAccount(options.device));
    const state = parseStoredState(stored);
    return state === undefined ? { enabled: true } : { enabled: true, ...state };
  } catch {
    return { enabled: true };
  }
}

export async function uploadBackup(options: {
  store: WalletStore;
  secrets: SecretStore;
  device: string;
  apiBase?: string;
  account?: string;
  networks?: readonly string[];
  env?: VaultEnv;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  randomBytes?: RandomBytes;
  timeoutMs?: number;
  signal?: AbortSignal;
  agentProfileSchema?: AgentProfileParser;
}): Promise<UploadBackupResult> {
  const timeoutSignal = AbortSignal.timeout(Math.max(0, options.timeoutMs ?? 10_000));
  const signal =
    options.signal === undefined ? timeoutSignal : AbortSignal.any([options.signal, timeoutSignal]);
  try {
    return await withAgentCredentialLock(
      options.store,
      `cloud-backup:${options.device}`,
      async () => await uploadBackupLocked(options, signal),
    );
  } catch (error) {
    if (signal.aborted) return { status: "skipped", reason: "timeout" };
    if (error instanceof AgentLinkError && error.code === "not_linked") {
      return { status: "skipped", reason: "not_linked" };
    }
    return { status: "skipped", reason: "network" };
  }
}

async function uploadBackupLocked(
  options: Parameters<typeof uploadBackup>[0],
  signal: AbortSignal,
): Promise<UploadBackupResult> {
  const stored = await readBackupKey({ secrets: options.secrets, device: options.device });
  if (signal.aborted) return { status: "skipped", reason: "timeout" };
  if (stored === undefined) return { status: "skipped", reason: "no_backup_key" };

  let vaultKey: Uint8Array | undefined;
  let salt: Buffer | undefined;
  try {
    let vaultFile;
    try {
      vaultFile = await readVaultFileUnlocked(join(options.store.home, "vault.json"));
    } catch (error) {
      if (error instanceof VaultError && error.code === "not_found") {
        return { status: "skipped", reason: "no_vault" };
      }
      return { status: "skipped", reason: "vault_locked" };
    }

    try {
      vaultKey = vaultFile.protected
        ? await unlockProtectedVault({
            path: join(options.store.home, "vault.json"),
            secrets: options.secrets,
            env: options.env,
            ...(options.now === undefined ? {} : { now: options.now }),
          })
        : await loadOrCreateDeviceKey({ secrets: options.secrets });
    } catch {
      return { status: "skipped", reason: "vault_locked" };
    }

    const source = await exportBackupSource({
      store: options.store,
      vaultKey,
      ...(options.networks === undefined ? {} : { networks: options.networks }),
      ...(options.agentProfileSchema === undefined
        ? {}
        : { agentProfileSchema: options.agentProfileSchema }),
    });
    salt = decodeBase64Url(stored.kdf.salt);
    if (salt?.byteLength !== 32) return { status: "skipped", reason: "rejected" };
    const created = await createBackup({
      vault: source,
      ownerKey: { kdf: stored.kdf.name, key: stored.key, salt },
      owner: stored.owner,
      device: options.device,
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.randomBytes === undefined ? {} : { randomBytes: options.randomBytes }),
    });

    const selected = await selectLinkedAccount(options, stored.owner);
    if (selected === undefined) return { status: "skipped", reason: "not_linked" };
    if (signal.aborted) return { status: "skipped", reason: "timeout" };

    let response: Response;
    try {
      const now = options.now;
      response = await withAgentCredentialLock(
        options.store,
        `wallet:${selected.name}`,
        async () => {
          await options.store.reload();
          const link = options.store.entry(selected.name)?.link;
          if (!linkMatches(link, stored.owner, options.apiBase)) {
            throw new AgentLinkError("not_linked", "Run vapi login first.");
          }
          return await agentFetch(
            {
              secrets: options.secrets,
              wallets: options.store,
              wallet: selected.name,
              ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
              ...(now === undefined ? {} : { now: () => now().getTime() }),
            },
            apiEndpoint(link.apiBase, "/api/agents/self/backup"),
            {
              method: "PUT",
              headers: { "content-type": "application/json" },
              body: created.envelope,
              signal,
            },
          );
        },
      );
    } catch (error) {
      if (signal.aborted) return { status: "skipped", reason: "timeout" };
      if (error instanceof AgentLinkError && error.code === "not_linked") {
        return { status: "skipped", reason: "not_linked" };
      }
      return { status: "skipped", reason: "network" };
    }

    if (response.status === 409) return { status: "skipped", reason: "device_unknown" };
    if (!response.ok) {
      return { status: "skipped", reason: "rejected", httpStatus: response.status };
    }

    const uploadedAt = readNow(options.now).toISOString();
    await writeBackupState(options.secrets, options.device, {
      lastUploadAt: uploadedAt,
      sizeBytes: created.bytes,
    });
    return {
      status: "uploaded",
      account: selected.name,
      bytes: created.bytes,
      uploadedAt,
      ...(created.omitted === undefined ? {} : { omitted: created.omitted }),
      ...(source.skipped === undefined ? {} : { skipped: source.skipped }),
    };
  } catch (error) {
    if (signal.aborted) return { status: "skipped", reason: "timeout" };
    if (error instanceof AgentLinkError && error.code === "not_linked") {
      return { status: "skipped", reason: "not_linked" };
    }
    if (error instanceof BackupError && error.code === "backup_snapshot_busy") {
      return { status: "skipped", reason: "snapshot_busy" };
    }
    return { status: "skipped", reason: "rejected" };
  } finally {
    vaultKey?.fill(0);
    stored.key.fill(0);
    salt?.fill(0);
  }
}

export { buildRelayRestorePayload } from "./backup.js";

export async function restoreFromOwner(options: {
  payload: RelayPayload;
  home: string;
  vaultKey: Uint8Array;
  secrets: SecretStore;
  password?: string;
  env?: VaultEnv;
  randomBytes?: RandomBytes;
  now?: () => Date;
}): Promise<BackupRestoreResult> {
  if (options.payload.purpose !== "restore" || options.payload.vault === undefined) {
    throw new CloudBackupError("payload_invalid");
  }
  let result: Awaited<ReturnType<typeof restoreBackupPlaintext>>;
  try {
    result = await restoreBackupPlaintext({
      plaintext: options.payload.vault,
      home: options.home,
      vaultKey: options.vaultKey,
      device: options.payload.device,
      ...(options.now === undefined ? {} : { now: options.now }),
      beforePublish: async ({ vault }) => {
        if (options.payload.vault?.protected === true) {
          await protectVault({
            path: vault,
            secrets: options.secrets,
            ...(options.password === undefined ? {} : { password: options.password }),
            ...(options.env === undefined ? {} : { env: options.env }),
            ...(options.randomBytes === undefined ? {} : { randomBytes: options.randomBytes }),
          });
        }
        await storeBackupKey({
          secrets: options.secrets,
          device: options.payload.device,
          owner: options.payload.owner,
          kdf: options.payload.kdf,
          key: options.payload.key,
        });
      },
    });
  } catch (error) {
    if (error instanceof CloudBackupError) throw error;
    if (error instanceof BackupError && error.code === "vault_exists") {
      throw new CloudBackupError("vault_exists");
    }
    throw new CloudBackupError("restore_failed");
  }
  return result;
}

async function readRelayResult(
  response: Response,
  options: {
    keyPair: RelayKeyPair;
    expectedOwner?: string;
    device: string;
    purpose: RelayPurpose;
  },
): Promise<RelayPayload> {
  let plaintext: Uint8Array | undefined;
  try {
    const result: unknown = await response.json();
    if (
      !isRecord(result) ||
      !hasExactKeys(result, RELAY_RESULT_KEYS) ||
      typeof result.sealed !== "string"
    ) {
      throw new Error();
    }
    plaintext = openSealed({
      recipientPrivateKey: options.keyPair.privateKey,
      sealed: result.sealed,
    });
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
    const payload = parseRelayPayload(JSON.parse(decoded) as unknown);
    if (payload.purpose !== options.purpose) {
      payload.key.fill(0);
      throw new CloudBackupError("payload_purpose_mismatch");
    }
    if (payload.device !== options.device) {
      payload.key.fill(0);
      throw new CloudBackupError("payload_device_mismatch");
    }
    if (
      options.expectedOwner !== undefined &&
      payload.owner !== options.expectedOwner.toLowerCase()
    ) {
      payload.key.fill(0);
      throw new CloudBackupError("payload_owner_mismatch");
    }
    return payload;
  } catch (error) {
    if (error instanceof CloudBackupError) throw error;
    throw new CloudBackupError("payload_invalid");
  } finally {
    plaintext?.fill(0);
  }
}

function parseRelayPayload(value: unknown): RelayPayload {
  if (!isRecord(value) || !isRelayPurpose(value.purpose)) {
    throw new CloudBackupError("payload_invalid");
  }
  const expectedKeys = value.purpose === "restore" ? RESTORE_PAYLOAD_KEYS : ENROLL_PAYLOAD_KEYS;
  if (
    !hasExactKeys(value, expectedKeys) ||
    value.format !== RELAY_PAYLOAD_FORMAT ||
    value.v !== 1 ||
    typeof value.owner !== "string" ||
    !OWNER_PATTERN.test(value.owner) ||
    typeof value.device !== "string" ||
    !DEVICE_NAME_PATTERN.test(value.device) ||
    !isRecord(value.kdf) ||
    typeof value.key !== "string"
  ) {
    throw new CloudBackupError("payload_invalid");
  }
  const kdf = parseKdf(value.kdf);
  const key = decodeBase64Url(value.key);
  if (kdf === undefined || key?.byteLength !== 32) {
    key?.fill(0);
    throw new CloudBackupError("payload_invalid");
  }

  let vault: BackupPlaintext | undefined;
  try {
    if (value.purpose === "restore") vault = parseBackupPlaintext(value.vault);
  } catch {
    key.fill(0);
    throw new CloudBackupError("payload_invalid");
  }
  const copiedKey = Uint8Array.from(key);
  key.fill(0);
  return {
    format: RELAY_PAYLOAD_FORMAT,
    v: 1,
    purpose: value.purpose,
    owner: value.owner as `0x${string}`,
    device: value.device,
    kdf,
    key: copiedKey,
    ...(vault === undefined ? {} : { vault }),
  };
}

function parseStoredBackupKey(value: unknown): StoredBackupKey | undefined {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, STORED_KEY_KEYS) ||
    typeof value.owner !== "string" ||
    !OWNER_PATTERN.test(value.owner) ||
    typeof value.device !== "string" ||
    !DEVICE_NAME_PATTERN.test(value.device) ||
    !isRecord(value.kdf) ||
    typeof value.key !== "string"
  ) {
    return undefined;
  }
  const kdf = parseKdf(value.kdf);
  const key = decodeBase64Url(value.key);
  if (kdf === undefined || key?.byteLength !== 32) {
    key?.fill(0);
    return undefined;
  }
  const copiedKey = Uint8Array.from(key);
  key.fill(0);
  return { owner: value.owner as `0x${string}`, device: value.device, kdf, key: copiedKey };
}

function parseKdf(value: Record<string, unknown>): BackupKdf | undefined {
  if (
    value.name === "hkdf-sha256" &&
    hasExactKeys(value, HKDF_KEYS) &&
    typeof value.salt === "string" &&
    isBase64UrlBytes(value.salt, 32)
  ) {
    return { name: "hkdf-sha256", salt: value.salt };
  }
  if (
    value.name === "scrypt" &&
    hasExactKeys(value, SCRYPT_KEYS) &&
    typeof value.salt === "string" &&
    isBase64UrlBytes(value.salt, 32) &&
    value.N === 131_072 &&
    value.r === 8 &&
    value.p === 1
  ) {
    return { name: "scrypt", salt: value.salt, N: 131_072, r: 8, p: 1 };
  }
  return undefined;
}

function parseStoredState(
  value: string | undefined,
): { lastUploadAt: string; sizeBytes: number } | undefined {
  if (value === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      !isRecord(parsed) ||
      !hasExactKeys(parsed, STATE_KEYS) ||
      typeof parsed.lastUploadAt !== "string" ||
      !isIsoUtc(parsed.lastUploadAt) ||
      typeof parsed.sizeBytes !== "number" ||
      !Number.isSafeInteger(parsed.sizeBytes) ||
      parsed.sizeBytes < 0
    ) {
      return undefined;
    }
    return { lastUploadAt: parsed.lastUploadAt, sizeBytes: parsed.sizeBytes };
  } catch {
    return undefined;
  }
}

async function writeBackupState(
  secrets: SecretStore,
  device: string,
  state: { lastUploadAt: string; sizeBytes: number },
): Promise<void> {
  try {
    await secrets.set(backupStateAccount(device), JSON.stringify(state));
  } catch {
    // The encrypted backup is already stored. A missing local timestamp must not report failure.
  }
}

async function selectLinkedAccount(
  options: { store: WalletStore; account?: string; apiBase?: string },
  owner: string,
): Promise<{ name: WalletName } | undefined> {
  await options.store.reload();
  const names = uniqueNames([
    ...(options.account === undefined ? [] : [options.account]),
    ...(options.store.defaultName === undefined ? [] : [options.store.defaultName]),
    ...options.store.names(),
  ]);
  for (const name of names) {
    if (linkMatches(options.store.entry(name)?.link, owner, options.apiBase)) return { name };
  }
  return undefined;
}

function linkMatches(
  link: AgentLink | undefined,
  owner: string,
  apiBase: string | undefined,
): link is AgentLink {
  if (link === undefined || link.owner.toLowerCase() !== owner.toLowerCase()) return false;
  if (apiBase === undefined) return true;
  try {
    return new URL(link.apiBase).origin === new URL(apiBase).origin;
  } catch {
    return false;
  }
}

function uniqueNames(values: readonly string[]): WalletName[] {
  const result: WalletName[] = [];
  for (const value of values) {
    if (!result.includes(value as WalletName)) result.push(value as WalletName);
  }
  return result;
}

function encodeSecretKey(key: Uint8Array): string {
  if (!(key instanceof Uint8Array) || key.byteLength !== 32) {
    throw new CloudBackupError("secret_store_unavailable");
  }
  const copy = Buffer.from(key);
  try {
    return copy.toString("base64url");
  } finally {
    copy.fill(0);
  }
}

function encodeBase64Url(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

function decodeBase64Url(value: string): Buffer | undefined {
  if (!BASE64URL_PATTERN.test(value) || value.length % 4 === 1) return undefined;
  const decoded = Buffer.from(value, "base64url");
  if (decoded.toString("base64url") !== value) {
    decoded.fill(0);
    return undefined;
  }
  return decoded;
}

function isBase64UrlBytes(value: string, length: number): boolean {
  const decoded = decodeBase64Url(value);
  try {
    return decoded?.byteLength === length;
  } finally {
    decoded?.fill(0);
  }
}

function isIsoUtc(value: string): boolean {
  if (!ISO_UTC_PATTERN.test(value)) return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function readNow(now: (() => Date) | undefined): Date {
  const value = (now ?? (() => new Date()))();
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw new Error();
  return value;
}

function isRelayPurpose(value: unknown): value is RelayPurpose {
  return value === "enroll" || value === "restore";
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

function apiEndpoint(apiBase: string, path: string): string {
  return new URL(path, new URL(apiBase).origin).toString();
}

async function sleepFor(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) throw signal.reason;
  await new Promise<void>((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const timeout = setTimeout(finish, milliseconds);
    const abort = () => {
      clearTimeout(timeout);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}
