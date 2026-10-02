import { execFileSync, spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { closeSync, mkdirSync, openSync, realpathSync } from "node:fs";
import { readFile as nodeReadFile } from "node:fs/promises";

import {
  getDefaultConfig,
  getVapiPaths,
  isMissingFile,
  loadConfig,
  type VapiConfig,
} from "@vapi-network/core";
import {
  runLogPath,
  runResultPath,
  runsDirectory,
  type Runtime,
  type RuntimeHandle,
  type RuntimeKind,
  type RuntimeMember,
  type RuntimeRun,
  type RuntimeStatus,
} from "@vapi-network/mcp";

import {
  UsageError,
  deviceVaultKey,
  getEnvironment,
  getSecretStore,
  isInteractive,
  type CliDependencies,
} from "./cli.js";
import { createRailwayRuntime, type RailwayRuntimeOptions } from "./runtime-railway.js";

type Spawn = (
  command: string,
  args: readonly string[],
  options: {
    detached: true;
    stdio: ["ignore", number, number];
    env: NodeJS.ProcessEnv;
    windowsHide: true;
  },
) => Pick<ChildProcess, "pid" | "unref">;

export type LocalRuntimeOptions = {
  home: string;
  entry?: string;
  execPath?: string;
  env?: NodeJS.ProcessEnv;
  spawn?: Spawn;
  kill?: (pid: number, signal: NodeJS.Signals | 0) => void;
  /** Full command line of a live process, or undefined when there is none. */
  processCommand?: (pid: number) => string | undefined;
  openLog?: (path: string) => number;
  closeFd?: (fd: number) => void;
  readFile?: (path: string, encoding: "utf8") => Promise<string>;
  now?: () => Date;
};

export function createLocalRuntime(options: LocalRuntimeOptions): Runtime {
  const { home } = options;
  const entry = options.entry ?? realpathSync(process.argv[1]!);
  const execPath = options.execPath ?? process.execPath;
  const spawn = options.spawn ?? (nodeSpawn as Spawn);
  const kill = options.kill ?? ((pid, signal) => process.kill(pid, signal));
  const processCommand = options.processCommand ?? defaultProcessCommand;
  // The child is its own process-group leader and carries the run's result path in its argv.
  // A pid the OS has since reused for another process never matches, so it is never signalled.
  const ownsProcess = (handle: RuntimeHandle, pid: number): boolean =>
    processCommand(pid)?.includes(runResultPath(home, handle.runId)) === true;
  const closeFd = options.closeFd ?? closeSync;
  const readFile = options.readFile ?? nodeReadFile;
  const now = options.now ?? (() => new Date());
  const openLog =
    options.openLog ??
    ((path: string): number => {
      mkdirSync(runsDirectory(home), { recursive: true, mode: 0o700 });
      return openSync(path, "a", 0o600);
    });

  return {
    kind: "local",
    async start(member: RuntimeMember, run: RuntimeRun, persistLaunch) {
      if (run.task.startsWith("--")) {
        throw new Error('A detached run task must not start with "--".');
      }
      const args = childArguments(member, run);
      const resultPath = runResultPath(home, run.runId);
      const logPath = runLogPath(home, run.runId);
      const logFd = openLog(logPath);
      let child: Pick<ChildProcess, "pid" | "unref">;
      try {
        child = spawn(execPath, [entry, ...args, "--json", "--result-file", resultPath], {
          detached: true,
          stdio: ["ignore", logFd, logFd],
          env: {
            ...withoutInheritedRunVariables(options.env ?? process.env),
            VAPI_HOME: home,
            VAPI_RUN_ID: run.runId,
            ...(run.parentRunId === undefined ? {} : { VAPI_PARENT_RUN_ID: run.parentRunId }),
            ...(run.mode === "agent" && member.swarm !== undefined
              ? { VAPI_SWARM: member.swarm }
              : {}),
          },
          windowsHide: true,
        });
      } finally {
        closeFd(logFd);
      }
      if (child.pid === undefined)
        throw new Error("The local runtime did not return a process id.");
      const handle: RuntimeHandle = {
        runId: run.runId,
        kind: "local",
        member,
        startedAt: now().toISOString(),
        ref: String(child.pid),
      };
      try {
        await persistLaunch?.(handle);
      } catch (error) {
        try {
          kill(-child.pid, "SIGTERM");
        } catch {
          // The worker already exited; preserving the persistence error is more useful.
        }
        throw error;
      }
      child.unref();
      return handle;
    },
    async status(handle: RuntimeHandle): Promise<RuntimeStatus> {
      const result = await readResultFile(readFile, runResultPath(home, handle.runId));
      if (result !== undefined) return result;
      const pid = localPid(handle);
      if (pid === undefined || handle.kind !== "local") {
        return { state: "unknown", detail: "invalid local runtime handle" };
      }
      try {
        kill(-pid, 0);
      } catch (error) {
        if (hasCode(error, "ESRCH")) {
          return { state: "unknown", detail: "exited without a result" };
        }
        if (hasCode(error, "EPERM")) {
          return { state: "unknown", detail: "process group is not accessible" };
        }
        throw error;
      }
      if (!ownsProcess(handle, pid)) {
        return { state: "unknown", detail: "exited without a result" };
      }
      return { state: "running" };
    },
    async stop(handle: RuntimeHandle): Promise<void> {
      const pid = localPid(handle);
      if (handle.kind !== "local" || pid === undefined) {
        throw new Error("Invalid local runtime process id.");
      }
      if (!ownsProcess(handle, pid)) return;
      try {
        kill(-pid, "SIGTERM");
      } catch (error) {
        if (!hasCode(error, "ESRCH")) throw error;
      }
    },
  };
}

/** What one start asks of a remote runtime. Status, list and stop need none of it. */
export type RuntimeRequest = {
  checkpoint?: string;
  allowRemoteKey?: boolean;
  keepSandbox?: boolean;
  /** The member accounts the owner confirmed; a railway start refuses any other. */
  confirmedMembers?: readonly string[];
};

export type RuntimeOptions = LocalRuntimeOptions & {
  railway?: Omit<RailwayRuntimeOptions, "home">;
};

export function runtimeForKind(kind: RuntimeKind, options: RuntimeOptions): Runtime {
  if (kind === "local") return createLocalRuntime(options);
  return createRailwayRuntime({ ...options.railway, home: options.home });
}

export function resolveRuntime(
  kind: RuntimeKind,
  home: string,
  dependencies: CliDependencies,
  request?: RuntimeRequest,
): Runtime {
  const injected =
    request === undefined
      ? dependencies.runtime?.(kind, home)
      : dependencies.runtime?.(kind, home, request);
  if (injected !== undefined) return injected;
  if (kind === "local") return runtimeForKind(kind, { home });
  return runtimeForKind(kind, { home, railway: railwayOptions(home, dependencies, request) });
}

/**
 * The railway adapter built from CLI dependencies: the CLI's secret store, its
 * swarm balance reader and fetch, and the device vault key read exactly as
 * `vapi export-key` reads it. A start without a request exports nothing: the
 * adapter refuses without a checkpoint and without `allowRemoteKey`.
 */
function railwayOptions(
  home: string,
  dependencies: CliDependencies,
  request: RuntimeRequest = {},
): Omit<RailwayRuntimeOptions, "home"> {
  const environment = getEnvironment(dependencies);
  return {
    secrets: getSecretStore(dependencies),
    vaultKey: async () => await deviceVaultKey({ home }, dependencies),
    config: async () => await loadRuntimeConfig(home, environment),
    tty: isInteractive(dependencies),
    env: environment,
    ...(request.checkpoint === undefined ? {} : { checkpoint: request.checkpoint }),
    ...(request.allowRemoteKey === undefined ? {} : { allowRemoteKey: request.allowRemoteKey }),
    ...(request.keepSandbox === undefined ? {} : { keepSandbox: request.keepSandbox }),
    ...(request.confirmedMembers === undefined
      ? {}
      : { confirmedMembers: request.confirmedMembers }),
    ...(dependencies.railwayExec === undefined ? {} : { exec: dependencies.railwayExec }),
    ...(dependencies.swarm?.balanceReader === undefined
      ? {}
      : { balanceReader: dependencies.swarm.balanceReader }),
    ...(dependencies.fetchImpl === undefined ? {} : { fetchImpl: dependencies.fetchImpl }),
    ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
  };
}

async function loadRuntimeConfig(home: string, env: NodeJS.ProcessEnv): Promise<VapiConfig> {
  try {
    return await loadConfig(getVapiPaths(home).config, env);
  } catch (error) {
    if (!isMissingFile(error)) throw error;
    return getDefaultConfig(env);
  }
}

export function parseRuntimeKind(value: string | undefined): RuntimeKind {
  if (value === undefined) return "local";
  if (value === "local" || value === "railway") return value;
  throw new UsageError("--runtime must be local or railway.");
}

function childArguments(member: RuntimeMember, run: RuntimeRun): string[] {
  if (run.mode === "agent") {
    return [
      "agent",
      "run",
      member.profile,
      run.task,
      ...(run.budgetUsd ? ["--budget", run.budgetUsd] : []),
    ];
  }
  if (member.swarm === undefined) {
    throw new Error("A lead runtime member must include a swarm.");
  }
  return [
    "swarm",
    "run",
    member.swarm,
    run.task,
    "--mode",
    "lead",
    "--lead",
    member.account,
    ...(run.budgetUsd ? ["--budget", run.budgetUsd] : []),
    ...(run.drawUsd ? ["--draw", run.drawUsd] : []),
  ];
}

async function readResultFile(
  readFile: (path: string, encoding: "utf8") => Promise<string>,
  path: string,
): Promise<RuntimeStatus | undefined> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (hasCode(error, "ENOENT")) return undefined;
    return { state: "failed", detail: "unreadable result file" };
  }
  try {
    const envelope = JSON.parse(text) as unknown;
    if (!isResultEnvelope(envelope)) throw new Error("invalid result envelope");
    return {
      state: envelope.exitCode === 0 ? "finished" : "failed",
      exitCode: envelope.exitCode,
      ...("result" in envelope ? { result: envelope.result } : {}),
      ...(envelope.error === undefined ? {} : { detail: envelope.error.message }),
    };
  } catch {
    return { state: "failed", detail: "unreadable result file" };
  }
}

