import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { WalletStore, getDefaultConfig, type SecretStore } from "@vapi-network/core";
import {
  DEFAULT_AGENT_SCOPES,
  agentSecretAccounts,
  type DeviceLinkStart,
  type LinkResult,
} from "@vapi-network/core/agent-link";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createVapiServer, type VapiServerOptions } from "../server.js";

const PASSPHRASE = "test-only-passphrase";
const API_BASE = "https://api.vapinetwork.ai/";
const USER_CODE = "BCDF-GHJK";
const DEVICE_CODE = "device-code-that-must-stay-private";
const ACCESS_TOKEN = "access-token-that-must-stay-private";
const REFRESH_TOKEN = "refresh-token-that-must-stay-private";
const ROUTER_KEY = "router-key-that-must-stay-private";
const OWNER = "0x2222222222222222222222222222222222222222" as const;
const VERIFY_URL = `${API_BASE}link?code=BCDF-GHJK`;
const temporaryDirectories: string[] = [];
type AgentLinkOverrides = NonNullable<VapiServerOptions["agentLink"]>;
type StartDeviceLink = NonNullable<AgentLinkOverrides["startDeviceLink"]>;
type PollDeviceLink = NonNullable<AgentLinkOverrides["pollDeviceLink"]>;

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("auth.link", () => {
  it("returns one reusable public code, requests only default scopes, and never exposes a secret", async () => {
    const pending = deferred<LinkResult>();
    const startDeviceLink = vi.fn<StartDeviceLink>(async () => deviceStart());
    const pollDeviceLink = vi.fn<PollDeviceLink>(async () => await pending.promise);
    const { server, account, fetchImpl } = await authServer({
      startDeviceLink,
      pollDeviceLink,
    });

    const [first, second] = await Promise.all([
      server.callTool({ name: "auth.link", arguments: {} }),
      server.callTool({ name: "auth.link", arguments: { label: "ignored" } }),
    ]);
    const status = await server.callTool({ name: "auth.status" });

    expect(first.isError).not.toBe(true);
    expect(first.content).toEqual([
      {
        type: "text",
        text: `Ask the person to open ${VERIFY_URL} and approve with their own wallet. The code is ${USER_CODE}. Then call auth.status.`,
      },
    ]);
    expect(first.structuredContent).toMatchObject({
      wallet: "main",
      address: account.address,
      userCode: USER_CODE,
      verificationUriComplete: VERIFY_URL,
      expiresAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/u),
    });
    expect(second).toEqual(first);
    expect(status.structuredContent).toMatchObject({
      wallet: "main",
      address: account.address,
      linked: false,
      pending: {
        userCode: USER_CODE,
        verificationUriComplete: VERIFY_URL,
        expiresAt: expect.any(String),
      },
    });
    expect(startDeviceLink).toHaveBeenCalledTimes(1);
    const startArgs = startDeviceLink.mock.calls[0]![0];
    expect(startArgs).toMatchObject({
      apiBase: API_BASE,
      label: "main",
      scopes: [...DEFAULT_AGENT_SCOPES],
    });
    expect(startArgs.account.address).toBe(account.address);
    expect(startArgs.fetchImpl).toBe(fetchImpl);
    expect(startArgs.scopes).not.toContain("call.publish");
    expect(pollDeviceLink).toHaveBeenCalledTimes(1);

    const serialized = JSON.stringify([first, second, status]);
    for (const secret of [DEVICE_CODE, ACCESS_TOKEN, REFRESH_TOKEN, ROUTER_KEY]) {
      expect(serialized).not.toContain(secret);
    }
    for (const field of FORBIDDEN_RESULT_FIELDS) {
      expect(schemaPropertyNames((await server.listTools()).tools)).not.toContain(field);
    }

    pending.resolve(linkResult());
    await vi.waitFor(() =>
      expect(server.callTool({ name: "auth.status" })).resolves.toMatchObject({
        structuredContent: { linked: true },
      }),
    );
    await server.close();
  });

  it("stores a completed link and reports owner, scopes and Router-key presence", async () => {
    const secrets = secretStoreStub();
    const { server, account, store } = await authServer({
      secretStore: secrets,
      startDeviceLink: vi.fn<StartDeviceLink>(async () => deviceStart()),
      pollDeviceLink: vi.fn<PollDeviceLink>(async () => linkResult()),
    });

    await server.callTool({ name: "auth.link", arguments: { label: "researcher" } });
    await vi.waitFor(() => expect(store.entry("main")?.link).toBeDefined());
    secrets.get.mockClear();
    const status = await server.callTool({ name: "auth.status" });

    expect(status.isError).not.toBe(true);
    expect(status.structuredContent).toMatchObject({
      wallet: "main",
      address: account.address,
      linked: true,
      owner: OWNER,
      label: "researcher",
      scopes: [...DEFAULT_AGENT_SCOPES],
      linkedAt: expect.any(String),
      router: true,
    });
    expect(status.structuredContent).not.toHaveProperty("pending");
    expect(JSON.stringify(status)).not.toContain(ROUTER_KEY);
    expect(secrets.get).not.toHaveBeenCalled();
    expect(secrets.has).toHaveBeenCalledWith(agentSecretAccounts("main").routerStake);
    await server.close();
  });

  it("fails before starting when no OS secret store is available", async () => {
    const startDeviceLink = vi.fn<StartDeviceLink>(async () => deviceStart());
    const { server } = await authServer({
      secretStore: secretStoreStub({}, false),
      startDeviceLink,
      pollDeviceLink: vi.fn<PollDeviceLink>(async () => linkResult()),
    });

    const result = await server.callTool({ name: "auth.link" });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("cannot be stored safely");
    expect(startDeviceLink).not.toHaveBeenCalled();
    await server.close();
  });

  it("registers only a label input and no secret-bearing output field", async () => {
    const { server } = await authServer();

    const tools = await server.listTools();
    const link = tools.tools.find((tool) => tool.name === "auth.link");
    const status = tools.tools.find((tool) => tool.name === "auth.status");
    const linkInput = link?.inputSchema as { properties?: Record<string, unknown> };

    expect(Object.keys(linkInput.properties ?? {})).toEqual(["label"]);
    expect(linkInput.properties).not.toHaveProperty("scope");
    expect(link).toHaveProperty("outputSchema");
    expect(status).toHaveProperty("outputSchema");
    for (const tool of [link, status]) {
      const fields = schemaPropertyNames(tool?.outputSchema);
      for (const field of FORBIDDEN_RESULT_FIELDS) expect(fields).not.toContain(field);
    }
    await server.close();
  });
});

