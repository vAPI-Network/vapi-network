import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { writeDefaultConfig } from "@vapi-network/core";

import { runCli, type CliDependencies, type CliIo } from "./cli.js";
import { mcpInstallTarget } from "./mcp-install.js";

const INSTALL_HOME = "/fixture/vapi-home";
const INSTALL_REGISTRY = "https://registry.example";
const originalVapiHome = process.env.VAPI_HOME;
const originalRegistry = process.env.VAPI_REGISTRY_URL;
const temporaryDirectories: string[] = [];

afterEach(async () => {
  restoreEnvironment("VAPI_HOME", originalVapiHome);
  restoreEnvironment("VAPI_REGISTRY_URL", originalRegistry);
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("vapi mcp install", () => {
  it("writes a fresh Claude Desktop config", async () => {
    const fixture = await installationFixture("vapi-mcp-install-claude-");
    const captured = captureIo();

    expect(
      await runCli(
        ["mcp", "install", "claude", "--home", INSTALL_HOME, "--registry", INSTALL_REGISTRY],
        captured.io,
        fixture.dependencies,
      ),
    ).toBe(0);

    const path = join(
      fixture.homedir,
      "Library",
      "Application Support",
      "Claude",
      "claude_desktop_config.json",
    );
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      mcpServers: {
        vapi: {
          command: "npx",
          args: ["-y", "vapi-network", "mcp"],
          env: {
            VAPI_HOME: INSTALL_HOME,
            VAPI_REGISTRY_URL: INSTALL_REGISTRY,
          },
        },
      },
    });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(captured.stdout).toEqual([
      `Wrote ${path}.`,
      'Restart Claude Desktop, then ask it: "Search vAPI for a weather API."',
    ]);
    expect(captured.stderr).toEqual([]);
  });

  it("updates Claude Desktop without changing another server or top-level key", async () => {
    const fixture = await installationFixture("vapi-mcp-install-claude-existing-");
    const path = join(
      fixture.homedir,
      "Library",
      "Application Support",
      "Claude",
      "claude_desktop_config.json",
    );
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(
      path,
      `${JSON.stringify(
        {
          mcpServers: { other: { command: "other-command", args: ["serve"] } },
          theme: "dark",
        },
        null,
        2,
      )}\n`,
    );
    const captured = captureIo();

    expect(await runCli(["mcp", "install", "claude"], captured.io, fixture.dependencies)).toBe(0);

    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      mcpServers: {
        other: { command: "other-command", args: ["serve"] },
        vapi: {
          command: "npx",
          args: ["-y", "vapi-network", "mcp"],
          env: {
            VAPI_HOME: fixture.vapiHome,
            VAPI_REGISTRY_URL: "https://api.vapinetwork.ai",
          },
        },
      },
      theme: "dark",
    });
    expect(captured.stdout[0]).toBe(`Updated ${path}.`);
  });

  it("leaves malformed Claude Desktop JSON byte-for-byte unchanged", async () => {
    const fixture = await installationFixture("vapi-mcp-install-claude-malformed-");
    const path = join(
      fixture.homedir,
      "Library",
      "Application Support",
      "Claude",
      "claude_desktop_config.json",
    );
    const malformed = '{ "mcpServers": {\n';
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, malformed);
    await chmod(path, 0o640);
    const captured = captureIo();

    expect(await runCli(["mcp", "install", "claude"], captured.io, fixture.dependencies)).toBe(1);

    expect(captured.stderr).toEqual([
      `${path} is not valid JSON. Fix it by hand; nothing was written.`,
    ]);
    expect(await readFile(path, "utf8")).toBe(malformed);
    expect((await stat(path)).mode & 0o777).toBe(0o640);
  });

  it("writes Cursor's project config and uses the configured registry", async () => {
    const fixture = await installationFixture("vapi-mcp-install-cursor-");
    await writeDefaultConfig(join(fixture.vapiHome, "config.json"), {
      VAPI_REGISTRY_URL: "https://configured.example/root",
    });
    const captured = captureIo();

    expect(await runCli(["mcp", "install", "cursor"], captured.io, fixture.dependencies)).toBe(0);

    const path = join(fixture.cwd, ".cursor", "mcp.json");
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      mcpServers: {
        vapi: {
          command: "npx",
          args: ["-y", "vapi-network", "mcp"],
          env: {
            VAPI_HOME: fixture.vapiHome,
            VAPI_REGISTRY_URL: "https://configured.example/root",
          },
        },
      },
    });
    expect(captured.stdout).toEqual([
      `Wrote ${path}.`,
      'Reload Cursor, then ask its agent: "Search vAPI for a weather API."',
    ]);
  });

  it("writes a fresh Codex TOML config", async () => {
    const fixture = await installationFixture("vapi-mcp-install-codex-");
    const captured = captureIo();

    expect(
      await runCli(
        [
          "mcp",
          "install",
          "codex",
          "--home",
          'C:\\Users\\Agent "One"',
          "--registry",
          'https://registry.example/tenant/"one"',
        ],
        captured.io,
        fixture.dependencies,
      ),
    ).toBe(0);

    const path = join(fixture.homedir, ".codex", "config.toml");
    expect(await readFile(path, "utf8")).toBe(
      [
        "[mcp_servers.vapi]",
        'command = "npx"',
        'args = ["-y", "vapi-network", "mcp"]',
        'env = { VAPI_HOME = "C:\\\\Users\\\\Agent \\"One\\"", VAPI_REGISTRY_URL = "https://registry.example/tenant/\\"one\\"" }',
        "",
      ].join("\n"),
    );
    expect(captured.stdout).toEqual([
      `Wrote ${path}.`,
      'Start codex in a new terminal, then ask: "Search vAPI for a weather API."',
    ]);
  });

  it("replaces every Codex vapi table while preserving other table bytes", async () => {
    const fixture = await installationFixture("vapi-mcp-install-codex-existing-");
    const path = join(fixture.homedir, ".codex", "config.toml");
    const before = [
      "[first]",
      'value = "keep this"',
      "",
      "[mcp_servers.vapi]",
      'command = "old"',
      "[mcp_servers.vapi.env]",
      'OLD = "remove"',
      "[second]",
      'spacing =   "stays"',
      "",
    ].join("\n");
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, before);
    const captured = captureIo();

    expect(await runCli(["mcp", "install", "codex"], captured.io, fixture.dependencies)).toBe(0);

    const after = await readFile(path, "utf8");
    const preserved = [
      "[first]",
      'value = "keep this"',
      "",
      "[second]",
      'spacing =   "stays"',
      "",
    ].join("\n");
    expect(after.startsWith(preserved)).toBe(true);
    expect(after.match(/^\[mcp_servers\.vapi(?:\.|\])/gm)).toHaveLength(1);
    expect(after).not.toContain('command = "old"');
    expect(after).not.toContain('OLD = "remove"');
    expect(captured.stdout[0]).toBe(`Updated ${path}.`);
  });

  it("recognizes quoted and commented vapi headers and stops at indented tables", async () => {
    const fixture = await installationFixture("vapi-mcp-install-codex-valid-headers-");
    const path = join(fixture.homedir, ".codex", "config.toml");
    const before = [
      "[first]",
      'value = "keep this"',
      "",
      '[mcp_servers."vapi"] # installed earlier',
      'command = "old"',
      '["mcp_servers".vapi.env] # old environment',
      'OLD = "remove"',
      "  [second] # valid indented header",
      'spacing =   "stays"',
      "",
    ].join("\n");
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, before);
    const captured = captureIo();

    expect(await runCli(["mcp", "install", "codex"], captured.io, fixture.dependencies)).toBe(0);

    const after = await readFile(path, "utf8");
    expect(after).toContain('value = "keep this"');
    expect(after).toContain("  [second] # valid indented header\n");
    expect(after).toContain('spacing =   "stays"');
    expect(after).not.toContain('command = "old"');
    expect(after).not.toContain('OLD = "remove"');
    expect(after.match(/^\[mcp_servers\.vapi\]$/gm)).toHaveLength(1);
  });

  it("reports the installed path and overrides as JSON", async () => {
    const fixture = await installationFixture("vapi-mcp-install-json-");
    const captured = captureIo();

    expect(
      await runCli(
        [
          "mcp",
          "install",
          "cursor",
          "--home",
          INSTALL_HOME,
          "--registry",
          INSTALL_REGISTRY,
          "--json",
        ],
        captured.io,
        fixture.dependencies,
      ),
    ).toBe(0);

    const path = join(fixture.cwd, ".cursor", "mcp.json");
    expect(captured.stdout).toEqual([
      JSON.stringify({
        command: "mcp install",
        app: "cursor",
        path,
        created: true,
        home: INSTALL_HOME,
        registry: INSTALL_REGISTRY,
      }),
    ]);
    expect(captured.stderr).toEqual([]);
  });

  it("reports exact usage errors for a missing or unknown app", async () => {
    const fixture = await installationFixture("vapi-mcp-install-usage-");
    const missing = captureIo();
    const unknown = captureIo();
    const usage =
      "Usage: vapi mcp install <claude|cursor|codex> [--home <dir>] [--registry <url>] [--json]";

    expect(await runCli(["mcp", "install"], missing.io, fixture.dependencies)).toBe(2);
    expect(missing.stderr).toEqual([usage]);
    expect(await runCli(["mcp", "install", "windsurf"], unknown.io, fixture.dependencies)).toBe(2);
    expect(unknown.stderr).toEqual([
      `Unknown app "windsurf". Choose claude, cursor or codex.\n${usage}`,
    ]);
  });

  it("starts a docs-only stdio server before init", async () => {
    const fixture = await installationFixture("vapi-mcp-server-regression-");
    const captured = captureIo();

    expect(await runCli(["mcp"], captured.io, fixture.dependencies)).toBe(0);
    expect(captured.stdout).toEqual([]);
    expect(captured.stderr).toEqual([]);
  });
});

