import { expect, it } from "vitest";
import { disputeFeeBaseUnits, taskFeeReservationKey } from "./dispute-fee.js";

it.each([
  [0n, 20_000_000n],
  [199_999_999n, 20_000_000n],
  [200_000_000n, 20_000_000n],
  [200_000_009n, 20_000_000n],
  [200_000_010n, 20_000_001n],
  [1_000_000_000n, 100_000_000n],
  [5_000_000_000n, 500_000_000n],
  [5_000_000_010n, 500_000_000n],
])("clamps the server dispute fee rule for amount %s", (amount, fee) =>
  expect(disputeFeeBaseUnits(amount)).toBe(fee),
);
it("keeps the two fee action reservations distinct from funding", () => {
  const id = "10000000-0000-4000-8000-000000000001";
  const dispute = taskFeeReservationKey(id, "dispute");
  const counter = taskFeeReservationKey(id, "counter-evidence");
  expect(dispute).not.toBe(id);
  expect(counter).not.toBe(dispute);
  expect(taskFeeReservationKey(id, "dispute")).toBe(dispute);
});
