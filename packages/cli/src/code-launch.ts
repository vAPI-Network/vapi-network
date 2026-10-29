import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { constants, homedir } from "node:os";

import { createPublicFetch, isMissingFile } from "@vapi-network/core";
import {
  RouterClientError,
  routerCredentials,
  routerUsage,
  type AgentRouterUsage,
  type RouterClientDeps,
} from "@vapi-network/core/router-client";

import {
  UsageError,
  getEnvironment,
  targetWallet,
  type CliDependencies,
  type CliIo,
} from "./cli.js";
import {
  VAPI_CODEX_DEFAULT_MODEL,
  VAPI_CODEX_PROFILE,
  VAPI_CODEX_PROVIDER,
  VAPI_ROUTER_KEY_ENV,
  codexConfigPath,
  hasVapiCodexProfile,
  resolveBinary,
  type CodeChild,
} from "./code.js";
import { routerDeps } from "./router.js";

export type CodeProcessSignals = {
  on(signal: NodeJS.Signals, listener: () => void): unknown;
  removeListener(signal: NodeJS.Signals, listener: () => void): unknown;
};
type Tool = "claude" | "codex";
type Credentials = Awaited<ReturnType<typeof routerCredentials>>;
type LaunchOptions = {
  own: boolean;
  vapi: boolean;
  balance: boolean;
  model?: string;
  account?: string;
  forwarded: string[];
};
type Route =
  | { kind: "unavailable"; reason: string }
  | { kind: "own"; reason?: string; exhausted?: boolean }
  | { kind: "vapi"; credentials: Credentials; usage?: AgentRouterUsage };
const CLAUDE_MODELS = {
  sonnet: "venice/claude-sonnet-5-5",
  opus: "venice/claude-opus-5-5",
  haiku: "venice/claude-haiku-5-5",
};

export async function claudeCommand(
  argv: string[],
  json: boolean,
  io: CliIo,
  dependencies: CliDependencies,
): Promise<number> {
  return await launch("claude", argv, json, io, dependencies);
}

export async function codexCommand(
  argv: string[],
  json: boolean,
  io: CliIo,
  dependencies: CliDependencies,
): Promise<number> {
  return await launch("codex", argv, json, io, dependencies);
}

function parseLaunch(argv: string[]): LaunchOptions {
  const result: LaunchOptions = { own: false, vapi: false, balance: false, forwarded: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--") {
      result.forwarded.push(...argv.slice(index + 1));
      break;
    }
    if (arg === "--own") result.own = true;
    else if (arg === "--vapi") result.vapi = true;
    else if (arg === "--use-balance") result.balance = true;
    else if (arg === "--model" || arg === "--account") {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new UsageError(`Expected ${arg} <value>.`);
      if (arg === "--model") result.model = value;
      else result.account = value;
    } else result.forwarded.push(arg);
  }
  if (result.own && result.vapi) throw new UsageError("--vapi and --own cannot be used together.");
  return result;
}

class LaunchTimeout extends Error {
  constructor() {
    super("timed out");
  }
}

async function bounded<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  milliseconds: number,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          const error = new LaunchTimeout();
          controller.abort(error);
          reject(error);
        }, milliseconds);
      }),
      operation(controller.signal),
    ]);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

// Abort real requests too; a promise race alone leaves sockets active after fallback.
function abortableDeps(deps: RouterClientDeps, signal: AbortSignal): RouterClientDeps {
  const fetchImpl = deps.fetchImpl ?? createPublicFetch({ allowPrivateNetwork: false });
  return {
    ...deps,
    fetchImpl: (input, init) =>
      fetchImpl(input, {
        ...init,
        signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal,
      }),
  };
}

function shortReason(error: unknown, env: NodeJS.ProcessEnv, credentials?: Credentials): string {
  if (error instanceof RouterClientError) {
    if (error.code === "not_linked") return "not linked, run vapi code install";
    if (error.code === "no_router_key") return "no Router key, run vapi code install";
  }
  let message = error instanceof Error ? error.message : String(error);
  for (const secret of [
    credentials?.apiKey,
    env.ANTHROPIC_API_KEY,
    env.ANTHROPIC_AUTH_TOKEN,
    env[VAPI_ROUTER_KEY_ENV],
  ]) {
    if (secret) message = message.replaceAll(secret, "[redacted]");
  }
  return message.replace(/\s+/gu, " ").trim().slice(0, 160) || "request failed";
}

