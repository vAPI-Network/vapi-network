import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { agentSecretAccounts, saveAgentLink, type AgentTokens } from "./agent-link.js";
import { DEFAULT_SPEND_CAPS } from "./config.js";
import {
  DEFAULT_ROUTER_BASE_URL,
  RouterClientError,
  listRouterModels,
  ownerStake,
  rotateRouterKey,
  routerChat,
  routerCredentials,
  routerUsage,
  type RouterClientDeps,
} from "./router-client.js";
import type { SecretStore } from "./secret-store.js";
import { WalletStore, type AgentLink } from "./wallet-store.js";

const API_BASE = "https://console.example";
const ROUTER_BASE = "https://router.example/gateway/";
const ACCESS_TOKEN = "test-agent-access-token";
const ROUTER_KEY = "sk-test-router-key";
const OWNER = "0x1111111111111111111111111111111111111111" as const;
const RESET_AT = "2026-09-24T00:00:00.000Z";

const directories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

type MemorySecretStore = SecretStore & {
  entries: Record<string, string>;
  setCalls: Array<[string, string]>;
};

function memorySecretStore(
  initial: Record<string, string> = {},
  available = true,
): MemorySecretStore {
  const entries = { ...initial };
  const setCalls: Array<[string, string]> = [];
  return {
    available,
    platform: available ? "darwin" : "win32",
    description: available ? "the test keychain" : "no OS secret store",
    entries,
    setCalls,
    get: async (name) => entries[name],
    has: async (name) => entries[name] !== undefined,
    set: async (name, value) => {
      setCalls.push([name, value]);
      entries[name] = value;
    },
    remove: async (name) => {
      if (entries[name] === undefined) return false;
      delete entries[name];
      return true;
    },
  };
}

function agentLink(overrides: Partial<AgentLink> = {}): AgentLink {
  return {
    apiBase: API_BASE,
    clientId: `agent_${OWNER.toLowerCase()}`,
    owner: OWNER,
    label: "researcher",
    scopes: ["mcp:call", "router.use"],
    linkedAt: "2026-09-23T10:00:00.000Z",
    routerBaseUrl: ROUTER_BASE,
    ...overrides,
  };
}

function tokens(): AgentTokens {
  return {
    accessToken: ACCESS_TOKEN,
    refreshToken: "test-agent-refresh-token",
    expiresAt: Number.MAX_SAFE_INTEGER,
    scopes: ["mcp:call", "router.use"],
  };
}

