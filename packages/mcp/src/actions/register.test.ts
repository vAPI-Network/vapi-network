import { getDefaultConfig } from "@vapi-network/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { z } from "zod";

import { loopToolsForProfile } from "../agent/run.js";
import { createVapiServer } from "../server.js";
import { accountsSend } from "./accounts.js";
import type { ActionContext } from "./context.js";
import { defineAction, type ActionMoney } from "./define.js";
import { checkAction } from "./policy.js";
import { ActionDeclinedError, actions, agentToolNames, runAction } from "./register.js";

vi.mock("./policy.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./policy.js")>();
  return { ...actual, checkAction: vi.fn(actual.checkAction) };
});

const PRIVATE_KEY = "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" as Hex;

beforeEach(() => {
  vi.mocked(checkAction).mockClear();
});

describe("action register", () => {
  it("publishes every action through MCP with its exact declaration", async () => {
    const server = createVapiServer({
      account: privateKeyToAccount(PRIVATE_KEY),
      config: getDefaultConfig(),
      fetchImpl: () => Promise.reject(new Error("The register test makes no network call.")),
    });

    const listed = (await server.listTools()).tools;
    for (const action of actions) {
      const tool = listed.find((candidate) => candidate.name === action.name);
      expect(tool).toEqual({
        name: action.name,
        description: action.description,
        inputSchema: z.toJSONSchema(action.input),
        outputSchema: z.toJSONSchema(action.output),
      });
    }
    await server.close();
  });

  it("registers accounts.send in its existing MCP position but not in the agent loop", async () => {
    const server = createVapiServer({
      account: privateKeyToAccount(PRIVATE_KEY),
      config: getDefaultConfig(),
      fetchImpl: () => Promise.reject(new Error("The register test makes no network call.")),
    });

    expect(actions).toContain(accountsSend);
    expect(agentToolNames).not.toContain(accountsSend.name);
    expect(
      loopToolsForProfile({ tools: [...agentToolNames, accountsSend.name] }).map(
        (tool) => tool.function.name,
      ),
    ).not.toContain(accountsSend.loopName);

    const listed = (await server.listTools()).tools;
    const sendIndex = listed.findIndex((tool) => tool.name === accountsSend.name);
    expect(listed[sendIndex - 1]?.name).toBe("accounts.caps");
    expect(listed[sendIndex + 1]?.name).toBe("call.search");
    expect(listed[sendIndex]).toEqual({
      name: accountsSend.name,
      description: accountsSend.description,
      inputSchema: z.toJSONSchema(accountsSend.input),
      outputSchema: z.toJSONSchema(accountsSend.output),
    });
    await expect(
      server.callTool({
        name: accountsSend.name,
        arguments: { from: "main", to: "owner", amountUsd: "1" },
      }),
    ).resolves.toEqual({
      isError: true,
      content: [
        {
          type: "text",
          text: "No wallet store is available on this machine, so accounts cannot be changed. Run vapi setup.",
        },
      ],
    });
    await server.close();
  });

  it("does not expose movement cancellation through MCP", async () => {
    const server = createVapiServer({
      account: privateKeyToAccount(PRIVATE_KEY),
      config: getDefaultConfig(),
      fetchImpl: () => Promise.reject(new Error("The register test makes no network call.")),
    });

    const tools = (await server.listTools()).tools;
    const names = tools.map((tool) => tool.name);
    expect(names).not.toContain("accounts.cancel");
    expect(names).not.toContain("accounts.distribute");
    expect(names.every((name) => !name.includes("cancel"))).toBe(true);
    const schemas = JSON.stringify(tools.map((tool) => tool.inputSchema));
    expect(schemas).not.toContain('"cancel"');
    expect(schemas).not.toContain('"replaceExpiredRestored"');
    expect(schemas).not.toContain('"replace-expired-restored"');
    await server.close();
  });

  it("runs accounts.send through policy and its port for an owner caller", async () => {
    const transfer = {
      status: "sent",
      from: "main",
      to: "0x1111111111111111111111111111111111111111",
      toName: "research",
      toKind: "account",
      amountUsd: "0.05",
      amountAtomic: "50000",
      network: "eip155:8453",
      txHash: "0x2222",
      nonce: "0x3333",
      replayed: false,
    } as const;
    const send = vi.fn(async () => transfer);
    const input = { from: "main", to: "research", amountUsd: "0.05" };

    await expect(runAction(accountsSend, input, context({ accounts: { send } }))).resolves.toEqual({
      ...transfer,
      message: "Sent 0.05 USDC from main to research.",
    });
    expect(checkAction).toHaveBeenCalledWith(accountsSend, input, expect.anything());
    expect(send).toHaveBeenCalledWith(input);
  });

  it.each(["spends", "moves"] as const)(
    "consults the policy gate before running a %s action",
    async (money) => {
      const consulted: string[] = [];
      vi.mocked(checkAction).mockImplementationOnce(async () => {
        consulted.push("gate");
        return { kind: "allow" };
      });
      const action = gatedAction(money, () => {
        if (consulted.at(-1) !== "gate") throw new Error("The policy gate was bypassed.");
        consulted.push("run");
      });

      await expect(runAction(action, {}, context())).resolves.toEqual({ ok: true });
      expect(consulted).toEqual(["gate", "run"]);
      expect(checkAction).toHaveBeenCalledTimes(1);
    },
  );

  it("declines an owner question when the owner does not approve", async () => {
    vi.mocked(checkAction).mockResolvedValueOnce({
      kind: "ask_owner",
      reason: "Approval is required.",
      ref: "weather",
      priceUsd: 0.75,
    });
    const askOwner = vi.fn(async () => false);
    const run = vi.fn(async () => ({ ok: true }));
    const action = gatedAction("spends", run);

    const result = runAction(action, {}, context({ askOwner }));

    await expect(result).rejects.toEqual(
      new ActionDeclinedError("Payment was not approved: Approval is required."),
    );
    expect(askOwner).toHaveBeenCalledTimes(1);
    expect(run).not.toHaveBeenCalled();
  });

  it("rechecks policy after the owner approves", async () => {
    vi.mocked(checkAction)
      .mockResolvedValueOnce({
        kind: "ask_owner",
        reason: "Approval is required.",
        ref: "weather",
        priceUsd: 0.75,
      })
      .mockResolvedValueOnce({ kind: "allow" });
    const askOwner = vi.fn(async () => true);
    const run = vi.fn(async () => ({ ok: true }));
    const action = gatedAction("spends", run);

    await expect(runAction(action, {}, context({ askOwner }))).resolves.toEqual({ ok: true });

    expect(askOwner).toHaveBeenCalledWith({
      action: "test.gated",
      reason: "Approval is required.",
      ref: "weather",
      priceUsd: 0.75,
    });
    expect(checkAction).toHaveBeenNthCalledWith(2, action, {}, expect.anything(), {
      ownerApproved: true,
    });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("validates output without returning Zod's stripped copy", async () => {
    const output = { known: "value", retained: "unknown to the schema" };
    const action = defineAction<Record<string, never>, { known: string }>({
      name: "test.output",
      description: "Test output identity.",
      input: z.object({}),
      output: z.object({ known: z.string() }),
      money: "none",
      grant: "read",
      async run() {
        return output;
      },
    });

    const result = await runAction(action, {}, context());

    expect(result).toBe(output);
    expect(result).toHaveProperty("retained", "unknown to the schema");
  });

  it("returns a paid result even when its shape does not match, and rejects it for free actions", async () => {
    const badOutput = { ok: "yes" } as unknown as { ok: boolean };
    const spend = defineAction<Record<string, never>, { ok: boolean }>({
      name: "test.paid",
      description: "Test a paid result.",
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
      money: "spends",
      grant: "call",
      async run() {
        return badOutput;
      },
    });
    const free = defineAction<Record<string, never>, { ok: boolean }>({
      ...spend,
      name: "test.free",
      money: "none",
    });

    await expect(runAction(spend, {}, context())).resolves.toBe(badOutput);
    await expect(runAction(free, {}, context())).rejects.toThrow();
  });
});

function gatedAction(money: Exclude<ActionMoney, "none">, beforeRun: () => void) {
  return defineAction<Record<string, never>, { ok: boolean }>({
    name: "test.gated",
    description: "Test the policy gate.",
    input: z.object({}),
    output: z.object({ ok: z.boolean() }),
    money,
    grant: "call",
    async run() {
      beforeRun();
      return { ok: true };
    },
  });
}

function context(overrides: Partial<ActionContext> = {}): ActionContext {
  const unavailable = async (): Promise<never> => {
    throw new Error("This test port is unavailable.");
  };
  return {
    config: getDefaultConfig(),
    clock: () => new Date("2026-09-29T00:00:00.000Z"),
    call: { search: unavailable, inspect: unavailable, pay: unavailable },
    caller: { surface: "mcp" },
    ...overrides,
  };
}
