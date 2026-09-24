import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";

import {
  BASE_MAINNET_CAIP2,
  assertWalletName,
  formatUsdc,
  getNetworkDefinition,
  getVapiPaths,
  isMissingFile,
  listAgentProfiles,
  loadConfig,
  readAgentProfile,
  readSpendLedgerRows,
  removeAgentProfile,
  spendCapsForWallet,
  usdToAtomic,
  utcDateKey,
  WalletStore,
  writeAgentProfile,
  type AgentProfile,
} from "@vapi-network/core";
import { forgetAgentLink } from "@vapi-network/core/agent-link";
import { routerChat, routerUsage } from "@vapi-network/core/router-client";
import { createAgentRunDeps, getWallet, runAgent, type AgentEvent } from "@vapi-network/mcp";

import {
  UsageError,
  getSecretStore,
  parseArguments,
  targetWallet,
  unlockTarget,
  walletCapsCommand,
  walletCreateCommand,
  type CliDependencies,
  type CliIo,
} from "./cli.js";
import { runLoginFlow } from "./login.js";

export type AgentCommandDependencies = {
  readAgentProfile?: typeof readAgentProfile;
  writeAgentProfile?: typeof writeAgentProfile;
  listAgentProfiles?: typeof listAgentProfiles;
  removeAgentProfile?: typeof removeAgentProfile;
  readSpendLedgerRows?: typeof readSpendLedgerRows;
  createAgentRunDeps?: typeof createAgentRunDeps;
  runAgent?: typeof runAgent;
  getWallet?: typeof getWallet;
};

const AGENT_USAGE = "Usage: vapi agent create|run|list|pause|resume|revoke";
const CREATE_USAGE =
  "Usage: vapi agent create <name> --model <id> --instructions <file> [--call-budget <usd>] [--max-per-call <usd>] [--router-budget <usd>] [--approve-above <usd>] [--include-unverified] [--max-steps <n>]";
const RUN_USAGE = 'Usage: vapi agent run <name> "<task>"';

export async function agentCommand(
  argv: string[],
  json: boolean,
  io: CliIo,
  dependencies: CliDependencies,
): Promise<number> {
  const subcommand = argv[0];
  switch (subcommand) {
    case "create":
      await createCommand(argv.slice(1), json, io, dependencies);
      return 0;
    case "run":
      return await runCommand(argv.slice(1), json, io, dependencies);
    case "list":
      await listCommand(argv.slice(1), json, io, dependencies);
      return 0;
    case "pause":
      await setPausedCommand(argv.slice(1), true, json, io, dependencies);
      return 0;
    case "resume":
      await setPausedCommand(argv.slice(1), false, json, io, dependencies);
      return 0;
    case "revoke":
      await revokeCommand(argv.slice(1), json, io, dependencies);
      return 0;
    default:
      throw new UsageError(
        subcommand === undefined
          ? AGENT_USAGE
          : `Unknown agent subcommand ${JSON.stringify(subcommand)}. ${AGENT_USAGE}`,
      );
  }
}

