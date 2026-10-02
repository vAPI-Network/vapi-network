import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentProfile, ChatRequest, ChatResult, VapiConfig } from "@vapi-network/core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { actions } from "../actions/register.js";
import { loopToolsForProfile, runAgent, type RunAgentDeps } from "./run.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("agent loop tool definitions", () => {
  it("preserves the exact wire contract for all call tools", async () => {
    const request = await firstChatRequest(["call.search", "call.inspect", "call.pay"]);

    expect(request.tools).toMatchInlineSnapshot(`
      [
        {
          "function": {
            "description": "Search vAPI Call listings available to this agent. Set network to null to search every network, or to a CAIP-2 id such as eip155:8453 (Base) or eip155:5042 (Arc).",
            "name": "call_search",
            "parameters": {
              "additionalProperties": false,
              "properties": {
                "network": {
                  "type": [
                    "string",
                    "null",
                  ],
                },
                "query": {
                  "type": "string",
                },
              },
              "required": [
                "query",
                "network",
              ],
              "type": "object",
            },
            "strict": true,
          },
          "profileName": "call.search",
          "type": "function",
        },
        {
          "function": {
            "description": "Inspect a vAPI Call listing's price, verification, and request contract.",
            "name": "call_inspect",
            "parameters": {
              "additionalProperties": false,
              "properties": {
                "ref": {
                  "type": "string",
                },
              },
              "required": [
                "ref",
              ],
              "type": "object",
            },
            "strict": true,
          },
          "profileName": "call.inspect",
          "type": "function",
        },
        {
          "function": {
            "description": "Call and pay a listing. body is a JSON-encoded request body or null. max_usd cannot override wallet or agent policy.",
            "name": "call_pay",
            "parameters": {
              "additionalProperties": false,
              "properties": {
                "body": {
                  "type": [
                    "string",
                    "null",
                  ],
                },
                "max_usd": {
                  "minimum": 0,
                  "type": "number",
                },
                "ref": {
                  "type": "string",
                },
              },
              "required": [
                "ref",
                "body",
                "max_usd",
              ],
              "type": "object",
            },
            "strict": true,
          },
          "profileName": "call.pay",
          "type": "function",
        },
        {
          "function": {
            "description": "Finish the run with the final answer.",
            "name": "finish",
            "parameters": {
              "additionalProperties": false,
              "properties": {
                "answer": {
                  "type": "string",
                },
              },
              "required": [
                "answer",
              ],
              "type": "object",
            },
            "strict": true,
          },
          "type": "function",
        },
      ]
    `);
  });

  it("preserves the exact wire contract for search only", async () => {
    const request = await firstChatRequest(["call.search"]);

    expect(request.tools).toMatchInlineSnapshot(`
      [
        {
          "function": {
            "description": "Search vAPI Call listings available to this agent. Set network to null to search every network, or to a CAIP-2 id such as eip155:8453 (Base) or eip155:5042 (Arc).",
            "name": "call_search",
            "parameters": {
              "additionalProperties": false,
              "properties": {
                "network": {
                  "type": [
                    "string",
                    "null",
                  ],
                },
                "query": {
                  "type": "string",
                },
              },
              "required": [
                "query",
                "network",
              ],
              "type": "object",
            },
            "strict": true,
          },
          "profileName": "call.search",
          "type": "function",
        },
        {
          "function": {
            "description": "Finish the run with the final answer.",
            "name": "finish",
            "parameters": {
              "additionalProperties": false,
              "properties": {
                "answer": {
                  "type": "string",
                },
              },
              "required": [
                "answer",
              ],
              "type": "object",
            },
            "strict": true,
          },
          "type": "function",
        },
      ]
    `);
  });

  it("preserves the exact wire contract for pay only", async () => {
    const request = await firstChatRequest(["call.pay"]);

    expect(request.tools).toMatchInlineSnapshot(`
      [
        {
          "function": {
            "description": "Call and pay a listing. body is a JSON-encoded request body or null. max_usd cannot override wallet or agent policy.",
            "name": "call_pay",
            "parameters": {
              "additionalProperties": false,
              "properties": {
                "body": {
                  "type": [
                    "string",
                    "null",
                  ],
                },
                "max_usd": {
                  "minimum": 0,
                  "type": "number",
                },
                "ref": {
                  "type": "string",
                },
              },
              "required": [
                "ref",
                "body",
                "max_usd",
              ],
              "type": "object",
            },
            "strict": true,
          },
          "profileName": "call.pay",
          "type": "function",
        },
        {
          "function": {
            "description": "Finish the run with the final answer.",
            "name": "finish",
            "parameters": {
              "additionalProperties": false,
              "properties": {
                "answer": {
                  "type": "string",
                },
              },
              "required": [
                "answer",
              ],
              "type": "object",
            },
            "strict": true,
          },
          "type": "function",
        },
      ]
    `);
  });

  it("offers every enabled call action under its registered loop name", () => {
    const callActions = actions.filter((action) => action.grant === "call");
    const tools = loopToolsForProfile({ tools: callActions.map((action) => action.name) });

    expect(
      tools.filter((tool) => tool.function.name !== "finish").map((tool) => tool.function.name),
    ).toEqual(callActions.map((action) => action.loopName));
  });

  it("adds granted read actions before finish in register order", async () => {
    const request = await firstChatRequest(["call.search", "call.inspect", "call.pay"], ["read"]);

    const names = (request.tools as Array<{ function: { name: string } }>).map(
      (tool) => tool.function.name,
    );
    expect(names).toEqual(["call_search", "call_inspect", "call_pay", "call_read", "finish"]);
  });

  it("does not expose swarm.runs inside an agent loop with the read grant", () => {
    const names = loopToolsForProfile({
      tools: [],
      grants: ["read"],
    }).map((tool) => tool.function.name);

    expect(names).toEqual(["call_read", "finish"]);
    expect(names).not.toContain("swarm_runs");
  });

  it("adds granted swarm actions with loop bindings before finish", () => {
    const names = loopToolsForProfile({
      tools: ["call.search"],
      grants: ["delegate", "allocate"],
    }).map((tool) => tool.function.name);

    expect(names).toEqual(["call_search", "swarm_allocate", "swarm_delegate", "finish"]);
  });

  it("rejects call_read when the profile has no read grant", async () => {
    const home = await mkdtemp(join(tmpdir(), "vapi-loop-tools-"));
    temporaryDirectories.push(home);
    const requests: ChatRequest[] = [];
    const replies: ChatResult[] = [
      {
        content: null,
        toolCalls: [
          {
            id: "read-1",
            name: "call_read",
            arguments: JSON.stringify({ url: "https://93.184.216.34/private" }),
          },
        ],
        model: "router/test",
        keyUsed: "stake",
      },
      { content: "done", toolCalls: [], model: "router/test", keyUsed: "stake" },
    ];
    const read = vi.fn();

    await runAgent("Read the paid resource", {
      profile: { ...profile(["call.search"], []), maxSteps: 2 },
      config: config(),
      home,
      async chat(request) {
        requests.push(structuredClone(request));
        const reply = replies.shift();
        if (reply === undefined) throw new Error("No scripted reply remains.");
        return reply;
      },
      async search() {
        return [];
      },
      async inspect() {
        throw new Error("inspect should not be called");
      },
      read,
      async pay() {
        throw new Error("pay should not be called");
      },
      caps: { perCallUsd: 0.05 },
      async approve() {
        return false;
      },
      now: () => new Date("2026-09-29T12:00:00.000Z"),
    });

    expect(read).not.toHaveBeenCalled();
    expect(requests[1]?.messages.at(-1)?.content).toContain(
      "Tool call_read is not allowed for this agent.",
    );
  });
});

