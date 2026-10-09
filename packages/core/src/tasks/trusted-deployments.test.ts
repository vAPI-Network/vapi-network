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
