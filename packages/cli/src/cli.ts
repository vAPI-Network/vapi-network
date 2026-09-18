import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";

import {
  ARC_TESTNET_CAIP2,
  BASE_MAINNET_CAIP2,
  STATS_RANGES,
  aggregateStats,
  createOnrampSession,
  createSupportReport,
  createKeystore,
  enableDefaultNetwork,
  enableSolanaKey,
  exportKeystoreKeys,
  filterReceiptsByRange,
  formatLegacyRegistryRewrites,
  formatUsdc,
  getArcGasHeadroomAtomic,
  getKeystorePassphrase,
  getNetworkDefinition,
  getVapiPaths,
  isMissingFile,
  isNetworkConfigured,
  isSolanaNetwork,
  loadConfig,
  listAccounts,
  migrateLegacyRegistryConfig,
  migrateLegacyVapiHome,
  readKeystoreAddress,
  readReceipts,
  readSearchEvents,
  receiptsToCsv,
  sweepBack,
  unlockKeystore,
  writeDefaultConfig,
  type StatsRange,
  type AccountInfo,
  type VapiConfig,
} from "@vapi-network/core";
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
  vapi fund [--amount <usd>] [--json]
  vapi accounts [--enable solana] [--json]
  vapi search [query] [--kind <kind>] [--network <caip2>] [--limit <n>] [--cursor <cursor>] [--json]
  vapi inspect <id> [--endpoint <name>] [--json]
  vapi pay <id-or-url> [--method <method>] [--endpoint <name>] [--body <json>] [--content-type <type>] [--network <caip2>] [--expected-pay-to <address>] [--max <amount>] [--json]
  vapi balance [--json]
  vapi receipts [--limit <n>] [--json]
  vapi receipts export --format <json|csv> [--range <24h|7d|30d>]
  vapi stats [--range <24h|7d|30d>] [--json]
  vapi sweep <address> [--network <caip2>] [--json]
  vapi export-key [--network <caip2>] [--json]
  vapi report "<what happened>" [--include-addresses] [--send] [--json]
  vapi mcp [--json]
  vapi serve [--json]
  vapi version [--json]
  vapi publish [--json]

With no command, vapi shows this help. The MCP server starts only with \`vapi mcp\`.`;

export type CliIo = {
  stdout(message: string): void;
  stderr(message: string): void;
};

export type CliDependencies = {
  fetchImpl?: typeof fetch;
};

const processIo: CliIo = {
  stdout: (message) => process.stdout.write(`${message}\n`),
  stderr: (message) => process.stderr.write(`${message}\n`),
};

class UsageError extends Error {}

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
        await payCommand(args.slice(1), json, io);
        return 0;
      case "balance":
        await balanceCommand(args.slice(1), json, io, dependencies);
        return 0;
      case "receipts":
        await receiptsCommand(args.slice(1), json, io);
        return 0;
      case "stats":
        await statsCommand(args.slice(1), json, io);
        return 0;
      case "sweep":
        await sweepCommand(args.slice(1), json, io);
        return 0;
      case "export-key":
        await exportKeyCommand(args.slice(1), json, io);
        return 0;
      case "report":
        await reportCommand(args.slice(1), json, io, dependencies);
        return 0;
      case "mcp":
        await mcpCommand(args.slice(1));
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
  let migrated: string[] = [];
  if (!process.env.VAPI_HOME?.trim()) {
    migrated = await migrateLegacyVapiHome({ targetDirectory: paths.directory, notice: io.stderr });
  }
  // Refuse before the prompt: re-running init must never cost a passphrase.
  const adopted = migrated.includes(paths.keystore);
  if (!adopted && (await fileExists(paths.keystore))) {
    const address = await readKeystoreAddress(paths.keystore);
    throw new Error(
      [
        `Keystore already exists at ${paths.keystore}. Refusing to replace the local payment key.`,
        ...(address ? [`Address: ${address}`] : []),
      ].join("\n"),
    );
  }
  const passphrase = await getKeystorePassphrase({ confirm: true });
  let account = adopted
    ? await unlockKeystore(passphrase, paths.keystore)
    : await createKeystore(passphrase, paths.keystore, { enableSolana });
  if (enableSolana && !account.solana) {
    account = await enableSolanaKey(passphrase, paths.keystore);
  }
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
    address: account.address,
    accounts,
    config: paths.config,
    keystore: paths.keystore,
    ...(configRewrites.length > 0 ? { configRewrites } : {}),
    message: "vAPI wallet created. Its encrypted key stays on this machine.",
    nextSteps: buildNextSteps(account.address),
  };
  if (json) {
    io.stdout(JSON.stringify(result));
    return;
  }

  if (configRewrites.length > 0) io.stdout(formatLegacyRegistryRewrites(configRewrites));
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
  io.stdout(`Keystore: ${paths.keystore}`);
  io.stdout(formatAccounts(accounts));
  io.stdout("");
  io.stdout(result.nextSteps.join("\n"));
}

