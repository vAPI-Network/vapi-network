import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  WalletStore,
  getDefaultConfig,
  protectVault,
  readAuditLog,
  setupSwarm,
  type AuditEntry,
  type ChatResult,
  type SecretStore,
  type VapiConfig,
  type VapiPaymentAccount,
} from "@vapi-network/core";
import { agentSecretAccounts } from "@vapi-network/core/agent-link";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mnemonicToAccount } from "viem/accounts";

import { createVapiServer } from "./server.js";

const PASSPHRASE = "test-only-passphrase";
const VAULT_PASSWORD = "test-only-vault-password";
const PAY_TO = "0x1111111111111111111111111111111111111111";
const TEST_PHRASE = "legal winner thank year wave sausage worth useful legal winner thank yellow";
const DEVICE_CODE = "surface-device-code";
const ACCESS_TOKEN = "surface-access-token";
const REFRESH_TOKEN = "surface-refresh-token";
const TRUSTED_TOKEN = "surface-trusted-token";
const TRUSTED_REFRESH_TOKEN = "surface-trusted-refresh";
const ROUTER_KEY = "surface-router-key";
const API_BASE = "https://api.vapinetwork.ai";
const temporaryDirectories: string[] = [];
const secretStores = new Map<string, SecretStore>();

afterEach(async () => {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories) secretStores.delete(directory);
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
    expect(JSON.stringify(result.content)).toContain("No account named nobody");
    expect(JSON.stringify(result.content)).toContain("agent, main");
    expect(still.structuredContent).toMatchObject({ wallet: "main" });
    await server.close();
  });

  it("appends one audit line with the agent marker and no terminal", async () => {
    const home = await walletHome("vapi-mcp-wallet-use-audit-");
    const { server } = await servedHome(home, zeroBalanceFetch(), {
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

describe("paying from the vault", () => {
  const NO_PASSWORD_ENVIRONMENT: NodeJS.ProcessEnv = {};

  it("pays without any passphrase at all", async () => {
    const home = await walletHome("vapi-mcp-unlocked-");
    const { server } = await servedHome(home, paidResource("5000"), {
      ...NO_PASSWORD_ENVIRONMENT,
      receiptsPath: join(home, "receipts.jsonl"),
    });
    expect(await secretsFor(home).has("agent")).toBe(false);

    const paid = await server.callTool({
      name: "call.pay",
      arguments: { url: "https://93.184.216.34/paid", wallet: "agent", maxPriceUsd: "0.01" },
    });

    expect(paid.isError).not.toBe(true);
    expect(paid.structuredContent).toMatchObject({ wallet: "agent", status: 200 });
    expect(JSON.stringify(paid.structuredContent)).not.toMatch(/0x[0-9a-fA-F]{64}/u);
    await server.close();
  });

  it("refuses to pay from a protected, locked vault and says how to unlock it, without prompting", async () => {
    const home = await walletHome("vapi-mcp-locked-");
    const unlocked = await WalletStore.open(home, { secrets: secretsFor(home), env: {} });
    const account = await unlocked.unlock("main", "");
    await protectVault({
      path: join(home, "vault.json"),
      secrets: secretsFor(home),
      password: VAULT_PASSWORD,
    });
    const { server } = await servedHome(
      home,
      paidResource("5000"),
      { ...NO_PASSWORD_ENVIRONMENT, receiptsPath: join(home, "receipts.jsonl") },
      {
        account,
        passphrase: () => {
          throw new Error("prompted");
        },
      },
    );

    const paid = await server.callTool({
      name: "call.pay",
      arguments: { url: "https://93.184.216.34/paid", wallet: "agent", maxPriceUsd: "0.01" },
    });

    expect(paid.isError).toBe(true);
    const message = JSON.stringify(paid.content);
    expect(message).toContain("vapi vault unlock");
    expect(message).toContain("VAPI_VAULT_PASSWORD");
    expect(message).not.toContain(VAULT_PASSWORD);
    expect(message).not.toContain("prompted");
    await server.close();
  });

  it("keeps reading addresses and balances without any passphrase at all", async () => {
    const home = await walletHome("vapi-mcp-reads-");
    const { server } = await servedHome(home, zeroBalanceFetch(), NO_PASSWORD_ENVIRONMENT);

    const address = await server.callTool({
      name: "wallet.address",
      arguments: { wallet: "agent" },
    });

    expect(address.isError).not.toBe(true);
    expect(address.structuredContent).toMatchObject({ wallet: "agent" });
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

  it("allows account tools by name while their output schemas expose no secret fields", async () => {
    const home = await walletHome("vapi-mcp-account-tool-surface-");
    const { server } = await servedHome(home, zeroBalanceFetch());

    const tools = await server.listTools();
    const accountTools = tools.tools.filter((tool) =>
      ["accounts.add", "accounts.caps", "accounts.send"].includes(tool.name),
    );

    expect(accountTools.map((tool) => tool.name)).toEqual([
      "accounts.add",
      "accounts.caps",
      "accounts.send",
    ]);
    for (const tool of accountTools) {
      const fields = schemaPropertyNames(tool.outputSchema);
      for (const field of FORBIDDEN_RESULT_FIELDS) expect([...fields]).not.toContain(field);
      for (const field of fields) expect(field).not.toMatch(/token|devicecode|phrase|key/iu);
    }
    await server.close();
  });

  it("keeps swarm tool input and output schemas free of secret-like fields", async () => {
    const home = await walletHome("vapi-mcp-swarm-tool-surface-");
    const { server } = await servedHome(home, zeroBalanceFetch());

    const tools = await server.listTools();
    const swarmTools = tools.tools.filter((tool) =>
      ["swarm.run", "swarm.allocate", "swarm.delegate"].includes(tool.name),
    );

    expect(swarmTools.map((tool) => tool.name)).toEqual([
      "swarm.run",
      "swarm.allocate",
      "swarm.delegate",
    ]);
    for (const tool of swarmTools) {
      const fields = new Set([
        ...schemaPropertyNames(tool.inputSchema),
        ...schemaPropertyNames(tool.outputSchema),
      ]);
      for (const field of fields) {
        expect(field).not.toMatch(
          /recovery|phrase|private|secret|passphrase|token|devicecode|key/iu,
        );
      }
    }
    await server.close();
  });

  it("keeps swarm-run results and request bodies free of wallet and link secrets", async () => {
    const fixture = await secretSurfaceSwarmFixture();

    const result = await fixture.server.callTool({
      name: "swarm.run",
      arguments: { name: "team", task: "Finish without exposing credentials" },
    });

    expect(result.isError).not.toBe(true);
    const privateKeys = [0, 1, 2].map((addressIndex) => {
      const privateKey = mnemonicToAccount(TEST_PHRASE, { addressIndex }).getHdKey().privateKey;
      expect(privateKey).not.toBeNull();
      return Buffer.from(privateKey!).toString("hex");
    });
    const forbidden = [
      TEST_PHRASE,
      ...privateKeys,
      ...privateKeys.map((privateKey) => `0x${privateKey}`),
      ROUTER_KEY,
      ACCESS_TOKEN,
      REFRESH_TOKEN,
      DEVICE_CODE,
    ];
    expectNoSecret(JSON.stringify(result), forbidden);
    expect(fixture.requestBodies.length).toBeGreaterThan(0);
    for (const body of fixture.requestBodies) expectNoSecret(body, forbidden);

    await fixture.server.close();
  });

  it("keeps phrase, derived key, device code and link credentials out of results and requests", async () => {
    const untrusted = await secretSurfaceFixture(false);
    const untrustedResult = await untrusted.server.callTool({
      name: "accounts.add",
      arguments: { name: "research", caps: { perDayUsd: 2 } },
    });
    await vi.waitFor(async () => {
      await untrusted.store.reload();
      expect(untrusted.store.entry("research")?.link).toBeDefined();
    });

    const trusted = await secretSurfaceFixture(true);
    const trustedResult = await trusted.server.callTool({
      name: "accounts.add",
      arguments: { name: "research", caps: { perDayUsd: 2 } },
    });

    const derived = mnemonicToAccount(TEST_PHRASE, { addressIndex: 1 });
    const privateKey = derived.getHdKey().privateKey;
    expect(privateKey).not.toBeNull();
    expect(untrustedResult.structuredContent).toMatchObject({ address: derived.address });
    expect(trustedResult.structuredContent).toMatchObject({
      address: derived.address,
      linked: true,
      autoApproved: true,
    });
    const privateKeyHex = Buffer.from(privateKey!).toString("hex");
    const forbidden = [
      ...threeWordWindows(TEST_PHRASE),
      privateKeyHex,
      `0x${privateKeyHex}`,
      DEVICE_CODE,
      ACCESS_TOKEN,
      REFRESH_TOKEN,
      TRUSTED_TOKEN,
      TRUSTED_REFRESH_TOKEN,
    ];
    expectNoSecret(JSON.stringify(untrustedResult), forbidden);
    expectNoSecret(JSON.stringify(trustedResult), forbidden);

    const requests = [...untrusted.requests, ...trusted.requests];
    const authorizationRequests = requests.filter(
      (request) => request.headers.authorization !== undefined,
    );
    expect(authorizationRequests).toHaveLength(1);
    expect(authorizationRequests[0]?.headers.authorization).toBe(`Bearer ${TRUSTED_TOKEN}`);
    expect(new URL(authorizationRequests[0]!.url).origin).toBe(new URL(API_BASE).origin);
    for (const request of requests) {
      const publicHeaders = { ...request.headers };
      delete publicHeaders.authorization;
      expectNoSecret(request.url, forbidden);
      expectNoSecret(JSON.stringify(publicHeaders), forbidden);
      if (new URL(request.url).pathname === "/oauth/token") {
        expect(new URL(request.url).origin).toBe(new URL(API_BASE).origin);
        const fields = [...new URLSearchParams(request.body).entries()];
        expect(fields.map(([name]) => name)).toEqual(["grant_type", "device_code", "client_id"]);
        expect(Object.fromEntries(fields)).toEqual({
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          device_code: DEVICE_CODE,
          client_id: "agent_research",
        });
        for (const [name, value] of fields) {
          if (name === "device_code") {
            expect(value).toBe(DEVICE_CODE);
            expectNoSecret(
              value,
              forbidden.filter((secret) => secret !== DEVICE_CODE),
            );
          } else {
            expectNoSecret(value, forbidden);
          }
        }
      } else {
        expectNoSecret(request.body, forbidden);
      }
    }

    await untrusted.server.close();
    await trusted.server.close();
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

type SecretSurfaceRequest = {
  url: string;
  headers: Record<string, string>;
  body: string;
};

async function secretSurfaceFixture(trusted: boolean) {
  const home = await mkdtemp(join(tmpdir(), "vapi-mcp-secret-behaviour-"));
  temporaryDirectories.push(home);
  const secrets = secretsFor(home);
  const store = await WalletStore.open(home, { secrets, env: {} });
  await store.create("main", "", { phrase: TEST_PHRASE });
  if (trusted) {
    await store.setLink("main", {
      apiBase: API_BASE,
      clientId: "agent_main",
      owner: PAY_TO,
      label: "main",
      scopes: ["mcp:call", "router.use"],
      linkedAt: "2026-09-29T12:00:00.000Z",
    });
    await secrets.set(
      agentSecretAccounts("main").tokens,
      JSON.stringify({
        accessToken: TRUSTED_TOKEN,
        refreshToken: TRUSTED_REFRESH_TOKEN,
        expiresAt: Date.parse("2026-09-29T13:00:00.000Z"),
        scopes: ["mcp:call", "router.use"],
      }),
    );
  }

  const requests: SecretSurfaceRequest[] = [];
  const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    const headers = Object.fromEntries(
      new Headers(
        init?.headers ?? (input instanceof Request ? input.headers : undefined),
      ).entries(),
    );
    const body =
      init?.body === undefined
        ? input instanceof Request
          ? await input.clone().text()
          : ""
        : String(init.body);
    requests.push({ url, headers, body });
    const path = new URL(url).pathname;
    if (path === "/api/auth/siwe-nonce") return Response.json({ nonce: "n".repeat(32) });
    if (path === "/oauth/device_authorization") {
      return Response.json({
        client_id: "agent_research",
        device_code: DEVICE_CODE,
        user_code: "BCDF-GHJK",
        verification_uri: `${API_BASE}/link`,
        verification_uri_complete: `${API_BASE}/link?code=BCDF-GHJK`,
        expires_in: 600,
        interval: 1,
        auto_approved: trusted,
      });
    }
    if (path === "/oauth/token") {
      return Response.json({
        access_token: ACCESS_TOKEN,
        refresh_token: REFRESH_TOKEN,
        expires_in: 3600,
        scope: "mcp:call router.use",
        owner_wallet: PAY_TO,
      });
    }
    if (path === "/api/agents/self") return Response.json({ status: "active" });
    throw new Error(`Unexpected secret-surface request ${url}`);
  });
  const server = createVapiServer({
    account: await store.unlock("main", ""),
    config: getDefaultConfig({}),
    store,
    wallet: "main",
    env: {},
    secretStore: secrets,
    fetchImpl,
    agentLink: { apiBase: API_BASE },
    accounts: {
      hostname: "Secret Surface Host",
      now: () => Date.parse("2026-09-29T12:00:00.000Z"),
      sleep: async () => undefined,
    },
  });
  return { server, store, requests };
}

async function secretSurfaceSwarmFixture() {
  const home = await mkdtemp(join(tmpdir(), "vapi-mcp-swarm-secret-behaviour-"));
  temporaryDirectories.push(home);
  const secrets = secretsFor(home);
  const store = await WalletStore.open(home, { secrets, env: {} });
  await store.create("main", "", { phrase: TEST_PHRASE });
  await setupSwarm({
    home,
    store,
    secrets,
    apiBase: API_BASE,
    name: "team",
    roles: ["lead"],
    strategy: "even",
    surface: "cli",
    env: {},
    hostname: "Secret Surface Host",
    now: () => new Date("2026-09-29T12:00:00.000Z"),
    startDeviceLink: async (args) => ({
      clientId: `agent_${args.label}`,
      deviceCode: DEVICE_CODE,
      userCode: "BCDF-GHJK",
      verificationUri: `${API_BASE}/link`,
      verificationUriComplete: `${API_BASE}/link?code=BCDF-GHJK`,
      expiresIn: 600,
      interval: 1,
      autoApproved: true,
    }),
    pollDeviceLink: async () => ({
      owner: PAY_TO,
      routerKey: ROUTER_KEY,
      routerBaseUrl: "https://router.vapinetwork.ai",
      tokens: {
        accessToken: ACCESS_TOKEN,
        refreshToken: REFRESH_TOKEN,
        expiresAt: Date.parse("2026-09-29T13:00:00.000Z"),
        scopes: ["mcp:call", "router.use"],
      },
    }),
  });

  const requestBodies: string[] = [];
  const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
    const body =
      init?.body === undefined
        ? input instanceof Request
          ? await input.clone().text()
          : ""
        : String(init.body);
    requestBodies.push(body);
    const request = JSON.parse(body) as { id: number; method: string };
    return Response.json({
      jsonrpc: "2.0",
      id: request.id,
      result: request.method === "eth_call" ? `0x${"0".repeat(64)}` : "0x0",
    });
  });
  const routerChat = async (): Promise<ChatResult> => ({
    content: "Finished safely.",
    toolCalls: [],
    model: "router/test",
    keyUsed: "stake",
  });
  const server = createVapiServer({
    account: await store.unlock("main", ""),
    config: getDefaultConfig({}),
    store,
    wallet: "main",
    env: {},
    secretStore: secrets,
    fetchImpl,
    agentLink: { apiBase: API_BASE },
    router: { routerChat },
    ledgerPath: join(home, "spend-ledger.json"),
    receiptsPath: join(home, "receipts.jsonl"),
    searchesPath: join(home, "searches.jsonl"),
  });
  return { server, requestBodies };
}

function threeWordWindows(phrase: string): string[] {
  const words = phrase.split(" ");
  return words.slice(0, -2).map((_, index) => words.slice(index, index + 3).join(" "));
}

function expectNoSecret(value: string, forbidden: string[]): void {
  for (const secret of forbidden) expect(value.toLowerCase()).not.toContain(secret.toLowerCase());
}

/** A home with two wallets: the human's `main` and a tightly capped `agent`. */
async function walletHome(prefix: string): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(home);
  const store = await WalletStore.open(home, { secrets: secretsFor(home) });
  await store.create("main", "");
  await store.create("agent", "", {
    label: "for the agent",
    spendCaps: { perCallAtomic: "10000", perDayAtomic: "20000" },
  });
  return home;
}

async function addressOf(home: string, name: string): Promise<string> {
  const store = await WalletStore.open(home, { secrets: secretsFor(home) });
  return (await store.list()).find((info) => info.name === name)?.address ?? "";
}

async function servedHome(
  home: string,
  fetchImpl: typeof fetch,
  overrides: NodeJS.ProcessEnv & { receiptsPath?: string } = {},
  options: {
    account?: VapiPaymentAccount;
    passphrase?: () => string | Promise<string>;
    secretStore?: SecretStore;
  } = {},
) {
  const { receiptsPath, ...env } = overrides;
  const store = await WalletStore.open(home, { secrets: secretsFor(home), env });
  const account = options.account ?? (await store.unlock("main", ""));
  const config: VapiConfig = getDefaultConfig();
  const server = createVapiServer({
    account,
    config,
    store,
    wallet: undefined,
    env,
    fetchImpl,
    secretStore: options.secretStore ?? secretsFor(home),
    ...(options.passphrase ? { passphrase: options.passphrase } : {}),
    ledgerPath: join(home, "spend-ledger.json"),
    receiptsPath: receiptsPath ?? join(home, "receipts.jsonl"),
    searchesPath: join(home, "searches.jsonl"),
  });
  return { server, store, config };
}

function secretsFor(home: string): SecretStore {
  const existing = secretStores.get(home);
  if (existing !== undefined) return existing;
  const created = secretStoreStub();
  secretStores.set(home, created);
  return created;
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
