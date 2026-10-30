import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CONNECTABLE_APP_IDS, type ConnectableAppId } from "../../shared/apps.js";
import { appPaths, CLAUDE_EXTENSION_ID, detectApps, type AppPaths } from "./detect.js";
import { tomlBlock } from "./install.js";

describe("app detection from installed configs", () => {
  let root: string;
  let paths: AppPaths;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "apps-detect-"));
    paths = appPaths(join(root, "appData"), join(root, "home"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function put(path: string, text: string) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text);
  }

  async function status(id: ConnectableAppId) {
    return (await detectApps(paths)).find((entry) => entry.id === id);
  }

  it("uses the verified per-app paths under the supplied roots", () => {
    expect(paths).toEqual({
      claudeInstallations: join(root, "appData/Claude/extensions-installations.json"),
      claudeExtensionsDir: join(root, "appData/Claude/Claude Extensions"),
      cursor: join(root, "home/.cursor/mcp.json"),
      vscode: join(root, "appData/Code/User/mcp.json"),
      codex: join(root, "home/.codex/config.toml"),
      grokCli: join(root, "home/.grok/config.toml"),
    });
  });

  it("returns every absent app in CONNECTABLE_APP_IDS order", async () => {
    expect(await detectApps(paths)).toEqual(
      CONNECTABLE_APP_IDS.map((id) => ({ id, state: "not_connected" })),
    );
  });

  it("reads Cursor's installed wallet", async () => {
    await put(
      paths.cursor,
      JSON.stringify({
        mcpServers: { vapi: { command: "shim", env: { VAPI_DESKTOP_WALLET: "claude" } } },
      }),
    );
    expect(await status("cursor")).toEqual({ id: "cursor", state: "connected", wallet: "claude" });
  });

  it("recognizes Cursor without env as a legacy connection", async () => {
    await put(paths.cursor, JSON.stringify({ mcpServers: { vapi: { command: "shim" } } }));
    expect(await status("cursor")).toEqual({ id: "cursor", state: "connected", wallet: null });
  });

  it.each(["{bad JSON", "null", "[]", '{"mcpServers":null}'])(
    "handles malformed or unexpected Cursor JSON: %s",
    async (text) => {
      await put(paths.cursor, text);
      expect(await status("cursor")).toEqual({ id: "cursor", state: "not_connected" });
    },
  );

  it("reads VS Code comments and trailing commas without stripping // inside strings", async () => {
    await put(
      paths.vscode,
      `{
      // global servers
      "servers": {
        /* local stdio server */
        "vapi": { "command": "https://x", "env": { "VAPI_DESKTOP_WALLET": "research//x", }, },
      },
    }`,
    );
    expect(await status("vscode")).toEqual({
      id: "vscode",
      state: "connected",
      wallet: "research//x",
    });
  });

  it("handles malformed VS Code JSON", async () => {
    await put(paths.vscode, '{"servers":');
    expect(await status("vscode")).toEqual({ id: "vscode", state: "not_connected" });
  });

  async function installClaude(wallet?: string) {
    await put(
      paths.claudeInstallations,
      JSON.stringify({
        extensions: { [CLAUDE_EXTENSION_ID]: { version: wallet ? "0.2.0" : "0.1.1" } },
      }),
    );
    await put(
      join(paths.claudeExtensionsDir, CLAUDE_EXTENSION_ID, "manifest.json"),
      JSON.stringify({
        manifest_version: "0.3",
        name: "vapi-desktop",
        version: wallet ? "0.2.0" : "0.1.1",
        server: {
          type: "node",
          entry_point: "dist/shim.js",
          mcp_config: {
            command: "node",
            args: ["${__dirname}/dist/shim.js"],
            env: {
              VAPI_DESKTOP_SOCKET: "/tmp/mcp.sock",
              ...(wallet ? { VAPI_DESKTOP_WALLET: wallet } : {}),
            },
          },
        },
      }),
    );
  }

  it("recognizes the Claude Desktop 0.1.1 manifest without a wallet", async () => {
    await installClaude();
    expect(await status("claude-desktop")).toEqual({
      id: "claude-desktop",
      state: "connected",
      wallet: null,
    });
  });

  it("reads Claude Desktop's wallet from the installed manifest", async () => {
    await installClaude("research");
    expect(await status("claude-desktop")).toEqual({
      id: "claude-desktop",
      state: "connected",
      wallet: "research",
    });
  });

  it("requires the Claude registry even when a manifest exists", async () => {
    await installClaude("research");
    await rm(paths.claudeInstallations);
    expect(await status("claude-desktop")).toEqual({
      id: "claude-desktop",
      state: "not_connected",
    });
  });

  it("keeps a registered Claude connection when its manifest cannot be read", async () => {
    await installClaude();
    await rm(join(paths.claudeExtensionsDir, CLAUDE_EXTENSION_ID, "manifest.json"));
    expect(await status("claude-desktop")).toEqual({
      id: "claude-desktop",
      state: "connected",
      wallet: null,
    });
  });

  it("reads Codex's managed wallet", async () => {
    await put(
      paths.codex,
      tomlBlock({ shimPath: "/tmp/shim", socketPath: "/tmp/socket", wallet: "research" }),
    );
    expect(await status("codex")).toEqual({ id: "codex", state: "connected", wallet: "research" });
  });

  it("reports an unmanaged Codex entry as a conflict with its path", async () => {
    await put(paths.codex, '[mcp_servers.vapi]\ncommand = "x"\n');
    expect(await status("codex")).toEqual({ id: "codex", state: "conflict", path: paths.codex });
  });

  it("reads Grok CLI's managed wallet using the same TOML format", async () => {
    await put(
      paths.grokCli,
      tomlBlock({ shimPath: "/tmp/shim", socketPath: "/tmp/socket", wallet: "claude" }),
    );
    expect(await status("grok-cli")).toEqual({
      id: "grok-cli",
      state: "connected",
      wallet: "claude",
    });
  });

  it("treats unreadable config paths as not connected without rejecting detection", async () => {
    await mkdir(paths.cursor, { recursive: true });
    await mkdir(paths.codex, { recursive: true });
    expect(await detectApps(paths)).toEqual(
      CONNECTABLE_APP_IDS.map((id) => ({ id, state: "not_connected" })),
    );
  });
});
