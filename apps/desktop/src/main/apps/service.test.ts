import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { appPaths, detectApps } from "./detect.js";
import { cursorInstallUrl, mcpbManifest, tomlBlock, vscodeInstallUrl } from "./install.js";
import { appSnippet, appStatuses, connectApp, type AppsDeps } from "./service.js";
import { writeTomlEntry } from "./toml-block.js";

describe("Apps service", () => {
  let root: string;
  let deps: AppsDeps;
  const open = vi.fn<(target: string) => Promise<string>>();
  const original = 'model = "gpt-5"\n\n[projects."/Users/x/a"]\ntrust_level = "trusted"\n';
  const shimJs = 'console.log("Node shim for Claude");\n';

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "apps-service-test-"));
    open.mockReset().mockResolvedValue("");
    deps = {
      paths: appPaths(join(root, "appData"), join(root, "home")),
      shimPath: join(root, "vapi-mcp-shim"),
      shimJsPath: join(root, "shim.js"),
      socketPath: join(root, "mcp.sock"),
      mcpbDir: join(root, "mcpb"),
      open,
      run: async (file, args) => {
        expect(file).toBe("/usr/bin/ditto");
        expect(args.slice(0, 3)).toEqual(["-c", "-k", "--norsrc"]);
        const stage = args[3]!;
        expect(JSON.parse(await readFile(join(stage, "manifest.json"), "utf8"))).toEqual(
          mcpbManifest({ socketPath: deps.socketPath, wallet: "claude" }),
        );
        expect(await readFile(join(stage, "dist/shim.js"), "utf8")).toBe(shimJs);
        await writeFile(args[4]!, "fake bundle");
        return { code: 0, stderr: "" };
      },
    };
    await writeFile(deps.shimJsPath, shimJs);
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function target(wallet = "claude") {
    return { shimPath: deps.shimPath, socketPath: deps.socketPath, wallet };
  }

  async function put(path: string, text: string) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text);
  }

  it("builds Claude Desktop's bundle in mcpbDir and opens it", async () => {
    expect(await connectApp(deps, "claude-desktop", "claude")).toEqual({
      ok: true,
      kind: "opened",
    });
    const path = join(deps.mcpbDir, "vapi-desktop-claude.mcpb");
    expect(open.mock.calls).toEqual([[path]]);
    expect(await readFile(path, "utf8")).toBe("fake bundle");
  });

  it.each(["cursor", "vscode"] as const)("opens the exact %s installation link", async (id) => {
    expect(await connectApp(deps, id, "claude")).toEqual({ ok: true, kind: "opened" });
    expect(open.mock.calls).toEqual([
      [id === "cursor" ? cursorInstallUrl(target()) : vscodeInstallUrl(target())],
    ]);
  });

  it.each([
    ["cursor", "Cursor"],
    ["vscode", "VS Code"],
  ] as const)("reports when %s does not open", async (id, label) => {
    open.mockResolvedValue("boom");
    expect(await connectApp(deps, id, "claude")).toEqual({
      ok: false,
      message: `${label} did not open. Is it installed?`,
    });
  });

  it("reports Claude Desktop's extension open error", async () => {
    open.mockResolvedValue("boom");
    expect(await connectApp(deps, "claude-desktop", "claude")).toEqual({
      ok: false,
      message: "Claude Desktop did not open the extension: boom",
    });
  });

  describe.each(["codex", "grok-cli"] as const)("%s config", (id) => {
    function configPath() {
      return id === "codex" ? deps.paths.codex : deps.paths.grokCli;
    }

    it("backs up the original bytes, preserves mode, then switches only the wallet", async () => {
      const path = configPath();
      await put(path, original);
      await chmod(path, 0o644);
      expect(await connectApp(deps, id, "claude")).toEqual({
        ok: true,
        kind: "written",
        path,
        backup: path + ".vapi-backup",
      });
      expect(await readFile(path + ".vapi-backup")).toEqual(Buffer.from(original));
      const first = await readFile(path, "utf8");
      expect(first).toBe(writeTomlEntry(original, tomlBlock(target())));
      expect((await stat(path)).mode & 0o777).toBe(0o644);
      expect(await connectApp(deps, id, "research")).toEqual({
        ok: true,
        kind: "written",
        path,
        backup: path + ".vapi-backup",
      });
      expect(await readFile(path, "utf8")).toBe(
        first.replace('VAPI_DESKTOP_WALLET = "claude"', 'VAPI_DESKTOP_WALLET = "research"'),
      );
      expect(await readFile(path + ".vapi-backup")).toEqual(Buffer.from(original));
      expect((await stat(path)).mode & 0o777).toBe(0o644);
      expect(open).not.toHaveBeenCalled();
    });

    it("creates a missing directory and config with private modes and no backup", async () => {
      const path = configPath();
      expect(await connectApp(deps, id, "claude")).toEqual({
        ok: true,
        kind: "written",
        path,
        backup: null,
      });
      expect((await stat(dirname(path))).mode & 0o777).toBe(0o700);
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect(await readFile(path, "utf8")).toBe(tomlBlock(target()) + "\n");
      await expect(stat(path + ".vapi-backup")).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("refuses an unmanaged vapi server without changing or backing up the file", async () => {
      const path = configPath();
      const conflict = '[mcp_servers.vapi]\ncommand = "x"\n';
      await put(path, conflict);
      expect(await connectApp(deps, id, "claude")).toEqual({
        ok: false,
        message: `A vapi server is already set up in ${path}. Remove it or edit it by hand.`,
      });
      expect(await readFile(path, "utf8")).toBe(conflict);
      await expect(stat(path + ".vapi-backup")).rejects.toMatchObject({ code: "ENOENT" });
      await expect(stat(path + ".tmp")).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("keeps an existing backup when installing into an unmanaged file", async () => {
      const path = configPath();
      await put(path, original);
      await writeFile(path + ".vapi-backup", "earliest original");
      expect(await connectApp(deps, id, "claude")).toEqual({
        ok: true,
        kind: "written",
        path,
        backup: path + ".vapi-backup",
      });
      expect(await readFile(path + ".vapi-backup", "utf8")).toBe("earliest original");
    });

    it("does not back up an already-managed file when changing wallets", async () => {
      const path = configPath();
      await put(path, tomlBlock(target()) + "\n");
      expect(await connectApp(deps, id, "research")).toEqual({
        ok: true,
        kind: "written",
        path,
        backup: null,
      });
      await expect(stat(path + ".vapi-backup")).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it.each(["codex", "grok-cli"] as const)("shows the exact %s TOML block", (id) => {
    expect(appSnippet(deps, id, "claude")).toBe(tomlBlock(target()));
  });

  it.each(["cursor", "vscode", "claude-desktop"] as const)("has no snippet for %s", (id) => {
    expect(appSnippet(deps, id, "claude")).toBeNull();
  });

  it("reports the installed wallet by reading the app configs", async () => {
    await connectApp(deps, "codex", "research");
    const statuses = await appStatuses(deps);
    expect(statuses).toEqual(await detectApps(deps.paths));
    expect(statuses).toContainEqual({ id: "codex", state: "connected", wallet: "research" });
  });
  it("writes through a symlinked config file and keeps the link", async () => {
    const real = join(root, "dotfiles", "codex.toml");
    await put(real, original);
    await mkdir(dirname(deps.paths.codex), { recursive: true });
    await symlink(real, deps.paths.codex);
    const result = await connectApp(deps, "codex", "claude");
    expect(result).toMatchObject({ ok: true, kind: "written" });
    expect((await lstat(deps.paths.codex)).isSymbolicLink()).toBe(true);
    expect(await readFile(real, "utf8")).toBe(writeTomlEntry(original, tomlBlock(target())));
  });
});
