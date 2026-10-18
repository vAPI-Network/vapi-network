import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir as systemHomedir } from "node:os";
import { dirname, posix, win32 } from "node:path";

import { getVapiPaths, isMissingFile, resolveRegistryUrl } from "@vapi-network/core";

import {
  UsageError,
  output,
  parseArguments,
  readConfig,
  registryBaseUrl,
  type CliDependencies,
  type CliIo,
} from "./cli.js";

type McpInstallApp = "claude-code" | "claude-desktop" | "cursor" | "codex";
type McpFileInstallApp = Exclude<McpInstallApp, "claude-code">;

export type McpInstallProcessResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
};

export type McpInstallProcessRunner = (
  command: string,
  args: readonly string[],
) => Promise<McpInstallProcessResult>;

type McpServerEntry = {
  command: "npx";
  args: ["-y", "vapi-network@latest", "mcp"];
  env: {
    VAPI_HOME: string;
    VAPI_REGISTRY_URL: string;
  };
};

const MCP_INSTALL_USAGE =
  "Usage: vapi mcp install <claude-code|claude-desktop|cursor|codex> [--home <dir>] [--registry <url>] [--json]";
const APPS = new Set<McpInstallApp>(["claude-code", "claude-desktop", "cursor", "codex"]);
const CLAUDE_ALIAS_NOTICE =
  "vapi mcp install claude installs into Claude Desktop; for the Claude Code CLI use: vapi mcp install claude-code";
const CLAUDE_NOT_FOUND =
  "Claude Code's claude command was not found on PATH. Install Claude Code, or run this yourself:";
const NEXT_STEP: Record<McpInstallApp, string> = {
  "claude-code": 'Start a new Claude Code session, then ask: "Search vAPI for a weather API."',
  "claude-desktop": 'Restart Claude Desktop, then ask it: "Search vAPI for a weather API."',
  cursor: 'Reload Cursor, then ask its agent: "Search vAPI for a weather API."',
  codex: 'Start codex in a new terminal, then ask: "Search vAPI for a weather API."',
};

export function mcpInstallTarget(
  app: McpFileInstallApp,
  context: {
    platform: NodeJS.Platform;
    homedir: string;
    cwd: string;
    appData?: string;
  },
): { path: string; format: "json" | "toml" } {
  const paths = context.platform === "win32" ? win32 : posix;
  if (app === "cursor") {
    return { path: paths.join(context.cwd, ".cursor", "mcp.json"), format: "json" };
  }
  if (app === "codex")
    return { path: paths.join(context.homedir, ".codex", "config.toml"), format: "toml" };
  if (context.platform === "darwin") {
    return {
      path: paths.join(
        context.homedir,
        "Library",
        "Application Support",
        "Claude",
        "claude_desktop_config.json",
      ),
      format: "json",
    };
  }
  if (context.platform === "win32") {
    if (!context.appData) throw new Error("APPDATA is not set.");
    return {
      path: win32.join(context.appData, "Claude", "claude_desktop_config.json"),
      format: "json",
    };
  }
  return {
    path: paths.join(context.homedir, ".config", "Claude", "claude_desktop_config.json"),
    format: "json",
  };
}

export async function mcpInstallCommand(
  argv: string[],
  json: boolean,
  io: CliIo,
  dependencies: CliDependencies,
): Promise<number> {
  const parsed = parseArguments(argv, {
    valueOptions: new Set(["--home", "--registry"]),
    maximumPositionals: 1,
  });
  const requestedApp = parsed.positionals[0];
  if (requestedApp === undefined) throw new UsageError(MCP_INSTALL_USAGE);
  const appValue = requestedApp === "claude" ? "claude-desktop" : requestedApp;
  if (!isMcpInstallApp(appValue)) {
    throw new UsageError(
      `Unknown app ${JSON.stringify(requestedApp)}. Choose claude-code, claude-desktop, cursor or codex.\n${MCP_INSTALL_USAGE}`,
    );
  }
  if (requestedApp === "claude") io.stderr(CLAUDE_ALIAS_NOTICE);

  const home = parsed.one("--home") ?? getVapiPaths().directory;
  const paths = getVapiPaths(home);
  const registry =
    parsed.one("--registry") ??
    ((await pathExists(paths.config))
      ? registryBaseUrl(await readConfig(paths.config, io))
      : resolveRegistryUrl());
  const platform = dependencies.mcpInstall?.platform ?? process.platform;
  const entry = serverEntry(home, registry);
  if (appValue === "claude-code") {
    return await installClaudeCode(entry, platform, json, io, dependencies);
  }

  const target = mcpInstallTarget(appValue, {
    platform,
    homedir: dependencies.mcpInstall?.homedir ?? systemHomedir(),
    cwd: dependencies.mcpInstall?.cwd ?? process.cwd(),
    appData: dependencies.mcpInstall?.appData ?? process.env.APPDATA,
  });
  const created = await writeMcpConfig(target, entry);

  output(
    io,
    json,
    { command: "mcp install", app: appValue, path: target.path, created, home, registry },
    `${created ? "Wrote" : "Updated"} ${target.path}.`,
  );
  if (!json) io.stdout(NEXT_STEP[appValue]);
  return 0;
}

