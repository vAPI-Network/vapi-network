import { expect, it } from "vitest";
import { DEFAULT_CAPS } from "./limits.js";

it("defaults to $1 per payment and $5 per day in atomic USDC", () => {
  expect(DEFAULT_CAPS).toEqual({ perCallAtomic: "1000000", perDayAtomic: "5000000" });
});
