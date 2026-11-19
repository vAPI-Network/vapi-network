import { createInterface } from "node:readline/promises";

import {
  loadConfig,
  promptForSecret,
  type CeilingBalanceReader,
  type CeilingSiblingsFetcher,
  type CeilingTransfer,
  type DistributeArgs,
  type drainCeilingSweeps,
  type SecretStore,
  type SwarmCapitalDeps,
  type sweepAboveCeiling,
  type sweepBack,
  type sweepNativeEth,
  type TransferArgs,
  type VapiConfig,
} from "@vapi-network/core";
import type { pollDeviceLink, startDeviceLink } from "@vapi-network/core/agent-link";
import type {
  buyRouterBalance,
  listRouterModels,
  ownerStake,
  rotateRouterKey,
  routerChat,
  routerCredentials,
  routerUsage,
} from "@vapi-network/core/router-client";
import type { Runtime, RuntimeKind, runSwarm } from "@vapi-network/mcp";
import type { AgentCommandDependencies } from "./agent.js";
import type { TasksCommandDependencies } from "./task.js";
import type { RuntimeRequest } from "./runtime-local.js";
import type { RailwayExec } from "./runtime-railway.js";

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
  /** Whether stdin is a terminal, independently of redirected stdout. */
  stdinIsTTY?: boolean;
  /** The environment this run sees: wallet selection and agent detection. */
  env?: NodeJS.ProcessEnv;
  /**
   * Runtime adapter selection, injected so CLI tests never spawn real children.
   * A `vapi swarm run --runtime railway` start passes its request as well.
   */
  runtime?: (kind: RuntimeKind, home: string, request?: RuntimeRequest) => Runtime;
  /** The `railway` CLI executor, injected so tests never run the real binary. */
  railwayExec?: RailwayExec;
  /** The OS secret store `vapi unlock` and `vapi lock` act on. */
  secretStore?: SecretStore;
  /** The OS store setup probes before it makes a new vault; injected so tests never touch a real keychain. */
  secretBackendProbe?: SecretStore;
  /** Injected clock, so a signed message is reproducible in a test. */
  now?: () => Date;
  /** Injected hostname, so device naming is reproducible in a test. */
  hostname?: () => string;
  /** Device-link operations, injected so tests never touch the account service. */
  agentLink?: {
    startDeviceLink?: typeof startDeviceLink;
    pollDeviceLink?: typeof pollDeviceLink;
    forgetAgentLink?: typeof import("@vapi-network/core/agent-link").forgetAgentLink;
  };
  /** Router operations, injected so CLI tests never make service requests. */
  router?: {
    listRouterModels?: typeof listRouterModels;
    routerUsage?: typeof routerUsage;
    routerChat?: typeof routerChat;
    buyRouterBalance?: typeof buyRouterBalance;
    rotateRouterKey?: typeof rotateRouterKey;
    ownerStake?: typeof ownerStake;
    routerCredentials?: typeof routerCredentials;
  };
  /** Task transport and chain seams for deterministic commands. */
  tasks?: TasksCommandDependencies;
  /** Status-screen deadlines, injected so timeout behavior is deterministic in tests. */
  status?: { timeoutMs?: number };
  /** Cloud-backup seams, injected so relay and upload tests stay deterministic. */
  cloudBackup?: {
    startRelay?: typeof import("@vapi-network/core/cloud-backup").startRelay;
    awaitRelay?: typeof import("@vapi-network/core/cloud-backup").awaitRelay;
    uploadBackup?: typeof import("@vapi-network/core/cloud-backup").uploadBackup;
    fetchSiblings?: typeof import("@vapi-network/core").fetchSiblings;
    sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
    randomBytes?: (size: number) => Uint8Array;
    uploadTimeoutMs?: number;
  };
  /** Code installer and launcher seams; tests never touch the real HOME or processes. */
  code?: {
    homedir?: string;
    platform?: NodeJS.Platform;
    isExecutable?: (path: string) => Promise<boolean>;
    realpath?: (path: string) => Promise<string>;
    selfPath?: string;
    spawn?: import("./code.js").CodeSpawn;
    usageTimeoutMs?: number;
    processSignals?: import("./code-launch.js").CodeProcessSignals;
    login?: typeof import("./login.js").runLoginFlow;
  };
  /** MCP client locations, injected so installer tests never touch user config. */
  mcpInstall?: {
    platform?: NodeJS.Platform;
    homedir?: string;
    cwd?: string;
    appData?: string;
    runProcess?: import("./mcp-install.js").McpInstallProcessRunner;
  };
  /** Agent profile and run operations, injected so tests stay local and deterministic. */
  agent?: AgentCommandDependencies;
  /** Reads stdin to EOF for `vapi router chat ... -` and scripted vault restores. */
  readStdin?: () => Promise<string>;
  /** Opens one public URL in the platform browser. */
  openUrl?: (url: string) => boolean;
  /** Moves a wallet balance, injected for deterministic sweep command tests. */
  sweepBack?: typeof sweepBack;
  sweepNativeEth?: typeof sweepNativeEth;
  /** Transfer authorization inputs, injected so send tests are deterministic. */
  transfer?: {
    nonce?: TransferArgs["nonce"];
    timeoutMs?: number;
  };
  /** Distribution seams, injected so CLI tests never sign or relay live transfers. */
  distribute?: Pick<
    DistributeArgs,
    | "balanceReader"
    | "siblingsReader"
    | "transfer"
    | "authorizationState"
    | "randomId"
    | "randomNonce"
    | "timeoutMs"
    | "lockTimeoutMs"
  >;
  /** Swarm capital seams, injected so CLI tests never sign or relay live transfers. */
  swarm?: Pick<
    SwarmCapitalDeps,
    | "balanceReader"
    | "transfer"
    | "authorizationState"
    | "addressReader"
    | "randomId"
    | "randomNonce"
    | "unlock"
    | "timeoutMs"
    | "lockTimeoutMs"
  > & { runSwarm?: typeof runSwarm };
  /** Automatic ceiling sweep seams for status and short-lived paid calls. */
  ceiling?: {
    sweepAboveCeiling?: typeof sweepAboveCeiling;
    sweepAllAboveCeiling?: typeof import("@vapi-network/core").sweepAllAboveCeiling;
    drainCeilingSweeps?: typeof drainCeilingSweeps;
    balanceReader?: CeilingBalanceReader;
    fetchSiblingsImpl?: CeilingSiblingsFetcher;
    transfer?: CeilingTransfer;
    timeoutMs?: number;
  };
};

