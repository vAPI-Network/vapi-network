import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { constants, tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { WalletStore, type SecretStore } from "@vapi-network/core";
import { RouterClientError, type AgentRouterUsage } from "@vapi-network/core/router-client";

import { UsageError, runCli, type CliDependencies } from "./cli.js";
import { claudeCommand, codexCommand } from "./code-launch.js";
import { codexConfigPath, type CodeChild, type CodeSpawn } from "./code.js";

const homes: string[] = [];
const KEY = "test-router-key-not-for-argv";
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
const settings = (model = "venice/claude-sonnet-5-5") =>
  JSON.stringify({
    env: {
      ANTHROPIC_MODEL: model,
      ANTHROPIC_DEFAULT_SONNET_MODEL: "venice/claude-sonnet-5-5",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "venice/claude-opus-5-5",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "venice/claude-haiku-5-5",
      CLAUDE_CODE_MAX_RETRIES: "2",
    },
  });

class FakeChild extends EventEmitter {
  kill = vi.fn((_signal?: NodeJS.Signals | number) => true);
}

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "vapi-code-launch-"));
  homes.push(home);
  const secrets = new Map<string, string>();
  const secretStore: SecretStore = {
    available: true,
    platform: "linux",
    description: "test only",
    get: vi.fn(async (key) => secrets.get(key)),
    has: vi.fn(async (key) => secrets.has(key)),
    set: vi.fn(async (key, value) => {
      secrets.set(key, value);
    }),
    remove: vi.fn(async (key) => secrets.delete(key)),
  };
  const env: NodeJS.ProcessEnv = {
    PATH: "/fake/bin",
    VAPI_HOME: join(home, "vapi"),
    SHELL: "/bin/zsh",
  };
  const store = await WalletStore.open(env.VAPI_HOME, { secrets: secretStore, env });
  await store.create("daily", "test-passphrase");
  const signals = new EventEmitter();
  // The launcher uses only events and kill; once() also names the full Node child type.
  const child = new FakeChild() as FakeChild & CodeChild;
  const spawn = vi.fn<CodeSpawn>(() => {
    queueMicrotask(() => child.emit("exit", 0, null));
    return child;
  });
  const readCredentials = vi.fn(async () => credentials);
  const readUsage = vi.fn(async () => usage);
  const deps: CliDependencies = {
    env,
    interactive: false,
    secretStore,
    fetchImpl: vi.fn(async () => {
      throw new Error("unexpected network");
    }),
    code: {
      homedir: home,
      platform: "linux",
      selfPath: "/fake/vapi",
      realpath: vi.fn(async (path) => path),
      isExecutable: vi.fn(async () => true),
      spawn,
      processSignals: signals,
    },
    router: { routerCredentials: readCredentials, routerUsage: readUsage },
  };
  const stdout: string[] = [];
  const stderr: string[] = [];
  const io = {
    stdout: (message: string) => {
      stdout.push(message);
    },
    stderr: (message: string) => {
      stderr.push(message);
    },
  };
  const run = (tool: "claude" | "codex", args: string[] = []) => runCli([tool, ...args], io, deps);
  return {
    home,
    env,
    store,
    deps,
    child,
    spawn,
    signals,
    readCredentials,
    readUsage,
    stdout,
    stderr,
    io,
    run,
  };
}

function usageWith(compute: number, balance: number | null): AgentRouterUsage {
  return {
    ...usage,
    compute: { ...usage.compute, remainingTodayUsd: compute },
    balance:
      balance === null ? null : { remainingUsd: balance, purchasedUsd: balance, spentUsd: 0 },
  };
}

