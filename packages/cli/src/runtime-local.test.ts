import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  runLogPath,
  runResultPath,
  type Runtime,
  type RuntimeHandle,
  type RuntimeMember,
  type RuntimeRun,
} from "@vapi-network/mcp";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createLocalRuntime,
  parseRuntimeKind,
  resolveRuntime,
  runtimeForKind,
  type LocalRuntimeOptions,
} from "./runtime-local.js";

const RUN_ID = "run_111111111111111111111111";
const PARENT_RUN_ID = "run_222222222222222222222222";
const MEMBER: RuntimeMember = { account: "researcher", profile: "researcher" };
const STARTED_AT = "2026-09-30T10:00:00.000Z";
const homes: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

describe("local runtime start", () => {
  it.each([
    [undefined, []],
    ["0.25", ["--budget", "0.25"]],
  ] as const)("spawns an agent child with budget %s", async (budgetUsd, budgetArguments) => {
    const home = await temporaryHome();
    const unref = vi.fn();
    const spawn = vi.fn<NonNullable<LocalRuntimeOptions["spawn"]>>(() => ({
      pid: 4242,
      unref,
    }));
    const openLog = vi.fn(() => 71);
    const closeFd = vi.fn();
    const runtime = createLocalRuntime({
      home,
      entry: "/opt/vapi/cli.js",
      execPath: "/usr/bin/node",
      env: { BASE_ENV: "present" },
      spawn,
      openLog,
      closeFd,
      now: () => new Date(STARTED_AT),
    });
    const run: RuntimeRun = {
      runId: RUN_ID,
      task: "Research safely",
      mode: "agent",
      ...(budgetUsd === undefined ? {} : { budgetUsd }),
    };
    const persistLaunch = vi.fn(async (_handle: RuntimeHandle) => undefined);

    await expect(runtime.start(MEMBER, run, persistLaunch)).resolves.toEqual({
      runId: RUN_ID,
      kind: "local",
      member: MEMBER,
      startedAt: STARTED_AT,
      ref: "4242",
    });

    expect(openLog).toHaveBeenCalledWith(runLogPath(home, RUN_ID));
    expect(spawn).toHaveBeenCalledWith(
      "/usr/bin/node",
      [
        "/opt/vapi/cli.js",
        "agent",
        "run",
        "researcher",
        "Research safely",
        ...budgetArguments,
        "--json",
        "--result-file",
        runResultPath(home, RUN_ID),
      ],
      {
        detached: true,
        stdio: ["ignore", 71, 71],
        env: {
          BASE_ENV: "present",
          VAPI_HOME: home,
          VAPI_RUN_ID: RUN_ID,
        },
        windowsHide: true,
      },
    );
    expect(spawn.mock.calls[0]![1]).not.toContain("--detach");
    expect(persistLaunch).toHaveBeenCalledWith(
      expect.objectContaining({ runId: RUN_ID, ref: "4242" }),
    );
    expect(persistLaunch.mock.invocationCallOrder[0]).toBeLessThan(
      unref.mock.invocationCallOrder[0]!,
    );
    expect(unref).toHaveBeenCalledOnce();
    expect(closeFd).toHaveBeenCalledWith(71);
  });

  it("spawns a lead child with the swarm, lead, budgets, and parent run id", async () => {
    const home = await temporaryHome();
    const unref = vi.fn();
    const spawn = vi.fn<NonNullable<LocalRuntimeOptions["spawn"]>>(() => ({
      pid: 4343,
      unref,
    }));
    const runtime = createLocalRuntime({
      home,
      entry: "/opt/vapi/cli.js",
      execPath: "/usr/bin/node",
      env: {},
      spawn,
      openLog: () => 72,
      closeFd: vi.fn(),
    });
    const member: RuntimeMember = {
      swarm: "research-team",
      account: "research-team-lead-1",
      profile: "research-team-lead-1",
      role: "lead",
    };

    await runtime.start(member, {
      runId: RUN_ID,
      task: "Lead the research",
      mode: "lead",
      budgetUsd: "1.50",
      drawUsd: "2.00",
      parentRunId: PARENT_RUN_ID,
    });

    expect(spawn.mock.calls[0]![1]).toEqual([
      "/opt/vapi/cli.js",
      "swarm",
      "run",
      "research-team",
      "Lead the research",
      "--mode",
      "lead",
      "--lead",
      "research-team-lead-1",
      "--budget",
      "1.50",
      "--draw",
      "2.00",
      "--json",
      "--result-file",
      runResultPath(home, RUN_ID),
    ]);
    expect(spawn.mock.calls[0]![2].env).toEqual({
      VAPI_HOME: home,
      VAPI_RUN_ID: RUN_ID,
      VAPI_PARENT_RUN_ID: PARENT_RUN_ID,
    });
    expect(spawn.mock.calls[0]![1]).not.toContain("--detach");
    expect(unref).toHaveBeenCalledOnce();
  });

  it("tells an each-mode swarm member child which swarm it runs for", async () => {
    const home = await temporaryHome();
    const spawn = vi.fn<NonNullable<LocalRuntimeOptions["spawn"]>>(() => ({
      pid: 4444,
      unref: vi.fn(),
    }));
    const runtime = createLocalRuntime({
      home,
      entry: "/opt/vapi/cli.js",
      execPath: "/usr/bin/node",
      env: {},
      spawn,
      openLog: () => 73,
      closeFd: vi.fn(),
    });

    await runtime.start(
      {
        swarm: "research-team",
        account: "research-team-worker-1",
        profile: "research-team-worker-1",
      },
      {
        runId: RUN_ID,
        task: "improve accessibility of the docs",
        mode: "agent",
        budgetUsd: "0.40",
        parentRunId: PARENT_RUN_ID,
      },
    );

    expect(spawn.mock.calls[0]![1]).toEqual([
      "/opt/vapi/cli.js",
      "agent",
      "run",
      "research-team-worker-1",
      "improve accessibility of the docs",
      "--budget",
      "0.40",
      "--json",
      "--result-file",
      runResultPath(home, RUN_ID),
    ]);
    expect(spawn.mock.calls[0]![2].env).toEqual({
      VAPI_HOME: home,
      VAPI_RUN_ID: RUN_ID,
      VAPI_PARENT_RUN_ID: PARENT_RUN_ID,
      VAPI_SWARM: "research-team",
    });
  });

  it("never passes the parent shell's run variables to a child", async () => {
    const home = await temporaryHome();
    const spawn = vi.fn<NonNullable<LocalRuntimeOptions["spawn"]>>(() => ({
      pid: 4545,
      unref: vi.fn(),
    }));
    const runtime = createLocalRuntime({
      home,
      entry: "/opt/vapi/cli.js",
      execPath: "/usr/bin/node",
      env: {
        PATH: "/usr/bin",
        VAPI_SWARM: "other-team",
        VAPI_RUN_ID: "run_eeeeeeeeeeeeeeeeeeeeeeee",
        VAPI_PARENT_RUN_ID: "run_ffffffffffffffffffffffff",
      },
      spawn,
      openLog: () => 74,
      closeFd: vi.fn(),
    });

    await runtime.start(
      { account: "solo", profile: "solo" },
      { runId: RUN_ID, task: "Answer", mode: "agent" },
    );

    expect(spawn.mock.calls[0]![2].env).toEqual({
      PATH: "/usr/bin",
      VAPI_HOME: home,
      VAPI_RUN_ID: RUN_ID,
    });
  });

  it("refuses a detached task that the CLI parser would treat as an option", async () => {
    const home = await temporaryHome();
    const spawn = vi.fn<NonNullable<LocalRuntimeOptions["spawn"]>>(() => ({
      pid: 4242,
      unref: vi.fn(),
    }));
    const runtime = createLocalRuntime({
      home,
      entry: "/opt/vapi/cli.js",
      spawn,
    });

    await expect(
      runtime.start(MEMBER, { runId: RUN_ID, task: "--unsafe", mode: "agent" }),
    ).rejects.toThrow('A detached run task must not start with "--".');
    expect(spawn).not.toHaveBeenCalled();
  });
});

