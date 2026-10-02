import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SecretStore } from "@vapi-network/core";
import type { Action, ActionContext, Runtime } from "@vapi-network/mcp";

const runActionCalls = vi.hoisted(() => [] as string[]);
const startStdioServer = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("@vapi-network/mcp", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@vapi-network/mcp")>();
  return {
    ...actual,
    startStdioServer,
    async runAction<I, O>(action: Action<I, O>, input: unknown, ctx: ActionContext): Promise<O> {
      runActionCalls.push(action.name);
      return await actual.runAction(action, input, ctx);
    },
  };
});

import { runCli, type CliDependencies, type CliIo } from "./cli.js";

const originalHome = process.env.VAPI_HOME;
const originalPassword = process.env.VAPI_KEYSTORE_PASSWORD;
const temporaryDirectories: string[] = [];
let dependencies: CliDependencies;

beforeEach(async () => {
  runActionCalls.length = 0;
  startStdioServer.mockClear();
  delete process.env.VAPI_KEYSTORE_PASSWORD;
  const home = await mkdtemp(join(tmpdir(), "vapi-cli-actions-"));
  temporaryDirectories.push(home);
  process.env.VAPI_HOME = home;
  dependencies = { secretStore: secretStoreStub(), fetchImpl: zeroBalanceRpc() };
  expect(await runCli(["init", "--json"], captureIo().io, dependencies)).toBe(0);
  runActionCalls.length = 0;
});

afterEach(async () => {
  restoreEnvironment("VAPI_HOME", originalHome);
  restoreEnvironment("VAPI_KEYSTORE_PASSWORD", originalPassword);
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map(async (directory) => await rm(directory, { recursive: true, force: true })),
  );
});

describe("CLI action register", () => {
  it("runs search, inspect, and pay through runAction", async () => {
    const search = captureIo();
    expect(
      await runCli(["search", "weather"], search.io, {
        ...dependencies,
        fetchImpl: async () => Response.json(marketplacePage()),
      }),
    ).toBe(0);

    const inspect = captureIo();
    expect(
      await runCli(["inspect", "weather"], inspect.io, {
        ...dependencies,
        fetchImpl: async () => Response.json(servicesResponse()),
      }),
    ).toBe(0);

    await allowPrivateNetwork();
    const pay = captureIo();
    expect(
      await runCli(["pay", "https://127.0.0.1/free", "--json"], pay.io, {
        ...dependencies,
        fetchImpl: async () => Response.json({ ok: true }),
        ceiling: { drainCeilingSweeps: async () => undefined },
      }),
    ).toBe(0);

    expect(runActionCalls).toEqual(["call.search", "call.inspect", "call.pay"]);
  });

  it("keeps an invalid --limit as the existing usage error", async () => {
    const captured = captureIo();

    expect(await runCli(["search", "--limit", "many"], captured.io, dependencies)).toBe(2);
    expect(captured.stdout).toEqual([]);
    expect(captured.stderr).toEqual(["--limit must be a non-negative integer."]);
    expect(runActionCalls).toEqual([]);
  });

  it("keeps an invalid --expected-pay-to error and JSON exit shape", async () => {
    const captured = captureIo();

    expect(
      await runCli(
        ["pay", "https://example.test/paid", "--expected-pay-to", "not-an-address", "--json"],
        captured.io,
        dependencies,
      ),
    ).toBe(1);
    expect(captured.stderr).toEqual([]);
    expect(captured.stdout).toEqual([
      JSON.stringify({
        error: "call expectedPayTo must be a 20-byte 0x address.",
        exitCode: 1,
      }),
    ]);
    expect(runActionCalls).toEqual(["call.pay"]);
  });

  it("passes the injected local runtime to the MCP stdio server", async () => {
    const runtime: Runtime = {
      kind: "local",
      start: async () => {
        throw new Error("The MCP command test does not start a run.");
      },
      stop: async () => undefined,
      status: async () => ({ state: "unknown" }),
    };
    const resolveRuntime = vi.fn(() => runtime);

    expect(
      await runCli(["mcp"], captureIo().io, { ...dependencies, runtime: resolveRuntime }),
    ).toBe(0);

    expect(resolveRuntime).toHaveBeenCalledWith("local", process.env.VAPI_HOME);
    expect(startStdioServer).toHaveBeenCalledWith(expect.objectContaining({ runtime }));
  });
});

async function allowPrivateNetwork(): Promise<void> {
  const path = join(process.env.VAPI_HOME!, "config.json");
  const config = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  config.allowPrivateNetwork = true;
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

function marketplacePage() {
  return {
    protocol: "vapi.marketplace.discovery/1",
    items: [],
    nextCursor: null,
    unavailableKinds: [],
    rankingVersion: "marketplace-ranking-v1",
  };
}

function servicesResponse() {
  return {
    services: [
      {
        id: "weather",
        name: "Weather",
        description: "Read the weather.",
        category: "crypto",
        tier: "verified",
        verified: true,
        wrapped: false,
        price: "$0.01",
        networks: ["eip155:8453"],
        endpoints: [
          {
            name: "forecast",
            method: "GET",
            url: "https://weather.example/forecast",
            price: "$0.01",
            description: "Read one forecast.",
          },
        ],
      },
    ],
  };
}

function secretStoreStub(): SecretStore {
  const entries = new Map<string, string>();
  return {
    available: true,
    platform: "darwin",
    description: "the test secret store",
    get: async (name) => entries.get(name),
    has: async (name) => entries.has(name),
    set: async (name, value) => {
      entries.set(name, value);
    },
    remove: async (name) => entries.delete(name),
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

function zeroBalanceRpc(): typeof fetch {
  return vi.fn<typeof fetch>(async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as { id: number; method: string };
    return Response.json({
      jsonrpc: "2.0",
      id: request.id,
      result: request.method === "eth_call" ? `0x${"0".repeat(64)}` : "0x0",
    });
  });
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
