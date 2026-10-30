// apps/desktop/src/renderer/onboarding-steps.test.ts
import { describe, expect, it } from "vitest";

import { nextStep, STEP_LABELS, STEPS, stepLabels, stepStatus } from "./onboarding-steps.js";

describe("onboarding steps", () => {
  it("is four steps: welcome, control, protect, wallet", () => {
    expect(STEPS).toEqual(["welcome", "control", "protect", "wallet"]);
  });

  it("labels every step in order", () => {
    expect(stepLabels()).toEqual([
      "Welcome",
      "You are in control",
      "Protect",
      "First agent wallet",
    ]);
    expect(Object.keys(STEP_LABELS)).toHaveLength(STEPS.length);
  });

  it("walks forward and ends after the wallet step", () => {
    expect(nextStep("welcome")).toBe("control");
    expect(nextStep("control")).toBe("protect");
    expect(nextStep("protect")).toBe("wallet");
    expect(nextStep("wallet")).toBeUndefined();
  });

  it("marks earlier steps done, the current one current, later ones todo", () => {
    expect(stepStatus(0, 2)).toBe("done");
    expect(stepStatus(2, 2)).toBe("current");
    expect(stepStatus(3, 2)).toBe("todo");
  });
});
