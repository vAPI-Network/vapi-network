import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { verifyMessage, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import {
  AGENT_LINK_STATEMENT,
  AgentLinkError,
  agentAccessToken,
  agentFetch,
  agentSecretAccounts,
  forgetAgentLink,
  pollDeviceLink,
  renameAgentLinkWallet,
  saveAgentLink,
  startDeviceLink,
  type AgentTokens,
  type DeviceLinkStart,
  type LinkResult,
} from "./agent-link.js";
import { readAuditLog } from "./audit.js";
import { DEFAULT_SPEND_CAPS } from "./config.js";
import type { SecretStore } from "./secret-store.js";
import { WalletStore, type AgentLink } from "./wallet-store.js";

const PRIVATE_KEY = "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" as Hex;
const account = privateKeyToAccount(PRIVATE_KEY);
const API_BASE = "https://api.vapinetwork.ai";
const OWNER = "0x1111111111111111111111111111111111111111" as const;
const ACCESS_TOKEN = "access-token-that-must-stay-secret";
const REFRESH_TOKEN = "refresh-token-that-must-stay-secret";
const ROUTER_KEY = "router-key-that-must-stay-secret";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function temporaryHome(prefix = "vapi-agent-link-"): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), prefix));
  directories.push(home);
  return home;
}

