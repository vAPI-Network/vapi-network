import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createFileSecretStore,
  fileSecretStore,
  KeystoreError,
  osSecretStore,
  type SecretStore,
  VAULT_KEY_ACCOUNT,
  WalletStore,
} from "@vapi-network/core";
import type {
  DeviceLinkStart,
  LinkResult,
  pollDeviceLink,
  startDeviceLink,
} from "@vapi-network/core/agent-link";
import type { AgentRouterUsage } from "@vapi-network/core/router-client";

import {
  runCli as runCliWithDependencies,
  type CliDependencies,
  type CliIo,
  type CliPrompts,
} from "./cli.js";
import { CLI_VERSION } from "./version.js";

vi.mock("@vapi-network/core", async (importOriginal) => {
  const core = await importOriginal<typeof import("@vapi-network/core")>();
  return {
    ...core,
    osSecretStore: vi.fn(() => {
      throw new Error("A setup test must inject its OS probe.");
    }),
    secretStore: (options?: Parameters<typeof core.secretStore>[0]) => {
      if (core.readSecretBackend(options?.home) !== "file") {
        throw new Error("A setup test must inject a secret store or pin the file backend.");
      }
      return core.secretStore(options);
    },
  };
});

const RECOVERY_PHRASE =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const VECTOR_ADDRESS = "0x9858EfFD232B4033E47d90003D41EC34EcaEda94";
const OWNER = "0x1111111111111111111111111111111111111111" as const;
const START: DeviceLinkStart = {
  clientId: "agent_main",
  deviceCode: "device-code-that-must-stay-secret",
  userCode: "BCDF-GHJK",
  verificationUri: "https://api.vapinetwork.ai/link",
  verificationUriComplete: "https://api.vapinetwork.ai/link?code=BCDF-GHJK",
  expiresIn: 600,
  interval: 5,
  autoApproved: false,
};
const RESULT: LinkResult = {
  tokens: {
    accessToken: "access-token-that-must-stay-secret",
    refreshToken: "refresh-token-that-must-stay-secret",
    expiresAt: Number.MAX_SAFE_INTEGER,
    scopes: ["mcp:call", "router.use"],
  },
  owner: OWNER,
  routerKey: "router-key-that-must-stay-secret",
  routerBaseUrl: "https://router.vapinetwork.ai",
};
const CUSTODY_NOTICE = [
  "This wallet is yours. vAPI has no copy of the key and cannot recover it.",
  "If you lose this machine and your recovery phrase, the funds are gone.",
].join("\n");
const SETUP_CHOICE = "Create a new vault, or restore one from a recovery phrase? [new/restore] ";
const PHRASE_GATE = "Write these 12 words down, then press Enter. ";
const CLOUD_BACKUP_OFFER =
  "vAPI can keep an encrypted copy of this vault. Only your owner wallet can unlock it; vAPI cannot.";
const CLOUD_BACKUP_CHOICE = "Turn on cloud backup? [Y/n] ";

const originalHome = process.env.VAPI_HOME;
const originalVaultPassword = process.env.VAPI_VAULT_PASSWORD;
const homes: string[] = [];
const secretStores = new Map<string, SecretStore>();

