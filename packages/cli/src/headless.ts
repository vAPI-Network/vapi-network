import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { rmSync } from "node:fs";
import { tmpdir as osTmpdir } from "node:os";
import { join } from "node:path";

import {
  createRunBudget,
  getVapiPaths,
  loadOrCreateDeviceKey,
  memorySecretStore,
  WalletStore,
  writeAgentProfile,
  writeJsonAtomic,
  type AgentProfile,
  type SecretStore,
} from "@vapi-network/core";
import { agentSecretAccounts } from "@vapi-network/core/agent-link";
import {
  headlessConfigFromBundle,
  openMemberBundle,
  type MemberBundle,
} from "@vapi-network/core/secrets";
import { registeredAgentProfileSchema, runAgent } from "@vapi-network/mcp";

import { buildAgentRunDeps, positiveUsdOption } from "./agent.js";
import {
  UsageError,
  getEnvironment,
  redactDetachedRunValue,
  type CliDependencies,
  type CliIo,
} from "./cli.js";

/**
 * Headless `vapi agent run --bundle-env <VAR>`: one swarm member running on a
 * remote sandbox from a member bundle.
 *
 * The bundle is read from one environment variable and removed from the
 * environment at once. The run gets an ephemeral 0700 home holding an
 * imported-key vault whose device key lives only in an in-memory secret store,
 * so it never touches the OS secret store. The home is removed when the run
 * ends, fails, or is stopped with SIGTERM/SIGINT. Neither the bundle nor the
 * key is ever written to argv, output, the result file, or a log.
 */

const BUNDLE_VARIABLE_PATTERN = /^[A-Z_][A-Z0-9_]*$/u;
/** Grants that need the treasury key, which never leaves the owner's machine. */
const REMOTE_BLOCKED_GRANTS = new Set<string>(["delegate", "allocate"]);
const agentProfileOptions = { schema: registeredAgentProfileSchema };

export type HeadlessHome = {
  home: string;
  secrets: SecretStore;
  cleanup(): Promise<void>;
};

export type HeadlessHomeOptions = {
  /** Parent directory of the ephemeral home. Defaults to `os.tmpdir()`. */
  tmpdir?: string;
  /** Randomness for the throwaway device vault key. */
  randomBytes?: (size: number) => Uint8Array;
  /** Injected clock for the wallet registry and vault records. */
  now?: () => Date;
  /** Called with the home path as soon as it exists, before any secret is written into it. */
  onCreated?: (home: string) => void;
};

/**
 * Builds an ephemeral VAPI_HOME for one member bundle: an imported-key vault
 * sealed with a random in-memory device key, `wallets.json` with the bundle's
 * caps, ceiling and link as the default wallet, the member's link credentials
 * in an in-memory secret store, the agent profile without delegate/allocate,
 * and `config.json` on the public RPC defaults. The home is removed again if
 * any step fails.
 */
