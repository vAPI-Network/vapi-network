import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import {
  assertWalletName,
  cancelMovement,
  ceilingCapsJson,
  createPublicFetch,
  createAccount,
  distributeBetweenAccounts,
  DistributeError,
  enableDefaultNetwork,
  fetchSiblings,
  formatUsdAmount,
  formatUsdc,
  getDefaultConfig,
  getVapiPaths,
  isMissingFile,
  KeystoreError,
  listAccounts,
  loadConfig,
  promptForSecret,
  readMovement,
  usdToAtomic,
  validatePrivateKey,
  type AccountInfo,
  type DistributeResult,
  type Movement,
  type Sibling,
  type SpendCaps,
  type StatusAccount,
} from "@vapi-network/core";
import { renameAgentLinkWallet } from "@vapi-network/core/agent-link";
import { exportKeystoreKeys } from "@vapi-network/core/secrets";

import {
  UsageError,
  baseUsdcBalanceReader,
  confirmWalletName,
  getSecretStore,
  getEnvironment,
  isInteractive,
  openWalletStore,
  parseArguments,
  recordAudit,
  registryBaseUrl,
  requiredPositional,
  targetWallet,
  unlockTarget,
  type CliDependencies,
  type CliIo,
} from "./cli.js";
import { runLoginFlow } from "./login.js";
import { accountNameWidth, collectStatus, formatAccountLine } from "./status.js";

const ACCOUNT_OPTION = "--account";
const WALLET_OPTION = "--wallet";
const ACCOUNTS_USAGE =
  "Usage: vapi accounts [list|add|import|rename|use|remove|restore|caps|distribute] …";
const ADD_USAGE = "Usage: vapi accounts add <name> [--label <text>] [--no-link] [--json]";
const IMPORT_USAGE =
  "Usage: vapi accounts import <name> [--keystore <path> | --key-file <path>] [--label <text>] [--json]";
const PRIVATE_KEY_ARGV_REFUSAL =
  "Private keys never go in argv. Use the private-key prompt, --key-file, or --keystore.";
const LEGACY_NOTICE = "vapi accounts --enable is a legacy form and will move in a later release.";
const SOLANA_VAULT_UNAVAILABLE = "Solana keys are not part of the device vault yet.";
const REMOVE_NEEDS_TERMINAL =
  "Removing an account needs a terminal, so a person can type its name. Run vapi accounts remove yourself, or pass --force.";
const SIBLINGS_LOGIN_HINT = "Link an account to see accounts on other devices: vapi login";
// Covers the lock wait, one token refresh and the request together.
const SIBLINGS_REQUEST_TIMEOUT_MS = 8_000;

export async function accountsCommand(
  argv: string[],
  json: boolean,
  io: CliIo,
  dependencies: CliDependencies,
): Promise<number> {
  if (isLegacyAccountsInvocation(argv)) {
    io.stderr(LEGACY_NOTICE);
    await networkAccountsCommand(argv, json, io, dependencies);
    return 0;
  }

  if (argv[0] === "--all") {
    await accountsListCommand(argv, json, io, dependencies);
    return 0;
  }

  const subcommand = argv[0];
  const rest = argv.slice(1);
  switch (subcommand) {
    case undefined:
      await accountsListCommand([], json, io, dependencies);
      return 0;
    case "list":
      await accountsListCommand(rest, json, io, dependencies);
      return 0;
    case "add":
      await accountsAddCommand(rest, json, io, dependencies);
      return 0;
    case "import":
      await accountsImportCommand(rest, json, io, dependencies);
      return 0;
    case "rename":
      await accountsRenameCommand(rest, json, io, dependencies);
      return 0;
    case "use":
      await accountsUseCommand(rest, json, io, dependencies);
      return 0;
    case "remove":
      await accountsRemoveCommand(rest, json, io, dependencies);
      return 0;
    case "restore":
      await accountsRestoreCommand(rest, json, io, dependencies);
      return 0;
    case "caps":
      await accountsCapsCommand(rest, json, io, dependencies);
      return 0;
    case "distribute":
      return await accountsDistributeCommand(rest, json, io, dependencies);
    default:
      throw new UsageError(
        `Unknown accounts subcommand ${JSON.stringify(subcommand)}. ${ACCOUNTS_USAGE}`,
      );
  }
}

