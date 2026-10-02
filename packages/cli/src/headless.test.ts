import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BASE_MAINNET_CAIP2,
  configSchema,
  getDefaultConfig,
  NETWORKS,
  readAgentProfile,
  type AgentProfile,
  type SecretStore,
  type VapiConfig,
} from "@vapi-network/core";
import {
  createMemberBundle,
  memberBundleConfig,
  type MemberBundle,
} from "@vapi-network/core/secrets";
import type { RunAgentDeps, RunAgentResult, runAgent } from "@vapi-network/mcp";
import { privateKeyToAccount } from "viem/accounts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { runCli, type CliDependencies, type CliIo } from "./cli.js";
import { createHeadlessHome } from "./headless.js";

const PRIVATE_KEY = "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" as const;
const ADDRESS = privateKeyToAccount(PRIVATE_KEY).address;
const OWNER = "0x1111111111111111111111111111111111111111" as const;
const RUN_ID = "run_0123456789abcdef01234567";
const PARENT_RUN_ID = "run_89abcdef0123456789abcdef";
const LINKED_AT = "2026-09-28T12:00:00.000Z";
const ACCESS_TOKEN = "alpha-access-token-7f3a";
const REFRESH_TOKEN = "alpha-refresh-token-7f3a";
const TOKENS = JSON.stringify({
  accessToken: ACCESS_TOKEN,
  expiresAt: 4_102_444_800_000,
  scopes: ["mcp:call", "router.use"],
  refreshable: false,
});
const ROUTER_STAKE = "alpha-router-stake-key-91c";
const VARIABLE = "VAPI_MEMBER_BUNDLE";
const TASK = "Find the cheapest weather listing";

