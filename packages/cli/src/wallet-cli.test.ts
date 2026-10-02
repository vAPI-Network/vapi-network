import { lstat, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  appendReceipt,
  AGENT_MARKER_VARIABLES,
  protectVault,
  unlockProtectedVault,
  VAULT_KEY_ACCOUNT,
  VAULT_SESSION_ACCOUNT,
  WalletStore,
  writeDefaultConfig,
  type AuditEntry,
  type SecretStore,
} from "@vapi-network/core";
import { createKeystoreWithPhrase } from "@vapi-network/core/secrets";

import {
  runCli as runCliWithDependencies,
  type CliDependencies,
  type CliIo,
  type CliPrompts,
} from "./cli.js";

const VECTOR_PHRASE =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const VECTOR_ADDRESS = "0x9858EfFD232B4033E47d90003D41EC34EcaEda94";

/** A person at a bare terminal: the only situation in which vAPI prints a secret. */
const HUMAN: CliDependencies = { interactive: true, env: {} };
/** Anything else: a pipe, a script, an agent. */
const AGENT: CliDependencies = { interactive: false, env: {} };
const secretStores = new Map<string, SecretStore>();

/** Every invocation in one VAPI_HOME sees the same deterministic device secret store. */
async function runCli(
  argv: string[],
  io: CliIo,
  dependencies: CliDependencies = {},
): Promise<number> {
  const home = process.env.VAPI_HOME;
  if (home === undefined) throw new Error("A wallet CLI test must set VAPI_HOME before runCli.");
  const secrets = dependencies.secretStore ?? secretStores.get(home) ?? secretStoreStub();
  secretStores.set(home, secrets);
  return await runCliWithDependencies(argv, io, { ...dependencies, secretStore: secrets });
}

const originalHome = process.env.VAPI_HOME;
const originalPassword = process.env.VAPI_KEYSTORE_PASSWORD;
const originalWallet = process.env.VAPI_WALLET;
const originalArcRpc = process.env.ARC_RPC_URL;

afterEach(() => {
  restoreEnvironment("VAPI_HOME", originalHome);
  restoreEnvironment("VAPI_KEYSTORE_PASSWORD", originalPassword);
  restoreEnvironment("VAPI_WALLET", originalWallet);
  restoreEnvironment("ARC_RPC_URL", originalArcRpc);
});

describe("vapi wallet list alias", () => {
  it("prints the accounts status block and one deprecation", async () => {
    const home = await initializedHome("vapi-wallet-list-");
    await createWallet("agent", ["--label", "for the agent"]);
    const captured = captureIo();

    expect(
      await runCli(["wallet", "list"], captured.io, { ...AGENT, fetchImpl: zeroBalanceRpc() }),
    ).toBe(0);

    expect(captured.stderr).toEqual(["vapi wallet is now vapi accounts."]);
    expect(captured.stdout[0]).toBe("Accounts");
    expect(captured.stdout[1]).toMatch(/^ {2}main \*\s+0x[0-9A-Fa-f]{4}…[0-9A-Fa-f]{4}/u);
    expect(captured.stdout[2]).toMatch(/^ {2}agent\s+0x[0-9A-Fa-f]{4}…[0-9A-Fa-f]{4}/u);
    expect(home).toContain("vapi-wallet-list-");
  });

  it("returns the status account array as JSON", async () => {
    const home = await initializedHome("vapi-wallet-list-json-");
    await createWallet("agent");
    await testSecretStore(home).remove(VAULT_KEY_ACCOUNT);
    const captured = captureIo();

    expect(
      await runCli(["wallet", "list", "--json"], captured.io, {
        ...AGENT,
        fetchImpl: zeroBalanceRpc(),
      }),
    ).toBe(0);

    const value = JSON.parse(captured.stdout[0]!) as Array<Record<string, unknown>>;
    expect(value.map((account) => account.name)).toEqual(["main", "agent"]);
    expect(value[0]).toMatchObject({ name: "main", default: true, usdc: "0.00" });
    expect(value[1]).toMatchObject({
      name: "agent",
      default: false,
      caps: { perCallUsd: "0.10", perDayUsd: "1.00" },
      link: "not_linked",
    });
    expect(captured.stderr).toEqual(["vapi wallet is now vapi accounts."]);
  });

  it("prints an empty accounts block when there is no wallet at all", async () => {
    await emptyHome("vapi-wallet-list-empty-");
    const captured = captureIo();

    expect(await runCli(["wallet", "list"], captured.io, AGENT)).toBe(0);
    expect(captured.stdout).toEqual(["Accounts"]);
    expect(captured.stderr).toEqual(["vapi wallet is now vapi accounts."]);
  });
});

