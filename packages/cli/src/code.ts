import type { ChildProcess } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, readFile, realpath, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, posix, win32 } from "node:path";

import { isMissingFile } from "@vapi-network/core";
import {
  RouterClientError,
  rotateRouterKey,
  routerCredentials,
  routerUsage,
} from "@vapi-network/core/router-client";

import {
  UsageError,
  getEnvironment,
  getLinePrompt,
  isStdinInteractive,
  parseArguments,
  targetWallet,
  type CliDependencies,
  type CliIo,
} from "./cli.js";
import { runLoginFlow } from "./login.js";
import { routerDeps } from "./router.js";
import { escapeToml, removeTomlTables, tomlKeyPath, tomlLines } from "./toml-config.js";

export const VAPI_CODEX_PROVIDER = "vapi";
export const VAPI_CODEX_PROFILE = "vapi";
export const VAPI_CODEX_DEFAULT_MODEL = "venice/openai-gpt-61-sol";
export const VAPI_ROUTER_KEY_ENV = "VAPI_ROUTER_KEY";
export type CodeChild = Pick<ChildProcess, "once" | "kill">;
export type CodeSpawn = (
  command: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; stdio: "inherit" },
) => CodeChild;

export function codexConfigPath(env: NodeJS.ProcessEnv, home: string): string {
  return join(env.CODEX_HOME || join(home, ".codex"), "config.toml");
}

export function hasVapiCodexProfile(contents: string): boolean {
  const roots = new Set(
    [...tomlLines(contents)].flatMap(({ table }) => {
      const path = table === undefined ? [] : tomlKeyPath(table);
      return path.length === 2 && path[1] === "vapi" ? [path[0]] : [];
    }),
  );
  return roots.has("model_providers") && roots.has("profiles");
}

type BinaryOptions = {
  env: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  isExecutable?: (path: string) => Promise<boolean>;
  realpath?: (path: string) => Promise<string>;
  selfPath?: string;
};

export async function resolveBinary(
  name: string,
  options: BinaryOptions,
): Promise<string | undefined> {
  const windows = (options.platform ?? process.platform) === "win32";
  const path =
    options.env.PATH ??
    (windows
      ? Object.entries(options.env).find(([key]) => key.toLowerCase() === "path")?.[1]
      : undefined);
  if (path === undefined) return undefined;
  const paths = windows ? win32 : posix;
  const canonical = options.realpath ?? realpath;
  const executable =
    options.isExecutable ??
    (async (candidate: string) => {
      try {
        await access(candidate, constants.X_OK);
        return true;
      } catch (error) {
        if (isMissingFile(error) || (error as NodeJS.ErrnoException).code === "EACCES")
          return false;
        throw error;
      }
    });
  const self = options.selfPath ?? process.argv[1];
  const selfReal = self === undefined ? undefined : await canonical(self);
  const extensions = windows
    ? ["", ...(options.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";")]
    : [""];
  for (const directory of path.split(windows ? ";" : ":")) {
    for (const extension of extensions) {
      const candidate = paths.resolve(directory.replace(/^"|"$/gu, ""), `${name}${extension}`);
      if (!(await executable(candidate))) continue;
      const resolved = await canonical(candidate);
      if (
        selfReal !== undefined &&
        (windows ? resolved.toLowerCase() === selfReal.toLowerCase() : resolved === selfReal)
      )
        continue;
      return candidate;
    }
  }
  return undefined;
}

const RC_START = "# >>> vapi code >>>";
const RC_END = "# <<< vapi code <<<";
const CONFIG_END = "# <<< vapi code config <<<\n";
const isCodeTable = ([root, name]: string[]) =>
  name === "vapi" && (root === "model_providers" || root === "profiles");

// The owned comment records only file provenance and a separator length, never credentials.
// This lets uninstall distinguish a newly created file from an existing empty one.
function cleanConfig(contents: string): { contents: string; created: boolean } {
  let created = false;
  const cleaned = contents.replace(
    /(\n?)\[model_providers\.vapi\]\n# >>> vapi code config (created|existing) (0|1) >>>\n([\s\S]*?)# <<< vapi code config <<<\n/gu,
    (_, prefix: string, kind: string, separator: string, body: string) => {
      created ||= kind === "created";
      return (
        (separator === "1" ? "" : prefix) +
        removeTomlTables(`[model_providers.vapi]\n${body}`, isCodeTable)
      );
    },
  );
  return { contents: removeTomlTables(cleaned, isCodeTable), created };
}

