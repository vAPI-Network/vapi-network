import {
  BASE_MAINNET_CAIP2,
  DEFAULT_WALLET_NAME,
  KeystoreError,
  WalletStore,
  assertWalletName,
  changeKeystorePassphrase,
  enableDefaultNetwork,
  getVapiPaths,
  isSolanaNetwork,
  lockVault,
  readKeystoreVersion,
  readVaultFileUnlocked,
  validatePrivateKey,
  validateRecoveryPhrase,
  writeDefaultConfig,
  type WalletName,
} from "@vapi-network/core";
import {
  exportKeystoreKeys,
  exportRecoveryPhrase,
  exportVaultAccountKey,
  exportVaultPhrase,
} from "@vapi-network/core/secrets";
import { join } from "node:path";
import {
  ACCOUNT_OPTION,
  UsageError,
  WALLET_OPTION,
  parseArguments,
  parseInitNetworks,
} from "./args.js";
import { baseUsdcBalanceReader } from "./balance-reader.js";
import {
  getEnvironment,
  getPrompts,
  isInteractive,
  output,
  readConfig,
  type CliDependencies,
  type CliIo,
} from "./cli-context.js";
import { cloudBackupCommand } from "./cloud-backup.js";
import { fileExists } from "./platform.js";
import { formatRecoveryPhrase } from "./recovery-phrase.js";
import {
  SOLANA_VAULT_UNAVAILABLE,
  confirmWalletName,
  deviceVaultKey,
  getSecretStore,
  openWalletStore,
  outputForWallet,
  recordAudit,
  requireSecretsAllowed,
  selectWallet,
  targetWallet,
  walletHeader,
  walletPassphrase,
  withResolvedPassphrase,
  type WalletTarget,
} from "./wallet-session.js";

import {
  MAX_RESTORE_ACCOUNTS,
  protectVault,
  unlockProtectedVault,
  unprotectVault,
} from "@vapi-network/core";

import { isStdinInteractive } from "./cli-context.js";
import { restoreFromOwnerCommand } from "./cloud-backup.js";
import { restoreVaultFromPhrase } from "./setup.js";
import { collectStatus } from "./status.js";

const VAULT_USAGE = "Usage: vapi vault protect|unprotect|lock|unlock|status [--json]";
const RESTORE_USAGE =
  "Usage: vapi restore [--accounts <n> | --from-owner [--owner <0x…>]] [--json]";
const LEGACY_PASSWORD_NOTICE =
  "VAPI_KEYSTORE_PASSWORD is deprecated for vault passwords; use VAPI_VAULT_PASSWORD instead.";

export async function vaultCommand(
  argv: string[],
  json: boolean,
  io: CliIo,
  dependencies: CliDependencies,
): Promise<void> {
  const subcommand = argv[0];
  const rest = argv.slice(1);
  switch (subcommand) {
    case "protect":
      await protectCommand(rest, json, io, dependencies);
      return;
    case "unprotect":
      await unprotectCommand(rest, json, io, dependencies);
      return;
    case "lock":
      await vaultLockCommand(rest, json, io, dependencies);
      return;
    case "unlock":
      await vaultUnlockCommand(rest, json, io, dependencies);
      return;
    case "status":
      await vaultStatusCommand(rest, json, io, dependencies);
      return;
    default:
      throw new UsageError(VAULT_USAGE);
  }
}

export async function restoreCommand(
  argv: string[],
  json: boolean,
  io: CliIo,
  dependencies: CliDependencies,
): Promise<void> {
  if (argv.includes("--from-owner")) {
    await restoreFromOwnerCommand(argv, json, io, dependencies);
    return;
  }
  let parsed;
  try {
    parsed = parseArguments(argv, {
      valueOptions: new Set(["--accounts"]),
      maximumPositionals: 0,
    });
  } catch (error) {
    if (error instanceof UsageError) throw new UsageError(RESTORE_USAGE);
    throw error;
  }
  const accountCount = parseRestoreAccountCount(parsed.one("--accounts"));
  const paths = getVapiPaths();
  const path = join(paths.directory, "vault.json");
  if (await fileExists(path)) {
    throw new Error(
      `A vault already exists in ${paths.directory}. Move it aside before restoring.`,
    );
  }
  if (!(await fileExists(paths.config))) {
    await writeDefaultConfig(paths.config, process.env, { networks: ["base"] });
  }
  const config = await readConfig(paths.config, json ? quietIo(io) : io);
  const phrase = isStdinInteractive(dependencies)
    ? await getPrompts(dependencies).secret("Recovery phrase: ")
    : await (dependencies.readStdin ?? readProcessStdin)();
  const restoreIo = json ? quietIo(io) : io;
  const { names, scannedAddresses } = await restoreVaultFromPhrase(
    phrase.trim(),
    config,
    restoreIo,
    dependencies,
    accountCount,
  );
  if (json) {
    output(
      io,
      true,
      { command: "restore", vault: "restored", accounts: names, scannedAddresses },
      "",
    );
    return;
  }
  io.stdout(`Run vapi setup to link ${names[0]}.`);
}