async function walletStore(home: string): Promise<WalletStore> {
  await writeFile(
    join(home, "wallets.json"),
    `${JSON.stringify(
      {
        version: 1,
        default: "main",
        wallets: {
          main: {
            createdAt: "2026-09-23T09:00:00.000Z",
            spendCaps: DEFAULT_SPEND_CAPS,
          },
        },
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  return await WalletStore.open(home);
}

type MemorySecretStore = SecretStore & {
  entries: Record<string, string>;
  setCalls: Array<[string, string]>;
  removeCalls: string[];
};

function memorySecretStore(
  initial: Record<string, string> = {},
  available = true,
): MemorySecretStore {
  const entries = { ...initial };
  const setCalls: Array<[string, string]> = [];
  const removeCalls: string[] = [];
  return {
    available,
    platform: available ? "darwin" : "win32",
    description: available ? "the test keychain" : "no OS secret store",
    entries,
    setCalls,
    removeCalls,
    get: async (name) => entries[name],
    has: async (name) => entries[name] !== undefined,
    set: async (name, value) => {
      setCalls.push([name, value]);
      entries[name] = value;
    },
    remove: async (name) => {
      removeCalls.push(name);
      if (entries[name] === undefined) return false;
      delete entries[name];
      return true;
    },
  };
}

function deviceStart(overrides: Partial<DeviceLinkStart> = {}): DeviceLinkStart {
  return {
    clientId: `agent_${account.address.toLowerCase()}`,
    deviceCode: "dc",
    userCode: "BCDF-GHJK",
    verificationUri: `${API_BASE}/link`,
    verificationUriComplete: `${API_BASE}/link?code=BCDF-GHJK`,
    expiresIn: 600,
    interval: 5,
    ...overrides,
  };
}

function agentLink(overrides: Partial<AgentLink> = {}): AgentLink {
  return {
    apiBase: API_BASE,
    clientId: deviceStart().clientId,
    owner: OWNER,
    label: "researcher",
    scopes: ["mcp:call", "router.use"],
    linkedAt: "2026-09-23T10:00:00.000Z",
    routerBaseUrl: "https://router.vapinetwork.ai",
    ...overrides,
  };
}

function linkResult(overrides: Partial<LinkResult> = {}): LinkResult {
  return {
    tokens: {
      accessToken: ACCESS_TOKEN,
      refreshToken: REFRESH_TOKEN,
      expiresAt: 3_600_000,
      scopes: ["mcp:call", "router.use"],
    },
    owner: OWNER,
    routerKey: ROUTER_KEY,
    routerBaseUrl: "https://router.vapinetwork.ai",
    ...overrides,
  };
}

describe("startDeviceLink", () => {
  it("signs a sign-in message bound to the API host and starts the flow", async () => {
    const calls: Array<[string, RequestInit | undefined]> = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push([String(url), init]);
      if (String(url).endsWith("/api/auth/siwe-nonce")) {
        return Response.json({ nonce: "n".repeat(108) });
      }
      return Response.json({
        device_code: "dc",
        user_code: "BCDF-GHJK",
        client_id: `agent_${account.address.toLowerCase()}`,
        verification_uri: `${API_BASE}/link`,
        verification_uri_complete: `${API_BASE}/link?code=BCDF-GHJK`,
        expires_in: 600,
        interval: 5,
      });
    }) as typeof fetch;

    const start = await startDeviceLink({
      apiBase: API_BASE,
      account,
      label: "researcher",
      fetchImpl,
      now: () => new Date("2026-09-23T10:00:00.000Z"),
    });

    expect(start.userCode).toBe("BCDF-GHJK");
    expect(calls[0]).toEqual([`${API_BASE}/api/auth/siwe-nonce`, undefined]);
    const body = JSON.parse(String(calls[1]![1]!.body)) as Record<string, unknown>;
    expect(body.agent_message).toContain(
      "api.vapinetwork.ai wants you to sign in with your Ethereum account:",
    );
    expect(body.agent_message).toContain(AGENT_LINK_STATEMENT);
    expect(
      await verifyMessage({
        address: account.address,
        message: String(body.agent_message),
        signature: body.agent_signature as Hex,
      }),
    ).toBe(true);
    expect(body.scope).toBe("mcp:call router.use");
  });

  it("rejects unsupported scopes before making a request", async () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return Response.json({});
    }) as typeof fetch;

    await expect(
      startDeviceLink({
        apiBase: API_BASE,
        account,
        label: "publisher",
        scopes: ["admin"],
        fetchImpl,
      }),
    ).rejects.toMatchObject({ code: "invalid_scope" });
    expect(called).toBe(false);
  });
});

describe("pollDeviceLink", () => {
  it("waits through pending and slow_down, then returns tokens and the owner", async () => {
    const responses = [
      Response.json({ error: "slow_down" }, { status: 400 }),
      Response.json({ error: "authorization_pending" }, { status: 400 }),
      Response.json({
        access_token: ACCESS_TOKEN,
        refresh_token: REFRESH_TOKEN,
        expires_in: 3600,
        scope: "mcp:call router.use",
        owner_wallet: OWNER,
        router_key: ROUTER_KEY,
        router_base_url: "https://router.vapinetwork.ai",
      }),
    ];
    const sleeps: number[] = [];
    const bodies: string[] = [];
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(String(init?.body));
      return responses.shift()!;
    }) as typeof fetch;

    const result = await pollDeviceLink({
      apiBase: API_BASE,
      start: deviceStart(),
      fetchImpl,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
      },
      now: () => 1_000,
    });

    expect(sleeps).toEqual([5_000, 10_000, 10_000]);
    expect(bodies[0]).toContain(
      "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code",
    );
    expect(result).toEqual({
      tokens: {
        accessToken: ACCESS_TOKEN,
        refreshToken: REFRESH_TOKEN,
        expiresAt: 3_601_000,
        scopes: ["mcp:call", "router.use"],
      },
      owner: OWNER,
      routerKey: ROUTER_KEY,
      routerBaseUrl: "https://router.vapinetwork.ai",
    });
  });

  it("throws access_denied when the owner denies", async () => {
    const fetchImpl = (async () =>
      Response.json({ error: "access_denied" }, { status: 400 })) as typeof fetch;

    await expect(
      pollDeviceLink({
        apiBase: API_BASE,
        start: deviceStart(),
        fetchImpl,
        sleep: async () => undefined,
        now: () => 1_000,
      }),
    ).rejects.toMatchObject({ code: "access_denied" });
  });
});

describe("stored agent links", () => {
  it("saves tokens in the secret store and non-secret metadata in the wallet registry", async () => {
    const home = await temporaryHome();
    const wallets = await walletStore(home);
    const secrets = memorySecretStore();

    const link = await saveAgentLink({
      secrets,
      wallets,
      wallet: "main",
      start: deviceStart(),
      result: linkResult(),
      apiBase: API_BASE,
      label: "researcher",
      home,
    });

    const accounts = agentSecretAccounts("main");
    expect(JSON.parse(secrets.entries[accounts.tokens]!)).toEqual(linkResult().tokens);
    expect(secrets.entries[accounts.routerStake]).toBe(ROUTER_KEY);
    expect(link).toMatchObject({ owner: OWNER, routerBaseUrl: "https://router.vapinetwork.ai" });
    expect((await WalletStore.open(home)).entry("main")?.link).toEqual(link);
    expect(await readAuditLog(home)).toEqual([
      expect.objectContaining({ event: "agent.linked", wallet: "main", owner: OWNER }),
    ]);
    expect(await readFile(join(home, "audit.log"), "utf8")).not.toContain(ACCESS_TOKEN);
    expect(await readFile(join(home, "wallets.json"), "utf8")).not.toContain(ROUTER_KEY);
  });

  it("refuses to save a link when no secret store is available", async () => {
    const home = await temporaryHome();
    const wallets = await walletStore(home);
    const secrets = memorySecretStore({}, false);

    await expect(
      saveAgentLink({
        secrets,
        wallets,
        wallet: "main",
        start: deviceStart(),
        result: linkResult(),
        apiBase: API_BASE,
        label: "researcher",
        home,
      }),
    ).rejects.toThrow("cannot be stored safely");

    expect(secrets.setCalls).toEqual([]);
    expect(wallets.entry("main")?.link).toBeUndefined();
    expect(await readAuditLog(home)).toEqual([]);
  });

  it("rolls back tokens and metadata when a relink credential write fails", async () => {
    const home = await temporaryHome();
    const wallets = await walletStore(home);
    const previousLink = agentLink();
    await wallets.setLink("main", previousLink);
    const accounts = agentSecretAccounts("main");
    const oldTokens = JSON.stringify({
      ...linkResult().tokens,
      accessToken: "old-access",
      refreshToken: "old-refresh",
    });
    const secrets = memorySecretStore({
      [accounts.tokens]: oldTokens,
      [accounts.routerStake]: "old-router-key",
      [accounts.routerBalance]: "old-balance-key",
    });
    const set = secrets.set.bind(secrets);
    secrets.set = async (name, value) => {
      if (name === accounts.routerStake && value === "new-router-key") {
        throw new Error("injected keychain failure");
      }
      await set(name, value);
    };

    await expect(
      saveAgentLink({
        secrets,
        wallets,
        wallet: "main",
        start: deviceStart(),
        result: linkResult({
          owner: "0x2222222222222222222222222222222222222222",
          routerKey: "new-router-key",
          tokens: {
            ...linkResult().tokens,
            accessToken: "new-access",
            refreshToken: "new-refresh",
          },
        }),
        apiBase: API_BASE,
        label: "relinked",
        home,
      }),
    ).rejects.toThrow("could not be stored");

    expect(secrets.entries[accounts.tokens]).toBe(oldTokens);
    expect(secrets.entries[accounts.routerStake]).toBe("old-router-key");
    expect(secrets.entries[accounts.routerBalance]).toBe("old-balance-key");
    expect((await WalletStore.open(home)).entry("main")?.link).toEqual(previousLink);
    expect(await readAuditLog(home)).toEqual([]);
  });

  it("rolls back credentials when relink metadata cannot be committed", async () => {
    const home = await temporaryHome();
    const wallets = await walletStore(home);
    const previousLink = agentLink();
    await wallets.setLink("main", previousLink);
    const accounts = agentSecretAccounts("main");
    const oldTokens = JSON.stringify(linkResult().tokens);
    const secrets = memorySecretStore({
      [accounts.tokens]: oldTokens,
      [accounts.routerStake]: "old-router-key",
    });
    vi.spyOn(wallets, "setLink").mockRejectedValueOnce(new Error("injected registry failure"));

    await expect(
      saveAgentLink({
        secrets,
        wallets,
        wallet: "main",
        start: deviceStart(),
        result: linkResult({
          owner: "0x2222222222222222222222222222222222222222",
          routerKey: "new-router-key",
        }),
        apiBase: API_BASE,
        label: "relinked",
        home,
      }),
    ).rejects.toThrow("injected registry failure");

    expect(secrets.entries[accounts.tokens]).toBe(oldTokens);
    expect(secrets.entries[accounts.routerStake]).toBe("old-router-key");
    expect((await WalletStore.open(home)).entry("main")?.link).toEqual(previousLink);
  });

  it("removes Router credentials when a relink issues no new Router key", async () => {
    const home = await temporaryHome();
    const wallets = await walletStore(home);
    const previousLink = agentLink();
    await wallets.setLink("main", previousLink);
    const accounts = agentSecretAccounts("main");
    const secrets = memorySecretStore({
      [accounts.tokens]: JSON.stringify(linkResult().tokens),
      [accounts.routerStake]: "old-router-key",
      [accounts.routerBalance]: "old-balance-key",
    });

    const link = await saveAgentLink({
      secrets,
      wallets,
      wallet: "main",
      start: deviceStart(),
      result: linkResult({
        owner: "0x2222222222222222222222222222222222222222",
        routerKey: undefined,
        routerBaseUrl: undefined,
      }),
      apiBase: API_BASE,
      label: "relinked",
      home,
    });

    expect(link).not.toHaveProperty("routerBaseUrl");
    expect(secrets.entries[accounts.routerStake]).toBeUndefined();
    expect(secrets.entries[accounts.routerBalance]).toBeUndefined();
  });
});

describe("agentAccessToken", () => {
  it("refreshes an expired access token once and stores the rotated pair", async () => {
    const home = await temporaryHome();
    const wallets = await walletStore(home);
    await wallets.setLink("main", agentLink());
    const accounts = agentSecretAccounts("main");
    const oldTokens: AgentTokens = {
      accessToken: ACCESS_TOKEN,
      refreshToken: REFRESH_TOKEN,
      expiresAt: 500,
      scopes: ["mcp:call", "router.use"],
    };
    const secrets = memorySecretStore({ [accounts.tokens]: JSON.stringify(oldTokens) });
    const calls: Array<[string, RequestInit | undefined]> = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push([String(url), init]);
      return Response.json({
        access_token: "rotated-access",
        refresh_token: "rotated-refresh",
        expires_in: 7200,
        scope: "mcp:call router.use",
      });
    }) as typeof fetch;

    expect(
      await agentAccessToken({ secrets, wallets, wallet: "main", fetchImpl, now: () => 1_000 }),
    ).toBe("rotated-access");

    expect(calls).toHaveLength(1);
    expect(calls[0]![0]).toBe(`${API_BASE}/oauth/token`);
    const body = new URLSearchParams(String(calls[0]![1]?.body));
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe(REFRESH_TOKEN);
    expect(body.get("client_id")).toBe(deviceStart().clientId);
    expect(JSON.parse(secrets.entries[accounts.tokens]!)).toEqual({
      accessToken: "rotated-access",
      refreshToken: "rotated-refresh",
      expiresAt: 7_201_000,
      scopes: ["mcp:call", "router.use"],
    });
  });

  it("reports not_linked when the refresh token was revoked", async () => {
    const home = await temporaryHome();
    const wallets = await walletStore(home);
    await wallets.setLink("main", agentLink());
    const accounts = agentSecretAccounts("main");
    const secrets = memorySecretStore({
      [accounts.tokens]: JSON.stringify({
        accessToken: ACCESS_TOKEN,
        refreshToken: REFRESH_TOKEN,
        expiresAt: 0,
        scopes: ["mcp:call"],
      }),
    });
    const fetchImpl = (async () =>
      Response.json(
        { error: "invalid_grant", error_description: `revoked ${REFRESH_TOKEN}` },
        { status: 400 },
      )) as typeof fetch;

    let error: unknown;
    try {
      await agentAccessToken({ secrets, wallets, wallet: "main", fetchImpl, now: () => 1_000 });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(AgentLinkError);
    expect(error).toMatchObject({
      code: "not_linked",
      message: "This agent's link was revoked or expired. Run vapi login again.",
    });
    expect(String(error)).not.toContain(REFRESH_TOKEN);
  });

  it("single-flights concurrent refresh-token rotation", async () => {
    const home = await temporaryHome();
    const wallets = await walletStore(home);
    const link = agentLink();
    await wallets.setLink("main", link);
    const accounts = agentSecretAccounts("main");
    const secrets = memorySecretStore({
      [accounts.tokens]: JSON.stringify({
        ...linkResult().tokens,
        expiresAt: 0,
      }),
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      await gate;
      return Response.json({
        access_token: "rotated-access",
        refresh_token: "rotated-refresh",
        expires_in: 3600,
        scope: "mcp:call router.use",
      });
    });

    const first = agentAccessToken({
      secrets,
      wallets,
      wallet: "main",
      fetchImpl,
      now: () => 1_000,
    });
    const second = agentAccessToken({
      secrets,
      wallets,
      wallet: "main",
      fetchImpl,
      now: () => 1_000,
    });
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    release();

    await expect(Promise.all([first, second])).resolves.toEqual([
      "rotated-access",
      "rotated-access",
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("keeps credentials attached to each wallet when renamed names are reused", async () => {
    const home = await temporaryHome();
    const entry = {
      createdAt: "2026-09-23T09:00:00.000Z",
      spendCaps: DEFAULT_SPEND_CAPS,
    };
    await writeFile(
      join(home, "wallets.json"),
      `${JSON.stringify({ version: 1, default: "a", wallets: { a: entry, b: entry } })}\n`,
      { mode: 0o600 },
    );
    await mkdir(join(home, "wallets"), { recursive: true });
    await Promise.all(
      ["a", "b"].map(
        async (name) =>
          await writeFile(join(home, "wallets", `${name}.json`), "{}\n", { mode: 0o600 }),
      ),
    );
    const wallets = await WalletStore.open(home);
    const firstLink = agentLink({
      clientId: "agent_0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      owner: "0x1111111111111111111111111111111111111111",
    });
    const secondLink = agentLink({
      clientId: "agent_0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      owner: "0x2222222222222222222222222222222222222222",
    });
    await wallets.setLink("a", firstLink);
    await wallets.setLink("b", secondLink);
    const firstAccounts = agentSecretAccounts("a");
    const secondAccounts = agentSecretAccounts("b");
    const secrets = memorySecretStore({
      [firstAccounts.tokens]: JSON.stringify({
        ...linkResult().tokens,
        accessToken: "first-access",
        refreshToken: "first-refresh",
        expiresAt: Number.MAX_SAFE_INTEGER,
      }),
      [secondAccounts.tokens]: JSON.stringify({
        ...linkResult().tokens,
        accessToken: "second-access",
        refreshToken: "second-refresh",
        expiresAt: Number.MAX_SAFE_INTEGER,
      }),
    });

    await renameAgentLinkWallet({ secrets, wallets, from: "a", to: "a2" });
    await renameAgentLinkWallet({ secrets, wallets, from: "b", to: "a" });

    await expect(agentAccessToken({ secrets, wallets, wallet: "a2" })).resolves.toBe(
      "first-access",
    );
    await expect(agentAccessToken({ secrets, wallets, wallet: "a" })).resolves.toBe(
      "second-access",
    );
    expect(wallets.entry("a2")?.link?.owner).toBe(firstLink.owner);
    expect(wallets.entry("a")?.link?.owner).toBe(secondLink.owner);
  });
});

describe("agentFetch", () => {
  it("retries once on 401 after forcing a refresh", async () => {
    const home = await temporaryHome();
    const wallets = await walletStore(home);
    await wallets.setLink("main", agentLink());
    const accounts = agentSecretAccounts("main");
    const secrets = memorySecretStore({
      [accounts.tokens]: JSON.stringify({
        accessToken: ACCESS_TOKEN,
        refreshToken: REFRESH_TOKEN,
        expiresAt: 9_999_999,
        scopes: ["mcp:call", "router.use"],
      }),
    });
    const calls: Array<[string, string | null]> = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const authorization = new Headers(init?.headers).get("authorization");
      calls.push([String(url), authorization]);
      if (String(url).endsWith("/oauth/token")) {
        return Response.json({ access_token: "new-access", expires_in: 3600 });
      }
      if (authorization === `Bearer ${ACCESS_TOKEN}`) return new Response(null, { status: 401 });
      return Response.json({ ok: true });
    }) as typeof fetch;

    const response = await agentFetch(
      { secrets, wallets, wallet: "main", fetchImpl, now: () => 1_000 },
      `${API_BASE}/api/call/services`,
      { headers: { "x-request-id": "request-1" } },
    );

    expect(await response.json()).toEqual({ ok: true });
    expect(calls).toEqual([
      [`${API_BASE}/api/call/services`, `Bearer ${ACCESS_TOKEN}`],
      [`${API_BASE}/oauth/token`, null],
      [`${API_BASE}/api/call/services`, "Bearer new-access"],
    ]);
    expect(JSON.parse(secrets.entries[accounts.tokens]!)).toMatchObject({
      accessToken: "new-access",
      refreshToken: REFRESH_TOKEN,
    });
  });

  it("shares one forced rotation between concurrent 401 retries", async () => {
    const home = await temporaryHome();
    const wallets = await walletStore(home);
    const link = agentLink();
    await wallets.setLink("main", link);
    const accounts = agentSecretAccounts("main");
    const secrets = memorySecretStore({
      [accounts.tokens]: JSON.stringify({
        ...linkResult().tokens,
        expiresAt: Number.MAX_SAFE_INTEGER,
      }),
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let refreshes = 0;
    const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
      if (String(url).endsWith("/oauth/token")) {
        refreshes += 1;
        await gate;
        return Response.json({
          access_token: "rotated-access",
          refresh_token: "rotated-refresh",
          expires_in: 3600,
        });
      }
      const authorization = new Headers(init?.headers).get("authorization");
      return authorization === `Bearer ${ACCESS_TOKEN}`
        ? new Response(null, { status: 401 })
        : Response.json({ ok: true });
    });

    const request = () =>
      agentFetch(
        { secrets, wallets, wallet: "main", fetchImpl, now: () => 1_000 },
        `${API_BASE}/api/call/services`,
      );
    const first = request();
    const second = request();
    await vi.waitFor(() => expect(refreshes).toBe(1));
    release();
    const responses = await Promise.all([first, second]);

    await expect(
      Promise.all(responses.map(async (response) => await response.json())),
    ).resolves.toEqual([{ ok: true }, { ok: true }]);
    expect(refreshes).toBe(1);
  });
});

describe("forgetAgentLink", () => {
  it("clears local state and audits the unlink even when the remote DELETE fails", async () => {
    const home = await temporaryHome();
    const wallets = await walletStore(home);
    await wallets.setLink("main", agentLink());
    const accounts = agentSecretAccounts("main");
    const secrets = memorySecretStore({
      [accounts.tokens]: JSON.stringify({
        ...linkResult().tokens,
        expiresAt: Number.MAX_SAFE_INTEGER,
      }),
      [accounts.routerStake]: ROUTER_KEY,
      [accounts.routerBalance]: "balance-router-key",
    });
    const calls: Array<[string, RequestInit | undefined]> = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push([String(url), init]);
      throw new Error("remote unavailable");
    }) as typeof fetch;

    await expect(
      forgetAgentLink({ secrets, wallets, wallet: "main", fetchImpl, home }),
    ).resolves.toBeUndefined();

    expect(calls[0]![0]).toBe(`${API_BASE}/api/agents/self`);
    expect(calls[0]![1]?.method).toBe("DELETE");
    expect(new Headers(calls[0]![1]?.headers).get("authorization")).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(secrets.entries).toEqual({});
    expect(secrets.removeCalls).toEqual([
      accounts.tokens,
      accounts.routerStake,
      accounts.routerBalance,
    ]);
    expect(wallets.entry("main")?.link).toBeUndefined();
    expect(await readAuditLog(home)).toEqual([
      expect.objectContaining({ event: "agent.unlinked", wallet: "main", owner: OWNER }),
    ]);
    const audit = await readFile(join(home, "audit.log"), "utf8");
    expect(audit).not.toContain(ACCESS_TOKEN);
    expect(audit).not.toContain(REFRESH_TOKEN);
    expect(audit).not.toContain(ROUTER_KEY);

    await expect(
      forgetAgentLink({ secrets, wallets, wallet: "main", fetchImpl, home }),
    ).resolves.toBeUndefined();
  });
});