async function fundCommand(
  argv: string[],
  json: boolean,
  io: CliIo,
  dependencies: CliDependencies,
): Promise<void> {
  const parsed = parseArguments(argv, {
    valueOptions: new Set(["--amount"]),
    maximumPositionals: 0,
  });
  const fiatAmount = optionalUsdAmount(parsed.one("--amount"), "--amount");
  const paths = getVapiPaths();
  const config = await readConfig(paths.config, io);
  const account = await unlockKeystore(await getKeystorePassphrase(), paths.keystore);
  const session = await createOnrampSession({
    address: account.address,
    ...(fiatAmount === undefined ? {} : { fiatAmount }),
    allowPrivateNetwork: config.allowPrivateNetwork ?? false,
    ...(dependencies.fetchImpl ? { fetchImpl: dependencies.fetchImpl } : {}),
  });
  const opened =
    session.status === "ready" && Boolean(process.stdout.isTTY) && openInBrowser(session.url);
  const wallet = await getWallet(account, config, dependencies);
  const result = { ...session, opened, balances: wallet.balances };
  output(io, json, result, formatFund(session, opened, wallet));
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

async function payCommand(argv: string[], json: boolean, io: CliIo): Promise<void> {
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
    ]),
    maximumPositionals: 1,
  });
  const target = requiredPositional(parsed.positionals[0], "Usage: vapi pay <id-or-url> [options]");
  const paths = getVapiPaths();
  const config = await readConfig(paths.config, io);
  const account = await unlockKeystore(await getKeystorePassphrase(), paths.keystore);
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
  });
  output(io, json, result, JSON.stringify(result, null, 2));
}

async function balanceCommand(
  argv: string[],
  json: boolean,
  io: CliIo,
  dependencies: CliDependencies,
): Promise<void> {
  requireNoArguments(argv, "balance");
  const paths = getVapiPaths();
  const config = await readConfig(paths.config, io);
  const account = await unlockKeystore(await getKeystorePassphrase(), paths.keystore);
  const wallet = await getWallet(account, config, dependencies);
  output(io, json, wallet, formatWallet(wallet));
}

async function accountsCommand(
  argv: string[],
  json: boolean,
  io: CliIo,
  dependencies: CliDependencies,
): Promise<void> {
  const parsed = parseArguments(argv, {
    valueOptions: new Set(["--enable"]),
    maximumPositionals: 0,
  });
  const enable = parsed.one("--enable");
  if (enable !== undefined && enable !== "solana") {
    throw new UsageError("--enable currently supports only solana.");
  }
  const paths = getVapiPaths();
  const passphrase = await getKeystorePassphrase();
  const account = enable
    ? await enableSolanaKey(passphrase, paths.keystore)
    : await unlockKeystore(passphrase, paths.keystore);
  if (enable) await enableDefaultNetwork("solana", paths.config);
  const config = await readConfig(paths.config, io);
  const accounts = await listAccounts({
    address: account.address,
    ...(account.solana ? { solanaAddress: account.solana.address } : {}),
    config,
    ...(dependencies.fetchImpl ? { fetchImpl: dependencies.fetchImpl } : {}),
  });
  output(io, json, { accounts }, formatAccounts(accounts));
}

async function receiptsCommand(argv: string[], json: boolean, io: CliIo): Promise<void> {
  if (argv[0] === "export") {
    await receiptsExportCommand(argv.slice(1), io);
    return;
  }
  const parsed = parseArguments(argv, {
    valueOptions: new Set(["--limit"]),
    maximumPositionals: 0,
  });
  const limit = optionalNonNegativeInteger(parsed.one("--limit"), "--limit");
  const receipts = await readReceipts(getVapiPaths().receipts, {
    ...(limit === undefined ? {} : { limit }),
  });
  output(
    io,
    json,
    receipts,
    receipts.length === 0 ? "No receipts." : receipts.map(formatReceipt).join("\n"),
  );
}

