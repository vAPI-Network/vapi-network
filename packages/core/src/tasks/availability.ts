// SPDX-License-Identifier: Apache-2.0
// What the client takes from the hosted readiness document (GET /api/tasks/readiness) on a
// Tasks V2 path, and what it does not.
//
// The document is unauthenticated hosted data. It never establishes trust: which contracts
// may receive money is decided by the chain ID and addresses pinned in v2-trust.ts and by the
// on-chain checks in v2-plan-guard.ts. A hosted `configured: true` adds nothing to those, and a
// hosted address is never used as a V2 destination.
//
// So a V2 path reads two fields:
//   - `chainId`: the chain a prepared step must name, and the chain whose local pin is used
//     when no plan exists yet (ballot sealing). A local pin must exist for it.
//   - `configured`: an availability statement. It gates only the steps that start new work
//     (TASK_V2_NEW_WORK_ACTIONS): putting new USDC from this wallet into Tasks, and hiring.
//     Waiting costs those steps nothing. Money sent into a market the API reports as
//     unavailable can sit locked until a deadline passes, and an award turns an offer the
//     poster can still cancel into an engagement and collects the worker's bond. Every other
//     step acts on work that is already running: refunds, cancellations, payouts, disputes
//     with their deadline, jury steps and votes. Refusing those because of a hosted flag could
//     strand the user's own money, so they are not gated.
import type { TasksClient } from "./client.js";
import { TaskOperationError } from "./operation-support.js";

export type TasksReadiness = Awaited<ReturnType<TasksClient["deployment"]>>;

/**
 * Steps that start new work: they move new USDC from the acting wallet into an escrow at its
 * own choice, or hire a worker (the worker's consent and the poster's award).
 */
export const TASK_V2_NEW_WORK_ACTIONS: readonly string[] = [
  "fund",
  "approve-bond",
  "award",
  "award-consent",
];

const NETWORK_NAMES: Readonly<Record<number, string>> = {
  8453: "Base",
  84532: "Base Sepolia",
  5042002: "Arc testnet",
};
/** A local name for a chain; hosted labels are never printed. */
export function taskNetworkName(chainId: number): string {
  return NETWORK_NAMES[chainId] ?? `chain ${chainId}`;
}

/** The refusal for a hosted `configured: false`. `untouched` says what did not happen. */
export function tasksUnavailableError(
  chainId: number,
  untouched = "Nothing was signed and no money moved.",
  code = "tasks_unavailable",
): TaskOperationError {
  return new TaskOperationError(
    code,
    `vAPI reports Tasks as unavailable on ${taskNetworkName(chainId)} right now. ${untouched} Try again later.`,
  );
}

/** The readiness document, or undefined when it cannot be fetched or parsed. */
export async function readTasksReadiness(
  client: Pick<TasksClient, "deployment">,
): Promise<TasksReadiness | undefined> {
  try {
    return await client.deployment();
  } catch {
    return undefined;
  }
}

/**
 * Refuses a step that starts new work while the API reports Tasks as unavailable or its
 * status cannot be read. Call it before anything is prepared, signed, sent or reserved.
 * Steps outside TASK_V2_NEW_WORK_ACTIONS always pass.
 */
export function requireTasksAvailable(
  action: string,
  readiness: TasksReadiness | undefined,
  untouched?: string,
): void {
  if (!TASK_V2_NEW_WORK_ACTIONS.includes(action)) return;
  if (!readiness)
    throw new TaskOperationError(
      "tasks_unavailable",
      `vAPI's Tasks status could not be read. ${untouched ?? "Nothing was signed and no money moved."} Try again later.`,
    );
  if (!readiness.configured) throw tasksUnavailableError(readiness.chainId, untouched);
}
