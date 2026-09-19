import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { createInterface } from "node:readline/promises";

import {
  ARC_TESTNET_CAIP2,
  BASE_MAINNET_CAIP2,
  DEFAULT_WALLET_NAME,
  ONRAMP_FALLBACK_INSTRUCTIONS,
  ONRAMP_NETWORK,
  STATS_RANGES,
  activeAgentMarker,
  aggregateStats,
  appendAudit,
  assertWalletName,
  changeKeystorePassphrase,
  createSupportReport,
  enableDefaultNetwork,
  enableSolanaKey,
  filterReceiptsByRange,
  formatLegacyRegistryRewrites,
  formatUsdc,
  fundingPageUrl,
  getArcGasHeadroomAtomic,
  getKeystorePassphrase,
  getNetworkDefinition,
  getVapiPaths,
  isMissingFile,
  isNetworkConfigured,
  isSolanaNetwork,
  KeystoreError,
  loadConfig,
  listAccounts,
  migrateLegacyRegistryConfig,
  migrateLegacyVapiHome,
  promptForSecret,
  readKeystoreVersion,
  readReceipts,
  readSearchEvents,
  receiptsToCsv,
  resolveRegistryUrl,
  secretsAllowed,
  spendCapsForWallet,
  sweepBack,
  unlockKeystore,
  usdToAtomic,
  validatePrivateKey,
  validateRecoveryPhrase,
  WalletStore,
  writeDefaultConfig,
  type AuditEvent,
  type SecretsDecision,
  type SpendCaps,
  type StatsRange,
  type AccountInfo,
  type VapiConfig,
  type WalletBalanceReader,
  type WalletEntry,
  type WalletInfo,
  type WalletName,
} from "@vapi-network/core";
import { exportKeystoreKeys, exportRecoveryPhrase } from "@vapi-network/core/secrets";
import {
  callService,
  getWallet,
  inspectService,
  searchMarketplace,
  startStdioServer,
} from "@vapi-network/mcp";
import { detectColorLevel, renderBanner } from "./brand.js";
import { CLI_VERSION } from "./version";

const HELP_HEADING = "vAPI Network";

export const HELP = `${HELP_HEADING}

Usage:
  vapi init [--networks <base,solana>] [--json]
  vapi wallet list [--json]
  vapi wallet create <name> [--networks <base,solana>] [--label <text>] [--json]
  vapi wallet use <name> [--json]
  vapi wallet rename <old> <new> [--json]
  vapi wallet remove <name> [--force] [--json]
  vapi wallet restore <name> [--json]
  vapi wallet caps <name> [--per-call <usd>] [--per-day <usd>] [--json]
  vapi fund [--amount <usd>] [--wallet <name>] [--json]
  vapi accounts [--enable solana] [--wallet <name>] [--json]
  vapi search [query] [--kind <kind>] [--network <caip2>] [--limit <n>] [--cursor <cursor>] [--json]
  vapi inspect <id> [--endpoint <name>] [--json]
  vapi pay <id-or-url> [--method <method>] [--endpoint <name>] [--body <json>] [--content-type <type>] [--network <caip2>] [--expected-pay-to <address>] [--max <amount>] [--wallet <name>] [--json]
  vapi balance [--wallet <name>] [--json]
  vapi receipts [--limit <n>] [--wallet <name>] [--all-wallets] [--json]
  vapi receipts export --format <json|csv> [--range <24h|7d|30d>] [--wallet <name>] [--all-wallets]
  vapi stats [--range <24h|7d|30d>] [--wallet <name>] [--all-wallets] [--json]
  vapi sweep <address> [--network <caip2>] [--wallet <name>] [--json]
  vapi export-key [--network <caip2>] [--wallet <name>] [--json]
  vapi backup [--wallet <name>] [--json]
  vapi import (--phrase | --key) [--wallet <name>] [--networks <base,solana>] [--replace] [--force] [--json]
  vapi passphrase [--wallet <name>] [--json]
  vapi report "<what happened>" [--include-addresses] [--send] [--json]
  vapi mcp [--json]
  vapi serve [--json]
  vapi version [--json]
  vapi publish [--json]

Every command that touches a wallet takes \`--wallet <name>\`, falls back to \`VAPI_WALLET\`, then to the default set by \`vapi wallet use\`, and names the wallet it used on its first line.

\`vapi fund\` opens the funding page: card via Coinbase (needs a Coinbase account; US guest checkout), send from MetaMask/Coinbase Wallet/WalletConnect, or bridge from another chain.

\`vapi backup\` and \`vapi export-key\` print a secret, so they run only on a real terminal, never for an agent, and ask you to type the wallet name first. Set \`VAPI_NO_SECRETS=1\` to switch them off entirely. Every export and every wallet change is logged to ~/.vapi/audit.log.

With no command, vapi shows this help. The MCP server starts only with \`vapi mcp\`.`;

export type CliIo = {
  stdout(message: string): void;
  stderr(message: string): void;
};

/** Every secret the CLI reads is read here, so tests never touch a terminal. */
export type CliPrompts = {
  /** Reads one line from the terminal without echoing it. */
  secret(prompt: string): Promise<string>;
  /**
   * Reads one visible line, for a typed confirmation such as a wallet name.
   * Never used for a secret, so it may echo.
   */
  line?(prompt: string): Promise<string>;
};

export type CliDependencies = {
  fetchImpl?: typeof fetch;
  prompts?: CliPrompts;
  /** Whether a person is watching. Only then is a recovery phrase shown. */
  interactive?: boolean;
  /** The environment this run sees: wallet selection and agent detection. */
  env?: NodeJS.ProcessEnv;
};

const processIo: CliIo = {
  stdout: (message) => process.stdout.write(`${message}\n`),
  stderr: (message) => process.stderr.write(`${message}\n`),
};

const defaultPrompts: CliPrompts = { secret: (prompt) => promptForSecret(prompt) };

class UsageError extends Error {}

function getPrompts(dependencies: CliDependencies): CliPrompts {
  return dependencies.prompts ?? defaultPrompts;
}

function getEnvironment(dependencies: CliDependencies): NodeJS.ProcessEnv {
  return dependencies.env ?? process.env;
}

/** A recovery phrase is shown only when a person can write it down. */
function isInteractive(dependencies: CliDependencies): boolean {
  return dependencies.interactive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

/**
 * Reads one visible line. The prompt and the echo go to stderr, so a typed
 * confirmation never lands in the stdout a caller may be capturing.
 */
async function promptForLine(prompt: string): Promise<string> {
  const reader = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return (await reader.question(prompt)).trim();
  } finally {
    reader.close();
  }
}

function getLinePrompt(dependencies: CliDependencies): (prompt: string) => Promise<string> {
  return getPrompts(dependencies).line ?? promptForLine;
}

const WALLET_OPTION = "--wallet";

/** The wallet one invocation acts on, resolved before any passphrase is read. */
type WalletTarget = {
  store: WalletStore;
  name: WalletName;
  path: string;
  entry: WalletEntry;
  address?: string;
};

/** Opens the wallet store for this home, migrating a 0.2.x layout on the way. */
async function openWalletStore(): Promise<WalletStore> {
  return await WalletStore.open(getVapiPaths().directory);
}

/**
 * `--wallet`, then `VAPI_WALLET`, then the default in `wallets.json`. An
 * unknown name fails here, before a passphrase prompt can cost anything.
 */
async function selectWallet(
  store: WalletStore,
  parsed: { one(name: string): string | undefined },
  dependencies: CliDependencies,
): Promise<WalletTarget> {
  const requested = parsed.one(WALLET_OPTION);
  const resolved = store.resolve({
    ...(requested === undefined ? {} : { name: requested }),
    env: getEnvironment(dependencies),
  });
  const address = await store.readAddress(resolved.name);
  return { store, ...resolved, ...(address === undefined ? {} : { address }) };
}

/** Opens the store and picks the wallet in one step, for the usual command. */
async function targetWallet(
  parsed: { one(name: string): string | undefined },
  dependencies: CliDependencies,
): Promise<WalletTarget> {
  return await selectWallet(await openWalletStore(), parsed, dependencies);
}