export async function accountsListCommand(
  argv: string[],
  json: boolean,
  io: CliIo,
  dependencies: CliDependencies,
): Promise<void> {
  const parsed = parseArguments(argv, {
    valueOptions: new Set(),
    booleanOptions: new Set(["--all"]),
    maximumPositionals: 0,
  });
  const report = await collectStatus(dependencies);
  if (!parsed.has("--all")) {
    if (json) {
      io.stdout(JSON.stringify(report.accounts));
      return;
    }
    printLocalAccounts(report.accounts, io);
    return;
  }

  let store: Awaited<ReturnType<typeof openWalletStore>>;
  try {
    store = await openWalletStore(dependencies);
    const walletInfos = await store.list();
    const defaultName = store.defaultName;
    const linked =
      (defaultName === undefined
        ? undefined
        : walletInfos.find(
            ({ name, entry }) => name === defaultName && entry.link !== undefined,
          )) ?? walletInfos.find(({ entry }) => entry.link !== undefined);
    if (linked?.entry.link === undefined) {
      outputSiblingsError(report.accounts, SIBLINGS_LOGIN_HINT, json, io, true);
      return;
    }

    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        controller.abort(new Error("The vAPI siblings request deadline exceeded."));
        reject(new Error("The vAPI siblings request failed."));
      }, SIBLINGS_REQUEST_TIMEOUT_MS);
    });
    let result: Awaited<ReturnType<typeof fetchSiblings>>;
    try {
      result = await Promise.race([
        fetchSiblings({
          apiBase: linked.entry.link.apiBase,
          account: linked.name,
          secrets: getSecretStore(dependencies),
          wallets: store,
          fetchImpl: await siblingsFetchImpl(dependencies),
          signal: controller.signal,
          ...(dependencies.now === undefined ? {} : { now: () => dependencies.now!().getTime() }),
        }),
        deadline,
      ]);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
    const localAddresses = new Set(report.accounts.map(({ address }) => address.toLowerCase()));
    const siblings = result.siblings.filter(
      ({ address }) => !localAddresses.has(address.toLowerCase()),
    );
    const revokedLocalAddresses = new Set(
      result.siblings
        .filter(
          ({ address, status }) =>
            status === "revoked" && localAddresses.has(address.toLowerCase()),
        )
        .map(({ address }) => address.toLowerCase()),
    );
    const accounts = report.accounts.map((account) =>
      revokedLocalAddresses.has(account.address.toLowerCase())
        ? { ...account, link: "revoked" as const }
        : account,
    );

    if (json) {
      io.stdout(JSON.stringify({ accounts, siblings }));
      return;
    }
    printLocalAccounts(accounts, io);
    printOtherDeviceAccounts(siblings, io);
  } catch (error) {
    outputSiblingsError(
      report.accounts,
      error instanceof Error ? error.message : String(error),
      json,
      io,
      false,
    );
  }
}

function printLocalAccounts(accounts: StatusAccount[], io: CliIo): void {
  io.stdout("Accounts");
  const width = accountNameWidth(accounts);
  for (const account of accounts) io.stdout(formatAccountLine(account, width));
}

function printOtherDeviceAccounts(siblings: Sibling[], io: CliIo): void {
  io.stdout("");
  io.stdout("On other devices");
  if (siblings.length === 0) {
    io.stdout("  (none)");
    return;
  }
  const nameWidth = Math.max(...siblings.map(({ name }) => name.length));
  for (const sibling of siblings) {
    const router =
      sibling.allowance.routerPerDayUsd === null
        ? "Router allowance not set"
        : `Router $${formatUsdAmount(sibling.allowance.routerPerDayUsd)} per day`;
    io.stdout(
      `  ${sibling.name.padEnd(nameWidth)}   ${shortAddress(sibling.address)}   ${sibling.device ?? "unknown device"}   ${sibling.status}   ${router}   read-only`,
    );
  }
}

function outputSiblingsError(
  accounts: StatusAccount[],
  message: string,
  json: boolean,
  io: CliIo,
  alsoWriteJsonErrorToStderr: boolean,
): void {
  if (json) {
    io.stdout(JSON.stringify({ accounts, siblings: [], siblingsError: message }));
    if (alsoWriteJsonErrorToStderr) io.stderr(message);
    return;
  }
  printLocalAccounts(accounts, io);
  io.stderr(message);
}