async function receiptsExportCommand(argv: string[], io: CliIo): Promise<void> {
  const parsed = parseArguments(argv, {
    valueOptions: new Set(["--format", "--range"]),
    maximumPositionals: 0,
  });
  const format = parsed.one("--format");
  if (format !== "json" && format !== "csv") {
    throw new UsageError("--format must be json or csv.");
  }
  const rangeValue = parsed.one("--range");
  const range = rangeValue === undefined ? undefined : parseStatsRange(rangeValue);
  const allReceipts = await readReceipts(getVapiPaths().receipts);
  const receipts = range ? filterReceiptsByRange(allReceipts, range) : allReceipts;
  io.stdout(format === "json" ? JSON.stringify(receipts) : receiptsToCsv(receipts));
}

async function statsCommand(argv: string[], json: boolean, io: CliIo): Promise<void> {
  const parsed = parseArguments(argv, {
    valueOptions: new Set(["--range"]),
    maximumPositionals: 0,
  });
  const range = parseStatsRange(parsed.one("--range") ?? "24h");
  const paths = getVapiPaths();
  const stats = aggregateStats({
    receipts: await readReceipts(paths.receipts),
    searches: await readSearchEvents(paths.searches),
    range,
  });
  output(io, json, stats, formatStats(stats));
}

async function sweepCommand(argv: string[], json: boolean, io: CliIo): Promise<void> {
  const parsed = parseArguments(argv, {
    valueOptions: new Set(["--network"]),
    maximumPositionals: 1,
  });
  const destination = requiredPositional(
    parsed.positionals[0],
    "Usage: vapi sweep <address> [--network <caip2>]",
  );
  const requestedNetwork = parsed.one("--network");
  const paths = getVapiPaths();
  const config = await readConfig(paths.config, io);
  const account = await unlockKeystore(await getKeystorePassphrase(), paths.keystore);
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
  output(io, json, results, formatSweepResults(results));
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
 * Prints one secret on stdout and nothing else, so `vapi export-key | pbcopy`
 * carries exactly the key. The warning goes to stderr for the same reason.
 */
async function exportKeyCommand(argv: string[], json: boolean, io: CliIo): Promise<void> {
  const parsed = parseArguments(argv, {
    valueOptions: new Set(["--network"]),
    maximumPositionals: 0,
  });
  const network = parsed.one("--network") ?? BASE_MAINNET_CAIP2;
  const solana = isSolanaNetwork(network);
  if (!solana && !network.startsWith("eip155:")) {
    throw new UsageError("--network must be an eip155:<chainId> or Solana network identifier.");
  }
  const paths = getVapiPaths();
  const keys = await exportKeystoreKeys(await getKeystorePassphrase(), paths.keystore);
  if (solana && !keys.solana) {
    throw new Error(
      `No Solana key is enabled in ${paths.keystore}. Run vapi accounts --enable solana first.`,
    );
  }
  const selected = solana && keys.solana ? keys.solana : keys.evm;
  const result = {
    network,
    address: selected.address,
    privateKey: "secretKey" in selected ? selected.secretKey : selected.privateKey,
  };
  io.stderr(EXPORT_KEY_WARNING);
  io.stdout(json ? JSON.stringify(result) : result.privateKey);
}

async function mcpCommand(argv: string[]): Promise<void> {
  requireNoArguments(argv, "mcp");
  const paths = getVapiPaths();
  const config = await loadConfig(paths.config);
  // Unlock before connecting stdio so a prompt can never corrupt MCP frames.
  const account = await unlockKeystore(await getKeystorePassphrase(), paths.keystore);
  await startStdioServer({
    account,
    config,
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

function formatFund(
  session: Awaited<ReturnType<typeof createOnrampSession>>,
  opened: boolean,
  wallet: Awaited<ReturnType<typeof getWallet>>,
): string {
  const lines =
    session.status === "ready"
      ? [
          `Fund: ${session.url}`,
          ...(opened ? ["Opened in your default browser."] : []),
          "Coinbase Onramp takes the card or Apple Pay payment and sends USDC straight to this address; vAPI never holds your funds.",
        ]
      : [`Card funding is unavailable right now (${session.reason}).`, session.instructions];
  return [`Address: ${session.address}`, ...lines, "", ...formatBalanceLines(wallet)].join("\n");
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

function buildNextSteps(address: string): string[] {
  return [
    formatNextStep("Address", address, "(copy this to fund it)"),
    formatNextStep(
      "Fund",
      "vapi fund",
      "(card / Apple Pay via Coinbase Onramp, or send USDC on Base)",
    ),
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