function walletHeader(target: { name: string; address?: string }): string {
  return target.address === undefined
    ? `Wallet: ${target.name}`
    : `Wallet: ${target.name} (${target.address})`;
}

/**
 * The shape every wallet-aware command prints: the wallet name first in text
 * mode, and a `wallet` field in `--json`, so a person and an agent always know
 * which key just moved.
 */
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
  io.stdout(walletHeader(target));
  io.stdout(human);
}

const AGENT_SECRET_REFUSAL =
  "Run this yourself in a terminal; an agent must never see these words.";

/** Whether this run may put a recovery phrase or a private key on the screen. */
function secretsDecision(dependencies: CliDependencies): SecretsDecision {
  const interactive = dependencies.interactive;
  return secretsAllowed(getEnvironment(dependencies), {
    stdinIsTTY: interactive ?? Boolean(process.stdin.isTTY),
    stdoutIsTTY: interactive ?? Boolean(process.stdout.isTTY),
  });
}

/** One audit line. The home is the wallet store's, so `VAPI_HOME` is honoured. */
async function recordAudit(
  dependencies: CliDependencies,
  event: AuditEvent,
  options: { wallet?: string; detail?: string } = {},
): Promise<void> {
  const marker = activeAgentMarker(getEnvironment(dependencies));
  await appendAudit(getVapiPaths().directory, {
    event,
    ...(options.wallet === undefined ? {} : { wallet: options.wallet }),
    tty: isInteractive(dependencies),
    ...(marker === undefined ? {} : { agentMarker: marker }),
    ...(options.detail === undefined ? {} : { detail: options.detail }),
  });
}

/**
 * The gate in front of `vapi backup` and `vapi export-key`: refuse, log the
 * attempt, and say which stream or which variable decided it. Nothing is
 * printed to stdout, so a caller capturing it gets nothing either way.
 */
async function requireSecretsAllowed(
  dependencies: CliDependencies,
  event: AuditEvent,
  wallet: string,
): Promise<void> {
  const decision = secretsDecision(dependencies);
  if (decision.allowed) return;
  await recordAudit(dependencies, event, { wallet, detail: `refused: ${decision.reason ?? ""}` });
  throw new KeystoreError(`${AGENT_SECRET_REFUSAL} ${decision.reason ?? ""}`.trim());
}

/**
 * Printing a secret or trashing a wallet is worth one deliberate act: the
 * person types the wallet's own name. A mismatch stops before anything moves.
 */
async function confirmWalletName(
  name: string,
  prompt: string,
  refusal: string,
  dependencies: CliDependencies,
): Promise<void> {
  const typed = await getLinePrompt(dependencies)(prompt);
  if (typed.trim() !== name) throw new KeystoreError(refusal);
}

/** Run one CLI invocation and return its process exit code. */
export async function runCli(
  argv = process.argv.slice(2),
  io: CliIo = processIo,
  dependencies: CliDependencies = {},
): Promise<number> {
  let json = argv.includes("--json");
  try {
    const parsedInvocation = removeJsonFlag(argv);
    json = parsedInvocation.json;
    const args = parsedInvocation.args;
    const command = args[0];

    if (command === "version" || command === "--version" || command === "-v") {
      requireNoArguments(args.slice(1), "version");
      output(io, json, { command: "version", version: CLI_VERSION }, CLI_VERSION);
      return 0;
    }

    if (command === undefined || command === "help" || command === "--help" || command === "-h") {
      requireNoArguments(args.slice(command === undefined ? 0 : 1), command ?? "help");
      if (command === undefined && !json) {
        // The banner already carries the wordmark, so the help heading would repeat it.
        showBanner(io);
        io.stdout(HELP.slice(HELP_HEADING.length + 2));
        return 0;
      }
      output(io, json, { command: "help", help: HELP }, HELP);
      return 0;
    }

    switch (command) {
      case "init":
        await initCommand(args.slice(1), json, io, dependencies);
        return 0;
      case "wallet":
        await walletCommand(args.slice(1), json, io, dependencies);
        return 0;
      case "fund":
        await fundCommand(args.slice(1), json, io, dependencies);
        return 0;
      case "accounts":
        await accountsCommand(args.slice(1), json, io, dependencies);
        return 0;
      case "search":
        await searchCommand(args.slice(1), json, io, dependencies);
        return 0;
      case "inspect":
        await inspectCommand(args.slice(1), json, io, dependencies);
        return 0;
      case "pay":
        await payCommand(args.slice(1), json, io, dependencies);
        return 0;
      case "balance":
        await balanceCommand(args.slice(1), json, io, dependencies);
        return 0;
      case "receipts":
        await receiptsCommand(args.slice(1), json, io, dependencies);
        return 0;
      case "stats":
        await statsCommand(args.slice(1), json, io, dependencies);
        return 0;
      case "sweep":
        await sweepCommand(args.slice(1), json, io, dependencies);
        return 0;
      case "export-key":
        await exportKeyCommand(args.slice(1), json, io, dependencies);
        return 0;
      case "backup":
        await backupCommand(args.slice(1), json, io, dependencies);
        return 0;
      case "import":
        await importCommand(args.slice(1), json, io, dependencies);
        return 0;
      case "passphrase":
        await passphraseCommand(args.slice(1), json, io, dependencies);
        return 0;
      case "report":
        await reportCommand(args.slice(1), json, io, dependencies);
        return 0;
      case "mcp":
        await mcpCommand(args.slice(1), dependencies);
        return 0;
      case "serve":
      case "publish":
        outputStub(io, json);
        return 2;
      default:
        throw new UsageError(`Unknown command ${JSON.stringify(command)}.`);
    }
  } catch (error) {
    const code = error instanceof UsageError ? 2 : 1;
    const message = error instanceof Error ? error.message : String(error);
    if (json) {
      io.stdout(JSON.stringify({ error: message, exitCode: code }));
    } else {
      io.stderr(message);
      if (error instanceof UsageError) io.stderr(`\n${HELP}`);
    }
    return code;
  }
}

/**
 * Creates the first wallet of a machine, `main`, together with the config. A
 * home that already has wallets is not an error: init says so and lists them,
 * without ever costing a passphrase prompt or touching an existing key.
 */
