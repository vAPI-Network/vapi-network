import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  WalletStore,
  getDefaultConfig,
  readAuditLog,
  type AuditEntry,
  type VapiConfig,
} from "@vapi-network/core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createVapiServer } from "./server.js";

const PASSPHRASE = "test-only-passphrase";
const PAY_TO = "0x1111111111111111111111111111111111111111";
const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("wallet.list", () => {
  it("shows every wallet with its caps, balances, default and session markers", async () => {
    const home = await walletHome("vapi-mcp-wallet-list-");
    const { server } = await servedHome(home, zeroBalanceFetch());

    const result = await server.callTool({ name: "wallet.list" });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      wallet: "main",
      default: "main",
      wallets: [
        {
          name: "main",
          address: expect.stringMatching(/^0x[0-9a-fA-F]{40}$/u),
          isDefault: true,
          isActive: true,
          spendCaps: {
            perCallAtomic: "100000",
            perDayAtomic: "1000000",
            perCallUsd: "0.1",
            perDayUsd: "1",
          },
          balances: [{ network: "eip155:8453", usdcAtomic: "0", usdc: "0" }],
        },
        {
          name: "agent",
          label: "for the agent",
          isDefault: false,
          isActive: false,
          spendCaps: { perCallAtomic: "10000", perDayAtomic: "20000" },
        },
      ],
    });
    // The wallet list is a read: it never asks for a passphrase.
    expect(JSON.stringify(result.structuredContent)).not.toContain(PASSPHRASE);
    await server.close();
  });

  it("keeps listing the other wallets when one wallet's RPC fails", async () => {
    const home = await walletHome("vapi-mcp-wallet-list-rpc-");
    const agentAddress = await addressOf(home, "agent");
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const body = String(init?.body ?? (input instanceof Request ? await input.text() : ""));
      if (body.includes(agentAddress.slice(2).toLowerCase())) {
        throw new Error("RPC is unreachable.");
      }
      return rpcOk(body);
    });
    const { server } = await servedHome(home, fetchImpl);

    const result = await server.callTool({ name: "wallet.list" });

    const wallets = (result.structuredContent as { wallets: Array<Record<string, unknown>> })
      .wallets;
    expect(result.isError).not.toBe(true);
    expect(wallets[0]).toMatchObject({ name: "main" });
    expect(wallets[0]).not.toHaveProperty("balanceError");
    expect(wallets[0]!.balances).toEqual([expect.objectContaining({ usdcAtomic: "0" })]);
    expect(wallets[1]).toMatchObject({
      name: "agent",
      balanceError: expect.stringContaining("RPC is unreachable."),
    });
    await server.close();
  });
});

describe("wallet.use", () => {
  it("moves the session, reports the previous wallet, and never writes wallets.json", async () => {
    const home = await walletHome("vapi-mcp-wallet-use-");
    const registryPath = join(home, "wallets.json");
    const before = await readFile(registryPath, "utf8");
    const { server } = await servedHome(home, zeroBalanceFetch());

    const used = await server.callTool({ name: "wallet.use", arguments: { name: "agent" } });
    const address = await server.callTool({ name: "wallet.address" });

    expect(used.structuredContent).toMatchObject({
      wallet: "agent",
      active: "agent",
      previous: "main",
      scope: "session",
      address: expect.stringMatching(/^0x[0-9a-fA-F]{40}$/u),
    });
    // The session moved; the human's default on disk did not.
    expect(await readFile(registryPath, "utf8")).toBe(before);
    expect(JSON.parse(before)).toMatchObject({ default: "main" });
    expect(address.structuredContent).toMatchObject({ wallet: "agent" });
    await server.close();
  });

  it("describes wallet.use as session-only and offers no wallet-changing tool", async () => {
    const home = await walletHome("vapi-mcp-wallet-use-doc-");
    const { server } = await servedHome(home, zeroBalanceFetch());

    const tools = await server.listTools();

    const use = tools.tools.find((tool) => tool.name === "wallet.use");
    expect(use?.description).toContain("Session-only");
    expect(use?.description).toContain("never writes wallets.json");
    await server.close();
  });

  it("refuses an unknown wallet and lists the names that exist", async () => {
    const home = await walletHome("vapi-mcp-wallet-use-unknown-");
    const { server } = await servedHome(home, zeroBalanceFetch());

    const result = await server.callTool({ name: "wallet.use", arguments: { name: "nobody" } });
    const still = await server.callTool({ name: "wallet.address" });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("No wallet named nobody");
    expect(JSON.stringify(result.content)).toContain("agent, main");
    expect(still.structuredContent).toMatchObject({ wallet: "main" });
    await server.close();
  });

  it("appends one audit line with the agent marker and no terminal", async () => {
    const home = await walletHome("vapi-mcp-wallet-use-audit-");
    const { server } = await servedHome(home, zeroBalanceFetch(), {
      VAPI_KEYSTORE_PASSWORD: PASSPHRASE,
      CLAUDECODE: "1",
    });

    await server.callTool({ name: "wallet.use", arguments: { name: "agent" } });

    const entries: AuditEntry[] = await readAuditLog(home);
    expect(entries).toEqual([
      {
        time: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/u),
        event: "wallet.use.session",
        wallet: "agent",
        tty: false,
        agentMarker: "CLAUDECODE",
        detail: "mcp session active wallet was main",
      },
    ]);
    await server.close();
  });
});

