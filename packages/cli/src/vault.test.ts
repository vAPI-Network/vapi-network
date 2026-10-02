import { mkdtemp, readFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  readVaultFileUnlocked,
  VAULT_LOCKED_MESSAGE,
  WalletStore,
  type SecretStore,
} from "@vapi-network/core";

import {
  runCli as runCliWithDependencies,
  type CliDependencies,
  type CliIo,
  type CliPrompts,
} from "./cli.js";

const TEST_PASSWORD = "test-only-vault-password";
const PROTECT_REFUSAL =
  "vapi vault protect needs a terminal to type the password, or VAPI_VAULT_PASSWORD.";
const UNLOCK_NOTICE = "vapi unlock is now vapi vault unlock; the old name works for one release.";
const PASSWORD_ENV_NOTICE =
  "VAPI_KEYSTORE_PASSWORD is deprecated for vault passwords; use VAPI_VAULT_PASSWORD instead.";
const USAGE = "Usage: vapi vault protect|unprotect|lock|unlock|status [--json]";
const RECOVERY_PHRASE =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const VECTOR_ADDRESS = "0x9858EfFD232B4033E47d90003D41EC34EcaEda94";

const originalHome = process.env.VAPI_HOME;
const homes: string[] = [];
const secretStores = new Map<string, SecretStore>();