async function firstChatRequest(
  tools: AgentProfile["tools"],
  grants: AgentProfile["grants"] = [],
): Promise<ChatRequest> {
  const home = await mkdtemp(join(tmpdir(), "vapi-loop-tools-"));
  temporaryDirectories.push(home);
  let request: ChatRequest | undefined;
  await runAgent("Inspect the tool contract", {
    profile: profile(tools, grants),
    config: config(),
    home,
    async chat(value) {
      request = structuredClone(value);
      return { content: "done", toolCalls: [], model: "router/test", keyUsed: "stake" };
    },
    async search() {
      return [];
    },
    async inspect() {
      throw new Error("inspect should not be called");
    },
    async pay() {
      throw new Error("pay should not be called");
    },
    caps: { perCallUsd: 0.05 },
    async approve() {
      return false;
    },
    now: () => new Date("2026-09-29T12:00:00.000Z"),
  } satisfies RunAgentDeps);
  if (request === undefined) throw new Error("The loop did not send a chat request.");
  return request;
}

function profile(tools: AgentProfile["tools"], grants: AgentProfile["grants"] = []): AgentProfile {
  return {
    version: 1,
    name: "researcher",
    wallet: "researcher",
    model: "router/test",
    instructions: "Research carefully.",
    verifiedOnly: true,
    approveAboveUsd: 0.5,
    maxSteps: 1,
    tools,
    grants,
    paused: false,
    createdAt: "2026-09-29T00:00:00.000Z",
  };
}

function config(): VapiConfig {
  return {
    discoveryUrl: "https://api.vapinetwork.ai/api/call/services",
    marketplaceDiscoveryUrl: "https://api.vapinetwork.ai/api/call/discovery",
    networks: {},
    spendCaps: { perCallAtomic: "50000", perDayAtomic: "1000000" },
  };
}