for (const tool of ["claude", "codex"] as const) {
  describe(`vapi ${tool}`, () => {
    it.each([
      { flags: [], compute: 0.49, balance: null, vapi: false },
      { flags: [], compute: 0.5, balance: null, vapi: true },
      { flags: [], compute: 7.4, balance: null, vapi: true },
      { flags: [], compute: 0, balance: 5, vapi: false },
      { flags: ["--use-balance"], compute: 0, balance: 5, vapi: true },
      { flags: ["--use-balance"], compute: 0.25, balance: 0.25, vapi: true },
      { flags: ["--use-balance"], compute: 0.25, balance: 0.24, vapi: false },
      { flags: ["--use-balance"], compute: 0.49, balance: null, vapi: false },
      { flags: ["--own"], compute: 7.4, balance: 5, vapi: false },
      { flags: ["--vapi"], compute: 0, balance: null, vapi: true },
    ])(
      "routes $flags with Compute $compute and balance $balance",
      async ({ flags, compute, balance, vapi }) => {
        const f = await fixture();
        f.readUsage.mockResolvedValue(usageWith(compute, balance));
        expect(await f.run(tool, [...flags, "resume", "--last"])).toBe(0);
        const [binary, args, options] = f.spawn.mock.calls[0]!;
        expect(binary).toBe(`/fake/bin/${tool}`);
        expect(options.stdio).toBe("inherit");
        expect(options.env[tool === "claude" ? "ANTHROPIC_AUTH_TOKEN" : "VAPI_ROUTER_KEY"]).toBe(
          vapi ? KEY : undefined,
        );
        expect(args.slice(-2)).toEqual(["resume", "--last"]);
        expect(JSON.stringify(args)).not.toContain(KEY);
        if (!vapi) {
          expect(args).toEqual(["resume", "--last"]);
          expect(options.env).toBe(f.env);
          expect(JSON.stringify(options.env)).not.toContain(KEY);
          if (!flags.includes("--own"))
            expect(f.stderr).toEqual([
              `● Compute used up today → ${tool === "claude" ? "your own Claude subscription" : "your own Codex/ChatGPT login"}`,
            ]);
        }
        if (flags.includes("--own")) {
          expect(f.readCredentials).not.toHaveBeenCalled();
          expect(f.readUsage).not.toHaveBeenCalled();
          expect(f.stderr).toEqual([]);
        }
      },
    );

    it.each(["not_linked", "no_router_key", "http", "budget_exhausted", "rate_limited"] as const)(
      "falls back on Router error %s",
      async (code) => {
        const f = await fixture();
        f.readUsage.mockRejectedValue(new RouterClientError(code, "service offline", 503));
        expect(await f.run(tool)).toBe(0);
        expect(f.spawn.mock.calls[0]![1]).toEqual([]);
        expect(JSON.stringify(f.spawn.mock.calls[0]![2].env)).not.toContain(KEY);
        const reason =
          code === "not_linked"
            ? "not linked, run vapi code install"
            : code === "no_router_key"
              ? "no Router key, run vapi code install"
              : "service offline";
        expect(f.stderr).toEqual([
          `● vAPI unreachable (${reason}) → ${tool === "claude" ? "your own Claude subscription" : "your own Codex/ChatGPT login"}`,
        ]);
      },
    );

    it("falls back on a credential failure without reading usage", async () => {
      const f = await fixture();
      f.readCredentials.mockRejectedValue(new Error("offline"));
      expect(await f.run(tool)).toBe(0);
      expect(f.readUsage).not.toHaveBeenCalled();
      expect(f.spawn.mock.calls[0]![2].env).toBe(f.env);
      expect(f.stderr[0]).toContain("vAPI unreachable (offline)");
    });

    it("does not silently fall back when --vapi credentials fail", async () => {
      const f = await fixture();
      f.readCredentials.mockRejectedValue(new RouterClientError("not_linked", "no link"));
      expect(await f.run(tool, ["--vapi"])).toBe(1);
      expect(f.spawn).not.toHaveBeenCalled();
      expect(f.stderr).toEqual(["not linked, run vapi code install"]);
    });

    it("keeps the forced route when usage fails, without a dollar amount", async () => {
      const f = await fixture();
      f.readUsage.mockRejectedValue(new Error("offline"));
      expect(await f.run(tool, ["--vapi"])).toBe(0);
      expect(f.stderr[0]).toBe(
        `● vAPI Compute · model ${tool === "claude" ? "claude-sonnet-5-5" : "openai-gpt-61-sol"}`,
      );
      expect(
        f.spawn.mock.calls[0]![2].env[
          tool === "claude" ? "ANTHROPIC_AUTH_TOKEN" : "VAPI_ROUTER_KEY"
        ],
      ).toBe(KEY);
    });

    it.each(["credentials", "usage"] as const)(
      "times out a hanging %s call and launches the own subscription",
      async (stage) => {
        const f = await fixture();
        vi.useFakeTimers();
        f.deps.code!.usageTimeoutMs = 10;
        let reached!: () => void;
        const ready = new Promise<void>((resolve) => {
          reached = resolve;
        });
        const never = () => {
          reached();
          return new Promise<never>(() => {});
        };
        if (stage === "credentials") f.readCredentials.mockImplementation(never);
        else f.readUsage.mockImplementation(never);
        const result = f.run(tool);
        await ready;
        await vi.advanceTimersByTimeAsync(9);
        expect(f.spawn).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(await result).toBe(0);
        expect(f.stderr[0]).toContain("vAPI unreachable (timed out)");
        expect(f.spawn.mock.calls[0]![2].env).toBe(f.env);
        expect(vi.getTimerCount()).toBe(0);
      },
    );

    it("preserves parent environment values on --own and passes through the explicit model", async () => {
      const f = await fixture();
      Object.assign(f.env, {
        ANTHROPIC_BASE_URL: "https://external.example",
        ANTHROPIC_AUTH_TOKEN: "external-auth",
        ANTHROPIC_API_KEY: "external-key",
        VAPI_ROUTER_KEY: "external-router",
      });
      const snapshot = { ...f.env };
      expect(await f.run(tool, ["--own", "--model", "opus", "--continue"])).toBe(0);
      expect(f.spawn.mock.calls[0]![1]).toEqual([
        tool === "claude" ? "--model" : "-m",
        "opus",
        "--continue",
      ]);
      expect(f.spawn.mock.calls[0]![2].env).toBe(f.env);
      expect(f.env).toEqual(snapshot);
    });

    it("preserves unknown arguments and consumes only launcher options before --", async () => {
      const f = await fixture();
      const args = [
        "resume",
        "--own",
        "--account",
        "daily",
        "--flag=value",
        "prompt with spaces",
        "--model",
        "custom",
        "--wallet",
        "keep",
        "--",
        "--model",
        "after",
        "--vapi",
        "--account",
        "child",
        "--json",
        "--wallet",
        "child-wallet",
        "--",
        "last",
      ];
      expect(await f.run(tool, args)).toBe(0);
      expect(f.spawn.mock.calls[0]![1]).toEqual([
        tool === "claude" ? "--model" : "-m",
        "custom",
        "resume",
        "--flag=value",
        "prompt with spaces",
        "--wallet",
        "keep",
        "--model",
        "after",
        "--vapi",
        "--account",
        "child",
        "--json",
        "--wallet",
        "child-wallet",
        "--",
        "last",
      ]);
      expect(f.readCredentials).not.toHaveBeenCalled();
    });

    it("honors the account selection for both credentials and usage", async () => {
      const f = await fixture();
      await f.store.create("work", "test-passphrase");
      expect(await f.run(tool, ["--account", "work"])).toBe(0);
      expect(f.readCredentials).toHaveBeenCalledWith(expect.objectContaining({ wallet: "work" }));
      expect(f.readUsage).toHaveBeenCalledWith(expect.objectContaining({ wallet: "work" }));
    });

    it.each([["--vapi", "--own"], ["--model"], ["--model", "--own"], ["--account"], ["--json"]])(
      "rejects invalid launcher arguments %j before resolving the binary",
      async (...args) => {
        const f = await fixture();
        expect(await f.run(tool, args)).toBe(2);
        expect(f.spawn).not.toHaveBeenCalled();
        expect(f.deps.code!.isExecutable).not.toHaveBeenCalled();
        expect(f.readCredentials).not.toHaveBeenCalled();
        if (args.includes("--json"))
          expect(JSON.parse(f.stdout[0]!)).toMatchObject({
            error: `vapi ${tool} is interactive and does not support --json.`,
            exitCode: 2,
          });
      },
    );

    it("returns 127 for a missing binary before accessing accounts or the Router", async () => {
      const f = await fixture();
      f.deps.code!.isExecutable = vi.fn(async () => false);
      const before = await readdir(f.home);
      expect(await f.run(tool)).toBe(127);
      expect(f.stderr).toEqual([
        `\`${tool}\` is not on PATH. Install ${tool === "claude" ? "Claude Code" : "Codex"} first.`,
      ]);
      expect(f.readCredentials).not.toHaveBeenCalled();
      expect(f.readUsage).not.toHaveBeenCalled();
      expect(f.spawn).not.toHaveBeenCalled();
      expect(await readdir(f.home)).toEqual(before);
    });

    it("keeps the help-alignment probe free of filesystem, secret-store, network, and spawn access", async () => {
      const io = { stdout: vi.fn(), stderr: vi.fn() };
      const spawn = vi.fn<CodeSpawn>();
      const isExecutable = vi.fn();
      const readCredentials = vi.fn();
      expect(
        await runCli([tool, "--vapi-alignment-probe"], io, {
          interactive: false,
          env: {},
          code: { spawn, isExecutable, homedir: "/must/not/read" },
          router: { routerCredentials: readCredentials },
        }),
      ).toBe(127);
      expect(isExecutable).not.toHaveBeenCalled();
      expect(readCredentials).not.toHaveBeenCalled();
      expect(spawn).not.toHaveBeenCalled();
    });

    it("skips a PATH entry resolving to vapi itself", async () => {
      const f = await fixture();
      f.env.PATH = "/self:/real";
      f.deps.code!.realpath = async (path) => (path === `/self/${tool}` ? "/fake/vapi" : path);
      expect(await f.run(tool, ["--own"])).toBe(0);
      expect(f.spawn.mock.calls[0]![0]).toBe(`/real/${tool}`);
    });
  });
}

