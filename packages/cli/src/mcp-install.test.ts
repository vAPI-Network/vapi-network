import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import { writeDefaultConfig } from "@vapi-network/core";

import { runCli, type CliDependencies, type CliIo } from "./cli.js";
import { defaultMcpInstallProcess, mcpInstallTarget } from "./mcp-install.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return { ...original, readFile: vi.fn(original.readFile) };
});

vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return {
    ...original,
    spawn: vi.fn(() => {
      throw new Error("Unexpected process launch in installer test");
    }),
  };
});

const INSTALL_HOME = "/fixture/vapi-home";
const INSTALL_REGISTRY = "https://registry.example";
const originalVapiHome = process.env.VAPI_HOME;
const originalRegistry = process.env.VAPI_REGISTRY_URL;
const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.mocked(readFile).mockReset();
  restoreEnvironment("VAPI_HOME", originalVapiHome);
  restoreEnvironment("VAPI_REGISTRY_URL", originalRegistry);
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("vapi mcp install", () => {
  it("launches a Windows batch shim through cmd and protects argument metacharacters", async () => {
    vi.mocked(readFile).mockResolvedValueOnce(Buffer.from("@echo off"));
    const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    vi.mocked(spawn).mockImplementationOnce(() => child as never);
    const args = [
      "mcp",
      "add",
      "-e",
      "VAPI_HOME=C:\\Users\\Test User\\",
      "-e",
      'VAPI_REGISTRY_URL=https://registry.example/?a=1&b=%PATH%!"quoted"',
    ];
    const result = defaultMcpInstallProcess("claude.cmd", args);
    await vi.waitFor(() =>
      expect(spawn).toHaveBeenLastCalledWith(
        "cmd.exe",
        expect.any(Array),
        expect.objectContaining({
          shell: false,
          windowsVerbatimArguments: true,
          timeout: 60_000,
          stdio: ["ignore", "pipe", "pipe"],
        }),
      ),
    );
    const launchedArgs = vi.mocked(spawn).mock.calls.at(-1)![1] as string[];
    expect(launchedArgs.slice(0, 4)).toEqual(["/d", "/v:off", "/s", "/c"]);
    const command = launchedArgs[4]!;
    expect(command).toContain("claude.cmd");
    expect(command).toContain("Test^^^ User");
    expect(command).toContain("^^^&b=^^^%PATH^^^%^^^!");
    expect(command).not.toContain(args[5]);
    child.emit("close", 0);
    await expect(result).resolves.toEqual({ exitCode: 0, stdout: "", stderr: "" });
  });

  it("reports a missing Windows batch shim before starting a command interpreter", async () => {
    vi.mocked(readFile).mockRejectedValue(Object.assign(new Error("missing"), { code: "ENOENT" }));
    const launches = vi.mocked(spawn).mock.calls.length;
    await expect(defaultMcpInstallProcess("claude.cmd", ["mcp", "add"])).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(spawn).toHaveBeenCalledTimes(launches);
  });
  it("runs the default process with no stdin and a bounded hard timeout", async () => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    vi.mocked(spawn).mockImplementationOnce(() => child as never);

    const resultPromise = defaultMcpInstallProcess("claude", ["mcp", "list"]);
    child.stdout.end("output");
    child.stderr.end("warning");
    child.emit("close", 0);

    await expect(resultPromise).resolves.toEqual({
      exitCode: 0,
      stdout: "output",
      stderr: "warning",
    });
    expect(spawn).toHaveBeenLastCalledWith("claude", ["mcp", "list"], {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 60_000,
      killSignal: "SIGKILL",
      windowsHide: true,
    });
  });

  it("runs the exact Claude Code command with quoted overrides", async () => {
    const fixture = await installationFixture("vapi-mcp-install-claude-code-");
    const captured = captureIo();
    const calls: Array<{ command: string; args: readonly string[] }> = [];
    fixture.dependencies.mcpInstall!.runProcess = async (command, args) => {
      calls.push({ command, args });
      return { exitCode: 0, stdout: "registered\n", stderr: "" };
    };
    const home = "/tmp/VAPI home/it's $(local)";
    const registry = "https://registry.example/root?x=1&y='two'";

    expect(
      await runCli(
        ["mcp", "install", "claude-code", "--home", home, "--registry", registry],
        captured.io,
        fixture.dependencies,
      ),
    ).toBe(0);

    expect(calls).toEqual([
      {
        command: "claude",
        args: [
          "mcp",
          "add",
          "--scope",
          "user",
          "vapi",
          "-e",
          `VAPI_HOME=${home}`,
          "-e",
          `VAPI_REGISTRY_URL=${registry}`,
          "--",
          "npx",
          "-y",
          "vapi-network@latest",
          "mcp",
        ],
      },
    ]);
    expect(captured.stdout).toEqual([
      "claude mcp add --scope user vapi -e 'VAPI_HOME=/tmp/VAPI home/it'\\''s $(local)' -e 'VAPI_REGISTRY_URL=https://registry.example/root?x=1&y='\\''two'\\''' -- npx -y vapi-network@latest mcp",
      'Start a new Claude Code session, then ask: "Search vAPI for a weather API."',
    ]);
    expect(captured.stderr).toEqual([]);
    await expect(stat(fixture.homedir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("uses config defaults for the same entry in Claude Code and file targets", async () => {
    const fixture = await installationFixture("vapi-mcp-install-entry-parity-");
    await writeDefaultConfig(join(fixture.vapiHome, "config.json"), {
      VAPI_REGISTRY_URL: "https://configured.example/parity",
    });
    let claudeArgs: readonly string[] = [];
    fixture.dependencies.mcpInstall!.runProcess = async (_command, args) => {
      claudeArgs = args;
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    expect(
      await runCli(["mcp", "install", "claude-code"], captureIo().io, fixture.dependencies),
    ).toBe(0);
    expect(
      await runCli(["mcp", "install", "claude-desktop"], captureIo().io, fixture.dependencies),
    ).toBe(0);

    const desktopPath = join(
      fixture.homedir,
      "Library",
      "Application Support",
      "Claude",
      "claude_desktop_config.json",
    );
    const desktop = JSON.parse(await readFile(desktopPath, "utf8")) as {
      mcpServers: { vapi: { command: string; args: string[]; env: Record<string, string> } };
    };
    const entry = desktop.mcpServers.vapi;
    expect(claudeArgs).toEqual([
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
    ]);
  });

  it("reports exact Claude Code success JSON", async () => {
    const fixture = await installationFixture("vapi-mcp-install-claude-success-json-");
    fixture.dependencies.mcpInstall!.runProcess = async () => ({
      exitCode: 0,
      stdout: "registered",
      stderr: "",
    });
    const captured = captureIo();
    const command = `claude mcp add --scope user vapi -e VAPI_HOME=${INSTALL_HOME} -e VAPI_REGISTRY_URL=${INSTALL_REGISTRY} -- npx -y vapi-network@latest mcp`;
    const nextStep = 'Start a new Claude Code session, then ask: "Search vAPI for a weather API."';

    expect(
      await runCli(
        [
          "mcp",
          "install",
          "claude-code",
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
    expect(captured.stdout).toEqual([
      JSON.stringify({ app: "claude-code", installed: true, command, nextStep }),
    ]);
    expect(captured.stderr).toEqual([]);
  });

  it("reports a missing Claude Code command exactly in human and JSON modes", async () => {
    const fixture = await installationFixture("vapi-mcp-install-claude-missing-");
    fixture.dependencies.mcpInstall!.runProcess = async () => {
      throw Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" });
    };
    const human = captureIo();
    const machine = captureIo();
    const installArgs = [
      "mcp",
      "install",
      "claude-code",
      "--home",
      INSTALL_HOME,
      "--registry",
      INSTALL_REGISTRY,
    ];
    const command = `claude mcp add --scope user vapi -e VAPI_HOME=${INSTALL_HOME} -e VAPI_REGISTRY_URL=${INSTALL_REGISTRY} -- npx -y vapi-network@latest mcp`;
    const message =
      "Claude Code's claude command was not found on PATH. Install Claude Code, or run this yourself:";

    expect(await runCli(installArgs, human.io, fixture.dependencies)).toBe(1);
    expect(human.stdout).toEqual([]);
    expect(human.stderr).toEqual([`${message}\n${command}`]);

    expect(await runCli([...installArgs, "--json"], machine.io, fixture.dependencies)).toBe(1);
    expect(machine.stderr).toEqual([]);
    expect(machine.stdout).toEqual([
      JSON.stringify({
        app: "claude-code",
        installed: false,
        command,
        error: { code: "claude_not_found", message },
      }),
    ]);
  });

  it("reports Claude Code nonzero status and trimmed stderr", async () => {
    const fixture = await installationFixture("vapi-mcp-install-claude-failed-");
    fixture.dependencies.mcpInstall!.runProcess = async () => ({
      exitCode: 7,
      stdout: "ignored",
      stderr: "  permission denied\n",
    });
    const human = captureIo();
    const machine = captureIo();

    expect(await runCli(["mcp", "install", "claude-code"], human.io, fixture.dependencies)).toBe(1);
    expect(human.stderr[0]).toContain("claude mcp add");
    expect(human.stderr[0]).toContain("exited with code 7. permission denied");

    expect(
      await runCli(["mcp", "install", "claude-code", "--json"], machine.io, fixture.dependencies),
    ).toBe(1);
    expect(machine.stderr).toEqual([]);
    const result = JSON.parse(machine.stdout[0]!) as Record<string, unknown>;
    expect(result).toMatchObject({
      app: "claude-code",
      installed: false,
      error: {
        code: "claude_mcp_add_failed",
        message: "Claude Code's claude command exited with code 7. permission denied",
        exitCode: 7,
      },
    });
  });

  it.each([
    {
      name: "null status",
      runProcess: async () => ({ exitCode: null, stdout: "", stderr: "terminated" }),
      message: "Claude Code's claude command ended without an exit code. terminated",
      exitCode: null,
    },
    {
      name: "runner rejection",
      runProcess: async () => {
        throw new Error("runner broke");
      },
      message: "Claude Code MCP installation failed: runner broke",
      exitCode: undefined,
    },
    {
      name: "timeout rejection",
      runProcess: async () => {
        throw new Error("timed out after 60000ms");
      },
      message: "Claude Code MCP installation failed: timed out after 60000ms",
      exitCode: undefined,
    },
  ])("returns structured JSON for $name", async ({ runProcess, message, exitCode }) => {
    const fixture = await installationFixture("vapi-mcp-install-claude-exception-");
    fixture.dependencies.mcpInstall!.runProcess = runProcess;
    const captured = captureIo();

    expect(
      await runCli(["mcp", "install", "claude-code", "--json"], captured.io, fixture.dependencies),
    ).toBe(1);
    expect(captured.stderr).toEqual([]);
    expect(JSON.parse(captured.stdout[0]!)).toMatchObject({
      app: "claude-code",
      installed: false,
      error: {
        code: "claude_mcp_add_failed",
        message,
        ...(exitCode === undefined ? {} : { exitCode }),
      },
    });
  });

  it("selects claude.cmd on Windows", async () => {
    const fixture = await installationFixture("vapi-mcp-install-claude-windows-");
    fixture.dependencies.mcpInstall!.platform = "win32";
    let invoked = "";
    fixture.dependencies.mcpInstall!.runProcess = async (command) => {
      invoked = command;
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    expect(
      await runCli(["mcp", "install", "claude-code"], captureIo().io, fixture.dependencies),
    ).toBe(0);
    expect(invoked).toBe("claude.cmd");
  });

  it("writes a fresh Claude Desktop config", async () => {
    const fixture = await installationFixture("vapi-mcp-install-claude-");
    const captured = captureIo();

    expect(
      await runCli(
        [
          "mcp",
          "install",
          "claude-desktop",
          "--home",
          INSTALL_HOME,
          "--registry",
          INSTALL_REGISTRY,
        ],
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
          args: ["-y", "vapi-network@latest", "mcp"],
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
          mcpServers: {
            other: { command: "other-command", args: ["serve"] },
            vapi: { command: "npx", args: ["-y", "vapi-network", "mcp"] },
          },
          theme: "dark",
        },
        null,
        2,
      )}\n`,
    );
    const captured = captureIo();

    expect(
      await runCli(["mcp", "install", "claude-desktop"], captured.io, fixture.dependencies),
    ).toBe(0);

    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      mcpServers: {
        other: { command: "other-command", args: ["serve"] },
        vapi: {
          command: "npx",
          args: ["-y", "vapi-network@latest", "mcp"],
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

    expect(
      await runCli(["mcp", "install", "claude-desktop"], captured.io, fixture.dependencies),
    ).toBe(1);

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
          args: ["-y", "vapi-network@latest", "mcp"],
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
        'args = ["-y", "vapi-network@latest", "mcp"]',
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
      'args = ["-y", "vapi-network", "mcp"]',
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
    expect(after).not.toContain('"vapi-network", "mcp"');
    expect(after).toContain('args = ["-y", "vapi-network@latest", "mcp"]');
    expect(after).not.toContain('OLD = "remove"');
    expect(captured.stdout[0]).toBe(`Updated ${path}.`);

    expect(await runCli(["mcp", "install", "codex"], captureIo().io, fixture.dependencies)).toBe(0);
    expect(await readFile(path, "utf8")).toBe(after);
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
      "Usage: vapi mcp install <claude-code|claude-desktop|cursor|codex> [--home <dir>] [--registry <url>] [--json]";

    expect(await runCli(["mcp", "install"], missing.io, fixture.dependencies)).toBe(2);
    expect(missing.stderr).toEqual([usage]);
    expect(await runCli(["mcp", "install", "windsurf"], unknown.io, fixture.dependencies)).toBe(2);
    expect(unknown.stderr).toEqual([
      `Unknown app "windsurf". Choose claude-code, claude-desktop, cursor or codex.\n${usage}`,
    ]);
  });

  it("keeps claude as a one-line Claude Desktop alias, including JSON", async () => {
    const fixture = await installationFixture("vapi-mcp-install-claude-alias-");
    const human = captureIo();
    const machine = captureIo();
    const notice =
      "vapi mcp install claude installs into Claude Desktop; for the Claude Code CLI use: vapi mcp install claude-code";

    expect(await runCli(["mcp", "install", "claude"], human.io, fixture.dependencies)).toBe(0);
    expect(human.stderr).toEqual([notice]);
    expect(human.stdout.at(-1)).toBe(
      'Restart Claude Desktop, then ask it: "Search vAPI for a weather API."',
    );

    expect(
      await runCli(["mcp", "install", "claude", "--json"], machine.io, fixture.dependencies),
    ).toBe(0);
    expect(machine.stderr).toEqual([notice]);
    expect(JSON.parse(machine.stdout[0]!)).toMatchObject({ app: "claude-desktop" });
    const path = join(
      fixture.homedir,
      "Library",
      "Application Support",
      "Claude",
      "claude_desktop_config.json",
    );
    expect(JSON.parse(await readFile(path, "utf8"))).toHaveProperty("mcpServers.vapi");
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
    expect(mcpInstallTarget("claude-desktop", context)).toEqual({
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
    expect(mcpInstallTarget("claude-desktop", context)).toEqual({
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
      mcpInstallTarget("claude-desktop", {
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
    expect(mcpInstallTarget("claude-desktop", context)).toEqual({
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
