import { join } from "node:path";

import {
  activeAgentMarker,
  createPublicFetch,
  deviceName,
  ensureDeviceName,
  fetchSiblings,
  getVapiPaths,
  loadOrCreateDeviceKey,
  writeDefaultConfig,
  type SiblingsResult,
  type WalletName,
} from "@vapi-network/core";
import {
  awaitRelay,
  forgetBackupKey,
  readCloudBackupState,
  restoreFromOwner,
  startRelay,
  storeBackupKey,
  uploadBackup,
  type UploadBackupResult,
} from "@vapi-network/core/cloud-backup";
import { registeredAgentProfileSchema } from "@vapi-network/mcp";

import { detectColorLevel } from "./brand.js";
import {
  UsageError,
  fileExists,
  getEnvironment,
  getLinePrompt,
  getPrompts,
  getSecretStore,
  isInteractive,
  isStdinInteractive,
  openInBrowser,
  openWalletStore,
  output,
  parseArguments,
  readConfig,
  recordAudit,
  registryBaseUrl,
  type CliDependencies,
  type CliIo,
} from "./cli.js";

const CLOUD_BACKUP_USAGE = "Usage: vapi backup --cloud [off] [--json]";
const OWNER_RESTORE_USAGE = "Usage: vapi restore --from-owner [--owner <0x…>] [--json]";
const OWNER_PATTERN = /^0x[0-9a-fA-F]{40}$/u;
const SIBLINGS_REQUEST_TIMEOUT_MS = 8_000;
const DEFAULT_UPLOAD_TIMEOUT_MS = 10_000;

type EnrollResult =
  | {
      status: "uploaded";
      device: string;
      bytes: number;
      uploadedAt: string;
      omitted?: NonNullable<Extract<UploadBackupResult, { status: "uploaded" }>["omitted"]>;
      skipped?: NonNullable<Extract<UploadBackupResult, { status: "uploaded" }>["skipped"]>;
    }
  | { status: "skipped"; device: string; reason: string };

export async function cloudBackupCommand(
  argv: string[],
  json: boolean,
  io: CliIo,
  dependencies: CliDependencies,
): Promise<void> {
  const parsed = parseArguments(argv, {
    valueOptions: new Set(),
    booleanOptions: new Set(["--cloud"]),
    maximumPositionals: 1,
  });
  if (!parsed.has("--cloud")) throw new UsageError(CLOUD_BACKUP_USAGE);
  const action = parsed.positionals[0];
  if (action !== undefined && action !== "off") throw new UsageError(CLOUD_BACKUP_USAGE);
  if (action === "off") {
    await disableCloudBackup(json, io, dependencies);
    return;
  }
  await enrollCloudBackup(json, io, dependencies);
}

