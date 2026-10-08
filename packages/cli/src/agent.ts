import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";

import {
  BASE_MAINNET_CAIP2,
  DEFAULT_AUTO_RELEASE_BELOW_USD,
  DEFAULT_MAX_PER_TASK_USD,
  assertWalletName,
  createRunBudget,
  createRunId,
  formatUsdc,
  getNetworkDefinition,
  getVapiPaths,
  isMissingFile,
  isRunId,
  listAgentProfiles,
  loadConfig,
  readAgentProfile,
  readSwarm,
  readSpendLedgerRows,
  removeAgentProfile,
  resolveRegistryUrl,
  spendCapsForWallet,
  SWARM_NAME_PATTERN,
  swarmParentResolver,
  sweepAboveCeiling,
  usdToAtomic,
  utcDateKey,
  writeAgentProfile,
  writeJsonAtomic,
  type AgentProfile,
  type RunBudget,
} from "@vapi-network/core";
import { forgetAgentLink } from "@vapi-network/core/agent-link";
import { routerChat, routerUsage } from "@vapi-network/core/router-client";
import {
  agentToolNames,
  createAgentRunDeps,
  getWallet,
  registeredAgentProfileSchema,
  runLogPath,
  runAgent,
  startDetachedRun,
  type AgentEvent,
  type RunAgentDeps,
} from "@vapi-network/mcp";

import {
  UsageError,
  getEnvironment,
  getSecretStore,
  openWalletStore,
  parseArguments,
  redactDetachedRunValue,
  targetWallet,
  unlockTarget,
  walletCapsCommand,
  walletCreateCommand,
  type CliDependencies,
  type CliIo,
} from "./cli.js";
import { runHeadlessAgent } from "./headless.js";
import { runLoginFlow } from "./login.js";
import { parseRuntimeKind, resolveRuntime } from "./runtime-local.js";

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

const AGENT_USAGE = "Usage: vapi agent create|run|list|show|pause|resume|revoke";
const CREATE_USAGE =
  "Usage: vapi agent create <name> --model <id> --instructions <file> [--call-budget <usd>] [--max-per-call <usd>] [--router-budget <usd>] [--approve-above <usd>] [--max-per-task <usd>] [--auto-release-below <usd>] [--include-unverified] [--max-steps <n>] [--yes]";
const RUN_USAGE =
  'Usage: vapi agent run <name> "<task>" [--budget <usd>] [--detach] [--runtime local] [--result-file <path>]\n       vapi agent run --bundle-env <VAR> ("<task>" | --task-base64url <text>) [--budget <usd>] [--result-file <path>]';
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/u;
const agentProfileOptions = { schema: registeredAgentProfileSchema };

/**
 * The task a railway sandbox receives as one base64url argument, which reads
 * the same whether `railway sandbox exec` passes argv or a shell string.
 */
