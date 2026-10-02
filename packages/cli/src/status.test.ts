import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  BASE_MAINNET_CAIP2,
  executeMovement,
  type CeilingTransfer,
  type SecretStore,
  WalletStore,
} from "@vapi-network/core";
import { agentSecretAccounts } from "@vapi-network/core/agent-link";
import { backupStateAccount, storeBackupKey } from "@vapi-network/core/cloud-backup";
import type { AgentRouterUsage, RouterClientDeps } from "@vapi-network/core/router-client";

import { runCli, type CliDependencies, type CliIo } from "./cli.js";
import { CLI_VERSION } from "./version.js";

const OWNER = "0xf69911111111111111111111111111111111b09c" as const;
const RECOVERY_PHRASE =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const MAIN_TOKEN = "main-status-token-that-must-stay-secret";
const RESEARCHER_TOKEN = "researcher-status-token-that-must-stay-secret";
const originalHome = process.env.VAPI_HOME;
const homes: string[] = [];

afterEach(async () => {
  restoreEnvironment("VAPI_HOME", originalHome);
  await Promise.all(homes.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("vapi status", () => {
  it("prints setup and cloud backup state for an empty home", async () => {
    const home = await temporaryHome("vapi-status-empty-");
    const captured = captureIo();

    expect(await runCli([], captured.io, dependencies(secretStoreStub()))).toBe(0);
    expect(captured.stdout).toEqual([
      `Run vapi setup to create a vault in ${home} and link your first account.`,
      "Cloud backup: off",
    ]);
  });

  it("renders two accounts, their balances, Router usage, caps, and link status", async () => {
    const fixture = await twoAccountFixture();
    const captured = captureIo();

    expect(await runCli([], captured.io, fixture.dependencies)).toBe(0);
    expect(captured.stdout).toEqual(twoAccountLines(fixture));
    const output = [...captured.stdout, ...captured.stderr].join("\n");
    expect(output).not.toMatch(/0x[0-9a-fA-F]{64}/u);
    expect(output).not.toContain(MAIN_TOKEN);
    expect(output).not.toContain(RESEARCHER_TOKEN);
  });

  it("finishes on the status deadline and marks unavailable probes with ellipses", async () => {
    const secrets = secretStoreStub();
    const home = await initializedHome("vapi-status-timeout-", secrets, false);
    const store = await WalletStore.open(home, { secrets });
    await linkAccount(store, secrets, "main", MAIN_TOKEN);
    const delayedFetch = vi.fn<typeof fetch>(async (input, init) => {
      const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
      return await new Promise<Response>((resolve, reject) => {
        const timer = setTimeout(() => resolve(Response.json({})), 300);
        const abort = () => {
          clearTimeout(timer);
          reject(signal?.reason);
        };
        if (signal?.aborted === true) abort();
        else signal?.addEventListener("abort", abort, { once: true });
      });
    });
    const started = performance.now();
    const captured = captureIo();

    expect(
      await runCli([], captured.io, {
        ...dependencies(secrets),
        fetchImpl: delayedFetch,
        status: { timeoutMs: 50 },
      }),
    ).toBe(0);
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(captured.stdout.find((line) => line.startsWith("  main *"))).toContain(
      "… USDC       Router today $… of $…",
    );
  });

  it("returns the complete status report as one JSON object", async () => {
    const fixture = await twoAccountFixture();
    const captured = captureIo();

    expect(await runCli(["--json"], captured.io, fixture.dependencies)).toBe(0);
    expect(captured.stdout).toHaveLength(1);
    expect(JSON.parse(captured.stdout[0]!)).toMatchObject({
      version: CLI_VERSION,
      home: fixture.home,
      registry: "https://api.vapinetwork.ai",
      owner: { address: OWNER, linked: true },
      vault: { exists: true, unlocked: true, store: "macOS Keychain", protected: false },
      cloudBackup: { enabled: false },
      accounts: [{ name: "main" }, { name: "researcher" }],
      next: expect.any(Array),
    });
  });

  it("shows cloud backup on with the last upload time", async () => {
    const fixture = await twoAccountFixture();
    const secrets = fixture.dependencies.secretStore!;
    const device = "status-device";
    const lastUploadAt = "2026-09-29T12:34:56.000Z";
    await storeBackupKey({
      secrets,
      device,
      owner: OWNER,
      kdf: { name: "hkdf-sha256", salt: Buffer.alloc(32, 7).toString("base64url") },
      key: Uint8Array.from({ length: 32 }, (_, index) => index + 1),
    });
    await secrets.set(backupStateAccount(device), JSON.stringify({ lastUploadAt, sizeBytes: 512 }));
    const captured = captureIo();

    expect(
      await runCli([], captured.io, {
        ...fixture.dependencies,
        env: { VAPI_DEVICE: device },
        hostname: () => device,
      }),
    ).toBe(0);

    expect(captured.stdout).toContain(`Cloud backup: on (last upload ${lastUploadAt})`);
  });

  it("shows the ceiling, the per-day floor rule, and unfinished resume commands", async () => {
    const fixture = await twoAccountFixture();
    const store = await WalletStore.open(fixture.home, {
      secrets: fixture.dependencies.secretStore,
    });
    await store.setCeiling("main", 500_000n);
    await expect(
      executeMovement(
        {
          reason: "distribute",
          from: "main",
          network: BASE_MAINNET_CAIP2,
          legs: [{ to: "researcher", amountUsd: "0.25" }],
        },
        {
          store,
          secrets: fixture.dependencies.secretStore!,
          apiBase: "https://api.vapinetwork.ai",
          randomId: () => "mv_status_test_1",
          randomNonce: () => `0x${"01".repeat(32)}`,
          transfer: async () => {
            throw new Error("simulated interruption");
          },
        },
      ),
    ).rejects.toThrow("simulated interruption");
    const captured = captureIo();

    expect(await runCli([], captured.io, fixture.dependencies)).toBe(0);
    expect(captured.stdout.find((line) => line.startsWith("  main *"))).toContain(
      "ceiling 0.5 USDC",
    );
    expect(captured.stdout).toContain("    main: swept down to 1.00 USDC, the per-day cap");
    expect(captured.stdout).toContain(
      "Unfinished movement mv_status_test_1 from main: vapi accounts distribute --resume mv_status_test_1",
    );
  });

  it("lets the ten-minute guard turn two status screens into one sweep", async () => {
    const fixture = await twoAccountFixture();
    const store = await WalletStore.open(fixture.home, {
      secrets: fixture.dependencies.secretStore,
    });
    await store.setCeiling("main", 500_000n);
    const transfer = vi.fn<CeilingTransfer>(async (args) => ({
      status: "sent",
      from: args.from,
      to: OWNER,
      toName: "owner",
      toKind: "owner",
      amountUsd: String(args.amountUsd),
      amountAtomic: "1000000",
      network: BASE_MAINNET_CAIP2,
      txHash: `0x${"12".repeat(32)}`,
      nonce: `0x${"34".repeat(32)}`,
      replayed: false,
    }));
    const dependenciesWithSweep: CliDependencies = {
      ...fixture.dependencies,
      ceiling: {
        balanceReader: async () => 2_000_000n,
        fetchSiblingsImpl: async ({ account }) => ({
          owner: OWNER,
          source: { account },
          siblings: [
            {
              name: account,
              address: (await store.readAddress(account))! as `0x${string}`,
              device: "test-device",
              status: "active",
              allowance: { routerPerDayUsd: null, perCallUsd: null, perDayUsd: null },
              self: true,
            },
          ],
        }),
        transfer,
      },
    };

    expect(await runCli([], captureIo().io, dependenciesWithSweep)).toBe(0);
    expect(await runCli([], captureIo().io, dependenciesWithSweep)).toBe(0);
    expect(transfer).toHaveBeenCalledOnce();
  });

  it("does not fail the status screen when the ceiling sweep fails", async () => {
    const fixture = await twoAccountFixture();
    const captured = captureIo();

    expect(
      await runCli([], captured.io, {
        ...fixture.dependencies,
        ceiling: {
          sweepAllAboveCeiling: async () => {
            throw new Error("sweep unavailable");
          },
        },
      }),
    ).toBe(0);
    expect(captured.stdout[0]).toMatch(/^vAPI /u);
  });

  it.each([["help"], ["--help"]])("keeps vapi %s on the help screen", async (command) => {
    const captured = captureIo();

    expect(await runCli([command], captured.io)).toBe(0);
    expect(captured.stdout[0]).toMatch(/^vAPI Network/u);
  });
});

type TwoAccountFixture = {
  home: string;
  mainAddress: string;
  researcherAddress: string;
  dependencies: CliDependencies;
};

async function twoAccountFixture(): Promise<TwoAccountFixture> {
  const secrets = secretStoreStub();
  const home = await initializedHome("vapi-status-two-", secrets, true);
  const store = await WalletStore.open(home, { secrets });
  await linkAccount(store, secrets, "main", MAIN_TOKEN);
  await linkAccount(store, secrets, "researcher", RESEARCHER_TOKEN);
  const accounts = await store.list();
  const mainAddress = accounts.find((account) => account.name === "main")!.address!;
  const researcherAddress = accounts.find((account) => account.name === "researcher")!.address!;
  const fetchImpl = statusFetch({ mainAddress, researcherAddress });
  const readUsage = vi.fn(async (deps: RouterClientDeps): Promise<AgentRouterUsage> => {
    const spentTodayUsd = deps.wallet === "main" ? 0.01 : 0;
    return usage(spentTodayUsd);
  });
  return {
    home,
    mainAddress,
    researcherAddress,
    dependencies: {
      ...dependencies(secrets),
      fetchImpl,
      router: { routerUsage: readUsage },
    },
  };
}

async function initializedHome(
  prefix: string,
  secrets: SecretStore,
  withResearcher: boolean,
): Promise<string> {
  const home = await temporaryHome(prefix);
  const init = captureIo();
  expect(
    await runCli(["import", "--phrase", "--json"], init.io, {
      ...dependencies(secrets),
      fetchImpl: zeroBalanceRpc(),
      prompts: { secret: async () => RECOVERY_PHRASE },
    }),
  ).toBe(0);
  if (withResearcher) {
    expect(
      await runCli(["wallet", "create", "researcher", "--json"], captureIo().io, {
        ...dependencies(secrets),
        fetchImpl: zeroBalanceRpc(),
      }),
    ).toBe(0);
    expect(
      await runCli(
        ["wallet", "caps", "main", "--per-call", "0.05", "--per-day", "1"],
        captureIo().io,
        dependencies(secrets),
      ),
    ).toBe(0);
  }
  return home;
}

async function linkAccount(
  store: WalletStore,
  secrets: SecretStore,
  name: "main" | "researcher",
  accessToken: string,
): Promise<void> {
  await store.setLink(name, {
    apiBase: "https://api.vapinetwork.ai",
    clientId: `agent_${name}`,
    owner: OWNER,
    label: name,
    scopes: ["mcp:call", "router.use"],
    linkedAt: "2026-09-28T10:00:00.000Z",
    routerBaseUrl: "https://router.vapinetwork.ai",
  });
  await secrets.set(
    agentSecretAccounts(name).tokens,
    JSON.stringify({
      accessToken,
      refreshToken: `${name}-refresh-token-that-must-stay-secret`,
      expiresAt: Number.MAX_SAFE_INTEGER,
      scopes: ["mcp:call", "router.use"],
    }),
  );
}

function twoAccountLines(fixture: TwoAccountFixture): string[] {
  const width = "researcher".length + 2;
  return [
    `vAPI ${CLI_VERSION}        home ${fixture.home}        registry api.vapinetwork.ai`,
    "",
    "Owner      0xf699…b09c   linked      console: https://api.vapinetwork.ai/agents",
    "Vault      unlocked on this device (macOS Keychain)   backup: vapi backup",
    "Cloud backup: off",
    "",
    "Accounts",
    `  ${"main *".padEnd(width)}  ${shortAddress(fixture.mainAddress)}   ${"0.98 USDC".padEnd(10)}   Router today $0.01 of $1.00   caps $0.05 / $1.00 per day   ceiling 5 USDC   active`,
    `  ${"researcher".padEnd(width)}  ${shortAddress(fixture.researcherAddress)}   ${"0.50 USDC".padEnd(10)}   Router today $0.00 of $1.00   caps $0.10 / $1.00 per day   ceiling 5 USDC   paused`,
    "",
    "Next",
    `  ${"vapi pay <ref> --max 0.02".padEnd(34)}pay an API from main`,
    `  ${'vapi router chat "hello"'.padEnd(34)}talk to a model on main's allowance`,
    `  ${"vapi accounts add <name>".padEnd(34)}add an account`,
  ];
}

function statusFetch(addresses: { mainAddress: string; researcherAddress: string }): typeof fetch {
  return vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname === "/api/agents/self") {
      const headers = new Headers(input instanceof Request ? input.headers : init?.headers);
      return Response.json(
        headers.get("authorization") === `Bearer ${RESEARCHER_TOKEN}` ? { status: "paused" } : {},
      );
    }
    const request = JSON.parse(String(init?.body)) as {
      id: number;
      method: string;
      params?: Array<{ data?: string }>;
    };
    let result = "0x0";
    if (request.method === "eth_call") {
      const data = request.params?.[0]?.data?.toLowerCase() ?? "";
      const main = addresses.mainAddress.toLowerCase().slice(2);
      result = quantity(data.endsWith(main) ? 980_000n : 500_000n);
    }
    return Response.json({ jsonrpc: "2.0", id: request.id, result });
  });
}

function zeroBalanceRpc(): typeof fetch {
  return vi.fn<typeof fetch>(async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as { id: number; method: string };
    return Response.json({
      jsonrpc: "2.0",
      id: request.id,
      result: request.method === "eth_call" ? quantity(0n) : "0x0",
    });
  });
}

function quantity(value: bigint): string {
  return `0x${value.toString(16).padStart(64, "0")}`;
}

function usage(spentTodayUsd: number): AgentRouterUsage {
  return {
    compute: {
      allowanceUsd: 1,
      spentTodayUsd,
      remainingTodayUsd: 1 - spentTodayUsd,
      resetsAt: "2026-09-29T00:00:00.000Z",
      ownerLimitUsd: 5,
      ownerSpentUsd: 0.01,
    },
    balance: null,
  };
}

function dependencies(secretStore: SecretStore): CliDependencies {
  return {
    interactive: false,
    env: {},
    secretStore,
    ceiling: { sweepAllAboveCeiling: async () => [] },
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

async function temporaryHome(prefix: string): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), prefix));
  homes.push(home);
  process.env.VAPI_HOME = home;
  return home;
}

function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
