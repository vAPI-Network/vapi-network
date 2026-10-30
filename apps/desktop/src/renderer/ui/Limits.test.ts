// apps/desktop/src/renderer/ui/Limits.test.ts
import { describe, expect, it } from "vitest";

import { limitsState, PRESETS } from "./Limits.js";

const careful = { perCallAtomic: "1000000", perDayAtomic: "5000000" };

describe("limitsState", () => {
  it("recognises a preset and allows saving a new wallet", () => {
    const state = limitsState({ perCall: "1.00", perDay: "5.00", password: "" });
    expect(state.caps).toEqual(careful);
    expect(state.preset?.id).toBe(PRESETS[0].id);
    expect(state.raising).toBe(false);
    expect(state.unchanged).toBe(false);
    expect(state.canSave).toBe(true);
  });

  it("blocks saving invalid amounts and reports why", () => {
    const state = limitsState({ perCall: "abc", perDay: "5", password: "" });
    expect(state.caps).toBeUndefined();
    expect(state.parsed).toBe("Enter dollar amounts, like 1 or 0.50.");
    expect(state.canSave).toBe(false);
  });

  it("blocks saving when nothing changed on an existing wallet", () => {
    const state = limitsState({ perCall: "1", perDay: "5", current: careful, password: "" });
    expect(state.unchanged).toBe(true);
    expect(state.canSave).toBe(false);
  });

  it("asks for the password before a raise can be saved", () => {
    const without = limitsState({ perCall: "2", perDay: "5", current: careful, password: "" });
    expect(without.raising).toBe(true);
    expect(without.canSave).toBe(false);
    const withPassword = limitsState({
      perCall: "2",
      perDay: "5",
      current: careful,
      password: "hunter22",
    });
    expect(withPassword.canSave).toBe(true);
  });
});
