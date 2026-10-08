import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createRunBudget,
  getDefaultConfig,
  type AgentProfile,
  type ChatRequest,
  type ChatResult,
} from "@vapi-network/core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { loopToolsForProfile, runAgent, type RunAgentDeps, type SwarmRunContext } from "./run.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("swarm agent loop", () => {
  it("offers lead swarm tools after call_read in register order", () => {
    const names = loopToolsForProfile(leadProfile()).map((tool) => tool.function.name);

    expect(names).toEqual([
      "call_search",
      "call_inspect",
      "call_pay",
      "call_read",
      "swarm_allocate",
      "swarm_delegate",
      "finish",
    ]);
  });

  it("does not offer treasury tools with only the read grant", () => {
    const names = loopToolsForProfile({
      ...leadProfile(),
      grants: ["read"],
    }).map((tool) => tool.function.name);

    expect(names).not.toContain("swarm_allocate");
    expect(names).not.toContain("swarm_delegate");
  });

  it("allocates through the injected swarm context and wraps the result as untrusted", async () => {
    const requests: ChatRequest[] = [];
    const deps = await agentDeps(
      [
        toolReply("allocate", "swarm_allocate", {
          amount_usd: "0.50",
          reason: null,
          request_id: "model-request-id",
          requestId: "another-model-request-id",
        }),
        toolReply("finish", "finish", { answer: "Allocated." }),
      ],
      requests,
    );
    deps.runId = "run_parent";
    deps.forRun = () => ({ ...deps });

    const result = await runAgent("Fund this work", deps);

    expect(deps.swarm?.allocate).toHaveBeenCalledWith({
      amountUsd: "0.50",
      requestId: "run_parent:allocate",
    });
    expect(requests[1]!.messages.at(-1)?.content).toContain(
      '<tool_result tool="swarm_allocate" trust="untrusted">',
    );
    expect(requests[1]!.messages.at(-1)?.content).toContain('"sentUsd":"0.50"');
    expect(result.answer).toBe("Allocated.");
  });

  it("passes the parent run id into a delegated member run", async () => {
    const deps = await agentDeps([
      toolReply("delegate", "swarm_delegate", {
        member: "research-writer",
        task: "Write the answer",
        budget_usd: "0.50",
      }),
      toolReply("finish", "finish", { answer: "Delegated." }),
    ]);
    deps.runId = "run_parent";

    const result = await runAgent("Delegate the writing", deps);

    expect(deps.swarm?.delegate).toHaveBeenCalledWith({
      member: "research-writer",
      task: "Write the answer",
      budgetUsd: "0.50",
      parentRunId: result.runId,
      requestId: "run_parent:delegate",
    });
  });

  it("uses the step and tool index when a swarm tool call id is empty", async () => {
    const deps = await agentDeps([
      toolReply("", "swarm_allocate", { amount_usd: "0.25", reason: null }),
      toolReply("finish", "finish", { answer: "Allocated." }),
    ]);
    deps.runId = "run_parent";

    await runAgent("Fund this work", deps);

    expect(deps.swarm?.allocate).toHaveBeenCalledWith({
      amountUsd: "0.25",
      requestId: "run_parent:step-1-0",
    });
  });

  it("declines delegation from a depth-one run without calling the delegate port", async () => {
    const requests: ChatRequest[] = [];
    const deps = await agentDeps(
      [
        toolReply("delegate", "swarm_delegate", {
          member: "research-writer",
          task: "Write the answer",
          budget_usd: "0.50",
        }),
        toolReply("finish", "finish", { answer: "Stopped." }),
      ],
      requests,
    );
    deps.swarm = swarmContext({ depth: 1 });

    await runAgent("Delegate the writing", deps);

    expect(deps.swarm.delegate).not.toHaveBeenCalled();
    expect(requests[1]!.messages.at(-1)?.content).toContain('"status":"declined"');
    expect(requests[1]!.messages.at(-1)?.content).toContain("A delegated run cannot delegate.");
  });

  it("declines an allocation above the draw without calling the allocation port", async () => {
    const requests: ChatRequest[] = [];
    const deps = await agentDeps(
      [
        toolReply("allocate", "swarm_allocate", { amount_usd: "0.50", reason: null }),
        toolReply("finish", "finish", { answer: "Stopped." }),
      ],
      requests,
    );
    deps.swarm = swarmContext({ limitAtomic: 250_000n });

    await runAgent("Fund this work", deps);

    expect(deps.swarm.allocate).not.toHaveBeenCalled();
    expect(requests[1]!.messages.at(-1)?.content).toContain('"status":"declined"');
    expect(requests[1]!.messages.at(-1)?.content).toContain("$0.25 left to draw");
  });

  it("declines when the owner rejects a draw above the approval threshold", async () => {
    const requests: ChatRequest[] = [];
    const deps = await agentDeps(
      [
        toolReply("allocate", "swarm_allocate", { amount_usd: "0.50", reason: null }),
        toolReply("finish", "finish", { answer: "Stopped." }),
      ],
      requests,
    );
    deps.profile = { ...deps.profile, approveAboveUsd: 0.25 };
    deps.approve = vi.fn().mockResolvedValue(false);

    await runAgent("Fund this work", deps);

    expect(deps.approve).toHaveBeenCalledWith({
      ref: "swarm treasury → research-lead",
      priceUsd: 0.5,
      reason: "Treasury draw $0.5 is above the approval threshold $0.25.",
    });
    expect(deps.swarm?.allocate).not.toHaveBeenCalled();
    expect(requests[1]!.messages.at(-1)?.content).toContain('"status":"declined"');
  });

  it("returns a tool error when the execution deps lose the swarm port", async () => {
    const requests: ChatRequest[] = [];
    const deps = await agentDeps(
      [
        toolReply("allocate", "swarm_allocate", { amount_usd: "0.50", reason: null }),
        toolReply("finish", "finish", { answer: "Stopped." }),
      ],
      requests,
    );
    const allocate = deps.swarm?.allocate;
    deps.forRun = () => ({ ...deps, swarm: undefined });

    await runAgent("Fund this work", deps);

    expect(allocate).not.toHaveBeenCalled();
    expect(requests[1]!.messages.at(-1)?.content).toContain("swarm_allocate failed.");
  });
});

