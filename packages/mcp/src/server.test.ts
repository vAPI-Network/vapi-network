import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  getDefaultConfig,
  type MarketplaceDiscoveryPage,
  type MarketplaceHit,
} from "@vapi-network/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { createVapiServer } from "./server.js";

const PRIVATE_KEY = "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" as Hex;
const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Agent Cash MCP marketplace tools", () => {
  it("registers inspect as the free request-contract step before call", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const { client, server } = await connectedServer(fetchImpl);

    const tools = await client.listTools();

    expect(tools.tools.map((tool) => tool.name)).toEqual([
      "call.search",
      "search",
      "call.inspect",
      "inspect",
      "call.pay",
      "call",
      "wallet.address",
      "wallet.balance",
      "wallet.accounts",
      "wallet",
      "receipts.list",
      "receipts.stats",
      "support.report",
    ]);
    const inspect = tools.tools.find((tool) => tool.name === "call.inspect");
    expect(inspect?.description).toContain("for free");
    expect(inspect?.description).toContain("before call");

    await client.close();
    await server.close();
  });

  it("keeps deprecated aliases behavior-compatible and emits one deprecation line", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json(marketplacePage([workHit("research-brief")])));
    const { client, server } = await connectedServer(fetchImpl);

    const result = await client.callTool({ name: "search", arguments: { query: "research" } });
    const text = (result.content as Array<{ type: string; text?: string }>)[0]?.text ?? "";

    expect(result.isError).not.toBe(true);
    expect(text.split("\n")[0]).toBe(
      "DEPRECATED: use call.search; this alias will be removed in a later release.",
    );
    expect(result.structuredContent).toEqual(marketplacePage([workHit("research-brief")]));

    await client.close();
    await server.close();
  });

  it.each([
    ["inspect", "call.inspect", {}],
    ["call", "call.pay", {}],
    ["wallet", "wallet.balance", {}],
  ] as const)("marks every %s alias result as deprecated", async (name, replacement, args) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json(marketplacePage([])));
    const { client, server } = await connectedServer(fetchImpl);

    const result = await client.callTool({ name, arguments: args });
    const text = (result.content as Array<{ type: string; text?: string }>)[0]?.text ?? "";

    expect(text.split("\n")[0]).toBe(
      `DEPRECATED: use ${replacement}; this alias will be removed in a later release.`,
    );
    await client.close();
    await server.close();
  });

  it("records calls in the same ledger exposed by receipts.list", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ ok: true }));
    const { client, server } = await connectedServer(fetchImpl);

    const callResult = await client.callTool({
      name: "call.pay",
      arguments: { url: "https://93.184.216.34/free" },
    });
    const receiptsResult = await client.callTool({ name: "receipts.list" });

    expect(callResult.isError).not.toBe(true);
    expect(receiptsResult.structuredContent).toMatchObject({
      receipts: [
        {
          resourceUrl: "https://93.184.216.34/free",
          status: 200,
          source: "direct",
          outcome: "paid",
          listing: { providerHost: "93.184.216.34", source: "direct" },
          policy: { capsApplied: false },
          client: { name: "vapi-network", version: "0.2.0-dev.3" },
        },
      ],
    });

    const statsResult = await client.callTool({ name: "receipts.stats" });
    expect(statsResult.structuredContent).toMatchObject({
      range: "24h",
      totals: { spendUsd: "0", calls: 1, uniqueApis: 1, policyDeclines: 0 },
      search: { count: 0, zeroResultRate: 0 },
    });
    await client.close();
    await server.close();
  });

  it("lists configured accounts with deposit guidance", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const body = init?.body ?? (input instanceof Request ? await input.clone().text() : "");
      const request = JSON.parse(String(body)) as { id: number; method: string };
      return Response.json({
        jsonrpc: "2.0",
        id: request.id,
        result: request.method === "eth_call" ? `0x${"0".repeat(64)}` : "0x0",
      });
    });
    const { client, server } = await connectedServer(fetchImpl);

    const result = await client.callTool({ name: "wallet.accounts" });

    expect(result.isError).not.toBe(true);
    expect(
      (result.structuredContent as { accounts: Array<{ error?: string }> }).accounts[0]?.error,
    ).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      accounts: [
        {
          caip2: "eip155:8453",
          name: "Base mainnet",
          usdcBalance: { atomic: "0", formatted: "0" },
          gasTokenBalance: { symbol: "ETH", atomic: "0", formatted: "0" },
          depositInstructions: expect.stringContaining("Send USDC on Base"),
        },
      ],
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    await client.close();
    await server.close();
  });

  it("writes support reports locally without sending by default", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vapi-mcp-report-"));
    temporaryDirectories.push(directory);
    const fetchImpl = vi.fn<typeof fetch>();
    const server = createVapiServer({
      account: privateKeyToAccount(PRIVATE_KEY),
      config: getDefaultConfig(),
      fetchImpl,
      receiptsPath: join(directory, "receipts.jsonl"),
      reportsDirectory: join(directory, "reports"),
    });

    const result = await server.callTool({
      name: "support.report",
      arguments: { message: "payment failed" },
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      issueUrl: expect.stringContaining("title=payment%20failed"),
      report: { message: "payment failed", receiptIds: [] },
    });
    const path = (result.structuredContent as { path: string }).path;
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ message: "payment failed" });
    expect(fetchImpl).not.toHaveBeenCalled();
    await server.close();
  });

  it("searches all marketplace kinds and refuses to call a cached Work result", async () => {
    const page = {
      protocol: "vapi.marketplace.discovery/1",
      items: [
        {
          ref: "research-brief",
          kind: "service_offer",
          card: {
            title: "Research brief",
            summary: "Evidence-backed market research.",
            badges: [],
            facts: [],
          },
          action: { type: "start_engagement", href: "/work/listings/research-brief" },
        },
      ],
      nextCursor: null,
      unavailableKinds: [],
      rankingVersion: "marketplace-ranking-v1",
    };
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify(page), { status: 200 }));
    const server = createVapiServer({
      account: privateKeyToAccount(PRIVATE_KEY),
      config: getDefaultConfig(),
      fetchImpl,
    });
    const client = server;

    const searchResult = await client.callTool({
      name: "search",
      arguments: { query: "research", kinds: ["service_offer"] },
    });
    expect(searchResult.isError).not.toBe(true);
    expect(JSON.stringify(searchResult.content)).toContain("research-brief");
    expect(searchResult.structuredContent).toEqual(page);

    const callResult = await client.callTool({
      name: "call",
      arguments: { id: "research-brief" },
    });
    expect(callResult.isError).toBe(true);
    expect(JSON.stringify(callResult.content)).toContain("only invokes API marketplace results");
    expect(fetchImpl).toHaveBeenCalledOnce();

    await client.close();
    await server.close();
  });

  it("retains source-bound external execution metadata across later searches", async () => {
    const external = externalApiHit("https://93.184.216.34/weather");
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(marketplacePage([external])))
      .mockResolvedValueOnce(Response.json(marketplacePage([workHit("research-brief")])));
    const { client, server } = await connectedServer(fetchImpl);

    await client.callTool({ name: "search", arguments: { query: "weather" } });
    await client.callTool({ name: "search", arguments: { query: "research" } });
    const callResult = await client.callTool({
      name: "call",
      arguments: { id: external.ref, network: "eip155:5042002" },
    });

    expect(callResult.isError).toBe(true);
    expect(JSON.stringify(callResult.content)).toContain(
      "registered endpoint requires eip155:8453",
    );
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    await client.close();
    await server.close();
  });

  it("replaces a repeated source snapshot without discarding its ref", async () => {
    const ref = "https://93.184.216.34/weather";
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(marketplacePage([externalApiHit(ref)])))
      .mockResolvedValueOnce(
        Response.json(marketplacePage([externalApiHit(ref, "eip155:5042002")])),
      );
    const { client, server } = await connectedServer(fetchImpl);

    await client.callTool({ name: "search", arguments: { query: "weather" } });
    await client.callTool({ name: "search", arguments: { query: "weather" } });
    const callResult = await client.callTool({
      name: "call",
      arguments: { id: ref, network: "eip155:8453" },
    });

    expect(callResult.isError).toBe(true);
    expect(JSON.stringify(callResult.content)).toContain(
      "registered endpoint requires eip155:5042002",
    );
    expect(JSON.stringify(callResult.content)).not.toContain("ambiguous");
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    await client.close();
    await server.close();
  });

  it("fails closed when searches return different result sources for one ref", async () => {
    const ref = "shared-ref";
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(marketplacePage([externalApiHit(ref)])))
      .mockResolvedValueOnce(Response.json(marketplacePage([nativeApiHit(ref)])));
    const { client, server } = await connectedServer(fetchImpl);

    await client.callTool({ name: "search", arguments: { query: "external" } });
    await client.callTool({ name: "search", arguments: { query: "native" } });
    const callResult = await client.callTool({ name: "call", arguments: { id: ref } });

    expect(callResult.isError).toBe(true);
    expect(JSON.stringify(callResult.content)).toContain(
      "ambiguous across result sources or kinds",
    );
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    await client.close();
    await server.close();
  });

  it("never falls back to legacy Calls resolution for an uncached external ref", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const { client, server } = await connectedServer(fetchImpl);

    const callResult = await client.callTool({
      name: "call",
      arguments: { id: "weather-api" },
    });

    expect(callResult.isError).toBe(true);
    expect(JSON.stringify(callResult.content)).toContain(
      "is not retained by this vAPI process; run call.search again",
    );
    expect(fetchImpl).not.toHaveBeenCalled();

    await client.close();
    await server.close();
  });

  it("evicts whole ref groups and keeps an evicted external ref fail-closed", async () => {
    const pages = Array.from({ length: 5 }, (_, pageIndex) =>
      marketplacePage(
        Array.from({ length: 50 }, (_, itemIndex) =>
          externalApiHit(`external-${pageIndex}-${itemIndex}`),
        ),
      ),
    );
    const fetchImpl = vi.fn<typeof fetch>();
    for (const page of pages) {
      fetchImpl.mockResolvedValueOnce(Response.json(page));
    }
    const { client, server } = await connectedServer(fetchImpl);

    for (let pageIndex = 0; pageIndex < pages.length; pageIndex += 1) {
      await client.callTool({
        name: "search",
        arguments: { query: `page ${pageIndex}` },
      });
    }
    const callResult = await client.callTool({
      name: "call",
      arguments: { id: pages[0]!.items[0]!.ref },
    });

    expect(callResult.isError).toBe(true);
    expect(JSON.stringify(callResult.content)).toContain(
      "is not retained by this vAPI process; run call.search again",
    );
    expect(fetchImpl).toHaveBeenCalledTimes(5);

    await client.close();
    await server.close();
  });

  it("serializes confirmed settlement separately when the paid body is unreadable", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vapi-mcp-server-"));
    temporaryDirectories.push(directory);
    const config = getDefaultConfig();
    const settlement = { success: true, transaction: `0x${"77".repeat(32)}` };
    const challenge = {
      x402Version: 2,
      resource: { url: "https://93.184.216.34/paid" },
      accepts: [
        {
          scheme: "exact",
          network: "eip155:8453",
          amount: "2500",
          asset: config.networks["eip155:8453"]!.usdc,
          payTo: "0x1111111111111111111111111111111111111111",
          maxTimeoutSeconds: 60,
          extra: { name: "USD Coin", version: "2" },
        },
      ],
    };
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json(challenge, {
          status: 402,
        }),
      )
      .mockResolvedValueOnce(
        new Response("provider body", {
          status: 200,
          headers: {
            "content-length": "1048577",
            "payment-response": Buffer.from(JSON.stringify(settlement), "utf8").toString("base64"),
          },
        }),
      );
    const server = createVapiServer({
      account: privateKeyToAccount(PRIVATE_KEY),
      config,
      fetchImpl,
      ledgerPath: join(directory, "ledger.json"),
      receiptsPath: join(directory, "receipts.jsonl"),
    });
    const client = server;

    const callResult = await client.callTool({
      name: "call",
      arguments: { url: "https://93.184.216.34/paid" },
    });

    const serialized = JSON.stringify(callResult.content);
    expect(callResult.isError).toBe(true);
    expect(serialized).toContain("response_unreadable");
    expect(serialized).toContain("confirmedSettlement");
    expect(serialized).not.toContain("possibleSettlement");
    expect(serialized).toContain(settlement.transaction);
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    await client.close();
    await server.close();
  });
});