describe("auth.status", () => {
  it("reports an unlinked wallet without reading a secret", async () => {
    const secrets = secretStoreStub();
    const { server, account } = await authServer({ secretStore: secrets });

    const result = await server.callTool({ name: "auth.status", arguments: { wallet: "main" } });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({
      wallet: "main",
      address: account.address,
      linked: false,
    });
    expect(secrets.get).not.toHaveBeenCalled();
    expect(secrets.has).not.toHaveBeenCalled();
    await server.close();
  });

  it("reports a non-secret background failure after clearing the pending code", async () => {
    const pending = deferred<LinkResult>();
    const { server } = await authServer({
      startDeviceLink: vi.fn<StartDeviceLink>(async () => deviceStart()),
      pollDeviceLink: vi.fn<PollDeviceLink>(async () => await pending.promise),
    });
    await server.callTool({ name: "auth.link" });

    pending.reject(new Error("The owner did not approve the link."));
    await vi.waitFor(async () => {
      const status = await server.callTool({ name: "auth.status" });
      expect(status.structuredContent).toMatchObject({
        linked: false,
        lastError: "The owner did not approve the link.",
      });
      expect(status.structuredContent).not.toHaveProperty("pending");
    });
    await server.close();
  });

  it("reloads link metadata changed by another process", async () => {
    const { server, store } = await authServer();
    const external = await WalletStore.open(store.home);
    const firstLink = {
      apiBase: API_BASE,
      clientId: deviceStart().clientId,
      owner: OWNER,
      label: "cli-login",
      scopes: [...DEFAULT_AGENT_SCOPES],
      linkedAt: "2026-09-23T10:00:00.000Z",
    };

    await external.setLink("main", firstLink);
    expect(await server.callTool({ name: "auth.status" })).toMatchObject({
      structuredContent: { linked: true, owner: OWNER, label: "cli-login" },
    });

    await external.clearLink("main");
    expect(await server.callTool({ name: "auth.status" })).toMatchObject({
      structuredContent: { linked: false },
    });

    const relinkedOwner = "0x3333333333333333333333333333333333333333";
    await external.setLink("main", {
      ...firstLink,
      owner: relinkedOwner,
      label: "cli-relink",
      scopes: ["mcp:call"],
    });
    expect(await server.callTool({ name: "auth.status" })).toMatchObject({
      structuredContent: {
        linked: true,
        owner: relinkedOwner,
        label: "cli-relink",
        scopes: ["mcp:call"],
      },
    });
    await server.close();
  });
});