describe("mcpInstallTarget", () => {
  it("finds every macOS target", () => {
    const context = {
      platform: "darwin" as const,
      homedir: "/Users/agent",
      cwd: "/work/project",
    };
    expect(mcpInstallTarget("claude", context)).toEqual({
      path: "/Users/agent/Library/Application Support/Claude/claude_desktop_config.json",
      format: "json",
    });
    expect(mcpInstallTarget("cursor", context)).toEqual({
      path: "/work/project/.cursor/mcp.json",
      format: "json",
    });
    expect(mcpInstallTarget("codex", context)).toEqual({
      path: "/Users/agent/.codex/config.toml",
      format: "toml",
    });
  });

  it("finds every Windows target", () => {
    const context = {
      platform: "win32" as const,
      homedir: "C:\\Users\\agent",
      cwd: "C:\\work\\project",
      appData: "C:\\Users\\agent\\AppData\\Roaming",
    };
    expect(mcpInstallTarget("claude", context)).toEqual({
      path: "C:\\Users\\agent\\AppData\\Roaming\\Claude\\claude_desktop_config.json",
      format: "json",
    });
    expect(mcpInstallTarget("cursor", context)).toEqual({
      path: "C:\\work\\project\\.cursor\\mcp.json",
      format: "json",
    });
    expect(mcpInstallTarget("codex", context)).toEqual({
      path: "C:\\Users\\agent\\.codex\\config.toml",
      format: "toml",
    });
    expect(() =>
      mcpInstallTarget("claude", {
        platform: "win32",
        homedir: "C:\\Users\\agent",
        cwd: "C:\\work\\project",
      }),
    ).toThrow("APPDATA is not set.");
  });

  it("finds every Linux target", () => {
    const context = {
      platform: "linux" as const,
      homedir: "/home/agent",
      cwd: "/work/project",
    };
    expect(mcpInstallTarget("claude", context)).toEqual({
      path: "/home/agent/.config/Claude/claude_desktop_config.json",
      format: "json",
    });
    expect(mcpInstallTarget("cursor", context)).toEqual({
      path: "/work/project/.cursor/mcp.json",
      format: "json",
    });
    expect(mcpInstallTarget("codex", context)).toEqual({
      path: "/home/agent/.codex/config.toml",
      format: "toml",
    });
  });
});

async function installationFixture(prefix: string): Promise<{
  homedir: string;
  cwd: string;
  vapiHome: string;
  dependencies: CliDependencies;
}> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(root);
  const homedir = join(root, "user");
  const cwd = join(root, "project");
  const vapiHome = join(root, "vapi-home");
  await mkdir(cwd, { recursive: true });
  process.env.VAPI_HOME = vapiHome;
  delete process.env.VAPI_REGISTRY_URL;
  return {
    homedir,
    cwd,
    vapiHome,
    dependencies: {
      interactive: false,
      env: {},
      mcpInstall: { platform: "darwin", homedir, cwd },
    },
  };
}

function captureIo(): { io: CliIo; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      stdout: (message) => stdout.push(message),
      stderr: (message) => stderr.push(message),
    },
  };
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