export async function enrollCloudBackup(
  json: boolean,
  io: CliIo,
  dependencies: CliDependencies,
): Promise<EnrollResult> {
  const paths = getVapiPaths();
  if (!(await fileExists(join(paths.directory, "vault.json")))) {
    throw new Error("No vault on this device. Run vapi setup first.");
  }
  const context = await cloudContext(io, dependencies);
  const linked = linkedAccount(context.store);
  if (linked === undefined) throw new Error("Link this device first: vapi login");

  if (await hasDeviceNameClash(context, linked.name, linked.apiBase, dependencies)) {
    const warning = deviceClashWarning(context.device);
    io.stderr(warning);
    if (!isInteractive(dependencies)) throw new Error("Choose a unique device name and try again.");
    const answer = await getLinePrompt(dependencies)("Continue anyway? [y/N] ");
    if (!isYes(answer, false)) throw new Error("Cloud backup was not enabled.");
  }

  const begin = dependencies.cloudBackup?.startRelay ?? startRelay;
  const wait = dependencies.cloudBackup?.awaitRelay ?? awaitRelay;
  const started = await begin({
    apiBase: context.apiBase,
    device: context.device,
    purpose: "enroll",
    fetchImpl: context.fetchImpl,
    ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
    ...(dependencies.cloudBackup?.randomBytes === undefined
      ? {}
      : { randomBytes: dependencies.cloudBackup.randomBytes }),
  });
  const consoleUrl = cloudConsoleUrl(context.apiBase);
  const humanIo = json ? io.stderr : io.stdout;
  humanIo(`Open ${consoleUrl} and enter code ${started.code}.`);
  openConsole(consoleUrl, dependencies);
  const stopWaiting = startWaiting(json, io);

  let payload: Awaited<ReturnType<typeof wait>> | undefined;
  try {
    payload = await wait({
      apiBase: context.apiBase,
      code: started.code,
      keyPair: started.keyPair,
      expiresAt: started.expiresAt,
      expectedOwner: linked.owner,
      device: context.device,
      purpose: "enroll",
      fetchImpl: context.fetchImpl,
      ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
      ...(dependencies.cloudBackup?.sleep === undefined
        ? {}
        : { sleep: dependencies.cloudBackup.sleep }),
    });
    await storeBackupKey({
      secrets: context.secrets,
      device: context.device,
      owner: payload.owner,
      kdf: payload.kdf,
      key: payload.key,
    });
  } finally {
    stopWaiting();
    started.keyPair.privateKey.fill(0);
    started.keyPair.publicKey.fill(0);
    payload?.key.fill(0);
  }

  const uploaded = await runUpload(context, dependencies, linked.name);
  await recordAudit(dependencies, "vault.cloud_backup_on", {
    wallet: linked.name,
    detail: `device ${context.device}`,
  });
  if (uploaded.status === "uploaded") {
    if (uploaded.omitted !== undefined) writeOmittedWarning(io, uploaded.omitted);
    if (uploaded.skipped !== undefined) writeSkippedWarnings(io, uploaded.skipped);
    output(
      io,
      json,
      {
        command: "backup",
        cloud: "on",
        device: context.device,
        bytes: uploaded.bytes,
        uploadedAt: uploaded.uploadedAt,
        ...(uploaded.omitted === undefined ? {} : { omitted: uploaded.omitted }),
        ...(uploaded.skipped === undefined ? {} : { skipped: uploaded.skipped }),
      },
      `Cloud backup on. Uploaded ${formatBytes(uploaded.bytes)} at ${formatUploadTime(uploaded.uploadedAt)}.`,
    );
    return {
      status: "uploaded",
      device: context.device,
      bytes: uploaded.bytes,
      uploadedAt: uploaded.uploadedAt,
      ...(uploaded.omitted === undefined ? {} : { omitted: uploaded.omitted }),
      ...(uploaded.skipped === undefined ? {} : { skipped: uploaded.skipped }),
    };
  }

  output(
    io,
    json,
    {
      command: "backup",
      cloud: "on",
      device: context.device,
      skipped: uploaded.reason,
    },
    `Cloud backup on. The first upload was skipped: ${uploadReason(uploaded)}.`,
  );
  return { status: "skipped", device: context.device, reason: uploaded.reason };
}

