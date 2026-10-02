import { describe, expect, it } from "vitest";

import { createRunBudget, RunBudgetError } from "./run-budget.js";

describe("run budget", () => {
  it("reserves amounts within the limit", () => {
    const budget = createRunBudget({ id: "run_test", limitAtomic: 10n });

    budget.reserve(4n, "first");
    budget.reserve(5n, "second");

    expect(budget.spentAtomic()).toBe(9n);
  });

  it("reports the current amount for one reservation", () => {
    const budget = createRunBudget({ id: "run_test", limitAtomic: 10n });

    expect(budget.reservedAtomic("first")).toBe(0n);
    budget.reserve(4n, "first");
    budget.reserve(5n, "second");

    expect(budget.reservedAtomic("first")).toBe(4n);
    expect(budget.reservedAtomic("second")).toBe(5n);
    budget.release("first");
    expect(budget.reservedAtomic("first")).toBe(0n);
  });

  it("rejects a reservation past the limit without reserving it", () => {
    const budget = createRunBudget({ id: "run_test", limitAtomic: 10n });
    budget.reserve(6n, "first");

    expect(() => budget.reserve(5n, "too-much")).toThrowError(RunBudgetError);
    expect(() => budget.reserve(5n, "too-much-again")).toThrowError(
      expect.objectContaining({
        name: "RunBudgetError",
        code: "run_budget_exceeded",
        message: expect.stringContaining("spent 6 atomic USDC, limit 10 atomic USDC"),
      }),
    );
    expect(budget.spentAtomic()).toBe(6n);
  });

  it("releases exactly one reservation", () => {
    const budget = createRunBudget({ id: "run_test", limitAtomic: 10n });
    budget.reserve(3n, "first");
    budget.reserve(4n, "second");

    budget.release("first");

    expect(budget.spentAtomic()).toBe(4n);
  });

  it("rejects a duplicate reservation id with a plain Error", () => {
    const budget = createRunBudget({ id: "run_test", limitAtomic: 10n });
    budget.reserve(3n, "duplicate");

    const error = (() => {
      try {
        budget.reserve(2n, "duplicate");
        return undefined;
      } catch (failure) {
        return failure;
      }
    })();
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(RunBudgetError);
    expect(budget.spentAtomic()).toBe(3n);
  });

  it("rejects negative reservation amounts", () => {
    const budget = createRunBudget({ id: "run_test", limitAtomic: 10n });

    expect(() => budget.reserve(-1n, "negative")).toThrow("must be non-negative");
    expect(budget.spentAtomic()).toBe(0n);
  });

  it("treats release of an unknown id as a no-op", () => {
    const budget = createRunBudget({ id: "run_test", limitAtomic: 10n });
    budget.reserve(3n, "known");

    expect(() => budget.release("unknown")).not.toThrow();
    expect(budget.spentAtomic()).toBe(3n);
  });

  it("allows an exact-limit reservation", () => {
    const budget = createRunBudget({ id: "run_test", limitAtomic: 10n });

    budget.reserve(10n, "exact");

    expect(budget.spentAtomic()).toBe(10n);
  });
});
