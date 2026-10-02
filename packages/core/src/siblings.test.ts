import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { getAddress } from "viem";

import { agentSecretAccounts, saveAgentLink } from "./agent-link.js";
import { DEFAULT_SPEND_CAPS } from "./config.js";
import type { SecretStore } from "./secret-store.js";
import { fetchSiblings, SIBLINGS_UNSUPPORTED_MESSAGE, SiblingsError } from "./siblings.js";
import { WalletStore } from "./wallet-store.js";

const API_BASE = "https://api.vapinetwork.ai";
const ACCESS_TOKEN = "access-token-that-must-stay-secret";
const REFRESH_TOKEN = "refresh-token-that-must-stay-secret";
const PRIVATE_KEY = `0x${"12".repeat(32)}`;
const OWNER = "0x8617e340b3d01fa5f11f306f4090fd50e238070d";
const SIBLING_ADDRESS = "0x52908400098527886e0f7030069857d2e4169ee7";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("fetchSiblings", () => {
  it("parses, normalizes, and strips a valid siblings response", async () => {
    const fixture = await linkedFixture();
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      Response.json({
        owner: OWNER,
        siblings: [
          {
            name: "researcher",
            address: SIBLING_ADDRESS,
            device: null,
            status: "active",
            allowance: {
              routerPerDayUsd: null,
              perCallUsd: 0.25,
              perDayUsd: null,
              ignored: "not returned",
            },
            self: false,
            ignored: "not returned",
          },
        ],
        ignored: "not returned",
      }),
    );

    await expect(
      fetchSiblings({
        apiBase: `${API_BASE}/`,
        account: "main",
        secrets: fixture.secrets,
        wallets: fixture.wallets,
        fetchImpl,
        now: () => 1_000,
      }),
    ).resolves.toEqual({
      owner: getAddress(OWNER),
      siblings: [
        {
          name: "researcher",
          address: getAddress(SIBLING_ADDRESS),
          device: null,
          status: "active",
          allowance: { routerPerDayUsd: null, perCallUsd: 0.25, perDayUsd: null },
          self: false,
        },
      ],
      source: { account: "main" },
    });
  });

  it.each([
    ["non-JSON", () => new Response("not-json")],
    ["missing siblings", () => Response.json({ owner: null })],
    ["invalid address", () => Response.json(validResponse({ address: "0x1234" }))],
    ["unknown status", () => Response.json(validResponse({ status: "paused" }))],
    [
      "non-finite allowance",
      () => Response.json(validResponse({ allowance: { routerPerDayUsd: Infinity } })),
    ],
  ])("rejects a %s body with a typed invalid_response error", async (_name, response) => {
    const fixture = await linkedFixture();

    await expect(
      fetchSiblings({
        apiBase: API_BASE,
        account: "main",
        secrets: fixture.secrets,
        wallets: fixture.wallets,
        fetchImpl: (async () => response()) as typeof fetch,
        now: () => 1_000,
      }),
    ).rejects.toMatchObject({
      name: "SiblingsError",
      code: "invalid_response",
      message: "The vAPI siblings response was invalid.",
    });
  });

  it("maps a 404 to the exact unsupported error", async () => {
    const fixture = await linkedFixture();

    await expect(
      fetchSiblings({
        apiBase: API_BASE,
        account: "main",
        secrets: fixture.secrets,
        wallets: fixture.wallets,
        fetchImpl: (async () => new Response(null, { status: 404 })) as typeof fetch,
        now: () => 1_000,
      }),
    ).rejects.toEqual(new SiblingsError("unsupported", SIBLINGS_UNSUPPORTED_MESSAGE, 404));
  });

  it("maps two rejected bearers to not_linked", async () => {
    const fixture = await linkedFixture();
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      if (String(input).endsWith("/oauth/token")) {
        return Response.json({ access_token: "refreshed-access", expires_in: 3_600 });
      }
      return new Response(null, { status: 401 });
    });

    await expect(
      fetchSiblings({
        apiBase: API_BASE,
        account: "main",
        secrets: fixture.secrets,
        wallets: fixture.wallets,
        fetchImpl,
        now: () => 1_000,
      }),
    ).rejects.toMatchObject({ name: "SiblingsError", code: "not_linked" });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("maps HTTP 500 and rejected fetches to typed http errors", async () => {
    const httpFixture = await linkedFixture();
    await expect(
      fetchSiblings({
        apiBase: API_BASE,
        account: "main",
        secrets: httpFixture.secrets,
        wallets: httpFixture.wallets,
        fetchImpl: (async () => new Response(null, { status: 500 })) as typeof fetch,
        now: () => 1_000,
      }),
    ).rejects.toMatchObject({
      name: "SiblingsError",
      code: "http",
      status: 500,
      message: "The vAPI siblings request returned HTTP 500.",
    });

    const rejectedFixture = await linkedFixture();
    await expect(
      fetchSiblings({
        apiBase: API_BASE,
        account: "main",
        secrets: rejectedFixture.secrets,
        wallets: rejectedFixture.wallets,
        fetchImpl: (async () => {
          throw new Error(`network failed with ${ACCESS_TOKEN} ${REFRESH_TOKEN}`);
        }) as typeof fetch,
        now: () => 1_000,
      }),
    ).rejects.toMatchObject({
      name: "SiblingsError",
      code: "http",
      message: "The vAPI siblings request failed.",
    });
  });

  it("ends a stalled request at its deadline and releases the credential lock", async () => {
    const fixture = await linkedFixture();
    const stalled = ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })) as typeof fetch;

    await expect(
      fetchSiblings({
        apiBase: API_BASE,
        account: "main",
        secrets: fixture.secrets,
        wallets: fixture.wallets,
        fetchImpl: stalled,
        now: () => 1_000,
        timeoutMs: 50,
      }),
    ).rejects.toMatchObject({ name: "SiblingsError", code: "http" });

    // A second call gets the lock at once, so the first one released it.
    await expect(
      fetchSiblings({
        apiBase: API_BASE,
        account: "main",
        secrets: fixture.secrets,
        wallets: fixture.wallets,
        fetchImpl: (async () => new Response(null, { status: 404 })) as typeof fetch,
        now: () => 1_000,
      }),
    ).rejects.toMatchObject({ code: "unsupported" });
  });

  it("sends only an empty GET and the bearer to the exact siblings URL", async () => {
    const fixture = await linkedFixture();
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return Response.json(validResponse());
    }) as typeof fetch;

    await fetchSiblings({
      apiBase: `${API_BASE}///`,
      account: "main",
      secrets: fixture.secrets,
      wallets: fixture.wallets,
      fetchImpl,
      now: () => 1_000,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`${API_BASE}/api/agents/self/siblings`);
    expect(calls[0]?.init?.method).toBe("GET");
    expect(calls[0]?.init?.body).toBeUndefined();
    expect([...new Headers(calls[0]?.init?.headers).entries()]).toEqual([
      ["authorization", `Bearer ${ACCESS_TOKEN}`],
    ]);
    const serializedRequest = JSON.stringify({
      url: calls[0]?.url,
      headers: [...new Headers(calls[0]?.init?.headers).entries()],
    });
    expect(serializedRequest).not.toContain(REFRESH_TOKEN);
    expect(serializedRequest).not.toContain(PRIVATE_KEY);
  });

  it("never sends a new link generation bearer to a stale server", async () => {
    const fixture = await linkedFixture();
    const staleApiBase = API_BASE;
    const replacementApiBase = "https://replacement.vapinetwork.ai";
    await saveAgentLink({
      secrets: fixture.secrets,
      wallets: fixture.wallets,
      wallet: "main",
      start: {
        clientId: "agent_main_relinked",
        deviceCode: "replacement-device-code",
        userCode: "BCDF-GHJK",
        verificationUri: `${replacementApiBase}/link`,
        verificationUriComplete: `${replacementApiBase}/link?code=BCDF-GHJK`,
        expiresIn: 600,
        interval: 5,
        autoApproved: false,
      },
      result: {
        owner: getAddress(OWNER),
        tokens: {
          accessToken: "replacement-access-token",
          refreshToken: "replacement-refresh-token",
          expiresAt: Number.MAX_SAFE_INTEGER,
          scopes: ["mcp:call", "router.use"],
        },
      },
      apiBase: replacementApiBase,
      label: "main",
    });
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json(validResponse()));

    await expect(
      fetchSiblings({
        apiBase: staleApiBase,
        account: "main",
        secrets: fixture.secrets,
        wallets: fixture.wallets,
        fetchImpl,
        now: () => 1_000,
      }),
    ).rejects.toMatchObject({
      name: "SiblingsError",
      code: "not_linked",
      message: "The selected account is not linked to this vAPI server.",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

async function linkedFixture(): Promise<{ wallets: WalletStore; secrets: SecretStore }> {
  const home = await mkdtemp(join(tmpdir(), "vapi-siblings-"));
  directories.push(home);
  await writeFile(
    join(home, "wallets.json"),
    `${JSON.stringify({
      version: 1,
      default: "main",
      wallets: {
        main: {
          createdAt: "2026-09-23T09:00:00.000Z",
          spendCaps: DEFAULT_SPEND_CAPS,
        },
      },
    })}\n`,
    { mode: 0o600 },
  );
  const entries: Record<string, string> = {};
  const secrets = memorySecretStore(entries);
  const wallets = await WalletStore.open(home, { secrets });
  await wallets.setLink("main", {
    apiBase: API_BASE,
    clientId: "agent_main",
    owner: getAddress(OWNER),
    label: "main",
    scopes: ["mcp:call", "router.use"],
    linkedAt: "2026-09-23T10:00:00.000Z",
  });
  entries[agentSecretAccounts("main").tokens] = JSON.stringify({
    accessToken: ACCESS_TOKEN,
    refreshToken: REFRESH_TOKEN,
    expiresAt: Number.MAX_SAFE_INTEGER,
    scopes: ["mcp:call", "router.use"],
  });
  return { wallets, secrets };
}

function memorySecretStore(entries: Record<string, string>): SecretStore {
  return {
    available: true,
    platform: "darwin",
    description: "the test keychain",
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

function validResponse(siblingOverrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    owner: OWNER,
    siblings: [
      {
        name: "researcher",
        address: SIBLING_ADDRESS,
        device: "lab-laptop",
        status: "active",
        allowance: { routerPerDayUsd: 20, perCallUsd: 1, perDayUsd: 5 },
        self: false,
        ...siblingOverrides,
      },
    ],
  };
}