async function createCommand(
  argv: string[],
  json: boolean,
  io: CliIo,
  dependencies: CliDependencies,
): Promise<void> {
  const parsed = parseArguments(argv, {
    valueOptions: new Set([
      "--model",
      "--instructions",
      "--call-budget",
      "--max-per-call",
      "--router-budget",
      "--approve-above",
      "--max-steps",
    ]),
    booleanOptions: new Set(["--include-unverified"]),
    maximumPositionals: 1,
  });
  const name = assertWalletName(required(parsed.positionals[0], CREATE_USAGE));
  const model = required(parsed.one("--model"), CREATE_USAGE);
  const instructionsPath = required(parsed.one("--instructions"), CREATE_USAGE);
  const paths = getVapiPaths();
  if (await profileFileExists(paths.agentsDir, name)) {
    throw new Error(`Agent ${name} already exists.`);
  }

  const instructions = await readFile(instructionsPath, "utf8");
  if (instructions.length > 20_000) {
    throw new UsageError("--instructions must contain at most 20000 characters.");
  }
  const callBudget = usdOption(parsed.one("--call-budget") ?? "1", "--call-budget", true);
  const maxPerCall = usdOption(parsed.one("--max-per-call") ?? "0.05", "--max-per-call");
  const routerBudget = usdOption(parsed.one("--router-budget") ?? "1", "--router-budget", true);
  const approveAbove = usdOption(parsed.one("--approve-above") ?? "0.5", "--approve-above");
  const maxSteps = boundedInteger(parsed.one("--max-steps") ?? "12", "--max-steps", 1, 50);
  const commandIo = json ? { stdout: () => undefined, stderr: io.stderr } : io;
  const initialStore = await WalletStore.open(paths.directory);
  if (!initialStore.has(name)) {
    await walletCreateCommand([name, "--label", name], json, commandIo, dependencies);
  }
  await walletCapsCommand(
    [name, "--per-call", maxPerCall.text, "--per-day", callBudget.text],
    json,
    commandIo,
    dependencies,
  );

  const profile: AgentProfile = {
    version: 1,
    name,
    wallet: name,
    model,
    instructions,
    verifiedOnly: !parsed.has("--include-unverified"),
    approveAboveUsd: approveAbove.number,
    maxSteps,
    tools: ["call.search", "call.inspect", "call.pay"],
    paused: false,
    createdAt: (dependencies.now?.() ?? new Date()).toISOString(),
  };
  const writeProfile = dependencies.agent?.writeAgentProfile ?? writeAgentProfile;
  await writeProfile(paths.directory, profile);
  await runLoginFlow(["--wallet", name, "--label", name], json, commandIo, dependencies, {
    routerAllowanceUsd: routerBudget.number,
  });

  const target = await targetWallet(explicitWallet(name), dependencies);
  if (target.address === undefined) {
    throw new Error(`Wallet ${name} has no readable address.`);
  }
  const fundingHint = `Fund it: send a few USDC on Base to ${target.address} (vapi fund --wallet ${name})`;
  if (json) {
    io.stdout(
      JSON.stringify({
        name: profile.name,
        wallet: profile.wallet,
        address: target.address,
        model: profile.model,
        verifiedOnly: profile.verifiedOnly,
        approveAboveUsd: profile.approveAboveUsd,
        maxSteps: profile.maxSteps,
        spendCaps: {
          perCallAtomic: maxPerCall.atomic,
          perDayAtomic: callBudget.atomic,
        },
        routerAllowanceUsd: routerBudget.number,
        fundingHint,
      }),
    );
    return;
  }
  io.stdout(fundingHint);
}