function configContents(existing: string | undefined, baseURL: string): string {
  const clean = cleanConfig(existing ?? "");
  const retained = clean.contents;
  const separator = retained.length > 0 && !retained.endsWith("\n") ? "\n" : "";
  return (
    `${retained}${separator}[model_providers.vapi]\n# >>> vapi code config ${existing === undefined || clean.created ? "created" : "existing"} ${separator.length} >>>\n` +
    [
      'name = "vAPI Router"',
      `base_url = "${escapeToml(baseURL)}"`,
      `env_key = "${VAPI_ROUTER_KEY_ENV}"`,
      'wire_api = "responses"',
      "",
      "[profiles.vapi]",
      `model_provider = "${VAPI_CODEX_PROVIDER}"`,
      `model = "${VAPI_CODEX_DEFAULT_MODEL}"`,
      "",
    ].join("\n") +
    CONFIG_END
  );
}

// Preserve the original final-newline convention in the block's final newline.
// An existing empty rc gets a final newline; a newly created rc does not.
function removeAliases(contents: string): string {
  return contents.replace(
    /(^|\n)# >>> vapi code >>>\r?\n[\s\S]*?^# <<< vapi code <<<(\r?\n|$)/gmu,
    (_, prefix: string, suffix: string) => (suffix === "" ? "" : prefix),
  );
}

function aliasContents(original: string | undefined, tools: string[]): string {
  const existing = original ?? "";
  const block = [RC_START, ...tools.map((tool) => `alias ${tool}="vapi ${tool}"`), RC_END].join(
    "\n",
  );
  const match = /^# >>> vapi code >>>\r?\n[\s\S]*?^# <<< vapi code <<</gmu;
  if (match.test(existing)) return existing.replace(match, block);
  const separator = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  return `${existing}${separator}${block}${original === "" || existing.endsWith("\n") ? "\n" : ""}`;
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isMissingFile(error)) return undefined;
    throw error;
  }
}

async function writeConfig(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents);
}

