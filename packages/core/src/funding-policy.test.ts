import { describe, expect, it } from "vitest";

import { decideFunding, decideRelease } from "./funding-policy.js";

describe("task funding decisions", () => {
  const base = { amountUsd: 10, maxPerTaskUsd: 100, approveAboveUsd: 25, dayRemainingUsd: 200 };

  it.each([
    [{ amountUsd: 101 }, { ok: false, reason: "policy.perTask" }],
    [{ dayRemainingUsd: 9 }, { ok: false, reason: "policy.perDay" }],
    [{ amountUsd: 26 }, { approval: true }],
    [{}, { ok: true }],
    [
      { amountUsd: 101, dayRemainingUsd: 1 },
      { ok: false, reason: "policy.perTask" },
    ],
    [
      { amountUsd: 26, dayRemainingUsd: 1 },
      { ok: false, reason: "policy.perDay" },
    ],
    [{ amountUsd: 100, approveAboveUsd: 100 }, { ok: true }],
    [{ dayRemainingUsd: 10 }, { ok: true }],
    [{ amountUsd: 25 }, { ok: true }],
    [{ amountUsd: 0, maxPerTaskUsd: 0, dayRemainingUsd: 0, approveAboveUsd: 0 }, { ok: true }],
  ])("decides funding with %j", (overrides, expected) => {
    expect(decideFunding({ ...base, ...overrides })).toEqual(expected);
  });

  it.each([-1, NaN, Infinity, -Infinity])("rejects invalid amount %s", (amountUsd) => {
    expect(() => decideFunding({ ...base, amountUsd })).toThrow(Error);
  });
});

describe("task release decisions", () => {
  it.each([
    [24, { auto: true }],
    [25, { approval: true }],
    [26, { approval: true }],
    [0, { auto: true }],
  ])("decides release of $%s", (amountUsd, expected) => {
    expect(decideRelease({ amountUsd, autoReleaseBelowUsd: 25 })).toEqual(expected);
  });

  it("requires approval when the automatic threshold is zero", () => {
    expect(decideRelease({ amountUsd: 0, autoReleaseBelowUsd: 0 })).toEqual({ approval: true });
  });

  it.each([-1, NaN, Infinity, -Infinity])("rejects invalid amount %s", (amountUsd) => {
    expect(() => decideRelease({ amountUsd, autoReleaseBelowUsd: 25 })).toThrow(Error);
  });
});
