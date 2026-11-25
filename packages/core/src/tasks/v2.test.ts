import { describe, expect, it } from "vitest";
import { prepareTaskPost, parseTaskMilestone, parseTaskProof } from "./post-options.js";
import { agentProfileSchema } from "../agent-profile.js";
import { taskEventLine, taskEventState } from "./operation-support.js";
import { v2Events } from "./fixtures/tasks-v2.js";
const now = new Date("2026-10-08T12:00:00.000Z");

describe("Tasks v2 post terms", () => {
  it("keeps exact milestone amounts and accepts ISO and relative deadlines", () => {
    const milestones = [
      parseTaskMilestone("0.000001|First|3d", 1, now),
      parseTaskMilestone("1.234567|Second|2026-10-15T12:00:00Z", 2, now),
    ];
    const result = prepareTaskPost({ milestones, deadline: "7d" }, now);
    expect(result.amount).toBe(1_234_568n);
    expect(result.terms.milestones).toEqual(milestones);
    expect(milestones[0]!.deadlineAt).toBe("2026-10-11T12:00:00.000Z");
  });
  it("requires the API's three-hour lead for a task and for each of its milestones", () => {
    expect(() =>
      prepareTaskPost(
        {
          deadline: "3d",
          milestones: [
            parseTaskMilestone("1|First|3d", 1, now),
            parseTaskMilestone("1|Second|20m", 2, now),
          ],
        },
        now,
      ),
    ).toThrow("Milestone deadlines must be at least 3 hours from now");
    // The API measures from when the post arrives (MIN_WORK_TIME 1 h + award margin 1 h +
    // funding lead 1 h), so the bare three hours are refused too.
    for (const deadline of ["20m", "2h", "3h", "180m"])
      expect(() => prepareTaskPost({ deadline, amountUsd: "1" }, now), deadline).toThrow(
        "Task deadlines must be at least 3 hours from now when vAPI receives the post, so the task can still be funded and awarded. Use 181m or more.",
      );
    expect(prepareTaskPost({ deadline: "181m", amountUsd: "1" }, now).deadlineAt).toBe(
      new Date(now.getTime() + 181 * 60_000).toISOString(),
    );
    expect(() =>
      prepareTaskPost(
        { deadline: "3d", milestones: [parseTaskMilestone("1|First|2h", 1, now)] },
        now,
      ),
    ).toThrow("Milestone deadlines must be at least 3 hours from now");
    // Bounties, pools and legacy submissions posts keep the ten-minute floor.
    expect(
      prepareTaskPost({ shape: "bounty", deadline: "10m", rewardPerWinner: "1" }, now).terms.shape,
    ).toBe("bounty");
    expect(
      prepareTaskPost({ deadline: "10m", amountUsd: "1", intake: "submissions" }, now).amount,
    ).toBe(1_000_000n);
    // The exception ends where the callers start sending shape terms: the API reads those as a
    // task and asks for the three hours, so the client refuses them before the request.
    const legacy = { deadline: "30m", amountUsd: "1", intake: "submissions" as const };
    for (const withTerms of [
      { proofSpec: [{ preset: "text" as const }] },
      { checkin: "24h" as const },
      { milestones: [parseTaskMilestone("1|First|30m", 1, now)] },
    ])
      expect(
        () => prepareTaskPost({ ...legacy, ...withTerms }, now),
        JSON.stringify(withTerms),
      ).toThrow("deadlines must be at least 3 hours from now when vAPI receives the post");
    expect(() => prepareTaskPost({ ...legacy, shape: "task" }, now)).toThrow(
      "Task deadlines must be at least 3 hours from now",
    );
    expect(
      prepareTaskPost({ ...legacy, deadline: "181m", proofSpec: [{ preset: "text" }] }, now).terms
        .shape,
    ).toBe("task");
  });
  it("uses per-winner market budgets and total escrow amounts", () => {
    const result = prepareTaskPost(
      {
        shape: "bounty",
        deadline: "3d",
        winners: 3,
        rewardPerWinner: "0.000001",
        choiceWindowSeconds: 60,
      },
      now,
    );
    expect(result.amount).toBe(1n);
    expect(result.escrowAmount).toBe(3n);
    expect(result.terms.bounty).toEqual({
      winners: 3,
      rewardPerWinnerBaseUnits: "1",
      deadlineAt: "2026-10-11T12:00:00.000Z",
      choiceWindowSeconds: 60,
    });
  });
  it("defaults pool gate and verifier, and accepts explicit open checks", () => {
    expect(
      prepareTaskPost({ shape: "pool", deadline: "3d", rewardPerClaim: "2", budget: "10" }, now)
        .terms.pool,
    ).toEqual({
      rewardPerClaimBaseUnits: "2000000",
      budgetBaseUnits: "10000000",
      gate: "proven",
      verifier: "poster",
    });
    expect(
      prepareTaskPost(
        {
          shape: "pool",
          deadline: "3d",
          rewardPerClaim: "2",
          budget: "10",
          gate: "open",
          openCheck: "invite",
          verifier: "vapi",
        },
        now,
      ).terms.pool,
    ).toMatchObject({ gate: "open", openCheck: "invite", verifier: "vapi" });
  });
  it.each([
    { amountUsd: "1", milestones: [parseTaskMilestone("2|Done|3d", 1, now)] },
    {
      milestones: Array.from({ length: 6 }, (_, i) => parseTaskMilestone("1|Done|3d", i + 1, now)),
    },
    { shape: "bounty" as const, rewardPerWinner: "1", winners: 51 },
    { shape: "pool" as const, rewardPerClaim: "2", budget: "1" },
    { shape: "pool" as const, rewardPerClaim: "1", budget: "2", gate: "open" as const },
    { amountUsd: "1", rewardPerWinner: "1" },
  ])("rejects incompatible or inconsistent terms %#", (input) => {
    expect(() => prepareTaskPost({ ...input, deadline: "3d" }, now)).toThrow();
  });
  it.each(["link", "file", "x-post:vAPI: Tasks", "onchain-tx", "pr:approved", "text", "media"])(
    "parses proof shorthand %s",
    (text) => {
      expect(parseTaskProof(text).preset).toBe(text.split(":")[0]);
    },
  );
  it.each(["unknown", "file:hello", "text:hello", "link:"])("refuses invalid proof %s", (text) =>
    expect(() => parseTaskProof(text)).toThrow(),
  );
  it("already stores both task policy fields on the vault's agent profile", () => {
    const profile = agentProfileSchema.parse({
      version: 1,
      name: "agent",
      wallet: "main",
      model: "test",
      instructions: "",
      createdAt: now.toISOString(),
      maxPerTaskUsd: 42,
      autoReleaseBelowUsd: 0,
    });
    expect(profile).toMatchObject({ maxPerTaskUsd: 42, autoReleaseBelowUsd: 0 });
  });
  it("recognizes all recorded deck alerts without rewriting their payloads", () => {
    for (const event of v2Events) expect(taskEventState(event)).toBe(event.type.split(".")[1]);
    expect(taskEventLine({ sequence: 4, ...v2Events[3] })).toBe(
      "4: deadline passed, 3 submissions, pick winners",
    );
  });
});
