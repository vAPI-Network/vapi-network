import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  getVapiPaths,
  readAgentProfile,
  type AgentProfile,
  type ChatResult,
  type SecretStore,
  WalletStore,
  writeAgentProfile,
} from "@vapi-network/core";
import {
  AGENT_LINK_REVOKED_MESSAGE,
  AgentLinkError,
  type DeviceLinkStart,
  type LinkResult,
  type forgetAgentLink,
  type pollDeviceLink,
  type startDeviceLink,
} from "@vapi-network/core/agent-link";
import {
  RouterClientError,
  type AgentRouterUsage,
  type RouterClientDeps,
} from "@vapi-network/core/router-client";
import { type RunAgentDeps, type createAgentRunDeps, type getWallet } from "@vapi-network/mcp";
import { afterEach, describe, expect, it, vi } from "vitest";

import { runCli, type CliDependencies, type CliIo } from "./cli.js";

const PASSPHRASE = "passphrase-that-must-stay-secret";
const ACCESS_TOKEN = "token-that-must-stay-secret";
const ROUTER_KEY = "router-key-that-must-stay-secret";
const OWNER = "0x1111111111111111111111111111111111111111" as const;
const START: DeviceLinkStart = {
  clientId: "agent_researcher",
  deviceCode: "device-code-that-must-stay-secret",
  userCode: "BCDF-GHJK",
  verificationUri: "https://api.vapinetwork.ai/link",
  verificationUriComplete: "https://api.vapinetwork.ai/link?code=BCDF-GHJK",
  expiresIn: 600,
  interval: 5,
};
const LINK_RESULT: LinkResult = {
  tokens: {
    accessToken: ACCESS_TOKEN,
    refreshToken: "refresh-token-that-must-stay-secret",
    expiresAt: Date.now() + 60 * 60 * 1_000,
    scopes: ["mcp:call", "router.use"],
  },
  owner: OWNER,
  routerKey: ROUTER_KEY,
  routerBaseUrl: "https://router.vapinetwork.ai",
};

const originalHome = process.env.VAPI_HOME;
const originalPassword = process.env.VAPI_KEYSTORE_PASSWORD;
const homes: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  restoreEnvironment("VAPI_HOME", originalHome);
  restoreEnvironment("VAPI_KEYSTORE_PASSWORD", originalPassword);
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

