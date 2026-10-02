import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { AgentRouterUsage } from "./router-client.js";
import type { SecretStore } from "./secret-store.js";
import { buildStatus, formatUsdAmount, type StatusDeps } from "./status.js";
import { protectVault, VAULT_KEY_ACCOUNT } from "./vault-key.js";
import { exportVaultPhrase } from "./vault.js";
import { WalletStore, type AgentLink } from "./wallet-store.js";

const NOW = new Date("2026-09-28T12:00:00.000Z");
const OWNER = "0xf699000000000000000000000000000000000b09c" as const;
const temporaryDirectories: string[] = [];
const secretStores = new Map<string, SecretStore>();

afterEach(async () => {
  vi.useRealTimers();
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
  const directory = await mkdtemp(join(tmpdir(), "vapi-status-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function openStore(home: string, env: NodeJS.ProcessEnv = {}): Promise<WalletStore> {
  return await WalletStore.open(home, {
    secrets: secretsFor(home),
    env,
    now: () => NOW,
  });
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

function linkedAccount(): AgentLink {
  return {
    owner: OWNER,
    apiBase: "https://api.vapinetwork.ai",
    clientId: "status-test",
    label: "Status test",
    scopes: ["router:use"],
    linkedAt: NOW.toISOString(),
  };
}

function deps(home: string, wallets: WalletStore, overrides: Partial<StatusDeps> = {}): StatusDeps {
  return {
    version: "0.8.0",
    home,
    registry: "https://api.vapinetwork.ai",
    wallets,
    secrets: secretsFor(home),
    env: {},
    chain: { usdcBalance: async () => 0n },
    agents: {
      routerUsage: async () => usage(0, 1),
      linkStatus: async () => "active",
    },
    now: () => NOW,
    ...overrides,
  };
}

function nextLine(command: string, description: string): string {
  return command.padEnd(34) + description;
}

describe("buildStatus", () => {
  it("reports an empty home and its single setup action", async () => {
    const home = await makeHome();
    const wallets = await openStore(home);

    await expect(
      buildStatus(deps(home, wallets, { registry: "https://api.vapinetwork.ai/" })),
    ).resolves.toEqual({
      version: "0.8.0",
      home,
      registry: "https://api.vapinetwork.ai",
      vault: {
        exists: false,
        unlocked: false,
        store: "macOS Keychain",
        protected: false,
      },
      accounts: [],
      unfinishedMovements: [],
      next: [nextLine("vapi setup", "create your vault and link your first account")],
    });
  });

  it("builds the complete two-account report in registry order", async () => {
    const home = await makeHome();
    const wallets = await openStore(home);
    await wallets.create("main", "");
    await wallets.create("researcher", "");
    const caps = { perCallAtomic: "50000", perDayAtomic: "1000000" };
    await wallets.setSpendCaps("main", caps);
    await wallets.setSpendCaps("researcher", caps);
    await wallets.setLink("main", linkedAccount());
    await wallets.setLink("researcher", {
      ...linkedAccount(),
      clientId: "researcher-status-test",
    });
    const infos = await wallets.list();
    const mainAddress = infos[0]?.address;
    const researcherAddress = infos[1]?.address;
    expect(mainAddress).toBeDefined();
    expect(researcherAddress).toBeDefined();

    const report = await buildStatus(
      deps(home, wallets, {
        chain: {
          usdcBalance: async (address) => (address === mainAddress ? 980000n : 500000n),
        },
        agents: {
          routerUsage: async (account) => (account === "main" ? usage(0.01, 1) : usage(0, 1)),
          linkStatus: async (account) => (account === "main" ? "active" : "paused"),
        },
      }),
    );

    expect(report).toEqual({
      version: "0.8.0",
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
      accounts: [
        {
          name: "main",
          default: true,
          address: mainAddress,
          usdc: "0.98",
          routerTodayUsd: "0.01",
          routerAllowanceUsd: "1.00",
          caps: { perCallUsd: "0.05", perDayUsd: "1.00", ceilingUsd: "5" },
          link: "active",
        },
        {
          name: "researcher",
          default: false,
          address: researcherAddress,
          usdc: "0.50",
          routerTodayUsd: "0.00",
          routerAllowanceUsd: "1.00",
          caps: { perCallUsd: "0.05", perDayUsd: "1.00", ceilingUsd: "5" },
          link: "paused",
        },
      ],
      unfinishedMovements: [],
      next: [
        nextLine("vapi pay <ref> --max 0.02", "pay an API from main"),
        nextLine('vapi router chat "hello"', "talk to a model on main's allowance"),
        nextLine("vapi accounts add <name>", "add an account"),
      ],
    });
  });

  it("returns at the shared deadline and aborts a pending chain call", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const home = await makeHome();
    const wallets = await openStore(home);
    await wallets.create("main", "");
    await wallets.setLink("main", linkedAccount());
    let aborted = false;
    const chain = vi.fn(
      async (_address: string, signal?: AbortSignal) =>
        await new Promise<bigint>((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => {
              aborted = true;
              reject(signal.reason);
            },
            { once: true },
          );
        }),
    );
    const reportPromise = buildStatus(
      deps(home, wallets, {
        timeoutMs: 2_000,
        chain: { usdcBalance: chain },
        agents: {
          routerUsage: async () => usage(0.25, 1),
          linkStatus: async () => "active",
        },
      }),
    );

    while (chain.mock.calls.length === 0) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    await vi.advanceTimersByTimeAsync(2_000);
    const report = await reportPromise;

    expect(chain).toHaveBeenCalledOnce();
    expect(aborted).toBe(true);
    expect(report.accounts[0]).toEqual(
      expect.objectContaining({
        link: "active",
        routerTodayUsd: "0.25",
        routerAllowanceUsd: "1.00",
      }),
    );
    expect(report.accounts[0]).not.toHaveProperty("usdc");
  });

  it("degrades rejected agent calls and skips router usage for an unlinked account", async () => {
    const home = await makeHome();
    const wallets = await openStore(home);
    await wallets.create("main", "");
    await wallets.create("researcher", "");
    await wallets.setLink("main", linkedAccount());
    const routerUsage = vi.fn<StatusDeps["agents"]["routerUsage"]>(
      async () => await Promise.reject(new Error("router unavailable")),
    );

    const report = await buildStatus(
      deps(home, wallets, {
        agents: {
          routerUsage,
          linkStatus: async () => await Promise.reject(new Error("link unavailable")),
        },
      }),
    );

    expect(routerUsage).toHaveBeenCalledTimes(1);
    expect(routerUsage.mock.calls[0]?.[0]).toBe("main");
    expect(routerUsage.mock.calls[0]?.[1]).toBeInstanceOf(AbortSignal);
    expect(report.accounts[0]).toEqual(expect.objectContaining({ name: "main", link: "unknown" }));
    expect(report.accounts[0]).not.toHaveProperty("routerTodayUsd");
    expect(report.accounts[0]).not.toHaveProperty("routerAllowanceUsd");
    expect(report.accounts[1]).toEqual(
      expect.objectContaining({ name: "researcher", link: "not_linked" }),
    );
    expect(report.next[0]).not.toContain("vapi setup");
  });

  it("includes cloud backup state only when its probe resolves", async () => {
    const home = await makeHome();
    const wallets = await openStore(home);
    const lastUploadAt = "2026-09-28T11:30:00.000Z";

    const reported = await buildStatus(
      deps(home, wallets, {
        cloudBackup: async () => ({ enabled: true, lastUploadAt }),
      }),
    );
    expect(reported.cloudBackup).toEqual({ enabled: true, lastUploadAt });

    const omitted = await buildStatus(
      deps(home, wallets, {
        cloudBackup: async () => await Promise.reject(new Error("secret store unavailable")),
      }),
    );
    expect(omitted).not.toHaveProperty("cloudBackup");
  });

  it("reports a protected vault as unlocked only with a password or live session", async () => {
    const home = await makeHome();
    const initial = await openStore(home);
    await initial.create("main", "");
    await protectVault({
      path: join(home, "vault.json"),
      secrets: secretsFor(home),
      password: "pw",
    });

    const lockedWallets = await openStore(home);
    const locked = await buildStatus(deps(home, lockedWallets));
    expect(locked.vault).toEqual({
      exists: true,
      unlocked: false,
      store: "macOS Keychain",
      protected: true,
    });

    const env = { VAPI_VAULT_PASSWORD: "pw" };
    const unlockedWallets = await openStore(home, env);
    const unlocked = await buildStatus(deps(home, unlockedWallets, { env }));
    expect(unlocked.vault).toEqual({
      exists: true,
      unlocked: true,
      store: "macOS Keychain",
      protected: true,
    });

    const wrongEnv = { VAPI_VAULT_PASSWORD: "wrong" };
    const wrongPasswordWallets = await openStore(home, wrongEnv);
    const wrongPassword = await buildStatus(deps(home, wrongPasswordWallets, { env: wrongEnv }));
    expect(wrongPassword.vault.unlocked).toBe(false);
  });

  it("never includes vault secrets in the report", async () => {
    const home = await makeHome();
    const wallets = await openStore(home);
    await wallets.create("main", "");
    const encodedKey = await secretsFor(home).get(VAULT_KEY_ACCOUNT);
    expect(encodedKey).toBeDefined();
    const phrase = await exportVaultPhrase({
      path: join(home, "vault.json"),
      key: Buffer.from(encodedKey!, "base64"),
    });

    const serialized = JSON.stringify(await buildStatus(deps(home, wallets)));

    expect(serialized).not.toMatch(/0x[0-9a-fA-F]{64}/u);
    expect(serialized).not.toContain(phrase);
    expect(serialized).not.toContain(encodedKey);
  });
});

describe("formatUsdAmount", () => {
  it.each([
    [980000n, "0.98"],
    [1000000n, "1.00"],
    [50000n, "0.05"],
    [1, "1.00"],
    [0.005, "0.005"],
    [1e-7, "0.0000001"],
  ])("formats %s without scientific notation", (value, expected) => {
    expect(formatUsdAmount(value)).toBe(expected);
  });
});
