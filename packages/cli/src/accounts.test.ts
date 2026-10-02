import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ARC_MAINNET_CAIP2,
  BASE_MAINNET_CAIP2,
  TransferError,
  createKeystoreFromPrivateKey,
  listUnfinishedMovements,
  sweepAboveCeiling,
  usdToAtomic,
  type DistributeArgs,
  type SecretStore,
  WalletStore,
} from "@vapi-network/core";
import {
  agentSecretAccounts,
  type DeviceLinkStart,
  type LinkResult,
  type pollDeviceLink,
  type startDeviceLink,
} from "@vapi-network/core/agent-link";
import type { Hex } from "viem";

import {
  runCli as runCliWithDependencies,
  type CliDependencies,
  type CliIo,
  type CliPrompts,
} from "./cli.js";

const PRIVATE_KEYS = [
  `0x${"11".repeat(32)}`,
  `0x${"22".repeat(32)}`,
  `0x${"33".repeat(32)}`,
] as const;
const API_BASE = "https://api.vapinetwork.ai";
const OWNER = "0x1111111111111111111111111111111111111111" as const;
const REMOTE_ADDRESS = "0x52908400098527886e0f7030069857d2e4169ee7";
const UNKNOWN_DEVICE_ADDRESS = "0xde709f2102306220921060314715629080e2fb77";
const START: DeviceLinkStart = {
  clientId: "agent_researcher",
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

const originalHome = process.env.VAPI_HOME;
const homes: string[] = [];
const secretStores = new Map<string, SecretStore>();

afterEach(async () => {
  restoreEnvironment("VAPI_HOME", originalHome);
  secretStores.clear();
  await Promise.all(homes.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("vapi accounts list", () => {
  it("prints the same account line as the status screen and returns the array as JSON", async () => {
    await initializedHome("vapi-accounts-list-");
    const dependencies = baseDependencies();
    const status = captureIo();
    const accounts = captureIo();

    expect(await runCli([], status.io, dependencies)).toBe(0);
    expect(await runCli(["accounts"], accounts.io, dependencies)).toBe(0);

    const statusAccount = status.stdout.find((line) => line.startsWith("  main *"));
    expect(accounts.stdout).toEqual(["Accounts", statusAccount]);

    const json = captureIo();
    expect(await runCli(["accounts", "list", "--json"], json.io, dependencies)).toBe(0);
    expect(JSON.parse(json.stdout[0]!)).toMatchObject([{ name: "main", default: true }]);
  });
});

describe("vapi accounts add", () => {
  it("derives a distinct account, prints the link code and URL, and validates missing names", async () => {
    const home = await initializedHome("vapi-accounts-add-");
    const before = await walletAddress(home, "main");
    const start = vi.fn<typeof startDeviceLink>(async () => START);
    const poll = vi.fn<typeof pollDeviceLink>(async () => RESULT);
    const captured = captureIo();

    expect(
      await runCli(["accounts", "add", "researcher"], captured.io, {
        ...baseDependencies(),
        agentLink: { startDeviceLink: start, pollDeviceLink: poll },
      }),
    ).toBe(0);

    const store = await WalletStore.open(home, { secrets: testSecretStore(home) });
    const researcher = (await store.list()).find(({ name }) => name === "researcher");
    expect(researcher?.address).toMatch(/^0x[0-9a-fA-F]{40}$/u);
    expect(researcher?.address).not.toBe(before);
    expect(captured.stdout[0]).toBe(`Account researcher derived: ${researcher?.address}`);
    expect(captured.stdout.join("\n")).toContain("BCDF-GHJK");
    expect(captured.stdout.join("\n")).toContain(START.verificationUriComplete);
    expect(start).toHaveBeenCalledOnce();
    expect(start.mock.calls[0]![0]).not.toHaveProperty("routerAllowanceUsd");

    const missing = captureIo();
    expect(await runCli(["accounts", "add"], missing.io, baseDependencies())).toBe(2);
    expect(missing.stderr).toEqual([
      "Missing <name>.\nUsage: vapi accounts add <name> [--label <text>] [--no-link] [--json]",
    ]);
  });

  it("requires an existing vault and skips linking with --no-link", async () => {
    await temporaryHome("vapi-accounts-no-vault-");
    const absent = captureIo();
    expect(await runCli(["accounts", "add", "researcher"], absent.io, baseDependencies())).toBe(1);
    expect(absent.stderr).toEqual(["No vault yet. Run vapi setup."]);

    await initializedHome("vapi-accounts-no-link-");
    const start = vi.fn<typeof startDeviceLink>(async () => START);
    const captured = captureIo();
    expect(
      await runCli(["accounts", "add", "offline", "--no-link"], captured.io, {
        ...baseDependencies(),
        agentLink: { startDeviceLink: start },
      }),
    ).toBe(0);
    expect(start).not.toHaveBeenCalled();
  });

  it("prints the derived and trusted-device lines without opening a browser", async () => {
    const home = await initializedHome("vapi-accounts-trusted-");
    const openUrl = vi.fn(() => true);
    const captured = captureIo();

    expect(
      await runCli(["accounts", "add", "trusted"], captured.io, {
        ...baseDependencies(),
        interactive: true,
        hostname: () => "Trusted Mac",
        agentLink: {
          startDeviceLink: async () => ({ ...START, autoApproved: true }),
          pollDeviceLink: async () => RESULT,
        },
        openUrl,
      }),
    ).toBe(0);

    const address = await walletAddress(home, "trusted");
    expect(captured.stdout).toEqual([
      `Account trusted derived: ${address}`,
      "Linked on this trusted device.",
      "Linked trusted to 0x1111…1111. Router key stored in the macOS Keychain.",
    ]);
    expect(captured.stdout.join("\n")).not.toContain(START.userCode);
    expect(captured.stdout.join("\n")).not.toContain(START.verificationUriComplete);
    expect(openUrl).not.toHaveBeenCalled();
  });

  it("omits a Router allowance for a new account on an untrusted device", async () => {
    await initializedHome("vapi-accounts-router-allowance-");
    const authorizationBodies: Array<Record<string, unknown>> = [];
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname === "/api/auth/siwe-nonce") {
        return Response.json({ nonce: "n".repeat(108) });
      }
      if (url.pathname === "/oauth/device_authorization") {
        authorizationBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return Response.json({
          device_code: START.deviceCode,
          user_code: START.userCode,
          client_id: START.clientId,
          verification_uri: START.verificationUri,
          verification_uri_complete: START.verificationUriComplete,
          expires_in: START.expiresIn,
          interval: START.interval,
        });
      }
      throw new Error(`Unexpected test URL ${url.origin}${url.pathname}`);
    });

    expect(
      await runCli(["accounts", "add", "researcher"], captureIo().io, {
        ...baseDependencies(fetchImpl),
        hostname: () => "Test Workstation",
        agentLink: { pollDeviceLink: async () => RESULT },
      }),
    ).toBe(0);

    expect(authorizationBodies).toEqual([
      expect.objectContaining({
        scope: "mcp:call router.use",
        device: "test-workstation",
        trust_device: true,
      }),
    ]);
    expect(authorizationBodies[0]).not.toHaveProperty("router_allowance_usd");
  });
});

describe("vapi accounts import", () => {
  it("imports from a secret prompt, a key file, and a vAPI keystore without leaking keys", async () => {
    const home = await initializedHome("vapi-accounts-import-");

    const prompted = captureIo();
    expect(
      await runCli(["accounts", "import", "prompted"], prompted.io, {
        ...baseDependencies(),
        prompts: scriptedPrompts({ "Private key: ": PRIVATE_KEYS[0] }).prompts,
      }),
    ).toBe(0);

    const keyPath = join(home, "private-key.txt");
    await writeFile(keyPath, `  ${PRIVATE_KEYS[1]}  \n`, { mode: 0o600 });
    const fromFile = captureIo();
    expect(
      await runCli(
        ["accounts", "import", "from-file", "--key-file", keyPath],
        fromFile.io,
        baseDependencies(),
      ),
    ).toBe(0);

    const keystorePath = join(home, "legacy-keystore.json");
    await createKeystoreFromPrivateKey("old-passphrase", keystorePath, {
      privateKey: PRIVATE_KEYS[2],
    });
    const fromKeystore = captureIo();
    expect(
      await runCli(
        ["accounts", "import", "from-keystore", "--keystore", keystorePath],
        fromKeystore.io,
        {
          ...baseDependencies(),
          prompts: scriptedPrompts({
            [`Passphrase for ${keystorePath}: `]: "old-passphrase",
          }).prompts,
        },
      ),
    ).toBe(0);

    const names = (await WalletStore.open(home, { secrets: testSecretStore(home) })).names();
    expect(names).toEqual(["main", "prompted", "from-file", "from-keystore"]);
    const output = [prompted, fromFile, fromKeystore]
      .flatMap(({ stdout, stderr }) => [...stdout, ...stderr])
      .join("\n");
    expect(output).toContain("Imported keys are not in the recovery phrase");
    expect(output).not.toMatch(/0x[0-9a-fA-F]{64}/u);
  });

  it("refuses positional and --key secrets without echoing them", async () => {
    await initializedHome("vapi-accounts-import-refusal-");
    for (const argv of [
      ["accounts", "import", "unsafe", PRIVATE_KEYS[0]],
      ["accounts", "import", "unsafe", "--key", PRIVATE_KEYS[0]],
    ]) {
      const captured = captureIo();
      expect(await runCli(argv, captured.io, baseDependencies())).toBe(2);
      const output = [...captured.stdout, ...captured.stderr].join("\n");
      expect(output).toContain("Private keys never go in argv");
      expect(output).not.toContain(PRIVATE_KEYS[0]);
    }
  });
});

describe("vapi accounts rename, use, remove, and the wallet alias", () => {
  it("renames linked secret entries and changes the default", async () => {
    const home = await initializedHome("vapi-accounts-rename-");
    const entries = testSecretEntries(home);
    expect(
      await runCli(["accounts", "add", "researcher"], captureIo().io, {
        ...baseDependencies(),
        agentLink: { startDeviceLink: async () => START, pollDeviceLink: async () => RESULT },
      }),
    ).toBe(0);
    const oldAccounts = agentSecretAccounts("researcher");
    const oldTokens = entries[oldAccounts.tokens];

    expect(
      await runCli(
        ["accounts", "rename", "researcher", "analyst"],
        captureIo().io,
        baseDependencies(),
      ),
    ).toBe(0);
    const newAccounts = agentSecretAccounts("analyst");
    expect(entries[oldAccounts.tokens]).toBeUndefined();
    expect(entries[newAccounts.tokens]).toBe(oldTokens);
    expect(
      (await WalletStore.open(home, { secrets: testSecretStore(home) })).entry("analyst")?.link
        ?.label,
    ).toBe("analyst");

    expect(await runCli(["accounts", "use", "analyst"], captureIo().io, baseDependencies())).toBe(
      0,
    );
    expect(JSON.parse(await readFile(join(home, "wallets.json"), "utf8"))).toMatchObject({
      default: "analyst",
    });
  });

  it("rewrites a funded refusal and removes a zero-balance account after typed confirmation", async () => {
    await initializedHome("vapi-accounts-remove-");
    expect(
      await runCli(["accounts", "add", "retire", "--no-link"], captureIo().io, baseDependencies()),
    ).toBe(0);

    const funded = captureIo();
    expect(
      await runCli(["accounts", "remove", "retire"], funded.io, {
        ...baseDependencies(fundedRpc()),
        interactive: true,
        prompts: scriptedPrompts({ "Type retire to remove it: ": "retire" }).prompts,
      }),
    ).toBe(1);
    expect(funded.stderr).toEqual([
      "Account retire still holds 1 USDC. Move it out with vapi sweep --account retire first.",
    ]);

    const removed = captureIo();
    expect(
      await runCli(["accounts", "remove", "retire"], removed.io, {
        ...baseDependencies(),
        interactive: true,
        prompts: scriptedPrompts({ "Type retire to remove it: ": "retire" }).prompts,
      }),
    ).toBe(0);
    expect(removed.stdout).toEqual([
      "Account retire removed. Bring it back with vapi accounts restore retire.",
    ]);
  });

  it("keeps vapi wallet list as a deprecated alias", async () => {
    await initializedHome("vapi-wallet-alias-");
    const captured = captureIo();

    expect(await runCli(["wallet", "list"], captured.io, baseDependencies())).toBe(0);
    expect(captured.stderr).toEqual(["vapi wallet is now vapi accounts."]);
    expect(captured.stdout[0]).toBe("Accounts");
    expect(captured.stdout[1]).toMatch(/^ {2}main \*/u);
  });

  it("keeps bare vapi wallet and wallet import as deprecated accounts aliases", async () => {
    await initializedHome("vapi-wallet-full-alias-");

    const bare = captureIo();
    expect(await runCli(["wallet"], bare.io, baseDependencies())).toBe(0);
    expect(bare.stdout[0]).toBe("Accounts");

    const imported = captureIo();
    expect(
      await runCli(["wallet", "import", "legacy"], imported.io, {
        ...baseDependencies(),
        prompts: scriptedPrompts({ "Private key: ": PRIVATE_KEYS[0] }).prompts,
      }),
    ).toBe(0);
    expect(imported.stdout.join("\n")).toContain("Account legacy imported:");
  });

  it("does not let --force remove an account that still has funds", async () => {
    const home = await initializedHome("vapi-accounts-force-funded-");
    expect(
      await runCli(["accounts", "add", "funded", "--no-link"], captureIo().io, baseDependencies()),
    ).toBe(0);
    const captured = captureIo();

    expect(
      await runCli(["accounts", "remove", "funded", "--force"], captured.io, {
        ...baseDependencies(fundedRpc()),
        interactive: false,
      }),
    ).toBe(1);
    expect(captured.stderr).toEqual([
      "Account funded still holds 1 USDC. Move it out with vapi sweep --account funded first.",
    ]);
    expect((await WalletStore.open(home, { secrets: testSecretStore(home) })).has("funded")).toBe(
      true,
    );
  });
});

describe("vapi accounts --all", () => {
  it("shows other-device siblings as read-only rows with device fallbacks", async () => {
    const home = await initializedHome("vapi-accounts-all-human-");
    await linkAccount(home);
    const captured = captureIo();

    expect(
      await runCli(
        ["accounts", "--all"],
        captured.io,
        baseDependencies(
          siblingsFetch([
            sibling({ name: "researcher", address: REMOTE_ADDRESS, device: "lab-laptop" }),
            sibling({
              name: "observer",
              address: UNKNOWN_DEVICE_ADDRESS,
              device: null,
              allowance: { routerPerDayUsd: null, perCallUsd: null, perDayUsd: null },
            }),
          ]),
        ),
      ),
    ).toBe(0);

    expect(captured.stdout.slice(0, 4)).toEqual([
      "Accounts",
      expect.stringMatching(/^ {2}main \*/u),
      "",
      "On other devices",
    ]);
    const researcher = captured.stdout.find((line) => line.includes("researcher"));
    expect(researcher).toContain("0x5290…9EE7");
    expect(researcher).toContain("lab-laptop");
    expect(researcher).toContain("active");
    expect(researcher).toContain("Router $20.00 per day");
    expect(researcher).toMatch(/read-only$/u);
    const observer = captured.stdout.find((line) => line.includes("observer"));
    expect(observer).toContain("unknown device");
    expect(observer).toContain("Router allowance not set");
    expect(observer).toMatch(/read-only$/u);
    expect(captured.stderr).toEqual([]);
  });

  it("shows revoked remote siblings and marks a matching local account revoked once", async () => {
    const home = await initializedHome("vapi-accounts-all-revoked-");
    expect(
      await runCli(["accounts", "add", "travel", "--no-link"], captureIo().io, baseDependencies()),
    ).toBe(0);
    const localAddress = await walletAddress(home, "travel");
    await linkAccount(home);
    const captured = captureIo();

    expect(
      await runCli(
        ["accounts", "--all"],
        captured.io,
        baseDependencies(
          siblingsFetch([
            sibling({
              name: "travel-copy",
              address: localAddress,
              device: "phone",
              status: "revoked",
            }),
            sibling({
              name: "retired",
              address: REMOTE_ADDRESS,
              device: "old-laptop",
              status: "revoked",
            }),
          ]),
        ),
      ),
    ).toBe(0);

    expect(captured.stdout.find((line) => line.startsWith("  travel "))).toMatch(/revoked$/u);
    expect(captured.stdout.join("\n")).not.toContain("travel-copy");
    const retired = captured.stdout.find((line) => line.includes("retired"));
    expect(retired).toContain("revoked");
    expect(retired).toMatch(/read-only$/u);
  });

  it("accepts both accounts --all and accounts list --all", async () => {
    const home = await initializedHome("vapi-accounts-all-spellings-");
    await linkAccount(home);
    const fetchImpl = siblingsFetch([sibling()]);

    for (const argv of [
      ["accounts", "--all"],
      ["accounts", "list", "--all"],
    ]) {
      const captured = captureIo();
      expect(await runCli(argv, captured.io, baseDependencies(fetchImpl))).toBe(0);
      expect(captured.stdout).toContain("On other devices");
      expect(captured.stdout.some((line) => line.includes("researcher"))).toBe(true);
    }
  });

  it("prints an explicit empty other-device block when every account is local", async () => {
    const home = await initializedHome("vapi-accounts-all-empty-");
    await linkAccount(home);
    const captured = captureIo();

    expect(
      await runCli(["accounts", "--all"], captured.io, baseDependencies(siblingsFetch([]))),
    ).toBe(0);
    expect(captured.stdout.slice(-3)).toEqual(["", "On other devices", "  (none)"]);
  });

  it("keeps JSON without --all byte-identical and never requests siblings", async () => {
    const home = await initializedHome("vapi-accounts-json-unchanged-");
    await linkAccount(home);
    const fetchImpl = siblingsFetch([sibling()]);
    const dependencies = baseDependencies(fetchImpl);
    const status = captureIo();
    const bare = captureIo();
    const list = captureIo();

    expect(await runCli(["--json"], status.io, dependencies)).toBe(0);
    fetchImpl.mockClear();
    expect(await runCli(["accounts", "--json"], bare.io, dependencies)).toBe(0);
    expect(await runCli(["accounts", "list", "--json"], list.io, dependencies)).toBe(0);
    const expected = JSON.stringify(
      (JSON.parse(status.stdout[0]!) as { accounts: unknown[] }).accounts,
    );
    expect(bare.stdout).toEqual([expected]);
    expect(list.stdout).toEqual([expected]);
    expect(fetchImpl.mock.calls.map(([input]) => String(input))).not.toContain(
      `${API_BASE}/api/agents/self/siblings`,
    );
  });

  it("returns only local accounts and other-device siblings in --all JSON", async () => {
    const home = await initializedHome("vapi-accounts-all-json-");
    const localAddress = await walletAddress(home, "main");
    await linkAccount(home);
    const captured = captureIo();

    expect(
      await runCli(
        ["accounts", "--all", "--json"],
        captured.io,
        baseDependencies(
          siblingsFetch([
            sibling({ name: "main-copy", address: localAddress, self: true }),
            sibling(),
          ]),
        ),
      ),
    ).toBe(0);

    const result = JSON.parse(captured.stdout[0]!) as Record<string, unknown>;
    expect(Object.keys(result)).toEqual(["accounts", "siblings"]);
    expect(result.accounts).toEqual([expect.objectContaining({ name: "main" })]);
    expect(result.siblings).toEqual([
      expect.objectContaining({
        name: "researcher",
        address: "0x52908400098527886E0F7030069857D2E4169EE7",
      }),
    ]);
    expect(captured.stderr).toEqual([]);
  });

  it("prints the login hint and exits zero when no local account is linked", async () => {
    await initializedHome("vapi-accounts-all-unlinked-");
    const ordinary = captureIo();
    const human = captureIo();
    const json = captureIo();
    const dependencies = baseDependencies();

    expect(await runCli(["accounts"], ordinary.io, dependencies)).toBe(0);
    expect(await runCli(["accounts", "--all"], human.io, dependencies)).toBe(0);
    expect(human.stdout).toEqual(ordinary.stdout);
    expect(human.stderr).toEqual(["Link an account to see accounts on other devices: vapi login"]);

    expect(await runCli(["accounts", "--all", "--json"], json.io, dependencies)).toBe(0);
    expect(JSON.parse(json.stdout[0]!)).toMatchObject({
      accounts: [expect.objectContaining({ name: "main" })],
      siblings: [],
      siblingsError: "Link an account to see accounts on other devices: vapi login",
    });
    expect(json.stderr).toEqual(["Link an account to see accounts on other devices: vapi login"]);
  });

  it("keeps the local list on network and unsupported failures", async () => {
    const home = await initializedHome("vapi-accounts-all-failures-");
    await linkAccount(home);
    const cases = [
      {
        fetchImpl: siblingsFetch([], { rejectSiblings: true }),
        message: "The vAPI siblings request failed.",
      },
      {
        fetchImpl: siblingsFetch([], { siblingsStatus: 404 }),
        message: "This vAPI server does not list siblings yet.",
      },
    ];

    for (const failure of cases) {
      const human = captureIo();
      expect(
        await runCli(["accounts", "--all"], human.io, baseDependencies(failure.fetchImpl)),
      ).toBe(0);
      expect(human.stdout[0]).toBe("Accounts");
      expect(human.stdout.some((line) => line.startsWith("  main *"))).toBe(true);
      expect(human.stdout).not.toContain("On other devices");
      expect(human.stderr).toEqual([failure.message]);

      const json = captureIo();
      expect(
        await runCli(["accounts", "--all", "--json"], json.io, baseDependencies(failure.fetchImpl)),
      ).toBe(0);
      expect(JSON.parse(json.stdout[0]!)).toMatchObject({
        accounts: [expect.objectContaining({ name: "main" })],
        siblings: [],
        siblingsError: failure.message,
      });
      expect(json.stderr).toEqual([]);
    }
  });

  it("stops a stalled siblings request at a finite deadline and keeps the local list", async () => {
    const home = await initializedHome("vapi-accounts-all-timeout-");
    await linkAccount(home);
    const captured = captureIo();
    vi.useFakeTimers();

    try {
      const fetchImpl = siblingsFetch([], { stallSiblings: true });
      const pending = runCli(["accounts", "--all"], captured.io, baseDependencies(fetchImpl));
      await vi.waitFor(() =>
        expect(fetchImpl.mock.calls.some(([input]) => String(input).endsWith("/siblings"))).toBe(
          true,
        ),
      );
      await vi.advanceTimersByTimeAsync(8_000);

      await expect(pending).resolves.toBe(0);
      expect(captured.stdout[0]).toBe("Accounts");
      expect(captured.stdout.some((line) => line.startsWith("  main *"))).toBe(true);
      expect(captured.stderr).toEqual(["The vAPI siblings request failed."]);
      const siblingsCall = fetchImpl.mock.calls.find(([input]) =>
        String(input).endsWith("/siblings"),
      );
      expect(siblingsCall?.[1]?.signal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects stray list arguments and unknown --all options with exit code 2", async () => {
    await initializedHome("vapi-accounts-all-usage-");

    for (const argv of [
      ["accounts", "list", "extra"],
      ["accounts", "--all", "--nope"],
    ]) {
      const captured = captureIo();
      expect(await runCli(argv, captured.io, baseDependencies())).toBe(2);
    }

    const json = captureIo();
    expect(
      await runCli(["accounts", "--all", "--nope", "--json"], json.io, baseDependencies()),
    ).toBe(2);
    expect(JSON.parse(json.stdout[0]!)).toEqual({ error: "Unknown option --nope.", exitCode: 2 });
  });

  it("never prints the linked credentials or a test private key", async () => {
    const home = await initializedHome("vapi-accounts-all-secrets-");
    await linkAccount(home);
    const fetchImpl = siblingsFetch([sibling()]);
    const human = captureIo();
    const json = captureIo();

    expect(await runCli(["accounts", "--all"], human.io, baseDependencies(fetchImpl))).toBe(0);
    expect(
      await runCli(["accounts", "--all", "--json"], json.io, baseDependencies(fetchImpl)),
    ).toBe(0);

    const output = [...human.stdout, ...human.stderr, ...json.stdout, ...json.stderr].join("\n");
    expect(output).not.toContain(RESULT.tokens.accessToken);
    expect(output).not.toContain(RESULT.tokens.refreshToken);
    expect(output).not.toContain(PRIVATE_KEYS[0]);
  });
});

describe("vapi accounts distribute", () => {
  it("prints one human row per recipient and a totals line", async () => {
    const fixture = await distributionFixture();
    const captured = captureIo();

    expect(
      await runCli(
        ["accounts", "distribute", "10", "--from", "main", "--to", "research,writer,reviewer"],
        captured.io,
        fixture.dependencies,
      ),
    ).toBe(0);

    expect(captured.stdout[0]).toContain("Account");
    expect(captured.stdout[1]).toMatch(/^research\s+3\.34 USDC\s+sent\s+0x/u);
    expect(captured.stdout[2]).toMatch(/^writer\s+3\.33 USDC\s+sent\s+0x/u);
    expect(captured.stdout[3]).toMatch(/^reviewer\s+3\.33 USDC\s+sent\s+0x/u);
    expect(captured.stdout.at(-1)).toBe("Totals: 10.00 USDC sent; 0.00 USDC not sent.");
  });

  it("returns the documented JSON shape including movementId", async () => {
    const fixture = await distributionFixture();
    const captured = captureIo();

    expect(
      await runCli(
        ["accounts", "distribute", "1", "--from", "main", "--to", "research", "--json"],
        captured.io,
        fixture.dependencies,
      ),
    ).toBe(0);

    expect(JSON.parse(captured.stdout[0]!)).toEqual({
      movementId: "mv_cli_test_1234",
      from: "main",
      network: BASE_MAINNET_CAIP2,
      requestedUsd: "1.00",
      legs: [
        {
          to: "research",
          amountUsd: "1.00",
          status: "sent",
          txHash: expect.stringMatching(/^0x/u),
          nonce: nonce(1),
        },
      ],
      sentUsd: "1.00",
      failedUsd: "0.00",
    });
  });

  it("continues after leg two fails and exits with partial-failure code 1", async () => {
    const fixture = await distributionFixture({ failRecipient: "writer" });
    const captured = captureIo();

    expect(
      await runCli(
        [
          "accounts",
          "distribute",
          "10",
          "--from",
          "main",
          "--to",
          "research,writer,reviewer",
          "--json",
        ],
        captured.io,
        fixture.dependencies,
      ),
    ).toBe(1);

    const result = JSON.parse(captured.stdout[0]!);
    expect(result.legs.map((leg: { status: string }) => leg.status)).toEqual([
      "sent",
      "failed",
      "sent",
    ]);
    expect(result.legs[1]).toMatchObject({ to: "writer", reason: "relay_failed" });
    expect(result).toMatchObject({ sentUsd: "6.67", failedUsd: "3.33" });
    expect(fixture.transfer).toHaveBeenCalledTimes(3);
  });

  it("treats recipient, split, network, and resume conflicts as usage errors", async () => {
    const fixture = await distributionFixture();
    const cases = [
      ["accounts", "distribute", "1", "--from", "main", "--to", "main"],
      ["accounts", "distribute", "0.01", "--from", "main", "--to", "research,writer"],
      ["accounts", "distribute", "1", "--from", "main", "--network", "other"],
      ["accounts", "distribute", "1", "--resume", "mv_cli_test_1234"],
      ["accounts", "distribute", "--resume", "mv_cli_test_1234", "--to", "research"],
    ];

    for (const argv of cases) {
      const captured = captureIo();
      expect(await runCli(argv, captured.io, fixture.dependencies)).toBe(2);
    }

    const noRecipient = captureIo();
    expect(
      await runCli(["accounts", "distribute", "1", "--from", "main"], noRecipient.io, {
        ...fixture.dependencies,
        distribute: {
          ...fixture.dependencies.distribute,
          siblingsReader: async () => ({
            owner: null,
            source: { account: "main" },
            siblings: [],
          }),
        },
      }),
    ).toBe(2);
    expect(noRecipient.stderr.join("\n")).toContain("No eligible recipient accounts were found.");
    expect(fixture.transfer).not.toHaveBeenCalled();
  });

  it("refuses a new movement with the resume command and resumes only planned legs", async () => {
    let crash = true;
    const fixture = await distributionFixture({
      transfer: async (args) => {
        if (crash && args.to === "writer") throw new Error("simulated process crash");
        return sentTransfer(args);
      },
    });
    const first = captureIo();
    expect(
      await runCli(
        ["accounts", "distribute", "3", "--from", "main", "--to", "research,writer,reviewer"],
        first.io,
        fixture.dependencies,
      ),
    ).toBe(1);

    const [unfinished] = await listUnfinishedMovements({ home: fixture.home, from: "main" });
    expect(unfinished?.id).toBe("mv_cli_test_1234");
    const refused = captureIo();
    expect(
      await runCli(
        ["accounts", "distribute", "1", "--from", "main", "--to", "research"],
        refused.io,
        fixture.dependencies,
      ),
    ).toBe(1);
    expect(refused.stderr.join("\n")).toContain(
      "vapi accounts distribute --resume mv_cli_test_1234",
    );

    crash = false;
    const resumed = captureIo();
    expect(
      await runCli(
        ["accounts", "distribute", "--resume", "mv_cli_test_1234", "--json"],
        resumed.io,
        fixture.dependencies,
      ),
    ).toBe(0);
    expect(
      JSON.parse(resumed.stdout[0]!).legs.map((leg: { status: string }) => leg.status),
    ).toEqual(["sent", "sent", "sent"]);
    expect(fixture.transfer).toHaveBeenCalledTimes(4);
  });

  it("uses the stored sender link when resuming an all-failed movement", async () => {
    const alternateApi = "https://alternate-registry.example";
    let fail = true;
    const fixture = await distributionFixture({
      transfer: async (args) => {
        if (fail) {
          throw new TransferError("relay_failed", "definite refusal", {
            reservationReleased: true,
          });
        }
        return sentTransfer(args);
      },
    });
    await fixture.store.setLink("main", {
      apiBase: alternateApi,
      clientId: "agent_main",
      owner: OWNER,
      label: "main",
      scopes: ["mcp:call"],
      linkedAt: "2026-09-29T09:00:00.000Z",
    });

    expect(
      await runCli(
        ["accounts", "distribute", "1", "--from", "main", "--to", "research", "--json"],
        captureIo().io,
        fixture.dependencies,
      ),
    ).toBe(1);
    await expect(
      listUnfinishedMovements({ home: fixture.home, from: "main" }),
    ).resolves.toMatchObject([{ id: "mv_cli_test_1234" }]);

    fail = false;
    expect(
      await runCli(
        ["accounts", "distribute", "--resume", "mv_cli_test_1234", "--json"],
        captureIo().io,
        fixture.dependencies,
      ),
    ).toBe(0);
    expect(fixture.transfer.mock.calls[1]?.[0].apiBase).toBe(alternateApi);
  });

  it("requires the terminal-only flag before replacing an expired restored nonce", async () => {
    let freshAttempts = 0;
    const fixture = await distributionFixture({
      transfer: async (args) => {
        const sent = sentTransfer(args);
        if (args.resume !== undefined || freshAttempts++ === 0) {
          return { ...sent, status: "unknown", txHash: null };
        }
        return sent;
      },
    });
    fixture.dependencies.distribute!.authorizationState = async () => "expired";

    expect(
      await runCli(
        ["accounts", "distribute", "1", "--from", "main", "--to", "research", "--json"],
        captureIo().io,
        fixture.dependencies,
      ),
    ).toBe(1);
    const movementPath = join(fixture.home, "movements", "mv_cli_test_1234.json");
    const movement = JSON.parse(await readFile(movementPath, "utf8")) as {
      legs: Array<Record<string, unknown>>;
    };
    movement.legs = movement.legs.map((leg) => ({ ...leg, restored: true }));
    await writeFile(movementPath, `${JSON.stringify(movement, null, 2)}\n`, "utf8");

    const refused = captureIo();
    expect(
      await runCli(
        ["accounts", "distribute", "--resume", "mv_cli_test_1234"],
        refused.io,
        fixture.dependencies,
      ),
    ).toBe(1);
    expect(refused.stderr.join("\n")).toContain("The original device may already have paid it");
    expect(refused.stderr.join("\n")).toContain("--replace-expired-restored");

    const replaced = captureIo();
    expect(
      await runCli(
        [
          "accounts",
          "distribute",
          "--resume",
          "mv_cli_test_1234",
          "--replace-expired-restored",
          "--json",
        ],
        replaced.io,
        fixture.dependencies,
      ),
    ).toBe(0);
    expect(JSON.parse(replaced.stdout[0]!).legs).toMatchObject([
      { status: "sent", nonce: nonce(2) },
    ]);
    expect(fixture.transfer.mock.calls.at(-1)?.[0]).toMatchObject({ nonce: nonce(2) });
    expect(fixture.transfer.mock.calls.at(-1)?.[0].resume).toBeUndefined();

    expect(
      await runCli(
        [
          "accounts",
          "distribute",
          "1",
          "--from",
          "main",
          "--to",
          "research",
          "--replace-expired-restored",
        ],
        captureIo().io,
        fixture.dependencies,
      ),
    ).toBe(2);
  });

  it("requires terminal review before binding current names in an unsigned legacy movement", async () => {
    const fixture = await distributionFixture();
    const movementId = "mv_legacybind01";
    await mkdir(join(fixture.home, "movements"), { recursive: true });
    await writeFile(
      join(fixture.home, "movements", `${movementId}.json`),
      `${JSON.stringify({
        v: 1,
        id: movementId,
        reason: "distribute",
        from: "main",
        network: BASE_MAINNET_CAIP2,
        createdAt: "2026-09-30T10:00:00.000Z",
        legs: [
          {
            to: "research",
            amountUsd: "1.00",
            nonce: nonce(9),
            status: "failed",
            reason: "signing_failed",
            retryable: true,
          },
        ],
      })}\n`,
      "utf8",
    );

    const refused = captureIo();
    expect(
      await runCli(
        ["accounts", "distribute", "--resume", movementId],
        refused.io,
        fixture.dependencies,
      ),
    ).toBe(1);
    expect(refused.stderr.join("\n")).toContain("--bind-legacy-addresses");
    expect(fixture.transfer).not.toHaveBeenCalled();

    const accepted = captureIo();
    expect(
      await runCli(
        ["accounts", "distribute", "--resume", movementId, "--bind-legacy-addresses", "--json"],
        accepted.io,
        fixture.dependencies,
      ),
    ).toBe(0);
    expect(JSON.parse(accepted.stdout[0]!)).toMatchObject({
      movementId,
      legacyAddressBindings: [
        {
          from: "main",
          to: "research",
          fromAddress: expect.stringMatching(/^0x/u),
          toAddress: expect.stringMatching(/^0x/u),
        },
      ],
    });
    expect(fixture.transfer).toHaveBeenCalledOnce();

    expect(
      await runCli(
        [
          "accounts",
          "distribute",
          "1",
          "--from",
          "main",
          "--to",
          "research",
          "--bind-legacy-addresses",
        ],
        captureIo().io,
        fixture.dependencies,
      ),
    ).toBe(2);
  });

  it("cancels an unsigned movement from the terminal, prints the balance check, and signs nothing", async () => {
    const fixture = await distributionFixture();
    const movementId = "mv_clicancel01";
    await mkdir(join(fixture.home, "movements"), { recursive: true });
    await writeFile(
      join(fixture.home, "movements", `${movementId}.json`),
      `${JSON.stringify({
        v: 2,
        id: movementId,
        reason: "distribute",
        from: "main",
        network: BASE_MAINNET_CAIP2,
        createdAt: "2026-09-30T10:00:00.000Z",
        legs: [
          {
            from: "main",
            to: "research",
            amountUsd: "1.00",
            purpose: "send",
            nonce: nonce(9),
            status: "planned",
          },
        ],
      })}\n`,
      "utf8",
    );
    const human = captureIo();

    expect(
      await runCli(
        ["accounts", "distribute", "--cancel", movementId],
        human.io,
        fixture.dependencies,
      ),
    ).toBe(0);
    expect(human.stdout.join("\n")).toContain("Cancelled 1.00 USDC from main to research");
    expect(human.stdout.join("\n")).toContain("vapi balance --account main");
    expect(fixture.transfer).not.toHaveBeenCalled();
    expect(
      JSON.parse(await readFile(join(fixture.home, "movements", `${movementId}.json`), "utf8")),
    ).toMatchObject({ legs: [{ status: "cancelled", nonce: nonce(9) }] });

    const json = captureIo();
    expect(
      await runCli(
        ["accounts", "distribute", "--cancel", movementId, "--json"],
        json.io,
        fixture.dependencies,
      ),
    ).toBe(0);
    expect(JSON.parse(json.stdout[0]!)).toMatchObject({
      movementId,
      legs: [
        {
          from: "main",
          to: "research",
          amountUsd: "1.00",
          nonce: nonce(9),
          status: "cancelled",
        },
      ],
      balanceCheck: "vapi balance --account main",
    });
    expect(fixture.transfer).not.toHaveBeenCalled();

    for (const argv of [
      ["accounts", "distribute", "1", "--cancel", movementId],
      ["accounts", "distribute", "--resume", movementId, "--cancel", movementId],
      ["accounts", "distribute", "--cancel", movementId, "--bind-legacy-addresses"],
    ]) {
      expect(await runCli(argv, captureIo().io, fixture.dependencies)).toBe(2);
    }
  });

  it("allows the terminal restored override with cancel but never the legacy binding flag", async () => {
    const fixture = await distributionFixture();
    const movementId = "mv_clicancel02";
    await mkdir(join(fixture.home, "movements"), { recursive: true });
    await writeFile(
      join(fixture.home, "movements", `${movementId}.json`),
      `${JSON.stringify({
        v: 2,
        id: movementId,
        reason: "distribute",
        from: "main",
        network: BASE_MAINNET_CAIP2,
        createdAt: "2026-09-30T10:00:00.000Z",
        legs: [
          {
            from: "main",
            to: "research",
            amountUsd: "1.00",
            purpose: "send",
            nonce: nonce(10),
            status: "failed",
            reason: "relay_failed",
            retryable: false,
            restored: true,
          },
        ],
      })}\n`,
      "utf8",
    );

    const cancelled = captureIo();
    expect(
      await runCli(
        ["accounts", "distribute", "--cancel", movementId, "--replace-expired-restored", "--json"],
        cancelled.io,
        fixture.dependencies,
      ),
    ).toBe(0);
    expect(JSON.parse(cancelled.stdout[0]!)).toMatchObject({
      movementId,
      legs: [{ status: "cancelled", nonce: nonce(10) }],
    });
    expect(fixture.transfer).not.toHaveBeenCalled();

    expect(
      await runCli(
        ["accounts", "distribute", "--cancel", movementId, "--bind-legacy-addresses"],
        captureIo().io,
        fixture.dependencies,
      ),
    ).toBe(2);
  });
});

describe("vapi accounts caps ceiling", () => {
  it("stores numeric and off ceilings and exposes caps.ceilingUsd in account JSON", async () => {
    const home = await initializedHome("vapi-accounts-ceiling-");
    const set = captureIo();
    expect(
      await runCli(
        ["accounts", "caps", "main", "--ceiling", "4.25", "--json"],
        set.io,
        baseDependencies(),
      ),
    ).toBe(0);
    expect(JSON.parse(set.stdout[0]!)).toMatchObject({
      wallet: "main",
      ceilingUsd: "4.25",
      message: "Ceiling updated for main.",
    });

    const listed = captureIo();
    expect(await runCli(["accounts", "--json"], listed.io, baseDependencies())).toBe(0);
    expect(JSON.parse(listed.stdout[0]!)[0]).toMatchObject({
      caps: { ceilingUsd: "4.25" },
    });

    const off = captureIo();
    expect(
      await runCli(
        ["accounts", "caps", "main", "--ceiling", "off", "--json"],
        off.io,
        baseDependencies(),
      ),
    ).toBe(0);
    expect(JSON.parse(off.stdout[0]!)).toMatchObject({ ceilingUsd: "off" });

    const store = await WalletStore.open(home, { secrets: testSecretStore(home) });
    await store.setLink("main", {
      apiBase: API_BASE,
      clientId: "agent_main",
      owner: OWNER,
      label: "main",
      scopes: [],
      linkedAt: "2026-09-29T12:00:00.000Z",
    });
    const transfer = vi.fn<NonNullable<DistributeArgs["transfer"]>>();
    expect(
      await sweepAboveCeiling({
        store,
        secrets: testSecretStore(home),
        apiBase: API_BASE,
        account: "main",
        balanceReader: async () => 20_000_000n,
        transfer,
      }),
    ).toMatchObject({ status: "skipped", reason: "ceiling_off" });
    expect(store.ceilingCaps("main").ceilingAtomic).toBeNull();
    expect(transfer).not.toHaveBeenCalled();
  });
});

async function distributionFixture(
  options: {
    failRecipient?: string;
    transfer?: NonNullable<DistributeArgs["transfer"]>;
  } = {},
) {
  const home = await initializedHome("vapi-accounts-distribute-");
  const secrets = testSecretStore(home);
  const store = await WalletStore.open(home, { secrets });
  for (const name of ["research", "writer", "reviewer"]) await store.create(name, "");
  await store.setSpendCaps("main", {
    perCallAtomic: "100000000",
    perDayAtomic: "100000000",
  });
  let nonceIndex = 0;
  const transfer = vi.fn<NonNullable<DistributeArgs["transfer"]>>(
    options.transfer ??
      (async (args) => {
        if (args.to === options.failRecipient) {
          throw new TransferError("relay_failed", "The relay failed.", {
            reservationReleased: true,
          });
        }
        return sentTransfer(args);
      }),
  );
  const dependencies: CliDependencies = {
    ...baseDependencies(),
    distribute: {
      balanceReader: async () => 100_000_000n,
      transfer,
      randomId: () => "mv_cli_test_1234",
      randomNonce: () => nonce(++nonceIndex),
    },
  };
  return { home, store, transfer, dependencies };
}

function nonce(index: number): Hex {
  return `0x${index.toString(16).padStart(64, "0")}`;
}

function sentTransfer(
  args: Parameters<NonNullable<DistributeArgs["transfer"]>>[0],
): Awaited<ReturnType<NonNullable<DistributeArgs["transfer"]>>> {
  return {
    status: "sent",
    from: args.from,
    to: OWNER,
    toName: args.to,
    toKind: "account",
    amountUsd: String(args.amountUsd),
    amountAtomic: usdToAtomic(args.amountUsd).toString(),
    network:
      args.network === "arc" || args.network === ARC_MAINNET_CAIP2
        ? ARC_MAINNET_CAIP2
        : BASE_MAINNET_CAIP2,
    txHash: `0x${"34".repeat(32)}`,
    nonce: (args.nonce ?? args.resume)!,
    replayed: false,
  };
}

async function runCli(argv: string[], io: CliIo, dependencies: CliDependencies): Promise<number> {
  const home = process.env.VAPI_HOME;
  if (home === undefined) throw new Error("An accounts test must set VAPI_HOME first.");
  const secrets = dependencies.secretStore ?? secretStores.get(home) ?? secretStoreStub();
  secretStores.set(home, secrets);
  return await runCliWithDependencies(argv, io, { ...dependencies, secretStore: secrets });
}

async function initializedHome(prefix: string): Promise<string> {
  const home = await temporaryHome(prefix);
  expect(await runCli(["init", "--json"], captureIo().io, baseDependencies())).toBe(0);
  return home;
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
    status: { timeoutMs: 1_000 },
  };
}

async function linkAccount(home: string, name = "main"): Promise<void> {
  const secrets = testSecretStore(home);
  const store = await WalletStore.open(home, { secrets });
  await store.setLink(name, {
    apiBase: API_BASE,
    clientId: `agent_${name}`,
    owner: OWNER,
    label: name,
    scopes: [...RESULT.tokens.scopes],
    linkedAt: "2026-09-23T10:00:00.000Z",
  });
  await secrets.set(agentSecretAccounts(name).tokens, JSON.stringify(RESULT.tokens));
}

function sibling(
  overrides: Partial<{
    name: string;
    address: string;
    device: string | null;
    status: "active" | "revoked";
    allowance: {
      routerPerDayUsd: number | null;
      perCallUsd: number | null;
      perDayUsd: number | null;
    };
    self: boolean;
  }> = {},
) {
  return {
    name: "researcher",
    address: REMOTE_ADDRESS,
    device: "lab-laptop",
    status: "active" as const,
    allowance: { routerPerDayUsd: 20, perCallUsd: 1, perDayUsd: 5 },
    self: false,
    ...overrides,
  };
}

function siblingsFetch(
  siblings: ReturnType<typeof sibling>[],
  options: { rejectSiblings?: boolean; siblingsStatus?: number; stallSiblings?: boolean } = {},
) {
  return vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    if (url === `${API_BASE}/api/agents/self/siblings`) {
      if (options.rejectSiblings) throw new Error(`rejected ${RESULT.tokens.accessToken}`);
      if (options.stallSiblings) {
        return await new Promise<Response>(() => undefined);
      }
      if (options.siblingsStatus !== undefined) {
        return new Response(null, { status: options.siblingsStatus });
      }
      return Response.json({ owner: OWNER, siblings });
    }
    if (url === `${API_BASE}/api/agents/self/router`) {
      return Response.json({
        compute: {
          allowanceUsd: 20,
          spentTodayUsd: 1.25,
          remainingTodayUsd: 18.75,
          resetsAt: "2026-09-30T00:00:00.000Z",
          ownerLimitUsd: 100,
          ownerSpentUsd: 1.25,
        },
        balance: null,
      });
    }
    if (url === `${API_BASE}/api/agents/self`) {
      return Response.json({ status: "active" });
    }
    const request = JSON.parse(String(init?.body)) as { id: number; method: string };
    return Response.json({
      jsonrpc: "2.0",
      id: request.id,
      result: request.method === "eth_call" ? quantity(0n) : "0x0",
    });
  });
}