describe("vAPI Claude settings", () => {
  it.each([undefined, "sonnet", "opus", "haiku", "provider/custom"])(
    "uses exact --settings JSON for model %s and removes the Anthropic API key",
    async (model) => {
      const f = await fixture();
      f.env.ANTHROPIC_API_KEY = "user-anthropic-secret";
      const before = { ...f.env };
      expect(
        await f.run("claude", [...(model === undefined ? [] : ["--model", model]), "--continue"]),
      ).toBe(0);
      const expected =
        model === undefined || model === "sonnet"
          ? "venice/claude-sonnet-5-5"
          : model === "opus"
            ? "venice/claude-opus-5-5"
            : model === "haiku"
              ? "venice/claude-haiku-5-5"
              : model;
      expect(f.spawn.mock.calls[0]![1]).toEqual(["--settings", settings(expected), "--continue"]);
      expect(f.spawn.mock.calls[0]![2].env).toEqual({
        PATH: f.env.PATH,
        SHELL: f.env.SHELL,
        VAPI_HOME: f.env.VAPI_HOME,
        ANTHROPIC_BASE_URL: "https://router.example",
        ANTHROPIC_AUTH_TOKEN: KEY,
      });
      expect(f.env).toEqual(before);
      expect(f.stderr).toEqual([
        `● vAPI Compute — $7.40 left today (resets 00:00 UTC) · model ${expected.slice(expected.lastIndexOf("/") + 1)}`,
        "  Compute runs out mid-session? /exit, then: vapi claude --continue",
      ]);
      expect(JSON.stringify(f.spawn.mock.calls[0]![1])).not.toContain(KEY);
    },
  );

  it.each([["--settings", '{"env":{"CUSTOM":"yes"}}'], ["--settings=/tmp/custom-settings.json"]])(
    "passes user settings through unchanged: %j",
    async (...args) => {
      const f = await fixture();
      expect(await f.run("claude", ["--model", "opus", ...args, "--continue"])).toBe(0);
      expect(f.spawn.mock.calls[0]![1]).toEqual([...args, "--continue"]);
      expect(f.stderr.at(-1)).toBe(
        "● Your --settings is passed as is; vAPI model settings were not added.",
      );
      expect(f.stderr.filter((line) => line.includes("settings"))).toHaveLength(1);
    },
  );
});