describe("local runtime status", () => {
  it.each([
    [
      "finished",
      { v: 1, exitCode: 0, result: { ok: true } },
      { state: "finished", exitCode: 0, result: { ok: true } },
    ],
    [
      "failed",
      { v: 1, exitCode: 1, error: { message: "child failed", code: "failed" } },
      { state: "failed", exitCode: 1, detail: "child failed" },
    ],
  ] as const)("reads a %s result envelope", async (_label, envelope, expected) => {
    const home = await temporaryHome();
    const kill = vi.fn();
    const runtime = createLocalRuntime({
      home,
      entry: "/opt/vapi/cli.js",
      kill,
      readFile: async () => JSON.stringify(envelope),
    });

    await expect(runtime.status(handle())).resolves.toEqual(expected);
    expect(kill).not.toHaveBeenCalled();
  });

  it("reports an unreadable result file as failed", async () => {
    const runtime = createLocalRuntime({
      home: await temporaryHome(),
      entry: "/opt/vapi/cli.js",
      readFile: async () => "not json",
    });

    await expect(runtime.status(handle())).resolves.toEqual({
      state: "failed",
      detail: "unreadable result file",
    });
  });

  it.each([
    ["alive", undefined, true, { state: "running" }],
    ["reused", undefined, false, { state: "unknown", detail: "exited without a result" }],
    ["gone", "ESRCH", true, { state: "unknown", detail: "exited without a result" }],
    ["not ours", "EPERM", true, { state: "unknown", detail: "process group is not accessible" }],
  ] as const)(
    "checks a missing result against an %s process group",
    async (_label, code, owned, expected) => {
      const home = await temporaryHome();
      const kill = vi.fn((_pid: number, _signal: NodeJS.Signals | 0) => {
        if (code !== undefined) throw Object.assign(new Error(code), { code });
      });
      const runtime = createLocalRuntime({
        home,
        entry: "/opt/vapi/cli.js",
        kill,
        processCommand: owned ? ownedCommand(home) : () => "/bin/zsh -l",
        readFile: async () => {
          throw Object.assign(new Error("missing"), { code: "ENOENT" });
        },
      });

      await expect(runtime.status(handle())).resolves.toEqual(expected);
      expect(kill).toHaveBeenCalledWith(-4242, 0);
    },
  );
});

