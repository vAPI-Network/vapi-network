import { describe, expect, it } from "vitest";
import { createSiweMessage } from "viem/siwe";

import { siweRefusal } from "./siwe-policy.js";

const API_BASE = "https://api.vapinetwork.ai";
const ADDRESS = "0x8617E340B3D01FA5F11F306F4090FD50E238070D" as const;
const fields = {
  domain: new URL(API_BASE).host,
  uri: API_BASE,
  address: ADDRESS,
  version: "1",
  chainId: 8453,
  nonce: "abc12345",
  issuedAt: new Date("2026-10-28T10:00:00.000Z"),
} as const;

describe("siweRefusal", () => {
  it("allows an exact vAPI sign-in message for the signing wallet", () => {
    expect(siweRefusal(createSiweMessage(fields), API_BASE, ADDRESS)).toBeNull();
  });

  it.each([
    ["plain text", "hello"],
    ["another domain", createSiweMessage({ ...fields, domain: "evil.example" })],
    ["another URI origin", createSiweMessage({ ...fields, uri: "https://evil.example" })],
    [
      "another wallet",
      createSiweMessage({ ...fields, address: "0x0000000000000000000000000000000000000009" }),
    ],
    ["an extra trailing line", `${createSiweMessage(fields)}\nSign this too.`],
    ["another version", createSiweMessage(fields).replace("Version: 1", "Version: 2")],
    ["an empty nonce", createSiweMessage(fields).replace("Nonce: abc12345", "Nonce: ")],
  ])("refuses %s", (_reason, message) => {
    expect(siweRefusal(message, API_BASE, ADDRESS)).not.toBeNull();
  });
});