describe("the wallet argument", () => {
  it("puts the argument above the session wallet, and the session above the default", async () => {
    const home = await walletHome("vapi-mcp-wallet-pay-");
    const receiptsPath = join(home, "receipts.jsonl");
    const { server } = await servedHome(home, paidResource("5000"), { receiptsPath });
    const pay = async (wallet?: string) =>
      await server.callTool({
        name: "call.pay",
        arguments: {
          url: "https://93.184.216.34/paid",
          maxPriceUsd: "0.01",
          ...(wallet === undefined ? {} : { wallet }),
        },
      });

    const fromDefault = await pay();
    await server.callTool({ name: "wallet.use", arguments: { name: "agent" } });
    const fromSession = await pay();
    const fromArgument = await pay("main");

    expect(fromDefault.structuredContent).toMatchObject({ wallet: "main", status: 200 });
    expect(fromSession.structuredContent).toMatchObject({ wallet: "agent", status: 200 });
    expect(fromArgument.structuredContent).toMatchObject({ wallet: "main", status: 200 });
    const lines = (await readFile(receiptsPath, "utf8")).trim().split("\n");
    expect(lines.map((line) => (JSON.parse(line) as { wallet?: string }).wallet)).toEqual([
      "main",
      "agent",
      "main",
    ]);
    await server.close();
  });

  it("applies the caps of the wallet that pays, not the machine's", async () => {
    const home = await walletHome("vapi-mcp-wallet-caps-");
    const { server } = await servedHome(home, paidResource("25000"), {
      receiptsPath: join(home, "receipts.jsonl"),
    });

    // 0.025 USDC: inside main's 0.10 per-call cap, over agent's 0.01.
    const refused = await server.callTool({
      name: "call.pay",
      arguments: { url: "https://93.184.216.34/paid", wallet: "agent" },
    });
    const allowed = await server.callTool({
      name: "call.pay",
      arguments: { url: "https://93.184.216.34/paid", wallet: "main" },
    });

    expect(refused.isError).toBe(true);
    expect(JSON.stringify(refused.content)).toContain("exceeds the per-call cap 10000");
    expect(allowed.structuredContent).toMatchObject({ wallet: "main", status: 200 });
    await server.close();
  });

  it("filters receipts and stats per wallet and reads them all on request", async () => {
    const home = await walletHome("vapi-mcp-wallet-receipts-");
    const receiptsPath = join(home, "receipts.jsonl");
    const { server } = await servedHome(home, paidResource("5000"), { receiptsPath });

    await server.callTool({
      name: "call.pay",
      arguments: { url: "https://93.184.216.34/paid", wallet: "agent", maxPriceUsd: "0.01" },
    });
    await server.callTool({
      name: "call.pay",
      arguments: { url: "https://93.184.216.34/paid", wallet: "main", maxPriceUsd: "0.01" },
    });

    const sessionWallet = await server.callTool({ name: "receipts.list" });
    const named = await server.callTool({
      name: "receipts.list",
      arguments: { wallet: "agent" },
    });
    const every = await server.callTool({
      name: "receipts.list",
      arguments: { allWallets: true },
    });
    const stats = await server.callTool({ name: "receipts.stats", arguments: { wallet: "agent" } });

    expect(sessionWallet.structuredContent).toMatchObject({
      wallet: "main",
      receipts: [{ wallet: "main" }],
    });
    expect(named.structuredContent).toMatchObject({
      wallet: "agent",
      receipts: [{ wallet: "agent" }],
    });
    expect((every.structuredContent as { wallet: null; receipts: unknown[] }).wallet).toBeNull();
    expect((every.structuredContent as { receipts: unknown[] }).receipts).toHaveLength(2);
    expect(stats.structuredContent).toMatchObject({
      wallet: "agent",
      totals: { calls: 1 },
    });
    await server.close();
  });

  it("lets VAPI_WALLET pick the session wallet before the registry default", async () => {
    const home = await walletHome("vapi-mcp-wallet-env-");
    const { server } = await servedHome(home, zeroBalanceFetch(), {
      VAPI_KEYSTORE_PASSWORD: PASSPHRASE,
      VAPI_WALLET: "agent",
    });

    const address = await server.callTool({ name: "wallet.address" });
    const list = await server.callTool({ name: "wallet.list" });

    expect(address.structuredContent).toMatchObject({ wallet: "agent" });
    expect(list.structuredContent).toMatchObject({
      wallet: "agent",
      default: "main",
      wallets: [
        { name: "main", isActive: false },
        { name: "agent", isActive: true },
      ],
    });
    await server.close();
  });
});