function parseRestoreAccountCount(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/u.test(value)) {
    throw new UsageError(
      `--accounts must be a positive integer no greater than ${MAX_RESTORE_ACCOUNTS}.`,
    );
  }
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 1 || count > MAX_RESTORE_ACCOUNTS) {
    throw new UsageError(
      `--accounts must be a positive integer no greater than ${MAX_RESTORE_ACCOUNTS}.`,
    );
  }
  return count;
}

async function protectCommand(
  argv: string[],
  json: boolean,
  io: CliIo,
  dependencies: CliDependencies,
): Promise<void> {
  requireNoArguments(argv);
  const env = getEnvironment(dependencies);
  let password = passwordFromEnvironment(io, dependencies);
  if (password === undefined) {
    requirePasswordTerminal("protect", dependencies);
    const prompts = getPrompts(dependencies);
    password = await prompts.secret("New vault password: ");
    if (password.length === 0) throw new Error("The vault password cannot be empty.");
    const repeated = await prompts.secret("Repeat the vault password: ");
    if (password !== repeated) throw new Error("The passwords do not match. Nothing changed.");
  } else if (password.length === 0) {
    throw new Error("The vault password cannot be empty.");
  }

  await protectVault({ path: vaultPath(), secrets: getSecretStore(dependencies), password, env });
  await recordAudit(dependencies, "vault.protect");
  output(
    io,
    json,
    { command: "vault protect", protected: true },
    "The vault is now password protected and locked. Run vapi vault unlock to use it for 8 hours.",
  );
}

async function unprotectCommand(
  argv: string[],
  json: boolean,
  io: CliIo,
  dependencies: CliDependencies,
): Promise<void> {
  requireNoArguments(argv);
  const env = getEnvironment(dependencies);
  const password = await vaultPassword("unprotect", "Vault password: ", io, dependencies);
  await unprotectVault({ path: vaultPath(), secrets: getSecretStore(dependencies), password, env });
  await recordAudit(dependencies, "vault.unprotect");
  output(
    io,
    json,
    { command: "vault unprotect", protected: false },
    "The vault is no longer password protected.",
  );
}

async function vaultLockCommand(
  argv: string[],
  json: boolean,
  io: CliIo,
  dependencies: CliDependencies,
): Promise<void> {
  requireNoArguments(argv);
  const locked = await lockVault({ secrets: getSecretStore(dependencies) });
  if (locked) {
    await recordAudit(dependencies, "wallet.lock", { detail: "protected vault session" });
  }
  output(
    io,
    json,
    { command: "vault lock", locked },
    locked ? "Locked the vault." : "The vault has no open session to lock.",
  );
}

async function vaultUnlockCommand(
  argv: string[],
  json: boolean,
  io: CliIo,
  dependencies: CliDependencies,
): Promise<void> {
  requireNoArguments(argv);
  const path = vaultPath();
  if (!(await readVaultFileUnlocked(path)).protected) {
    output(
      io,
      json,
      { command: "vault unlock", unlocked: true, protected: false },
      "The vault is not password protected; nothing to unlock.",
    );
    return;
  }

  const env = getEnvironment(dependencies);
  const password = await vaultPassword("unlock", "Vault password: ", io, dependencies);
  let key: Uint8Array | undefined;
  try {
    key = await unlockProtectedVault({
      path,
      secrets: getSecretStore(dependencies),
      password,
      env,
      ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
    });
    await recordAudit(dependencies, "wallet.unlock", { detail: "protected vault session" });
    output(
      io,
      json,
      { command: "vault unlock", unlocked: true, protected: true, sessionHours: 8 },
      "Vault open on this device for 8 hours. Lock it early with vapi vault lock.",
    );
  } finally {
    key?.fill(0);
  }
}

