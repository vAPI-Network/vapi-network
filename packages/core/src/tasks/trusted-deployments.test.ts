import { describe, expect, it } from "vitest";

import { getTrustedTasksFactory } from "./trusted-deployments.js";

describe("trusted Tasks deployments", () => {
  it("pins the Base Sepolia escrow factory", () => {
    expect(getTrustedTasksFactory(84532)).toBe("0x6Ba83621eb386B3E093032096251cA504F6ee033");
  });

  it("has no implicit Base mainnet or Arc factory", () => {
    expect(getTrustedTasksFactory(8453)).toBeUndefined();
    expect(getTrustedTasksFactory(5042002)).toBeUndefined();
  });

  it("prefers and validates a configured override", () => {
    expect(
      getTrustedTasksFactory(84532, {
        "84532": "0x1111111111111111111111111111111111111111",
      }),
    ).toBe("0x1111111111111111111111111111111111111111");
    expect(() => getTrustedTasksFactory(84532, { "84532": "invalid" })).toThrow(/is invalid/i);
  });
});

import { getTrustedTasksDurations } from "./trusted-deployments.js";

it("pins duration defaults and accepts only explicit local overrides", () => {
  expect(getTrustedTasksDurations(84532)).toEqual({
    workDurationSeconds: 604800,
    reviewWindowSeconds: 604800,
  });
  expect(getTrustedTasksDurations(8453)).toEqual({
    workDurationSeconds: undefined,
    reviewWindowSeconds: undefined,
  });
  expect(
    getTrustedTasksDurations(84532, {
      "84532": { workDurationSeconds: 1200, reviewWindowSeconds: 600 },
    }),
  ).toEqual({ workDurationSeconds: 1200, reviewWindowSeconds: 600 });
  expect(() => getTrustedTasksDurations(84532, { "84532": { workDurationSeconds: 0 } })).toThrow(
    /positive integer seconds/,
  );
});