describe("the MCP secret surface", () => {
  const FORBIDDEN_TOOL_WORDS = [
    "backup",
    "export",
    "create",
    "remove",
    "rename",
    "restore",
    "passphrase",
    "import",
  ];
  const FORBIDDEN_RESULT_FIELDS = ["recoveryPhrase", "privateKey", "secretKey", "passphrase"];

  it("has no tool that mints or exports a wallet and no field that returns a secret", async () => {
    const home = await walletHome("vapi-mcp-secret-surface-");
    const { server } = await servedHome(home, zeroBalanceFetch());

    const tools = await server.listTools();

    expect(tools.tools.length).toBeGreaterThan(0);
    for (const tool of tools.tools) {
      for (const word of FORBIDDEN_TOOL_WORDS) {
        expect(tool.name.toLowerCase()).not.toContain(word);
      }
      const fields = schemaPropertyNames(tool.outputSchema);
      for (const field of FORBIDDEN_RESULT_FIELDS) {
        expect([...fields]).not.toContain(field);
      }
    }
    await server.close();
  });
});

/** Every property name a JSON Schema declares, at any depth. */
function schemaPropertyNames(schema: unknown, found = new Set<string>()): Set<string> {
  if (Array.isArray(schema)) {
    for (const item of schema) schemaPropertyNames(item, found);
    return found;
  }
  if (typeof schema !== "object" || schema === null) return found;
  for (const [key, value] of Object.entries(schema)) {
    if (key === "properties" && typeof value === "object" && value !== null) {
      for (const name of Object.keys(value)) found.add(name);
    }
    schemaPropertyNames(value, found);
  }
  return found;
}

/** A home with two wallets: the human's `main` and a tightly capped `agent`. */
async function walletHome(prefix: string): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(home);
  const store = await WalletStore.open(home);
  await store.create("main", PASSPHRASE);
  await store.create("agent", PASSPHRASE, {
    label: "for the agent",
    spendCaps: { perCallAtomic: "10000", perDayAtomic: "20000" },
  });
  return home;
}

async function addressOf(home: string, name: string): Promise<string> {
  const store = await WalletStore.open(home);
  return (await store.list()).find((info) => info.name === name)?.address ?? "";
}

async function servedHome(
  home: string,
  fetchImpl: typeof fetch,
  overrides: NodeJS.ProcessEnv & { receiptsPath?: string } = {},
) {
  const { receiptsPath, ...env } = overrides;
  const store = await WalletStore.open(home);
  const account = await store.unlock("main", PASSPHRASE);
  const config: VapiConfig = getDefaultConfig();
  const server = createVapiServer({
    account,
    config,
    store,
    wallet: undefined,
    env: { VAPI_KEYSTORE_PASSWORD: PASSPHRASE, ...env },
    fetchImpl,
    ledgerPath: join(home, "spend-ledger.json"),
    receiptsPath: receiptsPath ?? join(home, "receipts.jsonl"),
    searchesPath: join(home, "searches.jsonl"),
  });
  return { server, store, config };
}

/** An RPC that answers every balance question with zero. */
function zeroBalanceFetch(): typeof fetch {
  return vi.fn<typeof fetch>(async (input, init) =>
    rpcOk(String(init?.body ?? (input instanceof Request ? await input.text() : ""))),
  );
}

function rpcOk(body: string): Response {
  const request = JSON.parse(body) as { id: number; method: string };
  return Response.json({
    jsonrpc: "2.0",
    id: request.id,
    result: request.method === "eth_call" ? `0x${"0".repeat(64)}` : "0x0",
  });
}

/** A paid resource that quotes `amountAtomic` USDC and answers every signed retry. */
function paidResource(amountAtomic: string): typeof fetch {
  const config = getDefaultConfig();
  const challenge = {
    x402Version: 2,
    resource: { url: "https://93.184.216.34/paid" },
    accepts: [
      {
        scheme: "exact",
        network: "eip155:8453",
        amount: amountAtomic,
        asset: config.networks["eip155:8453"]!.usdc,
        payTo: PAY_TO,
        maxTimeoutSeconds: 60,
        extra: { name: "USD Coin", version: "2" },
      },
    ],
  };
  return vi.fn<typeof fetch>(async (input) => {
    const request = input instanceof Request ? input : new Request(String(input));
    return request.headers.has("payment-signature")
      ? Response.json({ paid: true })
      : Response.json(challenge, { status: 402 });
  });
}