async function walletStore(link: AgentLink | undefined): Promise<WalletStore> {
  const home = await mkdtemp(join(tmpdir(), "vapi-router-client-"));
  directories.push(home);
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
            ...(link === undefined ? {} : { link }),
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

async function linkedDeps(
  fetchImpl: typeof fetch,
  options: { link?: AgentLink; key?: string; available?: boolean } = {},
): Promise<RouterClientDeps & { secrets: MemorySecretStore }> {
  const wallets = await walletStore(options.link ?? agentLink());
  const accounts = agentSecretAccounts("main");
  const secrets = memorySecretStore(
    {
      [accounts.tokens]: JSON.stringify(tokens()),
      ...(options.key === undefined && !Object.hasOwn(options, "key")
        ? { [accounts.routerStake]: ROUTER_KEY }
        : options.key === undefined
          ? {}
          : { [accounts.routerStake]: options.key }),
    },
    options.available,
  );
  return { secrets, wallets, wallet: "main", fetchImpl };
}

function usageResponse() {
  return {
    compute: {
      allowanceUsd: 2,
      spentTodayUsd: 0.75,
      remainingTodayUsd: 1.25,
      resetsAt: RESET_AT,
      ownerLimitUsd: 5,
      ownerSpentUsd: 1.5,
    },
    balance: { purchasedUsd: 10, spentUsd: 4, remainingUsd: 6 },
  };
}

describe("routerChat", () => {
  it("sends the stake key only to the Router and passes tool fields through", async () => {
    const calls: Array<{ url: URL; init?: RequestInit }> = [];
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      calls.push({ url, init });
      return Response.json({
        model: "provider/model-version",
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: { name: "get_weather", arguments: '{"city":"Utrecht"}' },
                },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 },
      });
    });
    const deps = await linkedDeps(fetchImpl);
    const tool = { type: "function", function: { name: "get_weather" } };
    const toolChoice = { type: "function", function: { name: "get_weather" } };
    const messages = [
      { role: "user" as const, content: "Weather?" },
      {
        role: "assistant" as const,
        content: "",
        tool_calls: [
          {
            id: "call_1",
            type: "function" as const,
            function: { name: "get_weather", arguments: '{"city":"Utrecht"}' },
          },
        ],
      },
      { role: "tool" as const, content: "Sunny", tool_call_id: "call_1" },
    ];

    const result = await routerChat(deps, {
      model: "provider/model",
      messages,
      max_tokens: 200,
      temperature: 0.2,
      tools: [tool],
      tool_choice: toolChoice,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url.host).toBe("router.example");
    expect(calls[0]!.url.pathname).toBe("/gateway/v1/chat/completions");
    expect(calls[0]!.init?.method).toBe("POST");
    expect(calls[0]!.init?.redirect).toBe("error");
    expect(new Headers(calls[0]!.init?.headers).get("authorization")).toBe(`Bearer ${ROUTER_KEY}`);
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({
      model: "provider/model",
      messages,
      max_tokens: 200,
      temperature: 0.2,
      tools: [tool],
      tool_choice: toolChoice,
    });
    expect(result).toEqual({
      content: null,
      toolCalls: [{ id: "call_1", name: "get_weather", arguments: '{"city":"Utrecht"}' }],
      usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 },
      model: "provider/model-version",
      keyUsed: "stake",
    });
    expect(
      calls
        .filter(({ url }) => url.host === "console.example")
        .some(
          ({ init }) => new Headers(init?.headers).get("authorization") === `Bearer ${ROUTER_KEY}`,
        ),
    ).toBe(false);
  });

  it("refuses redirects so the authorization header cannot cross hosts", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      expect(init?.redirect).toBe("error");
      return Response.json({ choices: [{ message: { content: "ok" } }] });
    });

    await expect(
      routerChat(await linkedDeps(fetchImpl), { model: "provider/model", messages: [] }),
    ).resolves.toMatchObject({ content: "ok", keyUsed: "stake" });
  });

  it("reads the Router base URL and key from one link generation", async () => {
    const calls: Array<{ url: URL; authorization: string | null }> = [];
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      calls.push({
        url: new URL(String(input)),
        authorization: new Headers(init?.headers).get("authorization"),
      });
      return Response.json({ choices: [{ message: { content: "ok" } }] });
    });
    const deps = await linkedDeps(fetchImpl);
    const oldEntry = deps.wallets.entry("main")!;
    const newKey = "sk-test-new-owner-key";
    const newLink = agentLink({
      owner: "0x2222222222222222222222222222222222222222",
      linkedAt: "2026-09-23T11:00:00.000Z",
      routerBaseUrl: "https://new-owner-router.example",
    });
    let activeLink = oldEntry.link!;
    let linkReads = 0;
    vi.spyOn(deps.wallets, "entry").mockImplementation((name) => {
      if (name !== "main") return undefined;
      const entry = { ...oldEntry, link: activeLink };
      if (linkReads++ === 0) {
        activeLink = newLink;
        deps.secrets.entries[agentSecretAccounts("main").routerStake] = newKey;
      }
      return entry;
    });

    await expect(
      routerChat(deps, { model: "provider/model", messages: [] }),
    ).resolves.toMatchObject({ content: "ok" });

    expect(calls).toEqual([
      {
        url: new URL("https://new-owner-router.example/v1/chat/completions"),
        authorization: `Bearer ${newKey}`,
      },
    ]);
  });

  it("maps a 429 to budget_exhausted with the console reset time", async () => {
    const calls: Array<{ url: URL; authorization: string | null }> = [];
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      calls.push({ url, authorization: new Headers(init?.headers).get("authorization") });
      if (url.host === "router.example") return new Response("rate limited", { status: 429 });
      if (url.pathname === "/api/agents/self/router") return Response.json(usageResponse());
      throw new Error(`Unexpected test URL ${url.origin}${url.pathname}`);
    });

    await expect(
      routerChat(await linkedDeps(fetchImpl), { model: "provider/model", messages: [] }),
    ).rejects.toMatchObject({
      name: "RouterClientError",
      code: "budget_exhausted",
      status: 429,
      message: `Today's Router allowance is used up. It resets at ${RESET_AT}.`,
    });
    expect(calls.some(({ url }) => url.host === "console.example")).toBe(true);
    expect(
      calls.some(
        ({ url, authorization }) =>
          url.host === "console.example" && authorization === `Bearer ${ROUTER_KEY}`,
      ),
    ).toBe(false);
  });

  it("maps an ExceededBudget response with another status to budget_exhausted", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      if (url.host === "router.example") {
        return new Response('{"error":"ExceededBudget"}', { status: 400 });
      }
      return Response.json(usageResponse());
    });

    await expect(
      routerChat(await linkedDeps(fetchImpl), { model: "provider/model", messages: [] }),
    ).rejects.toMatchObject({ code: "budget_exhausted", status: 400 });
  });

  it("maps a revoked key response to no_router_key", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response("revoked", { status: 401 }));

    await expect(
      routerChat(await linkedDeps(fetchImpl), { model: "provider/model", messages: [] }),
    ).rejects.toMatchObject({
      code: "no_router_key",
      status: 401,
      message: "The Router key was revoked. Run vapi router key --rotate.",
    });
  });

  it("rejects an unlinked wallet", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const wallets = await walletStore(undefined);
    const secrets = memorySecretStore();

    await expect(
      routerChat(
        { secrets, wallets, wallet: "main", fetchImpl },
        { model: "provider/model", messages: [] },
      ),
    ).rejects.toMatchObject({
      code: "not_linked",
      message: "Not linked. Run vapi login.",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects a missing Router key", async () => {
    const fetchImpl = vi.fn<typeof fetch>();

    await expect(
      routerChat(await linkedDeps(fetchImpl, { key: undefined }), {
        model: "provider/model",
        messages: [],
      }),
    ).rejects.toMatchObject({
      code: "no_router_key",
      message: "No Router key is stored for this wallet. Run vapi router key --rotate.",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects a non-https Router base before sending a request", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const deps = await linkedDeps(fetchImpl, {
      link: agentLink({ routerBaseUrl: "http://router.example" }),
    });

    await expect(routerChat(deps, { model: "provider/model", messages: [] })).rejects.toMatchObject(
      { code: "http" },
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("does not include the Router key or response body in an error", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () => new Response(`upstream failure ${ROUTER_KEY}`, { status: 503 }),
    );

    let thrown: unknown;
    try {
      await routerChat(await linkedDeps(fetchImpl), {
        model: "provider/model",
        messages: [],
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(RouterClientError);
    expect(thrown).toMatchObject({ code: "http", status: 503 });
    expect((thrown as Error).message).toBe("vAPI Router returned HTTP 503.");
    expect((thrown as Error).message).not.toContain(ROUTER_KEY);
  });
});

describe("console Router endpoints", () => {
  it("parses Router usage and owner stake contracts", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/agents/self/router") return Response.json(usageResponse());
      if (url.pathname === "/api/agents/self/stake") {
        return Response.json({
          owner: OWNER,
          epoch: 42,
          stake: "1000000000000000000",
          computeTodayUsd: 5,
          stakeUrl: "https://console.example/stake",
        });
      }
      throw new Error(`Unexpected test URL ${url.origin}${url.pathname}`);
    });
    const deps = await linkedDeps(fetchImpl);

    await expect(routerUsage(deps)).resolves.toEqual(usageResponse());
    await expect(ownerStake(deps)).resolves.toEqual({
      owner: OWNER,
      stake: "1000000000000000000",
      computeTodayUsd: 5,
      stakeUrl: "https://console.example/stake",
    });
  });

  it("maps an agentFetch not_linked error to RouterClientError", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const deps = await linkedDeps(fetchImpl);
    await deps.secrets.remove(agentSecretAccounts("main").tokens);

    await expect(routerUsage(deps)).rejects.toMatchObject({
      name: "RouterClientError",
      code: "not_linked",
      message: "Not linked. Run vapi login.",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("stores a rotated key, updates the Router base, and returns undefined", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe("/api/agents/self/router-key");
      expect(init?.method).toBe("POST");
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${ACCESS_TOKEN}`);
      expect(new Headers(init?.headers).get("authorization")).not.toBe(`Bearer ${ROUTER_KEY}`);
      return Response.json({
        router_key: "sk-test-rotated-key",
        router_base_url: "https://new-router.example/base/",
      });
    });
    const deps = await linkedDeps(fetchImpl);

    await expect(rotateRouterKey(deps)).resolves.toBeUndefined();

    const accounts = agentSecretAccounts("main");
    expect(deps.secrets.entries[accounts.routerStake]).toBe("sk-test-rotated-key");
    await deps.wallets.reload();
    expect(deps.wallets.entry("main")?.link?.routerBaseUrl).toBe(
      "https://new-router.example/base/",
    );
  });

  it("refuses an invalid rotated Router base without storing the returned key", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      Response.json({
        router_key: "sk-test-rotated-key",
        router_base_url: "https://user:password@router.example",
      }),
    );
    const deps = await linkedDeps(fetchImpl);

    await expect(rotateRouterKey(deps)).rejects.toMatchObject({ code: "http" });
    expect(deps.secrets.setCalls).toEqual([]);
    expect(deps.secrets.entries[agentSecretAccounts("main").routerStake]).toBe(ROUTER_KEY);
  });

  it("does not apply an old rotation response after the wallet is relinked", async () => {
    let rotationRequested!: () => void;
    const requestStarted = new Promise<void>((resolve) => {
      rotationRequested = resolve;
    });
    let releaseRotation!: () => void;
    const rotationGate = new Promise<void>((resolve) => {
      releaseRotation = resolve;
    });
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      if (url.pathname !== "/api/agents/self/router-key") {
        throw new Error(`Unexpected test URL ${url.origin}${url.pathname}`);
      }
      rotationRequested();
      await rotationGate;
      return Response.json({
        router_key: "sk-test-stale-rotation-key",
        router_base_url: "https://stale-router.example",
      });
    });
    const deps = await linkedDeps(fetchImpl);
    const rotation = rotateRouterKey(deps);
    await requestStarted;

    const newOwner = "0x2222222222222222222222222222222222222222" as const;
    const newRouterKey = "sk-test-new-owner-key";
    const newRouterBaseUrl = "https://new-owner-router.example";
    await saveAgentLink({
      secrets: deps.secrets,
      wallets: deps.wallets,
      wallet: "main",
      start: {
        clientId: agentLink().clientId,
        deviceCode: "new-device-code",
        userCode: "NEW-CODE",
        verificationUri: `${API_BASE}/link`,
        verificationUriComplete: `${API_BASE}/link?code=NEW-CODE`,
        expiresIn: 600,
        interval: 5,
      },
      result: {
        tokens: {
          accessToken: "new-owner-access-token",
          refreshToken: "new-owner-refresh-token",
          expiresAt: Number.MAX_SAFE_INTEGER,
          scopes: ["mcp:call", "router.use"],
        },
        owner: newOwner,
        routerKey: newRouterKey,
        routerBaseUrl: newRouterBaseUrl,
      },
      apiBase: API_BASE,
      label: "new owner",
    });
    releaseRotation();

    await expect(rotation).rejects.toMatchObject({
      code: "http",
      message: "The agent link changed during Router key rotation.",
    });
    await deps.wallets.reload();
    expect(deps.wallets.entry("main")?.link).toMatchObject({
      owner: newOwner,
      routerBaseUrl: newRouterBaseUrl,
    });
    expect(deps.secrets.entries[agentSecretAccounts("main").routerStake]).toBe(newRouterKey);
  });
});

describe("listRouterModels", () => {
  it("lists models without an Authorization header", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe(`${API_BASE}/api/router/models`);
      expect(new Headers(init?.headers).has("authorization")).toBe(false);
      return Response.json({ models: [{ id: "provider/model", context_window: 128_000 }] });
    });

    await expect(listRouterModels({ apiBase: `${API_BASE}/`, fetchImpl })).resolves.toEqual([
      { id: "provider/model", context_window: 128_000 },
    ]);
  });
});

describe("routerCredentials", () => {
  it("returns the OpenAI-compatible base URL and stored stake key", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const deps = await linkedDeps(fetchImpl, {
      link: agentLink({ routerBaseUrl: undefined }),
    });

    await expect(routerCredentials(deps)).resolves.toEqual({
      baseURL: `${DEFAULT_ROUTER_BASE_URL}/v1`,
      apiKey: ROUTER_KEY,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