describe("vAPI Codex configuration", () => {
  it("passes complete overrides when install has not run and writes nothing", async () => {
    const f = await fixture();
    const before = await readdir(f.home);
    expect(await f.run("codex", ["resume", "--last"])).toBe(0);
    expect(f.spawn.mock.calls[0]![1]).toEqual([
      "-c",
      'model_providers.vapi.name="vAPI Router"',
      "-c",
      'model_providers.vapi.base_url="https://router.example/v1"',
      "-c",
      'model_providers.vapi.env_key="VAPI_ROUTER_KEY"',
      "-c",
      'model_providers.vapi.wire_api="responses"',
      "-c",
      'model_provider="vapi"',
      "-m",
      "venice/openai-gpt-61-sol",
      "resume",
      "--last",
    ]);
    expect(f.spawn.mock.calls[0]![2].env).toEqual({ ...f.env, VAPI_ROUTER_KEY: KEY });
    expect(await readdir(f.home)).toEqual(before);
    expect(f.stderr).toEqual([
      "● vAPI Compute — $7.40 left today (resets 00:00 UTC) · model openai-gpt-61-sol",
      "  Compute runs out mid-session? /quit, then: vapi codex resume --last",
    ]);
  });

  it.each([undefined, "sonnet", "provider/custom"])(
    "uses an installed profile and keeps Codex model %s unchanged",
    async (model) => {
      const f = await fixture();
      f.env.CODEX_HOME = join(f.home, "custom-codex");
      await mkdir(f.env.CODEX_HOME);
      await writeFile(
        codexConfigPath(f.env, f.home),
        '[model_providers.vapi]\nname = "vAPI Router"\n[profiles.vapi]\nmodel_provider = "vapi"\n',
      );
      expect(
        await f.run("codex", [
          ...(model === undefined ? [] : ["--model", model]),
          "resume",
          "--last",
        ]),
      ).toBe(0);
      expect(f.spawn.mock.calls[0]![1]).toEqual([
        "--profile",
        "vapi",
        ...(model === undefined ? [] : ["-m", model]),
        "resume",
        "--last",
      ]);
    },
  );

  it("does not translate Claude model shortcuts in the fallback overrides", async () => {
    const f = await fixture();
    expect(await f.run("codex", ["--model", "opus"])).toBe(0);
    expect(f.spawn.mock.calls[0]![1].slice(-2)).toEqual(["-m", "opus"]);
  });
});

