import { lookup } from "node:dns/promises";
import { mkdir, readFile, writeFile } from "node:fs/promises";

import { createPublicFetch, getVapiPaths } from "@vapi-network/core";

import { runCli, type CliDependencies, type CliIo } from "./cli.js";
import { CLI_VERSION } from "./version.js";

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1_000;
const CHECK_TIMEOUT_MS = 1_500;
const LATEST_URL = "https://registry.npmjs.org/vapi-network/latest";

type UpdateCheckOptions = {
  argv?: string[];
  env?: NodeJS.ProcessEnv;
  stderrIsTTY?: boolean;
  home?: string;
  fetchImpl?: typeof fetch;
  nowMs?: () => number;
};

/** Only the executable entry points check for updates, never SDK or MCP calls. */
export async function runCliWithUpdateCheck(
  argv = process.argv.slice(2),
  io: CliIo = {
    stdout: (message) => console.log(message),
    stderr: (message) => console.error(message),
  },
  dependencies: CliDependencies = {},
  options: UpdateCheckOptions = {},
): Promise<number> {
  const notice = checkForUpdate({ ...options, env: options.env ?? dependencies.env, argv });
  const code = await runCli(argv, io, dependencies);
  const message = await notice;
  if (message) io.stderr(message);
  return code;
}

export async function checkForUpdate(
  options: UpdateCheckOptions = {},
): Promise<string | undefined> {
  const env = options.env ?? process.env;
  const argv = options.argv ?? process.argv.slice(2);
  if (
    !(options.stderrIsTTY ?? process.stderr.isTTY) ||
    argv.includes("--json") ||
    argv[0] === "claude" ||
    argv[0] === "codex" ||
    (argv[0] === "mcp" && argv[1] !== "install") ||
    env.VAPI_NO_UPDATE_CHECK === "1" ||
    env.CI !== undefined
  ) {
    return undefined;
  }

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      latestNotice(options, env, controller.signal),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => {
          controller.abort();
          resolve(undefined);
        }, CHECK_TIMEOUT_MS);
      }),
    ]);
  } catch {
    return undefined;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    controller.abort();
  }
}

async function latestNotice(
  options: UpdateCheckOptions,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
): Promise<string | undefined> {
  const paths = getVapiPaths(options.home ?? (env.VAPI_HOME?.trim() || undefined));
  const now = (options.nowMs ?? Date.now)();
  let cached: { checkedAt: number; latest: string } | undefined;
  try {
    const value: unknown = JSON.parse(await readFile(paths.updateCheck, "utf8"));
    if (
      isRecord(value) &&
      typeof value.checkedAt === "number" &&
      Number.isFinite(value.checkedAt) &&
      typeof value.latest === "string" &&
      parseVersion(value.latest)
    ) {
      cached = { checkedAt: value.checkedAt, latest: value.latest };
    }
  } catch {
    // A missing or damaged cache is refreshed like a first run.
  }
  signal.throwIfAborted();
  let latest = cached?.latest ?? CLI_VERSION;
  if (
    cached === undefined ||
    now - cached.checkedAt >= CHECK_INTERVAL_MS ||
    now < cached.checkedAt
  ) {
    await mkdir(paths.directory, { recursive: true });
    signal.throwIfAborted();
    // Record failed attempts too, so an offline terminal checks at most daily.
    await writeFile(paths.updateCheck, JSON.stringify({ checkedAt: now, latest }), { mode: 0o600 });
    signal.throwIfAborted();
    const fetchImpl =
      options.fetchImpl ??
      createPublicFetch({
        allowPrivateNetwork: false,
        lookup: async (hostname) => {
          let onAbort: () => void;
          const aborted = new Promise<never>((_resolve, reject) => {
            onAbort = () => reject(signal.reason);
            signal.addEventListener("abort", onAbort, { once: true });
          });
          try {
            signal.throwIfAborted();
            const addresses = await Promise.race([lookup(hostname, { all: true }), aborted]);
            return addresses.map(({ address }) => address);
          } finally {
            signal.removeEventListener("abort", onAbort!);
          }
        },
      });
    const response = await fetchImpl(LATEST_URL, { signal, redirect: "error" });
    if (!response.ok) return undefined;
    const body: unknown = await response.json();
    signal.throwIfAborted();
    if (!isRecord(body) || typeof body.version !== "string" || !parseVersion(body.version)) {
      return undefined;
    }
    latest = body.version;
    await writeFile(paths.updateCheck, JSON.stringify({ checkedAt: now, latest }), { mode: 0o600 });
  }
  signal.throwIfAborted();
  return isNewerVersion(latest, CLI_VERSION)
    ? `vapi-network ${latest} is available (you have ${CLI_VERSION}). Update: npm i -g vapi-network@latest`
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseVersion(version: string): { core: bigint[]; prerelease?: string[] } | undefined {
  const match =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([\da-zA-Z.-]+))?(?:\+[\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*)?$/.exec(
      version,
    );
  if (!match) return undefined;
  const prerelease = match[4]?.split(".");
  if (prerelease?.some((part) => part === "" || (/^\d+$/.test(part) && /^0\d/.test(part)))) {
    return undefined;
  }
  return { core: match.slice(1, 4).map(BigInt), prerelease };
}

function isNewerVersion(latest: string, current: string): boolean {
  const next = parseVersion(latest)!;
  const running = parseVersion(current)!;
  for (let index = 0; index < 3; index += 1) {
    if (next.core[index] !== running.core[index]) return next.core[index]! > running.core[index]!;
  }
  if (running.prerelease === undefined) return false;
  if (next.prerelease === undefined) return true;
  for (
    let index = 0;
    index < Math.max(next.prerelease.length, running.prerelease.length);
    index += 1
  ) {
    const a = next.prerelease[index];
    const b = running.prerelease[index];
    if (a === b) continue;
    if (a === undefined) return false;
    if (b === undefined) return true;
    const aNumeric = /^\d+$/.test(a);
    const bNumeric = /^\d+$/.test(b);
    if (aNumeric && bNumeric) return BigInt(a) > BigInt(b);
    if (aNumeric !== bNumeric) return !aNumeric;
    return a > b;
  }
  return false;
}