describe("vapi accounts add", () => {
  it("creates a second vault account without printing the shared recovery phrase", async () => {
    const home = await initializedHome("vapi-wallet-create-");
    const prompts = refusingPrompts();
    const captured = captureIo();

    expect(
      await runCli(["accounts", "add", "agent", "--label", "capped", "--no-link"], captured.io, {
        ...HUMAN,
        prompts,
      }),
    ).toBe(0);

    const text = captured.stdout.join("\n");
    expect(text).toMatch(/^Account agent derived: 0x[0-9a-fA-F]{40}$/u);
    expect(numberedWords(text)).toHaveLength(0);
    expect((await stat(join(home, "vault.json"))).mode & 0o777).toBe(0o600);
  });

  it("maps the hidden wallet create alias to accounts add without linking", async () => {
    await initializedHome("vapi-wallet-create-alias-");
    const captured = captureIo();

    expect(await runCli(["wallet", "create", "agent"], captured.io, AGENT)).toBe(0);
    expect(captured.stderr).toEqual(["vapi wallet is now vapi accounts."]);
    expect(captured.stdout[0]).toMatch(/^Account agent derived: 0x[0-9a-fA-F]{40}$/u);
  });

  it("returns the new account as JSON without the phrase", async () => {
    await initializedHome("vapi-wallet-create-json-");
    const captured = captureIo();

    expect(
      await runCli(["accounts", "add", "agent", "--no-link", "--json"], captured.io, {
        ...HUMAN,
        prompts: refusingPrompts(),
      }),
    ).toBe(0);

    const value = JSON.parse(captured.stdout[0]!) as Record<string, unknown>;
    expect(value).toMatchObject({
      account: "agent",
      linked: false,
      address: expect.stringMatching(/^0x[0-9a-fA-F]{40}$/u),
    });
    expect(numberedWords(captured.stdout[0]!)).toEqual([]);
  });

  it("rejects the retired --networks option", async () => {
    await initializedHome("vapi-wallet-create-solana-");
    const captured = captureIo();

    expect(
      await runCli(["accounts", "add", "agent", "--networks", "base,solana"], captured.io, AGENT),
    ).toBe(2);
    expect(captured.stderr).toEqual(["Unknown option --networks."]);
  });

  it("refuses a name that already exists and a name that is not a wallet name", async () => {
    await initializedHome("vapi-wallet-create-refusals-");
    const taken = captureIo();

    expect(await runCli(["accounts", "add", "main"], taken.io, AGENT)).toBe(1);
    expect(taken.stderr).toEqual(["Wallet main already exists. Choose another name."]);

    const invalid = captureIo();
    expect(await runCli(["accounts", "add", "../escape"], invalid.io, AGENT)).toBe(1);
    expect(invalid.stderr[0]).toContain("A wallet name is a name, not a path");
  });
});

