import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  WalletStore,
  getDefaultConfig,
  type AgentRouterUsage,
  type SecretStore,
} from "@vapi-network/core";
import { agentSecretAccounts } from "@vapi-network/core/agent-link";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { createVapiServer } from "../server.js";

const NOW = new Date("2026-09-29T12:00:00.000Z");
const API_BASE = "https://api.vapinetwork.ai";
const WORK_API_BASE = "https://work-api.example.test";
const OWNER = "0x2222222222222222222222222222222222222222" as const;
const REMOTE_ADDRESS = "0x3333333333333333333333333333333333333333" as const;
const KNOWN_PRIVATE_KEY =
  "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" as Hex;
const ACCESS_TOKEN = "access-token-that-must-stay-private";
const REFRESH_TOKEN = "refresh-token-that-must-stay-private";
const WORK_ACCESS_TOKEN = "work-access-token-that-must-stay-private";
const WORK_REFRESH_TOKEN = "work-refresh-token-that-must-stay-private";
const NO_LINK_NOTE =
  "No local account is linked. Link one with auth.link or vapi login to see accounts on other devices.";
const UNSUPPORTED_NOTE = "This vAPI server does not list siblings yet.";
const NO_STORE_MESSAGE =
  "No wallet store is available on this machine, so there are no accounts to read. Run vapi setup.";
