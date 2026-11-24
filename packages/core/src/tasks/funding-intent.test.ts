import { describe, expect, it } from "vitest";
import { EIP3009_AUTHORIZATION_TYPES } from "../x402.js";
import { taskFundingIntentNonce } from "./funding-intent.js";
const types = { ReceiveWithAuthorization: EIP3009_AUTHORIZATION_TYPES.TransferWithAuthorization };
const from = "0x1111111111111111111111111111111111111111";
const to = "0x2222222222222222222222222222222222222222";
const token = "0x3333333333333333333333333333333333333333";
const domain = { name: "USDC", version: "2", chainId: 84532, verifyingContract: token } as const;
const nonce = `0x${"ab".repeat(32)}`;
const intent = {
  kind: "eip712",
  signer: from,
  typedData: {
    primaryType: "ReceiveWithAuthorization",
    domain,
    types,
    message: { from, to, value: "1000000", validAfter: "0", validBefore: "2000000000", nonce },
  },
};
const expected = {
  from,
  to,
  value: 1_000_000n,
  validBefore: 2_000_000_000n,
  domain,
  types,
} as const;
describe("hosted funding intent verification", () => {
  it("accepts the nonce only when every signing field matches verified local terms", () => {
    expect(taskFundingIntentNonce(intent, expected)).toBe(nonce);
  });
  it.each([
    { value: "1000001" },
    { to: from },
    { from: to },
    { validAfter: "1" },
    { validBefore: "2000000001" },
    { nonce: "0x12" },
  ])("rejects a forged authorization before signing %#", (patch) => {
    expect(() =>
      taskFundingIntentNonce(
        {
          ...intent,
          typedData: { ...intent.typedData, message: { ...intent.typedData.message, ...patch } },
        },
        expected,
      ),
    ).toThrow();
  });
  it.each([
    { chainId: 8453 },
    { verifyingContract: to },
    { name: "Another token" },
    { version: "1" },
  ])("rejects a substituted token domain %#", (patch) => {
    expect(() =>
      taskFundingIntentNonce(
        { ...intent, typedData: { ...intent.typedData, domain: { ...domain, ...patch } } },
        expected,
      ),
    ).toThrow();
  });
  it("rejects a substituted signer or type definition", () => {
    expect(() => taskFundingIntentNonce({ ...intent, signer: to }, expected)).toThrow();
    expect(() =>
      taskFundingIntentNonce(
        {
          ...intent,
          typedData: {
            ...intent.typedData,
            types: { TransferWithAuthorization: types.ReceiveWithAuthorization },
          },
        },
        expected,
      ),
    ).toThrow();
  });
});