const FORBIDDEN_RESULT_FIELDS = [
  "deviceCode",
  "device_code",
  "accessToken",
  "access_token",
  "refreshToken",
  "refresh_token",
  "routerKey",
  "router_key",
  "privateKey",
  "secretKey",
  "passphrase",
];

async function authServer(
  overrides: {
    secretStore?: SecretStore;
    apiBase?: string;
    startDeviceLink?: NonNullable<VapiServerOptions["agentLink"]>["startDeviceLink"];
    pollDeviceLink?: NonNullable<VapiServerOptions["agentLink"]>["pollDeviceLink"];
  } = {},
) {
  const home = await mkdtemp(join(tmpdir(), "vapi-mcp-auth-"));
  temporaryDirectories.push(home);
  const store = await WalletStore.open(home);
  const created = await store.create("main", PASSPHRASE);
  const account = created.account;
  const secretStore = overrides.secretStore ?? secretStoreStub();
  const fetchImpl = vi.fn<typeof fetch>(async () => {
    throw new Error("The auth test injected device-link functions make no network call.");
  });
  const server = createVapiServer({
    account,
    config: getDefaultConfig({}),
    store,
    wallet: "main",
    env: { VAPI_KEYSTORE_PASSWORD: PASSPHRASE },
    secretStore,
    fetchImpl,
    agentLink: {
      ...(overrides.apiBase ? { apiBase: overrides.apiBase } : {}),
      ...(overrides.startDeviceLink ? { startDeviceLink: overrides.startDeviceLink } : {}),
      ...(overrides.pollDeviceLink ? { pollDeviceLink: overrides.pollDeviceLink } : {}),
    },
  });
  return { server, account, store, secretStore, fetchImpl };
}

function deviceStart(): DeviceLinkStart {
  return {
    clientId: "agent_0x1111111111111111111111111111111111111111",
    deviceCode: DEVICE_CODE,
    userCode: USER_CODE,
    verificationUri: `${API_BASE}link`,
    verificationUriComplete: VERIFY_URL,
    expiresIn: 600,
    interval: 5,
  };
}

function linkResult(): LinkResult {
  return {
    owner: OWNER,
    tokens: {
      accessToken: ACCESS_TOKEN,
      refreshToken: REFRESH_TOKEN,
      expiresAt: Date.now() + 3_600_000,
      scopes: [...DEFAULT_AGENT_SCOPES],
    },
    routerKey: ROUTER_KEY,
    routerBaseUrl: "https://router.vapinetwork.ai",
  };
}

function secretStoreStub(
  entries: Record<string, string> = {},
  available = true,
): SecretStore & {
  get: ReturnType<typeof vi.fn<SecretStore["get"]>>;
  has: ReturnType<typeof vi.fn<SecretStore["has"]>>;
} {
  return {
    available,
    platform: available ? "darwin" : "win32",
    description: available ? "the macOS Keychain" : "no OS secret store",
    get: vi.fn(async (name) => entries[name]),
    has: vi.fn(async (name) => entries[name] !== undefined),
    set: vi.fn(async (name, value) => {
      entries[name] = value;
    }),
    remove: vi.fn(async (name) => {
      if (entries[name] === undefined) return false;
      delete entries[name];
      return true;
    }),
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

/** Every property name a JSON Schema declares, at any depth. */
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
