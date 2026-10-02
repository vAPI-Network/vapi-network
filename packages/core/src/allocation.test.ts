import { describe, expect, it } from "vitest";

import { planAllocation } from "./allocation.js";
import {
  AllocationError,
  RELAY_MAX_PER_TRANSFER_ATOMIC,
  type AllocationPlan,
} from "./allocation.js";

const POLICY = {
  balanceAtomic: 100_000_000n,
  perCallAtomic: 100_000_000n,
  perDayRemainingAtomic: 100_000_000n,
};

describe("planAllocation", () => {
  it.each([
    ["10.00", ["3.34", "3.33", "3.33"]],
    ["0.05", ["0.03", "0.01", "0.01"]],
    ["1.00", ["1.00"]],
  ])("puts the %s uneven-cent remainder on the first recipient", (amountUsd, amounts) => {
    const recipients = amounts.map((_, index) => `agent-${index + 1}`);
    expect(
      planAllocation({ strategy: "even", from: "owner", recipients, amountUsd, policy: POLICY }),
    ).toEqual({
      legs: recipients.map((to, index) => ({ to, amountUsd: amounts[index] })),
      blocked: [],
    });
  });

  it("rejects an amount whose even share is zero cents", () => {
    expect(() =>
      planAllocation({
        strategy: "even",
        from: "owner",
        recipients: ["one", "two"],
        amountUsd: "0.01",
        policy: POLICY,
      }),
    ).toThrow("Amount too small to split over 2 accounts.");
  });

  it("reports every policy-blocked leg instead of dropping it", () => {
    expect(
      planAllocation({
        strategy: "even",
        from: "owner",
        recipients: ["one", "two", "three"],
        amountUsd: "10.00",
        policy: { ...POLICY, perCallAtomic: 3_330_000n },
      }),
    ).toEqual({
      legs: [
        { to: "two", amountUsd: "3.33" },
        { to: "three", amountUsd: "3.33" },
      ],
      blocked: [{ to: "one", amountUsd: "3.34", reason: "per_call_cap_exceeded" }],
    });

    const daily = planAllocation({
      strategy: "even",
      from: "owner",
      recipients: ["one", "two"],
      amountUsd: "2.00",
      policy: { ...POLICY, perDayRemainingAtomic: 1_990_000n },
    });
    expect(daily.legs).toEqual([]);
    expect(daily.blocked).toEqual([
      { to: "one", amountUsd: "1.00", reason: "per_day_cap_exceeded" },
      { to: "two", amountUsd: "1.00", reason: "per_day_cap_exceeded" },
    ]);
  });
});