const originalHome = process.env.VAPI_HOME;
const directories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  if (originalHome === undefined) delete process.env.VAPI_HOME;
  else process.env.VAPI_HOME = originalHome;
  delete process.env[VARIABLE];
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("vapi agent run --bundle-env", () => {
  it("runs the loop in an ephemeral 0700 home and removes it afterwards", async () => {
    const outer = await temporaryDirectory();
    process.env.VAPI_HOME = outer;
    const text = bundleText(["read", "delegate", "allocate"]);
    process.env[VARIABLE] = text;
    const resultFile = join(outer, "result.json");
    let seenHome: string | undefined;
    let seenDeps: RunAgentDeps | undefined;
    const execute = vi.fn<typeof runAgent>(async (_task, deps) => {
      seenDeps = deps;
      seenHome = deps.home;
      expect(process.env.VAPI_HOME).toBe(deps.home);
      expect((await stat(deps.home)).mode & 0o777).toBe(0o700);
      expect((await readdir(deps.home)).sort()).toEqual(
        expect.arrayContaining(["agents", "config.json", "vault.json", "wallets.json"]),
      );
      const wallets = JSON.parse(await readFile(join(deps.home, "wallets.json"), "utf8")) as {
        default: string;
        wallets: Record<string, Record<string, unknown>>;
      };
      expect(wallets.default).toBe("alpha");
      expect(wallets.wallets.alpha).toMatchObject({
        spendCaps: { perCallAtomic: "100000", perDayAtomic: "1000000" },
        ceilingAtomic: null,
        link: { owner: OWNER, clientId: "client-alpha" },
      });
      expect((await stat(join(deps.home, "config.json"))).mode & 0o777).toBe(0o600);
      expect((await readAgentProfile(deps.home, "alpha")).grants).toEqual(["read"]);
      const vault = await readFile(join(deps.home, "vault.json"), "utf8");
      expect(vault).not.toContain(PRIVATE_KEY.slice(2));
      return result(`Done. ${PRIVATE_KEY} ${ACCESS_TOKEN} ${ROUTER_STAKE}`);
    });
    const secretStore = throwingSecretStore();
    const env: NodeJS.ProcessEnv = { [VARIABLE]: text };
    const captured = captureIo();

    expect(
      await runCli(
        ["agent", "run", "--bundle-env", VARIABLE, TASK, "--result-file", resultFile, "--json"],
        captured.io,
        dependencies({ env, secretStore, agent: { runAgent: execute } }),
      ),
    ).toBe(0);

    expect(execute).toHaveBeenCalledWith(TASK, expect.anything());
    expect(seenDeps?.profile.grants).toEqual(["read"]);
    expect(seenDeps?.runId).toBe(RUN_ID);
    expect(seenDeps?.runMeta).toEqual({
      swarm: "crew",
      member: "alpha",
      parentRunId: PARENT_RUN_ID,
    });
    expect(seenHome).toBeDefined();
    await expect(stat(seenHome!)).rejects.toMatchObject({ code: "ENOENT" });
    expect(process.env.VAPI_HOME).toBe(outer);
    expect(env[VARIABLE]).toBeUndefined();
    expect(process.env[VARIABLE]).toBeUndefined();
    for (const method of ["get", "has", "set", "remove"] as const) {
      expect(secretStore[method]).not.toHaveBeenCalled();
    }

    const printed = JSON.parse(onlyStdout(captured)) as RunAgentResult;
    expect(printed.answer).toContain("Done.");
    const envelope = JSON.parse(await readFile(resultFile, "utf8")) as Record<string, unknown>;
    expect(envelope).toEqual({ v: 1, exitCode: 0, result: printed });
    expect((await stat(resultFile)).mode & 0o777).toBe(0o600);
    expectNoSecrets(`${allOutput(captured)}\n${JSON.stringify(envelope)}`, text);
  });

  it("prints the answer as text without a result file", async () => {
    const outer = await temporaryDirectory();
    process.env.VAPI_HOME = outer;
    const text = bundleText();
    const captured = captureIo();

    expect(
      await runCli(
        ["agent", "run", "--bundle-env", VARIABLE, TASK],
        captured.io,
        dependencies({
          env: { [VARIABLE]: text },
          agent: { runAgent: async () => result("Plain answer.") },
        }),
      ),
    ).toBe(0);
    expect(captured.stdout).toEqual(["Plain answer."]);
    expect(process.env.VAPI_HOME).toBe(outer);
  });

  it("refuses a payment after a 23:59 launch allowance expires at UTC midnight", async () => {
    const outer = await temporaryDirectory();
    process.env.VAPI_HOME = outer;
    const allowanceExpiresAt = "2026-10-01T00:00:00.000Z";
    const text = Buffer.from(
      JSON.stringify({ ...bundleInput(["read"]), v: 1, allowanceExpiresAt }),
      "utf8",
    ).toString("base64url");
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      throw new Error("A remote payment must be refused before network I/O.");
    });
    const execute = vi.fn<typeof runAgent>(async (_task, deps) => {
      await expect(deps.pay({ ref: "weather", maxPriceUsd: 0.01 })).rejects.toThrow(
        `Remote allowance expired at ${allowanceExpiresAt}`,
      );
      return result("Expired allowance was refused.");
    });

    expect(
      await runCli(
        ["agent", "run", "--bundle-env", VARIABLE, TASK],
        captureIo().io,
        dependencies({
          env: { [VARIABLE]: text },
          now: () => new Date("2026-10-01T00:00:01.000Z"),
          fetchImpl,
          agent: { runAgent: execute },
        }),
      ),
    ).toBe(0);
    expect(execute).toHaveBeenCalledOnce();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("decodes a --task-base64url task, shell characters and all, as one task", async () => {
    const outer = await temporaryDirectory();
    process.env.VAPI_HOME = outer;
    const task = 'Compare "two" APIs; echo $(id) $VAPI_MEMBER_BUNDLE';
    const execute = vi.fn<typeof runAgent>(async () => result("Decoded."));

    expect(
      await runCli(
        [
          "agent",
          "run",
          "--bundle-env",
          VARIABLE,
          "--task-base64url",
          Buffer.from(task, "utf8").toString("base64url"),
        ],
        captureIo().io,
        dependencies({ env: { [VARIABLE]: bundleText() }, agent: { runAgent: execute } }),
      ),
    ).toBe(0);
    expect(execute).toHaveBeenCalledWith(task, expect.anything());

    const captured = captureIo();
    expect(
      await runCli(
        ["agent", "run", "alpha", "--task-base64url", "QQ"],
        captured.io,
        dependencies({ env: {} }),
      ),
    ).toBe(2);
    expect(captured.stderr.join("\n")).toContain("--task-base64url needs --bundle-env");
  });

  it("removes the home and writes an error envelope when the loop throws", async () => {
    const outer = await temporaryDirectory();
    process.env.VAPI_HOME = outer;
    const text = bundleText();
    const resultFile = join(outer, "failed.json");
    let seenHome: string | undefined;
    const execute = vi.fn<typeof runAgent>(async (_task, deps) => {
      seenHome = deps.home;
      throw new Error(`Model exploded near ${PRIVATE_KEY} with ${ACCESS_TOKEN}`);
    });
    const captured = captureIo();

    expect(
      await runCli(
        ["agent", "run", "--bundle-env", VARIABLE, TASK, "--result-file", resultFile],
        captured.io,
        dependencies({ env: { [VARIABLE]: text }, agent: { runAgent: execute } }),
      ),
    ).toBe(1);

    expect(seenHome).toBeDefined();
    await expect(stat(seenHome!)).rejects.toMatchObject({ code: "ENOENT" });
    expect(process.env.VAPI_HOME).toBe(outer);
    const envelope = JSON.parse(await readFile(resultFile, "utf8")) as {
      v: number;
      exitCode: number;
      error: { message: string };
    };
    expect(envelope).toMatchObject({ v: 1, exitCode: 1 });
    expect(envelope.error.message).toContain("Model exploded");
    expect((await stat(resultFile)).mode & 0o777).toBe(0o600);
    expect(captured.stderr).toHaveLength(1);
    expectNoSecrets(`${allOutput(captured)}\n${JSON.stringify(envelope)}`, text);
  });

  it("cleans the home synchronously on SIGTERM and drops the handler afterwards", async () => {
    const outer = await temporaryDirectory();
    process.env.VAPI_HOME = outer;
    const before = process.listeners("SIGTERM");
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    let seenHome: string | undefined;
    const execute = vi.fn<typeof runAgent>(async (_task, deps) => {
      seenHome = deps.home;
      const added = process.listeners("SIGTERM").filter((listener) => !before.includes(listener));
      expect(added).toHaveLength(1);
      added[0]!("SIGTERM");
      expect(exit).toHaveBeenCalledWith(143);
      await expect(stat(deps.home)).rejects.toMatchObject({ code: "ENOENT" });
      return result("Stopped.");
    });

    await runCli(
      ["agent", "run", "--bundle-env", VARIABLE, TASK],
      captureIo().io,
      dependencies({ env: { [VARIABLE]: bundleText() }, agent: { runAgent: execute } }),
    );

    expect(seenHome).toBeDefined();
    expect(process.listeners("SIGTERM")).toEqual(before);
  });

  it.each([
    [[TASK], {}, `The environment variable ${VARIABLE} is not set.`],
    [[TASK, "--detach"], { [VARIABLE]: "x" }, "--bundle-env cannot be used with --detach"],
    [
      [TASK, "--runtime", "local"],
      { [VARIABLE]: "x" },
      "--bundle-env cannot be used with --detach or --runtime",
    ],
    [["alpha", TASK], { [VARIABLE]: "x" }, "--bundle-env takes exactly one task"],
    [
      [TASK, "--task-base64url", Buffer.from(TASK).toString("base64url")],
      { [VARIABLE]: "x" },
      "--bundle-env takes exactly one task",
    ],
    [["--task-base64url", "not base64!"], { [VARIABLE]: "x" }, "must be a base64url-encoded task"],
    [["--task-base64url", "IA"], { [VARIABLE]: "x" }, "must be a base64url-encoded task"],
  ] as const)("returns a usage error for %j", async (rest, env, message) => {
    const execute = vi.fn<typeof runAgent>();
    const captured = captureIo();

    expect(
      await runCli(
        ["agent", "run", "--bundle-env", VARIABLE, ...rest],
        captured.io,
        dependencies({ env: { ...env }, agent: { runAgent: execute } }),
      ),
    ).toBe(2);
    expect(captured.stderr.join("\n")).toContain(message);
    expect(execute).not.toHaveBeenCalled();
  });

  it("refuses an invalid variable name", async () => {
    const captured = captureIo();
    expect(
      await runCli(
        ["agent", "run", "--bundle-env", "lower-case", TASK],
        captured.io,
        dependencies({ env: {} }),
      ),
    ).toBe(2);
    expect(captured.stderr.join("\n")).toContain("--bundle-env must name an environment variable");
  });

  it("exits 1 without the bundle text for a tampered bundle", async () => {
    const text = `${bundleText()}AAAA!`;
    const captured = captureIo();

    expect(
      await runCli(
        ["agent", "run", "--bundle-env", VARIABLE, TASK],
        captured.io,
        dependencies({ env: { [VARIABLE]: text } }),
      ),
    ).toBe(1);
    expect(captured.stderr).toEqual(["The member bundle is not base64url text."]);
  });
});