describe("vapi agent create", () => {
  it("creates wallets, applies default and requested caps, and suggests Router allowances", async () => {
    const home = await temporaryHome();
    const instructions = join(home, "instructions.md");
    await writeFile(instructions, "Research carefully.\n", "utf8");
    const start = vi.fn<typeof startDeviceLink>(async () => START);
    const poll = vi.fn<typeof pollDeviceLink>(async () => LINK_RESULT);
    const dependencies = createDependencies({
      interactive: true,
      agentLink: { startDeviceLink: start, pollDeviceLink: poll },
    });

    const defaults = captureIo();
    expect(
      await runCli(
        [
          "agent",
          "create",
          "researcher",
          "--model",
          "router/test",
          "--instructions",
          instructions,
          "--json",
        ],
        defaults.io,
        dependencies,
      ),
    ).toBe(0);
    const defaultResult = JSON.parse(onlyStdout(defaults)) as Record<string, unknown>;
    expect(defaultResult).toMatchObject({
      name: "researcher",
      wallet: "researcher",
      address: expect.stringMatching(/^0x[0-9a-fA-F]{40}$/u),
      model: "router/test",
      spendCaps: { perCallAtomic: "50000", perDayAtomic: "1000000" },
      routerAllowanceUsd: 1,
    });
    expect(defaultResult.fundingHint).toBe(
      `Fund it: send a few USDC on Base to ${String(defaultResult.address)} (vapi fund --wallet researcher)`,
    );
    expect(start.mock.calls[0]![0]).toMatchObject({
      label: "researcher",
      routerAllowanceUsd: 1,
    });

    const custom = captureIo();
    expect(
      await runCli(
        [
          "agent",
          "create",
          "analyst",
          "--model",
          "router/test",
          "--instructions",
          instructions,
          "--call-budget",
          "2.5/day",
          "--max-per-call",
          "0.125",
          "--router-budget",
          "3.25/day",
          "--approve-above",
          "0.75",
          "--include-unverified",
          "--max-steps",
          "20",
          "--json",
        ],
        custom.io,
        dependencies,
      ),
    ).toBe(0);
    expect(JSON.parse(onlyStdout(custom))).toMatchObject({
      name: "analyst",
      spendCaps: { perCallAtomic: "125000", perDayAtomic: "2500000" },
      routerAllowanceUsd: 3.25,
    });
    expect(start.mock.calls[1]![0]).toMatchObject({ label: "analyst", routerAllowanceUsd: 3.25 });
    const profile = await readAgentProfile(home, "analyst");
    expect(profile).toMatchObject({
      verifiedOnly: false,
      approveAboveUsd: 0.75,
      maxSteps: 20,
      instructions: "Research carefully.\n",
    });
    const store = await WalletStore.open(home);
    expect(store.entry("researcher")?.spendCaps).toEqual({
      perCallAtomic: "50000",
      perDayAtomic: "1000000",
    });
    expect(store.entry("analyst")?.spendCaps).toEqual({
      perCallAtomic: "125000",
      perDayAtomic: "2500000",
    });
    const audit = await readFile(join(home, "audit.log"), "utf8");
    expect(audit.match(/"event":"wallet\.caps"/gu)).toHaveLength(2);
    expect(noSecrets(allOutput(defaults))).toBe(true);
    expect(noSecrets(allOutput(custom))).toBe(true);
  });

  it("refuses to replace an existing profile", async () => {
    const home = await temporaryHome();
    const instructions = join(home, "instructions.md");
    await writeFile(instructions, "Research carefully.\n", "utf8");
    await writeAgentProfile(home, profile());
    const start = vi.fn<typeof startDeviceLink>(async () => START);
    const captured = captureIo();

    expect(
      await runCli(
        [
          "agent",
          "create",
          "researcher",
          "--model",
          "router/test",
          "--instructions",
          instructions,
          "--json",
        ],
        captured.io,
        createDependencies({
          agentLink: { startDeviceLink: start, pollDeviceLink: async () => LINK_RESULT },
        }),
      ),
    ).toBe(1);
    expect(JSON.parse(onlyStdout(captured))).toEqual({
      error: "Agent researcher already exists.",
      exitCode: 1,
    });
    expect(start).not.toHaveBeenCalled();
    expect((await WalletStore.open(home)).has("researcher")).toBe(false);
  });
});