describe("vapi accounts use, rename and caps", () => {
  it("moves the default without touching a key", async () => {
    const home = await initializedHome("vapi-wallet-use-");
    await createWallet("agent");
    const captured = captureIo();

    expect(await runCli(["accounts", "use", "agent"], captured.io, AGENT)).toBe(0);

    expect(captured.stdout[0]).toMatch(/^Wallet: agent \(0x[0-9a-fA-F]{40}\)$/u);
    expect(captured.stdout[1]).toBe("Default wallet is now agent.");
    expect(await readRegistry(home)).toMatchObject({ default: "agent" });

    const balance = captureIo();
    expect(
      await runCli(["balance", "--json"], balance.io, { ...AGENT, fetchImpl: zeroBalanceRpc() }),
    ).toBe(0);
    expect((JSON.parse(balance.stdout[0]!) as { wallet: string }).wallet).toBe("agent");
  });

  it("renames a wallet and its receipts together", async () => {
    const home = await initializedHome("vapi-wallet-rename-");
    await createWallet("agent");
    await appendReceipt(
      {
        id: "agent-call",
        timestamp: new Date().toISOString(),
        resourceUrl: "https://weather.example/call",
        outcome: "paid",
      },
      join(home, "receipts.jsonl"),
      { wallet: "agent" },
    );
    const captured = captureIo();

    expect(
      await runCli(["accounts", "rename", "agent", "worker", "--json"], captured.io, AGENT),
    ).toBe(0);

    expect(JSON.parse(captured.stdout[0]!)).toMatchObject({
      wallet: "worker",
      previous: "agent",
      message: "Wallet agent is now worker.",
    });
    expect(await readFile(join(home, "receipts.jsonl"), "utf8")).toContain('"wallet":"worker"');
    expect(await walletAddress(home, "worker")).toMatch(/^0x[0-9a-fA-F]{40}$/u);
  });

  it("sets the caps in dollars and stores them in atomic USDC", async () => {
    const home = await initializedHome("vapi-wallet-caps-");
    await createWallet("agent");
    const captured = captureIo();

    expect(
      await runCli(
        ["accounts", "caps", "agent", "--per-call", "0.25", "--per-day", "2.50", "--json"],
        captured.io,
        AGENT,
      ),
    ).toBe(0);

    expect(JSON.parse(captured.stdout[0]!)).toMatchObject({
      wallet: "agent",
      spendCaps: { perCallAtomic: "250000", perDayAtomic: "2500000" },
      perCallUsd: "0.25",
      perDayUsd: "2.5",
      message: "Spend caps updated for agent.",
    });
    const registry = await readRegistry(home);
    expect(registry.wallets.agent?.spendCaps).toEqual({
      perCallAtomic: "250000",
      perDayAtomic: "2500000",
    });
    expect(registry.wallets.main?.spendCaps).toEqual({
      perCallAtomic: "100000",
      perDayAtomic: "1000000",
    });

    const shown = captureIo();
    expect(await runCli(["accounts", "caps", "agent"], shown.io, AGENT)).toBe(0);
    expect(shown.stdout[1]).toContain("Spend caps: 0.25 USD per call, 2.5 USD per day");
  });

  it("refuses a per-call cap above the per-day cap and a cap that is not money", async () => {
    await initializedHome("vapi-wallet-caps-refusals-");
    const tooBig = captureIo();

    expect(
      await runCli(
        ["accounts", "caps", "main", "--per-call", "5", "--per-day", "1"],
        tooBig.io,
        AGENT,
      ),
    ).toBe(2);
    expect(tooBig.stderr[0]).toBe("The per-call cap cannot be larger than the per-day cap.");

    const notMoney = captureIo();
    expect(
      await runCli(["accounts", "caps", "main", "--per-day", "lots"], notMoney.io, AGENT),
    ).toBe(2);
    expect(notMoney.stderr[0]).toContain("--per-day must be a US dollar amount");
  });
});

describe("vapi accounts remove and restore", () => {
  it("asks the person to type the name, then keeps the vault account in the trash", async () => {
    const home = await initializedHome("vapi-wallet-remove-");
    await createWallet("agent");
    const agentAddress = await walletAddress(home, "agent");
    const prompts = scriptedPrompts({ "Type agent to remove it: ": "agent" });
    const captured = captureIo();

    expect(
      await runCli(["accounts", "remove", "agent"], captured.io, {
        ...HUMAN,
        prompts: prompts.prompts,
        fetchImpl: zeroBalanceRpc(),
      }),
    ).toBe(0);

    expect(prompts.prompted).toEqual(["Type agent to remove it: "]);
    expect(captured.stdout).toEqual([
      "Account agent removed. Bring it back with vapi accounts restore agent.",
    ]);
    const trashDirectory = join(home, "wallets", ".trash");
    const trashPath = join(trashDirectory, (await readdir(trashDirectory))[0]!);
    expect((await stat(trashPath)).mode & 0o777).toBe(0o600);

    const restored = captureIo();
    expect(await runCli(["accounts", "restore", "agent", "--json"], restored.io, AGENT)).toBe(0);
    expect(JSON.parse(restored.stdout[0]!)).toMatchObject({
      wallet: "agent",
      address: agentAddress,
    });
  });

  it("refuses without a terminal, on a typo, on the default wallet, and on a funded one", async () => {
    const home = await initializedHome("vapi-wallet-remove-refusals-");
    await createWallet("agent");
    const agentAddress = await walletAddress(home, "agent");
    const piped = captureIo();

    expect(await runCli(["accounts", "remove", "agent"], piped.io, AGENT)).toBe(1);
    expect(piped.stderr[0]).toBe(
      "Removing an account needs a terminal, so a person can type its name. Run vapi accounts remove yourself, or pass --force.",
    );

    const typo = captureIo();
    expect(
      await runCli(["accounts", "remove", "agent"], typo.io, {
        ...HUMAN,
        prompts: scriptedPrompts({ "Type agent to remove it: ": "agnet" }).prompts,
      }),
    ).toBe(1);
    expect(typo.stderr).toEqual(["That is not the account name. Nothing was removed."]);
    expect(await walletAddress(home, "agent")).toBe(agentAddress);

    const isDefault = captureIo();
    expect(
      await runCli(["accounts", "remove", "main", "--force"], isDefault.io, {
        ...AGENT,
        fetchImpl: zeroBalanceRpc(),
      }),
    ).toBe(1);
    expect(isDefault.stderr[0]).toContain("is the default wallet");

    const funded = captureIo();
    expect(
      await runCli(["accounts", "remove", "agent"], funded.io, {
        ...HUMAN,
        prompts: scriptedPrompts({ "Type agent to remove it: ": "agent" }).prompts,
        fetchImpl: fundedRpc(),
      }),
    ).toBe(1);
    expect(funded.stderr).toEqual([
      "Account agent still holds 1 USDC. Move it out with vapi sweep --account agent first.",
    ]);
  });
});

