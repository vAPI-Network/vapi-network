import {
  createRunBudget,
  getDefaultConfig,
  treasuryRequestMovementId,
  type AgentProfile,
} from "@vapi-network/core";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { InspectToolResult } from "../tools/inspect.js";
import { accountsSend } from "./accounts.js";
import { callInspect, callPay, callSearch } from "./call.js";
import { createRunState, inspectionCacheKey, type ActionContext } from "./context.js";
import { defineAction } from "./define.js";
import { checkAction } from "./policy.js";
import { ActionDeclinedError, runAction } from "./register.js";
import { swarmAllocate, swarmDelegate } from "./swarm-agent.js";
import {
  swarmAdd,
  swarmDissolve,
  swarmFund,
  swarmLeave,
  swarmRebalance,
  swarmSetup,
} from "./swarm.js";

describe("action payment policy", () => {
  it.each([
    [
      "an unknown price",
      { listing: { price: "See live x402 quote" } },
      { kind: "deny", reason: "The listing has no exact USDC price." },
    ],
    [
      "the per-call cap",
      { listing: { price: "$1.01" }, caps: { perCallUsd: 1 } },
      {
        kind: "deny",
        reason: "Price $1.01 is above this wallet's per-call cap $1.",
      },
    ],
    [
      "verified-only mode",
      { listing: { verification: "none" as const } },
      { kind: "deny", reason: "This agent only pays verified listings." },
    ],
  ] as const)("denies a payment rejected by %s", async (_label, setup, expected) => {
    const ctx = context({
      listing: setup.listing,
      ...("caps" in setup ? { caps: setup.caps } : {}),
    });

    await expect(checkAction(callPay, payInput(), ctx)).resolves.toEqual(expected);
  });

  it("asks the owner when the ref was not searched in this run", async () => {
    const ctx = context({ searched: false });

    await expect(checkAction(callPay, payInput(), ctx)).resolves.toEqual({
      kind: "ask_owner",
      reason: "weather was not found by call_search in this run.",
      ref: "weather",
      priceUsd: 0.01,
    });
  });

  it("asks the owner above the profile approval threshold", async () => {
    const ctx = context({
      listing: { price: "$0.80" },
      profile: { approveAboveUsd: 0.5 },
    });

    await expect(checkAction(callPay, payInput({ maxPriceUsd: 1 }), ctx)).resolves.toEqual({
      kind: "ask_owner",
      reason: "Price $0.8 is above the approval threshold $0.5.",
      ref: "weather",
      priceUsd: 0.8,
    });
  });

  it("lets refusal beat an owner question", async () => {
    const ctx = context({
      searched: false,
      listing: { verification: "none" },
    });

    await expect(checkAction(callPay, payInput(), ctx)).resolves.toEqual({
      kind: "deny",
      reason: "This agent only pays verified listings.",
    });
  });

  it("checks maxPriceUsd after an otherwise automatic payment", async () => {
    const ctx = context({ listing: { price: "$0.50" } });

    await expect(checkAction(callPay, payInput({ maxPriceUsd: 0.25 }), ctx)).resolves.toEqual({
      kind: "deny",
      reason: "Requested maximum $0.25 is below the listing price $0.5.",
    });
  });

  it("checks maxPriceUsd only after the owner approves", async () => {
    const ctx = context({
      searched: false,
      listing: { price: "$0.50" },
    });
    const input = payInput({ maxPriceUsd: 0.25 });

    await expect(checkAction(callPay, input, ctx)).resolves.toMatchObject({
      kind: "ask_owner",
      reason: "weather was not found by call_search in this run.",
    });
    await expect(checkAction(callPay, input, ctx, { ownerApproved: true })).resolves.toEqual({
      kind: "deny",
      reason: "Requested maximum $0.25 is below the listing price $0.5.",
    });
  });

  it("allows MCP and CLI callers without an agent profile", async () => {
    const ctx = context({ profile: undefined });

    await expect(checkAction(callPay, payInput(), ctx)).resolves.toEqual({ kind: "allow" });
    expect(ctx.call.inspect).not.toHaveBeenCalled();
  });

  it("allows money-free actions without inspecting a listing", async () => {
    const ctx = context();

    await expect(checkAction(callSearch, { query: "weather" }, ctx)).resolves.toEqual({
      kind: "allow",
    });
    expect(ctx.call.inspect).not.toHaveBeenCalled();
  });

  it("denies account moves for an agent before calling the accounts port", async () => {
    const send = vi.fn(async () => {
      throw new Error("The denied accounts port must not run.");
    });
    const ctx: ActionContext = { ...context(), accounts: { send } };

    await expect(
      runAction(accountsSend, { from: "researcher", to: "owner", amountUsd: "1" }, ctx),
    ).rejects.toEqual(new ActionDeclinedError("Agents cannot move money between accounts yet."));
    expect(send).not.toHaveBeenCalled();
  });

  it("does not let an allocate grant bypass the money-movement policy", async () => {
    const ctx = context({ profile: { grants: ["allocate"] } });

    await expect(runAction(swarmFund, { name: "research", amountUsd: "1" }, ctx)).rejects.toEqual(
      new ActionDeclinedError("Agents cannot move money between accounts yet."),
    );
  });

  it("reuses an action inspection from the context's single cache when paying", async () => {
    const ctx = context();

    await expect(runAction(callInspect, { id: "weather" }, ctx)).resolves.toEqual(inspected());
    await expect(checkAction(callPay, payInput(), ctx)).resolves.toEqual({ kind: "allow" });

    expect(ctx.call.inspect).toHaveBeenCalledTimes(1);
    expect(ctx.caller.run?.inspected.get(inspectionCacheKey({ id: "weather" }))).toEqual(
      inspected(),
    );
  });

  it("keeps inspections for separate endpoints distinct", async () => {
    const run = createRunState();
    const inspect = vi.fn(async ({ endpoint }: { id: string; endpoint?: string }) =>
      inspected({
        name: endpoint ?? "Default",
        url: `https://weather.example/${endpoint ?? "default"}`,
        price: endpoint === "expensive" ? "$0.50" : "$0.01",
      }),
    );
    const ctx: ActionContext = {
      ...context(),
      call: { ...context().call, inspect },
      caller: { surface: "agent", profile: agentProfile(), run },
    };

    const cheap = await runAction(callInspect, { id: "weather", endpoint: "cheap" }, ctx);
    const expensive = await runAction(callInspect, { id: "weather", endpoint: "expensive" }, ctx);
    const cachedExpensive = await runAction(
      callInspect,
      { id: "weather", endpoint: "expensive" },
      ctx,
    );

    expect(cheap).toMatchObject({ url: "https://weather.example/cheap", price: "$0.01" });
    expect(expensive).toMatchObject({
      url: "https://weather.example/expensive",
      price: "$0.50",
    });
    expect(cachedExpensive).toBe(expensive);
    expect(inspect).toHaveBeenCalledTimes(2);
    expect(inspect).toHaveBeenNthCalledWith(1, { id: "weather", endpoint: "cheap" });
    expect(inspect).toHaveBeenNthCalledWith(2, { id: "weather", endpoint: "expensive" });
  });

  it("uses the payment endpoint when policy obtains an inspection", async () => {
    const ctx = context({ searched: false });

    await expect(
      checkAction(callPay, { ...payInput(), endpoint: "expensive" }, ctx),
    ).resolves.toMatchObject({ kind: "ask_owner" });

    expect(ctx.call.inspect).toHaveBeenCalledWith({ id: "weather", endpoint: "expensive" });
  });

  describe("swarm run treasury policy", () => {
    it("denies a treasury action when its grant is missing", async () => {
      const ctx = swarmContext({ grants: ["read", "delegate"] });

      await expect(checkAction(swarmAllocate, { amountUsd: "0.50" }, ctx)).resolves.toEqual({
        kind: "deny",
        reason: "This agent does not have the allocate grant.",
      });
    });

    it("denies a treasury action outside a swarm run", async () => {
      const ctx = context({ profile: { grants: ["allocate"] } });

      await expect(checkAction(swarmAllocate, { amountUsd: "0.50" }, ctx)).resolves.toEqual({
        kind: "deny",
        reason: "Only a swarm run can move treasury money.",
      });
    });

    it("does not let a delegated run delegate again", async () => {
      const ctx = swarmContext({ grants: ["delegate"], depth: 1 });

      await expect(
        checkAction(
          swarmDelegate,
          { member: "writer", task: "Write the answer", budgetUsd: "0.50" },
          ctx,
        ),
      ).resolves.toEqual({ kind: "deny", reason: "A delegated run cannot delegate." });
    });

    it("denies a treasury request above the draw remaining", async () => {
      const ctx = swarmContext({ grants: ["allocate"], limitAtomic: 1_000_000n });
      ctx.caller.run?.swarm?.draw.reserve(750_000n, "already-spent");

      await expect(checkAction(swarmAllocate, { amountUsd: "0.50" }, ctx)).resolves.toEqual({
        kind: "deny",
        reason: "The swarm run has $0.25 left to draw.",
      });
    });

    it("allows a retry whose full draw is already reserved for the request movement", async () => {
      const requestId = "run_policy:allocate";
      const ctx = swarmContext({ grants: ["allocate"], limitAtomic: 1_000_000n });
      reserveTreasuryRequest(ctx, requestId, 1_000_000n);

      await expect(
        checkAction(swarmAllocate, { amountUsd: "1.00", requestId }, ctx),
      ).resolves.toEqual({ kind: "allow" });
    });

    it("requires fresh draw for a different request id", async () => {
      const ctx = swarmContext({ grants: ["allocate"], limitAtomic: 1_000_000n });
      reserveTreasuryRequest(ctx, "run_policy:original", 1_000_000n);

      await expect(
        checkAction(swarmAllocate, { amountUsd: "1.00", requestId: "run_policy:different" }, ctx),
      ).resolves.toEqual({
        kind: "deny",
        reason: "The swarm run has $0 left to draw.",
      });
    });

    it("allows a retry once its movement has reserved part of the draw", async () => {
      const requestId = "run_policy:partial-allow";
      const ctx = swarmContext({ grants: ["allocate"], limitAtomic: 1_000_000n });
      reserveTreasuryRequest(ctx, requestId, 400_000n);
      ctx.caller.run?.swarm?.draw.reserve(100_000n, "other-request");

      await expect(
        checkAction(swarmAllocate, { amountUsd: "0.90", requestId }, ctx),
      ).resolves.toEqual({ kind: "allow" });
    });

    it("allows a ceiling-trimmed completed request after another request spends the remaining draw", async () => {
      const requestId = "run_policy:ceiling-trimmed";
      const ctx = swarmContext({ grants: ["allocate"], limitAtomic: 1_000_000n });
      reserveTreasuryRequest(ctx, requestId, 500_000n);
      ctx.caller.run?.swarm?.draw.reserve(500_000n, "other-request");

      await expect(
        checkAction(swarmAllocate, { amountUsd: "1.00", requestId }, ctx),
      ).resolves.toEqual({ kind: "allow" });
    });

    it("keeps full fresh-draw behavior when a request id is absent", async () => {
      const ctx = swarmContext({ grants: ["allocate"], limitAtomic: 1_000_000n });
      reserveTreasuryRequest(ctx, "run_policy:existing", 1_000_000n);

      await expect(checkAction(swarmAllocate, { amountUsd: "1.00" }, ctx)).resolves.toEqual({
        kind: "deny",
        reason: "The swarm run has $0 left to draw.",
      });
    });

    it("does not let a fully reserved request bypass the grant check", async () => {
      const requestId = "run_policy:no-grant";
      const ctx = swarmContext({ grants: [], limitAtomic: 1_000_000n });
      reserveTreasuryRequest(ctx, requestId, 1_000_000n);

      await expect(
        checkAction(swarmAllocate, { amountUsd: "1.00", requestId }, ctx),
      ).resolves.toEqual({
        kind: "deny",
        reason: "This agent does not have the allocate grant.",
      });
    });

    it("does not let a fully reserved request bypass the swarm-run check", async () => {
      const requestId = "run_policy:outside-run";
      const ctx = swarmContext({ grants: ["allocate"], limitAtomic: 1_000_000n });
      reserveTreasuryRequest(ctx, requestId, 1_000_000n);
      if (ctx.caller.run === undefined) throw new Error("Expected run state.");
      ctx.caller.run.swarm = undefined;

      await expect(
        checkAction(swarmAllocate, { amountUsd: "1.00", requestId }, ctx),
      ).resolves.toEqual({
        kind: "deny",
        reason: "Only a swarm run can move treasury money.",
      });
    });

    it("does not let a fully reserved request bypass delegation depth", async () => {
      const requestId = "run_policy:depth";
      const ctx = swarmContext({ grants: ["delegate"], depth: 1, limitAtomic: 1_000_000n });
      reserveTreasuryRequest(ctx, requestId, 1_000_000n);

      await expect(
        checkAction(
          swarmDelegate,
          {
            member: "writer",
            task: "Write the answer",
            budgetUsd: "1.00",
            requestId,
          },
          ctx,
        ),
      ).resolves.toEqual({ kind: "deny", reason: "A delegated run cannot delegate." });
    });

    it("does not let a fully reserved request bypass amount validation", async () => {
      const requestId = "run_policy:bad-amount";
      const ctx = swarmContext({ grants: ["allocate"], limitAtomic: 1_000_000n });
      reserveTreasuryRequest(ctx, requestId, 1_000_000n);

      await expect(
        checkAction(swarmAllocate, { amountUsd: "0.001", requestId }, ctx),
      ).resolves.toEqual({
        kind: "deny",
        reason: "Enter a positive USDC amount in whole cents.",
      });
    });

    it("does not let a fully reserved request bypass owner approval", async () => {
      const requestId = "run_policy:approval";
      const ctx = swarmContext({
        grants: ["delegate"],
        approveAboveUsd: 0.25,
        limitAtomic: 1_000_000n,
      });
      reserveTreasuryRequest(ctx, requestId, 1_000_000n);

      await expect(
        checkAction(
          swarmDelegate,
          {
            member: "writer",
            task: "Write the answer",
            budgetUsd: "1.00",
            requestId,
          },
          ctx,
        ),
      ).resolves.toEqual({
        kind: "ask_owner",
        reason: "Treasury draw $1 is above the approval threshold $0.25.",
        ref: "swarm treasury → writer",
        priceUsd: 1,
      });
    });

    it.each([
      ["zero", (ctx: ActionContext) => checkAction(swarmAllocate, { amountUsd: "0" }, ctx)],
      [
        "fractional cents",
        (ctx: ActionContext) => checkAction(swarmAllocate, { amountUsd: "0.001" }, ctx),
      ],
      [
        "negative",
        (ctx: ActionContext) =>
          checkAction(swarmDelegate, { member: "writer", task: "Write", budgetUsd: "-1" }, ctx),
      ],
      [
        "non-numeric",
        (ctx: ActionContext) =>
          checkAction(swarmDelegate, { member: "writer", task: "Write", budgetUsd: "many" }, ctx),
      ],
    ] as const)("denies a malformed whole-cent amount: %s", async (_label, decide) => {
      const ctx = swarmContext({ grants: ["allocate", "delegate"] });

      await expect(decide(ctx)).resolves.toEqual({
        kind: "deny",
        reason: "Enter a positive USDC amount in whole cents.",
      });
    });

    it("asks the owner above the profile approval threshold", async () => {
      const ctx = swarmContext({ grants: ["delegate"], approveAboveUsd: 0.25 });

      await expect(
        checkAction(
          swarmDelegate,
          { member: "writer", task: "Write the answer", budgetUsd: "0.50" },
          ctx,
        ),
      ).resolves.toEqual({
        kind: "ask_owner",
        reason: "Treasury draw $0.5 is above the approval threshold $0.25.",
        ref: "swarm treasury → writer",
        priceUsd: 0.5,
      });
    });

    it.each([
      ["owner declines", vi.fn(async () => false)],
      ["there is no owner prompt", undefined],
    ] as const)("does not run when %s", async (_label, askOwner) => {
      const run = vi.fn(async () => ({
        status: "sent" as const,
        movementId: "movement-1",
        sentUsd: "0.50",
        blocked: [],
      }));
      const action = { ...swarmAllocate, run };
      const ctx = swarmContext({ grants: ["allocate"], approveAboveUsd: 0.25 });
      if (askOwner !== undefined) ctx.askOwner = askOwner;

      await expect(runAction(action, { amountUsd: "0.50" }, ctx)).rejects.toBeInstanceOf(
        ActionDeclinedError,
      );
      expect(run).not.toHaveBeenCalled();
      if (askOwner !== undefined) expect(askOwner).toHaveBeenCalledTimes(1);
    });

    it.each([
      [
        accountsSend.name,
        (ctx: ActionContext) =>
          checkAction(accountsSend, { from: "researcher", to: "owner", amountUsd: "1" }, ctx),
      ],
      [swarmSetup.name, (ctx: ActionContext) => checkAction(swarmSetup, { name: "research" }, ctx)],
      [
        swarmAdd.name,
        (ctx: ActionContext) => checkAction(swarmAdd, { name: "research", role: "writer" }, ctx),
      ],
      [
        swarmLeave.name,
        (ctx: ActionContext) =>
          checkAction(swarmLeave, { name: "research", member: "research-writer" }, ctx),
      ],
      [
        swarmFund.name,
        (ctx: ActionContext) => checkAction(swarmFund, { name: "research", amountUsd: "1" }, ctx),
      ],
      [
        swarmRebalance.name,
        (ctx: ActionContext) => checkAction(swarmRebalance, { name: "research" }, ctx),
      ],
      [
        swarmDissolve.name,
        (ctx: ActionContext) => checkAction(swarmDissolve, { name: "research" }, ctx),
      ],
    ] as const)("keeps owner action %s denied inside a swarm run", async (_name, decide) => {
      const ctx = swarmContext({ grants: ["read", "delegate", "allocate"] });

      await expect(decide(ctx)).resolves.toEqual({
        kind: "deny",
        reason: "Agents cannot move money between accounts yet.",
      });
    });

    it("does not let an agent start a swarm run", async () => {
      const swarmRun = defineAction({
        name: "swarm.run",
        money: "spends",
        grant: "allocate",
        description: "Test swarm run action.",
        input: z.object({}),
        output: z.object({ ok: z.boolean() }),
        async run() {
          return { ok: true };
        },
      });

      await expect(checkAction(swarmRun, {}, swarmContext())).resolves.toEqual({
        kind: "deny",
        reason: "Agents cannot start swarm runs.",
      });
    });
  });
});

