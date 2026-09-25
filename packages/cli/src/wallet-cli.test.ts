import { lstat, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  appendReceipt,
  AGENT_MARKER_VARIABLES,
  type AuditEntry,
  type SecretStore,
} from "@vapi-network/core";

import { runCli, type CliDependencies, type CliIo, type CliPrompts } from "./cli.js";

const VECTOR_PHRASE =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const VECTOR_ADDRESS = "0x9858EfFD232B4033E47d90003D41EC34EcaEda94";

/** A person at a bare terminal: the only situation in which vAPI prints a secret. */
const HUMAN: CliDependencies = { interactive: true, env: {} };
/** Anything else: a pipe, a script, an agent. */
const AGENT: CliDependencies = { interactive: false, env: {} };

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

describe("vapi wallet list", () => {
  it("marks the default, converts the caps to dollars, and shows the label", async () => {
    const home = await initializedHome("vapi-wallet-list-");
    await createWallet("agent", ["--label", "for the agent"]);
    const secretStore = secretStoreStub({ agent: "test-only-passphrase" });
    const captured = captureIo();

    expect(await runCli(["wallet", "list"], captured.io, { ...AGENT, secretStore })).toBe(0);

    const rows = captured.stdout[0]!.split("\n");
    expect(rows[0]).toBe("  NAME\tADDRESS\tPER-CALL USD\tPER-DAY USD\tUNLOCKED\tLABEL");
    expect(rows[1]).toMatch(/^\* main\t0x[0-9a-fA-F]{40}\t0\.1\t1\tno\t$/u);
    expect(rows[2]).toMatch(/^ {2}agent\t0x[0-9a-fA-F]{40}\t0\.1\t1\tyes\tfor the agent$/u);
    expect(captured.stdout[0]).toContain("* is the default wallet.");
    expect(captured.stdout[0]).toContain("UNLOCKED says whether an agent can pay from it");
    expect(home).toContain("vapi-wallet-list-");
  });

  it("returns the whole registry as JSON", async () => {
    const home = await initializedHome("vapi-wallet-list-json-");
    await createWallet("agent");
    const secretStore = secretStoreStub({ agent: "test-only-passphrase" });
    const captured = captureIo();

    expect(await runCli(["wallet", "list", "--json"], captured.io, { ...AGENT, secretStore })).toBe(
      0,
    );

    const value = JSON.parse(captured.stdout[0]!) as {
      default: string;
      wallets: Array<Record<string, unknown>>;
    };
    expect(value.default).toBe("main");
    expect(value.wallets.map((wallet) => wallet.name)).toEqual(["main", "agent"]);
    expect(value.wallets[0]).toMatchObject({ name: "main", unlocked: false });
    expect(value.wallets[1]).toMatchObject({
      name: "agent",
      isDefault: false,
      unlocked: true,
      keystore: join(home, "wallets", "agent.json"),
      keystoreVersion: 3,
      spendCaps: { perCallAtomic: "100000", perDayAtomic: "1000000" },
      perCallUsd: "0.1",
      perDayUsd: "1",
    });
    expect(value.wallets[1]!.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
  });

  it("says so when there is no wallet at all", async () => {
    await emptyHome("vapi-wallet-list-empty-");
    const captured = captureIo();

    expect(
      await runCli(["wallet", "list"], captured.io, { ...AGENT, secretStore: secretStoreStub() }),
    ).toBe(0);
    expect(captured.stdout).toEqual(["No wallets yet. Run vapi init."]);
  });
});

describe("vapi wallet create", () => {
  it("creates a second wallet with the custody notice and the phrase behind a gate", async () => {
    const home = await initializedHome("vapi-wallet-create-");
    const prompts = scriptedPrompts({ "Write these 12 words down, then press Enter. ": "" });
    const captured = captureIo();

    expect(
      await runCli(["wallet", "create", "agent", "--label", "capped"], captured.io, {
        ...HUMAN,
        prompts: prompts.prompts,
      }),
    ).toBe(0);

    const text = captured.stdout.join("\n");
    expect(text).toContain(
      "This wallet is yours. vAPI has no copy of the key and cannot recover it.",
    );
    expect(numberedWords(text)).toHaveLength(12);
    expect(text).toMatch(/Wallet: agent \(0x[0-9a-fA-F]{40}\)/u);
    expect(text).toContain("Wallet agent created. Its encrypted key stays on this machine.");
    expect(text).toContain(`Keystore: ${join(home, "wallets", "agent.json")}`);
    expect(text).toContain("Spend caps: 0.1 USD per call, 1 USD per day");
    expect(text).toContain("vapi wallet use agent");
    expect((await stat(join(home, "wallets", "agent.json"))).mode & 0o777).toBe(0o600);
  });

  it("enables Arc mainnet in an existing config when requested", async () => {
    const home = await initializedHome("vapi-wallet-create-arc-");
    delete process.env.ARC_RPC_URL;
    const captured = captureIo();

    expect(
      await runCli(["wallet", "create", "agent", "--networks", "base,arc", "--json"], captured.io, {
        ...AGENT,
        prompts: refusingPrompts(),
      }),
    ).toBe(0);

    const config = JSON.parse(await readFile(join(home, "config.json"), "utf8")) as {
      networks: Record<string, { rpcUrl: string; usdc: string }>;
    };
    expect(config.networks["eip155:5042"]).toEqual({
      rpcUrl: "https://rpc.mainnet.arc.io",
      usdc: "0x3600000000000000000000000000000000000000",
    });
  });

  it("returns the new wallet as JSON without the phrase", async () => {
    await initializedHome("vapi-wallet-create-json-");
    const captured = captureIo();

    expect(
      await runCli(["wallet", "create", "agent", "--json"], captured.io, {
        ...HUMAN,
        prompts: refusingPrompts(),
      }),
    ).toBe(0);

    const value = JSON.parse(captured.stdout[0]!) as Record<string, unknown>;
    expect(value).toMatchObject({
      wallet: "agent",
      isDefault: false,
      custody: "self",
      recoveryPhrase: "hidden",
      message: "Wallet agent created. Its encrypted key stays on this machine.",
    });
    expect(numberedWords(captured.stdout[0]!)).toEqual([]);
  });

  it("refuses a name that already exists and a name that is not a wallet name", async () => {
    await initializedHome("vapi-wallet-create-refusals-");
    const taken = captureIo();

    expect(await runCli(["wallet", "create", "main"], taken.io, AGENT)).toBe(1);
    expect(taken.stderr).toEqual(["Wallet main already exists. Choose another name."]);

    const invalid = captureIo();
    expect(await runCli(["wallet", "create", "../escape"], invalid.io, AGENT)).toBe(1);
    expect(invalid.stderr[0]).toContain("A wallet name is a name, not a path");
  });
});

describe("vapi wallet use, rename and caps", () => {
  it("moves the default without touching a key", async () => {
    const home = await initializedHome("vapi-wallet-use-");
    await createWallet("agent");
    const captured = captureIo();

    expect(await runCli(["wallet", "use", "agent"], captured.io, AGENT)).toBe(0);

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
      await runCli(["wallet", "rename", "agent", "worker", "--json"], captured.io, AGENT),
    ).toBe(0);

    expect(JSON.parse(captured.stdout[0]!)).toMatchObject({
      wallet: "worker",
      previous: "agent",
      keystore: join(home, "wallets", "worker.json"),
      message: "Wallet agent is now worker.",
    });
    expect(await readFile(join(home, "receipts.jsonl"), "utf8")).toContain('"wallet":"worker"');
    await expect(stat(join(home, "wallets", "agent.json"))).rejects.toThrow();
  });

  it("sets the caps in dollars and stores them in atomic USDC", async () => {
    const home = await initializedHome("vapi-wallet-caps-");
    await createWallet("agent");
    const captured = captureIo();

    expect(
      await runCli(
        ["wallet", "caps", "agent", "--per-call", "0.25", "--per-day", "2.50", "--json"],
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
    expect(await runCli(["wallet", "caps", "agent"], shown.io, AGENT)).toBe(0);
    expect(shown.stdout[0]).toContain("Spend caps: 0.25 USD per call, 2.5 USD per day");
  });

  it("refuses a per-call cap above the per-day cap and a cap that is not money", async () => {
    await initializedHome("vapi-wallet-caps-refusals-");
    const tooBig = captureIo();

    expect(
      await runCli(
        ["wallet", "caps", "main", "--per-call", "5", "--per-day", "1"],
        tooBig.io,
        AGENT,
      ),
    ).toBe(2);
    expect(tooBig.stderr[0]).toBe("The per-call cap cannot be larger than the per-day cap.");

    const notMoney = captureIo();
    expect(await runCli(["wallet", "caps", "main", "--per-day", "lots"], notMoney.io, AGENT)).toBe(
      2,
    );
    expect(notMoney.stderr[0]).toContain("--per-day must be a US dollar amount");
  });
});

describe("vapi wallet remove and restore", () => {
  it("asks the person to type the name, then keeps the keystore in the trash", async () => {
    const home = await initializedHome("vapi-wallet-remove-");
    await createWallet("agent");
    const agentAddress = await walletAddress(home, "agent");
    const prompts = scriptedPrompts({ "Type agent to remove it: ": "agent" });
    const captured = captureIo();

    expect(
      await runCli(["wallet", "remove", "agent"], captured.io, {
        ...HUMAN,
        prompts: prompts.prompts,
        fetchImpl: zeroBalanceRpc(),
      }),
    ).toBe(0);

    expect(prompts.prompted).toEqual(["Type agent to remove it: "]);
    expect(captured.stdout[0]).toBe(`Wallet: agent (${agentAddress})`);
    const trashLine = captured.stdout[1]!.split("\n")[1]!;
    expect(trashLine).toMatch(
      new RegExp(`^Trash: ${escapeForRegExp(join(home, "wallets", ".trash", "agent-"))}`, "u"),
    );
    const trashPath = trashLine.slice("Trash: ".length);
    expect((await stat(trashPath)).mode & 0o777).toBe(0o600);
    expect(captured.stdout[1]).toContain("vapi wallet restore agent");

    const restored = captureIo();
    expect(await runCli(["wallet", "restore", "agent", "--json"], restored.io, AGENT)).toBe(0);
    expect(JSON.parse(restored.stdout[0]!)).toMatchObject({
      wallet: "agent",
      address: agentAddress,
      keystore: join(home, "wallets", "agent.json"),
    });
  });

  it("refuses without a terminal, on a typo, on the default wallet, and on a funded one", async () => {
    const home = await initializedHome("vapi-wallet-remove-refusals-");
    await createWallet("agent");
    const piped = captureIo();

    expect(await runCli(["wallet", "remove", "agent"], piped.io, AGENT)).toBe(1);
    expect(piped.stderr[0]).toBe(
      "Removing a wallet needs a terminal, so a person can type its name. Run vapi wallet remove yourself, or pass --force.",
    );

    const typo = captureIo();
    expect(
      await runCli(["wallet", "remove", "agent"], typo.io, {
        ...HUMAN,
        prompts: scriptedPrompts({ "Type agent to remove it: ": "agnet" }).prompts,
      }),
    ).toBe(1);
    expect(typo.stderr).toEqual(["That is not the wallet name. Nothing was removed."]);
    expect(await stat(join(home, "wallets", "agent.json"))).toBeTruthy();

    const isDefault = captureIo();
    expect(
      await runCli(["wallet", "remove", "main", "--force"], isDefault.io, {
        ...AGENT,
        fetchImpl: zeroBalanceRpc(),
      }),
    ).toBe(1);
    expect(isDefault.stderr[0]).toContain("is the default wallet");

    const funded = captureIo();
    expect(
      await runCli(["wallet", "remove", "agent"], funded.io, {
        ...HUMAN,
        prompts: scriptedPrompts({ "Type agent to remove it: ": "agent" }).prompts,
        fetchImpl: fundedRpc(),
      }),
    ).toBe(1);
    expect(funded.stderr[0]).toContain("still holds 1000000 atomic USDC");
    expect(funded.stderr[0]).toContain("--force");
  });
});

describe("wallet selection", () => {
  it("prefers --wallet, then VAPI_WALLET, then the default", async () => {
    await initializedHome("vapi-wallet-selection-");
    await createWallet("agent");

    const flag = captureIo();
    expect(
      await runCli(["balance", "--wallet", "agent", "--json"], flag.io, {
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

    expect(await runCli(["balance", "--wallet", "absent"], captured.io, AGENT)).toBe(1);
    expect(captured.stderr).toEqual(["No wallet named absent. This machine has: agent, main."]);
  });

  it("names the wallet on the first line of every text command", async () => {
    await initializedHome("vapi-wallet-header-");
    const captured = captureIo();

    expect(await runCli(["accounts"], captured.io, { ...AGENT, fetchImpl: zeroBalanceRpc() })).toBe(
      0,
    );
    expect(captured.stdout[0]).toMatch(/^Wallet: main \(0x[0-9a-fA-F]{40}\)$/u);
  });
});

describe("vapi import into a named wallet", () => {
  it("writes the named wallet and leaves the existing one alone", async () => {
    const home = await initializedHome("vapi-wallet-import-named-");
    const mainAddress = await walletAddress(home, "main");
    const prompts = scriptedPrompts({ "Recovery phrase: ": VECTOR_PHRASE });
    const captured = captureIo();

    expect(
      await runCli(["import", "--phrase", "--wallet", "backup-2026", "--json"], captured.io, {
        ...AGENT,
        prompts: prompts.prompts,
      }),
    ).toBe(0);

    expect(JSON.parse(captured.stdout[0]!)).toEqual({
      wallet: "backup-2026",
      address: VECTOR_ADDRESS,
      keystore: join(home, "wallets", "backup-2026.json"),
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
    expect(await runCli(["receipts", "--wallet", "agent", "--json"], agent.io, AGENT)).toBe(0);
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

  it("refuses --wallet together with --all-wallets", async () => {
    await initializedHome("vapi-wallet-receipts-conflict-");
    const captured = captureIo();

    expect(
      await runCli(["receipts", "--wallet", "main", "--all-wallets"], captured.io, AGENT),
    ).toBe(2);
    expect(captured.stderr[0]).toBe("--wallet and --all-wallets cannot be used together.");
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

  it("refuses when a stream is not a terminal, and names it", async () => {
    await initializedHome("vapi-wallet-gate-pipe-");
    const captured = captureIo();

    expect(
      await runCli(["backup"], captured.io, {
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
    expect(await stat(join(home, "wallets", "main.json"))).toBeTruthy();
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

    expect(await runCli(["wallet", "use", "agent"], captureIo().io, AGENT)).toBe(0);
    expect(
      await runCli(["wallet", "caps", "agent", "--per-call", "0.05"], captureIo().io, AGENT),
    ).toBe(0);
    expect(await runCli(["wallet", "rename", "agent", "worker"], captureIo().io, AGENT)).toBe(0);
    expect(
      await runCli(["wallet", "remove", "main"], captureIo().io, {
        ...HUMAN,
        prompts: scriptedPrompts({ "Type main to remove it: ": "main" }).prompts,
        fetchImpl: zeroBalanceRpc(),
      }),
    ).toBe(0);
    expect(await runCli(["wallet", "restore", "main"], captureIo().io, AGENT)).toBe(0);

    const entries = await readAudit(home);
    expect(entries.map((entry) => entry.event)).toEqual([
      "wallet.create",
      "wallet.create",
      "secret.export.phrase",
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
  it("verifies the passphrase, then hands it to the OS secret store", async () => {
    const home = await initializedHome("vapi-unlock-");
    const secretStore = secretStoreStub();
    const prompts = scriptedPrompts({ "Passphrase for main: ": "test-only-passphrase" });
    const captured = captureIo();

    expect(
      await runCli(["unlock"], captured.io, { ...HUMAN, prompts: prompts.prompts, secretStore }),
    ).toBe(0);

    expect(captured.stdout[0]).toMatch(/^Wallet: main \(0x[0-9a-fA-F]{40}\)$/u);
    expect(captured.stdout[1]).toContain(
      "Wallet main is unlocked for agents. Its passphrase is in the macOS Keychain.",
    );
    expect(captured.stdout[1]).toContain("vapi lock --wallet main");
    expect(captured.stdout.join("\n")).not.toContain("test-only-passphrase");
    expect(await secretStore.get("main")).toBe("test-only-passphrase");
    expect((await readAudit(home)).at(-1)).toMatchObject({
      event: "wallet.unlock",
      wallet: "main",
      tty: true,
      detail: "the macOS Keychain",
    });
  });

  it("names the wallet it unlocked in JSON, never the passphrase", async () => {
    await initializedHome("vapi-unlock-json-");
    await createWallet("agent");
    const secretStore = secretStoreStub();
    const prompts = scriptedPrompts({ "Passphrase for agent: ": "test-only-passphrase" });
    const captured = captureIo();

    expect(
      await runCli(["unlock", "--wallet", "agent", "--json"], captured.io, {
        ...HUMAN,
        prompts: prompts.prompts,
        secretStore,
      }),
    ).toBe(0);

    expect(JSON.parse(captured.stdout[0]!)).toMatchObject({
      wallet: "agent",
      unlocked: true,
      store: "the macOS Keychain",
    });
    expect(captured.stdout[0]).not.toContain("test-only-passphrase");
    expect(await storedNames(secretStore, ["main", "agent"])).toEqual(["agent"]);
  });

  it("refuses to take a passphrase from anything but a terminal", async () => {
    const home = await initializedHome("vapi-unlock-non-tty-");
    const secretStore = secretStoreStub();
    const captured = captureIo();

    expect(
      await runCli(["unlock"], captured.io, {
        ...AGENT,
        prompts: refusingPrompts(),
        secretStore,
      }),
    ).toBe(1);

    expect(captured.stderr).toEqual([
      "Type the passphrase yourself in a terminal; an agent must never be handed one. stdin is not a terminal.",
    ]);
    expect(await secretStore.has("main")).toBe(false);
    expect((await readAudit(home)).at(-1)).toMatchObject({
      event: "wallet.unlock",
      wallet: "main",
      detail: "refused: stdin is not a terminal.",
    });
  });

  it("stores nothing when the passphrase does not open the wallet", async () => {
    const home = await initializedHome("vapi-unlock-wrong-");
    const secretStore = secretStoreStub();
    const prompts = scriptedPrompts({ "Passphrase for main: ": "not-the-passphrase" });
    const captured = captureIo();

    expect(
      await runCli(["unlock"], captured.io, { ...HUMAN, prompts: prompts.prompts, secretStore }),
    ).toBe(1);

    expect(captured.stderr[0]).toContain("wrong passphrase or corrupt file");
    expect(await secretStore.has("main")).toBe(false);
    expect((await readAudit(home)).at(-1)).toMatchObject({
      event: "wallet.unlock",
      wallet: "main",
      detail: "refused: the passphrase did not open the wallet",
    });
  });
});

describe("vapi lock", () => {
  it("takes one wallet's passphrase back out and audits it", async () => {
    const home = await initializedHome("vapi-lock-");
    await createWallet("agent");
    const secretStore = secretStoreStub({
      main: "test-only-passphrase",
      agent: "test-only-passphrase",
    });
    const captured = captureIo();

    expect(
      await runCli(["lock", "--wallet", "agent"], captured.io, { ...AGENT, secretStore }),
    ).toBe(0);

    expect(captured.stdout[1]).toBe(
      "Locked agent. Its passphrase is no longer in the macOS Keychain.",
    );
    expect(await storedNames(secretStore, ["main", "agent"])).toEqual(["main"]);
    expect((await readAudit(home)).at(-1)).toMatchObject({ event: "wallet.lock", wallet: "agent" });
  });

  it("clears every wallet with --all and says when there was nothing to clear", async () => {
    await initializedHome("vapi-lock-all-");
    await createWallet("agent");
    const secretStore = secretStoreStub({
      main: "test-only-passphrase",
      agent: "test-only-passphrase",
    });
    const captured = captureIo();

    expect(await runCli(["lock", "--all"], captured.io, { ...AGENT, secretStore })).toBe(0);

    expect(captured.stdout).toEqual([
      "Locked main, agent. Their passphrases are no longer in the macOS Keychain.",
    ]);
    expect(await storedNames(secretStore, ["main", "agent"])).toEqual([]);

    const again = captureIo();
    expect(await runCli(["lock", "--all", "--json"], again.io, { ...AGENT, secretStore })).toBe(0);
    expect(JSON.parse(again.stdout[0]!)).toMatchObject({
      wallet: null,
      locked: [],
      message: "No passphrase was stored in the macOS Keychain.",
    });
  });

  it("refuses --wallet together with --all", async () => {
    await initializedHome("vapi-lock-both-");
    const captured = captureIo();

    expect(
      await runCli(["lock", "--all", "--wallet", "main"], captured.io, {
        ...AGENT,
        secretStore: secretStoreStub(),
      }),
    ).toBe(2);
    expect(captured.stderr[0]).toBe("--wallet and --all cannot be used together.");
  });
});

describe("migration of a 0.2.5 home", () => {
  it("moves keystore.json under wallets/ and adopts its config caps", async () => {
    const home = await initializedHome("vapi-wallet-migration-");
    const address = await walletAddress(home, "main");
    await downgradeToSingleKeystore(home, { perCallAtomic: "500000", perDayAtomic: "5000000" });
    const captured = captureIo();

    expect(
      await runCli(["wallet", "list", "--json"], captured.io, {
        ...AGENT,
        secretStore: secretStoreStub(),
      }),
    ).toBe(0);

    const value = JSON.parse(captured.stdout[0]!) as {
      default: string;
      wallets: Array<Record<string, unknown>>;
    };
    expect(value).toMatchObject({
      default: "main",
      wallets: [
        {
          name: "main",
          address,
          isDefault: true,
          spendCaps: { perCallAtomic: "500000", perDayAtomic: "5000000" },
        },
      ],
    });
    expect((await lstat(join(home, "keystore.json"))).isSymbolicLink()).toBe(true);
    expect((await stat(join(home, "wallets", "main.json"))).mode & 0o777).toBe(0o600);

    const balance = captureIo();
    expect(
      await runCli(["balance", "--json"], balance.io, { ...AGENT, fetchImpl: zeroBalanceRpc() }),
    ).toBe(0);
    expect(JSON.parse(balance.stdout[0]!)).toMatchObject({ wallet: "main", address });
  });
});

/** Turns a 0.3.0 home back into the single-keystore layout of 0.2.5. */
async function downgradeToSingleKeystore(
  home: string,
  spendCaps: { perCallAtomic: string; perDayAtomic: string },
): Promise<void> {
  await rename(join(home, "wallets", "main.json"), join(home, "keystore.json"));
  await rm(join(home, "wallets"), { recursive: true, force: true });
  await rm(join(home, "wallets.json"), { force: true });
  const config = JSON.parse(await readFile(join(home, "config.json"), "utf8")) as Record<
    string,
    unknown
  >;
  config.spendCaps = spendCaps;
  await writeFile(join(home, "config.json"), `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

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
  return (
    JSON.parse(await readFile(join(home, "wallets", `${name}.json`), "utf8")) as { address: string }
  ).address;
}

/** The words a numbered phrase listing shows, in order. */
function numberedWords(text: string): string[] {
  return text.split("\n").flatMap((line) => {
    const match = /^ *\d+\. ([a-z]+)$/u.exec(line);
    return match ? [match[1]!] : [];
  });
}

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
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

/** What the stub above is holding, for a test that stored or removed an entry. */
function storedNames(store: SecretStore, names: readonly string[]): Promise<string[]> {
  return Promise.all(names.map(async (name) => ((await store.has(name)) ? name : ""))).then(
    (found) => found.filter(Boolean),
  );
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
  process.env.VAPI_KEYSTORE_PASSWORD = "test-only-passphrase";
  delete process.env.VAPI_WALLET;
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
    await runCli(["wallet", "create", name, ...options, "--json"], captureIo().io, {
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