async function initCommand(
  argv: string[],
  json: boolean,
  io: CliIo,
  dependencies: CliDependencies,
): Promise<void> {
  const parsed = parseArguments(argv, {
    valueOptions: new Set(["--networks"]),
    maximumPositionals: 0,
  });
  const networks = parseInitNetworks(parsed.one("--networks") ?? "base");
  const enableSolana = networks.includes("solana");
  if (!json) showBanner(io);
  const paths = getVapiPaths();
  if (!process.env.VAPI_HOME?.trim()) {
    await migrateLegacyVapiHome({ targetDirectory: paths.directory, notice: io.stderr });
  }
  // WalletStore.open moves a 0.2.x keystore.json into wallets/main.json, so an
  // upgraded home is never mistaken for an empty one.
  const store = await openWalletStore();
  if (store.names().length > 0) {
    await reportExistingWallets(store, json, io);
    return;
  }

  // The custody terms come before the passphrase, so nothing exists yet when
  // the person reads what vAPI cannot do for them.
  if (!json) io.stdout(CUSTODY_NOTICE);
  const passphrase = await getKeystorePassphrase({ confirm: true });
  const created = await store.create(DEFAULT_WALLET_NAME, passphrase, { enableSolana });
  await recordAudit(dependencies, "wallet.create", { wallet: created.name });
  let account = created.account;
  if (enableSolana && !account.solana) {
    account = await enableSolanaKey(passphrase, created.path);
  }
  // Before any network call: the phrase must survive a registry outage.
  if (!json) await showRecoveryPhrase(created.recoveryPhrase, io, dependencies);
  if (!(await fileExists(paths.config))) {
    await writeDefaultConfig(paths.config, process.env, { networks });
  } else if (enableSolana) {
    await enableDefaultNetwork("solana", paths.config);
  }
  const configRewrites = await migrateLegacyRegistryConfig(paths.config);

  const config = await readConfig(paths.config, io);
  const accounts = await listAccounts({
    address: account.address,
    ...(account.solana ? { solanaAddress: account.solana.address } : {}),
    config,
    ...(dependencies.fetchImpl ? { fetchImpl: dependencies.fetchImpl } : {}),
  });
  const result = {
    wallet: created.name,
    address: account.address,
    accounts,
    config: paths.config,
    keystore: created.path,
    ...(configRewrites.length > 0 ? { configRewrites } : {}),
    custody: "self",
    warning: CUSTODY_NOTICE,
    recoveryPhrase: "hidden",
    message: "vAPI wallet created. Its encrypted key stays on this machine.",
    nextSteps: buildNextSteps(account.address),
  };
  if (json) {
    io.stdout(JSON.stringify(result));
    return;
  }

  if (configRewrites.length > 0) io.stdout(formatLegacyRegistryRewrites(configRewrites));
  io.stdout(walletHeader({ name: created.name, address: account.address }));
  io.stdout(result.message);
  io.stdout(`Address: ${result.address}`);
  io.stdout(
    "Fund the EVM address with USDC and a little ETH for gas on Base mainnet (eip155:8453).",
  );
  if (account.solana) {
    io.stdout(`Solana address: ${account.solana.address}`);
    io.stdout(
      "Fund it with Solana USDC; x402 fees are facilitator-sponsored, while sweeps need a little SOL.",
    );
  }
  io.stdout(`Config: ${paths.config}`);
  io.stdout(`Keystore: ${created.path}`);
  io.stdout(formatAccounts(accounts));
  io.stdout("");
  io.stdout(result.nextSteps.join("\n"));
}

const INIT_ALREADY_DONE = "This machine already has a wallet, so vapi init created nothing.";

/** What `vapi init` says on a home that is already set up. */
async function reportExistingWallets(store: WalletStore, json: boolean, io: CliIo): Promise<void> {
  const wallets = await store.list();
  if (json) {
    io.stdout(
      JSON.stringify({
        ...walletListResult(store, wallets),
        message: INIT_ALREADY_DONE,
      }),
    );
    return;
  }
  io.stdout(INIT_ALREADY_DONE);
  io.stdout(formatWalletList(wallets));
  io.stdout("");
  io.stdout("Add another wallet with vapi wallet create <name>.");
}

const WALLET_USAGE = "Usage: vapi wallet list|create|use|rename|remove|restore|caps";

/** The wallet manager: everything that names, defaults, caps or retires a key. */
async function walletCommand(
  argv: string[],
  json: boolean,
  io: CliIo,
  dependencies: CliDependencies,
): Promise<void> {
  const subcommand = argv[0];
  const rest = argv.slice(1);
  switch (subcommand) {
    case "list":
      await walletListCommand(rest, json, io);
      return;
    case "create":
      await walletCreateCommand(rest, json, io, dependencies);
      return;
    case "use":
      await walletUseCommand(rest, json, io, dependencies);
      return;
    case "rename":
      await walletRenameCommand(rest, json, io, dependencies);
      return;
    case "remove":
      await walletRemoveCommand(rest, json, io, dependencies);
      return;
    case "restore":
      await walletRestoreCommand(rest, json, io, dependencies);
      return;
    case "caps":
      await walletCapsCommand(rest, json, io, dependencies);
      return;
    case undefined:
      throw new UsageError(WALLET_USAGE);
    default:
      throw new UsageError(
        `Unknown wallet subcommand ${JSON.stringify(subcommand)}. ${WALLET_USAGE}`,
      );
  }
}

async function walletListCommand(argv: string[], json: boolean, io: CliIo): Promise<void> {
  requireNoArguments(argv, "wallet list");
  const store = await openWalletStore();
  const wallets = await store.list();
  output(io, json, walletListResult(store, wallets), formatWalletList(wallets));
}

/**
 * Creates another wallet on this machine, with the same custody notice, the
 * same passphrase confirmation and the same one-time phrase as `vapi init`.
 * No network call: a fresh wallet has nothing to look up.
 */
async function walletCreateCommand(
  argv: string[],
  json: boolean,
  io: CliIo,
  dependencies: CliDependencies,
): Promise<void> {
  const parsed = parseArguments(argv, {
    valueOptions: new Set(["--networks", "--label"]),
    maximumPositionals: 1,
  });
  const name = assertWalletName(
    requiredPositional(parsed.positionals[0], "Usage: vapi wallet create <name>"),
  );
  const networks = parseInitNetworks(parsed.one("--networks") ?? "base");
  const enableSolana = networks.includes("solana");
  const label = parsed.one("--label");
  const store = await openWalletStore();
  if (store.has(name)) {
    throw new KeystoreError(`Wallet ${name} already exists. Choose another name.`);
  }

  if (!json) io.stdout(CUSTODY_NOTICE);
  const passphrase = await getKeystorePassphrase({ confirm: true });
  const created = await store.create(name, passphrase, {
    enableSolana,
    ...(label === undefined ? {} : { label }),
  });
  await recordAudit(dependencies, "wallet.create", { wallet: created.name });
  let account = created.account;
  if (enableSolana && !account.solana) {
    account = await enableSolanaKey(passphrase, created.path);
  }
  if (!json) await showRecoveryPhrase(created.recoveryPhrase, io, dependencies);

  const isDefault = store.defaultName === created.name;
  const result = {
    address: account.address,
    ...(account.solana ? { solanaAddress: account.solana.address } : {}),
    keystore: created.path,
    ...(label === undefined ? {} : { label }),
    spendCaps: created.entry.spendCaps,
    isDefault,
    custody: "self",
    warning: CUSTODY_NOTICE,
    recoveryPhrase: "hidden",
    message: `Wallet ${created.name} created. Its encrypted key stays on this machine.`,
  };
  outputForWallet(
    io,
    json,
    { name: created.name, address: account.address },
    result,
    [
      result.message,
      `Address: ${account.address}`,
      ...(account.solana ? [`Solana address: ${account.solana.address}`] : []),
      `Keystore: ${created.path}`,
      `Spend caps: ${formatCaps(created.entry.spendCaps)}`,
      isDefault
        ? "It is the default wallet."
        : `Pay from it with vapi pay <ref> --wallet ${created.name}, or make it the default with vapi wallet use ${created.name}.`,
    ].join("\n"),
  );
}

/** Sets the wallet every command uses when nothing else selects one. */
async function walletUseCommand(
  argv: string[],
  json: boolean,
  io: CliIo,
  dependencies: CliDependencies,
): Promise<void> {
  const parsed = parseArguments(argv, { valueOptions: new Set(), maximumPositionals: 1 });
  const name = requiredPositional(parsed.positionals[0], "Usage: vapi wallet use <name>");
  const store = await openWalletStore();
  const wallet = store.resolve({ name, env: {} });
  await store.setDefault(wallet.name);
  await recordAudit(dependencies, "wallet.default", { wallet: wallet.name });
  const address = await store.readAddress(wallet.name);
  outputForWallet(
    io,
    json,
    { name: wallet.name, ...(address === undefined ? {} : { address }) },
    {
      ...(address === undefined ? {} : { address }),
      default: wallet.name,
      message: `Default wallet is now ${wallet.name}.`,
    },
    `Default wallet is now ${wallet.name}.`,
  );
}

/** Renames a wallet everywhere: the keystore file, the registry, its receipts. */
async function walletRenameCommand(
  argv: string[],
  json: boolean,
  io: CliIo,
  dependencies: CliDependencies,
): Promise<void> {
  const parsed = parseArguments(argv, { valueOptions: new Set(), maximumPositionals: 2 });
  const from = requiredPositional(parsed.positionals[0], "Usage: vapi wallet rename <old> <new>");
  const to = requiredPositional(parsed.positionals[1], "Usage: vapi wallet rename <old> <new>");
  const store = await openWalletStore();
  const renamed = await store.rename(from, to);
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
      keystore: renamed.path,
      message: `Wallet ${from} is now ${renamed.name}.`,
    },
    [`Wallet ${from} is now ${renamed.name}.`, `Keystore: ${renamed.path}`].join("\n"),
  );
}

