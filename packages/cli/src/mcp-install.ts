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

type McpInstallApp = "claude" | "cursor" | "codex";

type McpServerEntry = {
  command: "npx";
  args: ["-y", "vapi-network", "mcp"];
  env: {
    VAPI_HOME: string;
    VAPI_REGISTRY_URL: string;
  };
};

const MCP_INSTALL_USAGE =
  "Usage: vapi mcp install <claude|cursor|codex> [--home <dir>] [--registry <url>] [--json]";
const APPS = new Set<McpInstallApp>(["claude", "cursor", "codex"]);
const NEXT_STEP: Record<McpInstallApp, string> = {
  claude: 'Restart Claude Desktop, then ask it: "Search vAPI for a weather API."',
  cursor: 'Reload Cursor, then ask its agent: "Search vAPI for a weather API."',
  codex: 'Start codex in a new terminal, then ask: "Search vAPI for a weather API."',
};

export function mcpInstallTarget(
  app: McpInstallApp,
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
): Promise<void> {
  const parsed = parseArguments(argv, {
    valueOptions: new Set(["--home", "--registry"]),
    maximumPositionals: 1,
  });
  const appValue = parsed.positionals[0];
  if (appValue === undefined) throw new UsageError(MCP_INSTALL_USAGE);
  if (!isMcpInstallApp(appValue)) {
    throw new UsageError(
      `Unknown app ${JSON.stringify(appValue)}. Choose claude, cursor or codex.\n${MCP_INSTALL_USAGE}`,
    );
  }

  const home = parsed.one("--home") ?? getVapiPaths().directory;
  const paths = getVapiPaths(home);
  const registry =
    parsed.one("--registry") ??
    ((await pathExists(paths.config))
      ? registryBaseUrl(await readConfig(paths.config, io))
      : resolveRegistryUrl());
  const target = mcpInstallTarget(appValue, {
    platform: dependencies.mcpInstall?.platform ?? process.platform,
    homedir: dependencies.mcpInstall?.homedir ?? systemHomedir(),
    cwd: dependencies.mcpInstall?.cwd ?? process.cwd(),
    appData: dependencies.mcpInstall?.appData ?? process.env.APPDATA,
  });
  const entry = serverEntry(home, registry);
  const created = await writeMcpConfig(target, entry);

  output(
    io,
    json,
    { command: "mcp install", app: appValue, path: target.path, created, home, registry },
    `${created ? "Wrote" : "Updated"} ${target.path}.`,
  );
  if (!json) io.stdout(NEXT_STEP[appValue]);
}

function isMcpInstallApp(value: string): value is McpInstallApp {
  return APPS.has(value as McpInstallApp);
}

function serverEntry(home: string, registry: string): McpServerEntry {
  return {
    command: "npx",
    args: ["-y", "vapi-network", "mcp"],
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
    'args = ["-y", "vapi-network", "mcp"]',
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
