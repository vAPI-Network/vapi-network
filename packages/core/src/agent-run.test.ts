import { describe, expect, it, vi } from "vitest";

import { createRunId, isRunId, RUN_ID_PATTERN, runRefSchema } from "./agent-run.js";

describe("agent run references", () => {
  it("creates a run id from exactly 12 injected random bytes", () => {
    const random = vi.fn(() => Uint8Array.from({ length: 12 }, (_, index) => index));

    expect(createRunId(random)).toBe("run_000102030405060708090a0b");
    expect(random).toHaveBeenCalledWith(12);
  });

  it("recognizes only canonical run ids", () => {
    const runId = "run_000102030405060708090a0b";

    expect(RUN_ID_PATTERN.test(runId)).toBe(true);
    expect(isRunId(runId)).toBe(true);
    expect(isRunId("run_000102030405060708090A0B")).toBe(false);
    expect(isRunId("run_00010203")).toBe(false);
    expect(isRunId(123)).toBe(false);
  });

  it("validates strict run descriptors", () => {
    const run = {
      id: "run_000102030405060708090a0b",
      swarm: "research",
      member: "research-lead-1",
      parentRunId: "run_111111111111111111111111",
    };

    expect(runRefSchema.parse(run)).toEqual(run);
    expect(() => runRefSchema.parse({ ...run, id: "run_ABC" })).toThrow();
    expect(() => runRefSchema.parse({ ...run, extra: true })).toThrow();
  });
});