type ResultEnvelope = {
  v: 1;
  exitCode: number;
  result?: unknown;
  error?: { message: string; code?: string };
};

function isResultEnvelope(value: unknown): value is ResultEnvelope {
  if (typeof value !== "object" || value === null) return false;
  const envelope = value as Partial<ResultEnvelope>;
  if (
    envelope.v !== 1 ||
    !Number.isSafeInteger(envelope.exitCode) ||
    (envelope.exitCode as number) < 0
  ) {
    return false;
  }
  const hasResult = Object.prototype.hasOwnProperty.call(envelope, "result");
  const hasError =
    typeof envelope.error === "object" &&
    envelope.error !== null &&
    typeof envelope.error.message === "string" &&
    (envelope.error.code === undefined || typeof envelope.error.code === "string");
  if (envelope.exitCode === 0) return hasResult && envelope.error === undefined;
  return hasResult || hasError;
}

function localPid(handle: RuntimeHandle): number | undefined {
  const pid = Number(handle.ref);
  return Number.isSafeInteger(pid) && pid > 1 ? pid : undefined;
}

function defaultProcessCommand(pid: number): string | undefined {
  try {
    return execFileSync("ps", ["-ww", "-o", "args=", "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    }).trim();
  } catch {
    return undefined;
  }
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

/** A child's run identity comes only from this start, never from the parent's shell. */
function withoutInheritedRunVariables(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const rest = { ...env };
  delete rest.VAPI_SWARM;
  delete rest.VAPI_RUN_ID;
  delete rest.VAPI_PARENT_RUN_ID;
  return rest;
}
