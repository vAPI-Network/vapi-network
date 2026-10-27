import { escrowV2Abi, bountyPoolV1Abi } from "./v2-abi.js";
import {
  v2Read,
  verifyV2Target,
  verifyV2Plan,
  verifyV2TypedData,
  verifyUnmatchedSettlement,
  v2GuardFailure,
} from "./v2-plan-guard.js";
import { randomUUID } from "node:crypto";
import {
  isAddressEqual,
  keccak256,
  parseAbi,
  parseTransaction,
  recoverTransactionAddress,
  type TransactionSerializable,
  type TransactionSerialized,
} from "viem";
import { prepareTransactionRequest } from "viem/actions";
import { z } from "zod";
import type { SpendCaps } from "../config.js";
import {
  escrowFundingDayRemainingAtomic,
  reserveSpend,
  SpendCapError,
  taskReservedAtomic,
} from "../spend-policy.js";
import type { WalletName } from "../wallet-name.js";
import type { TaskFundingApproval } from "./actions.js";
import type { TasksChainOptions } from "./chain.js";
import { TasksClientError } from "./client.js";
import { TaskOperationError, type TaskOperationContext } from "./operation-support.js";
import { formatBaseUnitsUsd, taskMoney, taskPolicyAtomic, type TaskMoney } from "./money.js";
import {
  taskV2ActionSchema,
  taskV2ConsentSchema,
  taskV2OperationResponseSchema,
  taskV2PreparedSchema,
  taskV2IntentSchema,
  taskV2ConsentResponseSchema,
  type TaskV2Action,
  type TaskV2Consent,
  type TaskV2OperationResponse,
  type TaskV2Prepared,
} from "./v2-write.js";
import { canonicalJson } from "./canonical-json.js";

export type TaskV2ExecutionInput = {
  id: string;
  write?: TaskV2Action;
  consent?: TaskV2Consent;
  prepared?: TaskV2Prepared;
  preparationKey?: string;
  expectedGrossBaseUnits?: bigint;
  policy: { maxPerTaskUsd: number; approveAboveUsd: number };
  caps: SpendCaps;
  wallet: WalletName;
  ledgerPath: string;
  approval?: TaskFundingApproval;
  onMoney?: (money: TaskMoney & { escrow: string }) => void | Promise<void>;
};
const uint = z.string().regex(/^\d+$/u);
const stateSchema = z.object({
  escrow: z.string(),
  feeBp: z.number().int().min(0).max(2000),
  totalBaseUnits: uint,
  paidBaseUnits: uint,
  refundedBaseUnits: uint,
  milestones: z.array(
    z.object({ amountBaseUnits: uint, status: z.string(), dispute: z.unknown().optional() }),
  ),
});
const feeAbi = parseAbi(["function disputeFee(uint8) view returns (uint256)"]);
const fail = (message: string): never => {
  throw new TaskOperationError("invalid_response", message);
};

/** The API chooses V2, never a local calldata builder. Old adapters keep the V1 path. */
export async function taskUsesV2(context: Pick<TaskOperationContext, "client">, id: string) {
  if (!context.client.prepareV2) return false;
  const { workOrder } = await context.client.getOrder(id);
  return (
    workOrder.terms !== undefined &&
    (workOrder.v2State != null ||
      (workOrder.version === "work-order-view-v1" && workOrder.milestones.length === 0))
  );
}
export async function executeTaskV2(context: TaskOperationContext, input: TaskV2ExecutionInput) {
  if (!context.chain.executeV2)
    throw new TaskOperationError(
      "chain_unavailable",
      "The local wallet cannot execute prepared V2 steps.",
    );
  try {
    // Ask the hosted API before opening the vault, so disabled writes and stable
    // preparation errors retain their original behavior without a local signature.
    let prepared = input.prepared;
    if (!prepared && context.client.prepareV2 && context.client.signV2) {
      const action = input.consent
        ? taskV2ConsentSchema.parse(input.consent)
        : taskV2ActionSchema.parse(input.write);
      const verb = `v2:${canonicalJson(action)}`;
      const prepare = async () => {
        let journal = await context.pending?.preparation(input.id, verb);
        if (!journal) {
          journal = {
            idempotencyKey: input.preparationKey ?? context.randomUUID(),
            inputs: action,
          };
          await context.pending?.putPreparation(input.id, verb, journal);
        }
        const saved = journal.preparedV2;
        if (saved) return saved;
        const result = await (input.consent
          ? context.client.signV2!(input.id, input.consent, journal)
          : context.client.prepareV2!(input.id, input.write!, journal));
        await context.pending?.bindPreparedV2?.(input.id, verb, result);
        return result;
      };
      prepared = context.pending
        ? await context.pending.withFundingLock(input.id, prepare)
        : await prepare();
    }
    return await context.chain.executeV2({ ...input, ...(prepared ? { prepared } : {}) });
  } catch (error) {
    if (error instanceof TasksClientError)
      throw new TaskOperationError(error.serverCode ?? error.code, error.message);
    throw error;
  }
}

