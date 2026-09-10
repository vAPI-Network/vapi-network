import { stat } from "node:fs/promises";

import {
  ARC_TESTNET_CAIP2,
  STATS_RANGES,
  aggregateStats,
  createKeystore,
  filterReceiptsByRange,
  formatUsdc,
  getArcGasHeadroomAtomic,
  getKeystorePassphrase,
  getNetworkDefinition,
  getVapiPaths,
  isMissingFile,
  loadConfig,
  migrateLegacyVapiHome,
  readReceipts,
  readSearchEvents,
  receiptsToCsv,
  sweepBack,
  unlockKeystore,
  writeDefaultConfig,
  type StatsRange,
} from "@vapi-network/core";
import {
  callService,
  getWallet,
  inspectService,
  searchMarketplace,
  startStdioServer,
} from "@vapi-network/mcp";
import { getAddress } from "viem";

import { CLI_VERSION } from "./version";

export const HELP = `vAPI Network

Usage:
  vapi init [--json]
  vapi search [query] [--kind <kind>] [--network <caip2>] [--limit <n>] [--cursor <cursor>] [--json]
  vapi inspect <id> [--endpoint <name>] [--json]
  vapi pay <id-or-url> [--method <method>] [--endpoint <name>] [--body <json>] [--content-type <type>] [--network <caip2>] [--expected-pay-to <address>] [--max <amount>] [--json]
  vapi balance [--json]
  vapi receipts [--limit <n>] [--json]
  vapi receipts export --format <json|csv> [--range <24h|7d|30d>]
  vapi stats [--range <24h|7d|30d>] [--json]
  vapi sweep <address> [--network <caip2>] [--json]
  vapi mcp [--json]
  vapi serve [--json]
  vapi version [--json]
  vapi publish [--json]

With no command, vapi shows this help. The MCP server starts only with \`vapi mcp\`.`;

export type CliIo = {
  stdout(message: string): void;
  stderr(message: string): void;
};

const processIo: CliIo = {
  stdout: (message) => process.stdout.write(`${message}\n`),
  stderr: (message) => process.stderr.write(`${message}\n`),
};

class UsageError extends Error {}

/** Run one CLI invocation and return its process exit code. */
export async function runCli(argv = process.argv.slice(2), io: CliIo = processIo): Promise<number> {
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
      output(io, json, { command: "help", help: HELP }, HELP);
      return 0;
    }

    switch (command) {
      case "init":
        await initCommand(args.slice(1), json, io);
        return 0;
      case "search":
        await searchCommand(args.slice(1), json, io);
        return 0;
      case "inspect":
        await inspectCommand(args.slice(1), json, io);
        return 0;
      case "pay":
        await payCommand(args.slice(1), json, io);
        return 0;
      case "balance":
        await balanceCommand(args.slice(1), json, io);
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

async function initCommand(argv: string[], json: boolean, io: CliIo): Promise<void> {
  requireNoArguments(argv, "init");
  const paths = getVapiPaths();
  let migrated: string[] = [];
  if (!process.env.VAPI_HOME?.trim()) {
    migrated = await migrateLegacyVapiHome({ targetDirectory: paths.directory, notice: io.stderr });
  }
  const passphrase = await getKeystorePassphrase({ confirm: true });
  const account = migrated.includes(paths.keystore)
    ? await unlockKeystore(passphrase, paths.keystore)
    : await createKeystore(passphrase, paths.keystore);
  if (!(await fileExists(paths.config))) await writeDefaultConfig(paths.config);

  const result = {
    address: account.address,
    config: paths.config,
    keystore: paths.keystore,
    message: "vAPI wallet created. Its encrypted key stays on this machine.",
  };
  if (json) {
    io.stdout(JSON.stringify(result));
    return;
  }

  io.stdout(result.message);
  io.stdout(`Address: ${result.address}`);
  io.stdout("Fund this address with USDC and a little ETH for gas on Base mainnet (eip155:8453).");
  io.stdout(`Config: ${paths.config}`);
  io.stdout(`Keystore: ${paths.keystore}`);
}

async function searchCommand(argv: string[], json: boolean, io: CliIo): Promise<void> {
  const parsed = parseArguments(argv, {
    valueOptions: new Set(["--kind", "--network", "--limit", "--cursor"]),
    repeatableOptions: new Set(["--kind"]),
    maximumPositionals: 1,
  });
  const limit = optionalPositiveInteger(parsed.one("--limit"), "--limit");
  const config = await loadConfig(getVapiPaths().config);
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
    undefined,
    { searchesPath: getVapiPaths().searches, notice: io.stderr },
  );
  output(io, json, page, formatSearch(page));
}

async function inspectCommand(argv: string[], json: boolean, io: CliIo): Promise<void> {
  const parsed = parseArguments(argv, {
    valueOptions: new Set(["--endpoint"]),
    maximumPositionals: 1,
  });
  const id = requiredPositional(
    parsed.positionals[0],
    "Usage: vapi inspect <id> [--endpoint <name>]",
  );
  const config = await loadConfig(getVapiPaths().config);
  const result = await inspectService(
    { id, ...(parsed.one("--endpoint") ? { endpoint: parsed.one("--endpoint") } : {}) },
    config,
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
  const config = await loadConfig(paths.config);
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

async function balanceCommand(argv: string[], json: boolean, io: CliIo): Promise<void> {
  requireNoArguments(argv, "balance");
  const paths = getVapiPaths();
  const config = await loadConfig(paths.config);
  const account = await unlockKeystore(await getKeystorePassphrase(), paths.keystore);
  const wallet = await getWallet(account.address, config);
  output(io, json, wallet, formatWallet(wallet));
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
  const destination = getAddress(
    requiredPositional(parsed.positionals[0], "Usage: vapi sweep <address> [--network <caip2>]"),
  );
  const requestedNetwork = parsed.one("--network");
  const paths = getVapiPaths();
  const config = await loadConfig(paths.config);
  const account = await unlockKeystore(await getKeystorePassphrase(), paths.keystore);
  if (requestedNetwork && !config.networks[requestedNetwork]) {
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

function output(io: CliIo, json: boolean, value: unknown, human: string): void {
  io.stdout(json ? JSON.stringify(value) : human);
}

function outputStub(io: CliIo, json: boolean): void {
  const message = "gateway daemon lands in 0.3";
  if (json) io.stdout(JSON.stringify({ error: message, exitCode: 2 }));
  else io.stderr(message);
}

function formatSearch(page: Awaited<ReturnType<typeof searchMarketplace>>): string {
  if (page.items.length === 0) return "No listings found.";
  return page.items
    .map((item) => `${item.ref}\t${item.kind}\t${item.card.title}\n  ${item.card.summary}`)
    .join("\n");
}

function formatWallet(wallet: Awaited<ReturnType<typeof getWallet>>): string {
  const lines = [`Address: ${wallet.address}`];
  for (const entry of wallet.balances) {
    lines.push(
      entry.error
        ? `${entry.name} (${entry.network}): unavailable — ${entry.error}`
        : `${entry.name} (${entry.network}): ${entry.usdc} USDC (${entry.usdcAtomic} atomic)`,
    );
  }
  return lines.join("\n");
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
  repeatableOptions?: Set<string>;
  maximumPositionals: number;
};

function parseArguments(argv: string[], spec: ArgumentSpec) {
  const positionals: string[] = [];
  const options = new Map<string, string[]>();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (!argument.startsWith("--")) {
      positionals.push(argument);
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