export async function restoreFromOwnerCommand(
  argv: string[],
  json: boolean,
  io: CliIo,
  dependencies: CliDependencies,
): Promise<void> {
  const parsed = parseArguments(argv, {
    valueOptions: new Set(["--owner"]),
    booleanOptions: new Set(["--from-owner"]),
    maximumPositionals: 0,
  });
  if (!parsed.has("--from-owner")) throw new UsageError(OWNER_RESTORE_USAGE);
  const ownerValue = parsed.one("--owner");
  if (ownerValue !== undefined && !OWNER_PATTERN.test(ownerValue)) {
    throw new UsageError("--owner must be a 0x address.");
  }
  const expectedOwner = ownerValue?.toLowerCase();
  const paths = getVapiPaths();
  // Only an interrupted restore of this device may meet an existing vault;
  // core validates that its in-progress record matches the owner's backup.
  if (
    (await fileExists(join(paths.directory, "vault.json"))) &&
    !(await fileExists(join(paths.directory, ".backup-restore.json")))
  ) {
    throw new Error(
      `A vault already exists in ${paths.directory}. Move it aside before restoring.`,
    );
  }
  if (!isInteractive(dependencies) && expectedOwner === undefined) {
    throw new Error("Non-interactive owner restore requires --owner <0x…>.");
  }

  const context = await cloudRestoreContext(io, dependencies);
  const begin = dependencies.cloudBackup?.startRelay ?? startRelay;
  const wait = dependencies.cloudBackup?.awaitRelay ?? awaitRelay;
  const started = await begin({
    apiBase: context.apiBase,
    device: context.device,
    purpose: "restore",
    fetchImpl: context.fetchImpl,
    ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
    ...(dependencies.cloudBackup?.randomBytes === undefined
      ? {}
      : { randomBytes: dependencies.cloudBackup.randomBytes }),
  });
  const consoleUrl = cloudConsoleUrl(context.apiBase);
  const humanIo = json ? io.stderr : io.stdout;
  humanIo(`Open ${consoleUrl} and enter code ${started.code}.`);
  openConsole(consoleUrl, dependencies);
  const stopWaiting = startWaiting(json, io);

  let payload: Awaited<ReturnType<typeof wait>> | undefined;
  let vaultKey: Uint8Array | undefined;
  try {
    payload = await wait({
      apiBase: context.apiBase,
      code: started.code,
      keyPair: started.keyPair,
      expiresAt: started.expiresAt,
      ...(expectedOwner === undefined ? {} : { expectedOwner }),
      device: context.device,
      purpose: "restore",
      fetchImpl: context.fetchImpl,
      ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
      ...(dependencies.cloudBackup?.sleep === undefined
        ? {}
        : { sleep: dependencies.cloudBackup.sleep }),
    });
    stopWaiting();

    if (expectedOwner === undefined) {
      humanIo(`Owner: ${payload.owner}`);
      const answer = await getLinePrompt(dependencies)("Restore this owner's vault here? [y/N] ");
      if (!isYes(answer, false)) throw new Error("Restore canceled. Nothing was written.");
    }

    const password = payload.vault?.protected
      ? await newVaultPassword(io, dependencies)
      : undefined;
    vaultKey = await loadOrCreateDeviceKey({ secrets: context.secrets });
    const restored = await restoreFromOwner({
      payload,
      home: paths.directory,
      vaultKey,
      secrets: context.secrets,
      ...(password === undefined ? {} : { password }),
      env: getEnvironment(dependencies),
      ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
    });
    if (!(await fileExists(paths.config))) {
      const networks = restored.networks.length === 0 ? ["base"] : restored.networks;
      await writeDefaultConfig(paths.config, getEnvironment(dependencies), { networks });
    }
    await recordAudit(dependencies, "vault.restore", {
      ...(restored.accounts[0] === undefined ? {} : { wallet: restored.accounts[0].name }),
      detail: `${restored.accounts.length} account(s), device ${context.device}`,
    });
    const restoredV2 = "agents" in restored ? restored : undefined;
    output(
      io,
      json,
      {
        command: "restore",
        vault: "restored",
        owner: payload.owner,
        accounts: restored.accounts.map(({ name, address }) => ({ name, address })),
        ...(restored.default === undefined ? {} : { default: restored.default }),
        protected: restored.protected,
        cloudBackup: "on",
        ...(restoredV2 === undefined
          ? {}
          : {
              agents: restoredV2.agents,
              swarms: restoredV2.swarms,
              movements: restoredV2.movements,
              skipped: restoredV2.skipped,
              conflicts: restoredV2.conflicts,
            }),
      },
      [
        `Vault restored with ${restored.accounts.length} account(s): ${restored.accounts.map(({ name }) => name).join(", ")}`,
        ...(restoredV2 === undefined
          ? []
          : [
              `Restored agents: ${restoredV2.agents.length === 0 ? "(none)" : restoredV2.agents.join(", ")}`,
              `Restored swarms: ${restoredV2.swarms.length === 0 ? "(none)" : restoredV2.swarms.join(", ")}`,
              ...restoredV2.movements.map(
                (movement) =>
                  `Unfinished movement ${movement.id} from ${movement.from}: vapi accounts distribute --resume ${movement.id}`,
              ),
              ...restoredV2.skipped.map(
                (item) => `Skipped ${item.kind} ${item.name}: ${item.reason}`,
              ),
              ...restoredV2.conflicts.map(
                (item) => `Conflict ${item.kind} ${item.name}: ${item.path}`,
              ),
            ]),
        "Cloud backups resume after vapi login links this device.",
      ].join("\n"),
    );
  } finally {
    stopWaiting();
    started.keyPair.privateKey.fill(0);
    started.keyPair.publicKey.fill(0);
    payload?.key.fill(0);
    vaultKey?.fill(0);
  }
}