describe("createHeadlessHome", () => {
  it("filters delegate and allocate again even from a hand-built bundle", async () => {
    const parent = await temporaryDirectory();
    const bundle: MemberBundle = {
      ...bundleInput(),
      v: 1,
      profile: profile(["read", "delegate", "allocate"]),
    };

    const created = await createHeadlessHome(bundle, { tmpdir: parent });
    try {
      expect((await readAgentProfile(created.home, "alpha")).grants).toEqual(["read"]);
      expect(await created.secrets.get("vapi.agent.alpha.tokens")).toBe(TOKENS);
      expect(await created.secrets.get("vapi.agent.alpha.router.stake")).toBe(ROUTER_STAKE);
      expect(await created.secrets.has("vault-key")).toBe(true);
    } finally {
      await created.cleanup();
    }
    expect(await readdir(parent)).toEqual([]);
  });

  it("writes config.json on the public RPC defaults from the bundle's network ids", async () => {
    const parent = await temporaryDirectory();
    const bundle: MemberBundle = {
      ...bundleInput(),
      v: 1,
      config: {
        discoveryUrl: "https://api.vapinetwork.ai/api/call/services",
        marketplaceDiscoveryUrl: "https://api.vapinetwork.ai/api/call/discovery",
        networks: { [BASE_MAINNET_CAIP2]: { usdc: NETWORKS[BASE_MAINNET_CAIP2].usdc } },
      },
    };

    const created = await createHeadlessHome(bundle, { tmpdir: parent });
    try {
      const written = JSON.parse(
        await readFile(join(created.home, "config.json"), "utf8"),
      ) as VapiConfig;
      expect(configSchema.parse(written)).toBeDefined();
      expect(written.networks[BASE_MAINNET_CAIP2]).toEqual({
        rpcUrl: "https://mainnet.base.org",
        usdc: NETWORKS[BASE_MAINNET_CAIP2].usdc,
      });
      expect(written.discoveryUrl).toBe("https://api.vapinetwork.ai/api/call/services");
    } finally {
      await created.cleanup();
    }
  });

  it("removes the home when the key does not match the address", async () => {
    const parent = await temporaryDirectory();
    const bundle: MemberBundle = {
      ...bundleInput(),
      v: 1,
      address: "0x2222222222222222222222222222222222222222",
    };

    await expect(createHeadlessHome(bundle, { tmpdir: parent })).rejects.toThrow(
      "The member bundle's key does not match its address.",
    );
    expect(await readdir(parent)).toEqual([]);
  });
});