const REMOVE_NEEDS_TERMINAL =
  "Removing a wallet needs a terminal, so a person can type its name. Run vapi wallet remove yourself, or pass --force.";

/**
 * Retires a wallet without destroying it: the encrypted keystore moves to
 * `wallets/.trash/`, where the same passphrase still opens it. A funded wallet
 * and the default wallet are refused, and a person types the name first.
 */
async function walletRemoveCommand(
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
  const name = requiredPositional(parsed.positionals[0], "Usage: vapi wallet remove <name>");
  const force = parsed.has("--force");
  const store = await openWalletStore();
  const wallet = store.resolve({ name, env: {} });
  const address = await store.readAddress(wallet.name);

  if (isInteractive(dependencies)) {
    await confirmWalletName(
      wallet.name,
      `Type ${wallet.name} to remove it: `,
      "That is not the wallet name. Nothing was removed.",
      dependencies,
    );
  } else if (!force) {
    throw new KeystoreError(REMOVE_NEEDS_TERMINAL);
  }

  const config = await readConfig(getVapiPaths().config, io);
  const trashed = await store.remove(wallet.name, {
    force,
    balanceReader: baseUsdcBalanceReader(config, dependencies),
  });
  await recordAudit(dependencies, "wallet.remove", { wallet: trashed.name });
  outputForWallet(
    io,
    json,
    { name: trashed.name, ...(address === undefined ? {} : { address }) },
    {
      ...(address === undefined ? {} : { address }),
      removedAt: trashed.removedAt,
      trash: trashed.path,
      message: `Wallet ${trashed.name} removed. Its encrypted keystore is kept.`,
    },
    [
      `Wallet ${trashed.name} removed. Its encrypted keystore is kept.`,
      `Trash: ${trashed.path}`,
      `Bring it back with vapi wallet restore ${trashed.name}.`,
    ].join("\n"),
  );
}

async function walletRestoreCommand(
  argv: string[],
  json: boolean,
  io: CliIo,
  dependencies: CliDependencies,
): Promise<void> {
  const parsed = parseArguments(argv, { valueOptions: new Set(), maximumPositionals: 1 });
  const name = requiredPositional(parsed.positionals[0], "Usage: vapi wallet restore <name>");
  const store = await openWalletStore();
  const restored = await store.restore(name);
  await recordAudit(dependencies, "wallet.restore", { wallet: restored.name });
  const address = await store.readAddress(restored.name);
  outputForWallet(
    io,
    json,
    { name: restored.name, ...(address === undefined ? {} : { address }) },
    {
      ...(address === undefined ? {} : { address }),
      keystore: restored.path,
      spendCaps: restored.entry.spendCaps,
      message: `Wallet ${restored.name} restored. Its passphrase is unchanged.`,
    },
    [
      `Wallet ${restored.name} restored. Its passphrase is unchanged.`,
      `Keystore: ${restored.path}`,
    ].join("\n"),
  );
}

/** Per-wallet spend caps, in US dollars, converted to atomic USDC on the way in. */
async function walletCapsCommand(
  argv: string[],
  json: boolean,
  io: CliIo,
  dependencies: CliDependencies,
): Promise<void> {
  const parsed = parseArguments(argv, {
    valueOptions: new Set(["--per-call", "--per-day"]),
    maximumPositionals: 1,
  });
  const name = requiredPositional(parsed.positionals[0], "Usage: vapi wallet caps <name>");
  const perCall = parsed.one("--per-call");
  const perDay = parsed.one("--per-day");
  const store = await openWalletStore();
  const wallet = store.resolve({ name, env: {} });
  const address = await store.readAddress(wallet.name);
  if (perCall === undefined && perDay === undefined) {
    output(
      io,
      json,
      {
        wallet: wallet.name,
        ...(address === undefined ? {} : { address }),
        spendCaps: wallet.entry.spendCaps,
        ...capsInUsd(wallet.entry.spendCaps),
      },
      [
        walletHeader({ name: wallet.name, ...(address === undefined ? {} : { address }) }),
        `Spend caps: ${formatCaps(wallet.entry.spendCaps)}`,
        "Change them with --per-call <usd> or --per-day <usd>.",
      ].join("\n"),
    );
    return;
  }

  const spendCaps: SpendCaps = {
    perCallAtomic:
      perCall === undefined
        ? wallet.entry.spendCaps.perCallAtomic
        : capAtomic(perCall, "--per-call"),
    perDayAtomic:
      perDay === undefined ? wallet.entry.spendCaps.perDayAtomic : capAtomic(perDay, "--per-day"),
  };
  if (BigInt(spendCaps.perCallAtomic) > BigInt(spendCaps.perDayAtomic)) {
    throw new UsageError("The per-call cap cannot be larger than the per-day cap.");
  }
  const entry = await store.setSpendCaps(wallet.name, spendCaps);
  await recordAudit(dependencies, "wallet.caps", {
    wallet: wallet.name,
    detail: formatCaps(entry.spendCaps),
  });
  outputForWallet(
    io,
    json,
    { name: wallet.name, ...(address === undefined ? {} : { address }) },
    {
      ...(address === undefined ? {} : { address }),
      spendCaps: entry.spendCaps,
      ...capsInUsd(entry.spendCaps),
      message: `Spend caps updated for ${wallet.name}.`,
    },
    [`Spend caps updated for ${wallet.name}.`, `Spend caps: ${formatCaps(entry.spendCaps)}`].join(
      "\n",
    ),
  );
}

/** A US dollar cap, as the atomic USDC the spend policy compares against. */
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

function formatCaps(caps: SpendCaps): string {
  const usd = capsInUsd(caps);
  return `${usd.perCallUsd} USD per call, ${usd.perDayUsd} USD per day`;
}

function walletListResult(
  store: WalletStore,
  wallets: readonly WalletInfo[],
): { default: string | null; wallets: unknown[] } {
  return {
    default: store.defaultName ?? null,
    wallets: wallets.map((wallet) => ({
      name: wallet.name,
      ...(wallet.address === undefined ? {} : { address: wallet.address }),
      ...(wallet.solanaAddress === undefined ? {} : { solanaAddress: wallet.solanaAddress }),
      isDefault: wallet.isDefault,
      ...(wallet.label === undefined ? {} : { label: wallet.label }),
      createdAt: wallet.createdAt,
      spendCaps: wallet.spendCaps,
      ...capsInUsd(wallet.spendCaps),
      keystore: wallet.path,
      ...(wallet.keystoreVersion === undefined ? {} : { keystoreVersion: wallet.keystoreVersion }),
    })),
  };
}

/** One row per wallet: the default marked, the caps in dollars, the label last. */
function formatWalletList(wallets: readonly WalletInfo[]): string {
  if (wallets.length === 0) return "No wallets yet. Run vapi init.";
  return [
    "  NAME\tADDRESS\tPER-CALL USD\tPER-DAY USD\tLABEL",
    ...wallets.map((wallet) => {
      const usd = capsInUsd(wallet.spendCaps);
      return [
        `${wallet.isDefault ? "*" : " "} ${wallet.name}`,
        wallet.address ?? "unreadable",
        usd.perCallUsd,
        usd.perDayUsd,
        wallet.label ?? "",
      ].join("\t");
    }),
    "",
    "* is the default wallet. Change it with vapi wallet use <name>.",
  ].join("\n");
}

/**
 * The Base USDC balance of an address, read the way `vapi accounts` reads it,
 * so removing a wallet can refuse to walk away from money.
 */
