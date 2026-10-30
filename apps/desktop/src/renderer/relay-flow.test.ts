import { describe, expect, it } from "vitest";
import { formatCode, relayView } from "./relay-flow.js";

describe("relayView", () => {
  it("maps start and poll results", () => {
    expect(
      relayView({ mode: "browser", code: "123456", url: "https://x/agents", expiresAt: 1 }),
    ).toEqual({ kind: "code", code: "123456", url: "https://x/agents" });
    expect(relayView({ mode: "error", message: "no" })).toEqual({ kind: "error", message: "no" });
    expect(
      relayView({ state: "pending", purpose: "enroll", code: "1", url: "u", expiresAt: 2 }),
    ).toEqual({ kind: "code", code: "1", url: "u" });
    expect(relayView({ state: "enrolled" })).toEqual({ kind: "enrolled" });
    expect(relayView({ state: "approved", owner: "0xabc" })).toEqual({
      kind: "approved",
      owner: "0xabc",
    });
    expect(relayView({ state: "failed", message: "expired" })).toEqual({
      kind: "error",
      message: "expired",
    });
    expect(relayView({ state: "none" })).toEqual({ kind: "idle" });
  });
  it("groups the code in threes", () => {
    expect(formatCode("123456")).toBe("123 456");
  });
});