/** Exact hosted plans, durable signed bytes, and hosted finality. No ABI encoding occurs here. */
export function createTaskV2Executor(options: TasksChainOptions) {
  const { client, account, pending, rpcFor } = options;
  const now = options.now ?? (() => new Date());
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const key = () => ({ idempotencyKey: randomUUID() });
  return async (input: TaskV2ExecutionInput) => {
    if (!client.prepareV2 || !client.signV2 || !client.confirmV2Signature || !client.operationV2)
      fail("V2 transport unavailable.");
    const prepare = client.prepareV2!,
      sign = client.signV2!,
      confirmSignature = client.confirmV2Signature!,
      operationCall = client.operationV2!;
    const action = input.consent
      ? taskV2ConsentSchema.parse(input.consent)
      : taskV2ActionSchema.parse(input.write);
    const verb = `v2:${canonicalJson(action)}`;
    return pending.withFundingLock(input.id, async () => {
      let journal = await pending.preparation(input.id, verb);
      if (!journal) {
        journal = { idempotencyKey: input.preparationKey ?? randomUUID(), inputs: action };
        await pending.putPreparation(input.id, verb, journal);
      }
      let current = taskV2PreparedSchema.parse(
        input.prepared ??
          journal.preparedV2 ??
          (await (input.consent
            ? sign(input.id, input.consent, journal)
            : prepare(input.id, input.write!, journal))),
      );
      // Retain the supplied hosted operation/intent before any refusal. A later
      // fund command resumes it instead of preparing a conflicting operation.
      if (!pending.bindPreparedV2) fail("Durable V2 preparation storage is unavailable.");
      await pending.bindPreparedV2!(input.id, verb, current);
      const view = await client.getOrder(input.id);
      if (view.workOrder.id !== input.id) fail("The money view belongs to another task.");
      const terms = view.workOrder.terms;
      const state = stateSchema.safeParse(view.workOrder.v2State);
      const deployment = await client.deployment();
      const target = await verifyV2Target(options, current, view, action);
      if (
        state.success &&
        (BigInt(state.data.totalBaseUnits) !== target.total || state.data.feeBp !== target.feeBp)
      )
        v2GuardFailure("Hosted money snapshot differs from the verified V2 target.");
      let gross = 0n,
        pays = 0n;
      let feeBp: number | null = target.feeBp;
      const marketBudget = z
        .object({ budget: z.object({ amountBaseUnits: uint }) })
        .safeParse(view.workOrder.market);
      const total = state.success
        ? BigInt(state.data.totalBaseUnits)
        : terms?.pool
          ? BigInt(terms.pool.budgetBaseUnits)
          : terms?.bounty
            ? BigInt(terms.bounty.rewardPerWinnerBaseUnits) * BigInt(terms.bounty.winners)
            : (terms?.milestones?.reduce((sum, m) => sum + BigInt(m.amountBaseUnits), 0n) ??
              (marketBudget.success
                ? BigInt(marketBudget.data.budget.amountBaseUnits)
                : undefined));
      if (["fund", "award", "award-consent"].includes(action.action)) {
        if (total === undefined) fail("Hosted task total is unavailable.");
        if (total !== target.total)
          v2GuardFailure("Hosted funding total differs from the verified V2 target.");
        gross = target.total;
        if (action.action === "fund") pays = gross;
      } else if (action.action === "award-bounty") {
        if (!terms?.bounty) fail("Hosted bounty terms are unavailable.");
        const reward = BigInt(
          String(await v2Read(target.rpc, target.escrow, escrowV2Abi, "rewardPerWinner")),
        );
        if (reward !== BigInt(terms!.bounty!.rewardPerWinnerBaseUnits))
          v2GuardFailure("Hosted bounty reward differs from its verified on-chain amount.");
        gross = reward * BigInt(action.winners.length);
      } else if (action.action === "pay-claim") {
        if (!terms?.pool) fail("Hosted pool reward is unavailable.");
        gross = BigInt(
          String(await v2Read(target.rpc, target.escrow, bountyPoolV1Abi, "rewardPerClaim")),
        );
        if (gross !== BigInt(terms!.pool!.rewardPerClaimBaseUnits))
          v2GuardFailure("Hosted pool reward differs from its verified on-chain amount.");
      } else if (action.action === "split" || action.action === "split-consent")
        gross = BigInt(action.toWorker);
      else if (action.action === "approve" || action.action === "finalize") {
        const milestone = state.success ? state.data.milestones[action.i] : undefined;
        if (!milestone) fail("Hosted milestone money is unavailable.");
        gross = target.milestones[action.i]!.amount;
      } else if (["refund", "cancel-remainder", "cancel-offer", "expire"].includes(action.action)) {
        if (state.success)
          gross = ["refund", "cancel-remainder"].includes(action.action)
            ? target.milestones
                .filter((m) => m.status === 0 || (action.action === "refund" && m.status === 1))
                .reduce((sum, m) => sum + m.amount, 0n)
            : BigInt(state.data.totalBaseUnits) -
              BigInt(state.data.paidBaseUnits) -
              BigInt(state.data.refundedBaseUnits);
        else gross = total ?? 0n;
        feeBp = 0;
      } else if (action.action === "raise-dispute" || action.action === "counter-evidence") {
        if (!state.success || !deployment.configured)
          fail("Hosted dispute binding is unavailable.");
        pays = gross = await target.rpc.readContract({
          address: target.escrow,
          abi: feeAbi,
          functionName: "disputeFee",
          args: [action.i],
        });
        feeBp = 0;
      } else if (action.action === "resolve-unmatched") {
        if (!state.success)
          v2GuardFailure("Verified dispute settlement state is required before signing.");
        const settlement = await verifyUnmatchedSettlement(
          target,
          action.i,
          state.data!.milestones[action.i]?.dispute,
        );
        gross = settlement.gross;
        feeBp = settlement.toWorker ? target.feeBp : 0;
      }
      if (gross > 0n && feeBp === null)
        fail("Hosted gross, fee and net are unavailable; refusing to sign.");
      // Running payouts must use their immutable fee snapshot, never today's deployment rate.
      if (
        gross > 0n &&
        !["fund", "cancel-offer", "expire"].includes(action.action) &&
        !state.success
      )
        fail("Hosted V2 fee snapshot is unavailable; refusing to sign.");
      if (input.expectedGrossBaseUnits !== undefined && gross !== input.expectedGrossBaseUnits)
        fail("Hosted funding amount differs from the posted budget.");
      const quote = taskMoney(gross, feeBp ?? 0);
      const money = {
        ...quote,
        escrow: target.escrow,
        line: `${quote.line} · escrow ${target.escrow}`,
      };
      const initialOperation = taskV2OperationResponseSchema.safeParse(current);
      let progress = {
        orderId: input.id,
        lifecycle: view.lifecycle ?? view.workOrder.lifecycle ?? null,
        nextAction: view.nextAction ?? view.workOrder.nextAction ?? null,
        ...(initialOperation.success
          ? { operation: initialOperation.data.operation }
          : {
              operationId: taskV2IntentSchema.parse(current).operationId,
              operationState: "prepared" as const,
            }),
      };
      await input.onMoney?.(money);
      const reservationKey = journal.idempotencyKey;
      const remaining =
        pays > 0n
          ? await escrowFundingDayRemainingAtomic({
              caps: input.caps,
              ledgerPath: input.ledgerPath,
              wallet: input.wallet,
              now: now(),
              reservationId: reservationKey,
            })
          : 0n;
      const alreadyReserved =
        pays > 0n
          ? await taskReservedAtomic({
              ledgerPath: input.ledgerPath,
              wallet: input.wallet,
              taskKey: input.id,
              now: now(),
              excludeReservationId: reservationKey,
            })
          : 0n;
      if (pays + alreadyReserved > taskPolicyAtomic(input.policy.maxPerTaskUsd))
        return { ok: false as const, reason: "policy.perTask", money, ...progress };
      if (pays > remaining)
        return { ok: false as const, reason: "policy.perDay", money, ...progress };
      if (pays > taskPolicyAtomic(input.policy.approveAboveUsd)) {
        if (input.approval && "ask" in input.approval) {
          if (
            !(await input.approval.ask({
              money: taskMoney(pays, 0),
              dayRemainingUsd: Number(formatBaseUnitsUsd(remaining)),
            }))
          )
            return { ok: false as const, declined: true as const, money, ...progress };
        } else if (!input.approval?.granted)
          return { ok: false as const, approval: true as const, money, ...progress };
      }
      let reserved = false;
      const beforeSign = async () => {
        if (reserved || pays === 0n) return;
        await reserveSpend(pays, input.caps, {
          kind: action.action === "fund" ? "escrow-funding" : "dispute-fee",
          taskKey: input.id,
          maxPerTaskAtomic: taskPolicyAtomic(input.policy.maxPerTaskUsd),
          wallet: input.wallet,
          ledgerPath: input.ledgerPath,
          now: now(),
          reservationId: reservationKey,
          reuseExistingEscrowReservation: true,
        });
        // Retain on all ambiguous failures; no authorization or broadcast can roll this back.
        reserved = true;
      };
      let fundingAuthorization:
        { message: Record<string, unknown>; signature: `0x${string}` } | undefined;
      try {
        if ("kind" in current && current.kind === "eip712") {
          const intent = taskV2IntentSchema.parse(current);
          const typed = intent.typedData;
          await verifyV2TypedData(target, intent, action, account.address, pays);
          await beforeSign();
          const signature = await account.signTypedData(typed);
          if (action.action === "fund")
            fundingAuthorization = { message: typed.message, signature };
          const response = await confirmSignature(input.id, intent.operationId, signature, key());
          if (taskV2ConsentResponseSchema.safeParse(response).success) {
            const consentResponse = taskV2ConsentResponseSchema.parse(response);
            if (
              consentResponse.workOrderId !== input.id ||
              !isAddressEqual(consentResponse.signer, account.address)
            )
              fail("Consent confirmation binding mismatch.");
            await pending.completePreparation(input.id, verb);
            return {
              ok: true as const,
              money,
              ...consentResponse,
              operationId: intent.operationId,
              operationState: "confirmed" as const,
              lifecycle: view.lifecycle ?? view.workOrder.lifecycle ?? null,
              nextAction: view.nextAction ?? view.workOrder.nextAction ?? null,
            };
          }
          current = taskV2OperationResponseSchema.parse(response);
        }
        let result = taskV2OperationResponseSchema.parse(current);
        const operationId = result.operation.id;
        const finalStep = `v2-${action.action}`;
        const allowedSteps =
          action.action === "fund"
            ? ["v2-create-pool", "v2-approve-usdc", "v2-fund"]
            : action.action === "raise-dispute" || action.action === "counter-evidence"
              ? ["v2-approve-usdc", finalStep]
              : [finalStep];
        const validate = (value: TaskV2OperationResponse) => {
          if (
            value.orderId !== input.id ||
            value.operation.id !== operationId ||
            !isAddressEqual(value.operation.expectedActor, account.address) ||
            !allowedSteps.includes(value.operation.step)
          )
            fail("Hosted operation does not match the requested task, wallet or action.");
        };
        await pending.bindPreparationOperation(input.id, verb, operationId);
        const call = async (
          mode: "transaction" | "reconcile" | "recover",
          step: string,
          transactionHash?: string,
        ) => {
          const response = await operationCall(
            operationId,
            mode,
            { step, ...(transactionHash ? { transactionHash } : {}) },
            key(),
          );
          const parsed = taskV2OperationResponseSchema.parse(response);
          validate(parsed);
          if (allowedSteps.indexOf(parsed.operation.step) < allowedSteps.indexOf(step))
            fail("Hosted sequence moved backwards.");
          return { parsed, complete: !("scanComplete" in response) || response.scanComplete };
        };
        for (let poll = 0; poll < 256; poll++) {
          validate(result);
          progress = { ...progress, operation: result.operation };
          const op = result.operation;
          if (op.state === "confirmed") {
            if (op.step !== finalStep)
              fail("An approval alone cannot complete the requested action.");
            await pending.completePreparation(input.id, verb);
            const fresh = await client.getOrder(input.id);
            return {
              ok: true as const,
              money,
              ...result,
              lifecycle: fresh.lifecycle ?? fresh.workOrder.lifecycle ?? null,
              nextAction: fresh.nextAction ?? fresh.workOrder.nextAction ?? null,
            };
          }
          if (op.state === "abandoned") fail("The hosted operation was abandoned.");
          if (op.state === "submitted") {
            result = (await call("reconcile", op.step, op.transactionHash!)).parsed;
            if (result.operation.state === "submitted") await sleep(1000);
            continue;
          }
          const recovered = await call("recover", op.step);
          if (!recovered.complete) {
            result = recovered.parsed;
            await sleep(1000);
            continue;
          }
          if (
            recovered.parsed.operation.state !== "prepared" ||
            recovered.parsed.operation.step !== op.step
          ) {
            result = recovered.parsed;
            continue;
          }
          if (canonicalJson(recovered.parsed.operation.plan) !== canonicalJson(op.plan))
            fail("Recovery changed the prepared plan.");
          const plan = op.plan;
          if (!deployment.configured || plan.chainId !== deployment.chainId)
            fail("Hosted plan deployment mismatch.");
          const refreshed = await verifyV2Target(
            options,
            { orderId: input.id, operation: op },
            view,
            action,
            target.escrow,
          );
          if (!isAddressEqual(refreshed.escrow, target.escrow))
            v2GuardFailure("The continuation changed the verified V2 target.");
          try {
            await verifyV2Plan(refreshed, op, action, pays, fundingAuthorization);
          } catch (error) {
            if (error instanceof TaskOperationError) throw error;
            v2GuardFailure("Unknown V2 selector or malformed ABI arguments.");
          }
          const rpc = rpcFor(plan.chainId);
          if ((await rpc.getChainId()) !== plan.chainId) fail("Transaction chain mismatch.");
          await beforeSign();
          const saved = await pending.withStepLock(op.id, op.step, () =>
            pending.withSignerLock(plan.chainId, account.address, async () => {
              const existing = await pending.get(op.id, op.step);
              if (existing) {
                const decoded = parseTransaction(existing.raw);
                if (
                  keccak256(existing.raw) !== existing.txHash ||
                  decoded.chainId !== plan.chainId ||
                  decoded.to?.toLowerCase() !== plan.to ||
                  decoded.data !== plan.data ||
                  (decoded.value ?? 0n) !== 0n ||
                  !isAddressEqual(
                    await recoverTransactionAddress({
                      serializedTransaction: existing.raw as TransactionSerialized,
                    }),
                    account.address,
                  )
                )
                  fail("Saved transaction differs from the hosted plan.");
                return existing;
              }
              const nonce = Math.max(
                await rpc.getTransactionCount({ address: account.address, blockTag: "pending" }),
                await pending.nextNonce(plan.chainId, account.address),
              );
              const request = await prepareTransactionRequest(rpc, {
                account,
                chain: null,
                to: plan.to,
                data: plan.data,
                value: 0n,
                chainId: plan.chainId,
                nonce,
              });
              const raw = await account.signTransaction(request as TransactionSerializable);
              const decoded = parseTransaction(raw);
              if (
                decoded.chainId !== plan.chainId ||
                decoded.to?.toLowerCase() !== plan.to ||
                decoded.data !== plan.data ||
                (decoded.value ?? 0n) !== 0n ||
                !isAddressEqual(
                  await recoverTransactionAddress({
                    serializedTransaction: raw as TransactionSerialized,
                  }),
                  account.address,
                )
              )
                fail("The signed transaction differs from the hosted plan.");
              const entry = {
                raw,
                txHash: keccak256(raw),
                signer: account.address,
                chainId: plan.chainId,
                nonce,
                createdAt: now().toISOString(),
              };
              await pending.put(op.id, op.step, entry);
              return entry;
            }),
          );
          progress = {
            ...progress,
            operation: { ...op, state: "submitted", transactionHash: saved.txHash },
          };
          const hash = await rpc.sendRawTransaction({ serializedTransaction: saved.raw });
          if (hash !== saved.txHash) fail("RPC returned a different transaction hash.");
          result = (await call("transaction", op.step, hash)).parsed;
          const receipt = await rpc.waitForTransactionReceipt({
            hash,
            confirmations: options.confirmations ?? 2,
          });
          if (receipt.status !== "success")
            throw new TaskOperationError(
              "transaction_reverted",
              `Transaction reverted. Operation ${op.id}, step ${op.step}.`,
            );
          result = (await call("reconcile", op.step, hash)).parsed;
        }
        throw new TaskOperationError(
          "operation_pending",
          `Hosted confirmation is pending for operation ${operationId}. Recover it with vapi task status ${input.id} --operation ${operationId} --step ${result.operation.step}.`,
        );
      } catch (error) {
        if (error instanceof SpendCapError)
          return { ok: false as const, reason: error.code, money, ...progress };
        const code =
          error instanceof TasksClientError
            ? (error.serverCode ?? error.code)
            : error instanceof TaskOperationError
              ? error.code
              : "chain_error";
        const message =
          error instanceof TasksClientError || error instanceof TaskOperationError
            ? error.message
            : "The prepared V2 step did not complete. Resume the saved operation.";
        throw new TaskOperationError(code, message, undefined, progress);
      }
    });
  };
}