function baseUsdcBalanceReader(
  config: VapiConfig,
  dependencies: CliDependencies,
): WalletBalanceReader {
  return async (address: string) => {
    const accounts = await listAccounts({
      address,
      config,
      ...(dependencies.fetchImpl ? { fetchImpl: dependencies.fetchImpl } : {}),
    });
    const base = accounts.find((account) => account.caip2 === BASE_MAINNET_CAIP2);
    if (!base?.usdcBalance) {
      throw new KeystoreError(
        [
          `Could not read the USDC balance of ${address} on Base${base?.error ? `: ${base.error}` : "."}`,
          "Re-run with --force to remove the wallet anyway.",
        ].join("\n"),
      );
    }
    return BigInt(base.usdcBalance.atomic);
  };
}

/**
 * Hand out the hosted funding page. No registry call: the page itself mints the
 * card session when the human clicks, so this works offline and the link never
 * expires in a scrollback.
 */
async function fundCommand(
  argv: string[],
  json: boolean,
  io: CliIo,
  dependencies: CliDependencies,
): Promise<void> {
  const parsed = parseArguments(argv, {
    valueOptions: new Set(["--amount", WALLET_OPTION]),
    maximumPositionals: 0,
  });
  const amount = optionalUsdAmount(parsed.one("--amount"), "--amount");
  const target = await targetWallet(parsed, dependencies);
  const account = await unlockKeystore(await getKeystorePassphrase(), target.path);
  const url = fundingPageUrl(
    resolveRegistryUrl(),
    account.address,
    amount === undefined ? {} : { amount },
  );
  const opened = Boolean(process.stdout.isTTY) && openInBrowser(url);
  const result = { address: account.address, network: ONRAMP_NETWORK, url };
  outputForWallet(io, json, target, result, formatFund(result.address, url, opened));
}

async function searchCommand(
  argv: string[],
  json: boolean,
  io: CliIo,
  dependencies: CliDependencies,
): Promise<void> {
  const parsed = parseArguments(argv, {
    valueOptions: new Set(["--kind", "--network", "--limit", "--cursor"]),
    repeatableOptions: new Set(["--kind"]),
    maximumPositionals: 1,
  });
  const limit = optionalPositiveInteger(parsed.one("--limit"), "--limit");
  const config = await readConfig(getVapiPaths().config, io);
  const page = await searchMarketplace(
    {
      ...(parsed.positionals[0] ? { query: parsed.positionals[0] } : {}),
      ...(parsed.many("--kind").length > 0
        ? { kinds: parsed.many("--kind") as Array<"api" | "service_offer" | "open_request"> }
        : {}),
      ...(parsed.one("--network") ? { network: parsed.one("--network") } : {}),
      ...(limit === undefined ? {} : { limit }),
      ...(parsed.one("--cursor") ? { cursor: parsed.one("--cursor") } : {}),
    },
    config,
    dependencies.fetchImpl,
    { searchesPath: getVapiPaths().searches, notice: io.stderr },
  );
  output(io, json, page, formatSearch(page));
}

async function inspectCommand(
  argv: string[],
  json: boolean,
  io: CliIo,
  dependencies: CliDependencies,
): Promise<void> {
  const parsed = parseArguments(argv, {
    valueOptions: new Set(["--endpoint"]),
    maximumPositionals: 1,
  });
  const id = requiredPositional(
    parsed.positionals[0],
    "Usage: vapi inspect <id> [--endpoint <name>]",
  );
  const config = await readConfig(getVapiPaths().config, io);
  const result = await inspectService(
    { id, ...(parsed.one("--endpoint") ? { endpoint: parsed.one("--endpoint") } : {}) },
    config,
    dependencies.fetchImpl,
  );
  output(io, json, result, JSON.stringify(result, null, 2));
}

async function payCommand(
  argv: string[],
  json: boolean,
  io: CliIo,
  dependencies: CliDependencies,
): Promise<void> {
  const parsed = parseArguments(argv, {
    valueOptions: new Set([
      "--method",
      "--endpoint",
      "--body",
      "--content-type",
      "--network",
      "--expected-pay-to",
      "--max",
      "--max-price-usd",
      WALLET_OPTION,
    ]),
    maximumPositionals: 1,
  });
  const target = requiredPositional(parsed.positionals[0], "Usage: vapi pay <id-or-url> [options]");
  const paths = getVapiPaths();
  const config = await readConfig(paths.config, io);
  const wallet = await targetWallet(parsed, dependencies);
  const spendCaps = await spendCapsForWallet(wallet.store, wallet.name);
  const account = await unlockKeystore(await getKeystorePassphrase(), wallet.path);
  const bodyText = parsed.one("--body");
  const maxPriceUsd = aliasedOption(parsed, "--max", "--max-price-usd");
  const input = {
    ...(isHttpUrl(target) ? { url: target } : { id: target }),
    ...(parsed.one("--method") ? { method: parsed.one("--method") } : {}),
    ...(parsed.one("--endpoint") ? { endpoint: parsed.one("--endpoint") } : {}),
    ...(bodyText === undefined ? {} : { body: parseJson(bodyText, "--body") }),
    ...(parsed.one("--content-type") ? { contentType: parsed.one("--content-type") } : {}),
    ...(parsed.one("--network") ? { network: parsed.one("--network") } : {}),
    ...(parsed.one("--expected-pay-to") ? { expectedPayTo: parsed.one("--expected-pay-to") } : {}),
    ...(maxPriceUsd ? { maxPriceUsd } : {}),
  };
  const result = await callService({
    input,
    account,
    config,
    ledgerPath: paths.ledger,
    receiptsPath: paths.receipts,
    wallet: wallet.name,
    spendCaps,
  });
  outputForWallet(
    io,
    json,
    wallet,
    result as unknown as Record<string, unknown>,
    JSON.stringify(result, null, 2),
  );
}

async function balanceCommand(
  argv: string[],
  json: boolean,
  io: CliIo,
  dependencies: CliDependencies,
): Promise<void> {
  const parsed = parseArguments(argv, {
    valueOptions: new Set([WALLET_OPTION]),
    maximumPositionals: 0,
  });
  const paths = getVapiPaths();
  const config = await readConfig(paths.config, io);
  const target = await targetWallet(parsed, dependencies);
  const account = await unlockKeystore(await getKeystorePassphrase(), target.path);
  const wallet = await getWallet(account, config, dependencies);
  outputForWallet(io, json, target, wallet, formatWallet(wallet));
}

async function accountsCommand(
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
  if (enable !== undefined && enable !== "solana") {
    throw new UsageError("--enable currently supports only solana.");
  }
  const paths = getVapiPaths();
  const target = await targetWallet(parsed, dependencies);
  const passphrase = await getKeystorePassphrase();
  const account = enable
    ? await enableSolanaKey(passphrase, target.path)
    : await unlockKeystore(passphrase, target.path);
  if (enable) await enableDefaultNetwork("solana", paths.config);
  const config = await readConfig(paths.config, io);
  const accounts = await listAccounts({
    address: account.address,
    ...(account.solana ? { solanaAddress: account.solana.address } : {}),
    config,
    ...(dependencies.fetchImpl ? { fetchImpl: dependencies.fetchImpl } : {}),
  });
  outputForWallet(io, json, target, { accounts }, formatAccounts(accounts));
}

const ALL_WALLETS_OPTION = "--all-wallets";

/**
 * The wallet a ledger view is filtered by, or `undefined` for all of them.
 * A home that has no wallet yet — receipts copied in, or a fresh checkout —
 * reads every row rather than failing, but an explicit `--wallet` still must
 * name a wallet that exists.
 */
async function ledgerWallet(
  parsed: { one(name: string): string | undefined; has(name: string): boolean },
  dependencies: CliDependencies,
): Promise<WalletTarget | undefined> {
  if (parsed.has(ALL_WALLETS_OPTION)) {
    if (parsed.one(WALLET_OPTION) !== undefined) {
      throw new UsageError(`${WALLET_OPTION} and ${ALL_WALLETS_OPTION} cannot be used together.`);
    }
    return undefined;
  }
  const store = await openWalletStore();
  if (parsed.one(WALLET_OPTION) === undefined && store.names().length === 0) return undefined;
  return await selectWallet(store, parsed, dependencies);
}

