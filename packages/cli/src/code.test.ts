import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { WalletStore, type SecretStore } from "@vapi-network/core";
import { RouterClientError, type AgentRouterUsage } from "@vapi-network/core/router-client";

import { runCli, type CliDependencies } from "./cli.js";
import { codexConfigPath, hasVapiCodexProfile, resolveBinary } from "./code.js";

const homes: string[] = [];
const originalHome = process.env.VAPI_HOME;
const KEY = "test-router-key-never-write";
const credentials = { baseURL: "https://router.example/v1", apiKey: KEY };
const usage: AgentRouterUsage = {
  compute: {
    allowanceUsd: 10,
    spentTodayUsd: 2.6,
    remainingTodayUsd: 7.4,
    resetsAt: "2026-10-30T00:00:00Z",
    ownerLimitUsd: 10,
    ownerSpentUsd: 2.6,
  },
  balance: null,
};

afterEach(async () => {
  if (originalHome === undefined) delete process.env.VAPI_HOME;
  else process.env.VAPI_HOME = originalHome;
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

async function fixture(tools = ["claude", "codex"]) {
  const home = await mkdtemp(join(tmpdir(), "vapi-code-"));
  homes.push(home);
  process.env.VAPI_HOME = join(home, "vapi-home");
  const secrets = new Map<string, string>();
  const secretStore: SecretStore = {
    available: true,
    platform: "linux",
    description: "test secrets",
    get: async (key) => secrets.get(key),
    has: async (key) => secrets.has(key),
    set: async (key, value) => {
      secrets.set(key, value);
    },
    remove: async (key) => secrets.delete(key),
  };
  const store = await WalletStore.open(process.env.VAPI_HOME, { secrets: secretStore });
  await store.create("daily", "test-passphrase");
  const line = vi.fn(async () => "yes");
  const deps: CliDependencies = {
    interactive: false,
    stdinIsTTY: false,
    env: { PATH: "/bin", SHELL: "/bin/zsh" },
    secretStore,
    fetchImpl: vi.fn(async () => {
      throw new Error("unexpected network request");
    }),
    prompts: {
      secret: vi.fn(async () => {
        throw new Error("unexpected secret prompt");
      }),
      line,
    },
    code: {
      homedir: home,
      platform: "linux",
      selfPath: "/bin/vapi",
      realpath: async (path) => path,
      isExecutable: async (path) => tools.some((tool) => path === `/bin/${tool}`),
    },
    router: {
      routerCredentials: vi.fn(async () => credentials),
      routerUsage: vi.fn(async () => usage),
      rotateRouterKey: vi.fn(async () => {}),
    },
  };
  const stdout: string[] = [];
  const stderr: string[] = [];
  const io = {
    stdout: (value: string) => {
      stdout.push(value);
    },
    stderr: (value: string) => {
      stderr.push(value);
    },
  };
  const run = (args: string[]) => runCli(["code", ...args], io, deps);
  return {
    home,
    deps,
    stdout,
    stderr,
    run,
    line,
    config: join(home, ".codex", "config.toml"),
    rc: join(home, ".zshrc"),
  };
}

async function put(path: string, contents: string) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents);
}

async function optional(path: string) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