async function runCommand(
  argv: string[],
  json: boolean,
  io: CliIo,
  dependencies: CliDependencies,
): Promise<number> {
  const parsed = parseArguments(argv, { valueOptions: new Set(), maximumPositionals: 2 });
  const name = assertWalletName(required(parsed.positionals[0], RUN_USAGE));
  const task = required(parsed.positionals[1], RUN_USAGE);
  const paths = getVapiPaths();
  const readProfile = dependencies.agent?.readAgentProfile ?? readAgentProfile;
  const profile = await readProfile(paths.directory, name);
  if (profile.paused) {
    const message = `Agent ${name} is paused. Run vapi agent resume ${name}.`;
    if (json) io.stdout(JSON.stringify({ error: message, exitCode: 1 }));
    else io.stderr(message);
    return 1;
  }

  const target = await targetWallet(explicitWallet(profile.wallet), dependencies);
  const { account } = await unlockTarget(target, dependencies);
  const config = await loadConfig(paths.config, process.env, { notice: io.stderr });
  const spendCaps = await spendCapsForWallet(target.store, target.name);
  const tty = dependencies.interactive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const searchQueries: string[] = [];
  const listingNames = new Map<string, string>();
  const chatRequest = dependencies.router?.routerChat ?? routerChat;
  const chat = async (request: Parameters<typeof routerChat>[1]) => {
    const result = await chatRequest(
      {
        ...routerDependencies(target, dependencies),
        refill: {
          account,
          config,
          caps: async () => {
            await target.store.reload();
            return await spendCapsForWallet(target.store, target.name);
          },
          paths: { ledgerPath: paths.ledger, receiptsPath: paths.receipts },
          ...(dependencies.now === undefined ? {} : { now: dependencies.now() }),
        },
      },
      request,
    );
    for (const call of result.toolCalls) {
      if (call.name !== "call_search") continue;
      const query = searchQuery(call.arguments);
      if (query !== undefined) searchQueries.push(query);
    }
    return result;
  };
  const approve: RunAgentParameters["approve"] = async ({ ref, priceUsd, reason }) => {
    if (!tty) return false;
    const answer = await visibleLine(
      `Pay ${usd(priceUsd)} to ${ref}? ${reason} [y/N] `,
      dependencies,
    );
    return answer === "y" || answer === "yes";
  };
  const eventOutput = json ? io.stderr : io.stdout;
  const onEvent = (event: AgentEvent): void => {
    const message = formatEvent(event, searchQueries, listingNames);
    if (message !== undefined) eventOutput(message);
  };
  const makeDeps = dependencies.agent?.createAgentRunDeps ?? createAgentRunDeps;
  const execute = dependencies.agent?.runAgent ?? runAgent;
  const runDependencies = makeDeps({
    profile,
    config,
    home: paths.directory,
    account,
    wallet: target.name,
    spendCaps,
    chat,
    approve,
    onEvent,
    tty,
    ...(dependencies.fetchImpl === undefined ? {} : { fetchImpl: dependencies.fetchImpl }),
    ledgerPath: paths.ledger,
    receiptsPath: paths.receipts,
  });
  const search = runDependencies.search;
  runDependencies.search = async (query) => {
    const rows = await search(query);
    for (const row of rows) listingNames.set(row.ref, row.name);
    return rows;
  };
  const result = await execute(task, runDependencies);

  if (json) {
    io.stdout(JSON.stringify(result));
  } else if (result.stoppedBecause.reason === "finished") {
    io.stdout(result.answer ?? "");
  } else {
    io.stderr(result.stoppedBecause.detail ?? result.stoppedBecause.reason);
  }
  return result.stoppedBecause.reason === "finished" ? 0 : 1;
}

type RunAgentParameters = Parameters<typeof createAgentRunDeps>[0];

async function listCommand(
  argv: string[],
  json: boolean,
  io: CliIo,
  dependencies: CliDependencies,
): Promise<void> {
  parseArguments(argv, { valueOptions: new Set(), maximumPositionals: 0 });
  const paths = getVapiPaths();
  const listProfiles = dependencies.agent?.listAgentProfiles ?? listAgentProfiles;
  const readLedger = dependencies.agent?.readSpendLedgerRows ?? readSpendLedgerRows;
  const profiles = await listProfiles(paths.directory, { warn: io.stderr });
  const store = await WalletStore.open(paths.directory);
  const now = dependencies.now?.() ?? new Date();
  const ledger = await readLedger(paths.ledger, now);
  const readUsage = dependencies.router?.routerUsage ?? routerUsage;
  const rows = await Promise.all(
    profiles.map(async (profile) => {
      const address = await store.readAddress(profile.wallet);
      const entry = store.entry(profile.wallet);
      const spentAtomic =
        ledger.find((candidate) => candidate.wallet === profile.wallet)?.spentAtomic ?? "0";
      let routerRemainingTodayUsd: number | "—" = "—";
      try {
        const usage = await readUsage({
          secrets: getSecretStore(dependencies),
          wallets: store,
          wallet: assertWalletName(profile.wallet),
          ...(dependencies.fetchImpl === undefined ? {} : { fetchImpl: dependencies.fetchImpl }),
        });
        routerRemainingTodayUsd = usage.compute.remainingTodayUsd;
      } catch {
        // A broken or absent link should not hide the local profiles.
      }
      return {
        name: profile.name,
        wallet: profile.wallet,
        ...(address === undefined ? {} : { address }),
        linkedOwner: entry?.link ? shortAddress(entry.link.owner) : "not linked",
        model: profile.model,
        paused: profile.paused,
        date: utcDateKey(now),
        callSpentTodayUsd: Number(spentAtomic) / 1_000_000,
        routerRemainingTodayUsd,
      };
    }),
  );
  if (json) {
    io.stdout(JSON.stringify(rows));
    return;
  }
  io.stdout(
    [
      "NAME\tWALLET ADDRESS\tLINKED OWNER\tMODEL\tPAUSED\tCALL TODAY\tROUTER LEFT TODAY",
      ...rows.map((row) =>
        [
          row.name,
          row.address ?? "unreadable",
          row.linkedOwner,
          row.model,
          row.paused ? "yes" : "no",
          `$${row.callSpentTodayUsd.toFixed(2)}`,
          row.routerRemainingTodayUsd === "—" ? "—" : `$${row.routerRemainingTodayUsd.toFixed(2)}`,
        ].join("\t"),
      ),
    ].join("\n"),
  );
}

