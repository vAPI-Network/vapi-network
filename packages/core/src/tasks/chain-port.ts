import type { FrozenDeliveryManifest } from "./delivery-manifest.js";
import type { CreateEscrowResponse, GetOrderResponse } from "./types.js";

export type TaskMilestone = Extract<
  GetOrderResponse["workOrder"],
  { version: "work-order-view-v1" }
>["milestones"][number];

export type TasksChainResult = {
  txHash: `0x${string}`;
  operation: CreateEscrowResponse["operation"];
  milestone: Pick<TaskMilestone, "id" | "workOrderId" | "state" | "escrowState" | "resolution">;
};

export type TasksEscrowOperation = {
  escrowId: string;
  idempotencyKey: string;
  /** Avoid listing private orders when the caller already knows the parent. */
  orderId?: string;
};

/**
 * The adapter owns local signing, server preparation, exact plan broadcast, transaction
 * recording, receipt waiting, and reconciliation. escrowId is the milestone ID,
 * not the clone address. Use the supplied key to prepare one logical operation.
 * Derive stable keys for subsequent requests from that key, the operation and step.
 * A resolved result contains reconciled state, never a simulated transaction.
 * The adapter validates the active signer against the authenticated party,
 * plan.from, and operation.expectedActor, and checks the frozen funding amount.
 */
export interface TasksChain {
  readonly available: boolean;
  createEscrow(input: { orderId: string; idempotencyKey: string }): Promise<TasksChainResult>;
  /**
   * Sign EIP-3009 ReceiveWithAuthorization locally BEFORE preparing funding.
   * Once the authorization may have left the machine, failures must retain the
   * spend reservation even if no transaction was broadcast. Only a typed error
   * with broadcast:false and authorizationExposed:false permits rollback.
   */
  fund(input: TasksEscrowOperation & { grossBaseUnits: bigint }): Promise<TasksChainResult>;
  /** Prepare with manifest file IDs and exact note; verify the server's hash before broadcasting. */
  deliver(
    input: TasksEscrowOperation & { manifest: FrozenDeliveryManifest; note: string },
  ): Promise<TasksChainResult>;
  release(input: TasksEscrowOperation): Promise<TasksChainResult>;
  refund(input: TasksEscrowOperation): Promise<TasksChainResult>;
  dispute(input: TasksEscrowOperation & { evidenceHash: `0x${string}` }): Promise<TasksChainResult>;
  /** EIP-191 personal_sign over canonicalJson(scope.signingPayload), passed as a string. */
  signScopeMessage(message: string): Promise<`0x${string}`>;
}

/** Adapters must mark ambiguous submission and all post-broadcast failures true. */
export class TasksChainError extends Error {
  /** False only when the adapter proves no redeemable funding authorization left the machine. */
  readonly authorizationExposed: boolean;
  readonly transactionHash?: `0x${string}`;

  constructor(
    message: string,
    readonly broadcast: boolean,
    options?: ErrorOptions & { authorizationExposed?: boolean; transactionHash?: `0x${string}` },
  ) {
    super(message, options);
    this.name = "TasksChainError";
    // Unspecified exposure is uncertain, so funding keeps its reservation.
    this.authorizationExposed = options?.authorizationExposed ?? true;
    this.transactionHash = options?.transactionHash;
  }
}

export class TasksChainUnavailableError extends TasksChainError {
  readonly code = "chain_unavailable";

  constructor(readonly manifestHash?: `0x${string}`) {
    super("An acting wallet is required for task chain operations.", false, {
      authorizationExposed: false,
    });
    this.name = "TasksChainUnavailableError";
  }
}

async function unavailable(): Promise<never> {
  throw new TasksChainUnavailableError();
}

export const missingTasksChain: TasksChain = {
  available: false,
  createEscrow: unavailable,
  fund: unavailable,
  deliver: unavailable,
  release: unavailable,
  refund: unavailable,
  dispute: unavailable,
  signScopeMessage: unavailable,
};