describe("wallet selection", () => {
  it("prefers --account, then VAPI_WALLET, then the default", async () => {
    await initializedHome("vapi-wallet-selection-");
    await createWallet("agent");

    const flag = captureIo();
    expect(
      await runCli(["balance", "--account", "agent", "--json"], flag.io, {
        interactive: false,
        env: { VAPI_WALLET: "main" },
        fetchImpl: zeroBalanceRpc(),
      }),
    ).toBe(0);
    expect((JSON.parse(flag.stdout[0]!) as { wallet: string }).wallet).toBe("agent");

    const fromEnvironment = captureIo();
    expect(
      await runCli(["balance", "--json"], fromEnvironment.io, {
        interactive: false,
        env: { VAPI_WALLET: "agent" },
        fetchImpl: zeroBalanceRpc(),
      }),
    ).toBe(0);
    expect((JSON.parse(fromEnvironment.stdout[0]!) as { wallet: string }).wallet).toBe("agent");

    const fallback = captureIo();
    expect(
      await runCli(["balance", "--json"], fallback.io, { ...AGENT, fetchImpl: zeroBalanceRpc() }),
    ).toBe(0);
    expect((JSON.parse(fallback.stdout[0]!) as { wallet: string }).wallet).toBe("main");
  });

  it("lists the names it does know when asked for one it does not", async () => {
    await initializedHome("vapi-wallet-unknown-");
    await createWallet("agent");
    const captured = captureIo();

    expect(await runCli(["balance", "--account", "absent"], captured.io, AGENT)).toBe(1);
    expect(captured.stderr).toEqual(["No wallet named absent. This machine has: agent, main."]);
  });

  it("prints the account heading first for the account list", async () => {
    await initializedHome("vapi-wallet-header-");
    const captured = captureIo();

    expect(await runCli(["accounts"], captured.io, { ...AGENT, fetchImpl: zeroBalanceRpc() })).toBe(
      0,
    );
    expect(captured.stdout[0]).toBe("Accounts");
  });
});

describe("vapi import into a named wallet", () => {
  it("writes the named wallet and leaves the existing one alone", async () => {
    const home = await initializedHome("vapi-wallet-import-named-");
    const mainAddress = await walletAddress(home, "main");
    const prompts = scriptedPrompts({ "Recovery phrase: ": VECTOR_PHRASE });
    const captured = captureIo();

    expect(
      await runCli(["import", "--phrase", "--account", "backup-2026", "--json"], captured.io, {
        ...AGENT,
        prompts: prompts.prompts,
      }),
    ).toBe(0);

    expect(JSON.parse(captured.stdout[0]!)).toEqual({
      wallet: "backup-2026",
      address: VECTOR_ADDRESS,
      vault: join(home, "vault.json"),
      message: "Wallet imported. Its encrypted key stays on this machine.",
    });
    expect(await walletAddress(home, "main")).toBe(mainAddress);
    expect(await readRegistry(home)).toMatchObject({ default: "main" });
  });
});

