import { createHash } from "node:crypto";
import { readFile, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { withFileLock, writeJsonAtomic } from "../atomic-file.js";
import { releaseSpend } from "../spend-policy.js";
import type { WalletName } from "../wallet-name.js";
import type { TasksChain, VerifiedFundingCoordinates, FundingAuthorization } from "./chain-port.js";
import type { TasksClient } from "./client.js";
import { createPendingTransactions, type PendingTransactions } from "./pending-transactions.js";
import { TaskOperationError } from "./operation-support.js";

const coordinates = z.object({
  network: z.string().regex(/^eip155:[1-9][0-9]*$/u),
  asset: z.string().regex(/^0x[0-9a-fA-F]{40}$/u),
  payTo: z.string().regex(/^0x[0-9a-fA-F]{40}$/u),
  poster: z.string().regex(/^0x[0-9a-fA-F]{40}$/u),
  amount: z.string().regex(/^[1-9][0-9]*$/u),
});
const attemptSchema = z
  .object({
    version: z.literal(1),
    taskId: z.string(),
    milestoneId: z.string(),
    wallet: z.string(),
    protocol: z.enum(["x402", "intent"]),
    state: z.enum(["preparing", "authorization", "funded"]),
    amount: z.string().regex(/^[1-9][0-9]*$/u),
    reservationId: z.string().min(1),
    reservedOn: z.string(),
    coordinates: coordinates.optional(),
    nonce: z
      .string()
      .regex(/^0x[0-9a-fA-F]{64}$/u)
      .optional(),
    validBefore: z
      .string()
      .regex(/^(0|[1-9][0-9]*)$/u)
      .optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.state !== "authorization" ||
      Boolean(
        value.coordinates &&
        value.coordinates.amount === value.amount &&
        value.nonce &&
        value.validBefore,
      ),
  );
export type FundingAttempt = z.infer<typeof attemptSchema>;

export type FundingAttemptJournal = {
  record(input: {
    protocol: "x402" | "intent";
    amount: string;
    reservationId: string;
    reservedOn: string;
    authorization?: FundingAuthorization;
  }): Promise<void>;
  abandonUnsent(): Promise<void>;
};

/** One durable, cross-process gate for BOTH payment protocols, keyed by task and milestone within the vault.
 * A crash after writing the intent is uncertain even if exposure was never marked.
 */
export async function withFundingAttempt<T>(
  input: {
    ledgerPath: string;
    wallet: WalletName;
    taskId: string;
    milestoneId: string;
    client: TasksClient;
    chain: TasksChain;
    pending?: PendingTransactions;
    now: () => Date;
  },
  operation: (journal: FundingAttemptJournal) => Promise<T>,
): Promise<T> {
  const key = createHash("sha256").update(`${input.taskId}:${input.milestoneId}`).digest("hex");
  const path = join(dirname(input.ledgerPath), "tasks", `funding-${key}.json`);
  return withFileLock(
    `${path}.lock`,
    async () => {
      let current: FundingAttempt | undefined;
      try {
        current = attemptSchema.parse(JSON.parse(await readFile(path, "utf8")));
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
      const save = async (value: FundingAttempt) => {
        await writeJsonAtomic(path, attemptSchema.parse(value));
        current = value;
      };
      if (current) {
        if (
          current.taskId !== input.taskId ||
          current.milestoneId !== input.milestoneId ||
          current.wallet !== input.wallet
        )
          throw new TaskOperationError(
            "funding_unresolved",
            "The stored funding attempt has a different identity.",
          );
        if (current.state !== "funded") {
          const { workOrder } = await input.client.getOrder(input.taskId);
          const funded =
            workOrder.id === input.taskId &&
            workOrder.version === "work-order-view-v1" &&
            workOrder.milestones.some(
              (item) =>
                item.id === input.milestoneId &&
                item.workOrderId === input.taskId &&
                ["locked", "submitted", "disputed", "resolved"].includes(item.escrowState ?? ""),
            );
          if (funded) await save({ ...current, state: "funded" });
        }
        if (current.state === "funded")
          throw new TaskOperationError(
            "funding_already_funded",
            "The hosted task has confirmed this milestone funded. No new payment is needed.",
          );
        if (
          current.state === "authorization" &&
          current.coordinates &&
          current.nonce &&
          current.validBefore &&
          BigInt(Math.floor(input.now().getTime() / 1000)) > BigInt(current.validBefore) &&
          input.chain.fundingAuthorizationState
        ) {
          const used = await input.chain.fundingAuthorizationState({
            ...(current.coordinates as VerifiedFundingCoordinates),
            nonce: current.nonce as `0x${string}`,
            validBefore: current.validBefore,
          });
          if (used === false) {
            await releaseSpend(BigInt(current.amount), {
              ledgerPath: input.ledgerPath,
              wallet: input.wallet,
              reservedOn: current.reservedOn,
              reservationId: current.reservationId,
              now: input.now(),
            });
            const pending = input.pending ?? createPendingTransactions(dirname(input.ledgerPath));
            // Clear the old signed-intent cache only after expiry plus a trusted unused-nonce observation.
            if (current.protocol === "intent") {
              if (!pending.clearExpiredFunding)
                throw new TaskOperationError(
                  "funding_unresolved",
                  "Expired funding requires a store that can retire the old authorization.",
                );
              await pending.clearExpiredFunding(input.milestoneId, current.reservationId);
            }
            await unlink(path);
            current = undefined;
          }
        }
        if (current)
          throw new TaskOperationError(
            "funding_unresolved",
            "A prior funding authorization is unresolved. Check hosted funding state or wait for expiry and an unused-nonce verification before another payment.",
          );
      }
      const journal: FundingAttemptJournal = {
        async record(value) {
          if (current && current.reservationId !== value.reservationId)
            throw new TaskOperationError(
              "funding_unresolved",
              "Another funding attempt owns this milestone.",
            );
          await save({
            version: 1,
            taskId: input.taskId,
            milestoneId: input.milestoneId,
            wallet: input.wallet,
            protocol: value.protocol,
            state: value.authorization ? "authorization" : "preparing",
            amount: value.amount,
            reservationId: value.reservationId,
            reservedOn: value.reservedOn,
            ...(value.authorization
              ? {
                  coordinates: value.authorization.coordinates,
                  nonce: value.authorization.nonce,
                  validBefore: value.authorization.validBefore,
                }
              : {}),
          });
        },
        async abandonUnsent() {
          if (current) {
            await unlink(path);
            current = undefined;
          }
        },
      };
      return operation(journal);
    },
    { lockedMessage: "Another funding attempt owns this milestone. Try again after it finishes." },
  );
}
