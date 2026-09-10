import { afterEach, describe, expect, it, vi } from "vitest";

import { calculateSweepAmount, getArcGasHeadroomAtomic } from "./sweep.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("sweep amount math", () => {
  it("sweeps a full Base USDC balance when headroom is zero", () => {
    expect(calculateSweepAmount(2_500_000n, 0n)).toBe(2_500_000n);
  });

  it("leaves Arc's default 0.05 USDC gas headroom", () => {
    vi.stubEnv("VAPI_ARC_GAS_HEADROOM_USDC", "");
    expect(getArcGasHeadroomAtomic()).toBe(50_000n);
    expect(calculateSweepAmount(2_500_000n, 50_000n)).toBe(2_450_000n);
    expect(calculateSweepAmount(40_000n, 50_000n)).toBe(0n);
  });

  it("parses configured Arc gas headroom as atomic USDC", () => {
    vi.stubEnv("VAPI_ARC_GAS_HEADROOM_USDC", "1.234567");
    expect(getArcGasHeadroomAtomic()).toBe(1_234_567n);
  });

  it("preserves the Arc gas headroom validation error", () => {
    vi.stubEnv("VAPI_ARC_GAS_HEADROOM_USDC", "1.2345678");
    expect(() => getArcGasHeadroomAtomic()).toThrow(
      "VAPI_ARC_GAS_HEADROOM_USDC must be a non-negative USDC amount with at most 6 decimals.",
    );
  });
});