const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("vapi.siblings", () => {
  it("returns every sibling, marks local accounts, and sends only the bearer", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fixture = await siblingsFixture({
      fetchImpl: async (input, init) => {
        requests.push({ url: String(input), ...(init === undefined ? {} : { init }) });
        return Response.json({
          owner: OWNER,
          siblings: [
            {
              name: "main",
              address: fixture.mainAddress,
              device: "this laptop",
              status: "active",
              allowance: { routerPerDayUsd: 5, perCallUsd: 0.25, perDayUsd: 1 },
              self: true,
            },
            {
              name: "remote",
              address: REMOTE_ADDRESS,
              device: "home server",
              status: "revoked",
              allowance: { routerPerDayUsd: null, perCallUsd: null, perDayUsd: null },
              self: false,
            },
          ],
        });
      },
    });

    const result = await fixture.server.callTool({
      name: "vapi.siblings",
      arguments: {},
    });

    expect(result.structuredContent).toEqual({
      owner: OWNER,
      siblings: [
        {
          name: "main",
          address: fixture.mainAddress,
          device: "this laptop",
          status: "active",
          allowance: { routerPerDayUsd: 5, perCallUsd: 0.25, perDayUsd: 1 },
          self: true,
          onThisDevice: true,
        },
        {
          name: "remote",
          address: REMOTE_ADDRESS,
          device: "home server",
          status: "revoked",
          allowance: { routerPerDayUsd: null, perCallUsd: null, perDayUsd: null },
          self: false,
          onThisDevice: false,
        },
      ],
    });
    expect(result.content).toEqual([
      { type: "text", text: JSON.stringify(result.structuredContent, null, 2) },
    ]);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(`${API_BASE}/api/agents/self/siblings`);
    expect(requests[0]?.init?.method).toBe("GET");
    expect(new Headers(requests[0]?.init?.headers).get("authorization")).toBe(
      `Bearer ${ACCESS_TOKEN}`,
    );
    expect(requests[0]?.init?.body).toBeUndefined();
    expect([...new Headers(requests[0]?.init?.headers).keys()]).toEqual(["authorization"]);
    expectSecretSafe(result, fixture);
    await fixture.server.close();
  });

  it("uses the account argument and rejects unknown or unlinked accounts", async () => {
    const requests: Array<{ url: string; authorization: string | null }> = [];
    const fixture = await siblingsFixture({
      addUnlinked: true,
      fetchImpl: async (input, init) => {
        requests.push({
          url: String(input),
          authorization: new Headers(init?.headers).get("authorization"),
        });
        return Response.json({ owner: OWNER, siblings: [] });
      },
    });

    const selected = await fixture.server.callTool({
      name: "vapi.siblings",
      arguments: { account: "work" },
    });
    const unknown = await fixture.server.callTool({
      name: "vapi.siblings",
      arguments: { account: "missing" },
    });
    const unlinked = await fixture.server.callTool({
      name: "vapi.siblings",
      arguments: { account: "local" },
    });

    expect(selected.structuredContent).toEqual({ owner: OWNER, siblings: [] });
    expect(requests).toEqual([
      {
        url: `${WORK_API_BASE}/api/agents/self/siblings`,
        authorization: `Bearer ${WORK_ACCESS_TOKEN}`,
      },
    ]);
    expect(unknown).toEqual({
      isError: true,
      content: [{ type: "text", text: "Account missing is not in the vault." }],
    });
    expect(unlinked).toEqual({
      isError: true,
      content: [
        {
          type: "text",
          text: "Account local is not linked. Link it with auth.link or vapi login.",
        },
      ],
    });
    for (const result of [selected, unknown, unlinked]) expectSecretSafe(result, fixture);
    await fixture.server.close();
  });

  it("uses the first linked account when the default account is not linked", async () => {
    const requests: Array<{ url: string; authorization: string | null }> = [];
    const fixture = await siblingsFixture({
      linkMain: false,
      fetchImpl: async (input, init) => {
        requests.push({
          url: String(input),
          authorization: new Headers(init?.headers).get("authorization"),
        });
        return Response.json({ owner: OWNER, siblings: [] });
      },
    });

    const result = await fixture.server.callTool({ name: "vapi.siblings" });

    expect(result.structuredContent).toEqual({ owner: OWNER, siblings: [] });
    expect(requests).toEqual([
      {
        url: `${WORK_API_BASE}/api/agents/self/siblings`,
        authorization: `Bearer ${WORK_ACCESS_TOKEN}`,
      },
    ]);
    expectSecretSafe(result, fixture);
    await fixture.server.close();
  });

  it("returns a note without a request when no local account is linked", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const fixture = await siblingsFixture({ linkMain: false, linkWork: false, fetchImpl });

    const result = await fixture.server.callTool({ name: "vapi.siblings" });

    expect(result.structuredContent).toEqual({
      owner: null,
      siblings: [],
      note: NO_LINK_NOTE,
    });
    expect(result.content).toEqual([
      { type: "text", text: JSON.stringify(result.structuredContent, null, 2) },
    ]);
    expect(fetchImpl).not.toHaveBeenCalled();
    expectSecretSafe(result, fixture);
    await fixture.server.close();
  });

  it("returns the unsupported note and reports a rejected request as an error", async () => {
    const unsupportedFixture = await siblingsFixture({
      fetchImpl: async () => new Response(null, { status: 404 }),
    });
    const unsupported = await unsupportedFixture.server.callTool({ name: "vapi.siblings" });

    expect(unsupported.structuredContent).toEqual({
      owner: OWNER,
      siblings: [],
      note: UNSUPPORTED_NOTE,
    });
    expectSecretSafe(unsupported, unsupportedFixture);
    await unsupportedFixture.server.close();

    const failedFixture = await siblingsFixture({
      fetchImpl: () => Promise.reject(new Error(`Bearer ${ACCESS_TOKEN}`)),
    });
    const failed = await failedFixture.server.callTool({ name: "vapi.siblings" });

    expect(failed).toEqual({
      isError: true,
      content: [{ type: "text", text: "The vAPI siblings request failed." }],
    });
    expectSecretSafe(failed, failedFixture);
    await failedFixture.server.close();
  });

  it("returns an error when no wallet store is available", async () => {
    const server = createVapiServer({
      account: privateKeyToAccount(KNOWN_PRIVATE_KEY),
      config: getDefaultConfig({}),
      fetchImpl: () => Promise.reject(new Error("The no-store test makes no network call.")),
    });

    const result = await server.callTool({ name: "vapi.siblings" });

    expect(result).toEqual({
      isError: true,
      content: [{ type: "text", text: NO_STORE_MESSAGE }],
    });
    expectSecretSafe(result, {
      recoveryPhrase: undefined,
      secrets: [ACCESS_TOKEN, REFRESH_TOKEN],
    });
    await server.close();
  });

  it("declares no secret-bearing output fields", async () => {
    const fixture = await siblingsFixture({
      fetchImpl: () => Promise.reject(new Error("The schema test makes no network call.")),
    });

    const tools = await fixture.server.listTools();
    const tool = tools.tools.find((candidate) => candidate.name === "vapi.siblings");
    const fields = schemaPropertyNames(tool?.outputSchema);

    expect(tool?.description).toContain("Read-only");
    for (const field of [
      "recoveryPhrase",
      "privateKey",
      "secretKey",
      "passphrase",
      "accessToken",
      "refreshToken",
      "token",
    ]) {
      expect(fields).not.toContain(field);
    }
    await fixture.server.close();
  });
});