async function connectedServer(fetchImpl: typeof fetch) {
  const directory = await mkdtemp(join(tmpdir(), "vapi-mcp-server-"));
  temporaryDirectories.push(directory);
  const server = createVapiServer({
    account: privateKeyToAccount(PRIVATE_KEY),
    config: getDefaultConfig(),
    fetchImpl,
    ledgerPath: join(directory, "ledger.json"),
    receiptsPath: join(directory, "receipts.jsonl"),
    searchesPath: join(directory, "searches.jsonl"),
  });
  const client = server;
  return { client, server };
}

function marketplacePage(items: MarketplaceHit[]): MarketplaceDiscoveryPage {
  return {
    protocol: "vapi.marketplace.discovery/1",
    items,
    nextCursor: null,
    unavailableKinds: [],
    rankingVersion: "marketplace-ranking-v1",
  };
}

function externalApiHit(ref: string, network = "eip155:8453"): MarketplaceHit {
  return {
    ref,
    kind: "api",
    provenance: "indexed",
    execution: {
      mode: "direct",
      url: "https://93.184.216.34/weather",
      method: "POST",
      network,
    },
    card: {
      title: "External weather API",
      summary: "Weather from the external catalog.",
      badges: [{ code: "external_catalog", label: "External catalog" }],
      facts: [],
    },
    action: { type: "invoke_api", href: "/call/invoke" },
  };
}

function nativeApiHit(ref: string): MarketplaceHit {
  return {
    ref,
    kind: "api",
    provenance: "self_listed",
    execution: { mode: "direct" },
    card: {
      title: "Native weather API",
      summary: "Weather from a registered provider.",
      badges: [],
      facts: [],
    },
    action: { type: "invoke_api", href: `/call/${ref}` },
  };
}

function workHit(ref: string): MarketplaceHit {
  return {
    ref,
    kind: "service_offer",
    card: {
      title: "Research brief",
      summary: "Evidence-backed market research.",
      badges: [],
      facts: [],
    },
    action: { type: "start_engagement", href: `/work/listings/${ref}` },
  };
}
