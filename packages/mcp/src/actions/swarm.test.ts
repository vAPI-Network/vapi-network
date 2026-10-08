import { getDefaultConfig, type AgentProfile } from "@vapi-network/core";
import { describe, expect, it, vi } from "vitest";
import { type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { z } from "zod";

import { createVapiServer } from "../server.js";
import type { ActionContext, SwarmPort } from "./context.js";
import type { Action } from "./define.js";
import { ActionDeclinedError, agentToolNames, runAction } from "./register.js";
import { swarmAgentActions } from "./swarm-agent.js";
import {
  swarmActions,
  swarmAdd,
  swarmDissolve,
  swarmFund,
  swarmLeave,
  swarmRebalance,
  swarmSetup,
  swarmStatus,
  type SwarmStatusOutput,
} from "./swarm.js";

const PRIVATE_KEY = "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" as Hex;
const movingActions = [
  ["swarm.setup", swarmSetup, { name: "team" }, "setup"],
  ["swarm.add", swarmAdd, { name: "team", role: "helper" }, "add"],
  ["swarm.leave", swarmLeave, { name: "team", member: "team-helper-1" }, "leave"],
  ["swarm.fund", swarmFund, { name: "team", amountUsd: "1" }, "fund"],
  ["swarm.rebalance", swarmRebalance, { name: "team" }, "rebalance"],
  ["swarm.dissolve", swarmDissolve, { name: "team" }, "dissolve"],
] as const;

describe("swarm action register", () => {
  it("lists the swarm tools last in declaration order with their exact input schemas", async () => {
    const server = createVapiServer({
      account: privateKeyToAccount(PRIVATE_KEY),
      config: getDefaultConfig(),
      fetchImpl: () => Promise.reject(new Error("The register test makes no network call.")),
    });

    const listed = (await server.listTools()).tools;
    const allSwarmActions = [...swarmActions, ...swarmAgentActions];
    expect(listed.slice(-allSwarmActions.length).map((tool) => tool.name)).toEqual(
      allSwarmActions.map((action) => action.name),
    );
    for (const action of allSwarmActions) {
      expect(listed.find((tool) => tool.name === action.name)?.inputSchema).toEqual(
        z.toJSONSchema(action.input),
      );
    }
    expect(agentToolNames).toEqual(["call.search", "call.inspect", "call.pay"]);
    expect(agentToolNames.some((name) => name.startsWith("swarm."))).toBe(false);

    await server.close();
  });

  it.each(movingActions)(
    "denies %s for a profiled caller before the swarm port runs",
    async (_name, action, input, method) => {
      const port = swarmPort();

      await expect(
        runAction(action as Action<unknown, object>, input, context(port, profile())),
      ).rejects.toBeInstanceOf(ActionDeclinedError);
      expect(port[method]).not.toHaveBeenCalled();
    },
  );

  it("allows swarm.status for a profiled caller and delegates to the port", async () => {
    const port = swarmPort();

    await expect(
      runAction(swarmStatus, { name: "team" }, context(port, profile())),
    ).resolves.toEqual(statusResult());
    expect(port.status).toHaveBeenCalledWith({ name: "team" });
  });

  it.each([...movingActions, ["swarm.status", swarmStatus, { name: "team" }, "status"]] as const)(
    "%s reports clearly when the swarm port is unavailable",
    async (_name, action, input) => {
      await expect(action.run(input as never, context())).rejects.toThrow(
        `${action.name} is not available in this action context.`,
      );
    },
  );
});

function statusResult(): SwarmStatusOutput {
  return {
    swarm: "team",
    network: "eip155:8453",
    strategy: "targets",
    treasury: {
      account: "team-treasury",
      address: "0x1111111111111111111111111111111111111111",
      linked: true,
      balanceAtomic: "0",
      balanceUsd: "0.00",
    },
    members: [],
    openMovements: [],
  };
}

function swarmPort(): SwarmPort & Record<keyof SwarmPort, ReturnType<typeof vi.fn>> {
  const unavailable = vi.fn(async (): Promise<never> => {
    throw new Error("This test method should not run.");
  });
  return {
    setup: vi.fn(unavailable),
    add: vi.fn(unavailable),
    leave: vi.fn(unavailable),
    fund: vi.fn(unavailable),
    rebalance: vi.fn(unavailable),
    status: vi.fn(async () => statusResult()),
    dissolve: vi.fn(unavailable),
  };
}

function profile(): AgentProfile {
  return {
    version: 1,
    name: "agent",
    wallet: "agent",
    model: "openai/gpt-5-mini",
    instructions: "Test the policy gate.",
    tools: ["call.search", "call.inspect", "call.pay"],
    grants: [],
    verifiedOnly: true,
    approveAboveUsd: 0.5,
    maxPerTaskUsd: 100,
    autoReleaseBelowUsd: 25,
    maxSteps: 12,
    paused: false,
    createdAt: "2026-09-29T00:00:00.000Z",
  };
}

function context(swarm?: SwarmPort, callerProfile?: AgentProfile): ActionContext {
  const unavailable = async (): Promise<never> => {
    throw new Error("This test port is unavailable.");
  };
  return {
    config: getDefaultConfig(),
    clock: () => new Date("2026-09-29T00:00:00.000Z"),
    call: { search: unavailable, inspect: unavailable, pay: unavailable },
    ...(swarm === undefined ? {} : { swarm }),
    caller: {
      surface: callerProfile === undefined ? "mcp" : "agent",
      ...(callerProfile === undefined ? {} : { profile: callerProfile }),
    },
  };
}
