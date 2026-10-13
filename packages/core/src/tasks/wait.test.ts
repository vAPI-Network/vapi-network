import { afterEach, describe, expect, it, vi } from "vitest";

import type { TaskMilestone } from "./chain-port.js";
import { TasksClientError, type TasksClient } from "./client.js";
import type { GetOrderResponse } from "./types.js";
import { waitForMilestone } from "./wait.js";

const orderId = "10000000-0000-4000-8000-000000000001";
const milestoneId = "10000000-0000-4000-8000-000000000002";
const hash = `0x${"ab".repeat(32)}` as const;

afterEach(() => vi.useRealTimers());

function milestone(overrides: Partial<TaskMilestone> = {}): TaskMilestone {
  return {
    id: milestoneId,
    workOrderId: orderId,
    escrowState: null,
    fundingTxHash: null,
    settlementTxHash: null,
    delivery: null,
    ...overrides,
  } as TaskMilestone;
}

function harness(states: TaskMilestone[] = [milestone()]) {
  let clock = Date.parse("2026-10-08T12:00:00.000Z");
  let index = 0;
  const getOrder = vi.fn(async () => {
    const selected = states[Math.min(index++, states.length - 1)];
    return {
      workOrder: { version: "work-order-view-v1", id: orderId, milestones: [selected] },
    } as GetOrderResponse;
  });
  const client = { getOrder } as unknown as TasksClient;
  const sleep = vi.fn(async (ms: number) => {
    clock += ms;
  });
  const now = () => new Date(clock);
  return { client, getOrder, sleep, now };
}