async function siblingsFixture(options: {
  linkMain?: boolean;
  linkWork?: boolean;
  addUnlinked?: boolean;
  fetchImpl: typeof fetch;
}) {
  const home = await mkdtemp(join(tmpdir(), "vapi-mcp-siblings-"));
  temporaryDirectories.push(home);
  const secrets = memoryStore();
  const store = await WalletStore.open(home, { secrets, env: {}, now: () => NOW });
  const main = await store.create("main", "");
  const work = await store.importKey("work", "", KNOWN_PRIVATE_KEY);
  if (options.addUnlinked === true) await store.create("local", "");
  if (options.linkMain !== false) await store.setLink("main", linkedAccount(API_BASE, "main"));
  if (options.linkWork !== false) await store.setLink("work", linkedAccount(WORK_API_BASE, "work"));
  await setTokens(secrets, "main", ACCESS_TOKEN, REFRESH_TOKEN);
  await setTokens(secrets, "work", WORK_ACCESS_TOKEN, WORK_REFRESH_TOKEN);
  const server = createVapiServer({
    account: await store.unlock("main", ""),
    config: getDefaultConfig({}),
    store,
    wallet: "main",
    env: {},
    secretStore: secrets,
    fetchImpl: options.fetchImpl,
    agentLink: { apiBase: API_BASE },
    status: {
      usdcBalance: async () => 0n,
      routerUsage: async () => emptyUsage(),
      linkStatus: async () => "active",
      now: () => NOW,
    },
  });
  return {
    server,
    store,
    mainAddress: main.account.address,
    workAddress: work.account.address,
    recoveryPhrase: main.recoveryPhrase,
    secrets: [ACCESS_TOKEN, REFRESH_TOKEN, WORK_ACCESS_TOKEN, WORK_REFRESH_TOKEN],
  };
}

function linkedAccount(apiBase: string, clientId: string) {
  return {
    owner: OWNER,
    apiBase,
    clientId,
    label: clientId,
    scopes: ["router.use"],
    linkedAt: NOW.toISOString(),
  };
}

async function setTokens(
  secrets: SecretStore,
  account: "main" | "work",
  accessToken: string,
  refreshToken: string,
): Promise<void> {
  await secrets.set(
    agentSecretAccounts(account).tokens,
    JSON.stringify({
      accessToken,
      refreshToken,
      expiresAt: Number.MAX_SAFE_INTEGER,
      scopes: ["router.use"],
    }),
  );
}

function emptyUsage(): AgentRouterUsage {
  return {
    compute: {
      allowanceUsd: 0,
      spentTodayUsd: 0,
      remainingTodayUsd: 0,
      resetsAt: "2026-09-30T00:00:00.000Z",
      ownerLimitUsd: 0,
      ownerSpentUsd: 0,
    },
    balance: null,
  };
}

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

function expectSecretSafe(
  result: unknown,
  fixture: { recoveryPhrase?: string | undefined; secrets: string[] },
): void {
  const serialized = JSON.stringify(result);
  for (const secret of fixture.secrets) expect(serialized).not.toContain(secret);
  expect(serialized).not.toContain(KNOWN_PRIVATE_KEY);
  expect(serialized).not.toContain(KNOWN_PRIVATE_KEY.slice(2));
  if (fixture.recoveryPhrase !== undefined) {
    expect(serialized).not.toContain(fixture.recoveryPhrase);
  }
  expect(serialized).not.toMatch(/0x[0-9a-fA-F]{64}/u);
  expect(serialized).not.toMatch(/\b(?:[a-z]+ ){11}[a-z]+\b/u);
  expect(serialized).not.toMatch(/bearer\s+\S+/iu);
}

function schemaPropertyNames(schema: unknown, found = new Set<string>()): Set<string> {
  if (Array.isArray(schema)) {
    for (const item of schema) schemaPropertyNames(item, found);
    return found;
  }
  if (typeof schema !== "object" || schema === null) return found;
  for (const [key, value] of Object.entries(schema)) {
    if (key === "properties" && typeof value === "object" && value !== null) {
      for (const name of Object.keys(value)) found.add(name);
    }
    schemaPropertyNames(value, found);
  }
  return found;
}