describe("vapi agent run", () => {
  it("resolves auto-refill caps again when the purchase is attempted", async () => {
    const home = await homeWithAgent();
    const store = await WalletStore.open(home);
    await store.setRouterRefill("researcher", { belowUsd: 0.5, tierUsd: 1 });
    const routerChat = vi.fn(async (deps: RouterClientDeps) => {
      const writer = await WalletStore.open(home);
      await writer.setSpendCaps("researcher", { perCallAtomic: "0", perDayAtomic: "0" });
      const caps =
        typeof deps.refill?.caps === "function" ? await deps.refill.caps() : deps.refill?.caps;
      expect(caps).toEqual({ perCallAtomic: "0", perDayAtomic: "0" });
      return textReply("Caps reloaded.");
    });
    const captured = captureIo();

    expect(
      await runCli(["agent", "run", "researcher", "Check caps"], captured.io, {
        ...createDependencies(),
        router: { routerChat },
      }),
    ).toBe(0);
    expect(captured.stdout.at(-1)).toBe("Caps reloaded.");
  });

  it("never asks on a non-TTY and declines a scripted above-threshold payment", async () => {
    const home = await homeWithAgent();
    const line = vi.fn(async () => "yes");
    const readStdin = vi.fn(async () => "yes");
    const pay = vi.fn<RunAgentDeps["pay"]>(async () => ({
      ok: true,
      status: 200,
      body: { report: true },
      amountUsd: 0.8,
      network: "eip155:8453",
    }));
    const scripted = scriptedChat();
    const routerChat = vi.fn(async (_deps: RouterClientDeps) => scripted.shift()!);
    const createDeps = vi.fn<typeof createAgentRunDeps>((input) => ({
      profile: input.profile,
      config: input.config,
      home: input.home,
      chat: input.chat,
      search: vi
        .fn()
        .mockResolvedValue([
          { ref: "report", name: "DEX report", priceUsd: 0.8, verification: "verified" },
        ]),
      inspect: vi.fn().mockResolvedValue(inspected("$0.80")),
      pay,
      caps: { perCallUsd: 1 },
      approve: input.approve,
      ...(input.onEvent === undefined ? {} : { onEvent: input.onEvent }),
      ...(input.tty === undefined ? {} : { tty: input.tty }),
    }));
    const captured = captureIo();

    expect(
      await runCli(["agent", "run", "researcher", "Find the DEX report"], captured.io, {
        ...createDependencies(),
        interactive: false,
        prompts: { secret: async () => PASSPHRASE, line },
        readStdin,
        router: { routerChat },
        agent: { createAgentRunDeps: createDeps },
      }),
    ).toBe(0);

    expect(line).not.toHaveBeenCalled();
    expect(readStdin).not.toHaveBeenCalled();
    expect(pay).not.toHaveBeenCalled();
    expect(captured.stdout).toContain('→ search "base dex volume"');
    expect(captured.stdout.join("\n")).toContain("✗ declined report: Payment was not approved:");
    expect(captured.stdout.at(-1)).toBe("Declined.");
    expect(await readAgentProfile(home, "researcher")).toMatchObject({ paused: false });
  });

  it("exits 1 with the exact paused message before unlocking", async () => {
    const home = await homeWithAgent({ paused: true });
    delete process.env.VAPI_KEYSTORE_PASSWORD;
    const secret = vi.fn(async () => PASSPHRASE);
    const captured = captureIo();

    expect(
      await runCli(["agent", "run", "researcher", "Do work"], captured.io, {
        ...createDependencies(),
        interactive: true,
        prompts: { secret },
      }),
    ).toBe(1);
    expect(captured.stdout).toEqual([]);
    expect(captured.stderr).toEqual([
      "Agent researcher is paused. Run vapi agent resume researcher.",
    ]);
    expect(secret).not.toHaveBeenCalled();
    expect(await readAgentProfile(home, "researcher")).toMatchObject({ paused: true });
  });

  it("exits 1 with the revoked-link sentence when Router access is rejected", async () => {
    await homeWithAgent();
    const routerChat = vi.fn(async () => {
      throw new RouterClientError("not_linked", AGENT_LINK_REVOKED_MESSAGE);
    });
    const captured = captureIo();

    expect(
      await runCli(["agent", "run", "researcher", "Do work"], captured.io, {
        ...createDependencies(),
        router: { routerChat },
      }),
    ).toBe(1);
    expect(captured.stdout).toEqual([]);
    expect(captured.stderr).toEqual([AGENT_LINK_REVOKED_MESSAGE]);
    expect(noSecrets(allOutput(captured))).toBe(true);
  });

  it("writes only the result JSON and never serializes credentials", async () => {
    await homeWithAgent();
    const scripted = [textReply("Safe answer.")];
    const routerChat = vi.fn(async () => scripted.shift()!);
    const createDeps = vi.fn<typeof createAgentRunDeps>((input) => ({
      profile: input.profile,
      config: input.config,
      home: input.home,
      chat: input.chat,
      search: vi.fn(),
      inspect: vi.fn(),
      pay: vi.fn(),
      caps: { perCallUsd: 1 },
      approve: input.approve,
      ...(input.onEvent === undefined ? {} : { onEvent: input.onEvent }),
      ...(input.tty === undefined ? {} : { tty: input.tty }),
    }));
    const captured = captureIo();

    expect(
      await runCli(["agent", "run", "researcher", "Answer safely", "--json"], captured.io, {
        ...createDependencies(),
        router: { routerChat },
        agent: { createAgentRunDeps: createDeps },
      }),
    ).toBe(0);
    expect(JSON.parse(onlyStdout(captured))).toMatchObject({
      answer: "Safe answer.",
      stoppedBecause: { type: "stopped", reason: "finished" },
      paidUsd: 0,
      steps: 1,
    });
    expect(noSecrets(allOutput(captured))).toBe(true);
  });
});