describe("receipts and stats per wallet", () => {
  it("shows the selected wallet by default and everything with --all-wallets", async () => {
    const home = await initializedHome("vapi-wallet-receipts-");
    await createWallet("agent");
    const timestamp = new Date().toISOString();
    for (const [wallet, id] of [
      ["main", "main-call"],
      ["agent", "agent-call"],
    ] as const) {
      await appendReceipt(
        {
          id,
          timestamp,
          resourceUrl: `https://${wallet}.example/call`,
          outcome: "paid",
          quote: {
            network: "eip155:8453",
            asset: "0xasset",
            amountAtomic: "2500",
            payTo: "0xpayee",
          },
        },
        join(home, "receipts.jsonl"),
        { wallet },
      );
    }

    const mine = captureIo();
    expect(await runCli(["receipts", "--json"], mine.io, AGENT)).toBe(0);
    const selected = JSON.parse(mine.stdout[0]!) as {
      wallet: string;
      receipts: Array<{ id: string }>;
    };
    expect(selected.wallet).toBe("main");
    expect(selected.receipts.map((receipt) => receipt.id)).toEqual(["main-call"]);

    const agent = captureIo();
    expect(await runCli(["receipts", "--account", "agent", "--json"], agent.io, AGENT)).toBe(0);
    expect(
      (JSON.parse(agent.stdout[0]!) as { receipts: Array<{ id: string }> }).receipts.map(
        (receipt) => receipt.id,
      ),
    ).toEqual(["agent-call"]);

    const all = captureIo();
    expect(await runCli(["receipts", "--all-wallets", "--json"], all.io, AGENT)).toBe(0);
    expect(
      (JSON.parse(all.stdout[0]!) as Array<{ id: string }>).map((receipt) => receipt.id),
    ).toEqual(["main-call", "agent-call"]);

    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () =>
      Response.json({
        routedThroughVapi: { usd24h: "12.5", usd30d: "1234.567891", txCount: 42 },
      }),
    );
    const stats = captureIo();
    expect(await runCli(["stats", "--json"], stats.io, { ...AGENT, fetchImpl })).toBe(0);
    expect(JSON.parse(stats.stdout[0]!)).toMatchObject({
      wallet: "main",
      totals: { calls: 1, spendUsd: "0.0025" },
      network: {
        routedThroughVapi: { usd24h: "12.5", usd30d: "1234.567891", txCount: 42 },
      },
    });

    const allStats = captureIo();
    expect(
      await runCli(["stats", "--all-wallets", "--json"], allStats.io, {
        ...AGENT,
        fetchImpl,
      }),
    ).toBe(0);
    expect(JSON.parse(allStats.stdout[0]!)).toMatchObject({ totals: { calls: 2 } });
  });

  it("refuses --account together with --all-wallets", async () => {
    await initializedHome("vapi-wallet-receipts-conflict-");
    const captured = captureIo();

    expect(
      await runCli(["receipts", "--account", "main", "--all-wallets"], captured.io, AGENT),
    ).toBe(2);
    expect(captured.stderr[0]).toBe("--account and --all-wallets cannot be used together.");
  });
});

