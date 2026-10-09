import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { readSpendLedger, reserveSpend, type SpendKind } from "../spend-policy.js";
import { disputeTask, type DisputeTaskInput } from "./actions.js";
import { TasksChainError, type TasksChain } from "./chain-port.js";
import type { TasksClient } from "./client.js";
import { taskFeeReservationKey } from "./dispute-fee.js";
import { createPendingTransactions } from "./pending-transactions.js";

const orderId = "10000000-0000-4000-8000-000000000001";
const milestoneId = "10000000-0000-4000-8000-000000000002";
const key = "10000000-0000-4000-8000-000000000003";
const evidenceHash = `0x${"ab".repeat(32)}`;
const date = new Date("2026-10-09T00:00:00.000Z");
const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

async function setup(overrides: Record<string, unknown> = {}) {
  const home = await mkdtemp(join(tmpdir(), "vapi-dispute-policy-"));
  homes.push(home);
  const ledgerPath = join(home, "spend-ledger.json");
  const pending = createPendingTransactions(home);
  const result = {
    txHash: `0x${"cd".repeat(32)}`,
    operation: { state: "confirmed" },
    milestone: { id: milestoneId, workOrderId: orderId },
  };
  const dispute = vi.fn(async (_operation: { beforeSign?: () => Promise<void> }) => result);
  const client = {
    getOrder: vi.fn(async () => ({
      workOrder: {
        version: "work-order-view-v1",
        id: orderId,
        milestones: [
          {
            id: milestoneId,
            workOrderId: orderId,
            amountBaseUnits: "100000000",
            escrowState: "locked",
          },
        ],
      },
    })),
    deployment: vi.fn(async () => ({ configured: true, feeBp: 0 })),
  } as unknown as TasksClient;
  const chain = {
    available: true,
    dispute,
    disputeFee: vi.fn(async () => 20_000_000n),
  } as unknown as TasksChain;
  const input = {
    client,
    chain,
    pending,
    orderId,
    escrowId: milestoneId,
    evidenceHash,
    policy: { maxPerTaskUsd: 100, approveAboveUsd: 100 },
    caps: { perCallAtomic: "1", perDayAtomic: "100000000" },
    wallet: "main",
    ledgerPath,
    now: () => date,
    idempotencyKey: () => key,
    ...overrides,
  } as unknown as DisputeTaskInput;
  return { home, ledgerPath, pending, dispute, input };
}