describe("planAllocation weights", () => {
  it.each([
    ["10.00", [2, 1, 1], ["5.00", "2.50", "2.50"]],
    ["0.10", [1, 1, 1], ["0.04", "0.03", "0.03"]],
    ["10.00", [4e-10, 6e-10], ["4.00", "6.00"]],
    ["10.00", [1e-12, 1e-12], ["5.00", "5.00"]],
  ])("splits %s by Hamilton largest remainder", (amountUsd, weights, amounts) => {
    const recipients = weights.map((weight, index) => ({ to: `agent-${index + 1}`, weight }));
    expect(
      planAllocation({ strategy: "weights", from: "owner", recipients, amountUsd, policy: POLICY }),
    ).toEqual({
      legs: recipients.map(({ to }, index) => ({
        from: "owner",
        to,
        amountUsd: amounts[index],
        purpose: "send",
      })),
      blocked: [],
    });
  });

  it("reports a zero-cent tiny-weight share as share_too_small", () => {
    expect(
      planAllocation({
        strategy: "weights",
        from: "owner",
        recipients: [
          { to: "tiny", weight: 1e-6 },
          { to: "main", weight: 1 },
        ],
        amountUsd: "1.00",
        policy: POLICY,
      }),
    ).toEqual({
      legs: [{ from: "owner", to: "main", amountUsd: "1.00", purpose: "send" }],
      blocked: [
        {
          from: "owner",
          to: "tiny",
          amountUsd: "0.00",
          purpose: "send",
          reason: "share_too_small",
        },
      ],
    });
  });

  it.each([
    ["17.43", [7, 3, 2, 1]],
    ["0.07", [11, 5, 3]],
    ["49.99", [0.25, 1.75, 9.5, 4.125]],
  ])("preserves the requested total for %s over random-looking weights", (amountUsd, weights) => {
    const plan = planAllocation({
      strategy: "weights",
      from: "owner",
      recipients: weights.map((weight, index) => ({ to: `agent-${index}`, weight })),
      amountUsd,
      policy: POLICY,
    });
    expect(planTotalCents(plan)).toBe(testUsdCents(amountUsd));
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])("rejects invalid weight %s", (weight) => {
    expectAllocationCode(
      () =>
        planAllocation({
          strategy: "weights",
          from: "owner",
          recipients: [{ to: "agent", weight }],
          amountUsd: "1.00",
          policy: POLICY,
        }),
      "invalid_weights",
    );
  });

  it("trims a recipient at its ceiling and blocks the excess", () => {
    expect(
      planAllocation({
        strategy: "weights",
        from: "owner",
        recipients: [
          { to: "capped", weight: 1, balanceAtomic: 4_000_000n, ceilingAtomic: 7_000_000n },
          { to: "open", weight: 1 },
        ],
        amountUsd: "10.00",
        policy: POLICY,
      }),
    ).toEqual({
      legs: [
        { from: "owner", to: "capped", amountUsd: "3.00", purpose: "send" },
        { from: "owner", to: "open", amountUsd: "5.00", purpose: "send" },
      ],
      blocked: [
        {
          from: "owner",
          to: "capped",
          amountUsd: "2.00",
          purpose: "send",
          reason: "recipient_ceiling",
        },
      ],
    });
  });

  it("blocks a whole recipient share when ceiling headroom is zero", () => {
    expect(
      planAllocation({
        strategy: "weights",
        from: "owner",
        recipients: [
          { to: "capped", weight: 1, balanceAtomic: "7000000", ceilingAtomic: "7000000" },
        ],
        amountUsd: "5.00",
        policy: POLICY,
      }).blocked,
    ).toEqual([
      {
        from: "owner",
        to: "capped",
        amountUsd: "5.00",
        purpose: "send",
        reason: "recipient_ceiling",
      },
    ]);
  });

  it.each([
    ["policy override", "2.00", { ...POLICY, relayMaxPerTransferAtomic: 1_990_000n }],
    ["default constant", "50.01", POLICY],
  ])("blocks a weights leg above the %s relay maximum", (_label, amountUsd, policy) => {
    expect(RELAY_MAX_PER_TRANSFER_ATOMIC).toBe(50_000_000n);
    expect(
      planAllocation({
        strategy: "weights",
        from: "owner",
        recipients: [{ to: "agent", weight: 1 }],
        amountUsd,
        policy,
      }).blocked,
    ).toEqual([
      {
        from: "owner",
        to: "agent",
        amountUsd,
        purpose: "send",
        reason: "relay_limit_exceeded",
      },
    ]);
  });

  it.each([
    ["balance", { ...POLICY, balanceAtomic: 1_990_000n }, "insufficient_balance"],
    ["per-day cap", { ...POLICY, perDayRemainingAtomic: 1_990_000n }, "per_day_cap_exceeded"],
  ])("globally blocks every weights leg for insufficient %s", (_label, policy, reason) => {
    const plan = planAllocation({
      strategy: "weights",
      from: "owner",
      recipients: [
        { to: "one", weight: 1 },
        { to: "two", weight: 1 },
      ],
      amountUsd: "2.00",
      policy,
    });
    expect(plan.legs).toEqual([]);
    expect(plan.blocked).toEqual([
      { from: "owner", to: "one", amountUsd: "1.00", purpose: "send", reason },
      { from: "owner", to: "two", amountUsd: "1.00", purpose: "send", reason },
    ]);
  });
});