async function vaultStatusCommand(
  argv: string[],
  json: boolean,
  io: CliIo,
  dependencies: CliDependencies,
): Promise<void> {
  requireNoArguments(argv);
  const vault = (await collectStatus(dependencies)).vault;
  const state = !vault.exists
    ? "none. Run vapi setup."
    : vault.unlocked
      ? `unlocked on this device (${vault.store})`
      : vault.protected
        ? `protected, locked (${vault.store})`
        : `locked (${vault.store})`;
  output(io, json, { command: "vault status", ...vault }, `Vault: ${state}`);
}

async function vaultPassword(
  command: "unprotect" | "unlock",
  prompt: string,
  io: CliIo,
  dependencies: CliDependencies,
): Promise<string> {
  const password = passwordFromEnvironment(io, dependencies);
  if (password !== undefined) return password;
  requirePasswordTerminal(command, dependencies);
  return await getPrompts(dependencies).secret(prompt);
}

function passwordFromEnvironment(io: CliIo, dependencies: CliDependencies): string | undefined {
  const env = getEnvironment(dependencies);
  if (env.VAPI_VAULT_PASSWORD !== undefined) return env.VAPI_VAULT_PASSWORD;
  if (env.VAPI_KEYSTORE_PASSWORD === undefined) return undefined;
  io.stderr(LEGACY_PASSWORD_NOTICE);
  return env.VAPI_KEYSTORE_PASSWORD;
}

function requirePasswordTerminal(
  command: "protect" | "unprotect" | "unlock",
  dependencies: CliDependencies,
): void {
  if (isStdinInteractive(dependencies)) return;
  throw new Error(
    `vapi vault ${command} needs a terminal to type the password, or VAPI_VAULT_PASSWORD.`,
  );
}

function requireNoArguments(argv: string[]): void {
  parseArguments(argv, { valueOptions: new Set(), maximumPositionals: 0 });
}

function vaultPath(): string {
  return join(getVapiPaths().directory, "vault.json");
}

function quietIo(io: CliIo): CliIo {
  return { stdout: () => undefined, stderr: io.stderr };
}

async function readProcessStdin(): Promise<string> {
  process.stdin.setEncoding("utf8");
  let input = "";
  for await (const chunk of process.stdin) input += String(chunk);
  return input;
}

const EXPORT_KEY_WARNING =
  "Anyone with this key can spend the wallet. Never paste it into a website or chat.";

/**
 * Prints the private key of one wallet, to a person, on a terminal. The agent
 * gate runs before the passphrase is read, and the person types the wallet name
 * first, so a key never appears because a tool call asked for it.
 */
export async function exportKeyCommand(
  argv: string[],
  json: boolean,
  io: CliIo,
  dependencies: CliDependencies,
): Promise<void> {
  const parsed = parseArguments(argv, {
    valueOptions: new Set(["--network", WALLET_OPTION]),
    maximumPositionals: 0,
  });
  const network = parsed.one("--network") ?? BASE_MAINNET_CAIP2;
  const solana = isSolanaNetwork(network);
  if (!solana && !network.startsWith("eip155:")) {
    throw new UsageError("--network must be an eip155:<chainId> or Solana network identifier.");
  }
  const target = await targetWallet(parsed, dependencies);
  const vaultAccount = await target.store.hasVaultAccount(target.name);
  if (vaultAccount && solana) throw new UsageError(SOLANA_VAULT_UNAVAILABLE);
  await requireSecretsAllowed(dependencies, "secret.export.key", target.name);
  await confirmWalletName(
    target.name,
    `Type ${target.name} to print its private key: `,
    "That is not the wallet name. Nothing was printed.",
    dependencies,
  );
  let address: string;
  let privateKey: string;
  if (vaultAccount) {
    const { path, key } = await deviceVaultKey(target.store, dependencies);
    try {
      address = target.address ?? (await target.store.readAddress(target.name)) ?? "";
      privateKey = await exportVaultAccountKey({ path, key, name: target.name });
    } finally {
      key.fill(0);
    }
  } else {
    const resolved = await walletPassphrase(target, dependencies);
    const keys = await withResolvedPassphrase(resolved, target, dependencies, (passphrase) =>
      exportKeystoreKeys(passphrase, target.path),
    );
    if (solana && !keys.solana) {
      throw new Error(
        `No Solana key is enabled in ${target.path}. Run vapi accounts --enable solana first.`,
      );
    }
    const selected = solana && keys.solana ? keys.solana : keys.evm;
    address = selected.address;
    privateKey = "secretKey" in selected ? selected.secretKey : selected.privateKey;
  }
  const result = {
    network,
    address,
    privateKey,
  };
  await recordAudit(dependencies, "secret.export.key", { wallet: target.name, detail: network });
  io.stderr(EXPORT_KEY_WARNING);
  if (json) {
    io.stdout(JSON.stringify({ wallet: target.name, ...result }));
    return;
  }
  io.stdout(walletHeader(target));
  io.stdout(result.privateKey);
}

