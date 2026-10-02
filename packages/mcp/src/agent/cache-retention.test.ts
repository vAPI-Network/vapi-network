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

describe("agent marketplace lookups", () => {
  it("can pay an earlier result after more than 200 distinct searches", async () => {
    let nextRef = 0;
    mocks.searchMarketplace.mockImplementation(async () => ({
      items: [hit(`service-${nextRef++}`)],
    }));
    mocks.callService.mockResolvedValue({
      status: 200,
      body: { ok: true },
      payment: null,
    });
    const deps = createAgentRunDeps(input());

    for (let index = 0; index < 201; index += 1) {
      await deps.search({ query: `service-${index}`, includeUnverified: false });
    }

    await expect(deps.pay({ ref: "service-0", maxPriceUsd: 0.01 })).resolves.toMatchObject({
      status: 200,
      body: { ok: true },
    });
    expect(mocks.callService).toHaveBeenCalledOnce();
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
      grants: [],
      paused: false,
      createdAt: "2026-09-29T00:00:00.000Z",
    },
    config: {
      discoveryUrl: "https://api.vapinetwork.ai/api/call/services",
      marketplaceDiscoveryUrl: "https://api.vapinetwork.ai/api/call/discovery",
      networks: {},
      spendCaps: { perCallAtomic: "50000", perDayAtomic: "1000000" },
    },
    home: "/tmp/vapi-agent-cache-retention",
    account: {
      address: "0x3333333333333333333333333333333333333333",
    } as unknown as VapiPaymentAccount,
    wallet: "researcher",
    spendCaps: { perCallAtomic: "50000", perDayAtomic: "1000000" },
    chat: vi.fn(),
    approve: vi.fn().mockResolvedValue(false),
  };
}

function hit(ref: string) {
  return {
    ref,
    kind: "api",
    provenance: "self_listed",
    execution: { mode: "direct" },
    card: {
      title: `${ref} name`,
      summary: `${ref} description`,
      badges: [],
      facts: [{ label: "Price", value: "$0.01" }],
    },
    verification: "verified",
    action: { type: "invoke_api", href: `/call/${ref}` },
  };
}
