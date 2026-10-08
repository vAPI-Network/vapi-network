import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BASE_MAINNET_CAIP2,
  getDefaultConfig,
  type AgentProfile,
  type ChatRequest,
  type ChatResult,
} from "@vapi-network/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { createAgentRunDeps } from "./deps.js";
import { runAgent } from "./run.js";

const PRIVATE_KEY = "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" as Hex;
const EXPECTED_PAY_TO = getAddress("0x1111111111111111111111111111111111111111");
const OTHER_PAYEE = getAddress("0x2222222222222222222222222222222222222222");
const REF = "weather";
const API_URL = "https://93.184.216.34/weather";
const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("agent loop inspection cache", () => {
  it("pins the inspected payee without inspecting twice", async () => {
    const home = await mkdtemp(join(tmpdir(), "vapi-agent-shared-cache-"));
    temporaryDirectories.push(home);
    const config = getDefaultConfig();
    const requests: ChatRequest[] = [];
    const replies = [
      toolReply("search", "call_search", { query: "weather", network: null }),
      toolReply("inspect", "call_inspect", { ref: REF }),
      toolReply("pay", "call_pay", { ref: REF, body: null, max_usd: 0.01 }),
      toolReply("finish", "finish", { answer: "done" }),
    ];
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const request = input instanceof Request ? input : new Request(input);
      const url = new URL(request.url);
      if (url.pathname === "/api/call/discovery") return Response.json(marketplacePage());
      if (url.pathname === "/api/call/services") {
        return Response.json({ services: [service(config.networks[BASE_MAINNET_CAIP2]!.usdc)] });
      }
      if (request.url === API_URL)
        return paymentRequired(config.networks[BASE_MAINNET_CAIP2]!.usdc);
      throw new Error(`Unexpected request to ${request.url}`);
    });
    const deps = createAgentRunDeps({
      profile: profile(),
      config,
      home,
      account: privateKeyToAccount(PRIVATE_KEY),
      wallet: "researcher",
      spendCaps: { perCallAtomic: "50000", perDayAtomic: "1000000" },
      fetchImpl,
      async chat(request) {
        requests.push(structuredClone(request));
        const reply = replies.shift();
        if (reply === undefined) throw new Error("No scripted chat reply remains.");
        return reply;
      },
      approve: vi.fn().mockResolvedValue(false),
    });
    const result = await runAgent("Get the weather", deps);

    expect(result.answer).toBe("done");
    expect(
      fetchImpl.mock.calls.filter(([input]) => requestUrl(input).pathname === "/api/call/services"),
    ).toHaveLength(1);
    const apiRequests = fetchImpl.mock.calls
      .map(([input]) => (input instanceof Request ? input : new Request(input)))
      .filter((request) => request.url === API_URL);
    expect(apiRequests).toHaveLength(1);
    expect(apiRequests[0]!.headers.has("payment-signature")).toBe(false);
    expect(requests[3]!.messages.at(-1)?.content).toContain("call_pay failed.");
  });
});

function profile(): AgentProfile {
  return {
    version: 1,
    name: "researcher",
    wallet: "researcher",
    model: "router/test",
    instructions: "Research carefully.",
    verifiedOnly: true,
    approveAboveUsd: 0.5,
    maxPerTaskUsd: 100,
    autoReleaseBelowUsd: 25,
    maxSteps: 6,
    tools: ["call.search", "call.inspect", "call.pay"],
    grants: [],
    paused: false,
    createdAt: "2026-09-29T00:00:00.000Z",
  };
}

function marketplacePage() {
  return {
    protocol: "vapi.marketplace.discovery/1",
    items: [
      {
        ref: REF,
        kind: "api",
        provenance: "indexed",
        verification: "verified",
        execution: {
          mode: "direct",
          url: API_URL,
          method: "POST",
          network: BASE_MAINNET_CAIP2,
        },
        card: {
          title: "Weather",
          summary: "Current weather.",
          badges: [],
          facts: [{ label: "Price", value: "$0.0025" }],
        },
        action: { type: "invoke_api", href: "/call/weather" },
      },
    ],
    nextCursor: null,
    unavailableKinds: [],
    rankingVersion: "marketplace-ranking-v1",
  };
}

function service(asset: string) {
  return {
    id: REF,
    name: "Weather",
    description: "Current weather.",
    category: "data",
    tier: "listed",
    verification: "verified",
    verified: true,
    wrapped: false,
    price: "$0.0025",
    networks: [BASE_MAINNET_CAIP2],
    endpoints: [
      {
        name: "weather",
        method: "POST",
        url: API_URL,
        price: "$0.0025",
        description: "Current weather.",
        payment: {
          scheme: "exact",
          network: BASE_MAINNET_CAIP2,
          asset,
          payTo: EXPECTED_PAY_TO,
          checkedAt: "2026-09-29T00:00:00.000Z",
        },
      },
    ],
  };
}

function paymentRequired(asset: string): Response {
  return Response.json(
    {
      x402Version: 2,
      resource: { url: API_URL },
      accepts: [
        {
          scheme: "exact",
          network: BASE_MAINNET_CAIP2,
          amount: "2500",
          asset,
          payTo: OTHER_PAYEE,
          maxTimeoutSeconds: 60,
          extra: { name: "USD Coin", version: "2" },
        },
      ],
    },
    { status: 402 },
  );
}

function toolReply(id: string, name: string, args: Record<string, unknown>): ChatResult {
  return {
    content: null,
    toolCalls: [{ id, name, arguments: JSON.stringify(args) }],
    model: "router/test",
    keyUsed: "stake",
  };
}

function requestUrl(input: Parameters<typeof fetch>[0]): URL {
  return new URL(input instanceof Request ? input.url : input.toString());
}
