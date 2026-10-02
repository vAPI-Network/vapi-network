import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  VAPI_CLIENT_VERSION,
  WalletStore,
  getDefaultConfig,
  type AgentRouterUsage,
  type SecretStore,
} from "@vapi-network/core";
import { agentSecretAccounts } from "@vapi-network/core/agent-link";
import { afterEach, describe, expect, it } from "vitest";
import { type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { createVapiServer } from "../server.js";

const NOW = new Date("2026-09-28T12:00:00.000Z");
const OWNER = "0xf699000000000000000000000000000000000b09c" as const;
const PRIVATE_KEY = "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" as Hex;
const TOKEN = "access-token-that-must-stay-private";
const NO_STORE_MESSAGE =
  "No wallet store is available on this machine, so there is no status to read. Run vapi setup.";
const temporaryDirectories: string[] = [];
const secretStores = new Map<string, SecretStore>();

afterEach(async () => {
  const directories = temporaryDirectories.splice(0);
  for (const directory of directories) secretStores.delete(directory);
  await Promise.all(
    directories.map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function memoryStore(): SecretStore {
  const entries = new Map<string, string>();
  return {
    available: true,
    platform: "darwin",
    description: "the macOS Keychain",
    async get(name) {
      return entries.get(name);
    },
    async has(name) {
      return entries.has(name);
    },
    async set(name, value) {
      entries.set(name, value);
    },
    async remove(name) {
      return entries.delete(name);
    },
  };
}

function secretsFor(home: string): SecretStore {
  const existing = secretStores.get(home);
  if (existing !== undefined) return existing;
  const created = memoryStore();
  secretStores.set(home, created);
  return created;
}

async function makeHome(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "vapi-mcp-status-"));
  temporaryDirectories.push(directory);
  return directory;
}

function usage(spentTodayUsd: number, allowanceUsd: number): AgentRouterUsage {
  return {
    compute: {
      allowanceUsd,
      spentTodayUsd,
      remainingTodayUsd: allowanceUsd - spentTodayUsd,
      resetsAt: "2026-09-29T00:00:00.000Z",
      ownerLimitUsd: allowanceUsd,
      ownerSpentUsd: spentTodayUsd,
    },
    balance: null,
  };
}

function linkedAccount() {
  return {
    owner: OWNER,
    apiBase: "https://api.vapinetwork.ai",
    clientId: "status-test",
    label: "Status test",
    scopes: ["router:use"],
    linkedAt: NOW.toISOString(),
  };
}

function nextLine(command: string, description: string): string {
  return command.padEnd(34) + description;
}

async function statusFixture() {
  const home = await makeHome();
  const secrets = secretsFor(home);
  const store = await WalletStore.open(home, { secrets, now: () => NOW });
  await store.create("main", "");
  await store.setSpendCaps("main", { perCallAtomic: "50000", perDayAtomic: "1000000" });
  await store.setLink("main", linkedAccount());
  const address = (await store.list())[0]?.address;
  expect(address).toBeDefined();
  const server = createVapiServer({
    account: await store.unlock("main", ""),
    config: getDefaultConfig({}),
    store,
    wallet: "main",
    env: {},
    secretStore: secrets,
    fetchImpl: () => Promise.reject(new Error("The status test makes no network call.")),
    agentLink: { apiBase: "https://api.vapinetwork.ai" },
    status: {
      usdcBalance: async () => 980000n,
      routerUsage: async () => usage(0.01, 1),
      linkStatus: async () => "active",
      now: () => NOW,
    },
  });
  const account = {
    name: "main",
    default: true,
    address: address!,
    usdc: "0.98",
    routerTodayUsd: "0.01",
    routerAllowanceUsd: "1.00",
    caps: { perCallUsd: "0.05", perDayUsd: "1.00", ceilingUsd: "5" },
    link: "active",
  };
  const report = {
    version: VAPI_CLIENT_VERSION,
    home,
    registry: "https://api.vapinetwork.ai",
    owner: {
      address: OWNER,
      linked: true,
      console: "https://api.vapinetwork.ai/agents",
    },
    vault: {
      exists: true,
      unlocked: true,
      store: "macOS Keychain",
      protected: false,
    },
    accounts: [account],
    unfinishedMovements: [],
    next: [
      nextLine("vapi pay <ref> --max 0.02", "pay an API from main"),
      nextLine('vapi router chat "hello"', "talk to a model on main's allowance"),
      nextLine("vapi accounts add <name>", "add an account"),
    ],
  };
  return { server, home, store, secrets, account, report };
}

describe("status tools", () => {
  it("vapi.status returns the status report", async () => {
    const { server, report } = await statusFixture();

    const result = await server.callTool({ name: "vapi.status" });

    expect(result.structuredContent).toEqual(report);
    expect(result.content).toEqual([
      { type: "text", text: JSON.stringify(result.structuredContent, null, 2) },
    ]);
    await server.close();
  });

  it("vapi.accounts returns only the accounts array", async () => {
    const { server, account } = await statusFixture();

    const result = await server.callTool({ name: "vapi.accounts" });

    expect(result.structuredContent).toEqual({ accounts: [account] });
    expect(result.content).toEqual([
      { type: "text", text: JSON.stringify(result.structuredContent, null, 2) },
    ]);
    await server.close();
  });

  it("reloads accounts added after the server starts", async () => {
    const { server, home, secrets } = await statusFixture();
    const writer = await WalletStore.open(home, { secrets, env: {}, now: () => NOW });
    await writer.create("researcher", "");

    const status = await server.callTool({ name: "vapi.status" });

    expect(status.structuredContent).toMatchObject({
      accounts: [{ name: "main" }, { name: "researcher" }],
    });

    await writer.create("analyst", "");

    const accounts = await server.callTool({ name: "vapi.accounts" });

    expect(accounts.structuredContent).toMatchObject({
      accounts: [{ name: "main" }, { name: "researcher" }, { name: "analyst" }],
    });
    await server.close();
  });

  it("neither result leaks a secret", async () => {
    const { server, secrets } = await statusFixture();
    await secrets.set(agentSecretAccounts("main").tokens, TOKEN);

    const results = await Promise.all([
      server.callTool({ name: "vapi.status" }),
      server.callTool({ name: "vapi.accounts" }),
    ]);

    for (const result of results) {
      const serialized = JSON.stringify(result);
      expect(serialized).not.toMatch(/0x[0-9a-fA-F]{64}/u);
      expect(serialized).not.toMatch(/\b(?:[a-z]+ ){11}[a-z]+\b/u);
      expect(serialized).not.toMatch(/bearer\s+\S+/iu);
      expect(serialized).not.toContain(TOKEN);
    }
    await server.close();
  });

  it("says there is nothing to read without a wallet store", async () => {
    const server = createVapiServer({
      account: privateKeyToAccount(PRIVATE_KEY),
      config: getDefaultConfig({}),
      fetchImpl: () => Promise.reject(new Error("The status test makes no network call.")),
    });

    for (const name of ["vapi.status", "vapi.accounts"]) {
      await expect(server.callTool({ name })).resolves.toEqual({
        isError: true,
        content: [{ type: "text", text: NO_STORE_MESSAGE }],
      });
    }
    await server.close();
  });

  it("reports a missing vault as the setup line", async () => {
    const home = await makeHome();
    const secrets = secretsFor(home);
    const store = await WalletStore.open(home, { secrets, now: () => NOW });
    const server = createVapiServer({
      account: privateKeyToAccount(PRIVATE_KEY),
      config: getDefaultConfig({}),
      store,
      env: {},
      secretStore: secrets,
      fetchImpl: () => Promise.reject(new Error("The status test makes no network call.")),
      agentLink: { apiBase: "https://api.vapinetwork.ai" },
      status: { now: () => NOW },
    });

    const result = await server.callTool({ name: "vapi.status" });

    expect(result.structuredContent).toMatchObject({
      home,
      vault: { exists: false },
      accounts: [],
      next: [nextLine("vapi setup", "create your vault and link your first account")],
    });
    await server.close();
  });
});
