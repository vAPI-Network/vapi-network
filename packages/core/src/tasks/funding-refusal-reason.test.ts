import { describe, expect, it } from "vitest";
import { SpendCapExceededError } from "../spend-cap-exceeded.js";
import { SpendCapError } from "../spend-policy.js";
import { fundingRefusalReason } from "./operation-support.js";

describe("fundingRefusalReason", () => {
  it("maps the reservation's SpendCapError codes", () => {
    expect(fundingRefusalReason(new SpendCapError("per_day_cap_exceeded", "day"))).toBe(
      "policy.perDay",
    );
    expect(fundingRefusalReason(new SpendCapError("per_task_cap_exceeded", "task"))).toBe(
      "policy.perTask",
    );
  });

  it("maps a structured x402 cap error that wraps a reservation refusal", () => {
    // Another payment used the daily headroom between preflight and reservation.
    const wrapped = new SpendCapExceededError({
      cap: "per_day",
      amountUsd: "5",
      limitUsd: "10",
      cause: new SpendCapError("per_day_cap_exceeded", "day"),
    });
    expect(fundingRefusalReason(wrapped)).toBe("policy.perDay");
    const perTask = new SpendCapExceededError({
      cap: "max_amount",
      amountUsd: "5",
      limitUsd: "1",
      cause: new SpendCapError("per_task_cap_exceeded", "task"),
    });
    expect(fundingRefusalReason(perTask)).toBe("policy.perTask");
  });

  it("maps a structured per-day cap without a cause", () => {
    expect(
      fundingRefusalReason(
        new SpendCapExceededError({ cap: "per_day", amountUsd: "5", limitUsd: "1" }),
      ),
    ).toBe("policy.perDay");
  });

  it("leaves other errors alone", () => {
    expect(
      fundingRefusalReason(
        new SpendCapExceededError({ cap: "run_budget", amountUsd: "5", limitUsd: "1" }),
      ),
    ).toBeUndefined();
    expect(fundingRefusalReason(new Error("boom"))).toBeUndefined();
  });
});