async function agentDeps(
  replies: ChatResult[],
  requests: ChatRequest[] = [],
): Promise<RunAgentDeps> {
  const home = await mkdtemp(join(tmpdir(), "vapi-swarm-loop-"));
  temporaryDirectories.push(home);
  const scripted = [...replies];
  return {
    profile: leadProfile(),
    config: getDefaultConfig(),
    home,
    chat: vi.fn(async (request) => {
      requests.push(structuredClone(request));
      const reply = scripted.shift();
      if (reply === undefined) throw new Error("No scripted chat reply remains.");
      return reply;
    }),
    search: vi.fn().mockResolvedValue([]),
    inspect: vi.fn().mockRejectedValue(new Error("Inspect is unavailable in this test.")),
    pay: vi.fn().mockRejectedValue(new Error("Pay is unavailable in this test.")),
    caps: { perCallUsd: 1 },
    approve: vi.fn().mockResolvedValue(false),
    now: () => new Date("2026-09-30T00:00:00.000Z"),
    swarm: swarmContext(),
  };
}

function leadProfile(): AgentProfile {
  return {
    version: 1,
    name: "research-lead",
    wallet: "research-lead",
    model: "router/test",
    instructions: "Lead the swarm carefully.",
    verifiedOnly: true,
    approveAboveUsd: 1,
    maxPerTaskUsd: 100,
    autoReleaseBelowUsd: 25,
    maxSteps: 12,
    tools: ["call.search", "call.inspect", "call.pay"],
    grants: ["read", "delegate", "allocate"],
    paused: false,
    createdAt: "2026-09-30T00:00:00.000Z",
  };
}

function swarmContext(options: { depth?: 0 | 1; limitAtomic?: bigint } = {}): SwarmRunContext {
  return {
    name: "research",
    treasury: "research-treasury",
    member: "research-lead",
    depth: options.depth ?? 0,
    draw: createRunBudget({
      id: "run_swarm_draw",
      limitAtomic: options.limitAtomic ?? 1_000_000n,
    }),
    allocate: vi.fn().mockResolvedValue({
      status: "sent",
      movementId: "movement-1",
      sentUsd: "0.50",
      blocked: [],
    }),
    delegate: vi.fn().mockResolvedValue({
      member: "research-writer",
      runId: "run_child",
      answer: "Draft complete.",
      stoppedBecause: { reason: "finished" },
      spentUsd: 0.25,
      budgetUsd: 0.5,
    }),
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