async function installClaudeCode(
  entry: McpServerEntry,
  platform: NodeJS.Platform,
  json: boolean,
  io: CliIo,
  dependencies: CliDependencies,
): Promise<number> {
  const processCommand = platform === "win32" ? "claude.cmd" : "claude";
  const processArgs = claudeCodeArgs(entry);
  const command =
    platform === "win32"
      ? [escapeCmd(processCommand), ...processArgs.map(escapeCmdArgument)].join(" ")
      : displayCommand(processCommand, processArgs);
  let result: McpInstallProcessResult;
  try {
    result = await (dependencies.mcpInstall?.runProcess ?? defaultMcpInstallProcess)(
      processCommand,
      processArgs,
    );
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) {
      return claudeCodeFailure(json, io, command, "claude_not_found", CLAUDE_NOT_FOUND);
    }
    const message = `Claude Code MCP installation failed: ${errorMessage(error)}`;
    return claudeCodeFailure(json, io, command, "claude_mcp_add_failed", message);
  }

  if (result.exitCode !== 0) {
    const status =
      result.exitCode === null
        ? "Claude Code's claude command ended without an exit code."
        : `Claude Code's claude command exited with code ${result.exitCode}.`;
    const stderr = result.stderr.trim();
    const message = stderr.length === 0 ? status : `${status} ${stderr}`;
    return claudeCodeFailure(json, io, command, "claude_mcp_add_failed", message, result.exitCode);
  }

  const nextStep = NEXT_STEP["claude-code"];
  if (json) io.stdout(JSON.stringify({ app: "claude-code", installed: true, command, nextStep }));
  else {
    io.stdout(command);
    io.stdout(nextStep);
  }
  return 0;
}

function claudeCodeArgs(entry: McpServerEntry): string[] {
  return [
    "mcp",
    "add",
    "--scope",
    "user",
    "vapi",
    "-e",
    `VAPI_HOME=${entry.env.VAPI_HOME}`,
    "-e",
    `VAPI_REGISTRY_URL=${entry.env.VAPI_REGISTRY_URL}`,
    "--",
    entry.command,
    ...entry.args,
  ];
}

function claudeCodeFailure(
  json: boolean,
  io: CliIo,
  command: string,
  code: "claude_not_found" | "claude_mcp_add_failed",
  message: string,
  exitCode?: number | null,
): 1 {
  if (json) {
    io.stdout(
      JSON.stringify({
        app: "claude-code",
        installed: false,
        command,
        error: { code, message, ...(exitCode === undefined ? {} : { exitCode }) },
      }),
    );
  } else if (code === "claude_not_found") {
    io.stderr(`${message}\n${command}`);
  } else {
    io.stderr(`${command}\n${message}`);
  }
  return 1;
}

function displayCommand(command: string, args: readonly string[]): string {
  return [command, ...args].map(shellQuote).join(" ");
}

function shellQuote(value: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/u.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}

function isErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const defaultMcpInstallProcess: McpInstallProcessRunner = async (command, args) => {
  const batch = /\.(?:cmd|bat)$/iu.test(command);
  const executable = batch ? await windowsBatchPath(command) : command;
  // A batch shim goes through cmd.exe twice: once here and once in the shim.
  const commandLine = batch
    ? [escapeCmd(executable), ...args.map((arg) => escapeCmdArgument(arg))].join(" ")
    : undefined;
  return await new Promise((resolve, reject) => {
    const child = spawn(
      batch ? "cmd.exe" : command,
      batch ? ["/d", "/v:off", "/s", "/c", `"${commandLine}"`] : [...args],
      {
        shell: false,
        ...(batch ? { windowsVerbatimArguments: true } : {}),
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 60_000,
        killSignal: "SIGKILL",
        windowsHide: true,
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (exitCode) => resolve({ exitCode, stdout, stderr }));
  });
};

async function windowsBatchPath(command: string): Promise<string> {
  const path = Object.entries(process.env).find(([key]) => key.toLowerCase() === "path")?.[1];
  for (const directory of ["", ...(path ?? "").split(";")]) {
    const candidate = win32.join(directory.replace(/^"|"$/gu, ""), command);
    if (await pathExists(candidate)) return candidate;
  }
  throw Object.assign(new Error(`${command} was not found on PATH.`), { code: "ENOENT" });
}

function escapeCmd(value: string): string {
  return value.replace(/[()[\]%!^"`<>&|;, *?]/gu, "^$&");
}

function escapeCmdArgument(value: string): string {
  // Preserve literal quotes and trailing slashes for the program's argv parser,
  // then protect metacharacters through both command-interpreter passes.
  const quoted = `"${value.replace(/(\\*)"/gu, '$1$1\\"').replace(/(\\*)$/u, "$1$1")}"`;
  return escapeCmd(escapeCmd(quoted));
}

function isMcpInstallApp(value: string): value is McpInstallApp {
  return APPS.has(value as McpInstallApp);
}

function serverEntry(home: string, registry: string): McpServerEntry {
  return {
    command: "npx",
    args: ["-y", "vapi-network@latest", "mcp"],
    env: { VAPI_HOME: home, VAPI_REGISTRY_URL: registry },
  };
}

async function writeMcpConfig(
  target: { path: string; format: "json" | "toml" },
  entry: McpServerEntry,
): Promise<boolean> {
  const existing = await readExistingFile(target.path);
  const created = existing === undefined;
  const contents =
    target.format === "json"
      ? jsonConfig(target.path, existing, entry)
      : tomlConfig(existing ?? "", entry);
  await mkdir(dirname(target.path), { recursive: true });
  await writeFile(
    target.path,
    contents,
    created && target.format === "json" ? { mode: 0o600 } : {},
  );
  return created;
}

function jsonConfig(path: string, existing: string | undefined, entry: McpServerEntry): string {
  let config: Record<string, unknown>;
  if (existing === undefined) {
    config = {};
  } else {
    let parsed: unknown;
    try {
      parsed = JSON.parse(existing);
    } catch {
      throw new Error(`${path} is not valid JSON. Fix it by hand; nothing was written.`);
    }
    if (!isRecord(parsed)) {
      throw new Error(`${path} must contain a JSON object. Fix it by hand; nothing was written.`);
    }
    config = parsed;
  }

  const existingServers = config.mcpServers;
  if (existingServers !== undefined && !isRecord(existingServers)) {
    throw new Error(
      `${path} has an invalid mcpServers value. Fix it by hand; nothing was written.`,
    );
  }
  const mcpServers = existingServers ?? {};
  mcpServers.vapi = entry;
  config.mcpServers = mcpServers;
  return `${JSON.stringify(config, null, 2)}\n`;
}

function tomlConfig(existing: string, entry: McpServerEntry): string {
  const retained = removeVapiTomlTables(existing);
  const block = [
    "[mcp_servers.vapi]",
    'command = "npx"',
    'args = ["-y", "vapi-network@latest", "mcp"]',
    `env = { VAPI_HOME = "${escapeToml(entry.env.VAPI_HOME)}", VAPI_REGISTRY_URL = "${escapeToml(entry.env.VAPI_REGISTRY_URL)}" }`,
    "",
  ].join("\n");
  return `${retained}${tomlSeparator(retained)}${block}`;
}

function removeVapiTomlTables(contents: string): string {
  const lines = contents.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  let removing = false;
  let retained = "";
  for (const line of lines) {
    const table = tomlTableName(line);
    if (table !== undefined) removing = isVapiTomlTable(table);
    if (!removing) retained += line;
  }
  return retained;
}

function tomlTableName(line: string): string | undefined {
  const header = line.replace(/\r?\n$/, "");
  const match = /^\s*(?:\[\[\s*(.*?)\s*\]\]|\[\s*(.*?)\s*\])\s*(?:#.*)?$/.exec(header);
  return match?.[1] ?? match?.[2];
}

function isVapiTomlTable(table: string): boolean {
  const key = String.raw`(?:[A-Za-z0-9_-]+|"(?:[^"\\]|\\.)*"|'[^']*')`;
  const match = new RegExp(`^\\s*(${key})\\s*\\.\\s*(${key})(?:\\s*\\.|\\s*$)`).exec(table);
  if (match === null) return false;
  return unquoteTomlKey(match[1]!) === "mcp_servers" && unquoteTomlKey(match[2]!) === "vapi";
}

function unquoteTomlKey(key: string): string {
  if (key.startsWith("'") && key.endsWith("'")) return key.slice(1, -1);
  if (key.startsWith('"') && key.endsWith('"')) {
    try {
      return JSON.parse(key) as string;
    } catch {
      return key;
    }
  }
  return key;
}

function tomlSeparator(contents: string): string {
  if (contents.length === 0 || /(?:\r?\n)[ \t]*(?:\r?\n)$/.test(contents)) return "";
  return /\r?\n$/.test(contents) ? "\n" : "\n\n";
}

function escapeToml(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readExistingFile(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isMissingFile(error)) return undefined;
    throw error;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch (error) {
    if (isMissingFile(error)) return false;
    throw error;
  }
}