export async function cloudBackupSetupChoice(
  json: boolean,
  io: CliIo,
  dependencies: CliDependencies,
): Promise<{ status: "on" | "off" | "skipped"; changed: boolean }> {
  const device = await currentDevice(dependencies);
  const state = await readCloudBackupState({
    secrets: getSecretStore(dependencies),
    device,
  });
  if (state.enabled) return { status: "on", changed: false };
  if (!isInteractive(dependencies)) return { status: "skipped", changed: false };

  const humanIo = json ? io.stderr : io.stdout;
  humanIo(
    "vAPI can keep an encrypted copy of this vault. Only your owner wallet can unlock it; vAPI cannot.",
  );
  const answer = await getLinePrompt(dependencies)("Turn on cloud backup? [Y/n] ");
  if (!isYes(answer, true)) return { status: "off", changed: false };
  await enrollCloudBackup(
    json,
    json ? { stdout: () => undefined, stderr: io.stderr } : io,
    dependencies,
  );
  return { status: "on", changed: true };
}

export async function autoUploadBackup(
  io: CliIo,
  json: boolean,
  dependencies: CliDependencies,
): Promise<void> {
  const timeoutMs = dependencies.cloudBackup?.uploadTimeoutMs ?? DEFAULT_UPLOAD_TIMEOUT_MS;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<UploadBackupResult>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ status: "skipped", reason: "timeout" });
    }, timeoutMs);
    timer.unref();
  });
  try {
    const result = await Promise.race([
      attemptAutoUploadBackup(io, dependencies, timeoutMs, controller.signal),
      timeout,
    ]);
    if (result === undefined) return;
    if (result.status === "uploaded") {
      if (result.omitted !== undefined) writeOmittedWarning(io, result.omitted);
      if (result.skipped !== undefined) writeSkippedWarnings(io, result.skipped);
      return;
    }
    writeUploadFailure(io, dependencies, uploadReason(result));
  } catch (error) {
    writeUploadFailure(
      io,
      dependencies,
      error instanceof Error && error.message.length > 0 ? error.message : "an unexpected error",
    );
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function attemptAutoUploadBackup(
  io: CliIo,
  dependencies: CliDependencies,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<UploadBackupResult | undefined> {
  const paths = getVapiPaths();
  const config = await readConfig(paths.config, { stdout: () => undefined, stderr: io.stderr });
  const device = deviceName({
    env: getEnvironment(dependencies),
    config,
    ...(dependencies.hostname === undefined ? {} : { hostname: dependencies.hostname() }),
  });
  const secrets = getSecretStore(dependencies);
  const state = await readCloudBackupState({ secrets, device });
  if (signal.aborted) return { status: "skipped", reason: "timeout" };
  if (!state.enabled) return undefined;

  const fetchImpl = dependencies.fetchImpl ?? createPublicFetch({ allowPrivateNetwork: false });
  return await (dependencies.cloudBackup?.uploadBackup ?? uploadBackup)({
    store: await openWalletStore(dependencies),
    secrets,
    device,
    apiBase: registryBaseUrl(config),
    networks: Object.keys(config.networks),
    env: getEnvironment(dependencies),
    fetchImpl,
    ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
    ...(dependencies.cloudBackup?.randomBytes === undefined
      ? {}
      : { randomBytes: dependencies.cloudBackup.randomBytes }),
    timeoutMs,
    signal,
    agentProfileSchema: registeredAgentProfileSchema,
  });
}

async function disableCloudBackup(
  json: boolean,
  io: CliIo,
  dependencies: CliDependencies,
): Promise<void> {
  const context = await cloudContext(io, dependencies);
  const removed = await forgetBackupKey({ secrets: context.secrets, device: context.device });
  await recordAudit(dependencies, "vault.cloud_backup_off", {
    detail: `device ${context.device}`,
  });
  const consoleUrl = cloudConsoleUrl(context.apiBase);
  output(
    io,
    json,
    { command: "backup", cloud: "off", device: context.device, removed },
    `Cloud backup uploads stopped; delete the stored copy in the console at ${consoleUrl}.`,
  );
}

async function cloudContext(io: CliIo, dependencies: CliDependencies) {
  const context = await cloudRestoreContext(io, dependencies);
  return {
    ...context,
    store: await openWalletStore(dependencies),
  };
}

async function cloudRestoreContext(io: CliIo, dependencies: CliDependencies) {
  const config = await readConfig(getVapiPaths().config, {
    stdout: () => undefined,
    stderr: io.stderr,
  });
  return {
    apiBase: registryBaseUrl(config),
    device: await currentDevice(dependencies),
    fetchImpl: dependencies.fetchImpl ?? createPublicFetch({ allowPrivateNetwork: false }),
    networks: Object.keys(config.networks),
    secrets: getSecretStore(dependencies),
  };
}

async function currentDevice(dependencies: CliDependencies): Promise<string> {
  return await ensureDeviceName({
    env: getEnvironment(dependencies),
    configPath: getVapiPaths().config,
    ...(dependencies.hostname === undefined ? {} : { hostname: dependencies.hostname() }),
  });
}

function linkedAccount(
  store: Awaited<ReturnType<typeof openWalletStore>>,
): { name: WalletName; owner: `0x${string}`; apiBase: string } | undefined {
  const names = [
    ...(store.defaultName === undefined ? [] : [store.defaultName]),
    ...store.names().filter((name) => name !== store.defaultName),
  ];
  for (const name of names) {
    const link = store.entry(name)?.link;
    if (link !== undefined) return { name, owner: link.owner, apiBase: link.apiBase };
  }
  return undefined;
}

async function hasDeviceNameClash(
  context: Awaited<ReturnType<typeof cloudContext>>,
  account: WalletName,
  apiBase: string,
  dependencies: CliDependencies,
): Promise<boolean> {
  let result: SiblingsResult;
  try {
    result = await (dependencies.cloudBackup?.fetchSiblings ?? fetchSiblings)({
      apiBase,
      account,
      secrets: context.secrets,
      wallets: context.store,
      fetchImpl: context.fetchImpl,
      timeoutMs: SIBLINGS_REQUEST_TIMEOUT_MS,
      ...(dependencies.now === undefined ? {} : { now: () => dependencies.now!().getTime() }),
    });
  } catch {
    return false;
  }
  const addresses = new Set<string>();
  for (const name of context.store.names()) {
    const address = await context.store.readAddress(name);
    if (address !== undefined) addresses.add(address.toLowerCase());
  }
  return result.siblings.some(
    (sibling) =>
      sibling.device === context.device &&
      !sibling.self &&
      !addresses.has(sibling.address.toLowerCase()),
  );
}

async function runUpload(
  context: Awaited<ReturnType<typeof cloudContext>>,
  dependencies: CliDependencies,
  account?: string,
): Promise<UploadBackupResult> {
  return await (dependencies.cloudBackup?.uploadBackup ?? uploadBackup)({
    store: context.store,
    secrets: context.secrets,
    device: context.device,
    apiBase: context.apiBase,
    ...(account === undefined ? {} : { account }),
    networks: context.networks,
    env: getEnvironment(dependencies),
    fetchImpl: context.fetchImpl,
    ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
    ...(dependencies.cloudBackup?.randomBytes === undefined
      ? {}
      : { randomBytes: dependencies.cloudBackup.randomBytes }),
    timeoutMs: dependencies.cloudBackup?.uploadTimeoutMs ?? DEFAULT_UPLOAD_TIMEOUT_MS,
    agentProfileSchema: registeredAgentProfileSchema,
  });
}

function openConsole(url: string, dependencies: CliDependencies): void {
  if (!isInteractive(dependencies)) return;
  if (activeAgentMarker(getEnvironment(dependencies)) !== undefined) return;
  (dependencies.openUrl ?? openInBrowser)(url);
}

function startWaiting(json: boolean, io: CliIo): () => void {
  if (json || !process.stderr.isTTY) {
    io.stderr("Waiting for the owner to approve…");
    return () => undefined;
  }
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let index = 0;
  const render = () => {
    process.stderr.write(`\r${frames[index++ % frames.length]} Waiting for the owner to approve…`);
  };
  render();
  const interval = setInterval(render, 80);
  interval.unref();
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    clearInterval(interval);
    process.stderr.write("\r\u001b[2K");
  };
}

async function newVaultPassword(io: CliIo, dependencies: CliDependencies): Promise<string> {
  const password = getEnvironment(dependencies).VAPI_VAULT_PASSWORD;
  if (password !== undefined) {
    if (password.length === 0) throw new Error("The vault password cannot be empty.");
    return password;
  }
  if (!isStdinInteractive(dependencies)) {
    throw new Error(
      "Restoring a protected vault needs a terminal to type the password, or VAPI_VAULT_PASSWORD.",
    );
  }
  const prompt = getPrompts(dependencies).secret;
  const entered = await prompt("New vault password: ");
  if (entered.length === 0) throw new Error("The vault password cannot be empty.");
  const repeated = await prompt("Repeat the vault password: ");
  if (entered !== repeated) throw new Error("The passwords do not match. Nothing changed.");
  void io;
  return entered;
}

function cloudConsoleUrl(apiBase: string): string {
  return `${apiBase.replace(/\/+$/u, "")}/agents`;
}

function deviceClashWarning(device: string): string {
  return `Device name "${device}" is already used on another device. Backups with the same name overwrite. Set VAPI_DEVICE or device in ~/.vapi/config.json to rename this device.`;
}

function isYes(answer: string, defaultYes: boolean): boolean {
  const normalized = answer.trim().toLowerCase();
  if (normalized === "") return defaultYes;
  return normalized === "y" || normalized === "yes";
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  return `${(bytes / 1_024).toFixed(1)} KB`;
}

function formatUploadTime(value: string): string {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return value;
  return `${parsed.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

function uploadReason(result: Extract<UploadBackupResult, { status: "skipped" }>): string {
  switch (result.reason) {
    case "no_backup_key":
      return "cloud backup is off";
    case "no_vault":
      return "there is no vault";
    case "vault_locked":
      return "the vault is locked";
    case "not_linked":
      return "link this device with vapi login";
    case "device_unknown":
      return "the account link has no device name";
    case "snapshot_busy":
      return "backup files changed while they were captured; retry the backup";
    case "rejected":
      return result.httpStatus === undefined
        ? "the backup was rejected"
        : `the backup was rejected with HTTP ${result.httpStatus}`;
    case "network":
      return "the network request failed";
    case "timeout":
      return "the upload timed out";
  }
}

function writeUploadFailure(io: CliIo, dependencies: CliDependencies, reason: string): void {
  const message = `Cloud backup not updated: ${reason}.`;
  const color = detectColorLevel({
    isTty: Boolean(process.stderr.isTTY),
    env: getEnvironment(dependencies),
  });
  io.stderr(color > 0 ? `\u001b[2m${message}\u001b[22m` : message);
}

function writeOmittedWarning(io: CliIo, omitted: readonly string[]): void {
  if (omitted.length === 0) return;
  io.stderr(`Cloud backup left out ${omitted.join(", ")}: they do not fit the 64 KB backup limit.`);
}

function writeSkippedWarnings(
  io: CliIo,
  skipped: NonNullable<Extract<UploadBackupResult, { status: "uploaded" }>["skipped"]>,
): void {
  for (const item of skipped) {
    io.stderr(`Cloud backup skipped ${item.kind} ${item.name}: ${item.reason}.`);
  }
}