export async function codeCommand(
  argv: string[],
  json: boolean,
  io: CliIo,
  dependencies: CliDependencies,
): Promise<number> {
  const command = argv[0];
  if (command !== "install" && command !== "uninstall")
    throw new UsageError("Usage: vapi code <install|uninstall>.");
  const parsed = parseArguments(argv.slice(1), {
    valueOptions: new Set(command === "install" ? ["--wallet"] : []),
    booleanOptions: new Set(command === "install" ? ["--yes", "--no-alias"] : []),
    maximumPositionals: 0,
  });
  const env = getEnvironment(dependencies);
  const home = dependencies.code?.homedir ?? homedir();
  const config = codexConfigPath(env, home);
  const rcPaths = [join(home, ".zshrc"), join(home, ".bashrc")];
  if (command === "uninstall") {
    const removed: string[] = [];
    const previous = await readOptional(config);
    if (previous !== undefined) {
      const clean = cleanConfig(previous);
      if (clean.contents !== previous) {
        if (clean.contents === "" && clean.created) await unlink(config);
        else await writeFile(config, clean.contents);
        removed.push(config);
      }
    }
    for (const path of rcPaths) {
      const previous = await readOptional(path);
      if (previous === undefined) continue;
      const clean = removeAliases(previous);
      if (clean !== previous) {
        if (clean === "" && previous.startsWith(RC_START) && !previous.endsWith("\n"))
          await unlink(path);
        else await writeFile(path, clean);
        removed.push(path);
      }
    }
    io.stdout(
      json
        ? JSON.stringify({ command: "code uninstall", removed })
        : removed.length === 0
          ? "Nothing to remove."
          : `Removed vAPI code settings from: ${removed.join(", ")}`,
    );
    return 0;
  }

  const tools: string[] = [];
  const skipped: string[] = [];
  for (const name of ["claude", "codex"]) {
    const binary = await resolveBinary(name, { ...dependencies.code, env });
    if (binary === undefined)
      skipped.push(
        `Skipped ${name === "claude" ? "Claude Code" : "Codex"}: \`${name}\` is not on PATH.`,
      );
    else tools.push(name);
  }
  if (tools.length === 0) {
    const message = "Neither claude nor codex is on PATH; nothing was installed.";
    if (json) io.stdout(JSON.stringify({ installed: [], skipped, error: message }));
    else {
      skipped.forEach(io.stderr);
      io.stderr(message);
    }
    return 1;
  }

  let target = await targetWallet(parsed, dependencies);
  const credentials = dependencies.router?.routerCredentials ?? routerCredentials;
  let linked = false;
  let rotated = false;
  let result: Awaited<ReturnType<typeof routerCredentials>>;
  for (;;) {
    try {
      result = await credentials(routerDeps(target, dependencies));
      break;
    } catch (error) {
      if (error instanceof RouterClientError && error.code === "not_linked" && !linked) {
        linked = true;
        const account = parsed.one("--wallet");
        await (dependencies.code?.login ?? runLoginFlow)(
          account === undefined ? [] : ["--account", account],
          json,
          { ...io, stdout: io.stderr },
          json ? { ...dependencies, interactive: false, stdinIsTTY: false } : dependencies,
        );
        target = await targetWallet(parsed, dependencies);
      } else if (error instanceof RouterClientError && error.code === "no_router_key" && !rotated) {
        rotated = true;
        await (dependencies.router?.rotateRouterKey ?? rotateRouterKey)(
          routerDeps(target, dependencies),
        );
      } else throw error;
    }
  }
  const installed: string[] = [];
  if (tools.includes("claude")) installed.push("Claude Code: ready, launch with `vapi claude`");
  if (tools.includes("codex")) {
    await writeConfig(config, configContents(await readOptional(config), result.baseURL));
    installed.push(`Codex: installed ${config}`);
  }
  let alias = "Aliases: skipped.";
  if (!parsed.has("--no-alias")) {
    if ((dependencies.code?.platform ?? process.platform) === "win32")
      alias = "Aliases: skipped on Windows.";
    else {
      const yes =
        parsed.has("--yes") ||
        (!json &&
          dependencies.interactive === true &&
          isStdinInteractive(dependencies) &&
          /^y(?:es)?$/iu.test(
            (
              await getLinePrompt(dependencies)(
                "Make `claude` and `codex` use your vAPI Compute first from now on? [y/N] ",
              )
            ).trim(),
          ));
      if (yes) {
        const shell = basename(env.SHELL ?? "");
        const rc =
          shell === "zsh"
            ? rcPaths[0]!
            : shell === "bash"
              ? rcPaths[1]!
              : (await readOptional(rcPaths[0]!)) !== undefined
                ? rcPaths[0]!
                : rcPaths[1]!;
        await writeConfig(rc, aliasContents(await readOptional(rc), tools));
        alias = `Aliases: installed in ${rc}. Open a new terminal or run: source ${rc}`;
      }
    }
  }
  let compute: string;
  try {
    const usage = await (dependencies.router?.routerUsage ?? routerUsage)(
      routerDeps(target, dependencies),
    );
    const reset = new Date(usage.compute.resetsAt);
    if (!Number.isFinite(reset.getTime())) throw new Error("invalid reset time");
    compute = `$${usage.compute.remainingTodayUsd.toFixed(2)} left today (resets ${reset.toISOString().slice(11, 16)} UTC)`;
  } catch (error) {
    // Service error messages may contain request details; report only the safe error code.
    compute = `Compute today: unavailable (${error instanceof RouterClientError ? error.code : "request failed"})`;
  }
  const start = `Start with \`vapi ${tools.includes("claude") ? "claude" : "codex"}\``;
  if (json)
    io.stdout(
      JSON.stringify({ command: "code install", installed, skipped, alias, compute, start }),
    );
  else {
    skipped.forEach(io.stderr);
    [...installed, alias, compute, start].forEach(io.stdout);
  }
  return 0;
}
