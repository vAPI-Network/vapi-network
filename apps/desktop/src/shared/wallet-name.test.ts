import { describe, expect, it } from "vitest";
import { isWalletName, walletNameSchema } from "./wallet-name.js";

describe("wallet names", () => {
  it.each(["a", "0", "research-bot", "a".repeat(32), "a-"])("accepts %j", (name) => {
    expect(isWalletName(name)).toBe(true);
    expect(walletNameSchema.parse(name)).toBe(name);
  });
  it.each([
    "",
    "a".repeat(33),
    "-leading",
    "UPPER",
    "has space",
    "a\n",
    "a\r",
    "a\t",
    "../escape",
    "a_b",
  ])("rejects %j", (name) => {
    expect(isWalletName(name)).toBe(false);
    expect(walletNameSchema.safeParse(name).success).toBe(false);
  });
});
