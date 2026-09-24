import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { type SecretStore, WalletStore } from "@vapi-network/core";
import {
  AGENT_LINK_REVOKED_MESSAGE,
  AgentLinkError,
  agentSecretAccounts,
  type DeviceLinkStart,
  type LinkResult,
  type pollDeviceLink,
  type startDeviceLink,
} from "@vapi-network/core/agent-link";

import { runCli, type CliDependencies, type CliIo } from "./cli.js";

const PASSPHRASE = "test-only-passphrase";
const ACCESS_TOKEN = "access-token-that-must-stay-secret";
const REFRESH_TOKEN = "refresh-token-that-must-stay-secret";
const ROUTER_KEY = "router-key-that-must-stay-secret";
const OWNER = "0x1111111111111111111111111111111111111111" as const;
const START: DeviceLinkStart = {
  clientId: "agent_0xresearcher",
  deviceCode: "device-code-that-must-stay-secret",
  userCode: "BCDF-GHJK",
  verificationUri: "https://api.vapinetwork.ai/link",
  verificationUriComplete: "https://api.vapinetwork.ai/link?code=BCDF-GHJK",
  expiresIn: 600,
  interval: 5,
};
const RESULT: LinkResult = {
  tokens: {
    accessToken: ACCESS_TOKEN,
    refreshToken: REFRESH_TOKEN,
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
  restoreEnvironment("VAPI_HOME", originalHome);
  restoreEnvironment("VAPI_KEYSTORE_PASSWORD", originalPassword);
  await Promise.all(homes.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("vapi login", () => {
  it("links a wallet, opens the approval page for a person, and requests default scopes", async () => {
    await initializedHome();
    const entries: Record<string, string> = {};
    const secretStore = secretStoreStub(entries);
    const start = vi.fn<typeof startDeviceLink>(async () => START);
    const poll = vi.fn<typeof pollDeviceLink>(async () => RESULT);
    const openUrl = vi.fn(() => true);
    const captured = captureIo();

    expect(
      await runCli(["login", "--wallet", "researcher"], captured.io, {
        interactive: true,
        env: {},
        secretStore,
        agentLink: { startDeviceLink: start, pollDeviceLink: poll },
        openUrl,
      }),
    ).toBe(0);

    expect(start).toHaveBeenCalledOnce();
    expect(start.mock.calls[0]![0]).toMatchObject({
      apiBase: "https://api.vapinetwork.ai/",
      label: "researcher",
      scopes: ["mcp:call", "router.use"],
    });
    expect(openUrl).toHaveBeenCalledWith(START.verificationUriComplete);
    const text = allOutput(captured);
    expect(text).toContain("Link this agent to your vAPI account");
    expect(text).toContain("Agent wallet  researcher");
    expect(text).toContain("Code          BCDF-GHJK");
    expect(text).toContain(`Linked researcher to 0x1111…1111.`);
    expect(text).toContain("Router key stored in the macOS Keychain.");
    expectNoSecrets(text);
    expect(entries[agentSecretAccounts("researcher").tokens]).toContain(ACCESS_TOKEN);
    expect(entries[agentSecretAccounts("researcher").routerStake]).toBe(ROUTER_KEY);
  });

  it("keeps JSON clean, requests publish permission only with --publish, and prints no secret", async () => {
    await initializedHome();
    const start = vi.fn<typeof startDeviceLink>(async () => START);
    const poll = vi.fn<typeof pollDeviceLink>(async () => ({
      ...RESULT,
      tokens: { ...RESULT.tokens, scopes: [...RESULT.tokens.scopes, "call.publish"] },
    }));
    const captured = captureIo();

    expect(
      await runCli(
        ["login", "--wallet", "researcher", "--label", "publisher", "--publish", "--json"],
        captured.io,
        {
          interactive: true,
          env: {},
          secretStore: secretStoreStub(),
          agentLink: { startDeviceLink: start, pollDeviceLink: poll },
          openUrl: vi.fn(() => true),
        },
      ),
    ).toBe(0);

    expect(start.mock.calls[0]![0]).toMatchObject({
      label: "publisher",
      scopes: ["mcp:call", "router.use", "call.publish"],
    });
    expect(captured.stdout).toHaveLength(1);
    expect(JSON.parse(captured.stdout[0]!)).toEqual({
      wallet: "researcher",
      agentWallet: expect.stringMatching(/^0x[0-9a-fA-F]{40}$/u),
      owner: OWNER,
      scopes: ["mcp:call", "router.use", "call.publish"],
      router: true,
    });
    expect(captured.stderr.join("\n")).toContain("Link this agent to your vAPI account");
    expectNoSecrets(allOutput(captured));
  });

  it("does not open a browser for an agent marker or --no-browser", async () => {
    await initializedHome();
    const openUrl = vi.fn(() => true);
    const dependencies = linkDependencies({
      interactive: true,
      env: { CLAUDECODE: "1" },
      openUrl,
    });

    expect(await runCli(["login", "--wallet", "researcher"], captureIo().io, dependencies)).toBe(0);
    expect(openUrl).not.toHaveBeenCalled();

    expect(
      await runCli(["login", "--wallet", "researcher", "--no-browser"], captureIo().io, {
        ...dependencies,
        env: {},
      }),
    ).toBe(0);
    expect(openUrl).not.toHaveBeenCalled();
  });

  it("reports a missing Router key without exposing the service error", async () => {
    await initializedHome();
    const captured = captureIo();
    const serviceError = "router-service-detail-that-must-not-be-printed";

    expect(
      await runCli(["login", "--wallet", "researcher", "--no-browser"], captured.io, {
        ...linkDependencies(),
        agentLink: {
          startDeviceLink: async () => START,
          pollDeviceLink: async () => ({
            ...RESULT,
            routerKey: undefined,
            routerBaseUrl: undefined,
            routerKeyError: serviceError,
          }),
        },
      }),
    ).toBe(0);

    const text = allOutput(captured);
    expect(text).toContain(
      "vAPI Router is not available right now; run vapi router key --rotate later.",
    );
    expect(text).not.toContain(serviceError);
    expectNoSecrets(text);
  });

  it.each([
    ["access_denied", "The owner denied the agent link."],
    ["expired_token", "The agent link request expired. Run vapi login again."],
  ] as const)("reports %s without leaking credentials", async (code, message) => {
    await initializedHome();
    const captured = captureIo();
    const poll = vi.fn<typeof pollDeviceLink>(async () => {
      throw new AgentLinkError(code, message);
    });

    expect(
      await runCli(["login", "--wallet", "researcher", "--json"], captured.io, {
        ...linkDependencies(),
        agentLink: { startDeviceLink: async () => START, pollDeviceLink: poll },
      }),
    ).toBe(1);
    expect(JSON.parse(captured.stdout[0]!)).toEqual({ error: message, exitCode: 1 });
    expectNoSecrets(allOutput(captured));
  });
});

describe("vapi whoami and logout", () => {
  it("reports a revoked link when logout is rejected by the console", async () => {
    await initializedHome();
    const entries: Record<string, string> = {};
    const store = secretStoreStub(entries);
    expect(
      await runCli(["login", "--wallet", "researcher", "--no-browser"], captureIo().io, {
        ...linkDependencies(),
        secretStore: store,
      }),
    ).toBe(0);
    const captured = captureIo();
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname === "/api/agents/self") return new Response(null, { status: 401 });
      if (url.pathname === "/oauth/token") {
        return Response.json({ error: "invalid_grant" }, { status: 400 });
      }
      throw new Error(`Unexpected test URL ${url.origin}${url.pathname}`);
    });

    expect(
      await runCli(["logout", "--wallet", "researcher"], captured.io, {
        interactive: false,
        env: {},
        secretStore: store,
        fetchImpl,
      }),
    ).toBe(1);
    expect(captured.stdout).toEqual([]);
    expect(captured.stderr).toEqual([AGENT_LINK_REVOKED_MESSAGE]);
    expectNoSecrets(allOutput(captured));
  });

  it("reports an unlinked wallet without unlocking it", async () => {
    await initializedHome();
    delete process.env.VAPI_KEYSTORE_PASSWORD;
    const captured = captureIo();
    const fetchImpl = vi.fn<typeof fetch>();

    expect(
      await runCli(["whoami", "--wallet", "researcher"], captured.io, {
        interactive: false,
        env: {},
        secretStore: secretStoreStub(),
        fetchImpl,
      }),
    ).toBe(0);
    expect(captured.stdout.join("\n")).toContain("Not linked. Run vapi login.");
    expect(fetchImpl).not.toHaveBeenCalled();
    expectNoSecrets(allOutput(captured));
  });

  it("shows linked identity, Router key presence, and an active status", async () => {
    await initializedHome();
    const entries: Record<string, string> = {};
    const store = secretStoreStub(entries);
    expect(
      await runCli(["login", "--wallet", "researcher", "--no-browser"], captureIo().io, {
        ...linkDependencies(),
        secretStore: store,
      }),
    ).toBe(0);
    delete process.env.VAPI_KEYSTORE_PASSWORD;
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(null, { status: 200 }));
    const captured = captureIo();

    expect(
      await runCli(["whoami", "--wallet", "researcher"], captured.io, {
        interactive: false,
        env: {},
        secretStore: store,
        fetchImpl,
      }),
    ).toBe(0);

    const text = captured.stdout.join("\n");
    expect(text).toContain(`Owner: ${OWNER}`);
    expect(text).toContain("Label: researcher");
    expect(text).toContain("Permissions: mcp:call router.use");
    expect(text).toContain("Router key: stored");
    expect(text).toContain("Status: active");
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("https://api.vapinetwork.ai/api/agents/self");
    expect(fetchImpl.mock.calls[0]?.[1]?.method).toBe("GET");
    expectNoSecrets(allOutput(captured));

    const json = captureIo();
    expect(
      await runCli(["whoami", "--wallet", "researcher", "--json"], json.io, {
        interactive: false,
        env: {},
        secretStore: store,
        fetchImpl,
      }),
    ).toBe(0);
    expect(JSON.parse(json.stdout[0]!)).toMatchObject({
      wallet: "researcher",
      address: expect.stringMatching(/^0x[0-9a-fA-F]{40}$/u),
      linked: true,
      owner: OWNER,
      label: "researcher",
      scopes: ["mcp:call", "router.use"],
      linkedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/u),
      routerKey: "stored",
      status: "active",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[1]?.[0]).toBe("https://api.vapinetwork.ai/api/agents/self");
    expect(fetchImpl.mock.calls[1]?.[1]?.method).toBe("GET");
    expectNoSecrets(allOutput(json));
  });

  it("reports a revoked status after the console rejects the refresh grant", async () => {
    await initializedHome();
    const entries: Record<string, string> = {};
    const store = secretStoreStub(entries);
    expect(
      await runCli(["login", "--wallet", "researcher", "--no-browser"], captureIo().io, {
        ...linkDependencies(),
        secretStore: store,
      }),
    ).toBe(0);
    delete process.env.VAPI_KEYSTORE_PASSWORD;
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname === "/api/agents/self") return new Response(null, { status: 401 });
      if (url.pathname === "/oauth/token") {
        return Response.json({ error: "invalid_grant" }, { status: 400 });
      }
      throw new Error("unexpected test request");
    });
    const captured = captureIo();

    expect(
      await runCli(["whoami", "--wallet", "researcher"], captured.io, {
        interactive: false,
        env: {},
        secretStore: store,
        fetchImpl,
      }),
    ).toBe(0);

    expect(captured.stdout.join("\n")).toContain(
      "Status: revoked or expired on the server. Run vapi login to link again.",
    );
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("https://api.vapinetwork.ai/api/agents/self");
    expect(fetchImpl.mock.calls[0]?.[1]?.method).toBe("GET");
    expectNoSecrets(allOutput(captured));

    const json = captureIo();
    expect(
      await runCli(["whoami", "--wallet", "researcher", "--json"], json.io, {
        interactive: false,
        env: {},
        secretStore: store,
        fetchImpl,
      }),
    ).toBe(0);
    expect(JSON.parse(json.stdout[0]!)).toMatchObject({ status: "revoked" });
    expect(fetchImpl.mock.calls[2]?.[0]).toBe("https://api.vapinetwork.ai/api/agents/self");
    expect(fetchImpl.mock.calls[2]?.[1]?.method).toBe("GET");
    expectNoSecrets(allOutput(json));
  });

  it("reports an unknown status when the console does not support the endpoint", async () => {
    await initializedHome();
    const entries: Record<string, string> = {};
    const store = secretStoreStub(entries);
    expect(
      await runCli(["login", "--wallet", "researcher", "--no-browser"], captureIo().io, {
        ...linkDependencies(),
        secretStore: store,
      }),
    ).toBe(0);
    delete process.env.VAPI_KEYSTORE_PASSWORD;
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(null, { status: 404 }));
    const captured = captureIo();

    expect(
      await runCli(["whoami", "--wallet", "researcher"], captured.io, {
        interactive: false,
        env: {},
        secretStore: store,
        fetchImpl,
      }),
    ).toBe(0);
    expect(captured.stdout.join("\n")).toContain(
      "Status: not checked (this console does not support it yet)",
    );
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("https://api.vapinetwork.ai/api/agents/self");
    expect(fetchImpl.mock.calls[0]?.[1]?.method).toBe("GET");
    expectNoSecrets(allOutput(captured));

    const json = captureIo();
    expect(
      await runCli(["whoami", "--wallet", "researcher", "--json"], json.io, {
        interactive: false,
        env: {},
        secretStore: store,
        fetchImpl,
      }),
    ).toBe(0);
    expect(JSON.parse(json.stdout[0]!)).toMatchObject({ status: "unknown" });
    expect(fetchImpl.mock.calls[1]?.[0]).toBe("https://api.vapinetwork.ai/api/agents/self");
    expect(fetchImpl.mock.calls[1]?.[1]?.method).toBe("GET");
    expectNoSecrets(allOutput(json));
  });

  it("reports an unknown status without exposing a network error", async () => {
    await initializedHome();
    const entries: Record<string, string> = {};
    const store = secretStoreStub(entries);
    expect(
      await runCli(["login", "--wallet", "researcher", "--no-browser"], captureIo().io, {
        ...linkDependencies(),
        secretStore: store,
      }),
    ).toBe(0);
    delete process.env.VAPI_KEYSTORE_PASSWORD;
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      throw new TypeError("network detail with https://token:secret@example.test");
    });
    const captured = captureIo();

    expect(
      await runCli(["whoami", "--wallet", "researcher"], captured.io, {
        interactive: false,
        env: {},
        secretStore: store,
        fetchImpl,
      }),
    ).toBe(0);
    const text = allOutput(captured);
    expect(text).toContain("Status: could not check (network error)");
    expect(text).not.toContain("token:secret@example.test");
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("https://api.vapinetwork.ai/api/agents/self");
    expect(fetchImpl.mock.calls[0]?.[1]?.method).toBe("GET");
    expectNoSecrets(allOutput(captured));
  });

  it("unlinks the wallet and removes its local agent credentials", async () => {
    const home = await initializedHome();
    const entries: Record<string, string> = {};
    const store = secretStoreStub(entries);
    expect(
      await runCli(["login", "--wallet", "researcher", "--no-browser"], captureIo().io, {
        ...linkDependencies(),
        secretStore: store,
      }),
    ).toBe(0);
    const captured = captureIo();

    expect(
      await runCli(["logout", "--wallet", "researcher", "--json"], captured.io, {
        interactive: false,
        env: {},
        secretStore: store,
        fetchImpl: vi.fn<typeof fetch>(async () => new Response(null, { status: 204 })),
      }),
    ).toBe(0);

    expect(JSON.parse(captured.stdout[0]!)).toEqual({ wallet: "researcher", unlinked: true });
    expect((await WalletStore.open(home)).entry("researcher")?.link).toBeUndefined();
    const accounts = agentSecretAccounts("researcher");
    expect(entries[accounts.tokens]).toBeUndefined();
    expect(entries[accounts.routerStake]).toBeUndefined();
    expectNoSecrets(allOutput(captured));
  });
});

