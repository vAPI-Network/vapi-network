import { getDefaultConfig, type MarketplaceDiscoveryPage } from "@vapi-network/core";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  callInspect,
  callPay,
  callPayInputSchema,
  callSearch,
  inspectToolResultSchema,
} from "./call.js";
import { createRunState, inspectionCacheKey, type ActionContext } from "./context.js";
import { runAction } from "./register.js";

const inspected = {
  name: "email_count",
  method: "POST",
  url: "https://mpp.example/email-count",
  price: "$0.01",
  description: "Count matching emails.",
  verification: "none",
};

describe("call action result contracts", () => {
  it("validates paid response timeout seconds", () => {
    expect(
      callPayInputSchema.parse({ url: "https://example.com", timeoutSeconds: 45 }),
    ).toMatchObject({ timeoutSeconds: 45 });
    for (const timeoutSeconds of [0, 1.5, 301]) {
      expect(() =>
        callPayInputSchema.parse({ url: "https://example.com", timeoutSeconds }),
      ).toThrow();
    }
  });

  it("exports inspect output as JSON Schema for MCP registration", () => {
    expect(() => z.toJSONSchema(inspectToolResultSchema)).not.toThrow();
  });

  it.each([
    {
      protocol: "mpp",
      intent: "charge",
      method: "tempo",
      checkedAt: "2026-08-19T10:30:00.000Z",
    },
    {
      protocol: "future-pay",
      intent: "future-intent",
      method: { display: "future method" },
      checkedAt: "2026-08-19T10:30:00.000Z",
    },
  ])("parses inspect output carrying $protocol metadata", (payment) => {
    expect(inspectToolResultSchema.parse({ ...inspected, payment, hints: [] })).toMatchObject({
      payment,
    });
  });

  it.each(["cli", "mcp", "agent"] as const)(
    "returns schema-valid hints from every action for %s",
    async (surface) => {
      const ctx = context(surface);
      const search = await runAction(callSearch, {}, ctx);
      const inspect = await runAction(callInspect, { id: "weather" }, ctx);
      const pay = await runAction(callPay, { id: "weather" }, ctx);

      expect(callSearch.output.parse(search)).toEqual(search);
      expect(callInspect.output.parse(inspect)).toEqual(inspect);
      expect(callPay.output.parse(pay)).toEqual(pay);
      const inspectName =
        surface === "cli"
          ? "vapi inspect weather"
          : surface === "mcp"
            ? 'call.inspect {"id":"weather"}'
            : 'call_inspect {"ref":"weather"}';
      const payName =
        surface === "cli" ? "vapi pay weather" : surface === "mcp" ? "call.pay " : "call_pay ";
      expect(search.hints[0]).toBe(`Inspect before paying: ${inspectName}`);
      expect(inspect.hints[0]).toContain(payName);
      expect(pay.hints[0]).toContain(inspectName);
      expect(ctx.caller.run?.searchedRefs).toContain("weather");
    },
  );

  it("renders cached inspections per caller without caching or mutating hints", async () => {
    const ctx = context("agent");
    const raw = await ctx.call.inspect({ id: "weather" });
    const inspect = vi.fn(async () => raw);
    ctx.call.inspect = inspect;
    const agent = await runAction(callInspect, { id: "weather" }, ctx);
    ctx.caller.surface = "cli";
    const cli = await runAction(callInspect, { id: "weather" }, ctx);

    expect(agent.hints[0]).toContain("call_pay ");
    expect(cli.hints[0]).toContain("vapi pay weather");
    expect(cli.hints.join(" ")).not.toContain("call_pay");
    expect(inspect).toHaveBeenCalledTimes(1);
    expect(ctx.caller.run?.inspected.get(inspectionCacheKey({ id: "weather" }))).toBe(raw);
    expect(raw).not.toHaveProperty("hints");
  });

  it("leaves raw search and payment results available for persistence without hints", async () => {
    const ctx = context("cli");
    const page = await ctx.call.search({});
    const payment = await ctx.call.pay({ id: "weather" });
    ctx.call.search = async () => page;
    ctx.call.pay = async () => payment;
    await runAction(callSearch, { includeOutage: true }, ctx);
    await runAction(callPay, { id: "weather" }, ctx);
    expect(page).not.toHaveProperty("hints");
    expect(payment).not.toHaveProperty("hints");
  });

  it("does not manufacture a receipt id for a 402 or a listing for URL-only calls", async () => {
    const ctx = context("cli");
    ctx.call.pay = async () => ({ wallet: "main", status: 402, body: {}, payment: null });
    expect((await runAction(callPay, { url: "https://api.example/paid" }, ctx)).hints).toEqual([]);
    const result = await runAction(callPay, { id: "weather" }, ctx);
    expect(result.hints).toEqual([
      "The provider answered 402; check the request contract with: vapi inspect weather",
    ]);
  });

  it("propagates port failures without inventing hint results", async () => {
    const ctx = context("cli");
    const error = new Error("Injected provider timeout");
    const fail = async (): Promise<never> => {
      throw error;
    };
    ctx.call = { search: fail, inspect: fail, pay: fail };
    await expect(runAction(callSearch, {}, ctx)).rejects.toBe(error);
    await expect(runAction(callInspect, { id: "weather" }, ctx)).rejects.toBe(error);
    await expect(runAction(callPay, { id: "weather" }, ctx)).rejects.toBe(error);
  });

  it.each([callSearch, callInspect, callPay])(
    "exports a bounded hints array for $name",
    (action) => {
      const json = z.toJSONSchema(action.output);
      expect(json.properties?.hints).toMatchObject({
        type: "array",
        maxItems: 4,
        items: { type: "string" },
      });
      expect(json.required).toContain("hints");
    },
  );
});

function context(surface: ActionContext["caller"]["surface"]): ActionContext {
  const page: MarketplaceDiscoveryPage = {
    protocol: "vapi.marketplace.discovery/1",
    rankingVersion: "marketplace-ranking-v1",
    items: [
      {
        ref: "weather",
        kind: "api",
        verification: "verified",
        provenance: "self_listed",
        execution: { mode: "direct" },
        card: { title: "Weather", summary: "Forecasts.", badges: [], facts: [] },
        action: { type: "invoke_api", href: "/call/weather" },
      },
    ],
    nextCursor: null,
    unavailableKinds: [],
  };
  return {
    config: getDefaultConfig(),
    clock: () => new Date("2026-10-18T00:00:00Z"),
    caller: { surface, run: createRunState() },
    call: {
      search: async () => page,
      inspect: async () => ({ ...inspected, verification: "verified", payment: null }),
      pay: async () => ({
        wallet: "main",
        status: 500,
        body: { error: "Unavailable" },
        payment: null,
      }),
    },
  };
}