const BACKUP_WARNING =
  "Anyone with these words can spend the wallet. Never type them into a website or chat.";

/**
 * Prints the recovery phrase of one wallet, to a person, on a terminal. The
 * same gate and the same typed confirmation as `vapi export-key`.
 */
export async function backupCommand(
  argv: string[],
  json: boolean,
  io: CliIo,
  dependencies: CliDependencies,
): Promise<void> {
  if (argv.includes("--cloud")) {
    await cloudBackupCommand(argv, json, io, dependencies);
    return;
  }
  const parsed = parseArguments(argv, {
    valueOptions: new Set([WALLET_OPTION]),
    maximumPositionals: 0,
  });
  if (!isInteractive(dependencies)) {
    await recordAudit(dependencies, "secret.export.phrase", {
      detail: "refused: not a terminal",
    });
    throw new KeystoreError(
      "vapi backup prints your recovery phrase and only works in a terminal.",
    );
  }
  const target = await targetWallet(parsed, dependencies);
  const vaultAccount = await target.store.hasVaultAccount(target.name);
  if (vaultAccount) {
    const vault = await readVaultFileUnlocked(join(target.store.home, "vault.json"));
    if (
      vault.accounts.some((account) => account.name === target.name && account.kind === "imported")
    ) {
      throw new KeystoreError(
        `Account ${target.name} was imported and is not recoverable from the vault phrase. Back it up with vapi export-key --account ${target.name}.`,
      );
    }
  }
  await requireSecretsAllowed(dependencies, "secret.export.phrase", target.name);
  await confirmWalletName(
    target.name,
    `Type ${target.name} to print its recovery phrase: `,
    "That is not the wallet name. Nothing was printed.",
    dependencies,
  );
  io.stderr(BACKUP_WARNING);
  let recoveryPhrase: string;
  if (vaultAccount) {
    const { path, key } = await deviceVaultKey(target.store, dependencies);
    try {
      recoveryPhrase = await exportVaultPhrase({ path, key });
    } finally {
      key.fill(0);
    }
  } else {
    const resolved = await walletPassphrase(target, dependencies);
    try {
      recoveryPhrase = await withResolvedPassphrase(resolved, target, dependencies, (passphrase) =>
        exportRecoveryPhrase(passphrase, target.path),
      );
    } catch (error) {
      const version = await readKeystoreVersion(target.path);
      if (version === undefined || version === 3) throw error;
      throw new Error(
        [
          error instanceof Error ? error.message : String(error),
          `Back up ${target.path} together with the passphrase that opens it, or print the key itself with vapi export-key.`,
        ].join("\n"),
      );
    }
  }
  await recordAudit(dependencies, vaultAccount ? "vault.backup_shown" : "secret.export.phrase", {
    wallet: target.name,
  });
  if (json) {
    io.stdout(JSON.stringify({ wallet: target.name, recoveryPhrase }));
    return;
  }
  io.stdout(walletHeader(target));
  io.stdout(formatRecoveryPhrase(recoveryPhrase));
}

/**
 * Restores a wallet from words or a private key the person types in. The secret
 * never comes from argv, where a shell history would keep it, and an existing
 * wallet is moved to the trash rather than overwritten.
 */
