import type { VapiPaymentAccount } from "@vapi-network/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  searchMarketplace: vi.fn(),
  inspectService: vi.fn(),
  callService: vi.fn(),
}));

vi.mock("../tools/search.js", () => ({ searchMarketplace: mocks.searchMarketplace }));
vi.mock("../tools/inspect.js", () => ({ inspectService: mocks.inspectService }));
vi.mock("../tools/call.js", () => ({ callService: mocks.callService }));

import { createAgentRunDeps } from "./deps.js";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("createAgentRunDeps", () => {
  it("maps marketplace rows and keeps only exact six-decimal USDC prices", async () => {
    mocks.searchMarketplace.mockResolvedValue({
      items: [
        hit("exact", "$0.010001"),
        hit("variable", "Variable"),
        hit("too-precise", "$0.0000001"),
      ],
    });
    const deps = createAgentRunDeps(input());

    await expect(
      deps.search({ query: "weather", network: "eip155:8453", includeUnverified: true }),
    ).resolves.toEqual([
      {
        ref: "exact",
        name: "exact name",
        priceUsd: 0.010001,
        verification: "verified",
        description: "exact description",
      },
      {
        ref: "variable",
        name: "variable name",
        priceUsd: null,
        verification: "verified",
        description: "variable description",
      },
      {
        ref: "too-precise",
        name: "too-precise name",
        priceUsd: null,
        verification: "verified",
        description: "too-precise description",
      },
    ]);
    expect(mocks.searchMarketplace).toHaveBeenCalledWith(
      { query: "weather", network: "eip155:8453", includeUnverified: true },
      expect.any(Object),
      undefined,
      expect.objectContaining({ searchesPath: "/tmp/vapi-agent-deps/searches.jsonl" }),
    );
  });

  it("pins the inspected payee and strips payment material from the pay result", async () => {
    const inspected = {
      name: "Weather",
      method: "POST",
      url: "https://weather.example/call",
      price: "$0.01",
      description: "Forecasts.",
      verification: "verified",
      payment: {
        scheme: "exact",
        network: "eip155:8453",
        asset: "0x1111111111111111111111111111111111111111",
        payTo: "0x2222222222222222222222222222222222222222",
        checkedAt: "2026-09-23T00:00:00.000Z",
      },
    };
    mocks.inspectService.mockResolvedValue(inspected);
    mocks.callService.mockResolvedValue({
      status: 201,
      body: { forecast: "sunny" },
      payment: {
        network: "eip155:8453",
        amountAtomic: "10000",
        amountUsd: "0.01",
        asset: "0x1111111111111111111111111111111111111111",
        payTo: "0x2222222222222222222222222222222222222222",
        settlement: { transaction: "0xsecret-settlement" },
        proof: "secret-proof",
      },
    });
    const deps = createAgentRunDeps(input());

    await deps.inspect("weather");
    await expect(
      deps.pay({ ref: "weather", body: { city: "Amsterdam" }, maxPriceUsd: 0.01 }),
    ).resolves.toEqual({
      ok: true,
      status: 201,
      body: { forecast: "sunny" },
      amountUsd: 0.01,
      network: "eip155:8453",
    });
    expect(mocks.callService).toHaveBeenCalledWith(
      expect.objectContaining({
        input: {
          id: "weather",
          body: { city: "Amsterdam" },
          maxPriceUsd: 0.01,
          expectedPayTo: "0x2222222222222222222222222222222222222222",
        },
        ledgerPath: "/tmp/vapi-agent-deps/spend-ledger.json",
        receiptsPath: "/tmp/vapi-agent-deps/receipts.jsonl",
        wallet: "researcher",
        spendCaps: { perCallAtomic: "50000", perDayAtomic: "1000000" },
      }),
    );
    expect(deps.caps.perCallUsd).toBe(0.05);
  });
});

function input(): Parameters<typeof createAgentRunDeps>[0] {
  return {
    profile: {
      version: 1,
      name: "researcher",
      wallet: "researcher",
      model: "router/test",
      instructions: "Research carefully.",
      verifiedOnly: true,
      approveAboveUsd: 0.5,
      maxSteps: 12,
      tools: ["call.search", "call.inspect", "call.pay"],
      paused: false,
      createdAt: "2026-09-23T00:00:00.000Z",
    },
    config: {
      discoveryUrl: "https://api.vapinetwork.ai/api/call/services",
      marketplaceDiscoveryUrl: "https://api.vapinetwork.ai/api/call/discovery",
      networks: {},
      spendCaps: { perCallAtomic: "50000", perDayAtomic: "1000000" },
    },
    home: "/tmp/vapi-agent-deps",
    account: {
      address: "0x3333333333333333333333333333333333333333",
    } as unknown as VapiPaymentAccount,
    wallet: "researcher",
    spendCaps: { perCallAtomic: "50000", perDayAtomic: "1000000" },
    chat: vi.fn(),
    approve: vi.fn().mockResolvedValue(false),
  };
}

function hit(ref: string, price: string) {
  return {
    ref,
    kind: "api",
    provenance: "self_listed",
    execution: { mode: "direct" },
    card: {
      title: `${ref} name`,
      summary: `${ref} description`,
      badges: [],
      facts: [{ label: "Price", value: price }],
    },
    verification: "verified",
    action: { type: "invoke_api", href: `/call/${ref}` },
  };
}
