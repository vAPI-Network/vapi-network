import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AccountCapsRaiseError,
  addAccount,
  createAccount,
  linkRouterAllowanceUsd,
  lowerAccountCaps,
  type AddAccountArgs,
} from "./account-add.js";
import {
  AgentLinkError,
  agentSecretAccounts,
  type DeviceLinkStart,
  type LinkResult,
} from "./agent-link.js";
import { DEFAULT_SPEND_CAPS } from "./config.js";
import type { SecretStore } from "./secret-store.js";
import { protectVault } from "./vault-key.js";
import { VAULT_LOCKED_MESSAGE, WalletStore } from "./wallet-store.js";

const API_BASE = "https://api.vapinetwork.ai";
const TEST_PHRASE = "test test test test test test test test test test test junk";
const DEVICE_CODE = "device-code-that-must-stay-secret";
const ACCESS_TOKEN = "access-token-that-must-stay-secret";
const REFRESH_TOKEN = "refresh-token-that-must-stay-secret";
const OWNER = "0x1111111111111111111111111111111111111111" as const;
const temporaryDirectories: string[] = [];

type MemorySecretStore = SecretStore & { entries: Record<string, string> };

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

function memorySecretStore(available = true): MemorySecretStore {
  const entries: Record<string, string> = {};
  return {
    available,
    platform: available ? "darwin" : "freebsd",
    description: available ? "the test keychain" : "no OS secret store",
    entries,
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

async function temporaryHome(prefix = "vapi-account-add-"): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(home);
  return home;
}

async function initializedStore(): Promise<{
  home: string;
  store: WalletStore;
  secrets: MemorySecretStore;
}> {
  const home = await temporaryHome();
  const secrets = memorySecretStore();
  const store = await WalletStore.open(home, { secrets, env: {} });
  await store.create("main", "", { phrase: TEST_PHRASE });
  return { home, store, secrets };
}

function deviceStart(overrides: Partial<DeviceLinkStart> = {}): DeviceLinkStart {
  return {
    clientId: "agent_research",
    deviceCode: DEVICE_CODE,
    userCode: "BCDF-GHJK",
    verificationUri: `${API_BASE}/link`,
    verificationUriComplete: `${API_BASE}/link?code=BCDF-GHJK`,
    expiresIn: 600,
    interval: 5,
    autoApproved: false,
    ...overrides,
  };
}

function linkResult(): LinkResult {
  return {
    owner: OWNER,
    tokens: {
      accessToken: ACCESS_TOKEN,
      refreshToken: REFRESH_TOKEN,
      expiresAt: 3_600_000,
      scopes: ["mcp:call", "router.use"],
    },
  };
}

async function linkMainAccount(store: WalletStore, secrets: MemorySecretStore): Promise<void> {
  await store.setLink("main", {
    apiBase: API_BASE,
    clientId: "agent_main",
    owner: OWNER,
    label: "main",
    scopes: ["mcp:call", "router.use"],
    linkedAt: "2026-09-29T10:00:00.000Z",
  });
  await secrets.set(
    agentSecretAccounts("main").tokens,
    JSON.stringify({
      accessToken: ACCESS_TOKEN,
      refreshToken: REFRESH_TOKEN,
      expiresAt: 3_600_000,
      scopes: ["mcp:call", "router.use"],
    }),
  );
}

describe("linkRouterAllowanceUsd", () => {
  it("omits the allowance when router.use is not requested", () => {
    expect(
      linkRouterAllowanceUsd({
        scopes: ["mcp:call"],
        explicitUsd: 5,
        perDayCapUsd: 2,
        trusted: true,
      }),
    ).toBeUndefined();
  });

  it("uses an explicit allowance for trusted and untrusted links", () => {
    expect(
      linkRouterAllowanceUsd({
        scopes: ["router.use"],
        explicitUsd: 3,
        perDayCapUsd: 2,
        trusted: true,
      }),
    ).toBe(3);
    expect(
      linkRouterAllowanceUsd({
        scopes: ["router.use"],
        explicitUsd: 3,
        perDayCapUsd: 2,
        trusted: false,
      }),
    ).toBe(3);
  });

  it("uses the per-day cap for a trusted link without an explicit allowance", () => {
    expect(
      linkRouterAllowanceUsd({
        scopes: ["router.use"],
        perDayCapUsd: 2,
        trusted: true,
      }),
    ).toBe(2);
  });

  it("omits an implicit allowance for an untrusted link", () => {
    expect(
      linkRouterAllowanceUsd({
        scopes: ["router.use"],
        perDayCapUsd: 2,
        trusted: false,
      }),
    ).toBeUndefined();
  });

  it("uses the exact trusted per-day cap below whole-cent precision", () => {
    expect(
      linkRouterAllowanceUsd({
        scopes: ["router.use"],
        perDayCapUsd: "1.239999",
        trusted: true,
      }),
    ).toBe(1.239999);
    expect(
      linkRouterAllowanceUsd({
        scopes: ["router.use"],
        perDayCapUsd: 0.004,
        trusted: true,
      }),
    ).toBe(0.004);
  });
});

describe("createAccount", () => {
  it("uses the default caps when none are supplied", async () => {
    const { store } = await initializedStore();

    await expect(createAccount({ store, name: "research" })).resolves.toMatchObject({
      account: "research",
      address: expect.stringMatching(/^0x[0-9a-fA-F]{40}$/u),
      caps: { perCallUsd: "0.1", perDayUsd: "1" },
      created: true,
    });
    expect(store.entry("research")?.spendCaps).toEqual(DEFAULT_SPEND_CAPS);
  });

  it("lowers the default per-call cap when only a smaller per-day cap is supplied", async () => {
    const { store } = await initializedStore();

    const created = await createAccount({
      store,
      name: "research",
      caps: { perDayUsd: "0.05" },
    });

    expect(created.caps).toEqual({ perCallUsd: "0.05", perDayUsd: "0.05" });
    expect(store.entry("research")?.spendCaps).toEqual({
      perCallAtomic: "50000",
      perDayAtomic: "50000",
    });
  });

  it("refuses to create an account when there is no vault", async () => {
    const home = await temporaryHome();
    const store = await WalletStore.open(home, { secrets: memorySecretStore(), env: {} });

    await expect(createAccount({ store, name: "research" })).rejects.toThrow(
      "No vault yet. Run vapi setup.",
    );
    await expect(stat(join(home, "vault.json"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(store.has("research")).toBe(false);
  });

  it("refuses a password-protected locked vault without registering the account", async () => {
    const { home, secrets } = await initializedStore();
    await protectVault({
      path: join(home, "vault.json"),
      secrets,
      password: "test-vault-password",
      env: {},
    });
    const locked = await WalletStore.open(home, { secrets, env: {} });

    await expect(createAccount({ store: locked, name: "research" })).rejects.toMatchObject({
      name: "KeystoreError",
      message: VAULT_LOCKED_MESSAGE,
    });
    await locked.reload();
    expect(locked.has("research")).toBe(false);
  });

  it("returns an existing account without changing the vault or registry", async () => {
    const { home, store } = await initializedStore();
    const first = await createAccount({
      store,
      name: "research",
      caps: { perCallUsd: "0.02", perDayUsd: "0.2" },
      existing: "return",
    });
    const registryBefore = await readFile(join(home, "wallets.json"), "utf8");
    const vaultBefore = await readFile(join(home, "vault.json"), "utf8");

    const second = await createAccount({
      store,
      name: "research",
      caps: { perCallUsd: "0.01", perDayUsd: "0.1" },
      existing: "return",
    });

    expect(first.created).toBe(true);
    expect(second).toMatchObject({
      account: "research",
      address: first.address,
      caps: { perCallUsd: "0.02", perDayUsd: "0.2" },
      created: false,
    });
    expect(await readFile(join(home, "wallets.json"), "utf8")).toBe(registryBefore);
    expect(await readFile(join(home, "vault.json"), "utf8")).toBe(vaultBefore);
  });
});

describe("addAccount", () => {
  it("passes the trusted bearer and per-day cap as the router allowance", async () => {
    const { store, secrets } = await initializedStore();
    await linkMainAccount(store, secrets);
    let request: Parameters<NonNullable<AddAccountArgs["startDeviceLink"]>>[0] | undefined;

    const result = await addAccount({
      store,
      secrets,
      name: "research",
      caps: { perDayUsd: 2 },
      apiBase: API_BASE,
      env: {},
      hostname: "Test Host",
      now: () => 1_000,
      startDeviceLink: async (args) => {
        request = args;
        return deviceStart({ autoApproved: true });
      },
      pollDeviceLink: async () => linkResult(),
    });

    expect(result).toMatchObject({ linked: true, autoApproved: true });
    expect(request).toEqual(
      expect.objectContaining({
        routerAllowanceUsd: 2,
        bearer: ACCESS_TOKEN,
        device: "test-host",
        trustDevice: true,
      }),
    );
  });

  it("omits the router allowance when trusted scopes exclude router.use", async () => {
    const { store, secrets } = await initializedStore();
    await linkMainAccount(store, secrets);
    let request: Parameters<NonNullable<AddAccountArgs["startDeviceLink"]>>[0] | undefined;

    await addAccount({
      store,
      secrets,
      name: "research",
      caps: { perDayUsd: 2 },
      scopes: ["mcp:call"],
      apiBase: API_BASE,
      env: {},
      hostname: "Test Host",
      now: () => 1_000,
      startDeviceLink: async (args) => {
        request = args;
        return deviceStart({ autoApproved: true });
      },
      pollDeviceLink: async () => linkResult(),
    });

    expect(request).toEqual(expect.objectContaining({ bearer: ACCESS_TOKEN }));
    expect(request).not.toHaveProperty("routerAllowanceUsd");
  });

  it("omits the router allowance without a trusted bearer or explicit value", async () => {
    const { store, secrets } = await initializedStore();
    let request: Parameters<NonNullable<AddAccountArgs["startDeviceLink"]>>[0] | undefined;

    await addAccount({
      store,
      secrets,
      name: "research",
      caps: { perDayUsd: 2 },
      apiBase: API_BASE,
      env: {},
      hostname: "Test Host",
      now: () => 1_000,
      startDeviceLink: async (args) => {
        request = args;
        return deviceStart({ autoApproved: true });
      },
      pollDeviceLink: async () => linkResult(),
    });

    expect(request).not.toHaveProperty("bearer");
    expect(request).not.toHaveProperty("routerAllowanceUsd");
  });

  it("is idempotent by name and does not rewrite the vault or registry", async () => {
    const { home, store, secrets } = await initializedStore();
    const first = await addAccount({
      store,
      secrets,
      name: "research",
      caps: { perCallUsd: "0.02", perDayUsd: "0.2" },
      existing: "return",
      link: false,
      apiBase: API_BASE,
    });
    const registryBefore = await readFile(join(home, "wallets.json"), "utf8");
    const vaultBefore = await readFile(join(home, "vault.json"), "utf8");

    const second = await addAccount({
      store,
      secrets,
      name: "research",
      caps: { perCallUsd: "0.01", perDayUsd: "0.1" },
      existing: "return",
      apiBase: API_BASE,
    });

    expect(first.created).toBe(true);
    expect(second).toMatchObject({
      account: "research",
      address: first.address,
      caps: { perCallUsd: "0.02", perDayUsd: "0.2" },
      created: false,
      linked: false,
      autoApproved: false,
    });
    expect(await readFile(join(home, "wallets.json"), "utf8")).toBe(registryBefore);
    expect(await readFile(join(home, "vault.json"), "utf8")).toBe(vaultBefore);
  });

  it("has caps on disk before the first link request", async () => {
    const { home, store, secrets } = await initializedStore();
    let requestCount = 0;
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      requestCount += 1;
      const registry = JSON.parse(await readFile(join(home, "wallets.json"), "utf8")) as {
        wallets: Record<string, { spendCaps: typeof DEFAULT_SPEND_CAPS }>;
      };
      expect(registry.wallets.research?.spendCaps).toEqual({
        perCallAtomic: "20000",
        perDayAtomic: "200000",
      });
      const url = String(input);
      if (url.includes("siwe-nonce")) return Response.json({ nonce: "n".repeat(108) });
      if (url.endsWith("/oauth/device_authorization")) {
        return Response.json({
          device_code: DEVICE_CODE,
          user_code: "BCDF-GHJK",
          client_id: "agent_research",
          verification_uri: `${API_BASE}/link`,
          verification_uri_complete: `${API_BASE}/link?code=BCDF-GHJK`,
          expires_in: 600,
          interval: 5,
          auto_approved: true,
        });
      }
      return Response.json({
        access_token: ACCESS_TOKEN,
        refresh_token: REFRESH_TOKEN,
        expires_in: 3600,
        scope: "mcp:call router.use",
        owner_wallet: OWNER,
      });
    });

    const result = await addAccount({
      store,
      secrets,
      name: "research",
      caps: { perCallUsd: "0.02", perDayUsd: "0.2" },
      apiBase: API_BASE,
      env: {},
      hostname: "Test Host",
      fetchImpl,
      now: () => 1_000,
    });

    expect(requestCount).toBe(3);
    expect(result).toMatchObject({ linked: true, autoApproved: true });
  });

  it.each([
    ["access_denied", "denied"],
    ["expired_token", "expired"],
  ] as const)(
    "keeps the capped unlinked account when background polling ends with %s",
    async (code, reason) => {
      const { store, secrets } = await initializedStore();
      const result = await addAccount({
        store,
        secrets,
        name: `research-${reason}`,
        caps: { perCallUsd: "0.03", perDayUsd: "0.3" },
        apiBase: API_BASE,
        env: {},
        hostname: "Test Host",
        startDeviceLink: async () => deviceStart(),
        pollDeviceLink: async () => {
          throw new AgentLinkError(
            code,
            code === "access_denied" ? "The owner denied the agent link." : "The link expired.",
          );
        },
      });

      await expect(result.completion).resolves.toMatchObject({ linked: false, reason });
      await store.reload();
      expect(store.entry(`research-${reason}`)).toMatchObject({
        spendCaps: { perCallAtomic: "30000", perDayAtomic: "300000" },
      });
      expect(store.entry(`research-${reason}`)?.link).toBeUndefined();
    },
  );

  it("saves an approved background link and its tokens", async () => {
    const { store, secrets } = await initializedStore();
    const result = await addAccount({
      store,
      secrets,
      name: "research",
      apiBase: API_BASE,
      env: {},
      hostname: "Test Host",
      startDeviceLink: async () => deviceStart(),
      pollDeviceLink: async () => linkResult(),
    });

    expect(result).toMatchObject({
      linked: false,
      autoApproved: false,
      link: { userCode: "BCDF-GHJK", expiresInSeconds: 600 },
    });
    await expect(result.completion).resolves.toEqual({ linked: true, owner: OWNER });
    await store.reload();
    expect(store.entry("research")?.link).toMatchObject({ owner: OWNER, label: "research" });
    expect(JSON.parse(secrets.entries[agentSecretAccounts("research").tokens]!)).toEqual(
      linkResult().tokens,
    );
  });

  it("passes session cancellation to background polling", async () => {
    const { store, secrets } = await initializedStore();
    const controller = new AbortController();
    const pollDeviceLink = vi.fn(async (options: { signal?: AbortSignal }) => {
      expect(options.signal).toBe(controller.signal);
      throw new AgentLinkError("access_denied", "The owner denied the agent link.");
    });

    const result = await addAccount({
      store,
      secrets,
      name: "research",
      apiBase: API_BASE,
      env: {},
      hostname: "Test Host",
      signal: controller.signal,
      startDeviceLink: async () => deviceStart(),
      pollDeviceLink,
    });

    await expect(result.completion).resolves.toMatchObject({ linked: false, reason: "denied" });
    expect(pollDeviceLink).toHaveBeenCalledOnce();
  });

  it("completes an auto-approved link inline without returning a code", async () => {
    const { store, secrets } = await initializedStore();
    const pollDeviceLink = vi.fn(async () => linkResult());

    const result = await addAccount({
      store,
      secrets,
      name: "research",
      apiBase: API_BASE,
      env: {},
      hostname: "Test Host",
      startDeviceLink: async () => deviceStart({ autoApproved: true }),
      pollDeviceLink,
    });

    expect(result).toMatchObject({ linked: true, autoApproved: true, created: true });
    expect(result).not.toHaveProperty("link");
    expect(result).not.toHaveProperty("completion");
    expect(pollDeviceLink).toHaveBeenCalledWith(expect.objectContaining({ immediate: true }));
  });

  it("keeps the capped account and returns a public error when link start fails", async () => {
    const { store, secrets } = await initializedStore();

    const result = await addAccount({
      store,
      secrets,
      name: "research",
      caps: { perDayUsd: "0.05" },
      apiBase: API_BASE,
      env: {},
      hostname: "Test Host",
      startDeviceLink: async () => {
        throw new Error(`access token ${ACCESS_TOKEN}`);
      },
    });

    expect(result).toMatchObject({
      linked: false,
      autoApproved: false,
      caps: { perCallUsd: "0.05", perDayUsd: "0.05" },
      linkError: "The vAPI agent link could not be started.",
    });
    expect(JSON.stringify(result)).not.toContain(ACCESS_TOKEN);
    expect(store.entry("research")?.link).toBeUndefined();
  });

  it("never returns the device code, tokens, private keys or a recovery phrase", async () => {
    const pendingHome = await initializedStore();
    const pending = await addAccount({
      store: pendingHome.store,
      secrets: pendingHome.secrets,
      name: "pending",
      apiBase: API_BASE,
      env: {},
      hostname: "Test Host",
      startDeviceLink: async () => deviceStart(),
      pollDeviceLink: async () => linkResult(),
    });
    const { completion, ...pendingPublic } = pending;
    await completion;

    const approvedHome = await initializedStore();
    const approved = await addAccount({
      store: approvedHome.store,
      secrets: approvedHome.secrets,
      name: "approved",
      apiBase: API_BASE,
      env: {},
      hostname: "Test Host",
      startDeviceLink: async () => deviceStart({ autoApproved: true }),
      pollDeviceLink: async () => linkResult(),
    });

    for (const result of [pendingPublic, approved]) {
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain(DEVICE_CODE);
      expect(serialized).not.toContain(ACCESS_TOKEN);
      expect(serialized).not.toContain(REFRESH_TOKEN);
      expect(serialized).not.toMatch(/(?:0x)?[0-9a-fA-F]{64}/u);
      expect(hasPropertyAtAnyDepth(result, "recoveryPhrase")).toBe(false);
    }
  });
});

describe("lowerAccountCaps", () => {
  it("lowers caps, refuses a raise with the terminal command, and leaves storage unchanged", async () => {
    const { home, store } = await initializedStore();
    await createAccount({ store, name: "research" });

    await expect(
      lowerAccountCaps({ store, name: "research", perDayUsd: "0.05" }),
    ).resolves.toMatchObject({
      caps: { perCallUsd: "0.05", perDayUsd: "0.05" },
      changed: true,
    });
    const beforeRaise = await readFile(join(home, "wallets.json"), "utf8");
    const raised = lowerAccountCaps({ store, name: "research", perDayUsd: "5" });
    await expect(raised).rejects.toBeInstanceOf(AccountCapsRaiseError);
    await expect(raised).rejects.toThrow(
      "Raise caps in the terminal: vapi accounts caps research --per-day 5",
    );
    expect(await readFile(join(home, "wallets.json"), "utf8")).toBe(beforeRaise);
  });

  it("does not let overlapping reductions restore a cap another caller lowered", async () => {
    const { home, store } = await initializedStore();
    await createAccount({ store, name: "research" });
    const otherStore = await WalletStore.open(home, { secrets: memorySecretStore(), env: {} });

    const outcomes = await Promise.allSettled([
      lowerAccountCaps({ store, name: "research", perDayUsd: "0.1" }),
      lowerAccountCaps({ store: otherStore, name: "research", perDayUsd: "0.2" }),
    ]);

    await store.reload();
    expect(store.entry("research")?.spendCaps).toEqual({
      perCallAtomic: "100000",
      perDayAtomic: "100000",
    });
    expect(outcomes.some((outcome) => outcome.status === "fulfilled")).toBe(true);
  });
});

function hasPropertyAtAnyDepth(value: unknown, property: string): boolean {
  if (typeof value !== "object" || value === null) return false;
  if (Object.prototype.hasOwnProperty.call(value, property)) return true;
  return Object.values(value).some((entry) => hasPropertyAtAnyDepth(entry, property));
}