describe("dispute fee spend policy", () => {
  it("refuses a fee above the per-task cap before signing", async () => {
    const x = await setup({ policy: { maxPerTaskUsd: 19, approveAboveUsd: 100 } });
    expect(await disputeTask(x.input)).toMatchObject({
      outcome: "refused",
      reason: "policy.perTask",
    });
    expect(x.dispute).not.toHaveBeenCalled();
  });
  it("does not create a reservation identity when fee policy refuses", async () => {
    const x = await setup({ policy: { maxPerTaskUsd: 19, approveAboveUsd: 100 } });
    await disputeTask(x.input);
    expect(
      await x.pending.existingReservationId!(taskFeeReservationKey(milestoneId, "dispute")),
    ).toBeUndefined();
  });
  it("refuses a fee above the daily cap before signing", async () => {
    const x = await setup({ caps: { perCallAtomic: "1", perDayAtomic: "19000000" } });
    expect(await disputeTask(x.input)).toMatchObject({
      outcome: "refused",
      reason: "policy.perDay",
    });
    expect(x.dispute).not.toHaveBeenCalled();
  });
  it("requires approval above the threshold without signing", async () => {
    const x = await setup({ policy: { maxPerTaskUsd: 100, approveAboveUsd: 19 } });
    expect(await disputeTask(x.input)).toMatchObject({
      outcome: "approval_needed",
      disputeFee: { usd: "20.00" },
    });
    expect(x.dispute).not.toHaveBeenCalled();
  });
  it("reserves verified fee against daily spend with dispute-fee kind", async () => {
    const x = await setup();
    expect(await disputeTask(x.input)).toMatchObject({
      outcome: "done",
      disputeFee: { baseUnits: "20000000" },
    });
    expect((await readSpendLedger(x.ledgerPath, date)).spentAtomic).toBe("20000000");
    expect(await readFile(x.ledgerPath, "utf8")).toContain('"kind": "dispute-fee"');
  });
  it("retains the fee reservation after ambiguous broadcast", async () => {
    const x = await setup();
    x.dispute.mockRejectedValueOnce(new TasksChainError("RPC uncertain", true));
    await expect(disputeTask(x.input)).rejects.toThrow("RPC uncertain");
    expect((await readSpendLedger(x.ledgerPath, date)).spentAtomic).toBe("20000000");
  });
  it("releases the fee reservation after a preflight failure before signing", async () => {
    const x = await setup();
    x.dispute.mockRejectedValueOnce(
      new TasksChainError("preflight refused", false, { authorizationExposed: false }),
    );
    await expect(disputeTask(x.input)).rejects.toThrow("preflight refused");
    expect((await readSpendLedger(x.ledgerPath, date)).spentAtomic).toBe("0");
  });
  it("resumes an exposed preparation without rechecking a lowered policy", async () => {
    const x = await setup();
    x.dispute.mockRejectedValueOnce(new TasksChainError("RPC uncertain", true));
    await expect(disputeTask(x.input)).rejects.toThrow();
    await x.pending.putPreparation(milestoneId, "dispute", {
      idempotencyKey: key,
      inputs: { evidenceHash },
    });
    const resumed = { ...x.input, policy: { maxPerTaskUsd: 0, approveAboveUsd: 0 } };
    expect(await disputeTask(resumed)).toMatchObject({ outcome: "done" });
    expect((await readSpendLedger(x.ledgerPath, date)).spentAtomic).toBe("20000000");
  });
  it("reconciles a submitted fee action without a local reservation or new approval", async () => {
    const x = await setup({
      policy: { maxPerTaskUsd: 0, approveAboveUsd: 0 },
      caps: { perCallAtomic: "0", perDayAtomic: "0" },
    });
    const reply = await x.input.client.getOrder(orderId);
    if (reply.workOrder.version !== "work-order-view-v1")
      throw new Error("fixture must be private");
    reply.workOrder.milestones[0]!.chainOperation = {
      kind: "escrow-dispute",
      state: "submitted",
    } as (typeof reply.workOrder.milestones)[number]["chainOperation"];
    vi.mocked(x.input.client.getOrder).mockResolvedValue(reply);
    expect(await disputeTask(x.input)).toMatchObject({ outcome: "done" });
    expect((await readSpendLedger(x.ledgerPath, date)).spentAtomic).toBe("0");
  });
  it("checks current policy before a new signature from a saved preparation", async () => {
    const x = await setup();
    const done = await disputeTask(x.input);
    if (done.outcome !== "done") throw new Error("fixture policy must approve");
    await x.pending.putPreparation(milestoneId, "dispute", {
      idempotencyKey: key,
      inputs: { evidenceHash },
    });
    let signed = false;
    x.dispute.mockImplementationOnce(async (operation) => {
      await operation.beforeSign?.();
      signed = true;
      return done.result as unknown as Awaited<ReturnType<typeof x.dispute>>;
    });
    expect(
      await disputeTask({ ...x.input, policy: { maxPerTaskUsd: 0, approveAboveUsd: 0 } }),
    ).toMatchObject({ outcome: "refused", reason: "policy.perTask" });
    expect(signed).toBe(false);
  });
  it("reserves today's fee before a new signature from an unexposed prior-day preparation", async () => {
    const x = await setup();
    const done = await disputeTask(x.input);
    if (done.outcome !== "done") throw new Error("fixture policy must approve");
    await x.pending.putPreparation(milestoneId, "dispute", {
      idempotencyKey: key,
      inputs: { evidenceHash },
    });
    x.dispute.mockImplementationOnce(async (operation) => {
      await operation.beforeSign?.();
      return done.result as unknown as Awaited<ReturnType<typeof x.dispute>>;
    });
    const nextDay = new Date("2026-10-10T00:00:00.000Z");
    expect(await disputeTask({ ...x.input, now: () => nextDay })).toMatchObject({
      outcome: "done",
    });
    expect((await readSpendLedger(x.ledgerPath, nextDay)).spentAtomic).toBe("20000000");
  });
  it("dispute-fee reservations enforce per-task rather than per-call cap", async () => {
    const x = await setup();
    await expect(
      reserveSpend(
        20_000_000n,
        { perCallAtomic: "1", perDayAtomic: "100000000" },
        {
          kind: "dispute-fee" as SpendKind,
          maxPerTaskAtomic: 19_000_000n,
          ledgerPath: x.ledgerPath,
          now: date,
        },
      ),
    ).rejects.toMatchObject({ code: "per_task_cap_exceeded" });
  });
});