async function setPausedCommand(
  argv: string[],
  paused: boolean,
  json: boolean,
  io: CliIo,
  dependencies: CliDependencies,
): Promise<void> {
  const action = paused ? "pause" : "resume";
  const parsed = parseArguments(argv, { valueOptions: new Set(), maximumPositionals: 1 });
  const name = assertWalletName(
    required(parsed.positionals[0], `Usage: vapi agent ${action} <name>`),
  );
  const paths = getVapiPaths();
  const readProfile = dependencies.agent?.readAgentProfile ?? readAgentProfile;
  const writeProfile = dependencies.agent?.writeAgentProfile ?? writeAgentProfile;
  const profile = await readProfile(paths.directory, name);
  await writeProfile(paths.directory, { ...profile, paused });
  const state = paused ? "paused" : "resumed";
  io.stdout(json ? JSON.stringify({ name, paused }) : `Agent ${name} ${state}.`);
}

async function revokeCommand(
  argv: string[],
  json: boolean,
  io: CliIo,
  dependencies: CliDependencies,
): Promise<void> {
  const parsed = parseArguments(argv, { valueOptions: new Set(), maximumPositionals: 1 });
  const name = assertWalletName(required(parsed.positionals[0], "Usage: vapi agent revoke <name>"));
  const paths = getVapiPaths();
  const readProfile = dependencies.agent?.readAgentProfile ?? readAgentProfile;
  const removeProfile = dependencies.agent?.removeAgentProfile ?? removeAgentProfile;
  const profile = await readProfile(paths.directory, name);
  const target = await targetWallet(explicitWallet(profile.wallet), dependencies);
  const owner = target.entry.link?.owner;
  let balance: string | undefined;
  try {
    const config = await loadConfig(paths.config, process.env, { notice: io.stderr });
    balance = await baseBalance(target.address, config, dependencies);
  } catch {
    // Revocation and local credential removal must not depend on a balance read.
  }
  const forget = dependencies.agentLink?.forgetAgentLink ?? forgetAgentLink;
  try {
    await forget({
      secrets: getSecretStore(dependencies),
      wallets: target.store,
      wallet: target.name,
      ...(dependencies.fetchImpl === undefined ? {} : { fetchImpl: dependencies.fetchImpl }),
      home: paths.directory,
    });
  } finally {
    await removeProfile(paths.directory, name);
  }
  const sweep = `vapi sweep ${owner ?? "<address>"} --wallet ${profile.wallet}`;
  const message =
    balance === undefined
      ? `The wallet ${profile.wallet} still holds funds. Send it back with ${sweep}.`
      : `The wallet ${profile.wallet} still holds $${balance}. Send it back with ${sweep}.`;
  io.stdout(
    json
      ? JSON.stringify({
          name,
          wallet: profile.wallet,
          revoked: true,
          walletKept: true,
          ...(balance === undefined ? {} : { balanceUsd: balance }),
          message,
        })
      : message,
  );
}

