import type { TaskMilestone } from "./chain-port.js";
import type { TasksClient } from "./client.js";

/** Poll the authenticated order view without repeating a chain mutation. */
export async function waitForMilestone(
  client: TasksClient,
  input: {
    orderId: string;
    milestoneId: string;
    target: "created" | "locked" | "delivered" | "released";
    timeoutMs?: number;
    intervalMs?: number;
    sleep?: (ms: number) => Promise<void>;
    now?: () => Date;
  },
): Promise<{
  reached: boolean;
  milestone: TaskMilestone | undefined;
  polls: number;
  elapsedMs: number;
}> {
  const timeoutMs = input.timeoutMs ?? 120_000;
  const intervalMs = input.intervalMs ?? 3_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0)
    throw new RangeError("The milestone wait timeout must be non-negative and finite.");
  if (!Number.isFinite(intervalMs) || intervalMs <= 0)
    throw new RangeError("The milestone wait interval must be positive and finite.");
  const sleep = input.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = input.now ?? (() => new Date());
  const started = now().getTime();
  const deadline = started + timeoutMs;
  let polls = 0;
  let milestone: TaskMilestone | undefined;

  function result(reached: boolean) {
    return { reached, milestone, polls, elapsedMs: now().getTime() - started };
  }

  for (;;) {
    const remaining = deadline - now().getTime();
    if (remaining <= 0) return result(false);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), remaining);
    let response;
    polls++;
    try {
      response = await client.getOrder(input.orderId, { signal: controller.signal });
    } catch (error) {
      if (controller.signal.aborted) return result(false);
      throw error;
    } finally {
      clearTimeout(timer);
    }
    if (controller.signal.aborted || now().getTime() >= deadline) return result(false);
    const { workOrder } = response;
    milestone =
      workOrder.id === input.orderId && workOrder.version === "work-order-view-v1"
        ? workOrder.milestones.find(
            (item) => item.id === input.milestoneId && item.workOrderId === input.orderId,
          )
        : undefined;
    if (milestone && reachedTarget(milestone, input.target)) return result(true);
    await sleep(Math.min(intervalMs, deadline - now().getTime()));
  }
}

function reachedTarget(
  milestone: TaskMilestone,
  target: "created" | "locked" | "delivered" | "released",
): boolean {
  switch (target) {
    case "created":
      return milestone.escrowState !== null;
    case "locked":
      return ["locked", "submitted", "disputed", "resolved"].includes(milestone.escrowState ?? "");
    case "delivered":
      return ["submitted", "disputed", "resolved"].includes(milestone.escrowState ?? "");
    case "released":
      return milestone.escrowState === "resolved";
  }
}