describe("the secrets gate", () => {
  const REFUSAL = "Run this yourself in a terminal; an agent must never see these words.";

  it("refuses backup and export-key for every agent marker", async () => {
    await initializedHome("vapi-wallet-gate-markers-");

    for (const marker of AGENT_MARKER_VARIABLES) {
      for (const command of ["backup", "export-key"] as const) {
        const captured = captureIo();
        expect(
          await runCli([command], captured.io, {
            interactive: true,
            env: { [marker]: "1" },
            prompts: refusingPrompts(),
          }),
        ).toBe(1);
        expect(captured.stdout).toEqual([]);
        expect(captured.stderr).toEqual([`${REFUSAL} ${marker} is set.`]);
      }
    }
  });

  it("refuses backup outside a terminal with its command-specific line", async () => {
    const home = await initializedHome("vapi-wallet-gate-pipe-");
    const captured = captureIo();

    expect(
      await runCli(["backup"], captured.io, {
        interactive: false,
        env: {},
        prompts: refusingPrompts(),
      }),
    ).toBe(1);
    expect(captured.stdout).toEqual([]);
    expect(captured.stderr).toEqual([
      "vapi backup prints your recovery phrase and only works in a terminal.",
    ]);
    expect((await readAudit(home)).at(-1)).toMatchObject({
      event: "secret.export.phrase",
      tty: false,
      detail: "refused: not a terminal",
    });
  });

  it("keeps the stream-specific non-terminal refusal for export-key", async () => {
    await initializedHome("vapi-wallet-export-key-pipe-");
    const captured = captureIo();

    expect(
      await runCli(["export-key"], captured.io, {
        interactive: false,
        env: {},
        prompts: refusingPrompts(),
      }),
    ).toBe(1);
    expect(captured.stdout).toEqual([]);
    expect(captured.stderr).toEqual([`${REFUSAL} stdin is not a terminal.`]);
  });

  it("reports the refusal as JSON without printing a secret", async () => {
    await initializedHome("vapi-wallet-gate-json-");
    const captured = captureIo();

    expect(
      await runCli(["export-key", "--json"], captured.io, {
        interactive: false,
        env: {},
        prompts: refusingPrompts(),
      }),
    ).toBe(1);
    expect(JSON.parse(captured.stdout[0]!)).toEqual({
      error: `${REFUSAL} stdin is not a terminal.`,
      exitCode: 1,
    });
  });

  it("reports the backup non-terminal refusal as JSON", async () => {
    await initializedHome("vapi-wallet-backup-gate-json-");
    const captured = captureIo();

    expect(
      await runCli(["backup", "--json"], captured.io, {
        interactive: false,
        env: {},
        prompts: refusingPrompts(),
      }),
    ).toBe(1);
    expect(captured.stderr).toEqual([]);
    expect(JSON.parse(captured.stdout[0]!)).toEqual({
      error: "vapi backup prints your recovery phrase and only works in a terminal.",
      exitCode: 1,
    });
  });

  it("still creates the wallet for an agent, and points at vapi backup", async () => {
    const home = await emptyHome("vapi-wallet-gate-init-");
    const captured = captureIo();

    expect(
      await runCli(["init"], captured.io, {
        interactive: true,
        env: { CLAUDECODE: "1" },
        fetchImpl: zeroBalanceRpc(),
        prompts: refusingPrompts(),
      }),
    ).toBe(0);

    const text = captured.stdout.join("\n");
    expect(text).toContain("Recovery phrase: run vapi backup yourself in a terminal to see it.");
    expect(numberedWords(text)).toEqual([]);
    expect(await stat(join(home, "vault.json"))).toBeTruthy();
  });
});

describe("the audit log", () => {
  it("records every wallet change and every export, and never a secret", async () => {
    const home = await initializedHome("vapi-wallet-audit-");
    await createWallet("agent");

    const backupPrompts = scriptedPrompts({ "Type main to print its recovery phrase: ": "main" });
    const backup = captureIo();
    expect(
      await runCli(["backup", "--json"], backup.io, { ...HUMAN, prompts: backupPrompts.prompts }),
    ).toBe(0);
    const phrase = (JSON.parse(backup.stdout[0]!) as { recoveryPhrase: string }).recoveryPhrase;

    const exportPrompts = scriptedPrompts({ "Type main to print its private key: ": "main" });
    const exported = captureIo();
    expect(
      await runCli(["export-key", "--json"], exported.io, {
        ...HUMAN,
        prompts: exportPrompts.prompts,
      }),
    ).toBe(0);
    const privateKey = (JSON.parse(exported.stdout[0]!) as { privateKey: string }).privateKey;

    expect(await runCli(["accounts", "use", "agent"], captureIo().io, AGENT)).toBe(0);
    expect(
      await runCli(["accounts", "caps", "agent", "--per-call", "0.05"], captureIo().io, AGENT),
    ).toBe(0);
    expect(await runCli(["accounts", "rename", "agent", "worker"], captureIo().io, AGENT)).toBe(0);
    expect(
      await runCli(["accounts", "remove", "main"], captureIo().io, {
        ...HUMAN,
        prompts: scriptedPrompts({ "Type main to remove it: ": "main" }).prompts,
        fetchImpl: zeroBalanceRpc(),
      }),
    ).toBe(0);
    expect(await runCli(["accounts", "restore", "main"], captureIo().io, AGENT)).toBe(0);

    const entries = await readAudit(home);
    expect(entries.map((entry) => entry.event)).toEqual([
      "wallet.create",
      "wallet.create",
      "vault.backup_shown",
      "secret.export.key",
      "wallet.default",
      "wallet.caps",
      "wallet.rename",
      "wallet.remove",
      "wallet.restore",
    ]);
    expect(entries[2]).toMatchObject({ wallet: "main", tty: true });
    expect(entries[2]!.time).toMatch(/^\d{4}-\d{2}-\d{2}T/u);

    const raw = await readFile(join(home, "audit.log"), "utf8");
    for (const word of phrase.split(" ")) expect(raw).not.toContain(` ${word} `);
    expect(raw).not.toContain(privateKey);
    expect(raw).not.toContain(privateKey.slice(2));
    expect((await stat(join(home, "audit.log"))).mode & 0o777).toBe(0o600);
  });

  it("records a refused export with the marker that refused it", async () => {
    const home = await initializedHome("vapi-wallet-audit-refusal-");
    const captured = captureIo();

    expect(
      await runCli(["backup"], captured.io, {
        interactive: true,
        env: { VAPI_NO_SECRETS: "1" },
        prompts: refusingPrompts(),
      }),
    ).toBe(1);

    const entries = await readAudit(home);
    expect(entries.at(-1)).toMatchObject({
      event: "secret.export.phrase",
      wallet: "main",
      agentMarker: "VAPI_NO_SECRETS",
      detail: "refused: VAPI_NO_SECRETS is set.",
    });
  });
});