describe("launcher error and process lifecycle", () => {
  it("exports both commands with direct UsageError rejection for --json", async () => {
    for (const command of [claudeCommand, codexCommand])
      await expect(
        command([], true, { stdout: () => {}, stderr: () => {} }, { env: {} }),
      ).rejects.toBeInstanceOf(UsageError);
  });

  it("returns 1 directly when a forced route cannot obtain credentials", async () => {
    const f = await fixture();
    f.readCredentials.mockRejectedValue(new RouterClientError("no_router_key", "key missing"));
    expect(await claudeCommand(["--vapi"], false, f.io, f.deps)).toBe(1);
    expect(f.stderr).toEqual(["no Router key, run vapi code install"]);
    expect(f.spawn).not.toHaveBeenCalled();
  });

  it.each([0, 3])("passes through child exit code %i", async (code) => {
    const f = await fixture();
    f.spawn.mockImplementationOnce(() => {
      queueMicrotask(() => f.child.emit("exit", code, null));
      return f.child;
    });
    expect(await f.run("claude", ["--own"])).toBe(code);
    expect(f.signals.eventNames()).toEqual([]);
  });

  it.each(["SIGINT", "SIGQUIT", "SIGTERM", "SIGHUP"] as const)(
    "maps child signal %s to its shell exit code",
    async (signal) => {
      const f = await fixture();
      f.spawn.mockImplementationOnce(() => {
        queueMicrotask(() => f.child.emit("exit", null, signal));
        return f.child;
      });
      expect(await f.run("claude", ["--own"])).toBe(128 + constants.signals[signal]);
      expect(f.signals.eventNames()).toEqual([]);
    },
  );

  it("ignores terminal interrupts, forwards termination, and preserves pre-existing listeners", async () => {
    const f = await fixture();
    const existing = vi.fn();
    f.signals.on("SIGINT", existing);
    f.spawn.mockImplementationOnce(() => f.child);
    const result = f.run("claude", ["--own"]);
    await vi.waitFor(() => expect(f.spawn).toHaveBeenCalledTimes(1));
    f.signals.emit("SIGINT");
    f.signals.emit("SIGQUIT");
    expect(f.child.kill).not.toHaveBeenCalled();
    f.signals.emit("SIGTERM");
    f.signals.emit("SIGHUP");
    expect(f.child.kill.mock.calls).toEqual([["SIGTERM"], ["SIGHUP"]]);
    f.child.emit("exit", 0, null);
    expect(await result).toBe(0);
    expect(f.signals.eventNames()).toEqual(["SIGINT"]);
    expect(f.signals.listeners("SIGINT")).toEqual([existing]);
  });

  it.each(["sync", "async"])(
    "reports a %s spawn error and cleans up signal listeners",
    async (mode) => {
      const f = await fixture();
      f.spawn.mockImplementationOnce(() => {
        const error = Object.assign(new Error("spawn claude EACCES"), { code: "EACCES" });
        if (mode === "sync") throw error;
        queueMicrotask(() => f.child.emit("error", error));
        return f.child;
      });
      expect(await f.run("claude", ["--own"])).toBe(127);
      expect(f.stderr).toEqual(["spawn claude EACCES"]);
      expect(f.signals.eventNames()).toEqual([]);
    },
  );

  it("cleans up partially registered parent signal handlers", async () => {
    const f = await fixture();
    f.deps.code!.processSignals = {
      on: (signal, listener) => {
        if (signal === "SIGQUIT") throw new Error("signal setup failed");
        return f.signals.on(signal, listener);
      },
      removeListener: (signal, listener) => f.signals.removeListener(signal, listener),
    };
    expect(await f.run("claude", ["--own"])).toBe(1);
    expect(f.spawn).not.toHaveBeenCalled();
    expect(f.signals.eventNames()).toEqual([]);
    expect(f.stderr).toEqual(["signal setup failed"]);
  });

  it("aborts the underlying Router request on timeout and handles late rejection", async () => {
    const f = await fixture();
    vi.useFakeTimers();
    f.deps.code!.usageTimeoutMs = 10;
    let signal: AbortSignal | undefined;
    let reached!: () => void;
    const ready = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let reject!: (error: Error) => void;
    const pending = new Promise<never>((_resolve, rejectPromise) => {
      reject = rejectPromise;
    });
    f.deps.fetchImpl = async (_url, init) => {
      signal = init?.signal ?? undefined;
      reached();
      return pending;
    };
    f.deps.router!.routerUsage = async (deps) => {
      await deps.fetchImpl!("https://fixture.example/usage");
      return usage;
    };
    const result = f.run("claude");
    await ready;
    await vi.advanceTimersByTimeAsync(10);
    expect(await result).toBe(0);
    expect(signal?.aborted).toBe(true);
    reject(new Error("late failure"));
    await Promise.resolve();
    expect(f.spawn).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps a Router error named used up distinct from a low Compute balance", async () => {
    const f = await fixture();
    f.readUsage.mockRejectedValue(new Error("used up"));
    expect(await f.run("claude")).toBe(0);
    expect(f.stderr).toEqual(["● vAPI unreachable (used up) → your own Claude subscription"]);
  });

  it.each(["credentials", "usage"] as const)(
    "keeps the forced route semantics when %s times out",
    async (stage) => {
      const f = await fixture();
      vi.useFakeTimers();
      f.deps.code!.usageTimeoutMs = 10;
      let reached!: () => void;
      const ready = new Promise<void>((resolve) => {
        reached = resolve;
      });
      const never = () => {
        reached();
        return new Promise<never>(() => {});
      };
      if (stage === "credentials") f.readCredentials.mockImplementation(never);
      else f.readUsage.mockImplementation(never);
      const result = f.run("claude", ["--vapi"]);
      await ready;
      await vi.advanceTimersByTimeAsync(10);
      expect(await result).toBe(stage === "credentials" ? 1 : 0);
      if (stage === "credentials") {
        expect(f.spawn).not.toHaveBeenCalled();
        expect(f.stderr).toEqual(["timed out"]);
      } else {
        expect(f.spawn.mock.calls[0]![2].env.ANTHROPIC_AUTH_TOKEN).toBe(KEY);
        expect(f.stderr[0]).toBe("● vAPI Compute · model claude-sonnet-5-5");
      }
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("treats invalid Router reset times as unavailable in automatic mode", async () => {
    const f = await fixture();
    f.readUsage.mockResolvedValue({ ...usage, compute: { ...usage.compute, resetsAt: "invalid" } });
    expect(await f.run("claude")).toBe(0);
    expect(f.spawn.mock.calls[0]![2].env).toBe(f.env);
    expect(f.stderr[0]).toContain("invalid Compute reset time");
  });

  it("redacts credentials and collapses multiline Router error messages", async () => {
    const f = await fixture();
    f.env.ANTHROPIC_API_KEY = "anthropic-parent-secret";
    f.readUsage.mockRejectedValue(new Error(`failed ${KEY}\n${f.env.ANTHROPIC_API_KEY}`));
    expect(await f.run("claude")).toBe(0);
    expect(f.stderr).toEqual([
      "● vAPI unreachable (failed [redacted] [redacted]) → your own Claude subscription",
    ]);
    expect(JSON.stringify(f.spawn.mock.calls[0]![1])).not.toContain(KEY);
  });

  it("shows combined funds only when --use-balance is supplied", async () => {
    const f = await fixture();
    f.readUsage.mockResolvedValue(usageWith(0.49, 2.01));
    expect(await f.run("claude", ["--use-balance"])).toBe(0);
    expect(f.stderr[0]).toBe(
      "● vAPI Compute — $2.50 left today (resets 00:00 UTC) · model claude-sonnet-5-5",
    );
  });
});