async function receiptsCommand(
  argv: string[],
  json: boolean,
  io: CliIo,
  dependencies: CliDependencies,
): Promise<void> {
  if (argv[0] === "export") {
    await receiptsExportCommand(argv.slice(1), io, dependencies);
    return;
  }
  const parsed = parseArguments(argv, {
    valueOptions: new Set(["--limit", WALLET_OPTION]),
    booleanOptions: new Set([ALL_WALLETS_OPTION]),
    maximumPositionals: 0,
  });
  const limit = optionalNonNegativeInteger(parsed.one("--limit"), "--limit");
  const target = await ledgerWallet(parsed, dependencies);
  const receipts = await readReceipts(getVapiPaths().receipts, {
    ...(limit === undefined ? {} : { limit }),
    ...(target === undefined ? {} : { wallet: target.name }),
  });
  const human = receipts.length === 0 ? "No receipts." : receipts.map(formatReceipt).join("\n");
  if (target === undefined) {
    output(io, json, receipts, human);
    return;
  }
  if (json) {
    io.stdout(JSON.stringify({ wallet: target.name, receipts }));
    return;
  }
  io.stdout(walletHeader(target));
  io.stdout(human);
}

async function receiptsExportCommand(
  argv: string[],
  io: CliIo,
  dependencies: CliDependencies,
): Promise<void> {
  const parsed = parseArguments(argv, {
    valueOptions: new Set(["--format", "--range", WALLET_OPTION]),
    booleanOptions: new Set([ALL_WALLETS_OPTION]),
    maximumPositionals: 0,
  });
  const format = parsed.one("--format");
  if (format !== "json" && format !== "csv") {
    throw new UsageError("--format must be json or csv.");
  }
  const rangeValue = parsed.one("--range");
  const range = rangeValue === undefined ? undefined : parseStatsRange(rangeValue);
  const target = await ledgerWallet(parsed, dependencies);
  const allReceipts = await readReceipts(getVapiPaths().receipts, {
    ...(target === undefined ? {} : { wallet: target.name }),
  });
  const receipts = range ? filterReceiptsByRange(allReceipts, range) : allReceipts;
  io.stdout(format === "json" ? JSON.stringify(receipts) : receiptsToCsv(receipts));
}

async function statsCommand(
  argv: string[],
  json: boolean,
  io: CliIo,
  dependencies: CliDependencies,
): Promise<void> {
  const parsed = parseArguments(argv, {
    valueOptions: new Set(["--range", WALLET_OPTION]),
    booleanOptions: new Set([ALL_WALLETS_OPTION]),
    maximumPositionals: 0,
  });
  const range = parseStatsRange(parsed.one("--range") ?? "24h");
  const paths = getVapiPaths();
  const target = await ledgerWallet(parsed, dependencies);
  const stats = aggregateStats({
    receipts: await readReceipts(paths.receipts, {
      ...(target === undefined ? {} : { wallet: target.name }),
    }),
    searches: await readSearchEvents(paths.searches),
    range,
  });
  if (target === undefined) {
    output(io, json, stats, formatStats(stats));
    return;
  }
  outputForWallet(
    io,
    json,
    target,
    stats as unknown as Record<string, unknown>,
    formatStats(stats),
  );
}

