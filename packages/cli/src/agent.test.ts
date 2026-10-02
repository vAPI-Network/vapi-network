import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BASE_MAINNET_CAIP2,
  createRunBudget,
  getVapiPaths,
  readAgentProfile,
  type AgentProfile,
  type ChatResult,
  type SecretStore,
  WalletStore,
  writeAgentProfile,
  writeSwarm,
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
import {
  createAgentRunDeps,
  type RunAgentDeps,
  type Runtime,
  type RuntimeStatus,
  type getWallet,
} from "@vapi-network/mcp";
import { afterEach, describe, expect, it, vi } from "vitest";

import { runCli, type CliDependencies, type CliIo } from "./cli.js";
import { buildAgentRunDeps } from "./agent.js";

const PASSPHRASE = "passphrase-that-must-stay-secret";
const RECOVERY_PHRASE =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const PRIVATE_KEY = `0x${"42".repeat(32)}`;
const API_KEY = "vapi_sk_1234567890abcdef";
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
  autoApproved: false,
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
let activeSecretStore: SecretStore | undefined;
let activeSecretEntries: Record<string, string> | undefined;

afterEach(async () => {
  vi.restoreAllMocks();
  restoreEnvironment("VAPI_HOME", originalHome);
  restoreEnvironment("VAPI_KEYSTORE_PASSWORD", originalPassword);
  activeSecretStore = undefined;
  activeSecretEntries = undefined;
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

describe("vapi agent create", () => {
  it.each([
    [
      ["agent", "create"],
      "Missing <name>.\nUsage: vapi agent create <name> --model <id> --instructions <file> [--call-budget <usd>] [--max-per-call <usd>] [--router-budget <usd>] [--approve-above <usd>] [--include-unverified] [--max-steps <n>]",
    ],
    [
      ["agent", "create", "researcher"],
      "Missing --model <id>.\nUsage: vapi agent create <name> --model <id> --instructions <file> [--call-budget <usd>] [--max-per-call <usd>] [--router-budget <usd>] [--approve-above <usd>] [--include-unverified] [--max-steps <n>]",
    ],
  ] as const)("names the missing argument and prints create usage", async (argv, expected) => {
    await temporaryHome();
    const captured = captureIo();

    expect(await runCli([...argv], captured.io, createDependencies())).toBe(2);
    expect(captured.stderr).toEqual([expected]);
  });

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
      `Fund it: send a few USDC on Base to ${String(defaultResult.address)} (vapi fund --account researcher)`,
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
  it("builds reusable run dependencies with run metadata and forced-decline approvals", async () => {
    const home = await homeWithAgent();
    const line = vi.fn(async () => "yes");
    let refill: RouterClientDeps["refill"];
    const routerChat = vi.fn(async (deps: RouterClientDeps) => {
      refill = deps.refill;
      return textReply("Done.");
    });
    const createDeps = vi.fn<typeof createAgentRunDeps>((input) => createAgentRunDeps(input));
    const budget = createRunBudget({ id: "run_swarm_member", limitAtomic: 250_000n });
    const runMeta = {
      swarm: "team",
      member: "researcher",
      parentRunId: "run_swarm_parent",
    };
    const dependencies = createDependencies({
      interactive: true,
      prompts: { secret: async () => PASSPHRASE, line },
      router: { routerChat },
      agent: { createAgentRunDeps: createDeps },
    });

    const built = await buildAgentRunDeps({
      profile: profile(),
      runId: "run_swarm_member",
      budget,
      runMeta,
      approvals: "decline",
      json: false,
      io: captureIo().io,
      dependencies,
    });

    expect(createDeps).toHaveBeenCalledOnce();
    expect(createDeps.mock.calls[0]![0]).toMatchObject({
      runId: "run_swarm_member",
      budget,
      runMeta,
    });
    const currentSpendCaps = createDeps.mock.calls[0]![0].currentSpendCaps;
    expect(currentSpendCaps).toBeTypeOf("function");
    const writer = await WalletStore.open(home);
    await writer.setSpendCaps("researcher", {
      perCallAtomic: "10000",
      perDayAtomic: "10000",
    });
    await expect(currentSpendCaps!()).resolves.toEqual({
      perCallAtomic: "10000",
      perDayAtomic: "10000",
    });
    await built.chat({ model: "router/test", messages: [] });
    expect(refill?.run).toEqual({ id: "run_swarm_member", ...runMeta });
    await expect(
      built.approve({ ref: "report", priceUsd: 0.8, reason: "Above the threshold." }),
    ).resolves.toBe(false);
    expect(line).not.toHaveBeenCalled();
  });

  it("passes a hard run budget to Call and Router payments and returns it as JSON", async () => {
    await homeWithAgent();
    let refill: RouterClientDeps["refill"];
    const routerChat = vi.fn(async (deps: RouterClientDeps) => {
      refill = deps.refill;
      return textReply("Budgeted answer.");
    });
    const createDeps = vi.fn<typeof createAgentRunDeps>((input) => createAgentRunDeps(input));
    const captured = captureIo();

    expect(
      await runCli(
        ["agent", "run", "researcher", "Answer safely", "--budget", "0.25", "--json"],
        captured.io,
        {
          ...createDependencies(),
          router: { routerChat },
          agent: { createAgentRunDeps: createDeps },
        },
      ),
    ).toBe(0);

    const input = createDeps.mock.calls[0]![0];
    expect(input.budget?.limitAtomic).toBe(250_000n);
    expect(input.budget?.id).toBe(input.runId);
    expect(refill?.runBudget).toBe(input.budget);
    expect(refill?.run).toEqual({ id: input.runId });
    expect(JSON.parse(onlyStdout(captured))).toMatchObject({
      runId: input.runId,
      answer: "Budgeted answer.",
      stoppedBecause: { type: "stopped", reason: "finished" },
      budget: { limitUsd: 0.25, spentUsd: 0 },
    });
  });

  it.each(["0", "0.1234567", "not-money"])(
    "returns a usage error for invalid --budget %s",
    async (value) => {
      await temporaryHome();
      const captured = captureIo();

      expect(
        await runCli(
          ["agent", "run", "researcher", "Do work", "--budget", value],
          captured.io,
          createDependencies(),
        ),
      ).toBe(2);
      expect(captured.stderr).toEqual([
        "--budget must be a positive US dollar amount with at most 6 decimals, such as 0.25 or 10.",
      ]);
    },
  );

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

  it("writes an atomic success envelope, honours env run ids, and keeps secrets out", async () => {
    const home = await homeWithAgent();
    const runId = "run_111111111111111111111111";
    const parentRunId = "run_222222222222222222222222";
    const resultFile = join(home, "runs", `${runId}.result.json`);
    const createDeps = vi.fn<typeof createAgentRunDeps>((input) => createAgentRunDeps(input));
    const captured = captureIo();

    expect(
      await runCli(
        ["agent", "run", "researcher", "Answer safely", "--result-file", resultFile, "--json"],
        captured.io,
        {
          ...createDependencies(),
          env: {
            VAPI_RUN_ID: runId,
            VAPI_PARENT_RUN_ID: parentRunId,
            VAPI_RECOVERY_PHRASE: RECOVERY_PHRASE,
            VAPI_PRIVATE_KEY: PRIVATE_KEY,
            VAPI_VAULT_PASSWORD: PASSPHRASE,
            VAPI_API_KEY: API_KEY,
            VAPI_ACCESS_TOKEN: ACCESS_TOKEN,
            VAPI_DEVICE_CODE: START.deviceCode,
            VAPI_ROUTER_KEY: ROUTER_KEY,
          },
          router: {
            routerChat: async () =>
              textReply(
                `Safe answer. ${RECOVERY_PHRASE} ${PRIVATE_KEY} ${PASSPHRASE} ${API_KEY} ${ACCESS_TOKEN} ${START.deviceCode} ${ROUTER_KEY}`,
              ),
          },
          agent: { createAgentRunDeps: createDeps },
        },
      ),
    ).toBe(0);

    const printed = JSON.parse(onlyStdout(captured)) as Record<string, unknown>;
    expect(printed).toMatchObject({ runId });
    expect(printed.answer).toContain("[redacted]");
    expect(createDeps.mock.calls[0]![0]).toMatchObject({
      runId,
      runMeta: { parentRunId },
    });
    const envelope = JSON.parse(await readFile(resultFile, "utf8")) as Record<string, unknown>;
    expect(envelope).toEqual({ v: 1, exitCode: 0, result: printed });
    expect((await stat(resultFile)).mode & 0o777).toBe(0o600);
    expect(noSecrets(`${allOutput(captured)}\n${JSON.stringify(envelope)}`)).toBe(true);
  });

  it.each(["VAPI_RUN_ID", "VAPI_PARENT_RUN_ID"] as const)(
    "writes a usage-error envelope for invalid %s",
    async (variable) => {
      const home = await temporaryHome();
      const resultFile = join(home, "runs", `${variable}.result.json`);
      const captured = captureIo();

      expect(
        await runCli(
          ["agent", "run", "researcher", "Do work", "--result-file", resultFile, "--json"],
          captured.io,
          createDependencies({ env: { [variable]: "not-a-run-id" } }),
        ),
      ).toBe(2);

      const printed = JSON.parse(onlyStdout(captured)) as { error: string; exitCode: number };
      expect(printed).toEqual({
        error: `${variable} must match run_<24 lowercase hexadecimal characters>.`,
        exitCode: 2,
      });
      expect(JSON.parse(await readFile(resultFile, "utf8"))).toEqual({
        v: 1,
        exitCode: 2,
        error: { message: printed.error },
      });
    },
  );

  it("starts a detached agent run without unlocking and reports its log", async () => {
    const home = await homeWithAgent();
    delete process.env.VAPI_KEYSTORE_PASSWORD;
    const fake = fakeRuntime();
    const secret = vi.fn(async () => PASSPHRASE);
    const runId = "run_aaaaaaaaaaaaaaaaaaaaaaaa";
    const captured = captureIo();

    expect(
      await runCli(
        ["agent", "run", "researcher", "Research", "--budget", "0.25", "--detach", "--json"],
        captured.io,
        createDependencies({
          env: { VAPI_RUN_ID: runId },
          prompts: { secret },
          runtime: () => fake.runtime,
        }),
      ),
    ).toBe(0);
    expect(JSON.parse(onlyStdout(captured))).toEqual({
      detached: true,
      runId,
      kind: "local",
      state: "running",
      log: join(home, "runs", `${runId}.log`),
    });
    expect(fake.start).toHaveBeenCalledWith(
      { account: "researcher", profile: "researcher" },
      { runId, task: "Research", mode: "agent", budgetUsd: "0.25" },
      expect.any(Function),
    );
    expect(secret).not.toHaveBeenCalled();

    fake.states.set(runId, { state: "finished", exitCode: 0 });
    const human = captureIo();
    expect(
      await runCli(
        ["agent", "run", "researcher", "Research again", "--detach"],
        human.io,
        createDependencies({ runtime: () => fake.runtime }),
      ),
    ).toBe(0);
    expect(human.stdout[0]).toMatch(/^run_[0-9a-f]{24} started \(local\)$/u);
    expect(human.stdout[1]).toMatch(/^Log: .*\/runs\/run_[0-9a-f]{24}\.log$/u);
  });

  it("detaches the exact typed task and keeps ordinary words in the registry", async () => {
    const home = await homeWithAgent();
    const fake = fakeRuntime();
    const runId = "run_bbbbbbbbbbbbbbbbbbbbbbbb";
    const task = "improve accessibility of the docs and summarize tokenomics: false";

    expect(
      await runCli(
        ["agent", "run", "researcher", task, "--detach", "--json"],
        captureIo().io,
        createDependencies({
          env: { VAPI_RUN_ID: runId, TOKENIZERS_PARALLELISM: "false" },
          runtime: () => fake.runtime,
        }),
      ),
    ).toBe(0);

    expect(fake.start).toHaveBeenCalledWith(
      { account: "researcher", profile: "researcher" },
      { runId, task, mode: "agent" },
      expect.any(Function),
    );
    const record = JSON.parse(await readFile(join(home, "runs", `${runId}.json`), "utf8")) as {
      run: { task: string };
    };
    expect(record.run.task).toBe(task);
  });

  it("keeps result fields and ordinary words intact in a result file", async () => {
    const home = await homeWithAgent();
    const resultFile = join(home, "runs", "ordinary.result.json");
    const answer = "Improve accessibility, summarize tokenomics, keep router_budget: false.";
    const captured = captureIo();

    expect(
      await runCli(
        ["agent", "run", "researcher", "Answer", "--result-file", resultFile, "--json"],
        captured.io,
        {
          ...createDependencies({ env: { TOKENIZERS_PARALLELISM: "false" } }),
          router: { routerChat: async () => textReply(answer) },
        },
      ),
    ).toBe(0);

    const printed = JSON.parse(onlyStdout(captured)) as { answer: string };
    expect(printed.answer).toBe(answer);
    expect(JSON.parse(await readFile(resultFile, "utf8"))).toEqual({
      v: 1,
      exitCode: 0,
      result: printed,
    });
  });

  it("attributes a detached each-mode member run to its swarm without treasury grants", async () => {
    const home = await homeWithAgent({ grants: ["read", "delegate", "allocate"] });
    const store = await WalletStore.open(home, { secrets: currentSecretStore() });
    const treasury = await store.create("team-treasury", PASSPHRASE);
    await writeRuntimeSwarm(home, store, treasury.account.address);
    const parentRunId = "run_cccccccccccccccccccccccc";
    const createDeps = vi.fn<typeof createAgentRunDeps>((input) => createAgentRunDeps(input));

    expect(
      await runCli(["agent", "run", "researcher", "Answer", "--json"], captureIo().io, {
        ...createDependencies({
          env: {
            VAPI_SWARM: "team",
            VAPI_PARENT_RUN_ID: parentRunId,
            VAPI_RUN_ID: "run_dddddddddddddddddddddddd",
          },
        }),
        router: { routerChat: async () => textReply("Done.") },
        agent: { createAgentRunDeps: createDeps },
      }),
    ).toBe(0);

    expect(createDeps.mock.calls[0]![0]).toMatchObject({
      runMeta: { swarm: "team", member: "researcher", parentRunId },
      profile: { grants: ["read"] },
    });

    const invalid = captureIo();
    expect(
      await runCli(
        ["agent", "run", "researcher", "Answer", "--json"],
        invalid.io,
        createDependencies({
          env: { VAPI_SWARM: "../team", VAPI_RUN_ID: "run_dddddddddddddddddddddddd" },
        }),
      ),
    ).toBe(2);
    expect(JSON.parse(onlyStdout(invalid))).toEqual({
      error: "VAPI_SWARM must be a valid swarm name.",
      exitCode: 2,
    });
  });

  it("refuses a detached swarm profile whose wallet was changed to the treasury", async () => {
    const home = await homeWithAgent({ wallet: "team-treasury" });
    const store = await WalletStore.open(home, { secrets: currentSecretStore() });
    const treasury = await store.create("team-treasury", PASSPHRASE);
    await writeRuntimeSwarm(home, store, treasury.account.address);
    const captured = captureIo();

    expect(
      await runCli(["agent", "run", "researcher", "Answer", "--json"], captured.io, {
        ...createDependencies({
          env: {
            VAPI_SWARM: "team",
            VAPI_RUN_ID: "run_dddddddddddddddddddddddd",
          },
        }),
        router: { routerChat: async () => textReply("Done.") },
      }),
    ).toBe(2);
    expect(JSON.parse(onlyStdout(captured))).toEqual({
      error:
        "Agent researcher is member researcher of swarm team, but its profile selects team-treasury. Refusing to run.",
      exitCode: 2,
    });
  });

  it("ignores a VAPI_SWARM left in an ordinary shell for an attached run", async () => {
    await homeWithAgent({ grants: ["read", "delegate", "allocate"] });
    const createDeps = vi.fn<typeof createAgentRunDeps>((input) => createAgentRunDeps(input));

    expect(
      await runCli(["agent", "run", "researcher", "Answer", "--json"], captureIo().io, {
        ...createDependencies({ env: { VAPI_SWARM: "team" } }),
        router: { routerChat: async () => textReply("Done.") },
        agent: { createAgentRunDeps: createDeps },
      }),
    ).toBe(0);

    const input = createDeps.mock.calls[0]![0];
    expect(input.profile).toMatchObject({ grants: ["read", "delegate", "allocate"] });
    expect(input.runMeta?.swarm).toBeUndefined();
  });

  it("returns member_busy for a second detached agent run", async () => {
    await homeWithAgent();
    const fake = fakeRuntime();
    const deps = createDependencies({ runtime: () => fake.runtime });
    expect(
      await runCli(
        ["agent", "run", "researcher", "First", "--detach", "--json"],
        captureIo().io,
        deps,
      ),
    ).toBe(0);
    const captured = captureIo();

    expect(
      await runCli(
        ["agent", "run", "researcher", "Second", "--detach", "--json"],
        captured.io,
        deps,
      ),
    ).toBe(1);
    expect(JSON.parse(onlyStdout(captured))).toMatchObject({
      error: expect.stringContaining("already has running run"),
      exitCode: 1,
      code: "member_busy",
    });
    expect(fake.start).toHaveBeenCalledOnce();
  });

  it("checks a detached profile before resolving its runtime", async () => {
    await homeWithAgent({ paused: true });
    const runtime = vi.fn<NonNullable<CliDependencies["runtime"]>>();
    const captured = captureIo();

    expect(
      await runCli(
        ["agent", "run", "researcher", "Do work", "--detach", "--json"],
        captured.io,
        createDependencies({ runtime }),
      ),
    ).toBe(1);
    expect(JSON.parse(onlyStdout(captured))).toEqual({
      error: "Agent researcher is paused. Run vapi agent resume researcher.",
      exitCode: 1,
    });
    expect(runtime).not.toHaveBeenCalled();
  });

  it("rejects runtime without detach and detach with result-file", async () => {
    const home = await homeWithAgent();
    const runtimeOnly = captureIo();
    expect(
      await runCli(
        ["agent", "run", "researcher", "Do work", "--runtime", "local", "--json"],
        runtimeOnly.io,
        createDependencies(),
      ),
    ).toBe(2);
    expect(JSON.parse(onlyStdout(runtimeOnly))).toMatchObject({ exitCode: 2 });

    const conflict = captureIo();
    expect(
      await runCli(
        [
          "agent",
          "run",
          "researcher",
          "Do work",
          "--detach",
          "--result-file",
          join(home, "result.json"),
          "--json",
        ],
        conflict.io,
        createDependencies(),
      ),
    ).toBe(2);
    expect(JSON.parse(onlyStdout(conflict))).toMatchObject({ exitCode: 2 });
  });

  it("refuses a detached railway run for a standalone account and points to swarm run", async () => {
    const home = await homeWithAgent();
    const runtime = vi.fn<NonNullable<CliDependencies["runtime"]>>();
    const railwayExec = vi.fn<NonNullable<CliDependencies["railwayExec"]>>();
    const captured = captureIo();

    expect(
      await runCli(
        ["agent", "run", "researcher", "Do work", "--detach", "--runtime", "railway", "--json"],
        captured.io,
        createDependencies({ runtime, railwayExec }),
      ),
    ).toBe(2);
    const printed = JSON.parse(onlyStdout(captured)) as { error: string; exitCode: number };
    expect(printed.exitCode).toBe(2);
    expect(printed.error).toContain(
      'vapi swarm run <swarm> "<task>" --mode each --runtime railway',
    );
    expect(runtime).not.toHaveBeenCalled();
    expect(railwayExec).not.toHaveBeenCalled();
    await expect(readdir(join(home, "runs"))).rejects.toMatchObject({ code: "ENOENT" });
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
      `The wallet researcher still holds $2.5. Send it back with vapi sweep ${OWNER} --account researcher.`,
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
      `The wallet researcher still holds funds. Send it back with vapi sweep ${OWNER} --account researcher.`,
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
    secretStore: currentSecretStore(),
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
    grants: [],
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
  secretStoreStub();
  return home;
}

async function homeWithAgent(overrides: Partial<AgentProfile> = {}): Promise<string> {
  const home = await temporaryHome();
  process.env.VAPI_KEYSTORE_PASSWORD = PASSPHRASE;
  const store = await WalletStore.open(home, { secrets: currentSecretStore() });
  await store.create("researcher", PASSPHRASE, {
    spendCaps: { perCallAtomic: "1000000", perDayAtomic: "2000000" },
  });
  await writeAgentProfile(home, profile(overrides));
  return home;
}

async function writeRuntimeSwarm(
  home: string,
  store: WalletStore,
  treasuryAddress: `0x${string}`,
): Promise<void> {
  const memberAddress = await store.readAddress("researcher");
  if (memberAddress === undefined) throw new Error("Missing researcher address in test fixture.");
  await writeSwarm(home, {
    v: 1,
    name: "team",
    device: "test-device",
    network: BASE_MAINNET_CAIP2,
    createdAt: "2026-09-23T00:00:00.000Z",
    treasury: {
      account: "team-treasury",
      address: treasuryAddress,
      steps: { creating: true, created: true, capped: true, linked: true },
    },
    members: [
      {
        account: "researcher",
        address: memberAddress,
        role: "lead",
        weight: 1,
        targetAtomic: "1000000",
        ceilingAtomic: "2000000",
        steps: { creating: true, created: true, capped: true, linked: true, profiled: true },
      },
    ],
    policy: {
      strategy: "targets",
      treasuryCaps: { perCallAtomic: "5000000", perDayAtomic: "20000000" },
    },
  });
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

function secretStoreStub(entries?: Record<string, string>): SecretStore {
  if (activeSecretStore !== undefined && activeSecretEntries !== undefined) {
    if (entries !== undefined) {
      Object.assign(entries, activeSecretEntries);
      activeSecretEntries = entries;
    }
    return activeSecretStore;
  }
  activeSecretEntries = entries ?? {};
  activeSecretStore = {
    available: true,
    platform: "darwin",
    description: "the macOS Keychain",
    get: async (name) => activeSecretEntries![name],
    has: async (name) => activeSecretEntries![name] !== undefined,
    set: async (name, value) => {
      activeSecretEntries![name] = value;
    },
    remove: async (name) => {
      if (activeSecretEntries![name] === undefined) return false;
      delete activeSecretEntries![name];
      return true;
    },
  };
  return activeSecretStore;
}

function currentSecretStore(): SecretStore {
  if (activeSecretStore === undefined) throw new Error("Test home has no secret store.");
  return activeSecretStore;
}

function fakeRuntime() {
  const states = new Map<string, RuntimeStatus>();
  const start = vi.fn<Runtime["start"]>(async (member, run) => {
    states.set(run.runId, { state: "running" });
    return {
      runId: run.runId,
      kind: "local",
      member,
      startedAt: "2026-09-30T08:00:00.000Z",
      ref: `handle:${run.runId}`,
    };
  });
  const stop = vi.fn<Runtime["stop"]>(async (handle) => {
    states.set(handle.runId, { state: "stopped" });
  });
  const status = vi.fn<Runtime["status"]>(async (handle) =>
    Promise.resolve(states.get(handle.runId) ?? { state: "unknown" }),
  );
  return { runtime: { kind: "local" as const, start, stop, status }, start, stop, status, states };
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
  return ![
    PASSPHRASE,
    RECOVERY_PHRASE,
    PRIVATE_KEY,
    API_KEY,
    ACCESS_TOKEN,
    ROUTER_KEY,
    START.deviceCode,
  ].some((secret) => text.includes(secret));
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
