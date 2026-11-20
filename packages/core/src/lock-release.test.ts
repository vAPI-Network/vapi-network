import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { AgentLinkError, withAgentCredentialLock } from "./agent-link.js";
import { KeystoreError } from "./keystore.js";
import { reserveSpend, SpendCapError } from "./spend-policy.js";
import { VaultError, withVaultLock } from "./vault.js";
import { WalletStore, type AgentLink } from "./wallet-store.js";

const closeFailure = vi.hoisted(() => ({ path: undefined as string | undefined, calls: 0 }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...real,
    open: async (...args: Parameters<typeof real.open>) => {
      const handle = await real.open(...args);
      if (args[0] === closeFailure.path) {
        closeFailure.path = undefined;
        const close = handle.close.bind(handle);
        handle.close = async () => {
          handle.close = close;
          await close();
          closeFailure.calls += 1;
          throw Object.assign(new Error("Injected lock handle close failure."), { code: "EIO" });
        };
      }
      return handle;
    },
  };
});

const temporaryDirectories: string[] = [];
const now = new Date("2026-09-28T12:00:00.000Z");
const caps = { perCallAtomic: "100", perDayAtomic: "15" };
const link: AgentLink = {
  apiBase: "https://example.com",
  clientId: "lock-release-agent",
  owner: "0x1111111111111111111111111111111111111111",
  label: "lock release test",
  scopes: ["mcp:call"],
  linkedAt: now.toISOString(),
};

