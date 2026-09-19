import { describe, expect, it } from "vitest";

import { AGENT_MARKER_VARIABLES, activeAgentMarker, secretsAllowed } from "./agent-guard.js";

const TERMINAL = { stdinIsTTY: true, stdoutIsTTY: true };

describe("secretsAllowed", () => {
  it("allows a secret only on a bare terminal", () => {
    expect(secretsAllowed({}, TERMINAL)).toEqual({ allowed: true });
  });

  it("names the stream that is not a terminal", () => {
    expect(secretsAllowed({}, { stdinIsTTY: false, stdoutIsTTY: true })).toEqual({
      allowed: false,
      reason: "stdin is not a terminal.",
    });
    expect(secretsAllowed({}, { stdinIsTTY: true, stdoutIsTTY: false })).toEqual({
      allowed: false,
      reason: "stdout is not a terminal.",
    });
  });

  it("refuses for every documented agent marker, and names it", () => {
    for (const marker of AGENT_MARKER_VARIABLES) {
      expect(secretsAllowed({ [marker]: "1" }, TERMINAL)).toEqual({
        allowed: false,
        reason: `${marker} is set.`,
        marker,
      });
    }
    expect(AGENT_MARKER_VARIABLES).toEqual([
      "VAPI_NO_SECRETS",
      "CLAUDECODE",
      "CLAUDE_CODE",
      "CURSOR_AGENT",
      "CODEX_SANDBOX",
      "OPENAI_CODEX",
      "AGENT",
      "CI",
    ]);
  });

  it("treats an empty or blank marker as unset", () => {
    expect(secretsAllowed({ CI: "" }, TERMINAL)).toEqual({ allowed: true });
    expect(secretsAllowed({ CI: "  " }, TERMINAL)).toEqual({ allowed: true });
    expect(activeAgentMarker({ CI: "" })).toBeUndefined();
  });

  it("reports the first marker that is set", () => {
    expect(activeAgentMarker({ CI: "true", CLAUDECODE: "1" })).toBe("CLAUDECODE");
    expect(activeAgentMarker({ CI: "true" })).toBe("CI");
  });

  it("checks the streams before the environment", () => {
    expect(
      secretsAllowed({ VAPI_NO_SECRETS: "1" }, { stdinIsTTY: false, stdoutIsTTY: false }),
    ).toEqual({ allowed: false, reason: "stdin is not a terminal." });
  });
});
