import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { CONNECTABLE_APP_IDS, type AppStatus, type ConnectableAppId } from "../../shared/apps.js";
import { SERVER_NAME } from "./install.js";
import { readTomlEntry } from "./toml-block.js";

/** Claude Desktop's id for the bundled `.mcpb` (`local.mcpb.<author>.<name>`). */
export const CLAUDE_EXTENSION_ID = "local.mcpb.vertical-labs.vapi-desktop";

export type AppPaths = {
  claudeInstallations: string;
  claudeExtensionsDir: string;
  cursor: string;
  vscode: string;
  codex: string;
  grokCli: string;
};

export function appPaths(appData: string, homeDir: string): AppPaths {
  return {
    claudeInstallations: join(appData, "Claude", "extensions-installations.json"),
    claudeExtensionsDir: join(appData, "Claude", "Claude Extensions"),
    cursor: join(homeDir, ".cursor", "mcp.json"),
    vscode: join(appData, "Code", "User", "mcp.json"),
    codex: join(homeDir, ".codex", "config.toml"),
    grokCli: join(homeDir, ".grok", "config.toml"),
  };
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Match strings first so comment markers and commas inside them stay untouched. */
function stripJsonComments(text: string): string {
  const withoutComments = text.replace(
    /"(?:\\.|[^"\\])*"|\/\/[^\r\n]*|\/\*[\s\S]*?\*\//g,
    (token) => (token.startsWith('"') ? token : token.replace(/[^\r\n]/g, " ")),
  );
  return withoutComments.replace(/"(?:\\.|[^"\\])*"|,\s*(?=[}\]])/g, (token) =>
    token.startsWith('"') ? token : "",
  );
}

async function readJson(
  path: string,
  comments = false,
): Promise<Record<string, unknown> | undefined> {
  try {
    const text = await readFile(path, "utf8");
    return object(JSON.parse(comments ? stripJsonComments(text) : text));
  } catch {
    return undefined;
  }
}

function walletOf(server: Record<string, unknown> | undefined): string | null {
  const wallet = object(server?.env)?.VAPI_DESKTOP_WALLET;
  return typeof wallet === "string" ? wallet : null;
}

async function detectApp(id: ConnectableAppId, paths: AppPaths): Promise<AppStatus> {
  switch (id) {
    case "claude-desktop": {
      const registry = await readJson(paths.claudeInstallations);
      const extensions = object(registry?.extensions);
      if (!extensions || !Object.hasOwn(extensions, CLAUDE_EXTENSION_ID))
        return { id, state: "not_connected" };
      const manifest = await readJson(
        join(paths.claudeExtensionsDir, CLAUDE_EXTENSION_ID, "manifest.json"),
      );
      return {
        id,
        state: "connected",
        wallet: walletOf(object(object(manifest?.server)?.mcp_config)),
      };
    }
    case "cursor":
    case "vscode": {
      const config = await readJson(paths[id], id === "vscode");
      const server = object(
        object(config?.[id === "cursor" ? "mcpServers" : "servers"])?.[SERVER_NAME],
      );
      return server
        ? { id, state: "connected", wallet: walletOf(server) }
        : { id, state: "not_connected" };
    }
    case "codex":
    case "grok-cli": {
      const path = id === "codex" ? paths.codex : paths.grokCli;
      const entry = readTomlEntry(await readFile(path, "utf8"));
      switch (entry.state) {
        case "ours":
          return { id, state: "connected", wallet: entry.wallet };
        case "conflict":
          return { id, state: "conflict", path };
        case "absent":
          return { id, state: "not_connected" };
      }
    }
  }
}

/** Read only the apps' own configs; one failure never prevents detecting the others. */
export async function detectApps(paths: AppPaths): Promise<AppStatus[]> {
  return Promise.all(
    CONNECTABLE_APP_IDS.map(async (id): Promise<AppStatus> => {
      try {
        return await detectApp(id, paths);
      } catch {
        return { id, state: "not_connected" };
      }
    }),
  );
}