async function chooseRoute(
  options: LaunchOptions,
  env: NodeJS.ProcessEnv,
  dependencies: CliDependencies,
): Promise<Route> {
  if (options.own) return { kind: "own" };
  const timeout = dependencies.code?.usageTimeoutMs ?? 4_000;
  let credentials: Credentials | undefined;
  let deps: RouterClientDeps | undefined;
  let balanceKeyRequired = false;
  try {
    credentials = await bounded(async (signal) => {
      const target = await targetWallet(
        { one: (name) => (name === "--wallet" ? options.account : undefined) },
        dependencies,
        env.VAPI_HOME,
      );
      signal.throwIfAborted();
      deps = routerDeps(target, dependencies);
      return await (dependencies.router?.routerCredentials ?? routerCredentials)(
        abortableDeps(deps, signal),
      );
    }, timeout);
    let usage: AgentRouterUsage;
    try {
      usage = await bounded(
        (signal) => (dependencies.router?.routerUsage ?? routerUsage)(abortableDeps(deps!, signal)),
        timeout,
      );
      if (!Number.isFinite(new Date(usage.compute.resetsAt).getTime()))
        throw new Error("invalid Compute reset time");
    } catch (error) {
      if (options.vapi) return { kind: "vapi", credentials };
      throw error;
    }
    if (options.vapi || remaining(usage, options.balance) >= 0.5) {
      // A session has one funding key; choose balance only when Compute cannot qualify alone.
      if (
        options.balance &&
        usage.compute.remainingTodayUsd < 0.5 &&
        (usage.balance?.remainingUsd ?? 0) > 0
      ) {
        balanceKeyRequired = true;
        credentials = await bounded(
          (signal) =>
            (dependencies.router?.routerCredentials ?? routerCredentials)(
              abortableDeps(deps!, signal),
              { funding: "balance" },
            ),
          timeout,
        );
      }
      return { kind: "vapi", credentials, usage };
    }
    return { kind: "own", exhausted: true };
  } catch (error) {
    const reason =
      balanceKeyRequired && error instanceof RouterClientError && error.code === "no_router_key"
        ? "no Router balance key is stored"
        : shortReason(error, env, credentials);
    if (options.vapi) return { kind: "unavailable", reason };
    return { kind: "own", reason };
  }
}

function remaining(usage: AgentRouterUsage, useBalance: boolean): number {
  return usage.compute.remainingTodayUsd + (useBalance ? (usage.balance?.remainingUsd ?? 0) : 0);
}

async function launch(
  tool: Tool,
  argv: string[],
  json: boolean,
  io: CliIo,
  dependencies: CliDependencies,
): Promise<number> {
  if (json) throw new UsageError(`vapi ${tool} is interactive and does not support --json.`);
  const options = parseLaunch(argv);
  const env = getEnvironment(dependencies);
  let binary: string | undefined;
  try {
    binary = await resolveBinary(tool, { ...dependencies.code, env });
  } catch (error) {
    io.stderr(shortReason(error, env));
    return 127;
  }
  if (binary === undefined) {
    io.stderr(
      `\`${tool}\` is not on PATH. Install ${tool === "claude" ? "Claude Code" : "Codex"} first.`,
    );
    return 127;
  }
  const route = await chooseRoute(options, env, dependencies);
  if (route.kind === "unavailable") {
    io.stderr(route.reason);
    return 1;
  }
  let args = options.forwarded;
  let childEnv = env;
  const own = tool === "claude" ? "your own Claude subscription" : "your own Codex/ChatGPT login";
  if (route.kind === "own") {
    if (route.exhausted) io.stderr(`● Compute used up today → ${own}`);
    else if (route.reason !== undefined) io.stderr(`● vAPI unreachable (${route.reason}) → ${own}`);
    if (options.model !== undefined)
      args = [tool === "claude" ? "--model" : "-m", options.model, ...args];
  } else {
    const { credentials, usage } = route;
    const model =
      tool === "claude" ? claudeModel(options.model) : (options.model ?? VAPI_CODEX_DEFAULT_MODEL);
    let status = "● vAPI Compute";
    if (usage !== undefined)
      status += ` — $${remaining(usage, options.balance).toFixed(2)} left today (resets ${new Date(usage.compute.resetsAt).toISOString().slice(11, 16)} UTC)`;
    io.stderr(`${status} · model ${model.slice(model.lastIndexOf("/") + 1)}`);
    io.stderr(
      tool === "claude"
        ? "  Compute runs out mid-session? /exit, then: vapi claude --continue"
        : "  Compute runs out mid-session? /quit, then: vapi codex resume --last",
    );
    if (tool === "claude") {
      childEnv = {
        ...env,
        ANTHROPIC_BASE_URL: credentials.baseURL.replace(/\/v1\/?$/u, ""),
        ANTHROPIC_AUTH_TOKEN: credentials.apiKey,
      };
      delete childEnv.ANTHROPIC_API_KEY;
      if (args.some((arg) => arg === "--settings" || arg.startsWith("--settings=")))
        io.stderr("● Your --settings is passed as is; vAPI model settings were not added.");
      else
        args = [
          "--settings",
          JSON.stringify({
            env: {
              ANTHROPIC_MODEL: model,
              ANTHROPIC_DEFAULT_SONNET_MODEL: CLAUDE_MODELS.sonnet,
              ANTHROPIC_DEFAULT_OPUS_MODEL: CLAUDE_MODELS.opus,
              ANTHROPIC_DEFAULT_HAIKU_MODEL: CLAUDE_MODELS.haiku,
              CLAUDE_CODE_MAX_RETRIES: "2",
            },
          }),
          ...args,
        ];
    } else {
      childEnv = { ...env, [VAPI_ROUTER_KEY_ENV]: credentials.apiKey };
      args = [...(await codexArgs(env, credentials.baseURL, options.model, dependencies)), ...args];
    }
  }
  return await runChild(binary, args, childEnv, io, dependencies);
}