function context(
  options: {
    searched?: boolean;
    listing?: Partial<InspectToolResult>;
    caps?: { perCallUsd: number };
    profile?: Partial<AgentProfile> | undefined;
  } = {},
): ActionContext {
  const run = createRunState();
  if (options.searched !== false) run.searchedRefs.add("weather");
  const profile =
    options.profile === undefined && "profile" in options
      ? undefined
      : agentProfile(options.profile);
  return {
    config: getDefaultConfig(),
    clock: () => new Date("2026-09-29T00:00:00.000Z"),
    call: {
      search: vi.fn(async () => {
        throw new Error("Search is unavailable in this policy test.");
      }),
      inspect: vi.fn(async () => inspected(options.listing)),
      pay: vi.fn(async () => {
        throw new Error("Pay is unavailable in this policy test.");
      }),
    },
    caps: options.caps ?? { perCallUsd: 1 },
    caller: {
      surface: profile ? "agent" : "mcp",
      ...(profile === undefined ? {} : { profile, run }),
    },
  };
}

function agentProfile(overrides: Partial<AgentProfile> = {}): AgentProfile {
  const { grants = [], ...rest } = overrides;
  return {
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
    ...rest,
    grants,
  };
}

function swarmContext(
  options: {
    grants?: AgentProfile["grants"];
    depth?: 0 | 1;
    approveAboveUsd?: number;
    limitAtomic?: bigint;
  } = {},
): ActionContext {
  const ctx = context({
    profile: {
      grants: options.grants ?? ["read", "delegate", "allocate"],
      approveAboveUsd: options.approveAboveUsd ?? 1,
    },
  });
  const run = ctx.caller.run;
  if (run === undefined) throw new Error("The swarm policy test requires run state.");
  run.swarm = {
    name: "research",
    treasury: "research-treasury",
    member: "research-lead",
    depth: options.depth ?? 0,
    draw: createRunBudget({
      id: "run_swarm_policy",
      limitAtomic: options.limitAtomic ?? 1_000_000n,
    }),
  };
  return ctx;
}

function reserveTreasuryRequest(ctx: ActionContext, requestId: string, amountAtomic: bigint): void {
  const swarm = ctx.caller.run?.swarm;
  if (swarm === undefined) throw new Error("The policy test requires swarm run state.");
  swarm.draw.reserve(amountAtomic, treasuryRequestMovementId(swarm.name, requestId));
}

function payInput(overrides: Partial<{ id: string; maxPriceUsd: number | string }> = {}) {
  return { id: "weather", maxPriceUsd: 1, ...overrides };
}

function inspected(overrides: Partial<InspectToolResult> = {}): InspectToolResult {
  return {
    name: "Weather",
    method: "POST",
    url: "https://weather.example/call",
    price: "$0.01",
    description: "Forecasts.",
    verification: "verified",
    network: "eip155:8453",
    payment: null,
    ...overrides,
  };
}