afterEach(async () => {
  closeFailure.path = undefined;
  closeFailure.calls = 0;
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function openWallets(home: string): Promise<WalletStore> {
  await writeFile(
    join(home, "wallets.json"),
    JSON.stringify({
      version: 1,
      default: "main",
      wallets: { main: { createdAt: now.toISOString(), spendCaps: caps } },
    }),
  );
  return await WalletStore.open(home, { env: {} });
}

async function errorFrom(operation: () => Promise<unknown>): Promise<Error> {
  try {
    await operation();
  } catch (error) {
    if (error instanceof Error) return error;
    throw error;
  }
  throw new Error("Expected the locked operation to reject.");
}

type LockCase = {
  name: string;
  prepare(home: string): Promise<{
    lockPath: string;
    operation(): Promise<unknown>;
    result: unknown;
    nextResult: unknown;
    verifyWrite(): Promise<void>;
    fail(): Promise<unknown>;
    expectedError: Error;
  }>;
};

const cases: LockCase[] = [
  {
    name: "spend ledger",
    async prepare(home) {
      const ledgerPath = join(home, "spend-ledger.json");
      return {
        lockPath: `${ledgerPath}.lock`,
        operation: async () => await reserveSpend(5n, caps, { ledgerPath, now }),
        result: { date: "2026-09-28", spentAtomic: "5" },
        nextResult: { date: "2026-09-28", spentAtomic: "10" },
        async verifyWrite() {
          expect(JSON.parse(await readFile(ledgerPath, "utf8"))).toEqual({
            date: "2026-09-28",
            spentAtomic: "5",
          });
        },
        fail: async () => await reserveSpend(20n, caps, { ledgerPath, now }),
        expectedError: new SpendCapError(
          "per_day_cap_exceeded",
          "Payment quote 20 atomic USDC would raise today's spend to 20 for wallet main, above the per-day cap 15. Refusing to sign.",
        ),
      };
    },
  },
  {
    name: "wallet registry",
    async prepare(home) {
      const wallets = await openWallets(home);
      const result = { createdAt: now.toISOString(), spendCaps: caps, link };
      return {
        lockPath: `${wallets.registryPath}.lock`,
        operation: async () => await wallets.setLink("main", link),
        result,
        nextResult: result,
        async verifyWrite() {
          expect(JSON.parse(await readFile(wallets.registryPath, "utf8"))).toEqual({
            version: 1,
            default: "main",
            wallets: { main: result },
          });
        },
        async fail() {
          // The cached wallet resolves, but the locked read sees its removal.
          await writeFile(wallets.registryPath, JSON.stringify({ version: 1, wallets: {} }));
          return await wallets.setLink("main", link);
        },
        expectedError: new KeystoreError("No wallet yet. Run vapi init."),
      };
    },
  },
  {
    name: "agent credentials",
    async prepare(home) {
      const wallets = await openWallets(home);
      const digest = createHash("sha256").update(link.clientId).digest("hex").slice(0, 24);
      const result = { clientId: link.clientId, linked: true };
      const operationError = new AgentLinkError("not_linked", "The agent operation failed.");
      return {
        lockPath: `${wallets.registryPath}.${digest}.agent-link.lock`,
        operation: async () =>
          await withAgentCredentialLock(wallets, link.clientId, async () => {
            await wallets.setLink("main", link);
            return result;
          }),
        result,
        nextResult: result,
        async verifyWrite() {
          expect(JSON.parse(await readFile(wallets.registryPath, "utf8"))).toMatchObject({
            wallets: { main: { link } },
          });
        },
        fail: async () =>
          await withAgentCredentialLock(wallets, link.clientId, async () => {
            throw operationError;
          }),
        expectedError: operationError,
      };
    },
  },
  {
    name: "vault",
    async prepare(home) {
      const vaultPath = join(home, "vault.json");
      const result = { committed: true };
      const operationError = new VaultError("bad_key", "The vault operation failed.");
      return {
        lockPath: `${vaultPath}.lock`,
        operation: async () =>
          await withVaultLock(vaultPath, async () => {
            await writeFile(vaultPath, JSON.stringify(result));
            return result;
          }),
        result,
        nextResult: result,
        async verifyWrite() {
          expect(JSON.parse(await readFile(vaultPath, "utf8"))).toEqual(result);
        },
        fail: async () =>
          await withVaultLock(vaultPath, async () => {
            throw operationError;
          }),
        expectedError: operationError,
      };
    },
  },
];

describe.each(cases)("$name lock release", ({ prepare }) => {
  async function setup() {
    const home = await mkdtemp(join(tmpdir(), "vapi-lock-release-"));
    temporaryDirectories.push(home);
    return await prepare(home);
  }

  it("A: preserves a committed result when close rejects and lets the next call in", async () => {
    const test = await setup();
    closeFailure.path = test.lockPath;

    const outcome = await test.operation().then(
      (result) => ({ result }),
      (error: unknown) => ({ error }),
    );
    expect(closeFailure.calls).toBe(1);
    expect(closeFailure.path).toBeUndefined();
    await test.verifyWrite();
    expect.soft(outcome).toEqual({ result: test.result });
    await expect(stat(test.lockPath)).rejects.toMatchObject({ code: "ENOENT" });

    // The lock file is gone, so the next call does not have to wait for a stale rule.
    await expect(test.operation()).resolves.toEqual(test.nextResult);
    expect(closeFailure.calls).toBe(1);
    await expect(stat(test.lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("B: preserves the operation error when close also rejects and removes the lock", async () => {
    const test = await setup();
    const baseline = await errorFrom(test.fail);
    expect(baseline.constructor).toBe(test.expectedError.constructor);
    expect(baseline.message).toBe(test.expectedError.message);
    expect(Reflect.get(baseline, "code")).toBe(Reflect.get(test.expectedError, "code"));
    await expect(stat(test.lockPath)).rejects.toMatchObject({ code: "ENOENT" });

    closeFailure.path = test.lockPath;
    const error = await errorFrom(test.fail);
    expect(closeFailure.calls).toBe(1);
    expect(closeFailure.path).toBeUndefined();
    expect.soft(error.constructor).toBe(baseline.constructor);
    expect.soft(error.message).toBe(baseline.message);
    expect.soft(Reflect.get(error, "code")).toBe(Reflect.get(baseline, "code"));
    await expect(stat(test.lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