function linkDependencies(overrides: Partial<CliDependencies> = {}): CliDependencies {
  return {
    interactive: false,
    env: {},
    secretStore: secretStoreStub(),
    agentLink: {
      startDeviceLink: async () => START,
      pollDeviceLink: async () => RESULT,
    },
    openUrl: () => false,
    ...overrides,
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

function allOutput(captured: { stdout: string[]; stderr: string[] }): string {
  return [...captured.stdout, ...captured.stderr].join("\n");
}

function expectNoSecrets(text: string): void {
  for (const secret of [ACCESS_TOKEN, REFRESH_TOKEN, ROUTER_KEY, PASSPHRASE, START.deviceCode]) {
    expect(text).not.toContain(secret);
  }
}

async function initializedHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "vapi-login-"));
  homes.push(home);
  process.env.VAPI_HOME = home;
  process.env.VAPI_KEYSTORE_PASSWORD = PASSPHRASE;
  expect(
    await runCli(["init", "--json"], captureIo().io, {
      interactive: false,
      env: {},
      fetchImpl: zeroBalanceRpc(),
    }),
  ).toBe(0);
  expect(
    await runCli(["wallet", "create", "researcher", "--json"], captureIo().io, {
      interactive: false,
      env: {},
    }),
  ).toBe(0);
  return home;
}

function zeroBalanceRpc() {
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