describe("vapi unlock", () => {
  it("routes an unprotected device vault through the alias", async () => {
    await initializedHome("vapi-unlock-");
    const captured = captureIo();

    expect(await runCli(["unlock"], captured.io, { ...HUMAN, prompts: refusingPrompts() })).toBe(0);

    expect(captured.stderr).toEqual([
      "vapi unlock is now vapi vault unlock; the old name works for one release.",
    ]);
    expect(captured.stdout).toEqual(["The vault is not password protected; nothing to unlock."]);
  });

  it("ignores --account for the whole-vault alias", async () => {
    await initializedHome("vapi-unlock-json-");
    await createWallet("agent");
    const captured = captureIo();

    expect(await runCli(["unlock", "--account", "agent", "--json"], captured.io, AGENT)).toBe(0);

    expect(captured.stderr).toEqual([
      "vapi unlock is now vapi vault unlock; the old name works for one release.",
    ]);
    expect(JSON.parse(captured.stdout[0]!)).toEqual({
      command: "vault unlock",
      unlocked: true,
      protected: false,
    });
  });
});

describe("vapi lock", () => {
  it("clears a protected vault session for one account and for --all", async () => {
    const home = await initializedHome("vapi-lock-");
    const secrets = testSecretStore(home);
    await protectVault({ path: join(home, "vault.json"), secrets, password: "vault-password" });
    await unlockProtectedVault({
      path: join(home, "vault.json"),
      secrets,
      password: "vault-password",
    });
    expect(await secrets.has(VAULT_SESSION_ACCOUNT)).toBe(true);
    const captured = captureIo();

    expect(await runCli(["lock", "--account", "main"], captured.io, AGENT)).toBe(0);
    expect(await secrets.has(VAULT_SESSION_ACCOUNT)).toBe(false);
    expect(captured.stderr).toEqual([
      "vapi lock is now vapi vault lock; the old name works for one release.",
    ]);
    expect(captured.stdout).toEqual(["Locked the protected device vault."]);

    await unlockProtectedVault({
      path: join(home, "vault.json"),
      secrets,
      password: "vault-password",
    });
    expect(await runCli(["lock", "--all"], captureIo().io, AGENT)).toBe(0);
    expect(await secrets.has(VAULT_SESSION_ACCOUNT)).toBe(false);
  });

  it("refuses --account together with --all", async () => {
    await initializedHome("vapi-lock-both-");
    const captured = captureIo();

    expect(await runCli(["lock", "--all", "--account", "main"], captured.io, AGENT)).toBe(2);
    expect(captured.stderr).toEqual([
      "vapi lock is now vapi vault lock; the old name works for one release.",
      "--account and --all cannot be used together.",
    ]);
  });
});

describe("vapi passphrase", () => {
  it("directs vault accounts to whole-vault protection", async () => {
    await initializedHome("vapi-passphrase-");
    const captured = captureIo();

    expect(
      await runCli(["passphrase"], captured.io, { ...HUMAN, prompts: refusingPrompts() }),
    ).toBe(1);
    expect(captured.stderr).toEqual([
      "Vault accounts have no passphrase. Protect the whole vault instead with vapi vault protect.",
    ]);
  });
});

