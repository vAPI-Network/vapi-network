import { join } from "node:path";

import {
  getVapiPaths,
  lockVault,
  protectVault,
  readVaultFileUnlocked,
  unlockProtectedVault,
  unprotectVault,
  writeDefaultConfig,
} from "@vapi-network/core";

import {
  UsageError,
  fileExists,
  getEnvironment,
  getPrompts,
  getSecretStore,
  isStdinInteractive,
  output,
  parseArguments,
  readConfig,
  recordAudit,
  type CliDependencies,
  type CliIo,
} from "./cli.js";
import { restoreFromOwnerCommand } from "./cloud-backup.js";
import { restoreVaultFromPhrase } from "./setup.js";
import { collectStatus } from "./status.js";

const VAULT_USAGE = "Usage: vapi vault protect|unprotect|lock|unlock|status [--json]";
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
  if (argv.length > 0) {
    throw new UsageError("Usage: vapi restore [--from-owner [--owner <0x…>]] [--json]");
  }
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
  const { names } = await restoreVaultFromPhrase(phrase.trim(), config, restoreIo, dependencies);
  if (json) {
    output(io, true, { command: "restore", vault: "restored", accounts: names }, "");
    return;
  }
  io.stdout(`Run vapi setup to link ${names[0]}.`);
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
