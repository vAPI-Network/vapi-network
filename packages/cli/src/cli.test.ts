import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";

import {
  appendReceipt,
  appendSearchEvent,
  encryptPrivateKey,
  getVapiPaths,
  unlockKeystore,
} from "@vapi-network/core";

import { runCli, type CliIo, type CliPrompts } from "./cli.js";

/** BIP-39's own test phrase, and the Base account every wallet derives from it. */
const VECTOR_PHRASE =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const VECTOR_ADDRESS = "0x9858EfFD232B4033E47d90003D41EC34EcaEda94";
const IMPORTED_KEY = "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" as Hex;
const BACKUP_WARNING =
  "Anyone with these words can spend the wallet. Never type them into a website or chat.";

const originalHome = process.env.VAPI_HOME;
const originalPassword = process.env.VAPI_KEYSTORE_PASSWORD;
const originalSolanaRpc = process.env.SOLANA_RPC_URL;

afterEach(() => {
  restoreEnvironment("VAPI_HOME", originalHome);
  restoreEnvironment("VAPI_KEYSTORE_PASSWORD", originalPassword);
  restoreEnvironment("SOLANA_RPC_URL", originalSolanaRpc);
});

describe("CLI JSON output", () => {
  it("initializes a wallet without printing a QR code", async () => {
    const home = await mkdtemp(join(tmpdir(), "vapi-cli-init-"));
    process.env.VAPI_HOME = home;
    process.env.VAPI_KEYSTORE_PASSWORD = "test-only-passphrase";
    const captured = captureIo();

    expect(await runCli(["init", "--json"], captured.io, { fetchImpl: zeroBalanceRpc() })).toBe(0);
    expect(captured.stderr).toEqual([]);
    expect(captured.stdout).toHaveLength(1);
    const value = JSON.parse(captured.stdout[0]!) as Record<string, unknown>;
    expect(value).toMatchObject({
      accounts: [
        {
          caip2: "eip155:8453",
          usdcBalance: { atomic: "0", formatted: "0" },
          gasTokenBalance: { symbol: "ETH", atomic: "0", formatted: "0" },
        },
      ],
      config: join(home, "config.json"),
      keystore: join(home, "keystore.json"),
      message: "vAPI wallet created. Its encrypted key stays on this machine.",
    });
    expect(value.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(captured.stdout[0]).not.toContain("\u2588");
    expect(JSON.parse(await readFile(join(home, "keystore.json"), "utf8"))).not.toHaveProperty(
      "privateKey",
    );
  });

  it("returns the next steps in --json and prints them under the mark", async () => {
    const home = await mkdtemp(join(tmpdir(), "vapi-cli-next-steps-"));
    process.env.VAPI_HOME = home;
    process.env.VAPI_KEYSTORE_PASSWORD = "test-only-passphrase";
    const jsonRun = captureIo();
    expect(await runCli(["init", "--json"], jsonRun.io, { fetchImpl: zeroBalanceRpc() })).toBe(0);
    const value = JSON.parse(jsonRun.stdout[0]!) as { address: string; nextSteps: string[] };

    expect(value.nextSteps).toHaveLength(6);
    expect(value.nextSteps[0]).toContain(value.address);
    expect(value.nextSteps[0]).toContain("(copy this to fund it)");
    expect(value.nextSteps[1]).toBe(
      "Back up   vapi backup                                (write the 12 words down; vAPI cannot recover them)",
    );

    const humanHome = await mkdtemp(join(tmpdir(), "vapi-cli-next-steps-human-"));
    process.env.VAPI_HOME = humanHome;
    const humanRun = captureIo();
    expect(await runCli(["init"], humanRun.io, { fetchImpl: zeroBalanceRpc() })).toBe(0);
    const text = humanRun.stdout.join("\n");

    expect(text).toContain("vAPI Network");
    expect(text).toContain("\u2588");
    expect(text).toMatch(/Fund {6}vapi fund\s+\(card via Coinbase, a wallet transfer/);
    expect(text).toContain('vapi search "weather"');
    expect(text).toContain('Agent     add {"command":"npx","args":["-y","vapi-network","mcp"]}');
    expect(text).not.toContain("\u001b[");
  });

  it("reports an empty configured balance without making a network request", async () => {
    const home = await mkdtemp(join(tmpdir(), "vapi-cli-balance-"));
    process.env.VAPI_HOME = home;
    process.env.VAPI_KEYSTORE_PASSWORD = "test-only-passphrase";
    expect(await runCli(["init", "--json"], captureIo().io, { fetchImpl: zeroBalanceRpc() })).toBe(
      0,
    );

    const paths = getVapiPaths(home);
    const config = JSON.parse(await readFile(paths.config, "utf8")) as Record<string, unknown>;
    config.networks = {};
    await writeFile(paths.config, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    const captured = captureIo();

    expect(await runCli(["balance", "--json"], captured.io)).toBe(0);
    expect(captured.stderr).toEqual([]);
    expect(JSON.parse(captured.stdout[0]!)).toEqual({
      address: expect.stringMatching(/^0x[0-9a-fA-F]{40}$/),
      balances: [],
    });
  });

  it("creates an encrypted Solana key and mainnet config when requested", async () => {
    const home = await mkdtemp(join(tmpdir(), "vapi-cli-solana-init-"));
    process.env.VAPI_HOME = home;
    process.env.VAPI_KEYSTORE_PASSWORD = "test-only-passphrase";
    delete process.env.SOLANA_RPC_URL;
    const captured = captureIo();

    expect(
      await runCli(["init", "--networks", "base,solana", "--json"], captured.io, {
        fetchImpl: zeroBalanceRpc(),
      }),
    ).toBe(0);
    const value = JSON.parse(captured.stdout[0]!) as {
      accounts: Array<{ caip2: string; address: string }>;
    };
    const keystore = JSON.parse(await readFile(join(home, "keystore.json"), "utf8")) as {
      version: number;
      keys: { solana?: { type: string; address: string; path: string } };
    };
    const config = JSON.parse(await readFile(join(home, "config.json"), "utf8")) as {
      networks: Record<string, { rpcUrl: string; usdc: string }>;
    };

    const solana = value.accounts.find((account) => account.caip2.startsWith("solana:"));
    expect(solana?.address).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
    expect(keystore).toMatchObject({
      version: 3,
      keys: {
        solana: { type: "ed25519", address: solana?.address, path: "m/44'/501'/0'/0'" },
      },
    });
    expect(config.networks).toMatchObject({
      "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d": {
        rpcUrl: "https://api.mainnet-beta.solana.com",
        usdc: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      },
    });
  });

  it("lazily enables Solana without replacing the existing EVM key", async () => {
    const home = await mkdtemp(join(tmpdir(), "vapi-cli-solana-enable-"));
    process.env.VAPI_HOME = home;
    process.env.VAPI_KEYSTORE_PASSWORD = "test-only-passphrase";
    delete process.env.SOLANA_RPC_URL;
    const initialized = captureIo();
    const fetchImpl = zeroBalanceRpc();
    expect(await runCli(["init", "--json"], initialized.io, { fetchImpl })).toBe(0);
    const evm = (JSON.parse(initialized.stdout[0]!) as { address: string }).address;
    const enabled = captureIo();

    expect(
      await runCli(["accounts", "--enable", "solana", "--json"], enabled.io, { fetchImpl }),
    ).toBe(0);
    expect(JSON.parse(enabled.stdout[0]!)).toMatchObject({
      accounts: [
        { caip2: "eip155:8453", address: evm },
        {
          caip2: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
          address: expect.stringMatching(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/),
        },
      ],
    });
  });
});

describe("bare invocation", () => {
  it("shows the welcome banner above the usage list", async () => {
    const captured = captureIo();

    expect(await runCli([], captured.io)).toBe(0);
    const text = captured.stdout.join("\n");

    expect(text.split("Welcome to the vAPI Network")).toHaveLength(2);
    expect(text).toContain("\u2588");
    expect(text).toContain("vapi fund [--amount <usd>] [--json]");
  });

  it("keeps --json help output free of the mark", async () => {
    const captured = captureIo();

    expect(await runCli(["--json"], captured.io)).toBe(0);
    const value = JSON.parse(captured.stdout[0]!) as { command: string; help: string };
    expect(value.command).toBe("help");
    expect(value.help.startsWith("vAPI Network")).toBe(true);
    expect(captured.stdout[0]).not.toContain("\u2588");
  });
});

describe("fund command", () => {
  it("prints the funding page link without touching the network", async () => {
    const home = await initializedHome("vapi-cli-fund-page-");
    const fetchImpl = vi.fn<typeof fetch>();
    const captured = captureIo();

    expect(await runCli(["fund", "--amount", "20"], captured.io, { fetchImpl })).toBe(0);
    expect(captured.stderr).toEqual([]);
    expect(captured.stdout[0]).toMatch(/^Address: 0x[0-9a-fA-F]{40}\n/);
    expect(captured.stdout[0]).toMatch(
      /Fund: https:\/\/api\.vapinetwork\.ai\/fund\/0x[0-9a-fA-F]{40}\?amount=20/,
    );
    expect(captured.stdout[0]).toContain("card via Coinbase");
    expect(captured.stdout[0]).toContain("Send USDC on Base (eip155:8453)");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(home).toContain("vapi-cli-fund-page-");
  });

  it("returns the address, network and link as JSON", async () => {
    await initializedHome("vapi-cli-fund-json-");
    const fetchImpl = vi.fn<typeof fetch>();
    const captured = captureIo();

    expect(await runCli(["fund", "--json"], captured.io, { fetchImpl })).toBe(0);
    const value = JSON.parse(captured.stdout[0]!) as Record<string, string>;
    expect(Object.keys(value).sort()).toEqual(["address", "network", "url"]);
    expect(value.network).toBe("base");
    expect(value.url).toBe(`https://api.vapinetwork.ai/fund/${value.address}`);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("honours VAPI_REGISTRY_URL", async () => {
    await initializedHome("vapi-cli-fund-registry-");
    const previous = process.env.VAPI_REGISTRY_URL;
    process.env.VAPI_REGISTRY_URL = "https://staging.example";
    const captured = captureIo();

    try {
      expect(await runCli(["fund", "--json"], captured.io)).toBe(0);
    } finally {
      restoreEnvironment("VAPI_REGISTRY_URL", previous);
    }
    expect((JSON.parse(captured.stdout[0]!) as { url: string }).url).toContain(
      "https://staging.example/fund/0x",
    );
  });

  it("rejects an amount that is not a dollar figure", async () => {
    await initializedHome("vapi-cli-fund-amount-");
    const captured = captureIo();

    expect(await runCli(["fund", "--amount", "twenty"], captured.io)).toBe(2);
    expect(captured.stderr[0]).toContain("--amount must be a US dollar amount");
  });
});

describe("accounts and support commands", () => {
  it("lists deposit accounts as stable JSON", async () => {
    const home = await mkdtemp(join(tmpdir(), "vapi-cli-accounts-"));
    process.env.VAPI_HOME = home;
    process.env.VAPI_KEYSTORE_PASSWORD = "test-only-passphrase";
    const fetchImpl = zeroBalanceRpc();
    expect(await runCli(["init", "--json"], captureIo().io, { fetchImpl })).toBe(0);
    const captured = captureIo();

    expect(await runCli(["accounts", "--json"], captured.io, { fetchImpl })).toBe(0);
    expect(captured.stderr).toEqual([]);
    expect(JSON.parse(captured.stdout[0]!)).toMatchObject({
      accounts: [
        {
          caip2: "eip155:8453",
          name: "Base mainnet",
          address: expect.stringMatching(/^0x[0-9a-fA-F]{40}$/),
          usdcBalance: { atomic: "0", formatted: "0" },
          gasTokenBalance: { symbol: "ETH", atomic: "0", formatted: "0" },
          depositInstructions: expect.stringContaining("Send USDC on Base"),
        },
      ],
    });
  });

  it("writes a private local report without a network request", async () => {
    const home = await mkdtemp(join(tmpdir(), "vapi-cli-report-"));
    process.env.VAPI_HOME = home;
    const paths = getVapiPaths();
    await appendReceipt(
      {
        id: "latest-receipt",
        timestamp: new Date().toISOString(),
        resourceUrl: "https://api.example/call",
        quote: {
          network: "eip155:8453",
          asset: "0xasset",
          amountAtomic: "2500",
          payTo: "0xpayee",
        },
        payer: "0xpayer",
      },
      paths.receipts,
    );
    const fetchImpl = vi.fn<typeof fetch>();
    const captured = captureIo();

    expect(await runCli(["report", "payment failed", "--json"], captured.io, { fetchImpl })).toBe(
      0,
    );
    const result = JSON.parse(captured.stdout[0]!) as { path: string; issueUrl: string };
    const report = await readFile(result.path, "utf8");
    expect(result.issueUrl).toContain("title=payment%20failed");
    expect(report).toContain('"receiptIds"');
    expect(report).toContain("latest-receipt");
    expect(report).not.toContain("0xpayer");
    expect(report).not.toContain("0xpayee");
    expect(report).not.toContain("2500");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("search output", () => {
  const discoveryPage = {
    protocol: "vapi.marketplace.discovery/1",
    items: [
      {
        ref: "decodepaymentauthorization",
        kind: "api",
        provenance: "self_listed",
        group: "vapi",
        fee: { bps: 500, label: "5% network fee, paid by the API's splitter" },
        execution: { mode: "direct" },
        card: {
          title: "decodePaymentAuthorization",
          summary: "Decode what an EVM payment authorization actually authorizes.",
          badges: [{ code: "live_x402", label: "Live x402" }],
          facts: [{ label: "Price", value: "$0.005" }],
        },
        action: { type: "invoke_api", href: "/call/decodepaymentauthorization" },
      },
      {
        ref: "https://agent402.tools/api/skill/decode-blob",
        kind: "api",
        provenance: "indexed",
        group: "external",
        fee: { bps: 0, label: "No network fee" },
        execution: {
          mode: "direct",
          url: "https://agent402.tools/api/skill/decode-blob",
          method: "POST",
          network: "eip155:8453",
        },
        card: {
          title: "agent402.tools/api/skill/decode-blob",
          summary: "Unwrap an opaque blob layer by layer.",
          badges: [{ code: "external_catalog", label: "External catalog" }],
          facts: [{ label: "Price", value: "$0.007" }],
        },
        action: {
          type: "invoke_api",
          href: "/call/invoke?url=https%3A%2F%2Fagent402.tools%2Fapi%2Fskill%2Fdecode-blob",
        },
      },
    ],
    nextCursor: null,
    unavailableKinds: [],
    rankingVersion: "marketplace-ranking-v1",
  };

  it("tags each listing with its group and prints the network fee label", async () => {
    const home = await mkdtemp(join(tmpdir(), "vapi-cli-search-"));
    process.env.VAPI_HOME = home;
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json(discoveryPage));
    const captured = captureIo();

    expect(await runCli(["search", "decode"], captured.io, { fetchImpl })).toBe(0);

    const text = captured.stdout.join("\n");
    expect(text).toContain("[vapi] decodePaymentAuthorization");
    expect(text).toContain("[external] agent402.tools/api/skill/decode-blob");
    expect(text).toContain("Fee: 5% network fee, paid by the API's splitter");
    expect(text).toContain("Fee: No network fee");
  });

  it("passes the group and fee through --json untouched", async () => {
    const home = await mkdtemp(join(tmpdir(), "vapi-cli-search-json-"));
    process.env.VAPI_HOME = home;
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json(discoveryPage));
    const captured = captureIo();

    expect(await runCli(["search", "decode", "--json"], captured.io, { fetchImpl })).toBe(0);

    const page = JSON.parse(captured.stdout[0]!) as {
      items: Array<{ group?: string; fee?: { bps: number; label: string } }>;
    };
    expect(page.items.map((item) => item.group)).toEqual(["vapi", "external"]);
    expect(page.items[0]?.fee).toEqual({
      bps: 500,
      label: "5% network fee, paid by the API's splitter",
    });
  });
});

describe("local metrics commands", () => {
  it("prints stable stats JSON and exports flattened CSV", async () => {
    const home = await mkdtemp(join(tmpdir(), "vapi-cli-metrics-"));
    process.env.VAPI_HOME = home;
    const paths = getVapiPaths();
    const timestamp = new Date().toISOString();
    await appendReceipt(
      {
        id: "paid-weather",
        timestamp,
        resourceUrl: "https://weather.example/call",
        quote: {
          network: "eip155:8453",
          asset: "0xasset",
          amountAtomic: "2500",
          payTo: "0xpayee",
        },
        outcome: "paid",
        latencyMs: 25,
        phases: { quoteMs: 10, requestMs: 15 },
        listing: { name: "Weather", providerHost: "weather.example", source: "vapi" },
        policy: { capsApplied: true },
        client: { name: "vapi-network", version: "0.2.0-dev.3" },
      },
      paths.receipts,
    );
    await appendSearchEvent(
      {
        timestamp,
        query: "weather",
        sources: [{ source: "api.vapinetwork.ai", latencyMs: 12, count: 1 }],
        mergedCount: 1,
      },
      paths.searches,
    );

    const statsOutput = captureIo();
    expect(await runCli(["stats", "--range", "24h", "--json"], statsOutput.io)).toBe(0);
    expect(JSON.parse(statsOutput.stdout[0]!)).toMatchObject({
      range: "24h",
      totals: { spendUsd: "0.0025", calls: 1, uniqueApis: 1, policyDeclines: 0 },
      outcomes: { paid: { count: 1, rate: 1 } },
      search: { count: 1, zeroResultRate: 0 },
    });

    const csvOutput = captureIo();
    expect(
      await runCli(["receipts", "export", "--format", "csv", "--range", "24h"], csvOutput.io),
    ).toBe(0);
    expect(csvOutput.stdout[0]).toContain("id,timestamp,outcome,resourceUrl");
    expect(csvOutput.stdout[0]).toContain("paid-weather");
    expect(csvOutput.stdout[0]).toContain("0.0025");
  });
});

describe("future gateway commands", () => {
  for (const command of ["serve", "publish"] as const) {
    it(`${command} exits 2 with the promised message`, async () => {
      const captured = captureIo();
      expect(await runCli([command], captured.io)).toBe(2);
      expect(captured.stdout).toEqual([]);
      expect(captured.stderr).toEqual(["gateway daemon lands in 0.3"]);
    });

    it(`${command} remains a stub when its future arguments are supplied`, async () => {
      const captured = captureIo();
      const argumentsForPreview = command === "serve" ? ["--port", "4020"] : ["openapi.json"];
      expect(await runCli([command, ...argumentsForPreview], captured.io)).toBe(2);
      expect(captured.stderr).toEqual(["gateway daemon lands in 0.3"]);
    });

    it(`${command} has machine-readable JSON output`, async () => {
      const captured = captureIo();
      expect(await runCli([command, "--json"], captured.io)).toBe(2);
      expect(captured.stderr).toEqual([]);
      expect(JSON.parse(captured.stdout[0]!)).toEqual({
        error: "gateway daemon lands in 0.3",
        exitCode: 2,
      });
    });
  }
});

describe("init safety", () => {
  it("refuses a second init before asking for a passphrase", async () => {
    const home = await initializedHome("vapi-cli-init-twice-");
    const address = (
      JSON.parse(await readFile(join(home, "keystore.json"), "utf8")) as { address: string }
    ).address;
    // No passphrase in the environment: reaching the prompt would fail differently.
    delete process.env.VAPI_KEYSTORE_PASSWORD;
    const captured = captureIo();

    expect(await runCli(["init"], captured.io, { fetchImpl: zeroBalanceRpc() })).toBe(1);

    const message = captured.stderr.join("\n");
    expect(message).toContain(
      `Keystore already exists at ${join(home, "keystore.json")}. Refusing to replace the local payment key.`,
    );
    expect(message).toContain(`Address: ${address}`);
    expect(message).not.toContain("interactive terminal");
  });
});

describe("export-key command", () => {
  const SOLANA_MAINNET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";

  it("prints only the EVM key on stdout, behind a stderr warning", async () => {
    const home = await initializedHome("vapi-cli-export-evm-");
    const address = (
      JSON.parse(await readFile(join(home, "keystore.json"), "utf8")) as { address: string }
    ).address;
    const captured = captureIo();

    expect(await runCli(["export-key"], captured.io)).toBe(0);

    expect(captured.stderr).toEqual([
      "Anyone with this key can spend the wallet. Never paste it into a website or chat.",
    ]);
    expect(captured.stdout).toHaveLength(1);
    const privateKey = captured.stdout[0]!;
    expect(privateKey).toMatch(/^0x[0-9a-f]{64}$/);
    expect(privateKeyToAccount(privateKey as Hex).address).toBe(address);
  });

  it("returns the network, address, and key as JSON", async () => {
    await initializedHome("vapi-cli-export-json-");
    const captured = captureIo();

    expect(await runCli(["export-key", "--json"], captured.io)).toBe(0);

    const value = JSON.parse(captured.stdout[0]!) as {
      network: string;
      address: string;
      privateKey: string;
    };
    expect(value.network).toBe("eip155:8453");
    expect(privateKeyToAccount(value.privateKey as Hex).address).toBe(value.address);
  });

  it("exports the Solana secret key in base58 once Solana is enabled", async () => {
    const home = await mkdtemp(join(tmpdir(), "vapi-cli-export-solana-"));
    process.env.VAPI_HOME = home;
    process.env.VAPI_KEYSTORE_PASSWORD = "test-only-passphrase";
    delete process.env.SOLANA_RPC_URL;
    expect(
      await runCli(["init", "--networks", "base,solana", "--json"], captureIo().io, {
        fetchImpl: zeroBalanceRpc(),
      }),
    ).toBe(0);
    const solanaAddress = (
      JSON.parse(await readFile(join(home, "keystore.json"), "utf8")) as {
        keys: { solana?: { address: string } };
      }
    ).keys.solana?.address;
    const captured = captureIo();

    expect(await runCli(["export-key", "--network", SOLANA_MAINNET, "--json"], captured.io)).toBe(
      0,
    );

    const value = JSON.parse(captured.stdout[0]!) as {
      network: string;
      address: string;
      privateKey: string;
    };
    expect(value.network).toBe(SOLANA_MAINNET);
    expect(value.address).toBe(solanaAddress);
    // 64 raw bytes of Ed25519 secret key, base58-encoded.
    expect(value.privateKey).toMatch(/^[1-9A-HJ-NP-Za-km-z]{86,88}$/);
  });

  it("explains how to enable Solana instead of exporting the EVM key", async () => {
    const home = await initializedHome("vapi-cli-export-no-solana-");
    const captured = captureIo();

    expect(await runCli(["export-key", "--network", SOLANA_MAINNET], captured.io)).toBe(1);

    expect(captured.stdout).toEqual([]);
    expect(captured.stderr.at(-1)).toBe(
      `No Solana key is enabled in ${join(home, "keystore.json")}. Run vapi accounts --enable solana first.`,
    );
  });

  it("rejects a network identifier it cannot map to a key", async () => {
    await initializedHome("vapi-cli-export-bad-network-");
    const captured = captureIo();

    expect(await runCli(["export-key", "--network", "bitcoin:mainnet"], captured.io)).toBe(2);
    expect(captured.stdout).toEqual([]);
    expect(captured.stderr[0]).toContain("eip155:<chainId> or Solana network identifier");
  });
});

describe("custody at creation", () => {
  it("prints the custody notice and shows the phrase once behind an Enter gate", async () => {
    const home = await mkdtemp(join(tmpdir(), "vapi-cli-init-phrase-"));
    process.env.VAPI_HOME = home;
    process.env.VAPI_KEYSTORE_PASSWORD = "test-only-passphrase";
    const prompts = scriptedPrompts({ "Write these 12 words down, then press Enter. ": "" });
    const captured = captureIo();

    expect(
      await runCli(["init"], captured.io, {
        fetchImpl: zeroBalanceRpc(),
        interactive: true,
        prompts: prompts.prompts,
      }),
    ).toBe(0);

    const text = captured.stdout.join("\n");
    expect(text).toContain(
      "This wallet is yours. vAPI has no copy of the key and cannot recover it.",
    );
    expect(text).toContain(
      "If you lose this machine and your recovery phrase, the funds are gone.",
    );
    expect(prompts.prompted).toEqual(["Write these 12 words down, then press Enter. "]);
    expect(captured.stderr).toEqual([]);

    const words = numberedWords(text);
    expect(words).toHaveLength(12);
    const backup = captureIo();
    expect(await runCli(["backup", "--json"], backup.io)).toBe(0);
    expect(JSON.parse(backup.stdout[0]!)).toEqual({ recoveryPhrase: words.join(" ") });
  });

  it("hides the phrase in --json and names vapi backup without a terminal", async () => {
    const jsonHome = await mkdtemp(join(tmpdir(), "vapi-cli-init-json-phrase-"));
    process.env.VAPI_HOME = jsonHome;
    process.env.VAPI_KEYSTORE_PASSWORD = "test-only-passphrase";
    const jsonRun = captureIo();

    expect(
      await runCli(["init", "--json"], jsonRun.io, {
        fetchImpl: zeroBalanceRpc(),
        interactive: true,
        prompts: refusingPrompts(),
      }),
    ).toBe(0);

    expect(jsonRun.stdout).toHaveLength(1);
    expect(JSON.parse(jsonRun.stdout[0]!)).toMatchObject({
      custody: "self",
      recoveryPhrase: "hidden",
      warning:
        "This wallet is yours. vAPI has no copy of the key and cannot recover it.\nIf you lose this machine and your recovery phrase, the funds are gone.",
    });
    expect(numberedWords(jsonRun.stdout[0]!)).toEqual([]);

    const pipedHome = await mkdtemp(join(tmpdir(), "vapi-cli-init-piped-phrase-"));
    process.env.VAPI_HOME = pipedHome;
    const piped = captureIo();

    expect(
      await runCli(["init"], piped.io, {
        fetchImpl: zeroBalanceRpc(),
        interactive: false,
        prompts: refusingPrompts(),
      }),
    ).toBe(0);

    const text = piped.stdout.join("\n");
    expect(text).toContain("Recovery phrase: run vapi backup to see it.");
    expect(numberedWords(text)).toEqual([]);
  });
});

describe("backup command", () => {
  it("prints the numbered words on stdout behind a stderr warning", async () => {
    await initializedHome("vapi-cli-backup-v3-");
    const captured = captureIo();

    expect(await runCli(["backup"], captured.io)).toBe(0);

    expect(captured.stderr).toEqual([BACKUP_WARNING]);
    expect(captured.stdout).toHaveLength(1);
    expect(numberedWords(captured.stdout[0]!)).toHaveLength(12);
  });

  it("points a keystore from before recovery phrases at vapi export-key", async () => {
    const home = await mkdtemp(join(tmpdir(), "vapi-cli-backup-v2-"));
    process.env.VAPI_HOME = home;
    process.env.VAPI_KEYSTORE_PASSWORD = "test-only-passphrase";
    await writeFile(
      join(home, "keystore.json"),
      JSON.stringify(await encryptPrivateKey(IMPORTED_KEY, "test-only-passphrase")),
      { mode: 0o600 },
    );
    const captured = captureIo();

    expect(await runCli(["backup"], captured.io)).toBe(1);

    expect(captured.stdout).toEqual([]);
    expect(captured.stderr[0]).toBe(BACKUP_WARNING);
    const message = captured.stderr.slice(1).join("\n");
    expect(message).toContain("keystore version 2");
    expect(message).toContain(join(home, "keystore.json"));
    expect(message).toContain("vapi export-key");
  });
});

describe("import command", () => {
  it("restores the vector wallet from words typed at the prompt", async () => {
    const home = await mkdtemp(join(tmpdir(), "vapi-cli-import-phrase-"));
    process.env.VAPI_HOME = home;
    process.env.VAPI_KEYSTORE_PASSWORD = "test-only-passphrase";
    const prompts = scriptedPrompts({ "Recovery phrase: ": VECTOR_PHRASE });
    const captured = captureIo();

    expect(
      await runCli(["import", "--phrase", "--json"], captured.io, {
        fetchImpl: zeroBalanceRpc(),
        prompts: prompts.prompts,
      }),
    ).toBe(0);

    expect(captured.stderr).toEqual([]);
    expect(JSON.parse(captured.stdout[0]!)).toEqual({
      address: VECTOR_ADDRESS,
      keystore: join(home, "keystore.json"),
      message: "Wallet imported. Its encrypted key stays on this machine.",
    });
    expect(captured.stdout[0]).not.toContain("abandon");
    const keystore = JSON.parse(await readFile(join(home, "keystore.json"), "utf8")) as {
      version: number;
    };
    expect(keystore.version).toBe(3);
  });

  it("refuses to replace an existing wallet, and never reads the phrase from argv", async () => {
    await initializedHome("vapi-cli-import-existing-");
    const prompts = scriptedPrompts({ "Recovery phrase: ": VECTOR_PHRASE });
    const refused = captureIo();

    expect(
      await runCli(["import", "--phrase"], refused.io, {
        fetchImpl: zeroBalanceRpc(),
        prompts: prompts.prompts,
      }),
    ).toBe(1);
    expect(refused.stderr.join("\n")).toContain("Keystore already exists at");
    expect(refused.stderr.join("\n")).toContain("--replace");
    expect(prompts.prompted).toEqual([]);

    const onArgv = captureIo();
    expect(
      await runCli(["import", "--phrase", "abandon", "abandon"], onArgv.io, {
        prompts: refusingPrompts(),
      }),
    ).toBe(2);
    expect(onArgv.stderr[0]).toContain("reads the secret from a prompt");
  });

  it("moves the empty wallet aside with --replace and keeps a funded one", async () => {
    const home = await initializedHome("vapi-cli-import-replace-");
    const previousAddress = (
      JSON.parse(await readFile(join(home, "keystore.json"), "utf8")) as { address: string }
    ).address;
    const funded = captureIo();

    expect(
      await runCli(["import", "--phrase", "--replace"], funded.io, {
        fetchImpl: fundedRpc(),
        prompts: refusingPrompts(),
      }),
    ).toBe(1);
    expect(funded.stderr.join("\n")).toContain(`${previousAddress} still holds 1 USDC on Base.`);
    expect(funded.stderr.join("\n")).toContain("--force");

    const prompts = scriptedPrompts({ "Recovery phrase: ": VECTOR_PHRASE });
    const captured = captureIo();
    expect(
      await runCli(["import", "--phrase", "--replace", "--json"], captured.io, {
        fetchImpl: zeroBalanceRpc(),
        prompts: prompts.prompts,
      }),
    ).toBe(0);

    const value = JSON.parse(captured.stdout[0]!) as { address: string; previousKeystore: string };
    expect(value.address).toBe(VECTOR_ADDRESS);
    expect(value.previousKeystore).toMatch(/keystore\.json\.bak-/u);
    expect((await stat(value.previousKeystore)).mode & 0o777).toBe(0o600);
    expect(
      (JSON.parse(await readFile(value.previousKeystore, "utf8")) as { address: string }).address,
    ).toBe(previousAddress);
  });

  it("round-trips a private key typed at the prompt", async () => {
    const home = await mkdtemp(join(tmpdir(), "vapi-cli-import-key-"));
    process.env.VAPI_HOME = home;
    process.env.VAPI_KEYSTORE_PASSWORD = "test-only-passphrase";
    const prompts = scriptedPrompts({ "Private key: ": IMPORTED_KEY });
    const captured = captureIo();

    expect(
      await runCli(["import", "--key", "--json"], captured.io, {
        fetchImpl: zeroBalanceRpc(),
        prompts: prompts.prompts,
      }),
    ).toBe(0);

    const expected = privateKeyToAccount(IMPORTED_KEY).address;
    expect(JSON.parse(captured.stdout[0]!)).toMatchObject({ address: expected });
    expect(captured.stdout[0]).not.toContain(IMPORTED_KEY.slice(2));
    expect(
      (JSON.parse(await readFile(join(home, "keystore.json"), "utf8")) as { version: number })
        .version,
    ).toBe(2);

    const exported = captureIo();
    expect(await runCli(["export-key"], exported.io)).toBe(0);
    expect(exported.stdout[0]).toBe(IMPORTED_KEY);
  });
});

describe("passphrase command", () => {
  it("re-encrypts the wallet in place and retires the old passphrase", async () => {
    const home = await initializedHome("vapi-cli-passphrase-");
    const address = (
      JSON.parse(await readFile(join(home, "keystore.json"), "utf8")) as { address: string }
    ).address;
    const prompts = scriptedPrompts({
      "New passphrase: ": "second-passphrase",
      "Confirm new passphrase: ": "second-passphrase",
    });
    const captured = captureIo();

    expect(await runCli(["passphrase", "--json"], captured.io, { prompts: prompts.prompts })).toBe(
      0,
    );

    expect(JSON.parse(captured.stdout[0]!)).toEqual({
      address,
      keystore: join(home, "keystore.json"),
      message: "Passphrase changed. The wallet and its addresses are unchanged.",
    });
    expect(captured.stdout.join("\n")).not.toContain("second-passphrase");
    expect(captured.stderr).toEqual([
      "VAPI_KEYSTORE_PASSWORD still holds the old passphrase. Update it before the next run.",
    ]);
    expect((await unlockKeystore("second-passphrase", join(home, "keystore.json"))).address).toBe(
      address,
    );
    await expect(
      unlockKeystore("test-only-passphrase", join(home, "keystore.json")),
    ).rejects.toThrow(/wrong passphrase/u);
  });

  it("refuses a new passphrase that does not match its confirmation", async () => {
    await initializedHome("vapi-cli-passphrase-mismatch-");
    const prompts = scriptedPrompts({
      "New passphrase: ": "second-passphrase",
      "Confirm new passphrase: ": "typo-passphrase",
    });
    const captured = captureIo();

    expect(await runCli(["passphrase"], captured.io, { prompts: prompts.prompts })).toBe(1);
    expect(captured.stderr).toEqual(["Passphrases do not match."]);
    expect(captured.stdout).toEqual([]);
  });
});

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
  return {
    prompted,
    prompts: {
      secret: async (prompt) => {
        prompted.push(prompt);
        const answer = answers[prompt];
        if (answer === undefined) throw new Error(`Unexpected prompt ${JSON.stringify(prompt)}.`);
        return answer;
      },
    },
  };
}

/** A prompt that must never be reached. */
function refusingPrompts(): CliPrompts {
  return {
    secret: async (prompt) => {
      throw new Error(`Unexpected prompt ${JSON.stringify(prompt)}.`);
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

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

async function initializedHome(prefix: string): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), prefix));
  process.env.VAPI_HOME = home;
  process.env.VAPI_KEYSTORE_PASSWORD = "test-only-passphrase";
  expect(await runCli(["init", "--json"], captureIo().io, { fetchImpl: zeroBalanceRpc() })).toBe(0);
  return home;
}

/** One USDC on Base, so a replace has something to refuse. */
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
