import { describe, expect, it } from "vitest";

import { formatBaseUnitsUsd, parseFeeBp, parseUsdToBaseUnits, taskMoney } from "./money.js";
import { tasksResponseSchemas } from "./types.js";

describe("task money", () => {
  it("computes gross, fee, and net in base units", () => {
    expect(taskMoney("100000000", 500)).toEqual({
      gross: { usd: "100.00", baseUnits: "100000000" },
      fee: { usd: "5.00", baseUnits: "5000000" },
      net: { usd: "95.00", baseUnits: "95000000" },
      feeBp: 500,
      line: "$100.00 gross · $5.00 fee · $95.00 net",
    });
  });

  it("supports zero fee and the full gross as fee", () => {
    expect(taskMoney(100000000n, 0).line).toBe("$100.00 gross · $0.00 fee · $100.00 net");
    expect(taskMoney(100000000n, 10000).net?.baseUnits).toBe("0");
  });

  it("never guesses an unavailable fee", () => {
    expect(taskMoney(100000000n, null)).toEqual({
      gross: { usd: "100.00", baseUnits: "100000000" },
      fee: null,
      net: null,
      feeBp: null,
      line: "$100.00 gross · fee unavailable",
    });
    for (const input of [undefined, null, {}, { configured: true }, { feeBp: null }]) {
      expect(parseFeeBp(input)).toBeNull();
    }
    expect(parseFeeBp({ feeBp: 0 })).toBe(0);
    expect(parseFeeBp({ feeBp: 500 })).toBe(500);
  });

  it.each([-1, 10001, 0.5, NaN, Infinity, "500"])("rejects invalid fee %s", (fee) => {
    expect(() => taskMoney(1n, fee as number)).toThrow();
    expect(() => parseFeeBp({ feeBp: fee })).toThrow();
  });

  it("floors the fee in atomic units and retains exact fractional USD", () => {
    expect(taskMoney(1000001n, 3333)).toMatchObject({
      gross: { usd: "1.000001", baseUnits: "1000001" },
      fee: { usd: "0.3333", baseUnits: "333300" },
      net: { usd: "0.666701", baseUnits: "666701" },
    });
    expect(formatBaseUnitsUsd(9007199254740993000001n)).toBe("9007199254740993.000001");
  });

  it("parses decimal USD without rounding", () => {
    expect(parseUsdToBaseUnits("100.000001")).toBe(100000001n);
    expect(parseUsdToBaseUnits("0")).toBe(0n);
    expect(formatBaseUnitsUsd("10000")).toBe("0.01");
    expect(formatBaseUnitsUsd(1n)).toBe("0.000001");
  });

  it.each(["", " ", "-1", "NaN", "Infinity", "1.0000001", "1e2", ".1"])(
    "rejects USD %s",
    (text) => {
      expect(() => parseUsdToBaseUnits(text)).toThrow();
    },
  );

  it.each([-1n, "-1", "1.2", ""])("rejects invalid base units %s", (amount) => {
    expect(() => taskMoney(amount, null)).toThrow();
  });

  it("keeps deployment fee optional and validates it when supplied", () => {
    const deployment = {
      configured: false,
      chainId: 84532,
      network: "eip155:84532",
      explorerUrl: null,
      capabilities: { erc3009Funding: false, vapiVerify: false },
      eip3009Domain: null,
    };
    expect(parseFeeBp(tasksResponseSchemas.deployment.parse(deployment))).toBeNull();
    expect(tasksResponseSchemas.deployment.parse({ ...deployment, feeBp: 500 }).feeBp).toBe(500);
    expect(tasksResponseSchemas.deployment.safeParse({ ...deployment, feeBp: 1.5 }).success).toBe(
      false,
    );
  });
});
