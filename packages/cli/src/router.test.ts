import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { type SecretStore, WalletStore } from "@vapi-network/core";
import {
  RouterClientError,
  type AgentRouterUsage,
  type ChatRequest,
  type ChatResult,
  type RouterClientDeps,
} from "@vapi-network/core/router-client";

import { runCli, type CliDependencies, type CliIo } from "./cli.js";

const PASSPHRASE = "test-only-passphrase";
const WALLET = "researcher";
const TEST_ROUTER_KEY = "test-router-key-value";
const homes: string[] = [];
const originalHome = process.env.VAPI_HOME;

afterEach(async () => {
  restoreEnvironment("VAPI_HOME", originalHome);
  await Promise.all(homes.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("vapi router models", () => {
  it("prints model ids in human and JSON output without requiring a link", async () => {
    await initializedHome();
    const listRouterModels = vi.fn(async () => [{ id: "model-a" }, { id: "model-b" }]);
    const dependencies = commandDependencies({ router: { listRouterModels } });
    const human = captureIo();

    expect(await runCli(["router", "models", "--wallet", WALLET], human.io, dependencies)).toBe(0);
    expect(human.stdout).toEqual(["model-a", "model-b"]);
    expect(listRouterModels).toHaveBeenCalledWith({ apiBase: "https://api.vapinetwork.ai/" });

    const json = captureIo();
    expect(
      await runCli(["router", "models", "--wallet", WALLET, "--json"], json.io, dependencies),
    ).toBe(0);
    expect(JSON.parse(json.stdout[0]!)).toEqual(["model-a", "model-b"]);
  });
});

describe("vapi router usage", () => {
  it("prints the Compute allowance and preserves the usage object as JSON", async () => {
    await initializedHome();
    const usage = usageResult();
    const dependencies = commandDependencies({
      router: { routerUsage: vi.fn(async () => usage) },
    });
    const human = captureIo();

    expect(await runCli(["router", "usage", "--wallet", WALLET], human.io, dependencies)).toBe(0);
    expect(human.stdout).toEqual([
      "Compute today: $0.42 of $2.00 (resets 03:07 UTC)",
      "Owner's Compute: $0.90 of $5.00",
      "Router balance: none",
    ]);

    const json = captureIo();
    expect(
      await runCli(["router", "usage", "--wallet", WALLET, "--json"], json.io, dependencies),
    ).toBe(0);
    expect(JSON.parse(json.stdout[0]!)).toEqual(usage);
  });

  it("formats a purchased Router balance", async () => {
    await initializedHome();
    const dependencies = commandDependencies({
      router: {
        routerUsage: async () => ({
          ...usageResult(),
          balance: { purchasedUsd: 10, spentUsd: 2.25, remainingUsd: 7.75 },
        }),
      },
    });
    const captured = captureIo();

    expect(await runCli(["router", "usage", "--wallet", WALLET], captured.io, dependencies)).toBe(
      0,
    );
    expect(captured.stdout).toContain("Router balance: $7.75 left of $10.00");
  });
});

describe("vapi router chat", () => {
  it("builds system and user messages and prints human and JSON results", async () => {
    await initializedHome();
    const result: ChatResult = {
      model: "model-a",
      content: "Hello from the Router.",
      toolCalls: [],
      usage: { prompt_tokens: 4, completion_tokens: 5, total_tokens: 9 },
      keyUsed: "stake",
    };
    const routerChat = vi.fn(async (_deps: RouterClientDeps, _request: ChatRequest) => result);
    const dependencies = commandDependencies({ router: { routerChat } });
    const human = captureIo();

    expect(
      await runCli(
        [
          "router",
          "chat",
          "--wallet",
          WALLET,
          "--model",
          "model-a",
          "--system",
          "Be concise.",
          "--max-tokens",
          "200",
          "Hello",
        ],
        human.io,
        dependencies,
      ),
    ).toBe(0);
    expect(human.stdout).toEqual(["Hello from the Router."]);
    expect(routerChat.mock.calls[0]![1]).toEqual({
      model: "model-a",
      messages: [
        { role: "system", content: "Be concise." },
        { role: "user", content: "Hello" },
      ],
      max_tokens: 200,
    });

    const json = captureIo();
    expect(
      await runCli(
        ["router", "chat", "--wallet", WALLET, "--model", "model-a", "Hello", "--json"],
        json.io,
        dependencies,
      ),
    ).toBe(0);
    expect(JSON.parse(json.stdout[0]!)).toEqual({
      model: "model-a",
      content: "Hello from the Router.",
      usage: { prompt_tokens: 4, completion_tokens: 5, total_tokens: 9 },
    });
  });

  it("reads a dash prompt from the injected stdin reader", async () => {
    await initializedHome();
    const routerChat = vi.fn(async (_deps: RouterClientDeps, _request: ChatRequest) =>
      chatResult(),
    );
    const readStdin = vi.fn(async () => "Prompt from stdin\n");
    const captured = captureIo();

    expect(
      await runCli(
        ["router", "chat", "--wallet", WALLET, "--model", "model-a", "-"],
        captured.io,
        commandDependencies({ router: { routerChat }, readStdin }),
      ),
    ).toBe(0);
    expect(readStdin).toHaveBeenCalledOnce();
    expect(routerChat.mock.calls[0]![1].messages).toEqual([
      { role: "user", content: "Prompt from stdin\n" },
    ]);
  });

  it.each([
    [["router", "chat", "hello"], "vapi router chat requires --model <id>."],
    [
      ["router", "chat", "--model", "model-a"],
      'Usage: vapi router chat --model <id> [--system <text>] [--max-tokens <n>] "<prompt>".',
    ],
  ] as const)("rejects an incomplete invocation", async (argv, message) => {
    await initializedHome();
    const captured = captureIo();

    expect(await runCli([...argv, "--json"], captured.io, commandDependencies())).toBe(2);
    expect(JSON.parse(captured.stdout[0]!)).toEqual({ error: message, exitCode: 2 });
  });
});

describe("vapi router key", () => {
  it("prints a Router key only for an allowed terminal run and audits the export", async () => {
    const home = await initializedHome();
    const routerCredentials = vi.fn(async () => ({
      baseURL: "https://router.vapinetwork.ai/v1",
      apiKey: TEST_ROUTER_KEY,
    }));
    const captured = captureIo();

    expect(
      await runCli(
        ["router", "key", "--wallet", WALLET],
        captured.io,
        commandDependencies({ interactive: true, env: {}, router: { routerCredentials } }),
      ),
    ).toBe(0);
    expect(captured.stdout).toEqual([TEST_ROUTER_KEY]);
    expect(captured.stderr.join("\n")).not.toContain(TEST_ROUTER_KEY);
    const audit = await readFile(join(home, "audit.log"), "utf8");
    expect(audit).toContain('"event":"secret.export.key"');
    expect(audit).not.toContain(TEST_ROUTER_KEY);
  });

  it.each([
    ["an agent marker", true, { CLAUDECODE: "1" }, "CLAUDECODE is set."],
    ["non-TTY output", false, {}, "stdin is not a terminal."],
  ])("refuses for %s before reading the key", async (_name, interactive, env, reason) => {
    await initializedHome();
    const routerCredentials = vi.fn(async () => ({
      baseURL: "https://router.vapinetwork.ai/v1",
      apiKey: TEST_ROUTER_KEY,
    }));
    const captured = captureIo();

    expect(
      await runCli(
        ["router", "key", "--wallet", WALLET],
        captured.io,
        commandDependencies({ interactive, env, router: { routerCredentials } }),
      ),
    ).toBe(1);
    expect(routerCredentials).not.toHaveBeenCalled();
    expect(captured.stdout).toEqual([]);
    expect(captured.stderr.join("\n")).toContain(
      "Run this yourself in a terminal; an agent must never see these words.",
    );
    expect(captured.stderr.join("\n")).toContain(reason);
    expect(allOutput(captured)).not.toContain(TEST_ROUTER_KEY);
  });

  it("always refuses JSON output before reading the key", async () => {
    await initializedHome();
    const routerCredentials = vi.fn(async () => ({
      baseURL: "https://router.vapinetwork.ai/v1",
      apiKey: TEST_ROUTER_KEY,
    }));
    const captured = captureIo();

    expect(
      await runCli(
        ["router", "key", "--wallet", WALLET, "--json"],
        captured.io,
        commandDependencies({ interactive: true, env: {}, router: { routerCredentials } }),
      ),
    ).toBe(1);
    expect(routerCredentials).not.toHaveBeenCalled();
    expect(JSON.parse(captured.stdout[0]!)).toEqual({
      error:
        "Run this yourself in a terminal; an agent must never see these words. Router keys are never printed as JSON.",
      exitCode: 1,
    });
    expect(allOutput(captured)).not.toContain(TEST_ROUTER_KEY);
  });

  it("rotates the key without exposing it in human or JSON output", async () => {
    await initializedHome();
    const rotateRouterKey = vi.fn(async () => undefined);
    const dependencies = commandDependencies({ router: { rotateRouterKey } });
    const human = captureIo();

    expect(
      await runCli(["router", "key", "--wallet", WALLET, "--rotate"], human.io, dependencies),
    ).toBe(0);
    expect(human.stdout).toEqual(["New Router key stored."]);
    expect(allOutput(human)).not.toContain(TEST_ROUTER_KEY);

    const json = captureIo();
    expect(
      await runCli(
        ["router", "key", "--wallet", WALLET, "--rotate", "--json"],
        json.io,
        dependencies,
      ),
    ).toBe(0);
    expect(JSON.parse(json.stdout[0]!)).toEqual({ wallet: WALLET, rotated: true });
    expect(allOutput(json)).not.toContain(TEST_ROUTER_KEY);
  });
});

describe("Router client errors", () => {
  it("normalizes an unlinked wallet in human and JSON output", async () => {
    await initializedHome();
    const routerUsage = vi.fn(async () => {
      throw new RouterClientError("not_linked", "unsafe service detail");
    });
    const dependencies = commandDependencies({ router: { routerUsage } });
    const human = captureIo();

    expect(await runCli(["router", "usage", "--wallet", WALLET], human.io, dependencies)).toBe(1);
    expect(human.stderr).toEqual(["Not linked. Run vapi login."]);

    const json = captureIo();
    expect(
      await runCli(["router", "usage", "--wallet", WALLET, "--json"], json.io, dependencies),
    ).toBe(1);
    expect(JSON.parse(json.stdout[0]!)).toEqual({
      error: "Not linked. Run vapi login.",
      exitCode: 1,
    });
  });
});

function usageResult(): AgentRouterUsage {
  return {
    compute: {
      allowanceUsd: 2,
      spentTodayUsd: 0.42,
      remainingTodayUsd: 1.58,
      resetsAt: "2026-09-24T03:07:00.000Z",
      ownerLimitUsd: 5,
      ownerSpentUsd: 0.9,
    },
    balance: null,
  };
}

function chatResult(): ChatResult {
  return {
    model: "model-a",
    content: "Done.",
    toolCalls: [],
    keyUsed: "stake",
  };
}

function commandDependencies(overrides: Partial<CliDependencies> = {}): CliDependencies {
  return {
    interactive: false,
    env: {},
    secretStore: secretStoreStub(),
    ...overrides,
  };
}

function secretStoreStub(): SecretStore {
  return {
    available: true,
    platform: "darwin",
    description: "the macOS Keychain",
    get: async () => undefined,
    has: async () => false,
    set: async () => undefined,
    remove: async () => false,
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

function allOutput(captured: { stdout: string[]; stderr: string[] }): string {
  return [...captured.stdout, ...captured.stderr].join("\n");
}

async function initializedHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "vapi-router-cli-"));
  homes.push(home);
  process.env.VAPI_HOME = home;
  const store = await WalletStore.open(home);
  await store.create(WALLET, PASSPHRASE);
  return home;
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