describe("vapi agent lifecycle", () => {
  it("pauses and resumes a profile", async () => {
    const home = await homeWithAgent();

    expect(
      await runCli(["agent", "pause", "researcher"], captureIo().io, createDependencies()),
    ).toBe(0);
    expect(await readAgentProfile(home, "researcher")).toMatchObject({ paused: true });

    expect(
      await runCli(["agent", "resume", "researcher"], captureIo().io, createDependencies()),
    ).toBe(0);
    expect(await readAgentProfile(home, "researcher")).toMatchObject({ paused: false });
  });

  it("revokes the link, removes the profile, keeps the wallet, and prints the sweep hint", async () => {
    const home = await homeWithAgent();
    const store = await WalletStore.open(home);
    await store.setLink("researcher", linkedAgent());
    const balances = vi.fn<typeof getWallet>(async (account) => ({
      address: typeof account === "string" ? account : account.address,
      balances: [
        {
          network: "eip155:8453",
          name: "Base",
          usdcAtomic: "2500000",
          usdc: "2.5",
        },
      ],
    }));
    const captured = captureIo();

    expect(
      await runCli(["agent", "revoke", "researcher"], captured.io, {
        ...createDependencies(),
        agent: { getWallet: balances },
      }),
    ).toBe(0);
    await expect(readAgentProfile(home, "researcher")).rejects.toThrow("No agent named researcher");
    const retained = await WalletStore.open(home);
    expect(retained.has("researcher")).toBe(true);
    expect(retained.entry("researcher")?.link).toBeUndefined();
    expect(captured.stdout).toEqual([
      `The wallet researcher still holds $2.5. Send it back with vapi sweep ${OWNER} --wallet researcher.`,
    ]);
  });

  it("still revokes when the retained wallet balance cannot be read", async () => {
    const home = await homeWithAgent();
    const store = await WalletStore.open(home);
    await store.setLink("researcher", linkedAgent());
    const forget = vi.fn<typeof forgetAgentLink>(async () => undefined);
    const captured = captureIo();

    expect(
      await runCli(["agent", "revoke", "researcher"], captured.io, {
        ...createDependencies(),
        agentLink: { forgetAgentLink: forget },
        agent: {
          getWallet: vi.fn<typeof getWallet>(async () => {
            throw new Error("RPC unavailable");
          }),
        },
      }),
    ).toBe(0);
    expect(forget).toHaveBeenCalledOnce();
    await expect(readAgentProfile(home, "researcher")).rejects.toThrow("No agent named researcher");
    expect((await WalletStore.open(home)).has("researcher")).toBe(true);
    expect(captured.stdout).toEqual([
      `The wallet researcher still holds funds. Send it back with vapi sweep ${OWNER} --wallet researcher.`,
    ]);
  });

  it("removes the profile even when the link was already revoked remotely", async () => {
    const home = await homeWithAgent();
    const store = await WalletStore.open(home);
    await store.setLink("researcher", linkedAgent());
    const forget = vi.fn<typeof forgetAgentLink>(async () => {
      throw new AgentLinkError("not_linked", AGENT_LINK_REVOKED_MESSAGE);
    });

    expect(
      await runCli(["agent", "revoke", "researcher"], captureIo().io, {
        ...createDependencies(),
        agentLink: { forgetAgentLink: forget },
      }),
    ).toBe(1);
    await expect(readAgentProfile(home, "researcher")).rejects.toThrow("No agent named researcher");
  });

  it("lists local and Router spend as JSON without exposing secrets", async () => {
    const home = await homeWithAgent();
    const paths = getVapiPaths(home);
    await writeFile(
      paths.ledger,
      `${JSON.stringify({
        version: 1,
        rows: [{ wallet: "researcher", date: "2026-09-23", spentAtomic: "250000" }],
      })}\n`,
      "utf8",
    );
    const usage = vi.fn(async (): Promise<AgentRouterUsage> => routerUsageResult());
    const captured = captureIo();

    expect(
      await runCli(["agent", "list", "--json"], captured.io, {
        ...createDependencies(),
        now: () => new Date("2026-09-23T12:00:00.000Z"),
        router: { routerUsage: usage },
      }),
    ).toBe(0);
    expect(JSON.parse(onlyStdout(captured))).toEqual([
      expect.objectContaining({
        name: "researcher",
        wallet: "researcher",
        address: expect.stringMatching(/^0x[0-9a-fA-F]{40}$/u),
        linkedOwner: "not linked",
        model: "router/test",
        paused: false,
        callSpentTodayUsd: 0.25,
        routerRemainingTodayUsd: 0.75,
      }),
    ]);
    expect(noSecrets(allOutput(captured))).toBe(true);
  });

  it("keeps listing profiles when Router usage cannot be read", async () => {
    await homeWithAgent();
    const captured = captureIo();

    expect(
      await runCli(["agent", "list", "--json"], captured.io, {
        ...createDependencies(),
        router: {
          routerUsage: vi.fn(async () => {
            throw new Error("Router unavailable");
          }),
        },
      }),
    ).toBe(0);
    expect(JSON.parse(onlyStdout(captured))).toEqual([
      expect.objectContaining({ name: "researcher", routerRemainingTodayUsd: "—" }),
    ]);
  });
});

