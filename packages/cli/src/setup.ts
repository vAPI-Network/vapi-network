import { rm } from "node:fs/promises";
import { join } from "node:path";

import {
  DEFAULT_WALLET_NAME,
  getVapiPaths,
  loadOrCreateDeviceKey,
  promptForSecret,
  restoreVault,
  validateRecoveryPhrase,
  WalletStore,
  writeDefaultConfig,
  type VapiConfig,
} from "@vapi-network/core";

import {
  CUSTODY_NOTICE,
  UsageError,
  baseUsdcBalanceReader,
  fileExists,
  getSecretStore,
  isInteractive,
  openWalletStore,
  parseArguments,
  promptForLine,
  readConfig,
  recordAudit,
  showRecoveryPhrase,
  type CliDependencies,
  type CliIo,
} from "./cli.js";
import { cloudBackupSetupChoice } from "./cloud-backup.js";
import { runLoginFlow } from "./login.js";
import { collectStatus, renderStatusScreen } from "./status.js";

const SETUP_ARGUMENT_ERROR =
  "vapi setup accepts only --no-cloud-backup; a recovery phrase is typed at the prompt, never passed on the command line.";
const VAULT_CHOICE = "Create a new vault, or restore one from a recovery phrase? [new/restore] ";

type SetupResult = {
  vault: "created" | "restored" | "existing";
  account: string;
  address: string;
  linked: boolean;
  steps: string[];
  cloudBackup: "on" | "off" | "skipped";
};

export async function setupCommand(
  argv: string[],
  json: boolean,
  io: CliIo,
  dependencies: CliDependencies,
): Promise<void> {
  let parsed;
  try {
    parsed = parseArguments(argv, {
      valueOptions: new Set(),
      booleanOptions: new Set(["--no-cloud-backup"]),
      maximumPositionals: 0,
    });
  } catch (error) {
    if (error instanceof UsageError) throw new UsageError(SETUP_ARGUMENT_ERROR);
    throw error;
  }

  const paths = getVapiPaths();
  const steps: string[] = [];
  const humanIo = json ? stderrIo(io) : io;

  if (!(await fileExists(paths.config))) {
    await writeDefaultConfig(paths.config, process.env, { networks: ["base"] });
    steps.push("config");
  }
  const config = await readConfig(paths.config, humanIo);
  let store = await openWalletStore(dependencies);
  let vault: SetupResult["vault"] = "existing";
  let changedVault = false;
  let changedAccount = false;
  let changedLink = false;

  if (!(await fileExists(join(paths.directory, "vault.json")))) {
    const choice = await vaultChoice(dependencies);
    if (choice === "restore") {
      if (!isInteractive(dependencies)) {
        throw new Error("Restoring needs a terminal to type the phrase.");
      }
      const readSecret = dependencies.prompts?.secret ?? promptForSecret;
      await restoreVaultFromPhrase(
        await readSecret("Recovery phrase: "),
        config,
        humanIo,
        dependencies,
      );
      store = await WalletStore.open(paths.directory, {
        secrets: getSecretStore(dependencies),
        env: dependencies.env ?? process.env,
        ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
      });
      vault = "restored";
    } else {
      humanIo.stdout(CUSTODY_NOTICE);
      const created = await store.create(DEFAULT_WALLET_NAME, "");
      await showRecoveryPhrase(created.recoveryPhrase, humanIo, dependencies);
      await recordAudit(dependencies, "wallet.create", { wallet: created.name });
      vault = "created";
    }
    changedVault = true;
    steps.push("vault");
  }

  if (store.names().length === 0) {
    const created = await store.create(DEFAULT_WALLET_NAME, "");
    await recordAudit(dependencies, "wallet.create", { wallet: created.name });
    humanIo.stdout(`Account ${created.name} derived: ${created.account.address}`);
    changedAccount = true;
    steps.push("account");
  }

  const account = store.defaultName ?? store.names()[0];
  if (account === undefined) throw new Error("Setup did not create an account.");
  const address = await store.readAddress(account);
  if (address === undefined) throw new Error(`Setup could not read the address for ${account}.`);

  if (store.entry(account)?.link === undefined) {
    await runLoginFlow(
      ["--account", account, "--label", account],
      json,
      json ? { stdout: () => undefined, stderr: io.stderr } : io,
      dependencies,
    );
    await store.reload();
    changedLink = true;
    steps.push("link");
  }

  const linked = store.entry(account)?.link !== undefined;
  const cloudBackupChoice = parsed.has("--no-cloud-backup")
    ? { status: "skipped" as const, changed: false }
    : await cloudBackupSetupChoice(json, io, dependencies);
  const cloudBackup = cloudBackupChoice.status;
  const changedCloudBackup = cloudBackupChoice.changed;
  if (!changedVault && !changedAccount && !changedLink && !changedCloudBackup) {
    humanIo.stdout("Nothing to do.");
    for (const line of renderStatusScreen(await collectStatus(dependencies))) humanIo.stdout(line);
  } else {
    humanIo.stdout(
      `Fund ${account}: send USDC on Base to ${address} (or run vapi fund --account ${account}).`,
    );
  }

  if (json) {
    io.stdout(
      JSON.stringify({ vault, account, address, linked, steps, cloudBackup } satisfies SetupResult),
    );
  }
}

export async function restoreVaultFromPhrase(
  phrase: string,
  config: VapiConfig,
  io: CliIo,
  dependencies: CliDependencies,
): Promise<{ names: string[] }> {
  const paths = getVapiPaths();
  const validatedPhrase = validateRecoveryPhrase(phrase);
  const readBalance = baseUsdcBalanceReader(config, dependencies);
  const key = await loadOrCreateDeviceKey({ secrets: getSecretStore(dependencies) });
  let names: string[];
  try {
    const restored = await restoreVault({
      path: join(paths.directory, "vault.json"),
      key,
      phrase: validatedPhrase,
      probe: async (address) => (await readBalance(address)) > 0n,
      ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
    });
    names = restored.accounts().map((account) => account.name);
    await rm(join(paths.directory, "wallets.json"), { force: true });
  } finally {
    key.fill(0);
  }
  await recordAudit(dependencies, "vault.restore", {
    ...(names[0] === undefined ? {} : { wallet: names[0] }),
    detail: `${names.length} account(s)`,
  });
  io.stdout(`Vault restored with ${names.length} account(s): ${names.join(", ")}`);
  return { names };
}

async function vaultChoice(dependencies: CliDependencies): Promise<"new" | "restore"> {
  const answer =
    dependencies.prompts?.line === undefined
      ? isInteractive(dependencies)
        ? await promptForLine(VAULT_CHOICE)
        : ""
      : await dependencies.prompts.line(VAULT_CHOICE);
  const normalized = answer.trim().toLowerCase();
  if (normalized === "" || normalized === "new") return "new";
  if (normalized === "restore") return "restore";
  throw new UsageError("Choose new or restore.");
}

function stderrIo(io: CliIo): CliIo {
  return { stdout: io.stderr, stderr: io.stderr };
}
