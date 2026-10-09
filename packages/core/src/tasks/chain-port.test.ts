import { describe, expect, it } from "vitest";

import { missingTasksChain, TasksChainError } from "./chain-port.js";

describe("missing task chain", () => {
  it("makes every operation unavailable without reporting success", async () => {
    const idempotencyKey = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const escrowId = "22222222-2222-4222-8222-222222222222";
    expect(missingTasksChain.available).toBe(false);
    const calls = [
      () => missingTasksChain.createEscrow({ orderId: escrowId, idempotencyKey }),
      () => missingTasksChain.fund({ escrowId, grossBaseUnits: 1n, idempotencyKey }),
      () =>
        missingTasksChain.deliver({
          escrowId,
          manifest: {
            manifest: { files: [], noteSha256: "ab".repeat(32) },
            manifestHash: `0x${"ab".repeat(32)}`,
          },
          note: "Delivery",
          idempotencyKey,
        }),
      () => missingTasksChain.release({ escrowId, idempotencyKey }),
      () => missingTasksChain.refund({ escrowId, idempotencyKey }),
      () =>
        missingTasksChain.dispute({
          escrowId,
          evidenceHash: `0x${"ab".repeat(32)}`,
          idempotencyKey,
        }),
      () => missingTasksChain.signScopeMessage("{}"),
    ];
    for (const call of calls) {
      await expect(call()).rejects.toMatchObject({
        code: "chain_unavailable",
        message: "An acting wallet is required for task chain operations.",
        broadcast: false,
        authorizationExposed: false,
      });
    }
  });

  it("records whether submission may have broadcast", () => {
    expect(new TasksChainError("Submission uncertain", true).broadcast).toBe(true);
    expect(new TasksChainError("Signing refused", false).broadcast).toBe(false);
  });

  it("defaults funding authorization exposure to uncertain until explicitly ruled out", () => {
    expect(new TasksChainError("Preparation failed", false).authorizationExposed).toBe(true);
    expect(
      new TasksChainError("Signing refused", false, { authorizationExposed: false })
        .authorizationExposed,
    ).toBe(false);
  });
});