export async function importCommand(
  argv: string[],
  json: boolean,
  io: CliIo,
  dependencies: CliDependencies,
): Promise<void> {
  const parsed = parseArguments(argv, {
    valueOptions: new Set(["--networks", WALLET_OPTION]),
    booleanOptions: new Set(["--phrase", "--key", "--replace", "--force"]),
    maximumPositionals: 24,
  });
  if (parsed.positionals.length > 0) {
    throw new UsageError(
      "vapi import reads the secret from a prompt. Never pass a recovery phrase or a private key as an argument.",
    );
  }
  const fromPhrase = parsed.has("--phrase");
  if (fromPhrase === parsed.has("--key")) {
    throw new UsageError("vapi import needs exactly one of --phrase or --key.");
  }
  const networks = parseInitNetworks(parsed.one("--networks") ?? "base");
  if (networks.includes("solana")) throw new UsageError(SOLANA_VAULT_UNAVAILABLE);
  const enableArc = networks.includes("arc");

  const paths = getVapiPaths();
  const store = await openWalletStore(dependencies);
  const name = importWalletName(store, parsed, dependencies);
  const existed = store.has(name);
  if (existed && !parsed.has("--replace")) {
    const address = await store.readAddress(name);
    const location = (await store.hasVaultAccount(name))
      ? join(store.home, "vault.json")
      : store.pathFor(name);
    throw new Error(
      [
        `Wallet ${name} already exists at ${location}.`,
        ...(address ? [`Address: ${address}`] : []),
        "Write its recovery phrase down with vapi backup first, then re-run with --replace.",
      ].join("\n"),
    );
  }

  const prompts = getPrompts(dependencies);
  const secret = fromPhrase
    ? validateRecoveryPhrase(await prompts.secret("Recovery phrase: "))
    : validatePrivateKey(await prompts.secret("Private key: "));
  // Only now, with the secret in hand, is the existing wallet moved: a failed
  // prompt must never leave the machine without the wallet it had.
  let previousKeystore: string | undefined;
  if (existed) {
    const config = await readConfig(paths.config, io);
    const trashed = await store.remove(name, {
      force: parsed.has("--force"),
      balanceReader: baseUsdcBalanceReader(config, dependencies),
      allowDefault: true,
    });
    await recordAudit(dependencies, "wallet.remove", {
      wallet: trashed.name,
      detail: "replaced by vapi import",
    });
    previousKeystore = trashed.path;
  }
  const imported = fromPhrase
    ? await store.create(name, "", { phrase: secret })
    : await store.importKey(name, "", secret);
  await recordAudit(dependencies, "wallet.import", { wallet: imported.name });
  const account = imported.account;

  if (!(await fileExists(paths.config))) {
    await writeDefaultConfig(paths.config, process.env, { networks });
  } else {
    if (enableArc) await enableDefaultNetwork("arc", paths.config);
  }
  const result = {
    address: account.address,
    ...(account.solana ? { solanaAddress: account.solana.address } : {}),
    vault: join(paths.directory, "vault.json"),
    ...(previousKeystore ? { previousKeystore } : {}),
    message: "Wallet imported. Its encrypted key stays on this machine.",
  };
  outputForWallet(
    io,
    json,
    { name: imported.name, address: account.address },
    result,
    [
      result.message,
      `Address: ${result.address}`,
      ...(account.solana ? [`Solana address: ${account.solana.address}`] : []),
      `Vault: ${result.vault}`,
      ...(previousKeystore ? [`Previous keystore moved to ${previousKeystore}`] : []),
    ].join("\n"),
  );
}

/**
 * `main` only on a machine that has no wallet yet. Once one exists, an import
 * has to say which wallet it is writing, so it can never quietly land on top of
 * the one that holds the money.
 */
function importWalletName(
  store: WalletStore,
  parsed: { one(name: string): string | undefined },
  dependencies: CliDependencies,
): WalletName {
  const requested =
    parsed.one(WALLET_OPTION)?.trim() || getEnvironment(dependencies).VAPI_WALLET?.trim();
  if (requested !== undefined && requested.length > 0) return assertWalletName(requested);
  if (store.names().length === 0) return DEFAULT_WALLET_NAME;
  throw new Error(
    [
      `This machine already has ${store.names().sort().join(", ")}.`,
      "Name the wallet to import with vapi import --account <name>.",
    ].join("\n"),
  );
}