async function walletAddress(home: string, name: string): Promise<string> {
  const address = await (
    await WalletStore.open(home, { secrets: testSecretStore(home) })
  ).readAddress(name);
  if (address === undefined) throw new Error(`No address for account ${name}.`);
  return address;
}

const secretEntries = new WeakMap<SecretStore, Record<string, string>>();

function secretStoreStub(entries: Record<string, string> = {}): SecretStore {
  const store: SecretStore = {
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
  secretEntries.set(store, entries);
  return store;
}

function testSecretStore(home: string): SecretStore {
  const store = secretStores.get(home);
  if (store === undefined) throw new Error(`No test secret store for ${home}.`);
  return store;
}

function testSecretEntries(home: string): Record<string, string> {
  const entries = secretEntries.get(testSecretStore(home));
  if (entries === undefined) throw new Error(`No test secret entries for ${home}.`);
  return entries;
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

function fundedRpc(): typeof fetch {
  return vi.fn<typeof fetch>(async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as { id: number; method: string };
    return Response.json({
      jsonrpc: "2.0",
      id: request.id,
      result: request.method === "eth_call" ? quantity(1_000_000n) : "0x0",
    });
  });
}

function quantity(value: bigint): string {
  return `0x${value.toString(16).padStart(64, "0")}`;
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