function claudeModel(model: string | undefined): string {
  return model === undefined
    ? CLAUDE_MODELS.sonnet
    : Object.hasOwn(CLAUDE_MODELS, model)
      ? CLAUDE_MODELS[model as keyof typeof CLAUDE_MODELS]
      : model;
}

async function codexArgs(
  env: NodeJS.ProcessEnv,
  baseURL: string,
  model: string | undefined,
  dependencies: CliDependencies,
): Promise<string[]> {
  let contents = "";
  try {
    contents = await readFile(
      codexConfigPath(env, dependencies.code?.homedir ?? homedir()),
      "utf8",
    );
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }
  // Bind the selected key to the current Router, even when an installed profile is stale.
  const providerArgs = [
    "-c",
    `model_providers.${VAPI_CODEX_PROVIDER}.name="vAPI Router"`,
    "-c",
    `model_providers.${VAPI_CODEX_PROVIDER}.base_url=${JSON.stringify(baseURL)}`,
    "-c",
    `model_providers.${VAPI_CODEX_PROVIDER}.env_key="${VAPI_ROUTER_KEY_ENV}"`,
    "-c",
    `model_providers.${VAPI_CODEX_PROVIDER}.wire_api="responses"`,
    "-c",
    `model_provider="${VAPI_CODEX_PROVIDER}"`,
  ];
  if (hasVapiCodexProfile(contents))
    return [
      "--profile",
      VAPI_CODEX_PROFILE,
      ...providerArgs,
      ...(model === undefined ? [] : ["-m", model]),
    ];
  return [...providerArgs, "-m", model ?? VAPI_CODEX_DEFAULT_MODEL];
}

async function runChild(
  binary: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  io: CliIo,
  dependencies: CliDependencies,
): Promise<number> {
  const signals = dependencies.code?.processSignals ?? process;
  let child: CodeChild | undefined;
  const ignore = () => {};
  const forward = (signal: NodeJS.Signals) => () => {
    try {
      child?.kill(signal);
    } catch (error) {
      io.stderr(shortReason(error, env));
    }
  };
  const listeners: Array<[NodeJS.Signals, () => void]> = [
    ["SIGINT", ignore],
    ["SIGQUIT", ignore],
    ["SIGTERM", forward("SIGTERM")],
    ["SIGHUP", forward("SIGHUP")],
  ];
  try {
    for (const [signal, listener] of listeners) signals.on(signal, listener);
    return await new Promise<number>((resolve) => {
      let settled = false;
      const finish = (code: number) => {
        if (!settled) {
          settled = true;
          resolve(code);
        }
      };
      try {
        child = (dependencies.code?.spawn ?? spawn)(binary, args, { env, stdio: "inherit" });
        child.once("error", (error: Error) => {
          if (!settled) io.stderr(shortReason(error, env));
          finish(127);
        });
        child.once("exit", (code: number | null, signal: NodeJS.Signals | null) =>
          finish(code ?? (signal === null ? 1 : 128 + (constants.signals[signal] ?? 0))),
        );
      } catch (error) {
        io.stderr(shortReason(error, env));
        finish(127);
      }
    });
  } finally {
    for (const [signal, listener] of listeners) signals.removeListener(signal, listener);
  }
}
