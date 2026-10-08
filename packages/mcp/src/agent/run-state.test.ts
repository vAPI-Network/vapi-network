import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getDefaultConfig, type AgentProfile, type ChatResult } from "@vapi-network/core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { runAgent, type RunAgentDeps } from "./run.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("agent run state", () => {
  it("does not reuse search authorization or inspections across runs", async () => {
    const home = await mkdtemp(join(tmpdir(), "vapi-agent-run-state-"));
    temporaryDirectories.push(home);
    const replies = [
      toolReply("search-1", "call_search", { query: "weather", network: null }),
      toolReply("pay-1", "call_pay", { ref: "weather", body: null, max_usd: 0.01 }),
      toolReply("finish-1", "finish", { answer: "first" }),
      toolReply("pay-2", "call_pay", { ref: "weather", body: null, max_usd: 0.01 }),
      toolReply("finish-2", "finish", { answer: "second" }),
    ];
    const inspect = vi.fn(async () => inspected());
    const pay = vi.fn(async () => ({
      ok: true,
      status: 200,
      body: { forecast: "sunny" },
      amountUsd: 0.01,
      network: "eip155:8453",
    }));
    const approve = vi.fn(async () => false);
    const deps: RunAgentDeps = {
      profile: profile(),
      config: getDefaultConfig(),
      home,
      async chat() {
        const reply = replies.shift();
        if (reply === undefined) throw new Error("No scripted reply remains.");
        return reply;
      },
      async search() {
        return [
          {
            ref: "weather",
            name: "Weather",
            priceUsd: 0.01,
            verification: "verified",
          },
        ];
      },
      async inspect() {
        const result = await inspect();
        return result;
      },
      pay,
      caps: { perCallUsd: 1 },
      approve,
    };

    await expect(runAgent("First task", deps)).resolves.toMatchObject({ answer: "first" });
    await expect(runAgent("Second task", deps)).resolves.toMatchObject({ answer: "second" });

    expect(inspect).toHaveBeenCalledTimes(2);
    expect(approve).toHaveBeenCalledOnce();
    expect(approve).toHaveBeenCalledWith({
      ref: "weather",
      priceUsd: 0.01,
      reason: "weather was not found by call_search in this run.",
    });
    expect(pay).toHaveBeenCalledOnce();
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
    maxSteps: 4,
    tools: ["call.search", "call.inspect", "call.pay"],
    grants: [],
    paused: false,
    createdAt: "2026-09-29T00:00:00.000Z",
  };
}

function inspected() {
  return {
    name: "Weather",
    method: "POST",
    url: "https://weather.example/call",
    price: "$0.01",
    description: "Forecasts.",
    verification: "verified" as const,
    network: "eip155:8453",
    payment: null,
  };
}

function toolReply(id: string, name: string, args: Record<string, unknown>): ChatResult {
  return {
    content: null,
    toolCalls: [{ id, name, arguments: JSON.stringify(args) }],
    model: "router/test",
    keyUsed: "stake",
  };
}
