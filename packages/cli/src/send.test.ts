import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { WalletStore, type SecretStore } from "@vapi-network/core";
import { agentSecretAccounts } from "@vapi-network/core/agent-link";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getAddress, type Hex } from "viem";

import { runCli, type CliDependencies, type CliIo } from "./cli.js";

const API_BASE = "https://api.vapinetwork.ai";
const TEST_PHRASE = "test test test test test test test test test test test junk";
const ACCESS_TOKEN = "send-test-access-token";
const REFRESH_TOKEN = "send-test-refresh-token";
const OWNER = getAddress("0x1111111111111111111111111111111111111111");
const OUTSIDER = getAddress("0x2222222222222222222222222222222222222222");
const NONCE = `0x${"ab".repeat(32)}` as Hex;
const TX_HASH = `0x${"34".repeat(32)}` as Hex;
const NOW = new Date("2026-09-29T12:00:00.000Z");
const CAPS = { perCallAtomic: "10000000", perDayAtomic: "20000000" };

const originalHome = process.env.VAPI_HOME;
const homes: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  restoreEnvironment("VAPI_HOME", originalHome);
  await Promise.all(homes.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("vapi send", () => {
  it("prints a human transfer summary and transaction link", async () => {
    const fixture = await linkedFixture();
    const captured = captureIo();

    const exitCode = await runCli(
      ["send", "2", "--from", "research", "--to", "writer"],
      captured.io,
      dependencies(fixture),
    );

    expect(exitCode).toBe(0);
    expect(captured.stdout).toEqual([
      "Sent 2.00 USDC from research to writer on Base",
      `https://basescan.org/tx/${TX_HASH}`,
    ]);
    expect(captured.stderr).toEqual([]);
  });

  it("prints the exact transfer result for --json", async () => {
    const fixture = await linkedFixture();
    const captured = captureIo();

    const exitCode = await runCli(
      ["send", "2", "--from", "research", "--to", "writer", "--json"],
      captured.io,
      dependencies(fixture),
    );

    expect(exitCode).toBe(0);
    expect(JSON.parse(captured.stdout[0]!)).toEqual({
      status: "sent",
      from: "research",
      to: fixture.writerAddress,
      toName: "writer",
      toKind: "account",
      amountUsd: "2.00",
      amountAtomic: "2000000",
      network: "eip155:8453",
      txHash: TX_HASH,
      nonce: NONCE,
      replayed: false,
    });
    expect(Object.keys(JSON.parse(captured.stdout[0]!))).toEqual([
      "status",
      "from",
      "to",
      "toName",
      "toKind",
      "amountUsd",
      "amountAtomic",
      "network",
      "txHash",
      "nonce",
      "replayed",
    ]);
  });

  it("reports relay failure in human and JSON output with no money moved", async () => {
    const fixture = await linkedFixture({ relayStatus: "failed" });
    const human = captureIo();

    expect(
      await runCli(
        ["send", "2", "--from", "research", "--to", "writer"],
        human.io,
        dependencies(fixture),
      ),
    ).toBe(1);
    expect(human.stdout).toEqual([]);
    expect(human.stderr).toEqual(["The vAPI relay failed. No money moved."]);

    const json = captureIo();
    expect(
      await runCli(
        ["send", "2", "--from", "research", "--to", "writer", "--json"],
        json.io,
        dependencies(fixture),
      ),
    ).toBe(1);
    expect(JSON.parse(json.stdout[0]!)).toEqual({
      error: "The vAPI relay failed. No money moved.",
      exitCode: 1,
      code: "relay_failed",
      moneyMoved: false,
    });
  });

  it("refuses an unrelated recipient before a relay request", async () => {
    const fixture = await linkedFixture();
    const captured = captureIo();

    expect(
      await runCli(
        ["send", "2", "--from", "research", "--to", OUTSIDER, "--json"],
        captured.io,
        dependencies(fixture),
      ),
    ).toBe(1);
    expect(JSON.parse(captured.stdout[0]!)).toMatchObject({
      code: "recipient_not_allowed",
      moneyMoved: false,
    });
    expect(fixture.relayRequests).toBe(0);
  });

  it("treats a missing --to as a usage error", async () => {
    const fixture = await linkedFixture();
    const captured = captureIo();

    expect(
      await runCli(
        ["send", "2", "--from", "research", "--json"],
        captured.io,
        dependencies(fixture),
      ),
    ).toBe(2);
    expect(JSON.parse(captured.stdout[0]!)).toEqual({
      error: expect.stringContaining("Missing --to <account|owner|0x…>."),
      exitCode: 2,
    });
    expect(fixture.requests).toEqual([]);
  });

  it("keeps an unknown outcome reserved and prints the resume nonce", async () => {
    const fixture = await linkedFixture({ relayStatus: "unknown" });
    const captured = captureIo();

    expect(
      await runCli(
        ["send", "2", "--from", "research", "--to", "writer"],
        captured.io,
        dependencies(fixture),
      ),
    ).toBe(1);
    expect(captured.stdout).toEqual([]);
    expect(captured.stderr).toEqual([
      `The transfer outcome is unknown; the spend stays reserved. Run the same command with --resume ${NONCE} to finish it. Do not send it again.`,
    ]);
  });
});

type Fixture = {
  secrets: SecretStore;
  fetchImpl: typeof fetch;
  writerAddress: `0x${string}`;
  requests: string[];
  relayRequests: number;
};

async function linkedFixture(
  options: { relayStatus?: "sent" | "failed" | "unknown" } = {},
): Promise<Fixture> {
  const home = await mkdtemp(join(tmpdir(), "vapi-send-cli-"));
  homes.push(home);
  process.env.VAPI_HOME = home;
  const secrets = memorySecretStore();
  const store = await WalletStore.open(home, { secrets, env: {} });
  const research = await store.create("research", "", { phrase: TEST_PHRASE, spendCaps: CAPS });
  const writer = await store.create("writer", "", { spendCaps: CAPS });
  await store.setLink("research", {
    apiBase: API_BASE,
    clientId: "agent_research",
    owner: OWNER,
    label: "research",
    scopes: ["mcp:call", "router.use"],
    linkedAt: NOW.toISOString(),
  });
  await secrets.set(
    agentSecretAccounts("research").tokens,
    JSON.stringify({
      accessToken: ACCESS_TOKEN,
      refreshToken: REFRESH_TOKEN,
      expiresAt: Number.MAX_SAFE_INTEGER,
      scopes: ["mcp:call", "router.use"],
    }),
  );

  const requests: string[] = [];
  let relayRequests = 0;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    requests.push(url);
    const pathname = new URL(url).pathname;
    if (pathname === "/api/agents/self/siblings") {
      return Response.json({
        owner: OWNER,
        siblings: [
          sibling("research", research.account.address, true),
          sibling("writer", writer.account.address),
        ],
      });
    }
    if (pathname === "/api/agents/relay-transfer") {
      relayRequests += 1;
      if (options.relayStatus === "failed") {
        return Response.json({ error: "relay_failed" }, { status: 502 });
      }
      if (options.relayStatus === "unknown") {
        return Response.json({ error: "in_progress" }, { status: 409 });
      }
      const body = JSON.parse(String(init?.body)) as {
        network: string;
        authorization: { from: string; to: string; value: string };
      };
      return Response.json({
        txHash: TX_HASH,
        network: body.network,
        from: body.authorization.from,
        to: body.authorization.to,
        value: body.authorization.value,
        replayed: false,
      });
    }
    throw new Error(`Unexpected test request ${url}`);
  }) as typeof fetch;

  return {
    secrets,
    fetchImpl,
    writerAddress: writer.account.address,
    requests,
    get relayRequests() {
      return relayRequests;
    },
  };
}

function sibling(name: string, address: string, self = false) {
  return {
    name,
    address,
    device: "test-device",
    status: "active",
    allowance: { routerPerDayUsd: null, perCallUsd: null, perDayUsd: null },
    self,
  };
}

function dependencies(fixture: Fixture): CliDependencies {
  return {
    env: {},
    interactive: false,
    secretStore: fixture.secrets,
    fetchImpl: fixture.fetchImpl,
    now: () => NOW,
    transfer: { nonce: NONCE },
  };
}

function memorySecretStore(): SecretStore {
  const entries = new Map<string, string>();
  return {
    available: true,
    platform: "darwin",
    description: "the test keychain",
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

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