function profile(grants: AgentProfile["grants"] = ["read"]): AgentProfile {
  return {
    version: 1,
    name: "alpha",
    wallet: "alpha",
    model: "router/test",
    instructions: "Find the cheapest weather listing and report it.",
    verifiedOnly: true,
    approveAboveUsd: 0.5,
    maxSteps: 12,
    tools: ["call.search", "call.inspect", "call.pay"],
    grants,
    paused: false,
    createdAt: LINKED_AT,
  };
}

function bundleInput(grants: AgentProfile["grants"] = ["read"]): Omit<MemberBundle, "v"> {
  return {
    account: "alpha",
    address: ADDRESS,
    privateKey: PRIVATE_KEY,
    swarm: "crew",
    profile: profile(grants),
    link: {
      apiBase: "https://api.vapinetwork.ai",
      clientId: "client-alpha",
      owner: OWNER,
      label: "alpha",
      scopes: ["mcp:call", "router.use"],
      linkedAt: LINKED_AT,
    },
    credentials: { tokens: TOKENS, routerStake: ROUTER_STAKE },
    caps: { perCallAtomic: "100000", perDayAtomic: "1000000" },
    allowanceExpiresAt: "2026-09-29T00:00:00.000Z",
    ceilingAtomic: "2000000",
    config: memberBundleConfig(getDefaultConfig({}), BASE_MAINNET_CAIP2),
    runId: RUN_ID,
    parentRunId: PARENT_RUN_ID,
  };
}

function bundleText(grants: AgentProfile["grants"] = ["read"]): string {
  return createMemberBundle(bundleInput(grants));
}

function result(answer: string): RunAgentResult {
  return {
    runId: RUN_ID,
    answer,
    stoppedBecause: { type: "stopped", reason: "finished" },
    paidUsd: 0,
    steps: 1,
  };
}

function dependencies(overrides: Partial<CliDependencies> = {}): CliDependencies {
  return {
    interactive: false,
    env: {},
    secretStore: throwingSecretStore(),
    fetchImpl: (async () => {
      throw new Error("No live network in tests.");
    }) as typeof fetch,
    now: () => new Date(LINKED_AT),
    ...overrides,
  };
}

/** An OS store stand-in that fails every call: a headless run must never reach it. */
function throwingSecretStore(): SecretStore & {
  get: ReturnType<typeof vi.fn>;
  has: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
} {
  const refuse = () => {
    throw new Error("The OS secret store must not be used by a headless run.");
  };
  return {
    available: true,
    platform: "darwin",
    description: "the macOS Keychain",
    get: vi.fn(refuse),
    has: vi.fn(refuse),
    set: vi.fn(refuse),
    remove: vi.fn(refuse),
  };
}

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "vapi-headless-test-"));
  directories.push(path);
  return path;
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

function onlyStdout(captured: { stdout: string[] }): string {
  expect(captured.stdout).toHaveLength(1);
  return captured.stdout[0]!;
}

function allOutput(captured: { stdout: string[]; stderr: string[] }): string {
  return [...captured.stdout, ...captured.stderr].join("\n");
}

function expectNoSecrets(text: string, bundle: string): void {
  for (const secret of [
    bundle,
    PRIVATE_KEY,
    PRIVATE_KEY.slice(2),
    ACCESS_TOKEN,
    REFRESH_TOKEN,
    ROUTER_STAKE,
  ]) {
    expect(text).not.toContain(secret);
  }
}