afterEach(async () => {
  restoreEnvironment("VAPI_HOME", originalHome);
  secretStores.clear();
  await Promise.all(homes.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("vapi vault", () => {
  it("protects after two prompts and the status screen reports the locked vault", async () => {
    await initializedHome("vapi-vault-protect-");
    const prompts = scriptedPrompts({
      "New vault password: ": TEST_PASSWORD,
      "Repeat the vault password: ": TEST_PASSWORD,
    });
    const protectedRun = captureIo();

    expect(
      await runCli(["vault", "protect"], protectedRun.io, {
        ...baseDependencies(),
        interactive: true,
        prompts: prompts.prompts,
      }),
    ).toBe(0);

    expect(prompts.prompted).toEqual(["New vault password: ", "Repeat the vault password: "]);
    const statusRun = captureIo();
    expect(await runCli([], statusRun.io, baseDependencies())).toBe(0);
    expect(statusRun.stdout.join("\n")).toContain("protected, locked");
  });

  it("protects from VAPI_VAULT_PASSWORD without prompting", async () => {
    const home = await initializedHome("vapi-vault-protect-env-");
    const prompts = scriptedPrompts({});
    const captured = captureIo();

    expect(
      await runCli(["vault", "protect"], captured.io, {
        ...baseDependencies(),
        env: { VAPI_VAULT_PASSWORD: TEST_PASSWORD },
        prompts: prompts.prompts,
      }),
    ).toBe(0);

    expect(prompts.prompted).toEqual([]);
    expect((await readVaultFileUnlocked(vaultPath(home))).protected).toBe(true);
  });

  it("prompts for a password when stdin is a terminal and stdout is redirected", async () => {
    const home = await initializedHome("vapi-vault-protect-redirected-");
    const prompts = scriptedPrompts({
      "New vault password: ": TEST_PASSWORD,
      "Repeat the vault password: ": TEST_PASSWORD,
    });
    const captured = captureIo();

    expect(
      await runCli(["vault", "protect"], captured.io, {
        ...baseDependencies(),
        stdinIsTTY: true,
        prompts: prompts.prompts,
      }),
    ).toBe(0);

    expect(prompts.prompted).toEqual(["New vault password: ", "Repeat the vault password: "]);
    expect((await readVaultFileUnlocked(vaultPath(home))).protected).toBe(true);
  });

  it("refuses non-interactive protection without an environment password", async () => {
    await initializedHome("vapi-vault-protect-headless-");
    const captured = captureIo();

    expect(
      await runCli(["vault", "protect"], captured.io, {
        ...baseDependencies(),
        interactive: false,
        prompts: refusingPrompts(),
      }),
    ).toBe(1);

    expect(captured.stderr).toEqual([PROTECT_REFUSAL]);
    expect(captured.stdout).toEqual([]);
  });

  it("leaves the vault unchanged when the repeated password differs", async () => {
    const home = await initializedHome("vapi-vault-protect-mismatch-");
    const prompts = scriptedPrompts({
      "New vault password: ": TEST_PASSWORD,
      "Repeat the vault password: ": "different-test-only-value",
    });
    const captured = captureIo();

    expect(
      await runCli(["vault", "protect"], captured.io, {
        ...baseDependencies(),
        interactive: true,
        prompts: prompts.prompts,
      }),
    ).toBe(1);

    expect(captured.stderr).toEqual(["The passwords do not match. Nothing changed."]);
    expect((await readVaultFileUnlocked(vaultPath(home))).protected).toBe(false);
    expect(prompts.prompted).toEqual(["New vault password: ", "Repeat the vault password: "]);
  });

  it("caches an unlocked session for a later vault read", async () => {
    await initializedHome("vapi-vault-unlock-env-");
    await protectWithEnvironmentPassword();
    const prompts = scriptedPrompts({});
    const unlocked = captureIo();

    expect(
      await runCli(["vault", "unlock"], unlocked.io, {
        ...baseDependencies(),
        env: { VAPI_VAULT_PASSWORD: TEST_PASSWORD },
        prompts: prompts.prompts,
      }),
    ).toBe(0);
    expect(prompts.prompted).toEqual([]);

    const accounts = captureIo();
    expect(await runCli(["accounts", "--json"], accounts.io, baseDependencies())).toBe(0);
    expect(JSON.parse(accounts.stdout[0]!)).toMatchObject([{ name: "main" }]);
  });

  it("unlocks with the legacy password variable and prints one deprecation notice", async () => {
    await initializedHome("vapi-vault-unlock-legacy-env-");
    await protectWithEnvironmentPassword();
    const captured = captureIo();

    expect(
      await runCli(["vault", "unlock"], captured.io, {
        ...baseDependencies(),
        env: { VAPI_KEYSTORE_PASSWORD: TEST_PASSWORD },
        prompts: refusingPrompts(),
      }),
    ).toBe(0);

    expect(captured.stderr).toEqual([PASSWORD_ENV_NOTICE]);
    expect(captured.stdout).toEqual([
      "Vault open on this device for 8 hours. Lock it early with vapi vault lock.",
    ]);
  });

  it("routes the top-level unlock alias to the protected vault", async () => {
    await initializedHome("vapi-vault-unlock-alias-");
    await protectWithEnvironmentPassword();
    const prompts = scriptedPrompts({});
    const captured = captureIo();

    expect(
      await runCli(["unlock", "--account", "main"], captured.io, {
        ...baseDependencies(),
        env: { VAPI_VAULT_PASSWORD: TEST_PASSWORD },
        prompts: prompts.prompts,
      }),
    ).toBe(0);

    expect(captured.stderr).toEqual([UNLOCK_NOTICE]);
    expect(prompts.prompted).toEqual([]);
    expect(captured.stdout).toEqual([
      "Vault open on this device for 8 hours. Lock it early with vapi vault lock.",
    ]);
  });

  it("locks the session so a later vault read fails closed", async () => {
    await initializedHome("vapi-vault-lock-");
    await protectWithEnvironmentPassword();
    await unlockWithEnvironmentPassword();
    const locked = captureIo();

    expect(await runCli(["vault", "lock"], locked.io, baseDependencies())).toBe(0);
    expect(locked.stdout).toEqual(["Locked the vault."]);

    const read = captureIo();
    expect(await runCli(["balance"], read.io, baseDependencies())).toBe(1);
    expect(read.stderr).toEqual([VAULT_LOCKED_MESSAGE]);
  });

  it("unprotects the vault so the device key opens it again", async () => {
    await initializedHome("vapi-vault-unprotect-");
    await protectWithEnvironmentPassword();
    const prompts = scriptedPrompts({});
    const unprotected = captureIo();

    expect(
      await runCli(["vault", "unprotect"], unprotected.io, {
        ...baseDependencies(),
        env: { VAPI_VAULT_PASSWORD: TEST_PASSWORD },
        prompts: prompts.prompts,
      }),
    ).toBe(0);
    expect(prompts.prompted).toEqual([]);

    const read = captureIo();
    expect(await runCli(["balance", "--json"], read.io, baseDependencies())).toBe(0);
    expect(JSON.parse(read.stdout[0]!)).toMatchObject({ wallet: "main" });
  });

  it("prints vault status as one line", async () => {
    await initializedHome("vapi-vault-status-");
    await protectWithEnvironmentPassword();
    const captured = captureIo();

    expect(await runCli(["vault", "status"], captured.io, baseDependencies())).toBe(0);

    expect(captured.stdout).toEqual(["Vault: protected, locked (macOS Keychain)"]);
    expect(captured.stderr).toEqual([]);
  });

  it("rejects a missing subcommand with the short usage line", async () => {
    await temporaryHome("vapi-vault-usage-");
    const captured = captureIo();

    expect(await runCli(["vault"], captured.io, baseDependencies())).toBe(2);

    expect(captured.stdout).toEqual([]);
    expect(captured.stderr).toEqual([USAGE]);
  });

  it("returns the documented JSON shapes for protect and status", async () => {
    await initializedHome("vapi-vault-json-");
    const protectedRun = captureIo();

    expect(
      await runCli(["vault", "protect", "--json"], protectedRun.io, {
        ...baseDependencies(),
        env: { VAPI_VAULT_PASSWORD: TEST_PASSWORD },
        prompts: refusingPrompts(),
      }),
    ).toBe(0);
    expect(JSON.parse(protectedRun.stdout[0]!)).toEqual({
      command: "vault protect",
      protected: true,
    });
    expect(protectedRun.stderr).toEqual([]);

    const statusRun = captureIo();
    expect(await runCli(["vault", "status", "--json"], statusRun.io, baseDependencies())).toBe(0);
    expect(JSON.parse(statusRun.stdout[0]!)).toEqual({
      command: "vault status",
      exists: true,
      unlocked: false,
      store: "macOS Keychain",
      protected: true,
    });
    expect(statusRun.stderr).toEqual([]);
  });
});

describe("vapi restore", () => {
  it("restores funded accounts from a phrase piped on stdin and audits the restore", async () => {
    const home = await temporaryHome("vapi-restore-stdin-");
    const captured = captureIo();

    expect(
      await runCli(["restore"], captured.io, {
        ...baseDependencies(fundedVectorRpc()),
        readStdin: async () => `${RECOVERY_PHRASE}\n`,
        prompts: refusingPrompts(),
      }),
    ).toBe(0);

    const store = await WalletStore.open(home, { secrets: secretStores.get(home)! });
    expect(store.names()).toEqual(["account-1"]);
    expect(await store.readAddress("account-1")).toBe(VECTOR_ADDRESS);
    expect(captured.stdout).toEqual([
      "Vault restored with 1 account(s): account-1",
      "Run vapi setup to link account-1.",
    ]);
    const audit = await readFile(join(home, "audit.log"), "utf8");
    const restoreEntry = audit
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((entry) => entry.event === "vault.restore");
    expect(restoreEntry).toMatchObject({
      event: "vault.restore",
      wallet: "account-1",
      detail: "1 account(s)",
    });
    expect(audit).not.toContain(RECOVERY_PHRASE);
  });

  it("reads an interactive restore phrase from the secret prompt", async () => {
    const home = await temporaryHome("vapi-restore-prompt-");
    const prompts = scriptedPrompts({ "Recovery phrase: ": RECOVERY_PHRASE });
    const captured = captureIo();

    expect(
      await runCli(["restore"], captured.io, {
        ...baseDependencies(),
        interactive: true,
        prompts: prompts.prompts,
        readStdin: async () => {
          throw new Error("stdin must not be read for an interactive restore");
        },
      }),
    ).toBe(0);

    expect(prompts.prompted).toEqual(["Recovery phrase: "]);
    expect(await readVaultFileUnlocked(vaultPath(home))).toMatchObject({
      accounts: [{ name: "account-1", address: VECTOR_ADDRESS }],
    });
  });

  it("uses the secret prompt when stdin is a terminal and JSON stdout is redirected", async () => {
    await temporaryHome("vapi-restore-json-prompt-");
    const prompts = scriptedPrompts({ "Recovery phrase: ": RECOVERY_PHRASE });
    const captured = captureIo();

    expect(
      await runCli(["restore", "--json"], captured.io, {
        ...baseDependencies(),
        stdinIsTTY: true,
        prompts: prompts.prompts,
        readStdin: async () => {
          throw new Error("stdin must not be read when stdin is a terminal");
        },
      }),
    ).toBe(0);

    expect(prompts.prompted).toEqual(["Recovery phrase: "]);
    expect(captured.stdout).toHaveLength(1);
    expect(JSON.parse(captured.stdout[0]!)).toMatchObject({ vault: "restored" });
  });

  it("replaces stale account metadata after the old vault is moved aside", async () => {
    const home = await initializedHome("vapi-restore-stale-registry-");
    await rename(vaultPath(home), join(home, "vault.before-restore.json"));
    const captured = captureIo();

    expect(
      await runCli(["restore"], captured.io, {
        ...baseDependencies(),
        readStdin: async () => RECOVERY_PHRASE,
      }),
    ).toBe(0);

    const store = await WalletStore.open(home, { secrets: secretStores.get(home)! });
    expect(store.names()).toEqual(["account-1"]);
    expect(store.defaultName).toBe("account-1");
    expect(await store.readAddress("account-1")).toBe(VECTOR_ADDRESS);
  });

  it("refuses to replace an existing vault with one stderr line", async () => {
    const home = await initializedHome("vapi-restore-existing-");
    const captured = captureIo();

    expect(
      await runCli(["restore"], captured.io, {
        ...baseDependencies(),
        readStdin: async () => RECOVERY_PHRASE,
      }),
    ).toBe(1);

    expect(captured.stdout).toEqual([]);
    expect(captured.stderr).toEqual([
      `A vault already exists in ${home}. Move it aside before restoring.`,
    ]);
  });

  it("rejects a bad phrase without creating vault.json", async () => {
    const home = await temporaryHome("vapi-restore-invalid-");
    const captured = captureIo();

    expect(
      await runCli(["restore"], captured.io, {
        ...baseDependencies(),
        readStdin: async () => "not a recovery phrase\n",
      }),
    ).toBe(1);

    expect(captured.stdout).toEqual([]);
    expect(captured.stderr).toEqual([
      "A recovery phrase has 12 or 24 words; this one has 4. Check for a missing or repeated word.",
    ]);
    await expect(readFile(vaultPath(home), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("returns the documented JSON restore shape", async () => {
    await temporaryHome("vapi-restore-json-");
    const captured = captureIo();

    expect(
      await runCli(["restore", "--json"], captured.io, {
        ...baseDependencies(),
        readStdin: async () => RECOVERY_PHRASE,
      }),
    ).toBe(0);

    expect(captured.stdout).toHaveLength(1);
    expect(JSON.parse(captured.stdout[0]!)).toEqual({
      command: "restore",
      vault: "restored",
      accounts: ["account-1"],
    });
    expect([...captured.stdout, ...captured.stderr].join("\n")).not.toContain(RECOVERY_PHRASE);
  });

  it("rejects positional recovery words with the restore usage line", async () => {
    await temporaryHome("vapi-restore-argv-");
    const captured = captureIo();

    expect(await runCli(["restore", "some", "words"], captured.io, baseDependencies())).toBe(2);
    expect(captured.stdout).toEqual([]);
    expect(captured.stderr).toEqual([
      "Usage: vapi restore [--from-owner [--owner <0x…>]] [--json]",
    ]);
  });
});

async function runCli(argv: string[], io: CliIo, dependencies: CliDependencies): Promise<number> {
  const home = process.env.VAPI_HOME;
  if (home === undefined) throw new Error("A vault test must set VAPI_HOME first.");
  const secrets = dependencies.secretStore ?? secretStores.get(home) ?? secretStoreStub();
  secretStores.set(home, secrets);
  return await runCliWithDependencies(argv, io, { ...dependencies, secretStore: secrets });
}

async function temporaryHome(prefix: string): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), prefix));
  homes.push(home);
  process.env.VAPI_HOME = home;
  secretStores.set(home, secretStoreStub());
  return home;
}

async function initializedHome(prefix: string): Promise<string> {
  const home = await temporaryHome(prefix);
  expect(await runCli(["init", "--json"], captureIo().io, baseDependencies())).toBe(0);
  return home;
}

async function protectWithEnvironmentPassword(): Promise<void> {
  expect(
    await runCli(["vault", "protect"], captureIo().io, {
      ...baseDependencies(),
      env: { VAPI_VAULT_PASSWORD: TEST_PASSWORD },
      prompts: refusingPrompts(),
    }),
  ).toBe(0);
}

async function unlockWithEnvironmentPassword(): Promise<void> {
  expect(
    await runCli(["vault", "unlock"], captureIo().io, {
      ...baseDependencies(),
      env: { VAPI_VAULT_PASSWORD: TEST_PASSWORD },
      prompts: refusingPrompts(),
    }),
  ).toBe(0);
}

function vaultPath(home: string): string {
  return join(home, "vault.json");
}

function baseDependencies(fetchImpl: typeof fetch = zeroBalanceRpc()): CliDependencies {
  return {
    interactive: false,
    env: {},
    fetchImpl,
    status: { timeoutMs: 200 },
    router: {
      routerUsage: async () => ({
        compute: {
          allowanceUsd: 1,
          spentTodayUsd: 0,
          remainingTodayUsd: 1,
          resetsAt: "2099-01-01T00:00:00.000Z",
          ownerLimitUsd: 5,
          ownerSpentUsd: 0,
        },
        balance: null,
      }),
    },
  };
}

function scriptedPrompts(answers: Record<string, string>): {
  prompts: CliPrompts;
  prompted: string[];
} {
  const prompted: string[] = [];
  const answer = async (prompt: string) => {
    prompted.push(prompt);
    const value = answers[prompt];
    if (value === undefined) throw new Error(`Unexpected prompt ${JSON.stringify(prompt)}.`);
    return value;
  };
  return { prompted, prompts: { secret: answer, line: answer } };
}

function refusingPrompts(): CliPrompts {
  const refuse = async (prompt: string): Promise<string> => {
    throw new Error(`Unexpected prompt ${JSON.stringify(prompt)}.`);
  };
  return { secret: refuse, line: refuse };
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

function zeroBalanceRpc(): typeof fetch {
  return vi.fn<typeof fetch>(async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as { id: number; method: string };
    return Response.json({
      jsonrpc: "2.0",
      id: request.id,
      result:
        request.method === "eth_call"
          ? `0x${"0".repeat(64)}`
          : request.method === "getTokenAccountsByOwner"
            ? { context: { slot: 1 }, value: [] }
            : request.method === "getBalance"
              ? { context: { slot: 1 }, value: 0 }
              : "0x0",
    });
  });
}

function fundedVectorRpc(): typeof fetch {
  return rpcForUsdc((address) =>
    address.toLowerCase() === VECTOR_ADDRESS.toLowerCase() ? 1_000_000n : 0n,
  );
}

function rpcForUsdc(balance: (address: string) => bigint): typeof fetch {
  return vi.fn<typeof fetch>(async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as {
      id: number;
      method: string;
      params?: Array<{ data?: string } | string>;
    };
    let result = "0x0";
    if (request.method === "eth_call") {
      const call = request.params?.[0];
      const data = typeof call === "object" && call !== null ? call.data : undefined;
      const address = data === undefined ? "" : `0x${data.slice(-40)}`;
      result = `0x${balance(address).toString(16).padStart(64, "0")}`;
    }
    return Response.json({ jsonrpc: "2.0", id: request.id, result });
  });
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