/** Re-encrypts the same wallet under a new passphrase; the addresses stay. */
export async function passphraseCommand(
  argv: string[],
  json: boolean,
  io: CliIo,
  dependencies: CliDependencies,
): Promise<void> {
  const parsed = parseArguments(argv, {
    valueOptions: new Set([WALLET_OPTION]),
    maximumPositionals: 0,
  });
  const target = await targetWallet(parsed, dependencies);
  if (await target.store.hasVaultAccount(target.name)) {
    throw new KeystoreError(
      "Vault accounts have no passphrase. Protect the whole vault instead with vapi vault protect.",
    );
  }
  const prompts = getPrompts(dependencies);
  const resolved = await walletPassphrase(target, dependencies);
  const current = resolved.passphrase;
  const next = await prompts.secret("New passphrase: ");
  if (next.length === 0) throw new KeystoreError("Keystore passphrase cannot be empty.");
  if (next === current) {
    throw new KeystoreError("The new passphrase must differ from the current one.");
  }
  if ((await prompts.secret("Confirm new passphrase: ")) !== next) {
    throw new KeystoreError("Passphrases do not match.");
  }
  const account = await withResolvedPassphrase(resolved, target, dependencies, (passphrase) =>
    changeKeystorePassphrase(passphrase, next, target.path),
  );
  await recordAudit(dependencies, "passphrase.change", { wallet: target.name });
  await retireStoredPassphrase(target, dependencies, io);
  if (process.env.VAPI_KEYSTORE_PASSWORD !== undefined) {
    io.stderr(
      "VAPI_KEYSTORE_PASSWORD still holds the old passphrase. Update it before the next run.",
    );
  }
  const result = {
    address: account.address,
    ...(account.solana ? { solanaAddress: account.solana.address } : {}),
    keystore: target.path,
    message: "Passphrase changed. The wallet and its addresses are unchanged.",
  };
  outputForWallet(
    io,
    json,
    target,
    result,
    [result.message, `Address: ${result.address}`, `Keystore: ${target.path}`].join("\n"),
  );
}

const UNLOCK_NEEDS_TERMINAL =
  "Type the passphrase yourself in a terminal; an agent must never be handed one.";

/**
 * Hands one wallet's passphrase to the OS secret store, so an agent can pay
 * from it without the passphrase sitting in an editor's configuration file.
 * The passphrase is typed by a person, on a terminal, and is verified against
 * the keystore before anything is stored: a typo must not be kept.
 */
export async function unlockCommand(
  argv: string[],
  json: boolean,
  io: CliIo,
  dependencies: CliDependencies,
): Promise<void> {
  const parsed = parseArguments(argv, {
    valueOptions: new Set([WALLET_OPTION]),
    maximumPositionals: 0,
  });
  const target = await targetWallet(parsed, dependencies);
  if (await target.store.hasVaultAccount(target.name)) {
    const message = `${target.name} lives in the device vault, which the OS secret store opens; nothing to unlock.`;
    output(io, json, { wallet: target.name, unlocked: true, message }, message);
    return;
  }
  await requireSecretsAllowed(dependencies, "wallet.unlock", target.name, {
    refusal: UNLOCK_NEEDS_TERMINAL,
  });
  const store = getSecretStore(dependencies);
  if (!store.available) {
    throw new KeystoreError(NO_SECRET_STORE);
  }

  const passphrase = await getPrompts(dependencies).secret(`Passphrase for ${target.name}: `);
  if (passphrase.length === 0) throw new KeystoreError("Keystore passphrase cannot be empty.");
  try {
    await target.store.unlock(target.name, passphrase);
  } catch (error) {
    await recordAudit(dependencies, "wallet.unlock", {
      wallet: target.name,
      detail: "refused: the passphrase did not open the wallet",
    });
    throw error;
  }
  await store.set(target.name, passphrase);
  await recordAudit(dependencies, "wallet.unlock", {
    wallet: target.name,
    detail: store.description,
  });
  const message = `Wallet ${target.name} is unlocked for agents. Its passphrase is in ${store.description}.`;
  outputForWallet(
    io,
    json,
    target,
    { unlocked: true, store: store.description, message },
    [
      message,
      `Drop VAPI_KEYSTORE_PASSWORD from your MCP configuration; take the passphrase back out with vapi lock --account ${target.name}.`,
    ].join("\n"),
  );
}

