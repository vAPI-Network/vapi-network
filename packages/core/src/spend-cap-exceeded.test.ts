import { describe, expect, it } from "vitest";

import { SpendCapExceededError } from "./spend-cap-exceeded.js";

describe("SpendCapExceededError", () => {
  it.each(["10", "20", "100"])(
    "keeps a per-call remedy valid with daily cap %s",
    (perDayLimitUsd) => {
      const error = new SpendCapExceededError({
        cap: "per_call",
        amountUsd: "20",
        limitUsd: "1",
        perDayLimitUsd,
        wallet: "main",
      });
      expect(error.command).toBe(
        `vapi accounts caps main --per-call 20${perDayLimitUsd === "10" ? " --per-day 20" : ""}`,
      );
      const day = error.command!.match(/--per-day (\S+)/u)?.[1] ?? perDayLimitUsd;
      expect(BigInt(day) >= 20n).toBe(true);
    },
  );
  it.each([
    {
      cap: "per_call" as const,
      input: { amountUsd: " 2.500000 ", limitUsd: " 2.00 ", wallet: "main" },
      command: "vapi accounts caps main --per-call 2.5",
    },
    {
      cap: "per_day" as const,
      input: { amountUsd: "2.5", limitUsd: "10", spentUsd: "8.25", wallet: "worker" },
      command: "vapi accounts caps worker --per-day 10.75",
    },
    {
      cap: "max_price" as const,
      input: { amountUsd: "2.5", limitUsd: "2" },
      command: "--max 2.5",
    },
    {
      cap: "max_amount" as const,
      input: { amountUsd: "2.5", limitUsd: "2" },
      command: null,
    },
    {
      cap: "run_budget" as const,
      input: { amountUsd: "2.5", limitUsd: "10", spentUsd: "8.25" },
      command: "--budget 10.75",
    },
  ])("formats $cap fields, command, and message", ({ cap, input, command }) => {
    const cause = new Error("legacy cause");
    const error = new SpendCapExceededError({ cap, ...input, cause });

    expect(error).toMatchObject({
      name: "SpendCapExceededError",
      code: "spend_cap_exceeded",
      retryable: false,
      cap,
      amountUsd: normalized(input.amountUsd),
      limitUsd: normalized(input.limitUsd),
      command,
      cause,
    });
    expect(error.message).toContain(`payment of $${error.amountUsd}`);
    expect(error.message).toContain(`$${error.limitUsd}`);
    expect(error.message).toContain("Nothing was signed.");
    if ("spentUsd" in input) expect(error.message).toContain(`from $${input.spentUsd}`);
    if (command) expect(error.message.endsWith(command)).toBe(true);
    if (cap === "max_price") expect(error.message).toContain("MCP call.pay takes maxPriceUsd");
    if (cap === "run_budget") {
      expect(error.message).toContain("vapi agent run");
      expect(error.message).toContain("vapi swarm run");
    }
  });

  it("explains today's spend and the exact cap increase", () => {
    const error = new SpendCapExceededError({
      cap: "per_day",
      amountUsd: "0.25",
      limitUsd: "1.00",
      spentUsd: "0.90",
      wallet: "main",
    });

    expect(error.message).toBe(
      "Blocked by the per-day spend cap of account main: this payment of $0.25 would raise today's spend from $0.9 to $1.15, above $1. Nothing was signed. Raise it with: vapi accounts caps main --per-day 1.15",
    );
  });

  it("uses the literal account placeholder and emits stable JSON without its cause", () => {
    const error = new SpendCapExceededError({
      cap: "per_call",
      amountUsd: "1",
      limitUsd: "0.5",
      cause: new Error("private detail"),
    });

    expect(error.command).toBe("vapi accounts caps <account> --per-call 1");
    expect(error.toJSON()).toEqual({
      code: "spend_cap_exceeded",
      cap: "per_call",
      amountUsd: "1",
      limitUsd: "0.5",
      command: "vapi accounts caps <account> --per-call 1",
      message: error.message,
    });
    expect(JSON.stringify(error)).not.toContain("private detail");
  });
});

function normalized(value: string): string {
  const trimmed = value.trim();
  return trimmed.includes(".") ? trimmed.replace(/0+$/u, "").replace(/\.$/u, "") : trimmed;
}