describe("local runtime stop and selection", () => {
  it("signals only the detached process group", async () => {
    const home = await temporaryHome();
    const kill = vi.fn();
    const processCommand = vi.fn(ownedCommand(home));
    const runtime = createLocalRuntime({
      home,
      entry: "/opt/vapi/cli.js",
      kill,
      processCommand,
    });

    await runtime.stop(handle());
    expect(processCommand).toHaveBeenCalledWith(4242);
    expect(kill).toHaveBeenCalledWith(-4242, "SIGTERM");
  });

  it.each<[string, NonNullable<LocalRuntimeOptions["processCommand"]>]>([
    ["a process the OS reused the pid for", () => "/bin/zsh -l"],
    ["no process at all", () => undefined],
  ])("never signals %s", async (_label, processCommand) => {
    const kill = vi.fn();
    const runtime = createLocalRuntime({
      home: await temporaryHome(),
      entry: "/opt/vapi/cli.js",
      kill,
      processCommand,
    });

    await expect(runtime.stop(handle())).resolves.toBeUndefined();
    expect(kill).not.toHaveBeenCalled();
  });

  it("ignores a process group that exited before SIGTERM", async () => {
    const home = await temporaryHome();
    const kill = vi.fn(() => {
      throw Object.assign(new Error("gone"), { code: "ESRCH" });
    });
    const runtime = createLocalRuntime({
      home,
      entry: "/opt/vapi/cli.js",
      kill,
      processCommand: ownedCommand(home),
    });

    await expect(runtime.stop(handle())).resolves.toBeUndefined();
    expect(kill).toHaveBeenCalledWith(-4242, "SIGTERM");
  });

  it.each(["0", "1", "-5", "abc"])("refuses invalid process ref %s", async (ref) => {
    const kill = vi.fn();
    const runtime = createLocalRuntime({
      home: await temporaryHome(),
      entry: "/opt/vapi/cli.js",
      kill,
    });

    await expect(runtime.stop(handle(ref))).rejects.toThrow("Invalid local runtime process id.");
    expect(kill).not.toHaveBeenCalled();
  });

  it("builds the railway runtime without running anything", async () => {
    const exec = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));
    const runtime = runtimeForKind("railway", { home: "/tmp/vapi-test", railway: { exec } });
    expect(runtime.kind).toBe("railway");
    expect(exec).not.toHaveBeenCalled();
  });

  it("parses runtime kinds and defaults to local", () => {
    expect(parseRuntimeKind(undefined)).toBe("local");
    expect(parseRuntimeKind("local")).toBe("local");
    expect(parseRuntimeKind("railway")).toBe("railway");
    expect(() => parseRuntimeKind("container")).toThrow("--runtime must be local or railway.");
  });

  it("uses the CLI runtime injection seam", () => {
    const injected: Runtime = {
      kind: "railway",
      start: async () => {
        throw new Error("not called");
      },
      stop: async () => undefined,
      status: async () => ({ state: "unknown" }),
    };
    const runtime = vi.fn(() => injected);

    expect(resolveRuntime("railway", "/vapi/home", { runtime })).toBe(injected);
    expect(runtime).toHaveBeenCalledWith("railway", "/vapi/home");
  });
});