function createDependencies(overrides: Partial<CliDependencies> = {}): CliDependencies {
  return {
    interactive: false,
    env: {},
    prompts: { secret: async () => PASSPHRASE },
    secretStore: secretStoreStub(),
    openUrl: () => false,
    ...overrides,
  };
}

function profile(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    version: 1,
    name: "researcher",
    wallet: "researcher",
    model: "router/test",
    instructions: "Research carefully.",
    verifiedOnly: true,
    approveAboveUsd: 0.5,
    maxSteps: 12,
    tools: ["call.search", "call.inspect", "call.pay"],
    paused: false,
    createdAt: "2026-09-23T00:00:00.000Z",
    ...overrides,
  };
}

async function temporaryHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "vapi-agent-cli-"));
  homes.push(home);
  process.env.VAPI_HOME = home;
  delete process.env.VAPI_KEYSTORE_PASSWORD;
  return home;
}

async function homeWithAgent(overrides: Partial<AgentProfile> = {}): Promise<string> {
  const home = await temporaryHome();
  process.env.VAPI_KEYSTORE_PASSWORD = PASSPHRASE;
  const store = await WalletStore.open(home);
  await store.create("researcher", PASSPHRASE, {
    spendCaps: { perCallAtomic: "1000000", perDayAtomic: "2000000" },
  });
  await writeAgentProfile(home, profile(overrides));
  return home;
}

function scriptedChat(): ChatResult[] {
  return [
    toolReply("search", "call_search", { query: "base dex volume", network: null }),
    toolReply("pay", "call_pay", { ref: "report", body: null, max_usd: 1 }),
    toolReply("finish", "finish", { answer: "Declined." }),
  ];
}

function toolReply(id: string, name: string, args: Record<string, unknown>): ChatResult {
  return {
    content: null,
    toolCalls: [{ id, name, arguments: JSON.stringify(args) }],
    model: "router/test",
    keyUsed: "stake",
  };
}

function textReply(content: string): ChatResult {
  return { content, toolCalls: [], model: "router/test", keyUsed: "stake" };
}

function inspected(price: string): Awaited<ReturnType<RunAgentDeps["inspect"]>> {
  return {
    name: "DEX report",
    method: "POST",
    url: "https://data.example/report",
    price,
    description: "Base DEX volume.",
    verification: "verified",
    network: "eip155:8453",
    payment: {
      scheme: "exact",
      network: "eip155:8453",
      asset: "0x2222222222222222222222222222222222222222",
      payTo: "0x3333333333333333333333333333333333333333",
      checkedAt: "2026-09-23T00:00:00.000Z",
    },
  };
}

function routerUsageResult(): AgentRouterUsage {
  return {
    compute: {
      allowanceUsd: 1,
      spentTodayUsd: 0.25,
      remainingTodayUsd: 0.75,
      resetsAt: "2026-09-24T00:00:00.000Z",
      ownerLimitUsd: 5,
      ownerSpentUsd: 1,
    },
    balance: null,
  };
}

function linkedAgent() {
  return {
    apiBase: "https://api.vapinetwork.ai",
    clientId: "agent_researcher",
    owner: OWNER,
    label: "researcher",
    scopes: ["mcp:call", "router.use"],
    linkedAt: "2026-09-23T10:00:00.000Z",
  };
}

function secretStoreStub(entries: Record<string, string> = {}): SecretStore {
  return {
    available: true,
    platform: "darwin",
    description: "the macOS Keychain",
    get: async (name) => entries[name],
    has: async (name) => entries[name] !== undefined,
    set: async (name, value) => {
      entries[name] = value;
    },
    remove: async (name) => {
      if (entries[name] === undefined) return false;
      delete entries[name];
      return true;
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

function onlyStdout(captured: { stdout: string[] }): string {
  expect(captured.stdout).toHaveLength(1);
  return captured.stdout[0]!;
}

function allOutput(captured: { stdout: string[]; stderr: string[] }): string {
  return [...captured.stdout, ...captured.stderr].join("\n");
}

function noSecrets(text: string): boolean {
  return ![PASSPHRASE, ACCESS_TOKEN, ROUTER_KEY, START.deviceCode].some((secret) =>
    text.includes(secret),
  );
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