describe("vapi code install/uninstall", () => {
  const mcp = '[mcp_servers.vapi]\ncommand = "npx"\n';
  const fixtures: Array<[string | undefined, string | undefined]> = [
    [undefined, undefined],
    ["", ""],
    ['model = "own"\n', 'model = "own"\n'],
    ['model = "own"', 'model = "own"'],
    [mcp, mcp],
    ['# keep\r\nmodel = "own"\r\n', '# keep\r\nmodel = "own"\r\n'],
    [
      `# keep\n[profiles.vapi]\nmodel = "old"\n[profiles.vapi.env]\nX = "old"\n${mcp}`,
      `# keep\n${mcp}`,
    ],
  ];
  it.each(fixtures)("restores config bytes for %j", async (original, restored) => {
    const f = await fixture();
    if (original !== undefined) await put(f.config, original);
    expect(await f.run(["install", "--no-alias"])).toBe(0);
    const installed = await readFile(f.config, "utf8");
    expect(hasVapiCodexProfile(installed)).toBe(true);
    expect(installed).toContain('base_url = "https://router.example/v1"');
    expect(installed).toContain('env_key = "VAPI_ROUTER_KEY"');
    expect(installed).toContain('wire_api = "responses"');
    expect(installed).toContain('model = "venice/openai-gpt-61-sol"');
    expect(installed).not.toContain(KEY);
    expect(await f.run(["install", "--no-alias"])).toBe(0);
    expect(await readFile(f.config, "utf8")).toBe(installed);
    expect(await f.run(["uninstall"])).toBe(0);
    expect(await optional(f.config)).toBe(restored);
    expect(await f.run(["uninstall"])).toBe(0);
    expect(await optional(f.config)).toBe(restored);
  });

  it.each([".zshrc", ".bashrc"])(
    "restores %s newline conventions and replaces blocks in place",
    async (name) => {
      const f = await fixture();
      f.deps.env!.SHELL = name === ".zshrc" ? "/bin/zsh" : "/bin/bash";
      const path = join(f.home, name);
      for (const original of [
        "",
        "# original",
        "# original\n",
        "# original\n\n",
        "# original\r\n",
      ]) {
        await put(path, original);
        expect(await f.run(["install", "--yes"])).toBe(0);
        const installed = await readFile(path, "utf8");
        expect(installed.match(/# >>> vapi code >>>/gu)).toHaveLength(1);
        expect(installed).toContain('alias claude="vapi claude"\nalias codex="vapi codex"');
        expect(installed).not.toContain(KEY);
        expect(await f.run(["install", "--yes"])).toBe(0);
        expect(await readFile(path, "utf8")).toBe(installed);
        expect(await f.run(["uninstall"])).toBe(0);
        expect(await readFile(path, "utf8")).toBe(original);
      }
      const original =
        '# before\n# >>> vapi code >>>\nalias codex="old"\n# <<< vapi code <<<\n# after\n';
      await put(path, original);
      expect(await f.run(["install", "--yes"])).toBe(0);
      expect(await readFile(path, "utf8")).toBe(
        original.replace(
          'alias codex="old"',
          'alias claude="vapi claude"\nalias codex="vapi codex"',
        ),
      );
      expect(await f.run(["uninstall"])).toBe(0);
      expect(await readFile(path, "utf8")).toBe("# before\n# after\n");
    },
  );

  it("removes blocks from both shells and never creates missing files during uninstall", async () => {
    const f = await fixture();
    const before = await readdir(f.home);
    expect(await f.run(["uninstall"])).toBe(0);
    expect(await readdir(f.home)).toEqual(before);
    expect(f.stdout).toContain("Nothing to remove.");
    await put(
      f.rc,
      '# before\n# >>> vapi code >>>\nalias claude="vapi claude"\n# <<< vapi code <<<\n',
    );
    await put(
      join(f.home, ".bashrc"),
      '# bash\n# >>> vapi code >>>\nalias codex="vapi codex"\n# <<< vapi code <<<\n',
    );
    expect(await f.run(["uninstall"])).toBe(0);
    expect(await readFile(f.rc, "utf8")).toBe("# before\n");
    expect(await readFile(join(f.home, ".bashrc"), "utf8")).toBe("# bash\n");
    expect(f.deps.router!.routerCredentials).not.toHaveBeenCalled();
    expect(f.deps.router!.rotateRouterKey).not.toHaveBeenCalled();
  });

  it("restores a missing rc file and keeps an existing empty rc file", async () => {
    const f = await fixture();
    expect(await f.run(["install", "--yes"])).toBe(0);
    expect(await optional(f.rc)).toContain("alias claude=");
    expect(await f.run(["uninstall"])).toBe(0);
    expect(await optional(f.rc)).toBeUndefined();
    await put(f.rc, "");
    expect(await f.run(["install", "--yes"])).toBe(0);
    expect(await f.run(["uninstall"])).toBe(0);
    expect(await optional(f.rc)).toBe("");
  });

  it("preserves unrelated tables inserted inside the owned config block", async () => {
    const f = await fixture();
    expect(await f.run(["install", "--no-alias"])).toBe(0);
    const installed = await readFile(f.config, "utf8");
    const other = '[profiles.own]\nmodel = "own"\n';
    await writeFile(f.config, installed.replace("[profiles.vapi]", `${other}[profiles.vapi]`));
    expect(await f.run(["uninstall"])).toBe(0);
    expect(await readFile(f.config, "utf8")).toBe(other);
  });

  it("preserves the code profile through a subsequent MCP installation", async () => {
    const f = await fixture();
    await put(f.config, '[mcp_servers.vapi]\ncommand = "old"\n');
    expect(await f.run(["install", "--no-alias"])).toBe(0);
    f.deps.mcpInstall = { homedir: f.home };
    expect(
      await runCli(
        [
          "mcp",
          "install",
          "codex",
          "--home",
          process.env.VAPI_HOME!,
          "--registry",
          "https://registry.example",
          "--no-link",
        ],
        { stdout: () => {}, stderr: () => {} },
        f.deps,
      ),
    ).toBe(0);
    const combined = await readFile(f.config, "utf8");
    expect(hasVapiCodexProfile(combined)).toBe(true);
    expect(combined).toContain("# >>> vapi code config existing 0 >>>");
    expect(combined).toContain('[mcp_servers.vapi]\ncommand = "npx"');
    expect(await f.run(["uninstall"])).toBe(0);
    const removed = await readFile(f.config, "utf8");
    expect(removed).toContain('[mcp_servers.vapi]\ncommand = "npx"');
    expect(removed).not.toContain("vapi code config");
    expect(hasVapiCodexProfile(removed)).toBe(false);
  });

  it("honors CODEX_HOME and recognizes only complete vapi profiles", async () => {
    const f = await fixture();
    f.deps.env!.CODEX_HOME = join(f.home, "custom-codex");
    expect(codexConfigPath(f.deps.env!, f.home)).toBe(join(f.home, "custom-codex", "config.toml"));
    expect(await f.run(["install", "--no-alias"])).toBe(0);
    expect(await optional(f.config)).toBeUndefined();
    expect(hasVapiCodexProfile(await readFile(codexConfigPath(f.deps.env!, f.home), "utf8"))).toBe(
      true,
    );
    expect(hasVapiCodexProfile("[profiles.vapi]\n")).toBe(false);
    expect(hasVapiCodexProfile("[profiles.vapi.env]\n[model_providers.vapi]\n")).toBe(false);
    expect(hasVapiCodexProfile("[\"profiles\".'vapi']\n[model_providers.vapi]\n")).toBe(true);
    expect(await f.run(["uninstall"])).toBe(0);
    expect(await optional(codexConfigPath(f.deps.env!, f.home))).toBeUndefined();
  });

  it.each(["claude", "codex"])(
    "installs only %s when the other binary is missing",
    async (tool) => {
      const f = await fixture([tool]);
      expect(await f.run(["install", "--yes"])).toBe(0);
      expect(f.stderr.join("\n")).toContain("is not on PATH");
      const rc = await readFile(f.rc, "utf8");
      expect(rc).toContain(`alias ${tool}="vapi ${tool}"`);
      expect(rc).not.toContain(`alias ${tool === "claude" ? "codex" : "claude"}=`);
      expect((await optional(f.config)) !== undefined).toBe(tool === "codex");
      expect(f.stdout.at(-1)).toBe(`Start with \`vapi ${tool}\``);
    },
  );

  it("returns 1 with no writes or credential calls when neither tool exists", async () => {
    const f = await fixture([]);
    const before = await readdir(f.home);
    expect(await f.run(["install", "--yes"])).toBe(1);
    expect(await readdir(f.home)).toEqual(before);
    expect(f.stderr.join("\n")).toContain("Neither claude nor codex");
    expect(f.deps.router!.routerCredentials).not.toHaveBeenCalled();
  });

  it("prompts once only when interactive, and honors --no-alias and --yes", async () => {
    const f = await fixture();
    expect(await f.run(["install"])).toBe(0);
    expect(f.line).not.toHaveBeenCalled();
    expect(await optional(f.rc)).toBeUndefined();
    f.deps.interactive = true;
    f.deps.stdinIsTTY = true;
    expect(await f.run(["install", "--no-alias", "--yes"])).toBe(0);
    expect(f.line).not.toHaveBeenCalled();
    expect(await optional(f.rc)).toBeUndefined();
    f.deps.stdinIsTTY = false;
    expect(await f.run(["install"])).toBe(0);
    expect(f.line).not.toHaveBeenCalled();
    f.deps.stdinIsTTY = true;
    f.line.mockResolvedValueOnce("no");
    expect(await f.run(["install"])).toBe(0);
    expect(await optional(f.rc)).toBeUndefined();
    f.line.mockClear();
    expect(await f.run(["install"])).toBe(0);
    expect(f.line).toHaveBeenCalledExactlyOnceWith(
      "Make `claude` and `codex` use your vAPI Compute first from now on? [y/N] ",
    );
    expect(await optional(f.rc)).toContain("alias claude=");
  });

  it("produces one JSON object, including after inline login, and never prompts", async () => {
    const f = await fixture();
    f.deps.interactive = true;
    f.deps.stdinIsTTY = true;
    f.deps.router!.routerCredentials = vi
      .fn()
      .mockRejectedValueOnce(new RouterClientError("not_linked", "link required"))
      .mockResolvedValue(credentials);
    f.deps.code!.login = vi.fn(async (_argv, _json, io, dependencies) => {
      expect(dependencies.interactive).toBe(false);
      expect(dependencies.stdinIsTTY).toBe(false);
      io.stdout("login result");
    });
    expect(await f.run(["install", "--json"])).toBe(0);
    expect(f.stdout).toHaveLength(1);
    expect(JSON.parse(f.stdout[0]!)).toMatchObject({
      command: "code install",
      compute: "$7.40 left today (resets 00:00 UTC)",
    });
    expect(f.line).not.toHaveBeenCalled();
    expect(await optional(f.rc)).toBeUndefined();
    f.stdout.length = 0;
    expect(await f.run(["uninstall", "--json"])).toBe(0);
    expect(f.stdout).toHaveLength(1);
    expect(JSON.parse(f.stdout[0]!)).toMatchObject({
      command: "code uninstall",
      removed: [f.config],
    });
  });

  it.each(["not_linked", "no_router_key"] as const)(
    "recovers from %s once and forwards the selected account",
    async (code) => {
      const f = await fixture();
      const read = vi
        .fn()
        .mockRejectedValueOnce(new RouterClientError(code, "setup required"))
        .mockResolvedValue(credentials);
      const login = vi.fn(async () => {});
      f.deps.router!.routerCredentials = read;
      f.deps.code!.login = login;
      expect(await f.run(["install", "--account", "daily", "--no-alias"])).toBe(0);
      expect(read).toHaveBeenCalledTimes(2);
      expect(read).toHaveBeenLastCalledWith(expect.objectContaining({ wallet: "daily" }));
      if (code === "not_linked")
        expect(login).toHaveBeenCalledWith(
          ["--account", "daily"],
          false,
          expect.anything(),
          f.deps,
        );
      else expect(f.deps.router!.rotateRouterKey).toHaveBeenCalledTimes(1);
      expect(await readFile(f.config, "utf8")).not.toContain(KEY);
    },
  );

  it("bounds retries and does not write configuration when credentials or rotation fail", async () => {
    const f = await fixture();
    const read = vi.fn(async () => {
      throw new RouterClientError("no_router_key", "still unavailable");
    });
    f.deps.router!.routerCredentials = read;
    expect(await f.run(["install", "--yes"])).toBe(1);
    expect(read).toHaveBeenCalledTimes(2);
    expect(f.deps.router!.rotateRouterKey).toHaveBeenCalledTimes(1);
    expect(await optional(f.config)).toBeUndefined();
    f.deps.router!.rotateRouterKey = async () => {
      throw new Error("rotation failed");
    };
    expect(await f.run(["install"])).toBe(1);
    expect(f.stderr.join("\n")).toContain("rotation failed");
    f.deps.router!.routerCredentials = async () => {
      throw new RouterClientError("http", "service failed", 503);
    };
    expect(await f.run(["install"])).toBe(1);
    expect(await optional(f.config)).toBeUndefined();
  });

  it("reports unavailable usage without failing the installation or exposing service error details", async () => {
    const f = await fixture();
    f.deps.router!.routerUsage = async () => {
      throw new RouterClientError("http", `response includes ${KEY}`, 503);
    };
    expect(await f.run(["install", "--no-alias"])).toBe(0);
    expect(f.stdout).toContain("Compute today: unavailable (http)");
    expect([...f.stdout, ...f.stderr].join("\n")).not.toContain(KEY);
  });

  it("chooses an existing zshrc for unknown shells and falls back to bashrc", async () => {
    const f = await fixture();
    f.deps.env!.SHELL = "/bin/fish";
    expect(await f.run(["install", "--yes"])).toBe(0);
    expect(await optional(join(f.home, ".bashrc"))).toContain("alias claude=");
    await put(f.rc, "# zsh\n");
    expect(await f.run(["install", "--yes"])).toBe(0);
    expect(await readFile(f.rc, "utf8")).toContain("# zsh\n# >>> vapi code >>>");
  });

  it("skips aliases on Windows", async () => {
    const f = await fixture();
    f.deps.code!.platform = "win32";
    f.deps.env!.PATH = "C:\\bin";
    f.deps.code!.isExecutable = async (path) => path === "C:\\bin\\codex.EXE";
    expect(await f.run(["install", "--yes"])).toBe(0);
    expect(f.stdout).toContain("Aliases: skipped on Windows.");
    expect(await optional(f.rc)).toBeUndefined();
  });

  it("rejects invalid invocations before filesystem, secrets, or network access", async () => {
    const io = { stdout: vi.fn(), stderr: vi.fn() };
    const deps: CliDependencies = {
      interactive: false,
      env: {},
      code: { isExecutable: vi.fn(), homedir: "/does/not/exist" },
      secretStore: {
        get available(): boolean {
          throw new Error("secret store touched");
        },
        platform: "linux",
        description: "must not be accessed",
        get: vi.fn(),
        has: vi.fn(),
        set: vi.fn(),
        remove: vi.fn(),
      },
    };
    for (const args of [
      [],
      ["--vapi-alignment-probe"],
      ["unknown"],
      ["install", "--bad"],
      ["uninstall", "--yes"],
      ["uninstall", "extra"],
    ])
      expect(await runCli(["code", ...args], io, deps)).toBe(2);
    expect(deps.code!.isExecutable).not.toHaveBeenCalled();
    expect(io.stderr.mock.calls.flat().join("\n")).not.toContain("secret store touched");
  });
});

describe("resolveBinary", () => {
  it("skips self-resolution, tries PATH in order, and ignores shell aliases", async () => {
    const isExecutable = vi.fn(async () => true);
    const realpath = vi.fn(async (path: string) => (path === "/first/claude" ? "/vapi" : path));
    expect(
      await resolveBinary("claude", {
        env: { PATH: "/first:/second" },
        platform: "linux",
        selfPath: "/vapi",
        isExecutable,
        realpath,
      }),
    ).toBe("/second/claude");
    expect(isExecutable.mock.calls).toEqual([["/first/claude"], ["/second/claude"]]);
  });

  it("does not touch the filesystem without PATH", async () => {
    const isExecutable = vi.fn();
    const realpath = vi.fn();
    expect(await resolveBinary("claude", { env: {}, isExecutable, realpath })).toBeUndefined();
    expect(isExecutable).not.toHaveBeenCalled();
    expect(realpath).not.toHaveBeenCalled();
  });

  it("uses PATHEXT on Windows and compares realpaths without case sensitivity", async () => {
    expect(
      await resolveBinary("codex", {
        env: { PATH: "C:\\first;C:\\second", PATHEXT: ".EXE;.CMD" },
        platform: "win32",
        selfPath: "C:\\VAPI.EXE",
        realpath: async (path) => (path.startsWith("C:\\first") ? "c:\\vapi.exe" : path),
        isExecutable: async (path) => path.endsWith(".CMD"),
      }),
    ).toBe("C:\\second\\codex.CMD");
  });
});