it.skipIf(process.env.VAPI_RUNTIME_SMOKE !== "1")(
  "spawns a real detached child and observes its result",
  async () => {
    const home = await temporaryHome();
    const entry = join(home, "runtime-smoke.mjs");
    await writeFile(
      entry,
      [
        'import { writeFileSync } from "node:fs";',
        'const index = process.argv.indexOf("--result-file");',
        "writeFileSync(process.argv[index + 1], JSON.stringify({ v: 1, exitCode: 0, result: { ok: true } }));",
      ].join("\n"),
      "utf8",
    );
    const runtime = createLocalRuntime({ home, entry, env: {} });
    const started = await runtime.start(MEMBER, {
      runId: RUN_ID,
      task: "smoke",
      mode: "agent",
    });

    let status = await runtime.status(started);
    const deadline = Date.now() + 5_000;
    while (status.state !== "finished" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      status = await runtime.status(started);
    }
    expect(status).toEqual({ state: "finished", exitCode: 0, result: { ok: true } });
  },
);

it.skipIf(process.env.VAPI_RUNTIME_SMOKE !== "1")(
  "recognises and stops a real detached child it started",
  async () => {
    const home = await temporaryHome();
    const entry = join(home, "runtime-smoke-sleep.mjs");
    await writeFile(entry, "setTimeout(() => undefined, 10_000);\n", "utf8");
    const runtime = createLocalRuntime({ home, entry, env: {} });
    const started = await runtime.start(MEMBER, {
      runId: RUN_ID,
      task: "sleep",
      mode: "agent",
    });

    await expect(runtime.status(started)).resolves.toEqual({ state: "running" });
    await runtime.stop(started);
    let status = await runtime.status(started);
    const deadline = Date.now() + 5_000;
    while (status.state === "running" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      status = await runtime.status(started);
    }
    expect(status.state).toBe("unknown");
  },
);

async function temporaryHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "vapi-runtime-local-"));
  homes.push(home);
  return home;
}

function ownedCommand(home: string): (pid: number) => string {
  return () =>
    `/usr/bin/node /opt/vapi/cli.js agent run researcher task --json --result-file ${runResultPath(home, RUN_ID)}`;
}

function handle(ref = "4242"): RuntimeHandle {
  return {
    runId: RUN_ID,
    kind: "local",
    member: MEMBER,
    startedAt: STARTED_AT,
    ref,
  };
}