/** Resume bounded hosted scans without assuming a WorkMilestone row exists. */
export async function recoverTaskV2(
  context: TaskOperationContext & { sleep?: (ms: number) => Promise<void> },
  input: { id: string; operationId: string; step: string; abandon?: boolean },
) {
  if (!context.client.operationV2)
    throw new TaskOperationError("unsupported", "V2 operation recovery is unavailable.");
  for (let poll = 0; poll < 256; poll++) {
    const response = await context.client.operationV2(
      input.operationId,
      input.abandon ? "abandon" : "recover",
      { step: input.step },
      { idempotencyKey: context.randomUUID() },
    );
    if (
      response.orderId !== input.id ||
      (response.operation && response.operation.id !== input.operationId)
    )
      fail("Recovery returned another task or operation.");
    if (
      ("outcome" in response && response.outcome !== "scanning") ||
      ("scanComplete" in response &&
        response.scanComplete &&
        response.operation?.state !== "submitted") ||
      response.operation?.state === "confirmed"
    ) {
      const view = await context.client.getOrder(input.id);
      return {
        ...response,
        lifecycle: view.lifecycle ?? view.workOrder.lifecycle ?? null,
        nextAction: view.nextAction ?? view.workOrder.nextAction ?? null,
      };
    }
    await (
      context.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
    )(1000);
  }
  throw new TaskOperationError(
    "operation_pending",
    `Hosted recovery is pending for operation ${input.operationId}.`,
  );
}
