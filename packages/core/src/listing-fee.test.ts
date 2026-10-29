import { describe, expect, it } from "vitest";

import { formatListingFee } from "./listing-fee.js";
import { listingFeeSchema } from "./marketplace-contracts.js";

describe("listing fee display", () => {
  it.each([
    [0, "No network fee", "No network fee"],
    [0, "Outdated fee label", "No network fee"],
    [
      500,
      "Network fee kept by this API's legacy payout splitter",
      "Network fee kept by this API's legacy payout splitter (5%)",
    ],
    [125, "Legacy payout fee", "Legacy payout fee (1.25%)"],
  ])("formats %i basis points without a default fee", (bps, label, display) => {
    const fee = listingFeeSchema.parse({ bps, label });
    expect(formatListingFee(fee)).toBe(display);
    expect(fee).toEqual({ bps, label });
  });
});