export async function createHeadlessHome(
  bundle: MemberBundle,
  options: HeadlessHomeOptions = {},
): Promise<HeadlessHome> {
  const home = await mkdtemp(join(options.tmpdir ?? osTmpdir(), "vapi-headless-"));
  const cleanup = async (): Promise<void> => {
    await rm(home, { recursive: true, force: true });
  };
  try {
    await chmod(home, 0o700);
    options.onCreated?.(home);
    const secrets = memorySecretStore();
    // A random throwaway device key, held only by the in-memory store; the
    // vault it seals gets its own random phrase, never the owner's.
    const deviceKey = await loadOrCreateDeviceKey({
      secrets,
      ...(options.randomBytes === undefined ? {} : { randomBytes: options.randomBytes }),
    });
    deviceKey.fill(0);

    const store = await WalletStore.open(home, {
      secrets,
      env: {},
      ...(options.now === undefined ? {} : { now: options.now }),
    });
    const imported = await store.importKey(bundle.account, "", bundle.privateKey, {
      spendCaps: { ...bundle.caps },
    });
    if (imported.account.address.toLowerCase() !== bundle.address.toLowerCase()) {
      throw new Error("The member bundle's key does not match its address.");
    }
    // Remote authorizations are not reconciled back into the owner's journal.
    // Disable automatic sweeps so this disposable home can never sign a second
    // sweep while an earlier authorization may still settle.
    await store.setCeiling(bundle.account, null);
    await store.setLink(bundle.account, bundle.link);
    await store.setDefault(bundle.account);

    const names = agentSecretAccounts(bundle.account);
    await secrets.set(names.tokens, bundle.credentials.tokens);
    if (bundle.credentials.routerStake !== undefined) {
      await secrets.set(names.routerStake, bundle.credentials.routerStake);
    }
    if (bundle.credentials.routerBalance !== undefined) {
      await secrets.set(names.routerBalance, bundle.credentials.routerBalance);
    }

    await writeAgentProfile(home, remoteProfile(bundle), agentProfileOptions);
    // The bundle names networks only; RPC URLs are the public defaults, never the owner's.
    const configPath = getVapiPaths(home).config;
    const config = headlessConfigFromBundle(bundle.config);
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    return { home, secrets, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

/** Runs one member bundle headlessly and returns the process exit code. */
export async function runHeadlessAgent(input: {
  variable: string;
  task: string;
  budgetUsd?: string;
  resultFile?: string;
  json: boolean;
  io: CliIo;
  dependencies: CliDependencies;
}): Promise<number> {
  const { variable, task, resultFile, json, dependencies } = input;
  if (!BUNDLE_VARIABLE_PATTERN.test(variable)) {
    throw new UsageError("--bundle-env must name an environment variable such as VAPI_BUNDLE.");
  }
  const environment = getEnvironment(dependencies);
  const text = environment[variable];
  // Read once, then gone: no child process or tool may inherit the bundle.
  delete environment[variable];
  delete process.env[variable];
  if (text === undefined || text.length === 0) {
    throw new UsageError(`The environment variable ${variable} is not set.`);
  }
  const budgetOption =
    input.budgetUsd === undefined ? undefined : positiveUsdOption(input.budgetUsd, "--budget");

  let redaction: NodeJS.ProcessEnv = { ...environment, MEMBER_BUNDLE_SECRET: text };
  const io = redactingIo(input.io, () => redaction);
  let home: string | undefined;
  const removeSignalHandlers = (): void => {
    process.removeListener("SIGTERM", onSigterm);
    process.removeListener("SIGINT", onSigint);
  };
  const onSignal = (code: number): void => {
    if (home !== undefined) rmSync(home, { recursive: true, force: true });
    process.exit(code);
  };
  const onSigterm = (): void => onSignal(143);
  const onSigint = (): void => onSignal(130);
  const previousHome = process.env.VAPI_HOME;
  try {
    const bundle = openMemberBundle(text);
    redaction = { ...redaction, ...bundleSecrets(bundle) };
    const profile = remoteProfile(bundle);
    if (profile.paused) {
      const message = `Agent ${profile.name} is paused. Run vapi agent resume ${profile.name}.`;
      const result = { error: message, exitCode: 1 };
      if (resultFile !== undefined) {
        await writeJsonAtomic(resultFile, { v: 1, exitCode: 1, result }, { mode: 0o600 });
      }
      if (json) io.stdout(JSON.stringify(result));
      else io.stderr(message);
      return 1;
    }

    process.once("SIGTERM", onSigterm);
    process.once("SIGINT", onSigint);
    const created = await createHeadlessHome(bundle, {
      ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
      onCreated: (path) => {
        home = path;
      },
    });
    process.env.VAPI_HOME = created.home;
    const runDependencies: CliDependencies = {
      ...dependencies,
      secretStore: created.secrets,
      interactive: false,
      env: { ...environment, VAPI_HOME: created.home },
    };
    const budget =
      budgetOption === undefined
        ? undefined
        : createRunBudget({ id: bundle.runId, limitAtomic: BigInt(budgetOption.atomic) });
    const runMeta = {
      swarm: bundle.swarm,
      member: bundle.account,
      ...(bundle.parentRunId === undefined ? {} : { parentRunId: bundle.parentRunId }),
    };
    const agentDependencies = await buildAgentRunDeps({
      profile,
      runId: bundle.runId,
      ...(budget === undefined ? {} : { budget }),
      runMeta,
      allowanceExpiresAt: new Date(bundle.allowanceExpiresAt),
      approvals: "decline",
      json,
      io,
      dependencies: runDependencies,
    });
    const execute = dependencies.agent?.runAgent ?? runAgent;
    const result = redactDetachedRunValue(await execute(task, agentDependencies), redaction);
    const exitCode = result.stoppedBecause.reason === "finished" ? 0 : 1;
    if (resultFile !== undefined) {
      await writeJsonAtomic(resultFile, { v: 1, exitCode, result }, { mode: 0o600 });
    }
    if (json) io.stdout(JSON.stringify(result));
    else if (result.stoppedBecause.reason === "finished") io.stdout(result.answer ?? "");
    else io.stderr(result.stoppedBecause.detail ?? result.stoppedBecause.reason);
    return exitCode;
  } catch (error) {
    const raw = error instanceof Error ? error.message : String(error);
    const message = redactDetachedRunValue(raw, redaction);
    if (resultFile !== undefined) {
      await writeJsonAtomic(
        resultFile,
        { v: 1, exitCode: 1, error: { message } },
        { mode: 0o600 },
      ).catch(() => undefined);
    }
    if (json) io.stdout(JSON.stringify({ error: message, exitCode: 1 }));
    else io.stderr(message);
    return 1;
  } finally {
    if (previousHome === undefined) delete process.env.VAPI_HOME;
    else process.env.VAPI_HOME = previousHome;
    if (home !== undefined) await rm(home, { recursive: true, force: true });
    removeSignalHandlers();
  }
}

/** The bundle profile bound to the bundle's account, without the treasury grants. */
function remoteProfile(bundle: MemberBundle): AgentProfile {
  return {
    ...bundle.profile,
    wallet: bundle.account,
    grants: bundle.profile.grants.filter((grant) => !REMOTE_BLOCKED_GRANTS.has(grant)),
  };
}

/**
 * The bundle's secret values under secret-looking names, so the run redaction
 * scrubs them by exact value from the result, the result file and the output.
 */
function bundleSecrets(bundle: MemberBundle): NodeJS.ProcessEnv {
  const secrets: NodeJS.ProcessEnv = {
    MEMBER_PRIVATE_KEY: bundle.privateKey,
    MEMBER_TOKEN: bundle.credentials.tokens,
  };
  if (bundle.credentials.routerStake !== undefined) {
    secrets.MEMBER_ROUTER_STAKE_KEY = bundle.credentials.routerStake;
  }
  if (bundle.credentials.routerBalance !== undefined) {
    secrets.MEMBER_ROUTER_BALANCE_KEY = bundle.credentials.routerBalance;
  }
  // The stored token is JSON; scrub its short-lived access token too.
  try {
    tokenStrings(JSON.parse(bundle.credentials.tokens)).forEach((value, index) => {
      secrets[`MEMBER_TOKEN_${index}_TOKEN`] = value;
    });
  } catch {
    // Not JSON: the raw value above is scrubbed as a whole.
  }
  return secrets;
}

/** The string values stored under a `…Token` key, such as `accessToken`. */
function tokenStrings(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(tokenStrings);
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(value).flatMap(([key, item]) =>
    typeof item === "string" ? (/token$/iu.test(key) ? [item] : []) : tokenStrings(item),
  );
}

function redactingIo(io: CliIo, environment: () => NodeJS.ProcessEnv): CliIo {
  return {
    stdout: (message) => io.stdout(redactDetachedRunValue(message, environment())),
    stderr: (message) => io.stderr(redactDetachedRunValue(message, environment())),
  };
}