describe("waitForMilestone", () => {
  it("polls immediately and reaches created after three polls and two injected sleeps", async () => {
    const created = milestone({ escrowState: "created" });
    const { client, getOrder, sleep, now } = harness([milestone(), milestone(), created]);

    const result = await waitForMilestone(client, {
      orderId,
      milestoneId,
      target: "created",
      sleep,
      now,
    });

    expect(result).toEqual({ reached: true, milestone: created, polls: 3, elapsedMs: 6_000 });
    expect(sleep.mock.calls).toEqual([[3_000], [3_000]]);
    expect(getOrder.mock.calls).toEqual(
      Array.from({ length: 3 }, () => [orderId, { signal: expect.any(AbortSignal) }]),
    );
  });

  it("returns the last milestone and poll count on timeout without exceeding the deadline", async () => {
    const pending = milestone();
    const { client, getOrder, sleep, now } = harness([pending]);

    const result = await waitForMilestone(client, {
      orderId,
      milestoneId,
      target: "created",
      timeoutMs: 6_500,
      sleep,
      now,
    });

    expect(result).toEqual({ reached: false, milestone: pending, polls: 3, elapsedMs: 6_500 });
    expect(getOrder).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls).toEqual([[3_000], [3_000], [500]]);
  });

  it("accepts submitted as beyond the locked target", async () => {
    const submitted = milestone({ escrowState: "submitted" });
    const { client, sleep, now } = harness([submitted]);

    await expect(
      waitForMilestone(client, { orderId, milestoneId, target: "locked", sleep, now }),
    ).resolves.toEqual({ reached: true, milestone: submitted, polls: 1, elapsedMs: 0 });
    expect(sleep).not.toHaveBeenCalled();
  });

  it("does not start another poll when an injected sleep passes the deadline", async () => {
    const { client, getOrder, sleep, now } = harness();
    const delayedSleep = vi.fn(async (ms: number) => sleep(ms + 1));

    const result = await waitForMilestone(client, {
      orderId,
      milestoneId,
      target: "created",
      timeoutMs: 6_000,
      sleep: delayedSleep,
      now,
    });

    expect(result).toMatchObject({ reached: false, polls: 2, elapsedMs: 6_001 });
    expect(getOrder).toHaveBeenCalledTimes(2);
    expect(delayedSleep.mock.calls).toEqual([[3_000], [2_999]]);
  });

  it("propagates a poll's TasksClientError without sleeping or retrying", async () => {
    const { client, getOrder, sleep, now } = harness();
    const error = new TasksClientError("http", "Private order access denied.", 403);
    getOrder.mockRejectedValueOnce(error);

    await expect(
      waitForMilestone(client, { orderId, milestoneId, target: "created", sleep, now }),
    ).rejects.toBe(error);
    expect(getOrder).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });

  it("does not start a poll at a zero-length deadline", async () => {
    const { client, getOrder, sleep, now } = harness();
    await expect(
      waitForMilestone(client, {
        orderId,
        milestoneId,
        target: "created",
        timeoutMs: 0,
        sleep,
        now,
      }),
    ).resolves.toMatchObject({ reached: false, polls: 0, elapsedMs: 0 });
    expect(getOrder).not.toHaveBeenCalled();
  });

  it("aborts an in-flight poll at the remaining deadline and returns the last indexed state", async () => {
    vi.useFakeTimers();
    const { client, getOrder } = harness();
    const pending = milestone();
    getOrder.mockResolvedValueOnce({
      workOrder: { version: "work-order-view-v1", id: orderId, milestones: [pending] },
    } as GetOrderResponse);
    getOrder.mockImplementationOnce(async (_id?: string, options?: { signal?: AbortSignal }) => {
      const signal = options?.signal;
      expect(signal).toBeInstanceOf(AbortSignal);
      return await new Promise<never>((_resolve, reject) => {
        signal!.addEventListener("abort", () => reject(new TasksClientError("timeout", "aborted")));
      });
    });
    const waiting = waitForMilestone(client, {
      orderId,
      milestoneId,
      target: "created",
      timeoutMs: 6_000,
    });
    const assertion = expect(waiting).resolves.toMatchObject({
      reached: false,
      milestone: pending,
      polls: 2,
      elapsedMs: 6_000,
    });
    await vi.advanceTimersByTimeAsync(6_000);
    await assertion;
    expect(getOrder).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    { timeoutMs: -1 },
    { timeoutMs: Infinity },
    { intervalMs: 0 },
    { intervalMs: Infinity },
  ])("rejects invalid timing options %j before polling", async (timing) => {
    const { client, getOrder, sleep, now } = harness();
    await expect(
      waitForMilestone(client, { orderId, milestoneId, target: "created", sleep, now, ...timing }),
    ).rejects.toBeInstanceOf(RangeError);
    expect(getOrder).not.toHaveBeenCalled();
    expect(sleep).not.toHaveBeenCalled();
  });

  const predicates: {
    target: Parameters<typeof waitForMilestone>[1]["target"];
    fields: Partial<TaskMilestone>;
    reached: boolean;
  }[] = [
    { target: "created", fields: { escrowState: "expired" }, reached: true },
    { target: "created", fields: { escrowState: null }, reached: false },
    { target: "locked", fields: { escrowState: "locked" }, reached: true },
    { target: "locked", fields: { escrowState: "disputed" }, reached: true },
    { target: "locked", fields: { escrowState: "resolved" }, reached: true },
    { target: "locked", fields: { escrowState: "created", fundingTxHash: hash }, reached: false },
    { target: "locked", fields: { escrowState: "created" }, reached: false },
    { target: "locked", fields: { escrowState: "expired" }, reached: false },
    { target: "delivered", fields: { escrowState: "submitted" }, reached: true },
    { target: "delivered", fields: { escrowState: "disputed" }, reached: true },
    { target: "delivered", fields: { escrowState: "resolved" }, reached: true },
    {
      target: "delivered",
      fields: { escrowState: "locked", delivery: {} as NonNullable<TaskMilestone["delivery"]> },
      reached: false,
    },
    { target: "delivered", fields: { escrowState: "locked" }, reached: false },
    { target: "released", fields: { escrowState: "resolved" }, reached: true },
    {
      target: "released",
      fields: { escrowState: "submitted", settlementTxHash: hash },
      reached: false,
    },
    { target: "released", fields: { escrowState: "disputed" }, reached: false },
  ];
  it.each(predicates)("checks $target against $fields", async ({ target, fields, reached }) => {
    const { client, sleep, now } = harness([milestone(fields)]);
    const result = await waitForMilestone(client, {
      orderId,
      milestoneId,
      target,
      timeoutMs: 1,
      sleep,
      now,
    });
    expect(result.reached).toBe(reached);
    expect(result.polls).toBe(1);
    expect(sleep.mock.calls).toEqual(reached ? [] : [[1]]);
  });

  it("does not use a milestone from another parent order", async () => {
    const { client, sleep, now } = harness([
      milestone({ workOrderId: "10000000-0000-4000-8000-000000000003", escrowState: "created" }),
    ]);
    await expect(
      waitForMilestone(client, {
        orderId,
        milestoneId,
        target: "created",
        timeoutMs: 1,
        sleep,
        now,
      }),
    ).resolves.toEqual({ reached: false, milestone: undefined, polls: 1, elapsedMs: 1 });
  });
});
