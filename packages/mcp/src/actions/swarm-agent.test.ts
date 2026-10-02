import { getDefaultConfig } from "@vapi-network/core";
import { describe, expect, it, vi } from "vitest";

import type { ActionContext } from "./context.js";
import { runAction } from "./register.js";
import {
  swarmAllocate,
  swarmAllocateInputSchema,
  swarmDelegate,
  swarmDelegateInputSchema,
  swarmRun,
  swarmRunInputSchema,
} from "./swarm-agent.js";

describe("swarm agent MCP actions", () => {
  it("validates and forwards swarm.run input", async () => {
    const run = vi.fn().mockResolvedValue({
      runId: "run_parent",
      mode: "each",
      members: [],
      drawUsedUsd: 0,
      drawLimitUsd: 2,
      net: [],
    });
    const ctx = { ...context(), swarmRun: { run } };
    const input = {
      name: "research",
      task: "Compare the sources",
      mode: "each" as const,
      lead: "research-lead",
      budgetUsd: "0.50",
      drawUsd: "1.00",
    };

    await expect(runAction(swarmRun, input, ctx)).resolves.toMatchObject({
      runId: "run_parent",
      mode: "each",
    });
    expect(run).toHaveBeenCalledWith(input);
    expect(() => swarmRunInputSchema.parse({ ...input, name: "Not Valid" })).toThrow();
    expect(() => swarmRunInputSchema.parse({ ...input, task: "" })).toThrow();
  });

  it("rejects swarm.run when its port is unavailable", async () => {
    await expect(
      runAction(swarmRun, { name: "research", task: "Do the work" }, context()),
    ).rejects.toThrow("swarm.run is not available in this action context.");
  });

  it("rejects direct MCP execution of swarm.allocate", async () => {
    await expect(runAction(swarmAllocate, { amountUsd: "0.50" }, context())).rejects.toThrow(
      "swarm.allocate only works inside a swarm run.",
    );
  });

  it("rejects direct MCP execution of swarm.delegate", async () => {
    await expect(
      runAction(
        swarmDelegate,
        { member: "writer", task: "Write the answer", budgetUsd: "0.50" },
        context(),
      ),
    ).rejects.toThrow("swarm.delegate only works inside a swarm run.");
  });

  it("preserves bounded idempotency keys for in-run treasury actions", () => {
    expect(
      swarmAllocateInputSchema.parse({ amountUsd: "0.50", requestId: "run_1:allocate" }),
    ).toEqual({ amountUsd: "0.50", requestId: "run_1:allocate" });
    expect(
      swarmDelegateInputSchema.parse({
        member: "writer",
        task: "Write the answer",
        budgetUsd: "0.50",
        requestId: "run_1:delegate",
      }),
    ).toEqual({
      member: "writer",
      task: "Write the answer",
      budgetUsd: "0.50",
      requestId: "run_1:delegate",
    });
    expect(() =>
      swarmAllocateInputSchema.parse({ amountUsd: "0.50", requestId: "x".repeat(513) }),
    ).toThrow();
  });
});

function context(): ActionContext {
  const unavailable = async (): Promise<never> => {
    throw new Error("This test port is unavailable.");
  };
  return {
    config: getDefaultConfig(),
    clock: () => new Date("2026-09-30T00:00:00.000Z"),
    call: { search: unavailable, inspect: unavailable, pay: unavailable },
    caller: { surface: "mcp" },
  };
}
