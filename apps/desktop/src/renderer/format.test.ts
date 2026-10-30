import { describe, expect, it } from "vitest";
import { formatUsd, parseUsdToAtomic, shortAddress } from "./format.js";

describe("formatUsd", () => {
  it("shows cents and keeps sub-cent API prices exact", () => {
    expect(formatUsd("2000000")).toBe("$2.00");
    expect(formatUsd("0")).toBe("$0.00");
    expect(formatUsd("2000")).toBe("$0.002");
    expect(formatUsd("1234567")).toBe("$1.234567");
    expect(formatUsd(25_000_000n)).toBe("$25.00");
  });
});

describe("parseUsdToAtomic", () => {
  it("accepts dollar amounts with up to six decimals", () => {
    expect(parseUsdToAtomic("5")).toBe("5000000");
    expect(parseUsdToAtomic("$0.25")).toBe("250000");
    expect(parseUsdToAtomic(" 1.000001 ")).toBe("1000001");
  });

  it("rejects empty, negative and over-precise input", () => {
    expect(parseUsdToAtomic("")).toBeUndefined();
    expect(parseUsdToAtomic("-1")).toBeUndefined();
    expect(parseUsdToAtomic("0.0000001")).toBeUndefined();
    expect(parseUsdToAtomic("abc")).toBeUndefined();
  });
});

describe("shortAddress", () => {
  it("keeps the first six and last four characters", () => {
    expect(shortAddress("0x9467C22197110Cb2cBEE9b62C5d8424B130035f5")).toBe("0x9467…35f5");
  });
});
