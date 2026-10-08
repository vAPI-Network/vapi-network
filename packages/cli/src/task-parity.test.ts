import { TASKS_CLIENT_VERBS, getDefaultConfig } from "@vapi-network/core";
import { createVapiServer } from "@vapi-network/mcp";
import { describe, expect, it } from "vitest";
import { type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { TASK_HELP } from "./task.js";

const PRIVATE_KEY = "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" as Hex;

describe("task interface parity", () => {
  it("keeps CLI help and MCP registration aligned with the canonical task verbs", async () => {
    const helpVerbs = [...TASK_HELP.matchAll(/^ {2}vapi task (\w+)/gmu)].map((match) => match[1]);
    expect(new Set(helpVerbs)).toEqual(new Set(TASKS_CLIENT_VERBS));

    const server = createVapiServer({
      account: privateKeyToAccount(PRIVATE_KEY),
      config: getDefaultConfig({}),
      env: {},
      fetchImpl: () => Promise.reject(new Error("task parity must not use the network")),
    });
    try {
      const mcpVerbs = (await server.listTools()).tools
        .map(({ name }) => name)
        .filter((name) => name.startsWith("tasks."))
        .map((name) => name.slice("tasks.".length));
      expect(new Set(mcpVerbs)).toEqual(new Set(TASKS_CLIENT_VERBS));
    } finally {
      await server.close();
    }
  });
});