afterEach(async () => {
  restoreEnvironment("VAPI_HOME", originalHome);
  restoreEnvironment("VAPI_VAULT_PASSWORD", originalVaultPassword);
  vi.mocked(osSecretStore).mockReset();
  secretStores.clear();
  await Promise.all(homes.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("vapi setup", () => {
  it("tells a headless Linux user how to continue when no keyring works", async () => {
    const home = await temporaryHome("vapi-setup-no-keyring-");
    const captured = captureIo();

    expect(
      await runCliWithDependencies(["setup", "--no-cloud-backup"], captured.io, {
        ...baseDependencies(),
        agentLink: linkMocks().operations,
        secretBackendProbe: brokenLinuxStore(),
        env: {},
      }),
    ).toBe(1);

    expect(captured.stderr.join("\n")).toContain("VAPI_VAULT_PASSWORD");
    expect(captured.stderr.join("\n")).toContain("own computer");
    for (const name of ["vault.json", "secret-store.json", "secrets.json"]) {
      expect(await fileExists(join(home, name))).toBe(false);
    }
    expectNoSecretLeak(captured);
  });

  it("creates a file-backed vault when VAPI_VAULT_PASSWORD is set", async () => {
    const home = await temporaryHome("vapi-setup-file-");
    const env = { VAPI_VAULT_PASSWORD: "correct horse battery" };
    process.env.VAPI_VAULT_PASSWORD = env.VAPI_VAULT_PASSWORD;
    const captured = captureIo();

    expect(
      await runCliWithDependencies(["setup", "--no-cloud-backup"], captured.io, {
        ...baseDependencies(),
        agentLink: linkMocks().operations,
        prompts: scriptedPrompts({ [SETUP_CHOICE]: "new" }).prompts,
        secretBackendProbe: brokenLinuxStore(),
        env,
      }),
    ).toBe(0);

    expect(JSON.parse(await readFile(join(home, "secret-store.json"), "utf8"))).toEqual({
      v: 1,
      backend: "file",
    });
    expect(await fileExists(join(home, "vault.json"))).toBe(true);
    const path = join(home, "secrets.json");
    const raw = await readFile(path, "utf8");
    expect(JSON.parse(raw)).toMatchObject({
      entries: { [VAULT_KEY_ACCOUNT]: { ciphertext: expect.any(String) } },
    });
    const deviceKey = await fileSecretStore({ path, env }).get(VAULT_KEY_ACCOUNT);
    expect(deviceKey).toBeDefined();
    expect(raw).not.toContain(deviceKey!);
    for (const secret of [
      env.VAPI_VAULT_PASSWORD,
      RESULT.tokens.accessToken,
      RESULT.tokens.refreshToken,
      RESULT.routerKey!,
    ]) {
      expect(raw).not.toContain(secret);
      expect([...captured.stdout, ...captured.stderr].join("\n")).not.toContain(secret);
    }
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(join(home, "secret-store.json"))).mode & 0o777).toBe(0o600);
    expect((await stat(home)).mode & 0o777).toBe(0o700);
    expectNoSecretLeak(captured);
  }, 15_000);

  it.each([false, true])(
    "hides the recovery phrase in file mode with an agent marker and interactive %s",
    async (interactive) => {
      const home = await temporaryHome("vapi-setup-file-agent-");
      const env = { VAPI_VAULT_PASSWORD: "correct horse battery", CLAUDECODE: "1" };
      process.env.VAPI_VAULT_PASSWORD = env.VAPI_VAULT_PASSWORD;
      const captured = captureIo();
      const prompts = scriptedPrompts({ [SETUP_CHOICE]: "new" });

      expect(
        await runCliWithDependencies(["setup", "--no-cloud-backup"], captured.io, {
          ...baseDependencies(),
          agentLink: linkMocks().operations,
          prompts: prompts.prompts,
          secretBackendProbe: brokenLinuxStore(),
          interactive,
          env,
        }),
      ).toBe(0);

      expect(await fileExists(join(home, "vault.json"))).toBe(true);
      expect(captured.stdout).toContain(
        "Recovery phrase: run vapi backup yourself in a terminal to see it.",
      );
      expect(captured.stdout.join("\n")).not.toContain("These 12 words restore this wallet");
      expect(prompts.prompted).toEqual([SETUP_CHOICE]);
      expectNoSecretLeak(captured);
    },
    15_000,
  );

  it("never re-chooses the backend for an existing vault", async () => {
    const home = await temporaryHome("vapi-setup-existing-backend-");
    const link = linkMocks();
    expect(
      await runCli(["setup", "--no-cloud-backup"], captureIo().io, {
        ...baseDependencies(),
        agentLink: link.operations,
      }),
    ).toBe(0);
    await rm(join(home, "secret-store.json"), { force: true });
    const originalVault = await readFile(join(home, "vault.json"), "utf8");
    const probe = brokenLinuxStore();

    expect(
      await runCli(["setup", "--no-cloud-backup"], captureIo().io, {
        ...baseDependencies(),
        agentLink: link.operations,
        secretBackendProbe: probe,
      }),
    ).toBe(0);

    expect(await fileExists(join(home, "secret-store.json"))).toBe(false);
    expect(await readFile(join(home, "vault.json"), "utf8")).toBe(originalVault);
    expect(probe.set).not.toHaveBeenCalled();
    expect(probe.get).not.toHaveBeenCalled();
    expect(probe.remove).not.toHaveBeenCalled();
  });

  it("does not choose a backend when a secret store is injected without a probe", async () => {
    const home = await temporaryHome("vapi-setup-injected-backend-");
    expect(
      await runCli(["setup", "--no-cloud-backup"], captureIo().io, {
        ...baseDependencies(),
        agentLink: linkMocks().operations,
      }),
    ).toBe(0);
    expect(await fileExists(join(home, "secret-store.json"))).toBe(false);
    expect(osSecretStore).not.toHaveBeenCalled();
  });

  it("probes the raw OS store when retrying after a partial file-backed setup", async () => {
    const home = await temporaryHome("vapi-setup-stale-file-pin-");
    const env = { VAPI_VAULT_PASSWORD: "correct horse battery" };
    process.env.VAPI_VAULT_PASSWORD = env.VAPI_VAULT_PASSWORD;
    await createFileSecretStore({ path: join(home, "secrets.json"), env });
    await writeFile(join(home, "secret-store.json"), JSON.stringify({ v: 1, backend: "file" }));
    const probe = brokenLinuxStore();
    vi.mocked(osSecretStore).mockReturnValueOnce(probe);

    expect(
      await runCliWithDependencies(["setup", "--no-cloud-backup"], captureIo().io, {
        ...baseDependencies(),
        agentLink: linkMocks().operations,
        env,
      }),
    ).toBe(0);

    expect(osSecretStore).toHaveBeenCalledExactlyOnceWith();
    expect(probe.set).toHaveBeenCalledExactlyOnceWith("setup-probe", "ok");
    expect(JSON.parse(await readFile(join(home, "secret-store.json"), "utf8"))).toEqual({
      v: 1,
      backend: "file",
    });
  }, 15_000);

  it("creates a fresh vault, links main, and prints the complete next step", async () => {
    const home = await temporaryHome("vapi-setup-new-");
    const link = linkMocks();
    const prompts = scriptedPrompts({
      [SETUP_CHOICE]: "new",
      [PHRASE_GATE]: "",
      [CLOUD_BACKUP_CHOICE]: "n",
    });
    const openUrl = vi.fn(() => true);
    const fetchImpl = zeroBalanceRpc();
    const captured = captureIo();

    expect(
      await runCli(["setup"], captured.io, {
        ...baseDependencies(fetchImpl),
        interactive: true,
        prompts: prompts.prompts,
        agentLink: link.operations,
        openUrl,
      }),
    ).toBe(0);

    const store = await WalletStore.open(home, { secrets: testSecretStore(home) });
    const address = await requiredAddress(store, "main");
    const recoveryWords = captured.stdout[3];
    expect(recoveryWords?.split("\n")).toHaveLength(12);
    expect(captured.stdout).toEqual([
      CUSTODY_NOTICE,
      "",
      "Recovery phrase. These 12 words restore this wallet, and nothing else does:",
      recoveryWords,
      "",
      loginInstructions("main", address),
      "Linked main to 0x1111…1111. Router key stored in the macOS Keychain.",
      CLOUD_BACKUP_OFFER,
      `Fund main: send USDC on Base to ${address} (or run vapi fund --account main).`,
    ]);
    expect(captured.stderr).toEqual([]);
    expect(prompts.prompted).toEqual([SETUP_CHOICE, PHRASE_GATE, CLOUD_BACKUP_CHOICE]);
    expect(
      vi
        .mocked(fetchImpl)
        .mock.calls.some(([input]) => String(input).includes("/api/agents/backup-relays")),
    ).toBe(false);
    expect(
      vi
        .mocked(fetchImpl)
        .mock.calls.some(([input]) => String(input).includes("/api/agents/self/backup")),
    ).toBe(false);
    expect(openUrl).toHaveBeenCalledWith(START.verificationUriComplete);
    expect(link.start).toHaveBeenCalledOnce();
    expect(await fileExists(join(home, "vault.json"))).toBe(true);
    expect(JSON.parse(await readFile(join(home, "wallets.json"), "utf8"))).toMatchObject({
      default: "main",
      wallets: { main: expect.any(Object) },
    });
    expect(store.defaultName).toBe("main");
    expect(store.entry("main")?.link).toBeDefined();
  });

  it("skips cloud backup without consent in a non-interactive setup", async () => {
    await temporaryHome("vapi-setup-no-cloud-noninteractive-");
    const fetchImpl = zeroBalanceRpc();
    const captured = captureIo();

    expect(
      await runCli(["setup", "--json"], captured.io, {
        ...baseDependencies(fetchImpl),
        agentLink: linkMocks().operations,
      }),
    ).toBe(0);

    expect(JSON.parse(captured.stdout[0]!)).toMatchObject({ cloudBackup: "skipped" });
    expect(
      vi
        .mocked(fetchImpl)
        .mock.calls.some(([input]) => String(input).includes("/api/agents/backup-relays")),
    ).toBe(false);
    expect(
      vi
        .mocked(fetchImpl)
        .mock.calls.some(([input]) => String(input).includes("/api/agents/self/backup")),
    ).toBe(false);
  });

  it("does nothing on a second run and prints the status screen", async () => {
    const home = await temporaryHome("vapi-setup-again-");
    const link = linkMocks();
    expect(
      await runCli(["setup"], captureIo().io, {
        ...baseDependencies(),
        agentLink: link.operations,
      }),
    ).toBe(0);
    link.start.mockClear();
    const captured = captureIo();

    expect(
      await runCli(["setup"], captured.io, {
        ...baseDependencies(),
        agentLink: link.operations,
      }),
    ).toBe(0);

    const address = await requiredAddress(
      await WalletStore.open(home, { secrets: testSecretStore(home) }),
      "main",
    );
    expect(captured.stdout).toEqual([
      "Nothing to do.",
      `vAPI ${CLI_VERSION}        home ${home}        registry api.vapinetwork.ai`,
      "",
      "Owner      0x1111…1111   linked      console: https://api.vapinetwork.ai/agents",
      "Vault      unlocked on this device (macOS Keychain)   backup: vapi backup",
      "Cloud backup: off",
      "",
      "Accounts",
      `  main *  ${shortAddress(address)}   0.00 USDC    Router today $0.00 of $1.00   caps $0.10 / $1.00 per day   ceiling 5 USDC   active`,
      "",
      "Next",
      `  ${"vapi pay <ref> --max 0.02".padEnd(34)}pay an API from main`,
      `  ${'vapi router chat "hello"'.padEnd(34)}talk to a model on main's allowance`,
      `  ${"vapi accounts add <name>".padEnd(34)}add an account`,
    ]);
    expect(link.start).not.toHaveBeenCalled();
  });

  it("only links an existing unlinked main account", async () => {
    await temporaryHome("vapi-setup-link-");
    expect(
      await runCli(["init", "--json"], captureIo().io, {
        ...baseDependencies(),
      }),
    ).toBe(0);
    const link = linkMocks();
    const captured = captureIo();

    expect(
      await runCli(["setup", "--no-cloud-backup"], captured.io, {
        ...baseDependencies(),
        agentLink: link.operations,
      }),
    ).toBe(0);

    expect(link.start).toHaveBeenCalledOnce();
    expect(captured.stdout.join("\n")).not.toContain(CUSTODY_NOTICE);
    expect(captured.stdout[0]).toContain("Link this agent to your vAPI account");
  });

  it("restores funded accounts from a prompted phrase and links the default", async () => {
    const home = await temporaryHome("vapi-setup-restore-");
    const link = linkMocks();
    const prompts = scriptedPrompts({
      [SETUP_CHOICE]: "restore",
      "Recovery phrase: ": RECOVERY_PHRASE,
    });
    const captured = captureIo();

    expect(
      await runCli(["setup", "--no-cloud-backup"], captured.io, {
        ...baseDependencies(fundedVectorRpc()),
        interactive: true,
        prompts: prompts.prompts,
        agentLink: link.operations,
        openUrl: vi.fn(() => true),
      }),
    ).toBe(0);

    const store = await WalletStore.open(home, { secrets: testSecretStore(home) });
    expect(store.names()).toEqual(["account-1"]);
    expect(store.defaultName).toBe("account-1");
    expect(await store.readAddress("account-1")).toBe(VECTOR_ADDRESS);
    expect(store.entry("account-1")?.link).toBeDefined();
    expect(captured.stdout[0]).toBe(
      "Vault restored with 1 account(s): account-1. 6 address(es) scanned.",
    );
    expect(captured.stdout.join("\n")).toContain("Code          BCDF-GHJK");
    expect(captured.stdout.at(-1)).toBe(
      `Fund account-1: send USDC on Base to ${VECTOR_ADDRESS} (or run vapi fund --account account-1).`,
    );
    expect(prompts.prompted).toEqual([SETUP_CHOICE, "Recovery phrase: "]);
    expectNoSecretLeak(captured);
  });

  it("fails closed without creating a vault when restore discovery cannot read the chain", async () => {
    const home = await temporaryHome("vapi-setup-restore-error-");
    const prompts = scriptedPrompts({
      [SETUP_CHOICE]: "restore",
      "Recovery phrase: ": RECOVERY_PHRASE,
    });
    const captured = captureIo();

    expect(
      await runCli(["setup"], captured.io, {
        ...baseDependencies(
          vi.fn<typeof fetch>(async () => {
            throw new Error("RPC unavailable");
          }),
        ),
        interactive: true,
        prompts: prompts.prompts,
        agentLink: linkMocks().operations,
      }),
    ).toBe(1);
    expect(captured.stderr.join("\n")).toContain("Could not read the USDC balance");
    expect(await fileExists(join(home, "vault.json"))).toBe(false);
  });

  it("rejects positional recovery words as one usage-error line", async () => {
    await temporaryHome("vapi-setup-argv-");
    const captured = captureIo();

    expect(await runCli(["setup", "some", "words"], captured.io, baseDependencies())).toBe(2);
    expect(captured.stdout).toEqual([]);
    expect(captured.stderr).toEqual([
      "vapi setup accepts only --no-cloud-backup and --accounts <n> (1-10000); a recovery phrase is typed at the prompt, never passed on the command line.",
    ]);
  });

  it("restores a fixed number of accounts without reading balances", async () => {
    const home = await temporaryHome("vapi-setup-fixed-restore-");
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      throw new Error("balance RPC must not be called");
    });
    const captured = captureIo();

    expect(
      await runCli(["setup", "--accounts", "3", "--no-cloud-backup", "--json"], captured.io, {
        ...baseDependencies(fetchImpl),
        interactive: true,
        prompts: scriptedPrompts({
          [SETUP_CHOICE]: "restore",
          "Recovery phrase: ": RECOVERY_PHRASE,
        }).prompts,
        agentLink: linkMocks().operations,
        openUrl: vi.fn(() => true),
      }),
    ).toBe(0);

    const store = await WalletStore.open(home, { secrets: testSecretStore(home) });
    expect(store.names()).toEqual(["account-1", "account-2", "account-3"]);
    expect(JSON.parse(captured.stdout[0]!)).toMatchObject({
      vault: "restored",
      scannedAddresses: 0,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(captured.stderr.join("\n")).toContain("0 address(es) scanned");
  });

  it("rejects invalid fixed account counts before prompting", async () => {
    await temporaryHome("vapi-setup-invalid-count-");
    const captured = captureIo();

    expect(await runCli(["setup", "--accounts", "0"], captured.io, baseDependencies())).toBe(2);
    expect(captured.stderr).toEqual([
      "--accounts must be a positive integer no greater than 10000.",
    ]);
  });

  it("refuses a restore choice without a terminal", async () => {
    await temporaryHome("vapi-setup-headless-restore-");
    const captured = captureIo();

    expect(
      await runCli(["setup", "--no-cloud-backup"], captured.io, {
        ...baseDependencies(),
        prompts: scriptedPrompts({ [SETUP_CHOICE]: "restore" }).prompts,
      }),
    ).toBe(1);
    expect(captured.stdout).toEqual([]);
    expect(captured.stderr).toEqual(["Restoring needs a terminal to type the phrase."]);
  });

  it("never echoes a restore phrase or private-key-shaped value", async () => {
    await temporaryHome("vapi-setup-no-leak-");
    const captured = captureIo();

    expect(
      await runCli(["setup", "--no-cloud-backup"], captured.io, {
        ...baseDependencies(fundedVectorRpc()),
        interactive: true,
        prompts: scriptedPrompts({
          [SETUP_CHOICE]: "restore",
          "Recovery phrase: ": RECOVERY_PHRASE,
        }).prompts,
        agentLink: linkMocks().operations,
        openUrl: vi.fn(() => true),
      }),
    ).toBe(0);
    expectNoSecretLeak(captured);
  });

  it("returns one setup result object with --json", async () => {
    const home = await temporaryHome("vapi-setup-json-");
    const captured = captureIo();

    expect(
      await runCli(["setup", "--json"], captured.io, {
        ...baseDependencies(),
        agentLink: linkMocks().operations,
      }),
    ).toBe(0);

    const store = await WalletStore.open(home, { secrets: testSecretStore(home) });
    const address = await requiredAddress(store, "main");
    expect(captured.stdout).toHaveLength(1);
    expect(JSON.parse(captured.stdout[0]!)).toEqual({
      vault: "created",
      account: "main",
      address,
      linked: true,
      steps: ["config", "vault", "link"],
      cloudBackup: "skipped",
    });
    expect(captured.stderr.join("\n")).toContain("Code          BCDF-GHJK");
  });

  it("keeps interactive cloud enrollment in setup JSON to one stdout object", async () => {
    await temporaryHome("vapi-setup-cloud-json-");
    const link = linkMocks();
    expect(
      await runCli(["setup", "--json"], captureIo().io, {
        ...baseDependencies(),
        agentLink: link.operations,
      }),
    ).toBe(0);
    const captured = captureIo();

    expect(
      await runCli(["setup", "--json"], captured.io, {
        ...baseDependencies(),
        interactive: true,
        prompts: scriptedPrompts({ [CLOUD_BACKUP_CHOICE]: "yes" }).prompts,
        agentLink: link.operations,
        openUrl: vi.fn(() => true),
        cloudBackup: {
          fetchSiblings: async ({ account }) => ({
            owner: OWNER,
            source: { account },
            siblings: [],
          }),
          startRelay: async () => ({
            code: "0123-4567-89AB",
            expiresAt: "2026-09-29T10:21:12.345Z",
            keyPair: { publicKey: new Uint8Array(32), privateKey: new Uint8Array(32) },
          }),
          awaitRelay: async () => ({
            format: "vapi-vault-relay-payload",
            v: 1,
            purpose: "enroll",
            owner: OWNER,
            device: "test-device",
            kdf: { name: "hkdf-sha256", salt: Buffer.alloc(32, 7).toString("base64url") },
            key: Uint8Array.from({ length: 32 }, (_, index) => index + 1),
          }),
          uploadBackup: async () => ({
            status: "uploaded",
            account: "main",
            bytes: 512,
            uploadedAt: "2026-09-29T10:11:12.345Z",
          }),
          sleep: async () => undefined,
        },
        env: { VAPI_DEVICE: "test-device" },
      }),
    ).toBe(0);

    expect(captured.stdout).toHaveLength(1);
    expect(JSON.parse(captured.stdout[0]!)).toMatchObject({
      vault: "existing",
      account: "main",
      cloudBackup: "on",
    });
    expect(captured.stderr.join("\n")).toContain(
      "Open https://api.vapinetwork.ai/agents and enter code 0123-4567-89AB.",
    );
  });
});

async function runCli(argv: string[], io: CliIo, dependencies: CliDependencies): Promise<number> {
  const home = process.env.VAPI_HOME;
  if (home === undefined) throw new Error("A setup test must set VAPI_HOME first.");
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

function baseDependencies(fetchImpl: typeof fetch = zeroBalanceRpc()): CliDependencies {
  return {
    interactive: false,
    env: {},
    fetchImpl,
    status: { timeoutMs: 2_000 },
    router: { routerUsage: async () => usage() },
  };
}

function linkMocks(): {
  start: ReturnType<typeof vi.fn<typeof startDeviceLink>>;
  poll: ReturnType<typeof vi.fn<typeof pollDeviceLink>>;
  operations: NonNullable<CliDependencies["agentLink"]>;
} {
  const start = vi.fn<typeof startDeviceLink>(async () => START);
  const poll = vi.fn<typeof pollDeviceLink>(async () => RESULT);
  return { start, poll, operations: { startDeviceLink: start, pollDeviceLink: poll } };
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

function brokenLinuxStore(): SecretStore {
  const fail = async () => {
    throw new KeystoreError("Cannot autolaunch D-Bus without X11 $DISPLAY");
  };
  return {
    available: true,
    platform: "linux",
    description: "the libsecret keyring",
    set: vi.fn(fail),
    get: vi.fn(fail),
    has: vi.fn(fail),
    remove: vi.fn(fail),
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

function testSecretStore(home: string): SecretStore {
  const store = secretStores.get(home);
  if (store === undefined) throw new Error(`No test secret store for ${home}.`);
  return store;
}

function zeroBalanceRpc(): typeof fetch {
  return rpcForUsdc(() => 0n);
}

function fundedVectorRpc(): typeof fetch {
  return rpcForUsdc((address) =>
    address.toLowerCase() === VECTOR_ADDRESS.toLowerCase() ? 1_000_000n : 0n,
  );
}

function rpcForUsdc(balance: (address: string) => bigint): typeof fetch {
  return vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname === "/api/agents/self") return Response.json({});
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
      result = quantity(balance(address));
    }
    return Response.json({ jsonrpc: "2.0", id: request.id, result });
  });
}

function quantity(value: bigint): string {
  return `0x${value.toString(16).padStart(64, "0")}`;
}

function usage(): AgentRouterUsage {
  return {
    compute: {
      allowanceUsd: 1,
      spentTodayUsd: 0,
      remainingTodayUsd: 1,
      resetsAt: "2026-09-29T00:00:00.000Z",
      ownerLimitUsd: 5,
      ownerSpentUsd: 0,
    },
    balance: null,
  };
}

async function requiredAddress(store: WalletStore, name: string): Promise<string> {
  const address = await store.readAddress(name);
  if (address === undefined) throw new Error(`No address for ${name}.`);
  return address;
}

function loginInstructions(name: string, address: string): string {
  return [
    "Link this agent to your vAPI account",
    "",
    `  Agent wallet  ${name}  ${shortAddress(address)}`,
    "  Code          BCDF-GHJK",
    `  Open          ${START.verificationUriComplete}`,
    "",
    "Sign in there with your own wallet and approve. Waiting…",
  ].join("\n");
}

function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function expectNoSecretLeak(captured: { stdout: string[]; stderr: string[] }): void {
  const output = [...captured.stdout, ...captured.stderr].join("\n");
  expect(output).not.toContain(RECOVERY_PHRASE);
  expect(output).not.toMatch(/0x[0-9a-fA-F]{64}/u);
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