async function baseBalance(
  address: string | undefined,
  config: Awaited<ReturnType<typeof loadConfig>>,
  dependencies: CliDependencies,
): Promise<string | undefined> {
  if (address === undefined) return undefined;
  try {
    const readWallet = dependencies.agent?.getWallet ?? getWallet;
    const wallet = await readWallet(address as `0x${string}`, config, {
      ...(dependencies.fetchImpl === undefined ? {} : { fetchImpl: dependencies.fetchImpl }),
    });
    const base = wallet.balances.find((candidate) => candidate.network === BASE_MAINNET_CAIP2);
    return base?.usdcAtomic === null || base?.usdcAtomic === undefined
      ? undefined
      : formatUsdc(BigInt(base.usdcAtomic));
  } catch {
    return undefined;
  }
}

function routerDependencies(
  target: Awaited<ReturnType<typeof targetWallet>>,
  dependencies: CliDependencies,
) {
  return {
    secrets: getSecretStore(dependencies),
    wallets: target.store,
    wallet: target.name,
    ...(dependencies.fetchImpl === undefined ? {} : { fetchImpl: dependencies.fetchImpl }),
  };
}

function formatEvent(
  event: AgentEvent,
  searchQueries: string[],
  listingNames: ReadonlyMap<string, string>,
): string | undefined {
  if (event.type === "tool" && event.name === "call_search") {
    const query = searchQueries.shift();
    return query === undefined ? "→ search" : `→ search ${JSON.stringify(query)}`;
  }
  if (event.type === "paid") {
    let network = event.network;
    try {
      network = getNetworkDefinition(event.network).name;
    } catch {
      // Unknown networks remain identifiable by their CAIP-2 id.
    }
    return `✓ paid ${usd(event.amountUsd)} on ${network} to ${listingNames.get(event.ref) ?? event.ref}`;
  }
  if (event.type === "declined") return `✗ declined ${event.ref}: ${event.reason}`;
  return undefined;
}

function searchQuery(argumentsJson: string): string | undefined {
  try {
    const value = JSON.parse(argumentsJson) as { query?: unknown };
    return typeof value.query === "string" ? value.query : undefined;
  } catch {
    return undefined;
  }
}

async function visibleLine(prompt: string, dependencies: CliDependencies): Promise<string> {
  if (dependencies.prompts?.line)
    return (await dependencies.prompts.line(prompt)).trim().toLowerCase();
  const reader = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return (await reader.question(prompt)).trim().toLowerCase();
  } finally {
    reader.close();
  }
}

function explicitWallet(name: string): { one(option: string): string | undefined } {
  return { one: (option) => (option === "--wallet" ? name : undefined) };
}

async function profileFileExists(directory: string, name: string): Promise<boolean> {
  try {
    await stat(join(directory, `${name}.json`));
    return true;
  } catch (error) {
    if (isMissingFile(error)) return false;
    throw error;
  }
}

function usdOption(
  value: string,
  option: string,
  toleratePerDaySuffix = false,
): { text: string; number: number; atomic: string } {
  const text = toleratePerDaySuffix ? value.replace(/\/day$/u, "") : value;
  if (text.length === 0 || (!toleratePerDaySuffix && value.endsWith("/day"))) {
    throw new UsageError(`${option} must be a US dollar amount such as 0.25 or 10.`);
  }
  try {
    const atomic = usdToAtomic(text).toString();
    if (BigInt(atomic) < 0n) throw new Error("negative");
    const number = Number(atomic) / 1_000_000;
    if (!Number.isSafeInteger(Number(atomic))) throw new Error("too large");
    return { text, number, atomic };
  } catch {
    throw new UsageError(`${option} must be a US dollar amount such as 0.25 or 10.`);
  }
}

function boundedInteger(value: string, option: string, minimum: number, maximum: number): number {
  if (!/^\d+$/u.test(value)) {
    throw new UsageError(`${option} must be a whole number from ${minimum} to ${maximum}.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new UsageError(`${option} must be a whole number from ${minimum} to ${maximum}.`);
  }
  return parsed;
}

function required(value: string | undefined, usage: string): string {
  if (value === undefined || value.length === 0) throw new UsageError(usage);
  return value;
}

function shortAddress(address: string): string {
  return address.length <= 12 ? address : `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/** Exact USDC amount: $0.005 stays $0.005 instead of rounding to $0.01. */
function usd(value: number): string {
  return `$${formatUsdc(BigInt(Math.round(value * 1_000_000)))}`;
}