describe("planAllocation targets", () => {
  it("orders mixed down legs before up legs", () => {
    expect(
      planAllocation({
        strategy: "targets",
        treasury: "treasury",
        members: [
          {
            account: "up",
            balanceAtomic: 1_000_000n,
            targetAtomic: 3_000_000n,
            ceilingAtomic: null,
          },
          {
            account: "down-one",
            balanceAtomic: 5_000_000n,
            targetAtomic: 2_000_000n,
            ceilingAtomic: null,
          },
          {
            account: "down-two",
            balanceAtomic: 4_000_000n,
            targetAtomic: 3_000_000n,
            ceilingAtomic: null,
          },
        ],
        policy: POLICY,
      }),
    ).toEqual({
      legs: [
        { from: "down-one", to: "treasury", amountUsd: "3.00", purpose: "sweep" },
        { from: "down-two", to: "treasury", amountUsd: "1.00", purpose: "sweep" },
        { from: "treasury", to: "up", amountUsd: "2.00", purpose: "send" },
      ],
      blocked: [],
    });
  });

  it.each([
    ["treasury balance", { ...POLICY, balanceAtomic: 6_000_000n }, "insufficient_balance"],
    [
      "treasury per-day remainder",
      { ...POLICY, perDayRemainingAtomic: 6_000_000n },
      "per_day_cap_exceeded",
    ],
  ])("trims the last up leg when %s runs out", (_label, policy, reason) => {
    expect(
      planAllocation({
        strategy: "targets",
        treasury: "treasury",
        members: [
          { account: "one", balanceAtomic: 0n, targetAtomic: 4_000_000n, ceilingAtomic: null },
          { account: "two", balanceAtomic: 0n, targetAtomic: 4_000_000n, ceilingAtomic: null },
        ],
        policy,
      }),
    ).toEqual({
      legs: [
        { from: "treasury", to: "one", amountUsd: "4.00", purpose: "send" },
        { from: "treasury", to: "two", amountUsd: "2.00", purpose: "send" },
      ],
      blocked: [{ from: "treasury", to: "two", amountUsd: "2.00", purpose: "send", reason }],
    });
  });

  it("blocks a whole up leg above the treasury per-call cap", () => {
    expect(
      planAllocation({
        strategy: "targets",
        treasury: "treasury",
        members: [
          { account: "member", balanceAtomic: 0n, targetAtomic: 4_000_000n, ceilingAtomic: null },
        ],
        policy: { ...POLICY, perCallAtomic: 3_000_000n },
      }),
    ).toEqual({
      legs: [],
      blocked: [
        {
          from: "treasury",
          to: "member",
          amountUsd: "4.00",
          purpose: "send",
          reason: "per_call_cap_exceeded",
        },
      ],
    });
  });

  it("clamps an up leg at the effective ceiling with the per-day floor", () => {
    expect(
      planAllocation({
        strategy: "targets",
        treasury: "treasury",
        members: [
          {
            account: "member",
            balanceAtomic: 1_000_000n,
            targetAtomic: 10_000_000n,
            ceilingAtomic: 3_000_000n,
            perDayCapAtomic: 5_000_000n,
          },
        ],
        policy: POLICY,
      }),
    ).toEqual({
      legs: [{ from: "treasury", to: "member", amountUsd: "4.00", purpose: "send" }],
      blocked: [
        {
          from: "treasury",
          to: "member",
          amountUsd: "5.00",
          purpose: "send",
          reason: "recipient_ceiling",
        },
      ],
    });
  });

  it("splits a down leg above the relay maximum", () => {
    expect(
      planAllocation({
        strategy: "targets",
        treasury: "treasury",
        members: [
          { account: "member", balanceAtomic: 60_000_000n, targetAtomic: 0n, ceilingAtomic: null },
        ],
        policy: POLICY,
      }),
    ).toEqual({
      legs: [
        {
          from: "member",
          to: "treasury",
          amountUsd: "50.00",
          purpose: "sweep",
        },
        { from: "member", to: "treasury", amountUsd: "10.00", purpose: "sweep" },
      ],
      blocked: [],
    });
  });

  it("omits sub-cent target differences", () => {
    const plan = planAllocation({
      strategy: "targets",
      treasury: "treasury",
      members: [
        { account: "up", balanceAtomic: 0n, targetAtomic: 9_999n, ceilingAtomic: null },
        { account: "down", balanceAtomic: "9999", targetAtomic: "0", ceilingAtomic: null },
      ],
      policy: POLICY,
    });
    expect(plan).toEqual({ legs: [], blocked: [] });
    expect(plan.legs.every((leg) => testUsdCents(leg.amountUsd) >= 1n)).toBe(true);
  });
});

describe("planAllocation new-strategy recipient validation", () => {
  it.each([
    [
      "empty weights recipients",
      () =>
        planAllocation({
          strategy: "weights",
          from: "owner",
          recipients: [],
          amountUsd: "1.00",
          policy: POLICY,
        }),
    ],
    [
      "duplicate weights recipients",
      () =>
        planAllocation({
          strategy: "weights",
          from: "owner",
          recipients: [
            { to: "agent", weight: 1 },
            { to: " agent ", weight: 1 },
          ],
          amountUsd: "1.00",
          policy: POLICY,
        }),
    ],
    [
      "blank weights sender",
      () =>
        planAllocation({
          strategy: "weights",
          from: " ",
          recipients: [{ to: "agent", weight: 1 }],
          amountUsd: "1.00",
          policy: POLICY,
        }),
    ],
    [
      "empty targets members",
      () =>
        planAllocation({ strategy: "targets", treasury: "treasury", members: [], policy: POLICY }),
    ],
    [
      "treasury among targets members",
      () =>
        planAllocation({
          strategy: "targets",
          treasury: "treasury",
          members: [
            {
              account: "treasury",
              balanceAtomic: 0n,
              targetAtomic: 1_000_000n,
              ceilingAtomic: null,
            },
          ],
          policy: POLICY,
        }),
    ],
  ])("rejects %s", (_label, plan) => {
    expectAllocationCode(plan, "invalid_recipients");
  });
});

function planTotalCents(plan: AllocationPlan): bigint {
  return [...plan.legs, ...plan.blocked].reduce(
    (total, leg) => total + testUsdCents(leg.amountUsd),
    0n,
  );
}

function testUsdCents(amountUsd: string): bigint {
  const [whole = "0", fraction = ""] = amountUsd.split(".");
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0") || "0");
}

function expectAllocationCode(operation: () => unknown, code: AllocationError["code"]): void {
  try {
    operation();
    throw new Error("Expected allocation planning to fail.");
  } catch (error) {
    expect(error).toBeInstanceOf(AllocationError);
    expect((error as AllocationError).code).toBe(code);
  }
}