async function sweepCommand(
  argv: string[],
  json: boolean,
  io: CliIo,
  dependencies: CliDependencies,
): Promise<void> {
  const parsed = parseArguments(argv, {
    valueOptions: new Set(["--network", WALLET_OPTION]),
    maximumPositionals: 1,
  });
  const destination = requiredPositional(
    parsed.positionals[0],
    "Usage: vapi sweep <address> [--network <caip2>]",
  );
  const requestedNetwork = parsed.one("--network");
  const paths = getVapiPaths();
  const config = await readConfig(paths.config, io);
  const target = await targetWallet(parsed, dependencies);
  const account = await unlockKeystore(await getKeystorePassphrase(), target.path);
  if (requestedNetwork && !isNetworkConfigured(config.networks, requestedNetwork)) {
    throw new Error(`Network ${requestedNetwork} is not configured.`);
  }

  const results: Array<
    | { network: string; status: "swept"; amountAtomic: string; transaction: string }
    | { network: string; status: "error"; error: string }
  > = [];
  for (const network of requestedNetwork ? [requestedNetwork] : Object.keys(config.networks)) {
    try {
      const result = await sweepBack({ account, config, network, destination });
      results.push({ ...result, status: "swept" });
    } catch (error) {
      if (requestedNetwork) throw error;
      results.push({
        network,
        status: "error",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (!results.some((result) => result.status === "swept")) {
    throw new Error("No configured network had a sweepable USDC balance.");
  }
  outputForWallet(io, json, target, { results }, formatSweepResults(results));
}

async function reportCommand(
  argv: string[],
  json: boolean,
  io: CliIo,
  dependencies: CliDependencies,
): Promise<void> {
  const parsed = parseArguments(argv, {
    valueOptions: new Set(),
    booleanOptions: new Set(["--include-addresses", "--send"]),
    maximumPositionals: 1,
  });
  const message = requiredPositional(
    parsed.positionals[0],
    'Usage: vapi report "<what happened>" [--include-addresses] [--send]',
  );
  const paths = getVapiPaths();
  const result = await createSupportReport({
    message,
    includeAddresses: parsed.has("--include-addresses"),
    send: parsed.has("--send"),
    receiptsPath: paths.receipts,
    ...(dependencies.fetchImpl ? { fetchImpl: dependencies.fetchImpl } : {}),
  });
  output(io, json, result, formatSupportReport(result));
}

const EXPORT_KEY_WARNING =
  "Anyone with this key can spend the wallet. Never paste it into a website or chat.";

/**
 * Prints the private key of one wallet, to a person, on a terminal. The agent
 * gate runs before the passphrase is read, and the person types the wallet name
 * first, so a key never appears because a tool call asked for it.
 */
async function exportKeyCommand(
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
  await requireSecretsAllowed(dependencies, "secret.export.key", target.name);
  await confirmWalletName(
    target.name,
    `Type ${target.name} to print its private key: `,
    "That is not the wallet name. Nothing was printed.",
    dependencies,
  );
  const keys = await exportKeystoreKeys(await getKeystorePassphrase(), target.path);
  if (solana && !keys.solana) {
    throw new Error(
      `No Solana key is enabled in ${target.path}. Run vapi accounts --enable solana first.`,
    );
  }
  const selected = solana && keys.solana ? keys.solana : keys.evm;
  const result = {
    network,
    address: selected.address,
    privateKey: "secretKey" in selected ? selected.secretKey : selected.privateKey,
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
 * same gate and the same typed confirmation as `vapi export-key`. Wallets
 * created before version 3 have no phrase, so they get the route that does back
 * them up instead.
 */
async function backupCommand(
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
  await requireSecretsAllowed(dependencies, "secret.export.phrase", target.name);
  await confirmWalletName(
    target.name,
    `Type ${target.name} to print its recovery phrase: `,
    "That is not the wallet name. Nothing was printed.",
    dependencies,
  );
  io.stderr(BACKUP_WARNING);
  const passphrase = await getKeystorePassphrase();
  let recoveryPhrase: string;
  try {
    recoveryPhrase = await exportRecoveryPhrase(passphrase, target.path);
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
  await recordAudit(dependencies, "secret.export.phrase", { wallet: target.name });
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
async function importCommand(
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
  const enableSolana = networks.includes("solana");
  if (!fromPhrase && enableSolana) {
    throw new UsageError(
      "vapi import --key imports one EVM key, so --networks cannot include solana. Import the recovery phrase instead.",
    );
  }

  const paths = getVapiPaths();
  const store = await openWalletStore();
  const name = importWalletName(store, parsed, dependencies);
  const existed = store.has(name);
  if (existed && !parsed.has("--replace")) {
    const address = await store.readAddress(name);
    throw new Error(
      [
        `Wallet ${name} already exists at ${store.pathFor(name)}.`,
        ...(address ? [`Address: ${address}`] : []),
        "Write its recovery phrase down with vapi backup first, then re-run with --replace.",
      ].join("\n"),
    );
  }

  const prompts = getPrompts(dependencies);
  const secret = fromPhrase
    ? validateRecoveryPhrase(await prompts.secret("Recovery phrase: "))
    : validatePrivateKey(await prompts.secret("Private key: "));
  const passphrase = await getKeystorePassphrase({ confirm: true });
  // Only now, with both secrets in hand, is the existing wallet moved: a failed
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
    ? await store.create(name, passphrase, { phrase: secret, enableSolana })
    : await store.importKey(name, passphrase, secret);
  await recordAudit(dependencies, "wallet.import", { wallet: imported.name });
  const account = imported.account;

  if (!(await fileExists(paths.config))) {
    await writeDefaultConfig(paths.config, process.env, { networks });
  } else if (enableSolana) {
    await enableDefaultNetwork("solana", paths.config);
  }
  const result = {
    address: account.address,
    ...(account.solana ? { solanaAddress: account.solana.address } : {}),
    keystore: imported.path,
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
      `Keystore: ${imported.path}`,
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
      "Name the wallet to import with vapi import --wallet <name>.",
    ].join("\n"),
  );
}

/** Re-encrypts the same wallet under a new passphrase; the addresses stay. */
async function passphraseCommand(
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
  const prompts = getPrompts(dependencies);
  const current = await getKeystorePassphrase();
  const next = await prompts.secret("New passphrase: ");
  if (next.length === 0) throw new KeystoreError("Keystore passphrase cannot be empty.");
  if (next === current) {
    throw new KeystoreError("The new passphrase must differ from the current one.");
  }
  if ((await prompts.secret("Confirm new passphrase: ")) !== next) {
    throw new KeystoreError("Passphrases do not match.");
  }
  const account = await changeKeystorePassphrase(current, next, target.path);
  await recordAudit(dependencies, "passphrase.change", { wallet: target.name });
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

async function mcpCommand(argv: string[], dependencies: CliDependencies): Promise<void> {
  const parsed = parseArguments(argv, {
    valueOptions: new Set([WALLET_OPTION]),
    maximumPositionals: 0,
  });
  const paths = getVapiPaths();
  const config = await loadConfig(paths.config);
  // Resolving the wallet prints nothing: an MCP server owns stdout.
  const target = await targetWallet(parsed, dependencies);
  // Read the passphrase and unlock before connecting stdio, so a prompt can
  // never corrupt MCP frames and a wrong passphrase fails now rather than at
  // the first payment. The server keeps it to unlock whichever wallet a tool
  // call names; Release 3 moves it into the OS secret store.
  const passphrase = await getKeystorePassphrase();
  const account = await unlockKeystore(passphrase, target.path);
  await startStdioServer({
    account,
    config,
    store: target.store,
    wallet: target.name,
    env: getEnvironment(dependencies),
    passphrase: () => passphrase,
    ledgerPath: paths.ledger,
    receiptsPath: paths.receipts,
    searchesPath: paths.searches,
  });
}

/** Loads the config and reports any retired registry URL it had to repair. */
async function readConfig(path: string, io: CliIo): Promise<VapiConfig> {
  return await loadConfig(path, process.env, { notice: io.stderr });
}

function output(io: CliIo, json: boolean, value: unknown, human: string): void {
  io.stdout(json ? JSON.stringify(value) : human);
}

function outputStub(io: CliIo, json: boolean): void {
  const message = "gateway daemon lands in 0.3";
  if (json) io.stdout(JSON.stringify({ error: message, exitCode: 2 }));
  else io.stderr(message);
}

/**
 * One block per listing. The group tag is the shortest honest answer to "whose
 * API is this", and the fee label is the registry's own disclosure of what is
 * already inside the price, so neither is recomputed here.
 */
function formatSearch(page: Awaited<ReturnType<typeof searchMarketplace>>): string {
  if (page.items.length === 0) return "No listings found.";
  return page.items
    .map((item) =>
      [
        `${item.ref}\t${item.kind}\t${item.group ? `[${item.group}] ` : ""}${item.card.title}`,
        `  ${item.card.summary}`,
        ...(item.fee ? [`  Fee: ${item.fee.label}`] : []),
      ].join("\n"),
    )
    .join("\n");
}

function formatWallet(wallet: Awaited<ReturnType<typeof getWallet>>): string {
  return [`Address: ${wallet.address}`, ...formatBalanceLines(wallet)].join("\n");
}

function formatBalanceLines(wallet: Awaited<ReturnType<typeof getWallet>>): string[] {
  return wallet.balances.map((entry) =>
    entry.error
      ? `${entry.name} (${entry.network}): unavailable — ${entry.error}`
      : `${entry.name} (${entry.network}): ${entry.usdc} USDC (${entry.usdcAtomic} atomic)`,
  );
}

function formatFund(address: string, url: string, opened: boolean): string {
  return [
    `Address: ${address}`,
    `Fund: ${url}`,
    ...(opened ? ["Opened in your default browser."] : []),
    "The page takes a card via Coinbase (needs a Coinbase account; US guest checkout), a transfer from MetaMask/Coinbase Wallet/WalletConnect, or a bridge from another chain. vAPI never holds your funds.",
    ONRAMP_FALLBACK_INSTRUCTIONS,
  ].join("\n");
}

/**
 * Open a funding URL without ever failing the command: a headless or locked-down
 * machine simply keeps the printed link.
 */
function openInBrowser(url: string): boolean {
  const opener =
    process.platform === "darwin"
      ? { command: "open", args: [url] }
      : process.platform === "win32"
        ? { command: "cmd", args: ["/c", "start", "", url] }
        : { command: "xdg-open", args: [url] };
  try {
    const child = spawn(opener.command, opener.args, { stdio: "ignore", detached: true });
    child.on("error", () => undefined);
    child.unref();
    return true;
  } catch {
    return false;
  }
}

const CUSTODY_NOTICE = [
  "This wallet is yours. vAPI has no copy of the key and cannot recover it.",
  "If you lose this machine and your recovery phrase, the funds are gone.",
].join("\n");

const PHRASE_GATE = "Write these 12 words down, then press Enter.";
const PHRASE_HIDDEN = "Recovery phrase: run vapi backup yourself in a terminal to see it.";

/**
 * The phrase is shown once, to a person, and waits until they say they have it.
 * A script, a piped run or anything an agent drives gets the pointer to
 * `vapi backup` instead: the wallet is still created, but nothing here may end
 * up in a transcript or a log file.
 */
async function showRecoveryPhrase(
  phrase: string,
  io: CliIo,
  dependencies: CliDependencies,
): Promise<void> {
  if (!secretsDecision(dependencies).allowed) {
    io.stdout(PHRASE_HIDDEN);
    return;
  }
  io.stdout("");
  io.stdout("Recovery phrase. These 12 words restore this wallet, and nothing else does:");
  io.stdout(formatRecoveryPhrase(phrase));
  io.stdout("");
  await getPrompts(dependencies).secret(`${PHRASE_GATE} `);
}

/** One numbered word per line: the shape people copy onto paper without slips. */
function formatRecoveryPhrase(phrase: string): string {
  return phrase
    .split(" ")
    .map((word, index) => `${String(index + 1).padStart(2, " ")}. ${word}`)
    .join("\n");
}

function buildNextSteps(address: string): string[] {
  return [
    formatNextStep("Address", address, "(copy this to fund it)"),
    formatNextStep("Back up", "vapi backup", "(write the 12 words down; vAPI cannot recover them)"),
    formatNextStep("Fund", "vapi fund", "(card via Coinbase, a wallet transfer, or a bridge)"),
    formatNextStep("Search", 'vapi search "weather"'),
    formatNextStep("Pay", "vapi pay <ref> --max 0.02"),
    formatNextStep(
      "Agent",
      'add {"command":"npx","args":["-y","vapi-network","mcp"]} to your MCP config',
    ),
  ];
}

function formatNextStep(label: string, value: string, note?: string): string {
  const step = `${label.padEnd(10)}${value}`;
  return note === undefined ? step : `${step.padEnd(52)} ${note}`;
}

/** Print the welcome banner once; it adapts to the terminal's width and colour support. */
function showBanner(io: CliIo): void {
  io.stdout(
    renderBanner({
      version: CLI_VERSION,
      colorLevel: detectColorLevel(),
      columns: process.stdout.columns,
    }),
  );
}

function formatAccounts(accounts: readonly AccountInfo[]): string {
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

function formatSupportReport(result: Awaited<ReturnType<typeof createSupportReport>>): string {
  return [
    `Report: ${result.path}`,
    `GitHub: ${result.issueUrl}`,
    ...(result.responseCode === undefined ? [] : [`Send response: HTTP ${result.responseCode}`]),
  ].join("\n");
}

function formatReceipt(receipt: Awaited<ReturnType<typeof readReceipts>>[number]): string {
  const status =
    receipt.settlement?.outcome ?? (receipt.error ? "error" : (receipt.status ?? "recorded"));
  return `${receipt.timestamp}\t${status}\t${receipt.method ?? "GET"} ${receipt.resourceUrl}`;
}

function formatStats(stats: ReturnType<typeof aggregateStats>): string {
  const lines = [
    `Metrics (${stats.range}, generated ${stats.generatedAt})`,
    "TOTALS\tVALUE",
    `Spend (USD)\t${stats.totals.spendUsd}`,
    `Calls\t${stats.totals.calls}`,
    `Unique APIs\t${stats.totals.uniqueApis}`,
    `Policy declines\t${stats.totals.policyDeclines}`,
    "",
    "OUTCOME\tCOUNT\tRATE",
    ...Object.entries(stats.outcomes).map(
      ([outcome, value]) => `${outcome}\t${value.count}\t${formatRate(value.rate)}`,
    ),
    "",
    "LATENCY\tP50 MS\tP95 MS",
    `total\t${formatLatency(stats.latency.total.p50Ms)}\t${formatLatency(stats.latency.total.p95Ms)}`,
    ...Object.entries(stats.latency.phases).map(
      ([phase, value]) => `${phase}\t${formatLatency(value.p50Ms)}\t${formatLatency(value.p95Ms)}`,
    ),
    "",
    "TOP BY SPEND\tUSD\tCALLS",
    ...stats.topServices.bySpend.map(
      (service) => `${service.name}\t${service.spendUsd}\t${service.calls}`,
    ),
    "",
    "TOP BY CALLS\tCALLS\tUSD",
    ...stats.topServices.byCalls.map(
      (service) => `${service.name}\t${service.calls}\t${service.spendUsd}`,
    ),
    "",
    "SEARCH\tVALUE",
    `Count\t${stats.search.count}`,
    `Zero-result rate\t${formatRate(stats.search.zeroResultRate)}`,
    "SOURCE\tSEARCHES\tP95 MS",
    ...Object.entries(stats.search.sources).map(
      ([source, value]) => `${source}\t${value.count}\t${formatLatency(value.p95Ms)}`,
    ),
  ];
  return lines.join("\n");
}

function formatRate(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function formatLatency(value: number | null): string {
  return value === null ? "—" : String(value);
}

function formatSweepResults(
  results: Array<
    | { network: string; status: "swept"; amountAtomic: string; transaction: string }
    | { network: string; status: "error"; error: string }
  >,
): string {
  return results
    .map((result) => {
      const name = getNetworkDefinition(result.network).name;
      if (result.status === "error") return `${name}: ${result.error}`;
      const retained =
        result.network === ARC_TESTNET_CAIP2
          ? ` (retained ${formatUsdc(getArcGasHeadroomAtomic())} USDC for gas)`
          : "";
      return `${name}: swept ${formatUsdc(BigInt(result.amountAtomic))} USDC in ${result.transaction}${retained}`;
    })
    .join("\n");
}

type ArgumentSpec = {
  valueOptions: Set<string>;
  booleanOptions?: Set<string>;
  repeatableOptions?: Set<string>;
  maximumPositionals: number;
};

function parseArguments(argv: string[], spec: ArgumentSpec) {
  const positionals: string[] = [];
  const options = new Map<string, string[]>();
  const flags = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (!argument.startsWith("--")) {
      positionals.push(argument);
      continue;
    }
    if (spec.booleanOptions?.has(argument)) {
      if (flags.has(argument)) throw new UsageError(`${argument} may only be provided once.`);
      flags.add(argument);
      continue;
    }
    if (!spec.valueOptions.has(argument)) throw new UsageError(`Unknown option ${argument}.`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new UsageError(`Expected ${argument} <value>.`);
    index += 1;
    const previous = options.get(argument) ?? [];
    if (previous.length > 0 && !spec.repeatableOptions?.has(argument)) {
      throw new UsageError(`${argument} may only be provided once.`);
    }
    options.set(argument, [...previous, value]);
  }
  if (positionals.length > spec.maximumPositionals) {
    throw new UsageError("Too many positional arguments.");
  }
  return {
    positionals,
    one: (name: string) => options.get(name)?.[0],
    many: (name: string) => options.get(name) ?? [],
    has: (name: string) => flags.has(name),
  };
}

function removeJsonFlag(argv: string[]): { args: string[]; json: boolean } {
  let json = false;
  const args: string[] = [];
  for (const argument of argv) {
    if (argument !== "--json") {
      args.push(argument);
      continue;
    }
    if (json) throw new UsageError("--json may only be provided once.");
    json = true;
  }
  return { args, json };
}

function requireNoArguments(argv: string[], command: string): void {
  if (argv.length > 0) throw new UsageError(`${command} does not accept arguments.`);
}

function requiredPositional(value: string | undefined, usage: string): string {
  if (!value) throw new UsageError(usage);
  return value;
}

function optionalPositiveInteger(value: string | undefined, option: string): number | undefined {
  const result = optionalNonNegativeInteger(value, option);
  if (result === 0) throw new UsageError(`${option} must be a positive integer.`);
  return result;
}

function optionalUsdAmount(value: string | undefined, option: string): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+(?:\.\d{1,2})?$/.test(value)) {
    throw new UsageError(`${option} must be a US dollar amount such as 20 or 19.99.`);
  }
  const parsed = Number(value);
  if (parsed <= 0) throw new UsageError(`${option} must be greater than zero.`);
  if (parsed > 100_000) throw new UsageError(`${option} must be at most 100000.`);
  return parsed;
}

function optionalNonNegativeInteger(value: string | undefined, option: string): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value)) throw new UsageError(`${option} must be a non-negative integer.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new UsageError(`${option} is too large.`);
  return parsed;
}

function parseStatsRange(value: string): StatsRange {
  if ((STATS_RANGES as readonly string[]).includes(value)) return value as StatsRange;
  throw new UsageError(`--range must be one of ${STATS_RANGES.join(", ")}.`);
}

function parseJson(value: string, option: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new UsageError(`${option} must contain valid JSON.`);
  }
}

function aliasedOption(
  parsed: { one(name: string): string | undefined },
  preferred: string,
  legacy: string,
): string | undefined {
  const preferredValue = parsed.one(preferred);
  const legacyValue = parsed.one(legacy);
  if (preferredValue !== undefined && legacyValue !== undefined) {
    throw new UsageError(`${preferred} and ${legacy} cannot be used together.`);
  }
  return preferredValue ?? legacyValue;
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isMissingFile(error)) return false;
    throw error;
  }
}

function parseInitNetworks(value: string): string[] {
  const networks = value
    .split(",")
    .map((network) => network.trim().toLowerCase())
    .filter(Boolean);
  if (networks.length === 0 || new Set(networks).size !== networks.length) {
    throw new UsageError("--networks must be a comma-separated list without duplicates.");
  }
  for (const network of networks) {
    if (network !== "base" && network !== "solana") {
      throw new UsageError("--networks supports base and solana.");
    }
  }
  return networks;
}