describe("migration of a 0.2.5 home", () => {
  it("moves the root keystore into the vault and adopts its config caps", async () => {
    const home = await emptyHome("vapi-wallet-migration-");
    const created = await createKeystoreWithPhrase(
      "test-only-passphrase",
      join(home, "keystore.json"),
      { phrase: VECTOR_PHRASE },
    );
    const configPath = join(home, "config.json");
    await writeDefaultConfig(configPath, {});
    const config = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
    config.spendCaps = { perCallAtomic: "500000", perDayAtomic: "5000000" };
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    const captured = captureIo();

    expect(
      await runCli(["accounts", "list", "--json"], captured.io, {
        ...AGENT,
        env: { VAPI_KEYSTORE_PASSWORD: "test-only-passphrase" },
        fetchImpl: zeroBalanceRpc(),
      }),
    ).toBe(0);

    const value = JSON.parse(captured.stdout[0]!) as Array<Record<string, unknown>>;
    expect(value).toMatchObject([
      {
        name: "main",
        address: created.account.address,
        default: true,
        caps: { perCallUsd: "0.50", perDayUsd: "5.00" },
      },
    ]);
    await expect(lstat(join(home, "keystore.json"))).rejects.toThrow();
    expect((await stat(join(home, "vault.json"))).mode & 0o777).toBe(0o600);
    expect((await stat(join(home, "wallets.migrated", "main.json"))).mode & 0o777).toBe(0o600);
    expect(await walletAddress(home, "main")).toBe(created.account.address);

    const balance = captureIo();
    expect(
      await runCli(["balance", "--json"], balance.io, { ...AGENT, fetchImpl: zeroBalanceRpc() }),
    ).toBe(0);
    expect(JSON.parse(balance.stdout[0]!)).toMatchObject({
      wallet: "main",
      address: created.account.address,
    });
  });
});

async function readRegistry(home: string): Promise<{
  default?: string;
  wallets: Record<string, { spendCaps: { perCallAtomic: string; perDayAtomic: string } }>;
}> {
  return JSON.parse(await readFile(join(home, "wallets.json"), "utf8")) as {
    default?: string;
    wallets: Record<string, { spendCaps: { perCallAtomic: string; perDayAtomic: string } }>;
  };
}

async function readAudit(home: string): Promise<AuditEntry[]> {
  const raw = await readFile(join(home, "audit.log"), "utf8");
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as AuditEntry);
}

async function walletAddress(home: string, name: string): Promise<string> {
  const address = await (
    await WalletStore.open(home, { secrets: testSecretStore(home) })
  ).readAddress(name);
  if (address === undefined) throw new Error(`No address for wallet ${name}.`);
  return address;
}

/** The words a numbered phrase listing shows, in order. */
function numberedWords(text: string): string[] {
  return text.split("\n").flatMap((line) => {
    const match = /^ *\d+\. ([a-z]+)$/u.exec(line);
    return match ? [match[1]!] : [];
  });
}

function scriptedPrompts(answers: Record<string, string>): {
  prompts: CliPrompts;
  prompted: string[];
} {
  const prompted: string[] = [];
  const answer = async (prompt: string) => {
    prompted.push(prompt);
    const scripted = answers[prompt];
    if (scripted === undefined) throw new Error(`Unexpected prompt ${JSON.stringify(prompt)}.`);
    return scripted;
  };
  return { prompted, prompts: { secret: answer, line: answer } };
}

/** An OS secret store in a plain object, so no test ever touches a keychain. */
function secretStoreStub(entries: Record<string, string> = {}): SecretStore {
  return {
    available: true,
    platform: "darwin",
    description: "the macOS Keychain",
    get: async (name) => entries[name],
    has: async (name) => entries[name] !== undefined,
    set: async (name, passphrase) => {
      entries[name] = passphrase;
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

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

async function emptyHome(prefix: string): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), prefix));
  process.env.VAPI_HOME = home;
  delete process.env.VAPI_KEYSTORE_PASSWORD;
  delete process.env.VAPI_WALLET;
  secretStores.set(home, secretStoreStub());
  return home;
}

async function initializedHome(prefix: string): Promise<string> {
  const home = await emptyHome(prefix);
  expect(
    await runCli(["init", "--json"], captureIo().io, { ...AGENT, fetchImpl: zeroBalanceRpc() }),
  ).toBe(0);
  return home;
}

async function createWallet(name: string, options: string[] = []): Promise<void> {
  expect(
    await runCli(["accounts", "add", name, ...options, "--no-link", "--json"], captureIo().io, {
      ...AGENT,
      prompts: refusingPrompts(),
    }),
  ).toBe(0);
}

/** One USDC on Base, so a removal has something to refuse. */
function fundedRpc() {
  return vi.fn<typeof fetch>(async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as { id: number; method: string };
    return Response.json({
      jsonrpc: "2.0",
      id: request.id,
      result:
        request.method === "eth_call" ? `0x${(1_000_000).toString(16).padStart(64, "0")}` : "0x0",
    });
  });
}

function zeroBalanceRpc() {
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