const defaultPrompts: CliPrompts = { secret: (prompt) => promptForSecret(prompt) };

export function getPrompts(dependencies: CliDependencies): CliPrompts {
  return dependencies.prompts ?? defaultPrompts;
}

export function getEnvironment(dependencies: CliDependencies): NodeJS.ProcessEnv {
  return dependencies.env ?? process.env;
}

/** A recovery phrase is shown only when a person can write it down. */
export function isInteractive(dependencies: CliDependencies): boolean {
  return dependencies.interactive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

/** Whether a secret can be typed without being echoed, even when stdout is redirected. */
export function isStdinInteractive(dependencies: CliDependencies): boolean {
  return dependencies.stdinIsTTY ?? dependencies.interactive ?? Boolean(process.stdin.isTTY);
}

/**
 * Reads one visible line. The prompt and the echo go to stderr, so a typed
 * confirmation never lands in the stdout a caller may be capturing.
 */
export async function promptForLine(prompt: string): Promise<string> {
  const reader = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return (await reader.question(prompt)).trim();
  } finally {
    reader.close();
  }
}

export function getLinePrompt(dependencies: CliDependencies): (prompt: string) => Promise<string> {
  return getPrompts(dependencies).line ?? promptForLine;
}

/** Loads the config and reports any retired registry URL it had to repair. */
export async function readConfig(path: string, io: CliIo): Promise<VapiConfig> {
  return await loadConfig(path, process.env, { notice: io.stderr });
}

export function output(io: CliIo, json: boolean, value: unknown, human: string): void {
  io.stdout(json ? JSON.stringify(value) : human);
}