async function siblingsFetchImpl(dependencies: CliDependencies): Promise<typeof fetch> {
  if (dependencies.fetchImpl !== undefined) return dependencies.fetchImpl;
  const configPath = getVapiPaths().config;
  let config;
  try {
    await stat(configPath);
    config = await loadConfig(configPath, process.env);
  } catch (error) {
    if (!isMissingFile(error)) throw error;
    config = getDefaultConfig(process.env);
  }
  return createPublicFetch({ allowPrivateNetwork: config.allowPrivateNetwork ?? false });
}

function shortAddress(address: string): string {
  return address.length <= 12 ? address : `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export async function accountsAddCommand(
  argv: string[],
  json: boolean,
  io: CliIo,
  dependencies: CliDependencies,
): Promise<void> {
  const parsed = parseArguments(argv, {
    valueOptions: new Set(["--label"]),
    booleanOptions: new Set(["--no-link"]),
    maximumPositionals: 1,
  });
  const name = assertWalletName(requiredPositional(parsed.positionals[0], "<name>", ADD_USAGE));
  const label = parsed.one("--label");
  const store = await openWalletStore(dependencies);
  const created = await createAccount({
    store,
    name,
    ...(label === undefined ? {} : { label }),
    existing: "refuse",
  });
  await recordAudit(dependencies, "wallet.create", { wallet: created.account });
  const address = created.address;

  if (parsed.has("--no-link")) {
    output(
      io,
      json,
      { account: created.account, address, linked: false },
      `Account ${created.account} derived: ${address}`,
    );
    return;
  }

  const loginArgs = ["--account", created.account, "--label", label ?? created.account];
  if (!json) {
    io.stdout(`Account ${created.account} derived: ${address}`);
    await runLoginFlow(loginArgs, false, io, dependencies);
    return;
  }

  const linkedOutput: string[] = [];
  await runLoginFlow(
    loginArgs,
    true,
    {
      stdout: (message) => linkedOutput.push(message),
      stderr: io.stderr,
    },
    dependencies,
  );
  const linked = JSON.parse(linkedOutput.at(-1) ?? "{}") as Record<string, unknown>;
  io.stdout(JSON.stringify({ account: created.account, address, ...linked }));
}

export async function accountsImportCommand(
  argv: string[],
  json: boolean,
  io: CliIo,
  dependencies: CliDependencies,
): Promise<void> {
  if (argv.some((argument) => argument === "--key" || argument.startsWith("--key="))) {
    throw new UsageError(PRIVATE_KEY_ARGV_REFUSAL);
  }
  const parsed = parseArguments(argv, {
    valueOptions: new Set(["--keystore", "--key-file", "--label"]),
    maximumPositionals: 2,
  });
  const name = assertWalletName(requiredPositional(parsed.positionals[0], "<name>", IMPORT_USAGE));
  if (parsed.positionals[1] !== undefined) throw new UsageError(PRIVATE_KEY_ARGV_REFUSAL);
  const keystorePath = parsed.one("--keystore");
  const keyPath = parsed.one("--key-file");
  if (keystorePath !== undefined && keyPath !== undefined) {
    throw new UsageError(`Choose either --keystore or --key-file.\n${IMPORT_USAGE}`);
  }

  let privateKey: string;
  if (keystorePath !== undefined) {
    const passphrase = await secretPrompt(dependencies)(`Passphrase for ${keystorePath}: `);
    privateKey = (await exportKeystoreKeys(passphrase, keystorePath)).evm.privateKey;
  } else if (keyPath !== undefined) {
    privateKey = (await readFile(keyPath, "utf8")).trim();
  } else {
    privateKey = await secretPrompt(dependencies)("Private key: ");
  }
  const validated = validatePrivateKey(privateKey);
  const label = parsed.one("--label");
  const store = await openWalletStore(dependencies);
  const imported = await store.importKey(name, "", validated, {
    ...(label === undefined ? {} : { label }),
  });
  await recordAudit(dependencies, "wallet.import", { wallet: imported.name });
  const address = imported.account.address;
  const warning = "Imported keys are not in the recovery phrase; back the key up separately.";
  output(
    io,
    json,
    { account: imported.name, address, imported: true, warning },
    [`Account ${imported.name} imported: ${address}`, warning].join("\n"),
  );
}

export async function accountsRenameCommand(
  argv: string[],
  json: boolean,
  io: CliIo,
  dependencies: CliDependencies,
): Promise<void> {
  const parsed = parseArguments(argv, { valueOptions: new Set(), maximumPositionals: 2 });
  const usage = "Usage: vapi accounts rename <old> <new> [--json]";
  const from = requiredPositional(parsed.positionals[0], "<old>", usage);
  const to = requiredPositional(parsed.positionals[1], "<new>", usage);
  const store = await openWalletStore(dependencies);
  const renamed = await renameAgentLinkWallet({
    secrets: getSecretStore(dependencies),
    wallets: store,
    from,
    to,
  });
  const renamedLink = store.entry(renamed.name)?.link;
  if (renamedLink !== undefined && renamedLink.label !== renamed.name) {
    await store.setLink(renamed.name, { ...renamedLink, label: renamed.name });
  }
  await recordAudit(dependencies, "wallet.rename", {
    wallet: renamed.name,
    detail: `from ${from}`,
  });
  const address = await store.readAddress(renamed.name);
  outputForWallet(
    io,
    json,
    { name: renamed.name, ...(address === undefined ? {} : { address }) },
    {
      previous: from,
      ...(address === undefined ? {} : { address }),
      vault: join(store.home, "vault.json"),
      message: `Wallet ${from} is now ${renamed.name}.`,
    },
    [`Wallet ${from} is now ${renamed.name}.`, `Vault: ${join(store.home, "vault.json")}`].join(
      "\n",
    ),
  );
}

export async function accountsUseCommand(
  argv: string[],
  json: boolean,
  io: CliIo,
  dependencies: CliDependencies,
): Promise<void> {
  const parsed = parseArguments(argv, { valueOptions: new Set(), maximumPositionals: 1 });
  const name = requiredPositional(
    parsed.positionals[0],
    "<name>",
    "Usage: vapi accounts use <name> [--json]",
  );
  const store = await openWalletStore(dependencies);
  const account = store.resolve({ name, env: {} });
  await store.setDefault(account.name);
  await recordAudit(dependencies, "wallet.default", { wallet: account.name });
  const address = await store.readAddress(account.name);
  outputForWallet(
    io,
    json,
    { name: account.name, ...(address === undefined ? {} : { address }) },
    {
      ...(address === undefined ? {} : { address }),
      default: account.name,
      message: `Default wallet is now ${account.name}.`,
    },
    `Default wallet is now ${account.name}.`,
  );
}

export async function accountsRemoveCommand(
  argv: string[],
  json: boolean,
  io: CliIo,
  dependencies: CliDependencies,
): Promise<void> {
  const parsed = parseArguments(argv, {
    valueOptions: new Set(),
    booleanOptions: new Set(["--force"]),
    maximumPositionals: 1,
  });
  const name = requiredPositional(
    parsed.positionals[0],
    "<name>",
    "Usage: vapi accounts remove <name> [--force] [--json]",
  );
  const force = parsed.has("--force");
  const store = await openWalletStore(dependencies);
  const account = store.resolve({ name, env: {} });
  const address = await store.readAddress(account.name);

  if (isInteractive(dependencies)) {
    await confirmWalletName(
      account.name,
      `Type ${account.name} to remove it: `,
      "That is not the account name. Nothing was removed.",
      dependencies,
    );
  } else if (!force) {
    throw new KeystoreError(REMOVE_NEEDS_TERMINAL);
  }

  const config = await loadConfig(getVapiPaths().config, process.env, { notice: io.stderr });
  const readBalance = baseUsdcBalanceReader(config, dependencies);
  let trashed: Awaited<ReturnType<typeof store.remove>>;
  try {
    trashed = await store.remove(account.name, {
      balanceReader: async (walletAddress) => {
        const balance = await readBalance(walletAddress);
        if (balance > 0n) {
          throw new KeystoreError(
            `Account ${account.name} still holds ${formatUsdc(balance)} USDC. Move it out with vapi sweep --account ${account.name} first.`,
          );
        }
        return balance;
      },
    });
  } catch (error) {
    if (error instanceof KeystoreError && error.message.includes("vapi wallet use")) {
      throw new KeystoreError(error.message.replace("vapi wallet use", "vapi accounts use"), {
        cause: error,
      });
    }
    throw error;
  }
  await recordAudit(dependencies, "wallet.remove", { wallet: trashed.name });
  const message = `Account ${trashed.name} removed. Bring it back with vapi accounts restore ${trashed.name}.`;
  output(
    io,
    json,
    {
      account: trashed.name,
      ...(address === undefined ? {} : { address }),
      removedAt: trashed.removedAt,
      trash: trashed.path,
      message,
    },
    message,
  );
}

export async function accountsRestoreCommand(
  argv: string[],
  json: boolean,
  io: CliIo,
  dependencies: CliDependencies,
): Promise<void> {
  const parsed = parseArguments(argv, { valueOptions: new Set(), maximumPositionals: 1 });
  const name = requiredPositional(
    parsed.positionals[0],
    "<name>",
    "Usage: vapi accounts restore <name> [--json]",
  );
  const store = await openWalletStore(dependencies);
  const restored = await store.restore(name);
  await recordAudit(dependencies, "wallet.restore", { wallet: restored.name });
  const address = await store.readAddress(restored.name);
  outputForWallet(
    io,
    json,
    { name: restored.name, ...(address === undefined ? {} : { address }) },
    {
      ...(address === undefined ? {} : { address }),
      vault: join(store.home, "vault.json"),
      spendCaps: restored.entry.spendCaps,
      message: `Wallet ${restored.name} restored to the device vault.`,
    },
    [
      `Wallet ${restored.name} restored to the device vault.`,
      `Vault: ${join(store.home, "vault.json")}`,
    ].join("\n"),
  );
}

export async function accountsCapsCommand(
  argv: string[],
  json: boolean,
  io: CliIo,
  dependencies: CliDependencies,
): Promise<void> {
  const parsed = parseArguments(argv, {
    valueOptions: new Set(["--per-call", "--per-day", "--ceiling"]),
    maximumPositionals: 1,
  });
  const name = requiredPositional(
    parsed.positionals[0],
    "<name>",
    "Usage: vapi accounts caps <name> [--per-call <usd>] [--per-day <usd>] [--ceiling <usd|off>] [--json]",
  );
  const perCall = parsed.one("--per-call");
  const perDay = parsed.one("--per-day");
  const ceiling = parsed.one("--ceiling");
  const store = await openWalletStore(dependencies);
  const account = store.resolve({ name, env: {} });
  const address = await store.readAddress(account.name);
  if (perCall === undefined && perDay === undefined && ceiling === undefined) {
    const caps = capsOutput(account.entry.spendCaps, store.ceilingCaps(account.name));
    outputForWallet(
      io,
      json,
      { name: account.name, ...(address === undefined ? {} : { address }) },
      {
        ...(address === undefined ? {} : { address }),
        spendCaps: account.entry.spendCaps,
        ...caps,
      },
      [
        walletHeader({ name: account.name, ...(address === undefined ? {} : { address }) }),
        `Spend caps: ${formatCaps(account.entry.spendCaps)}`,
        `Ceiling: ${caps.ceilingUsd === "off" ? "off" : `${caps.ceilingUsd} USDC`}`,
        "Change them with --per-call <usd>, --per-day <usd>, or --ceiling <usd|off>.",
      ].join("\n"),
    );
    return;
  }

  const spendCaps: SpendCaps = {
    perCallAtomic:
      perCall === undefined
        ? account.entry.spendCaps.perCallAtomic
        : capAtomic(perCall, "--per-call"),
    perDayAtomic:
      perDay === undefined ? account.entry.spendCaps.perDayAtomic : capAtomic(perDay, "--per-day"),
  };
  if (BigInt(spendCaps.perCallAtomic) > BigInt(spendCaps.perDayAtomic)) {
    throw new UsageError("The per-call cap cannot be larger than the per-day cap.");
  }
  const ceilingAtomic =
    ceiling === undefined
      ? undefined
      : ceiling === "off"
        ? null
        : BigInt(capAtomic(ceiling, "--ceiling"));
  let entry = account.entry;
  if (perCall !== undefined || perDay !== undefined) {
    entry = await store.setSpendCaps(account.name, spendCaps);
  }
  if (ceilingAtomic !== undefined) entry = await store.setCeiling(account.name, ceilingAtomic);
  const caps = capsOutput(entry.spendCaps, store.ceilingCaps(account.name));
  await recordAudit(dependencies, "wallet.caps", {
    wallet: account.name,
    detail: `${formatCaps(entry.spendCaps)}, ceiling ${
      caps.ceilingUsd === "off" ? "off" : `${caps.ceilingUsd} USDC`
    }`,
  });
  const message =
    perCall !== undefined || perDay !== undefined
      ? `Spend caps updated for ${account.name}.`
      : `Ceiling updated for ${account.name}.`;
  outputForWallet(
    io,
    json,
    { name: account.name, ...(address === undefined ? {} : { address }) },
    {
      ...(address === undefined ? {} : { address }),
      spendCaps: entry.spendCaps,
      ...caps,
      message,
    },
    [
      message,
      `Spend caps: ${formatCaps(entry.spendCaps)}`,
      `Ceiling: ${caps.ceilingUsd === "off" ? "off" : `${caps.ceilingUsd} USDC`}`,
    ].join("\n"),
  );
}

const DISTRIBUTE_USAGE =
  "Usage: vapi accounts distribute <amount> --from <account> [--to <a,b,c>] [--network base|arc] [--json]\n       vapi accounts distribute --resume <id> [--replace-expired-restored] [--bind-legacy-addresses] [--json]\n       vapi accounts distribute --cancel <id> [--replace-expired-restored] [--json]";

export async function accountsDistributeCommand(
  argv: string[],
  json: boolean,
  io: CliIo,
  dependencies: CliDependencies,
): Promise<number> {
  const parsed = parseArguments(argv, {
    valueOptions: new Set(["--from", "--to", "--network", "--resume", "--cancel"]),
    booleanOptions: new Set(["--replace-expired-restored", "--bind-legacy-addresses"]),
    maximumPositionals: 1,
  });
  const amountUsd = parsed.positionals[0];
  const resume = parsed.one("--resume");
  const cancel = parsed.one("--cancel");
  const replaceExpiredRestored = parsed.has("--replace-expired-restored");
  const bindLegacyAddresses = parsed.has("--bind-legacy-addresses");
  const toValue = parsed.one("--to");
  const fromValue = parsed.one("--from");
  const network = parsed.one("--network");
  if (
    cancel !== undefined &&
    (resume !== undefined ||
      amountUsd !== undefined ||
      fromValue !== undefined ||
      toValue !== undefined ||
      network !== undefined)
  ) {
    throw new UsageError(
      `--cancel accepts only a movement id and optional --replace-expired-restored.\n${DISTRIBUTE_USAGE}`,
    );
  }
  if (resume !== undefined && (amountUsd !== undefined || toValue !== undefined)) {
    throw new UsageError(`--resume accepts no amount or --to recipients.\n${DISTRIBUTE_USAGE}`);
  }
  if (resume === undefined && cancel === undefined && amountUsd === undefined) {
    throw new UsageError(`Missing <amount>.\n${DISTRIBUTE_USAGE}`);
  }
  if (replaceExpiredRestored && resume === undefined && cancel === undefined) {
    throw new UsageError(
      `--replace-expired-restored requires --resume <id> or --cancel <id>.\n${DISTRIBUTE_USAGE}`,
    );
  }
  if (bindLegacyAddresses && resume === undefined) {
    throw new UsageError(`--bind-legacy-addresses requires --resume <id>.\n${DISTRIBUTE_USAGE}`);
  }
  if (resume === undefined && cancel === undefined && fromValue === undefined) {
    throw new UsageError(`Missing --from <account>.\n${DISTRIBUTE_USAGE}`);
  }
  if (network !== undefined && network !== "base" && network !== "arc") {
    throw new UsageError(`--network must be base or arc.\n${DISTRIBUTE_USAGE}`);
  }

  const store = await openWalletStore(dependencies);
  const config = await accountsConfig(dependencies);
  if (cancel !== undefined) {
    const movement = await cancelMovement(cancel, {
      store,
      secrets: getSecretStore(dependencies),
      apiBase:
        store.entry((await readMovement(store.home, cancel)).from)?.link?.apiBase ??
        registryBaseUrl(config),
      home: store.home,
      fetchImpl:
        dependencies.fetchImpl ??
        createPublicFetch({ allowPrivateNetwork: config.allowPrivateNetwork ?? false }),
      ...(dependencies.now === undefined ? {} : { now: () => dependencies.now!().getTime() }),
      ...(dependencies.distribute?.authorizationState === undefined
        ? {}
        : { authorizationState: dependencies.distribute.authorizationState }),
      ...(dependencies.distribute?.lockTimeoutMs === undefined
        ? {}
        : { lockTimeoutMs: dependencies.distribute.lockTimeoutMs }),
      ...(replaceExpiredRestored ? { replaceExpiredRestored: true } : {}),
    });
    printCancellation(movement, json, io);
    return 0;
  }
  const movementFrom =
    resume === undefined ? undefined : (await readMovement(store.home, resume)).from;
  const from = movementFrom ?? (fromValue === undefined ? undefined : assertWalletName(fromValue));
  const apiBase =
    (from === undefined ? undefined : store.entry(from)?.link?.apiBase) ?? registryBaseUrl(config);
  const to =
    toValue === undefined ? undefined : toValue.split(",").map((recipient) => recipient.trim());

  let result: DistributeResult;
  try {
    result = await distributeBetweenAccounts({
      store,
      secrets: getSecretStore(dependencies),
      apiBase,
      ...(from === undefined ? {} : { from }),
      ...(amountUsd === undefined ? {} : { amountUsd }),
      ...(to === undefined ? {} : { to }),
      ...(network === undefined ? {} : { network }),
      ...(resume === undefined ? {} : { resume }),
      fetchImpl:
        dependencies.fetchImpl ??
        createPublicFetch({ allowPrivateNetwork: config.allowPrivateNetwork ?? false }),
      unlock: async (name) => {
        const resolved = store.resolve({ name, env: {} });
        const address = await store.readAddress(resolved.name);
        return (
          await unlockTarget(
            { store, ...resolved, ...(address === undefined ? {} : { address }) },
            dependencies,
          )
        ).account;
      },
      ...(dependencies.now === undefined ? {} : { now: () => dependencies.now!().getTime() }),
      ...dependencies.distribute,
      ...(replaceExpiredRestored ? { replaceExpiredRestored: true } : {}),
      ...(bindLegacyAddresses ? { bindLegacyAddresses: true } : {}),
    });
  } catch (error) {
    if (
      error instanceof DistributeError &&
      ["invalid_amount", "invalid_network", "invalid_recipients", "resume_conflict"].includes(
        error.code,
      )
    ) {
      throw new UsageError(error.message);
    }
    throw error;
  }

  if (json) io.stdout(JSON.stringify(result));
  else printDistribution(result, io);
  return result.legs.every((leg) => leg.status === "sent") ? 0 : 1;
}

function isLegacyAccountsInvocation(argv: string[]): boolean {
  if (argv.includes("--enable")) return true;
  const hasAccountSelector = argv.includes(ACCOUNT_OPTION) || argv.includes(WALLET_OPTION);
  return hasAccountSelector && (argv[0]?.startsWith("--") ?? false);
}

async function networkAccountsCommand(
  argv: string[],
  json: boolean,
  io: CliIo,
  dependencies: CliDependencies,
): Promise<void> {
  const parsed = parseArguments(argv, {
    valueOptions: new Set(["--enable", WALLET_OPTION]),
    maximumPositionals: 0,
  });
  const enable = parsed.one("--enable");
  if (enable !== undefined && enable !== "solana" && enable !== "arc") {
    throw new UsageError("--enable supports solana and arc.");
  }
  if (enable === "solana") throw new UsageError(SOLANA_VAULT_UNAVAILABLE);
  const paths = getVapiPaths();
  const target = await targetWallet(parsed, dependencies);
  const { account } = await unlockTarget(target, dependencies);
  if (enable) await enableDefaultNetwork(enable, paths.config);
  const config = await loadConfig(paths.config, process.env, { notice: io.stderr });
  const accounts = await listAccounts({
    address: account.address,
    ...(account.solana ? { solanaAddress: account.solana.address } : {}),
    config,
    ...(dependencies.fetchImpl === undefined ? {} : { fetchImpl: dependencies.fetchImpl }),
  });
  outputForWallet(io, json, target, { accounts }, formatNetworkAccounts(accounts));
}

function secretPrompt(dependencies: CliDependencies): (prompt: string) => Promise<string> {
  return dependencies.prompts?.secret ?? ((prompt) => promptForSecret(prompt));
}

function capAtomic(value: string, option: string): string {
  try {
    return usdToAtomic(value).toString();
  } catch {
    throw new UsageError(`${option} must be a US dollar amount such as 0.25 or 10.`);
  }
}

function capsInUsd(caps: SpendCaps): { perCallUsd: string; perDayUsd: string } {
  return {
    perCallUsd: formatUsdc(BigInt(caps.perCallAtomic)),
    perDayUsd: formatUsdc(BigInt(caps.perDayAtomic)),
  };
}

function capsOutput(
  spendCaps: SpendCaps,
  ceiling: Parameters<typeof ceilingCapsJson>[0],
): { perCallUsd: string; perDayUsd: string; ceilingUsd: string } {
  return { ...capsInUsd(spendCaps), ...ceilingCapsJson(ceiling) };
}

function formatCaps(caps: SpendCaps): string {
  const usd = capsInUsd(caps);
  return `${usd.perCallUsd} USD per call, ${usd.perDayUsd} USD per day`;
}

async function accountsConfig(dependencies: CliDependencies) {
  try {
    return await loadConfig(getVapiPaths().config, getEnvironment(dependencies));
  } catch (error) {
    if (!isMissingFile(error)) throw error;
    return getDefaultConfig(getEnvironment(dependencies));
  }
}

function printDistribution(result: DistributeResult, io: CliIo): void {
  for (const binding of result.legacyAddressBindings ?? []) {
    io.stdout(
      `Bound current addresses after terminal review: ${binding.from} (${binding.fromAddress}) -> ${binding.to} (${binding.toAddress}).`,
    );
  }
  const rows = result.legs.map((leg) => [
    leg.to,
    `${leg.amountUsd} USDC`,
    leg.status,
    leg.txHash ?? leg.reason ?? (leg.status === "unknown" ? "outcome unknown" : ""),
  ]);
  const headings = ["Account", "Amount", "Status", "Transaction or reason"];
  const widths = headings.map((heading, index) =>
    Math.max(heading.length, ...rows.map((row) => row[index]!.length)),
  );
  const line = (columns: string[]) =>
    columns
      .map((column, index) => column.padEnd(widths[index]!))
      .join("  ")
      .trimEnd();
  io.stdout(line(headings));
  for (const row of rows) io.stdout(line(row));
  io.stdout(`Totals: ${result.sentUsd} USDC sent; ${result.failedUsd} USDC not sent.`);
}

function printCancellation(movement: Movement, json: boolean, io: CliIo): void {
  const balanceCommands = [...new Set(movement.legs.map((leg) => leg.from))].map(
    (account) => `vapi balance --account ${account}`,
  );
  const balanceCheck = balanceCommands.join("; ");
  const legs = movement.legs.map((leg) => ({
    from: leg.from,
    to: leg.to,
    amountUsd: leg.amountUsd,
    nonce: leg.nonce,
    status: leg.status,
    ...(leg.txHash === undefined ? {} : { txHash: leg.txHash }),
  }));
  if (json) {
    io.stdout(
      JSON.stringify({
        movementId: movement.id,
        network: movement.network,
        legs,
        balanceCheck,
      }),
    );
    return;
  }
  for (const leg of legs) {
    if (leg.status === "cancelled") {
      io.stdout(`Cancelled ${leg.amountUsd} USDC from ${leg.from} to ${leg.to} (${leg.nonce}).`);
    } else if (leg.status === "sent") {
      io.stdout(`Reconciled ${leg.amountUsd} USDC from ${leg.from} to ${leg.to} as sent.`);
    }
  }
  io.stdout(`Check current balances before moving funds again: ${balanceCheck}.`);
}

function output(io: CliIo, json: boolean, value: unknown, human: string): void {
  io.stdout(json ? JSON.stringify(value) : human);
}

function outputForWallet(
  io: CliIo,
  json: boolean,
  target: { name: string; address?: string },
  value: Record<string, unknown>,
  human: string,
): void {
  if (json) {
    io.stdout(JSON.stringify({ wallet: target.name, ...value }));
    return;
  }
  io.stdout(
    target.address === undefined
      ? `Wallet: ${target.name}`
      : `Wallet: ${target.name} (${target.address})`,
  );
  io.stdout(human);
}

function walletHeader(target: { name: string; address?: string }): string {
  return target.address === undefined
    ? `Wallet: ${target.name}`
    : `Wallet: ${target.name} (${target.address})`;
}

function formatNetworkAccounts(accounts: readonly AccountInfo[]): string {
  if (accounts.length === 0) return "No configured network accounts.";
  return accounts
    .map((account) => {
      const lines = [`${account.name} (${account.caip2})`, `  Address: ${account.address}`];
      lines.push(
        account.usdcBalance
          ? `  USDC: ${account.usdcBalance.formatted} (${account.usdcBalance.atomic} atomic)`
          : "  USDC: unavailable",
      );
      if (account.gasTokenBalance) {
        lines.push(
          `  ${account.gasTokenBalance.symbol}: ${account.gasTokenBalance.formatted} (${account.gasTokenBalance.atomic} atomic)`,
        );
      }
      if (account.depositUrl) lines.push(`  Deposit: ${account.depositUrl}`);
      if (account.depositInstructions) lines.push(`  ${account.depositInstructions}`);
      if (account.error) lines.push(`  Balance error: ${account.error}`);
      return lines.join("\n");
    })
    .join("\n");
}