/**
 * Takes a passphrase back out of the OS secret store. Nothing about the wallet
 * changes: the keystore, its addresses and its passphrase are untouched, and
 * the next run asks for the passphrase again.
 */
export async function lockCommand(
  argv: string[],
  json: boolean,
  io: CliIo,
  dependencies: CliDependencies,
): Promise<void> {
  const parsed = parseArguments(argv, {
    valueOptions: new Set([WALLET_OPTION]),
    booleanOptions: new Set([ALL_WALLETS_FLAG]),
    maximumPositionals: 0,
  });
  const all = parsed.has(ALL_WALLETS_FLAG);
  if (all && parsed.one(WALLET_OPTION) !== undefined) {
    throw new UsageError(`${ACCOUNT_OPTION} and ${ALL_WALLETS_FLAG} cannot be used together.`);
  }
  const walletStore = await openWalletStore(dependencies);
  const target = all ? undefined : await selectWallet(walletStore, parsed, dependencies);
  const store = getSecretStore(dependencies);
  if (!store.available) {
    throw new KeystoreError(NO_SECRET_STORE);
  }
  if (target && (await walletStore.hasVaultAccount(target.name))) {
    const vaultLocked = await lockVault({ secrets: store });
    if (vaultLocked) {
      await recordAudit(dependencies, "wallet.lock", {
        wallet: target.name,
        detail: "protected vault session",
      });
    }
    const message = vaultLocked
      ? "Locked the protected device vault."
      : `${target.name} lives in the device vault, which has no active protected session to lock.`;
    output(io, json, { wallet: target.name, locked: [], vaultLocked, message }, message);
    return;
  }
  const names = target ? [target.name] : walletStore.names();
  const hasVaultAccounts = (
    await Promise.all(names.map(async (name) => await walletStore.hasVaultAccount(name)))
  ).some(Boolean);
  const vaultLocked = all && hasVaultAccounts ? await lockVault({ secrets: store }) : false;
  if (vaultLocked) {
    await recordAudit(dependencies, "wallet.lock", { detail: "protected vault session" });
  }

  const locked: string[] = [];
  for (const name of names) {
    if (await walletStore.hasVaultAccount(name)) continue;
    if (!(await store.remove(name))) continue;
    locked.push(name);
    await recordAudit(dependencies, "wallet.lock", { wallet: name, detail: store.description });
  }

  const message =
    vaultLocked && locked.length === 0
      ? "Locked the protected device vault."
      : locked.length === 0
        ? `No passphrase was stored in ${store.description}${target ? ` for ${target.name}` : ""}.`
        : `${vaultLocked ? "Locked the protected device vault. " : ""}Locked ${locked.join(", ")}. ${locked.length === 1 ? "Its passphrase is" : "Their passphrases are"} no longer in ${store.description}.`;
  if (target) {
    outputForWallet(io, json, target, { locked, store: store.description, message }, message);
    return;
  }
  output(
    io,
    json,
    { wallet: null, locked, vaultLocked, store: store.description, message },
    message,
  );
}

/** Every wallet on the machine, for `vapi lock`. */
const ALL_WALLETS_FLAG = "--all";

const NO_SECRET_STORE = "No OS secret store on this platform yet; use VAPI_KEYSTORE_PASSWORD.";

/**
 * A new passphrase makes the stored copy wrong, so `vapi passphrase` retires
 * it. An entry that no longer opens its wallet is the one failure an agent
 * cannot do anything about.
 */
async function retireStoredPassphrase(
  target: WalletTarget,
  dependencies: CliDependencies,
  io: CliIo,
): Promise<void> {
  const store = getSecretStore(dependencies);
  if (!store.available) return;
  let removed: boolean;
  try {
    removed = await store.remove(target.name);
  } catch {
    // A keyring that will not answer is not a reason to fail a passphrase
    // change that already succeeded.
    return;
  }
  if (!removed) return;
  await recordAudit(dependencies, "wallet.lock", {
    wallet: target.name,
    detail: "passphrase changed",
  });
  io.stderr(
    `The old passphrase was removed from ${store.description}. Run vapi unlock --account ${target.name} to store the new one.`,
  );
}
