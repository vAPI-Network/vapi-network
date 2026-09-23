import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BASE_MAINNET_CAIP2,
  WalletStore,
  createKeystoreFromPrivateKey,
  getDefaultConfig,
  getVapiPaths,
  writeAgentProfile,
  type AgentLink,
  type SecretStore,
  type SpendCaps,
} from "@vapi-network/core";
import { agentSecretAccounts } from "@vapi-network/core/agent-link";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createVapiClient } from "./client.js";

const PRIVATE_KEY = "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const PASSPHRASE = "test-only-passphrase";
const PAY_TO = "0x1111111111111111111111111111111111111111";
const OWNER = "0x2222222222222222222222222222222222222222";
const ROUTER_KEY = "sk-test-router-key";
const NOT_LINKED = "Not linked. Run vapi login on this machine, or set VAPI_HOME to a linked home.";
const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("createVapiClient", () => {
  it("returns the linked wallet's Router base URL and stored key", async () => {
    const home = await registryHome({ link: agentLink() });
    const account = await externalAccount(home);
    const secrets = memorySecretStore({
      [agentSecretAccounts("main").routerStake]: ROUTER_KEY,
    });
    const client = await createVapiClient({ account, home, secretStore: secrets, env: {} });

    await expect(client.router.openai()).resolves.toEqual({
      baseURL: "https://router.example/gateway/v1",
      apiKey: ROUTER_KEY,
    });
    expect(client.wallet).toEqual({ name: "main", address: account.address, owner: OWNER });
  });

  it("reloads the selected wallet's caps before every payment", async () => {
    const home = await registryHome({
      spendCaps: { perCallAtomic: "10000", perDayAtomic: "1000000" },
    });
    const account = await externalAccount(home);
    const sign = vi.spyOn(account, "signTypedData");
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(paymentRequired());
    const client = await createVapiClient({ account, home, fetch: fetchImpl, env: {} });
    const capsWriter = await WalletStore.open(home);
    await capsWriter.setSpendCaps("main", {
      perCallAtomic: "1000",
      perDayAtomic: "1000",
    });

    await expect(
      client.call.pay({ url: "https://93.184.216.34/weather", method: "GET" }),
    ).rejects.toThrow(/per-call cap/i);
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(sign).not.toHaveBeenCalled();
    await expect(stat(getVapiPaths(home).ledger)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("uses an injected account without a local wallet registry or keystore", async () => {
    const home = await temporaryHome();
    const account = await externalAccount(home);
    const sign = vi.spyOn(account, "signTypedData");
    const unlock = vi.spyOn(WalletStore.prototype, "unlock");
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(paymentRequired())
      .mockResolvedValueOnce(Response.json({ paid: true }));
    const client = await createVapiClient({ account, home, fetch: fetchImpl, env: {} });

    expect(client.wallet).toEqual({ name: "main", address: account.address, owner: null });
    expect((await WalletStore.open(home)).hasRegistry()).toBe(false);

    await expect(
      client.call.pay({
        url: "https://93.184.216.34/weather",
        method: "GET",
        maxPriceUsd: 0.01,
      }),
    ).resolves.toMatchObject({ body: { paid: true } });
    expect(sign).toHaveBeenCalledOnce();
    expect(unlock).not.toHaveBeenCalled();
  });

  it("unlocks the local keystore lazily and only once per client", async () => {
    const home = await temporaryHome();
    const store = await WalletStore.open(home);
    await store.create("main", PASSPHRASE);
    const unlock = vi.spyOn(WalletStore.prototype, "unlock");
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => Response.json({ free: true }, { status: 200 }));
    const client = await createVapiClient({
      home,
      passphrase: PASSPHRASE,
      fetch: fetchImpl,
      env: {},
    });

    expect(unlock).not.toHaveBeenCalled();
    await client.call.pay({ url: "https://93.184.216.34/one", method: "GET" });
    await client.call.pay({ url: "https://93.184.216.34/two", method: "GET" });
    expect(unlock).toHaveBeenCalledOnce();
  });

  it("declines an above-threshold agent payment by default", async () => {
    const home = await registryHome({
      link: agentLink(),
      spendCaps: { perCallAtomic: "1000000", perDayAtomic: "2000000" },
    });
    await writeAgentProfile(home, {
      version: 1,
      name: "researcher",
      wallet: "main",
      model: "router/test",
      instructions: "Research carefully.",
      verifiedOnly: true,
      approveAboveUsd: 0.5,
      maxSteps: 4,
      tools: ["call.search", "call.inspect", "call.pay"],
      paused: false,
      createdAt: "2026-09-23T00:00:00.000Z",
    });
    const account = await externalAccount(home);
    const secrets = memorySecretStore({
      [agentSecretAccounts("main").routerStake]: ROUTER_KEY,
    });
    const endpointCalls: string[] = [];
    let chatRound = 0;
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      endpointCalls.push(url.href);
      if (url.hostname === "router.example") {
        chatRound += 1;
        if (chatRound === 1) {
          return chatToolReply("search", "call_search", {
            query: "base dex volume",
            network: null,
          });
        }
        if (chatRound === 2) {
          return chatToolReply("pay", "call_pay", {
            ref: "dex-volume",
            body: null,
            max_usd: 1,
          });
        }
        return chatToolReply("finish", "finish", { answer: "Payment declined." });
      }
      if (url.pathname === "/api/call/discovery") return marketplacePage();
      if (url.pathname === "/api/call/services") return servicePage();
      throw new Error(`Unexpected request to ${url.href}`);
    });
    const events: Array<{ type: string }> = [];
    const client = await createVapiClient({
      account,
      home,
      secretStore: secrets,
      fetch: fetchImpl,
      env: {},
    });

    const result = await client.agent.run("researcher", "Summarise Base DEX volume", {
      onEvent: (event) => events.push(event),
    });

    expect(result.answer).toBe("Payment declined.");
    expect(events).toContainEqual(expect.objectContaining({ type: "declined", ref: "dex-volume" }));
    expect(endpointCalls).not.toContain("https://93.184.216.34/paid");
  });

  it("rejects every Router method and agent runs for an unlinked injected account", async () => {
    const home = await registryHome();
    await writeAgentProfile(home, {
      version: 1,
      name: "researcher",
      wallet: "main",
      model: "router/test",
      instructions: "Research carefully.",
      verifiedOnly: true,
      approveAboveUsd: 0.5,
      maxSteps: 4,
      tools: ["call.search", "call.inspect", "call.pay"],
      paused: false,
      createdAt: "2026-09-23T00:00:00.000Z",
    });
    const client = await createVapiClient({
      account: await externalAccount(home),
      home,
      secretStore: memorySecretStore(),
      fetch: vi.fn<typeof fetch>(),
      env: {},
    });

    await expect(client.router.models()).rejects.toThrow(NOT_LINKED);
    await expect(client.router.usage()).rejects.toThrow(NOT_LINKED);
    await expect(
      client.router.chat({ model: "router/test", messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toThrow(NOT_LINKED);
    await expect(client.router.openai()).rejects.toThrow(NOT_LINKED);
    await expect(client.agent.run("researcher", "Do work")).rejects.toThrow(NOT_LINKED);
  });
});

type MemorySecretStore = SecretStore & { entries: Record<string, string> };

function memorySecretStore(initial: Record<string, string> = {}): MemorySecretStore {
  const entries = { ...initial };
  return {
    available: true,
    platform: "darwin",
    description: "the test keychain",
    entries,
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

function agentLink(): AgentLink {
  return {
    apiBase: "https://api.vapinetwork.ai",
    clientId: `agent_${OWNER.toLowerCase()}`,
    owner: OWNER,
    label: "main",
    scopes: ["mcp:call", "router.use"],
    linkedAt: "2026-09-23T10:00:00.000Z",
    routerBaseUrl: "https://router.example/gateway",
  };
}

async function registryHome(
  options: { spendCaps?: SpendCaps; link?: AgentLink } = {},
): Promise<string> {
  const home = await temporaryHome();
  await writeFile(
    join(home, "wallets.json"),
    `${JSON.stringify(
      {
        version: 1,
        default: "main",
        wallets: {
          main: {
            createdAt: "2026-09-23T09:00:00.000Z",
            spendCaps: options.spendCaps ?? {
              perCallAtomic: "100000",
              perDayAtomic: "1000000",
            },
            ...(options.link === undefined ? {} : { link: options.link }),
          },
        },
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  return home;
}

async function temporaryHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "vapi-client-"));
  temporaryDirectories.push(home);
  return home;
}

async function externalAccount(home: string) {
  return await createKeystoreFromPrivateKey(PASSPHRASE, join(home, "external-account.json"), {
    privateKey: PRIVATE_KEY,
  });
}

function paymentRequired(): Response {
  const config = getDefaultConfig();
  return Response.json(
    {
      x402Version: 2,
      resource: { url: "https://93.184.216.34/weather" },
      accepts: [
        {
          scheme: "exact",
          network: BASE_MAINNET_CAIP2,
          amount: "2500",
          asset: config.networks[BASE_MAINNET_CAIP2]!.usdc,
          payTo: PAY_TO,
          maxTimeoutSeconds: 60,
          extra: { name: "USD Coin", version: "2" },
        },
      ],
    },
    { status: 402 },
  );
}

function chatToolReply(id: string, name: string, args: Record<string, unknown>): Response {
  return Response.json({
    model: "router/test",
    choices: [
      {
        message: {
          content: null,
          tool_calls: [
            { id, type: "function", function: { name, arguments: JSON.stringify(args) } },
          ],
        },
      },
    ],
  });
}

function marketplacePage(): Response {
  return Response.json({
    protocol: "vapi.marketplace.discovery/1",
    items: [
      {
        ref: "dex-volume",
        kind: "api",
        provenance: "self_listed",
        verification: "verified",
        execution: { mode: "direct" },
        card: {
          title: "DEX volume",
          summary: "Current Base DEX volume.",
          badges: [],
          facts: [{ label: "Price", value: "$0.80" }],
        },
        action: { type: "invoke_api", href: "/call/dex-volume" },
      },
    ],
    nextCursor: null,
    unavailableKinds: [],
    rankingVersion: "test-ranking",
  });
}

function servicePage(): Response {
  return Response.json({
    services: [
      {
        id: "dex-volume",
        name: "DEX volume",
        description: "Current Base DEX volume.",
        category: "data",
        tier: "verified",
        verification: "verified",
        verified: true,
        wrapped: false,
        price: "$0.80",
        networks: [BASE_MAINNET_CAIP2],
        endpoints: [
          {
            name: "volume",
            method: "GET",
            url: "https://93.184.216.34/paid",
            price: "$0.80",
            description: "Current Base DEX volume.",
          },
        ],
      },
    ],
  });
}