function decodeTask(encoded: string): string {
  const task = BASE64URL_PATTERN.test(encoded)
    ? Buffer.from(encoded, "base64url").toString("utf8")
    : "";
  if (task.trim() === "" || Buffer.from(task, "utf8").toString("base64url") !== encoded) {
    throw new UsageError(`--task-base64url must be a base64url-encoded task.\n${RUN_USAGE}`);
  }
  return task;
}

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
    case "show":
      await showCommand(argv.slice(1), json, io, dependencies);
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
      "--max-per-task",
      "--auto-release-below",
      "--max-steps",
    ]),
    booleanOptions: new Set(["--include-unverified", "--yes"]),
    maximumPositionals: 1,
  });
  const name = assertWalletName(required(parsed.positionals[0], "<name>", CREATE_USAGE));
  const model = required(parsed.one("--model"), "--model <id>", CREATE_USAGE);
  const instructionsPath = required(
    parsed.one("--instructions"),
    "--instructions <file>",
    CREATE_USAGE,
  );
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
  const interactive =
    !json && (dependencies.interactive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY));
  const promptForTaskPolicy = interactive && !parsed.has("--yes");
  const maxPerTask = usdOption(
    parsed.one("--max-per-task") ??
      ((promptForTaskPolicy
        ? await visibleLine(`Max per task in USD [${DEFAULT_MAX_PER_TASK_USD}]: `, dependencies)
        : "") ||
        String(DEFAULT_MAX_PER_TASK_USD)),
    "--max-per-task",
  );
  const autoReleaseBelow = usdOption(
    parsed.one("--auto-release-below") ??
      ((promptForTaskPolicy
        ? await visibleLine(
            `Auto-release below in USD [${DEFAULT_AUTO_RELEASE_BELOW_USD}]: `,
            dependencies,
          )
        : "") ||
        String(DEFAULT_AUTO_RELEASE_BELOW_USD)),
    "--auto-release-below",
  );
  const commandIo = json ? { stdout: () => undefined, stderr: io.stderr } : io;
  const initialStore = await openWalletStore(dependencies);
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
    maxPerTaskUsd: maxPerTask.number,
    autoReleaseBelowUsd: autoReleaseBelow.number,
    maxSteps,
    tools: [...agentToolNames],
    grants: [],
    paused: false,
    createdAt: (dependencies.now?.() ?? new Date()).toISOString(),
  };
  const writeProfile = dependencies.agent?.writeAgentProfile ?? writeAgentProfile;
  await writeProfile(paths.directory, profile, agentProfileOptions);
  await runLoginFlow(["--account", name, "--label", name], json, commandIo, dependencies, {
    routerAllowanceUsd: routerBudget.number,
  });

  const target = await targetWallet(explicitWallet(name), dependencies);
  if (target.address === undefined) {
    throw new Error(`Wallet ${name} has no readable address.`);
  }
  const fundingHint = `Fund it: send a few USDC on Base to ${target.address} (vapi fund --account ${name})`;
  if (json) {
    io.stdout(
      JSON.stringify({
        name: profile.name,
        wallet: profile.wallet,
        address: target.address,
        model: profile.model,
        verifiedOnly: profile.verifiedOnly,
        approveAboveUsd: profile.approveAboveUsd,
        maxPerTaskUsd: profile.maxPerTaskUsd,
        autoReleaseBelowUsd: profile.autoReleaseBelowUsd,
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
  const parsed = parseArguments(argv, {
    valueOptions: new Set([
      "--budget",
      "--runtime",
      "--result-file",
      "--bundle-env",
      "--task-base64url",
    ]),
    booleanOptions: new Set(["--detach"]),
    maximumPositionals: 2,
  });
  const bundleVariable = parsed.one("--bundle-env");
  const encodedTask = parsed.one("--task-base64url");
  if (encodedTask !== undefined && bundleVariable === undefined) {
    throw new UsageError(`--task-base64url needs --bundle-env.\n${RUN_USAGE}`);
  }
  if (bundleVariable !== undefined) {
    // Headless: the account and profile come from the member bundle, never from argv.
    if (parsed.has("--detach") || parsed.one("--runtime") !== undefined) {
      throw new UsageError(`--bundle-env cannot be used with --detach or --runtime.\n${RUN_USAGE}`);
    }
    if (parsed.positionals.length !== (encodedTask === undefined ? 1 : 0)) {
      throw new UsageError(
        `--bundle-env takes exactly one task: one argument or --task-base64url.\n${RUN_USAGE}`,
      );
    }
    const headlessBudget = parsed.one("--budget");
    const headlessResultFile = parsed.one("--result-file");
    return await runHeadlessAgent({
      variable: bundleVariable,
      task:
        encodedTask === undefined
          ? required(parsed.positionals[0], "<task>", RUN_USAGE)
          : decodeTask(encodedTask),
      ...(headlessBudget === undefined ? {} : { budgetUsd: headlessBudget }),
      ...(headlessResultFile === undefined ? {} : { resultFile: headlessResultFile }),
      json,
      io,
      dependencies,
    });
  }
  const name = assertWalletName(required(parsed.positionals[0], "<name>", RUN_USAGE));
  const task = required(parsed.positionals[1], "<task>", RUN_USAGE);
  const budgetValue = parsed.one("--budget");
  const runtimeValue = parsed.one("--runtime");
  const resultFile = parsed.one("--result-file");
  const detached = parsed.has("--detach");
  const budgetOption =
    budgetValue === undefined ? undefined : positiveUsdOption(budgetValue, "--budget");
  if (runtimeValue !== undefined && !detached) {
    throw new UsageError(`--runtime requires --detach.\n${RUN_USAGE}`);
  }
  if (runtimeValue !== undefined && parseRuntimeKind(runtimeValue) === "railway") {
    // Only a swarm member's key may leave this machine; a standalone account is outside a swarm.
    throw new UsageError(
      `The railway runtime runs swarm members only. Use: vapi swarm run <swarm> "<task>" --mode each --runtime railway --checkpoint <name> --allow-remote-key\n${RUN_USAGE}`,
    );
  }
  if (detached && resultFile !== undefined) {
    throw new UsageError(`--detach and --result-file cannot be used together.\n${RUN_USAGE}`);
  }
  const environment = getEnvironment(dependencies);
  const configuredRunId = environmentRunId(environment, "VAPI_RUN_ID");
  const parentRunId = environmentRunId(environment, "VAPI_PARENT_RUN_ID");
  const paths = getVapiPaths();
  const readProfile = dependencies.agent?.readAgentProfile ?? readAgentProfile;
  const profile = await readProfile(paths.directory, name, agentProfileOptions);
  if (profile.paused) {
    const message = `Agent ${name} is paused. Run vapi agent resume ${name}.`;
    const result = { error: message, exitCode: 1 };
    if (resultFile !== undefined) {
      await writeJsonAtomic(resultFile, { v: 1, exitCode: 1, result }, { mode: 0o600 });
    }
    if (json) io.stdout(JSON.stringify(result));
    else io.stderr(message);
    return 1;
  }

  const runId = configuredRunId ?? createRunId();
  if (detached) {
    const runtime = resolveRuntime(parseRuntimeKind(runtimeValue), paths.directory, dependencies);
    const record = await startDetachedRun({
      home: paths.directory,
      runtime,
      member: { account: name, profile: name },
      run: {
        runId,
        task,
        mode: "agent",
        ...(budgetValue === undefined ? {} : { budgetUsd: budgetValue }),
        ...(parentRunId === undefined ? {} : { parentRunId }),
      },
      env: environment,
      ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
    });
    const result = {
      detached: true,
      runId: record.runId,
      kind: record.kind,
      state: record.state,
      log: runLogPath(paths.directory, record.runId),
    };
    if (json) io.stdout(JSON.stringify(result));
    else {
      io.stdout(`${record.runId} started (${record.kind})`);
      io.stdout(`Log: ${result.log}`);
    }
    return 0;
  }

  const budget =
    budgetOption === undefined
      ? undefined
      : createRunBudget({ id: runId, limitAtomic: BigInt(budgetOption.atomic) });
  // A detached each-mode swarm member arrives with VAPI_SWARM: attribute its receipts to the
  // swarm and drop the treasury grants, exactly as the attached each mode does.
  const swarmName = environmentSwarm(environment);
  let runProfile = profile;
  if (swarmName !== undefined) {
    const swarm = await readSwarm(paths.directory, swarmName);
    const member = swarm.members.find((candidate) => candidate.account === name);
    if (swarm.treasury.account === name || member === undefined) {
      throw new UsageError(
        `Agent ${name} is not a validated member of swarm ${swarmName}. Refusing to run.`,
      );
    }
    if (profile.wallet !== member.account) {
      throw new UsageError(
        `Agent ${name} is member ${member.account} of swarm ${swarmName}, but its profile selects ${profile.wallet}. Refusing to run.`,
      );
    }
    runProfile = {
      ...profile,
      wallet: member.account,
      grants: profile.grants.filter((grant) => grant !== "delegate" && grant !== "allocate"),
    };
  }
  const runMeta =
    swarmName === undefined
      ? parentRunId === undefined
        ? undefined
        : { parentRunId }
      : { swarm: swarmName, member: name, ...(parentRunId === undefined ? {} : { parentRunId }) };
  const runDependencies = await buildAgentRunDeps({
    profile: runProfile,
    runId,
    ...(budget === undefined ? {} : { budget }),
    ...(runMeta === undefined ? {} : { runMeta }),
    approvals: "tty",
    json,
    io,
    dependencies,
  });
  const execute = dependencies.agent?.runAgent ?? runAgent;
  const executed = await execute(task, runDependencies);
  const result =
    resultFile === undefined ? executed : redactDetachedRunValue(executed, environment);
  const exitCode = result.stoppedBecause.reason === "finished" ? 0 : 1;

  if (resultFile !== undefined) {
    await writeJsonAtomic(resultFile, { v: 1, exitCode, result }, { mode: 0o600 });
  }

  if (json) {
    io.stdout(JSON.stringify(result));
  } else if (result.stoppedBecause.reason === "finished") {
    io.stdout(result.answer ?? "");
  } else {
    io.stderr(result.stoppedBecause.detail ?? result.stoppedBecause.reason);
  }
  return exitCode;
}

function environmentSwarm(environment: NodeJS.ProcessEnv): string | undefined {
  // Only a detached child (started with VAPI_RUN_ID) is a swarm member run;
  // a VAPI_SWARM left in an ordinary shell must not change an attached run.
  if (environment.VAPI_RUN_ID === undefined) return undefined;
  const value = environment.VAPI_SWARM;
  if (value === undefined) return undefined;
  if (!SWARM_NAME_PATTERN.test(value)) {
    throw new UsageError("VAPI_SWARM must be a valid swarm name.");
  }
  return value;
}

function environmentRunId(
  environment: NodeJS.ProcessEnv,
  variable: "VAPI_RUN_ID" | "VAPI_PARENT_RUN_ID",
): string | undefined {
  const value = environment[variable];
  if (value === undefined) return undefined;
  if (!isRunId(value)) {
    throw new UsageError(`${variable} must match run_<24 lowercase hexadecimal characters>.`);
  }
  return value;
}

export async function buildAgentRunDeps(input: {
  profile: AgentProfile;
  runId: string;
  budget?: RunBudget;
  allowanceExpiresAt?: Date;
  runMeta?: { swarm?: string; member?: string; parentRunId?: string };
  approvals: "tty" | "decline";
  onEvent?: (event: AgentEvent) => void;
  json: boolean;
  io: CliIo;
  dependencies: CliDependencies;
}): Promise<RunAgentDeps> {
  const { profile, runId, budget, runMeta, approvals, json, io, dependencies } = input;
  const paths = getVapiPaths();
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
          run: { id: runId, ...(runMeta ?? {}) },
          ...(budget === undefined ? {} : { runBudget: budget }),
          ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
          ...(input.allowanceExpiresAt === undefined
            ? {}
            : { allowanceExpiresAt: input.allowanceExpiresAt }),
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
  const approve: RunAgentDeps["approve"] = async ({ ref, priceUsd, reason }) => {
    if (approvals === "decline" || !tty) return false;
    const answer = await visibleLine(
      `Pay ${usd(priceUsd)} to ${ref}? ${reason} [y/N] `,
      dependencies,
    );
    return answer === "y" || answer === "yes";
  };
  const eventOutput = json ? io.stderr : io.stdout;
  const onEvent =
    input.onEvent ??
    ((event: AgentEvent): void => {
      const message = formatEvent(event, searchQueries, listingNames);
      if (message !== undefined) eventOutput(message);
    });
  const makeDeps = dependencies.agent?.createAgentRunDeps ?? createAgentRunDeps;
  const runDependencies = makeDeps({
    profile,
    config,
    home: paths.directory,
    account,
    wallet: target.name,
    spendCaps,
    currentSpendCaps: async () => {
      await target.store.reload();
      return await spendCapsForWallet(target.store, target.name);
    },
    chat,
    approve,
    onEvent,
    tty,
    runId,
    ...(budget === undefined ? {} : { budget }),
    ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
    ...(input.allowanceExpiresAt === undefined
      ? {}
      : { allowanceExpiresAt: input.allowanceExpiresAt }),
    ...(runMeta === undefined ? {} : { runMeta }),
    ...(dependencies.fetchImpl === undefined ? {} : { fetchImpl: dependencies.fetchImpl }),
    ledgerPath: paths.ledger,
    receiptsPath: paths.receipts,
    ceilingSweep: {
      account: target.name,
      auditHome: target.store.home,
      run: async (signal) =>
        await (dependencies.ceiling?.sweepAboveCeiling ?? sweepAboveCeiling)({
          store: target.store,
          secrets: getSecretStore(dependencies),
          apiBase:
            target.entry.link?.apiBase ?? resolveRegistryUrl(dependencies.env ?? process.env),
          account: target.name,
          config,
          signal,
          resolveParent: swarmParentResolver(target.store.home),
          ...(dependencies.fetchImpl === undefined ? {} : { fetchImpl: dependencies.fetchImpl }),
          ...(dependencies.ceiling?.balanceReader === undefined
            ? {}
            : { balanceReader: dependencies.ceiling.balanceReader }),
          ...(dependencies.ceiling?.fetchSiblingsImpl === undefined
            ? {}
            : { fetchSiblingsImpl: dependencies.ceiling.fetchSiblingsImpl }),
          ...(dependencies.ceiling?.transfer === undefined
            ? {}
            : { transfer: dependencies.ceiling.transfer }),
          unlock: async () => account,
          ...(dependencies.ceiling?.timeoutMs === undefined
            ? {}
            : { timeoutMs: dependencies.ceiling.timeoutMs }),
        }),
    },
  });
  const search = runDependencies.search;
  runDependencies.search = async (query) => {
    const rows = await search(query);
    for (const row of rows) listingNames.set(row.ref, row.name);
    return rows;
  };
  return runDependencies;
}

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
  const profiles = await listProfiles(paths.directory, {
    warn: io.stderr,
    ...agentProfileOptions,
  });
  const store = await openWalletStore(dependencies);
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

async function showCommand(
  argv: string[],
  json: boolean,
  io: CliIo,
  dependencies: CliDependencies,
): Promise<void> {
  const parsed = parseArguments(argv, { valueOptions: new Set(), maximumPositionals: 1 });
  const name = assertWalletName(
    required(parsed.positionals[0], "<name>", "Usage: vapi agent show <name> [--json]"),
  );
  const paths = getVapiPaths();
  const readProfile = dependencies.agent?.readAgentProfile ?? readAgentProfile;
  const profile = await readProfile(paths.directory, name, agentProfileOptions);
  const store = await openWalletStore(dependencies);
  const spendCaps = store.has(profile.wallet)
    ? await spendCapsForWallet(store, assertWalletName(profile.wallet))
    : null;
  const result = {
    name: profile.name,
    wallet: profile.wallet,
    model: profile.model,
    paused: profile.paused,
    verifiedOnly: profile.verifiedOnly,
    approveAboveUsd: profile.approveAboveUsd,
    maxPerTaskUsd: profile.maxPerTaskUsd,
    autoReleaseBelowUsd: profile.autoReleaseBelowUsd,
    maxSteps: profile.maxSteps,
    tools: profile.tools,
    grants: profile.grants,
    spendCaps,
  };
  if (json) {
    io.stdout(JSON.stringify(result));
    return;
  }
  io.stdout(
    [
      `Name: ${profile.name}`,
      `Wallet: ${profile.wallet}`,
      `Model: ${profile.model}`,
      `Paused: ${profile.paused ? "yes" : "no"}`,
      `Verified only: ${profile.verifiedOnly ? "yes" : "no"}`,
      `Approve above: ${usd(profile.approveAboveUsd, 2)}`,
      `Max per task: ${usd(profile.maxPerTaskUsd, 2)}`,
      `Auto-release below: ${usd(profile.autoReleaseBelowUsd, 2)}`,
      `Max steps: ${profile.maxSteps}`,
      `Tools: ${profile.tools.join(", ")}`,
      `Grants: ${profile.grants.join(", ")}`,
      `Per call: ${spendCaps === null ? "unavailable" : usd(Number(spendCaps.perCallAtomic) / 1_000_000, 2)}`,
      `Per day: ${spendCaps === null ? "unavailable" : usd(Number(spendCaps.perDayAtomic) / 1_000_000, 2)}`,
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
    required(parsed.positionals[0], "<name>", `Usage: vapi agent ${action} <name>`),
  );
  const paths = getVapiPaths();
  const readProfile = dependencies.agent?.readAgentProfile ?? readAgentProfile;
  const writeProfile = dependencies.agent?.writeAgentProfile ?? writeAgentProfile;
  const profile = await readProfile(paths.directory, name, agentProfileOptions);
  await writeProfile(paths.directory, { ...profile, paused }, agentProfileOptions);
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
  const name = assertWalletName(
    required(parsed.positionals[0], "<name>", "Usage: vapi agent revoke <name>"),
  );
  const paths = getVapiPaths();
  const readProfile = dependencies.agent?.readAgentProfile ?? readAgentProfile;
  const removeProfile = dependencies.agent?.removeAgentProfile ?? removeAgentProfile;
  const profile = await readProfile(paths.directory, name, agentProfileOptions);
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
  const sweep = `vapi sweep ${owner ?? "<address>"} --account ${profile.wallet}`;
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

export function positiveUsdOption(
  value: string,
  option: string,
): { text: string; number: number; atomic: string } {
  try {
    const parsed = usdOption(value, option);
    if (BigInt(parsed.atomic) <= 0n) throw new Error("not positive");
    return parsed;
  } catch {
    throw new UsageError(
      `${option} must be a positive US dollar amount with at most 6 decimals, such as 0.25 or 10.`,
    );
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

function required(value: string | undefined, argument: string, usage: string): string {
  if (value === undefined || value.length === 0) {
    throw new UsageError(`Missing ${argument}.\n${usage}`);
  }
  return value;
}

function shortAddress(address: string): string {
  return address.length <= 12 ? address : `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/** Exact USDC amount: $0.005 stays $0.005 instead of rounding to $0.01. */
function usd(value: number, minimumDecimals = 0): string {
  const [whole, fraction = ""] = formatUsdc(BigInt(Math.round(value * 1_000_000))).split(".");
  const decimals = fraction.padEnd(minimumDecimals, "0");
  return `$${whole}${decimals === "" ? "" : `.${decimals}`}`;
}
