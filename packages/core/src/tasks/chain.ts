import { createHash, randomBytes as cryptoRandomBytes } from "node:crypto";
import {
  getAddress,
  isAddressEqual,
  keccak256,
  parseTransaction,
  recoverTransactionAddress,
  recoverTypedDataAddress,
  type Hex,
  type LocalAccount,
  type PublicClient,
  type TransactionSerialized,
  type TransactionSerializable,
} from "viem";
import { prepareTransactionRequest } from "viem/actions";

import {
  TasksChainError,
  type TaskMilestone,
  type TasksChain,
  type TasksChainResult,
  type TasksEscrowOperation,
} from "./chain-port.js";
import { TasksValidationError, safeTasksChainError } from "./chain-error.js";
import type { ScopeBindings } from "./scope-bindings.js";
import type { TasksDurationOverrides } from "./trusted-deployments.js";
import { getTrustedTasksFactory } from "./trusted-deployments.js";
import { TasksClientError, type TasksClient } from "./client.js";
import { freezeDeliveryManifest, sha256Hex } from "./delivery-manifest.js";
import { taskFeeReservationKey } from "./dispute-fee.js";
import { formatBaseUnitsUsd } from "./money.js";
import type { PendingTransactions } from "./pending-transactions.js";
import { TASKS_CHAIN_ABI, verifyPlan } from "./plan-guard.js";
import {
  verifyClone,
  verifyDeployment,
  verifyScope,
  type VerifiedContext,
  type EscrowVerb,
} from "./chain-verification.js";
import type { CreateEscrowResponse, DeploymentResponse, GetOrderResponse } from "./types.js";

type PrivateOrder = Extract<GetOrderResponse["workOrder"], { version: "work-order-view-v1" }>;
type Deployment = Extract<DeploymentResponse, { configured: true }>;
type Prepared = CreateEscrowResponse;

export type TasksChainOptions = {
  client: TasksClient;
  account: LocalAccount;
  rpcFor: (chainId: number) => PublicClient;
  pending: PendingTransactions;
  now?: () => Date;
  sleep?: (milliseconds: number) => Promise<void>;
  randomBytes?: (size: number) => Uint8Array;
  confirmations?: number;
  trustedFactories?: Record<string, string>;
  trustedDurations?: TasksDurationOverrides;
  bindings?: ScopeBindings;
};

// ReceiveWithAuthorization is defined by the server's eip3009-funding.ts.
const authorizationTypes = {
  ReceiveWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

/** Local signing with durable recovery, using the console's HTTP operation protocol. */
export function createTasksChain(options: TasksChainOptions): TasksChain {
  const { account, client, pending, rpcFor } = options;
  const now = options.now ?? (() => new Date());
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const randomBytes = options.randomBytes ?? cryptoRandomBytes;
  const confirmations = options.confirmations ?? 2;
  if (!Number.isSafeInteger(confirmations) || confirmations < 1)
    throw new TasksChainError("Tasks confirmations must be a positive integer.", false, {
      authorizationExposed: false,
    });

  async function deployment(): Promise<Deployment> {
    const value = await client.deployment();
    if (!value.configured || value.network !== `eip155:${value.chainId}`)
      throw new TasksValidationError("The Tasks chain deployment is unavailable.");
    // Resolve before signing authorizations, so unsupported chains fail locally.
    if (!getTrustedTasksFactory(value.chainId, options.trustedFactories))
      throw new TasksChainError(
        `No trusted Tasks escrow factory is configured for chain ${value.chainId}. Set VAPI_TASKS_ESCROW_FACTORY_${value.chainId}.`,
        false,
        { authorizationExposed: false },
      );
    return verifyDeployment(value, rpcFor(value.chainId), options.trustedFactories);
  }

  async function order(orderId: string): Promise<PrivateOrder> {
    const { workOrder } = await client.getOrder(orderId);
    if (workOrder.id !== orderId || workOrder.version !== "work-order-view-v1")
      throw new TasksValidationError("A private task order matching the requested ID is required.");
    const actor =
      workOrder.role === "client"
        ? workOrder.clientAddress
        : workOrder.role === "provider"
          ? (workOrder.proposals.find((proposal) => proposal.id === workOrder.acceptedProposalId)
              ?.providerAddress ?? workOrder.invitedProviderAddress)
          : null;
    if (!actor || !isAddressEqual(actor, account.address))
      throw new TasksValidationError(
        "The local signer does not match the authenticated task party.",
      );
    return workOrder;
  }

  async function milestone(input: TasksEscrowOperation) {
    let orderId = input.orderId;
    // SDK callers may only know the milestone ID. Interface callers supply its parent.
    if (!orderId) {
      let cursor: string | undefined;
      const seen = new Set<string>();
      for (let page = 0; page < 128; page++) {
        const result = await client.listOrders({ scope: "private", ...(cursor ? { cursor } : {}) });
        const found = result.workOrders.find(
          (candidate) =>
            candidate.version === "work-order-view-v1" &&
            candidate.milestones.some((item) => item.id === input.escrowId),
        );
        if (found) {
          orderId = found.id;
          break;
        }
        const next = result.page.nextCursor;
        if (!next || seen.has(next)) break;
        seen.add(next);
        cursor = next;
      }
    }
    if (!orderId)
      throw new TasksValidationError("The task milestone's parent order is unavailable.");
    const workOrder = await order(orderId);
    const matches = workOrder.milestones.filter((item) => item.id === input.escrowId);
    if (matches.length !== 1 || matches[0]!.workOrderId !== workOrder.id)
      throw new TasksValidationError("The task milestone does not match its parent order.");
    const selected = matches[0]!;
    if (selected.escrowState === null)
      throw new TasksValidationError("The task milestone has no created escrow clone.");
    return { workOrder, selected };
  }

  async function expectation(
    selected: TaskMilestone,
    ready: Deployment,
    verb: EscrowVerb,
    steps: readonly string[],
    counterparty?: string,
  ): Promise<VerifiedContext> {
    const verified = await verifyScope(client, account.address, selected, ready, verb, steps, {
      bindings: options.bindings,
      ...(counterparty ? { counterparty: getAddress(counterparty) } : {}),
      rpc: rpcFor(ready.chainId),
      now,
      trustedDurations: options.trustedDurations,
    });
    await verifyClone(rpcFor(ready.chainId), verified, false);
    return verified;
  }

  async function preparation(input: TasksEscrowOperation, verb: string, inputs: unknown = {}) {
    return pending.withStepLock(input.escrowId, `prepare-${verb}`, async () => {
      const existing = await pending.preparation(input.escrowId, verb);
      const idempotencyKey = existing?.idempotencyKey ?? input.idempotencyKey;
      await pending.putPreparation(input.escrowId, verb, { idempotencyKey, inputs });
      return idempotencyKey;
    });
  }

  async function verifyReceipt(
    operation: Prepared["operation"],
    expected: VerifiedContext,
    hash: Hex,
  ): Promise<void> {
    const rpc = rpcFor(expected.deployment.chainId);
    const receipt = await rpc.waitForTransactionReceipt({ hash, confirmations });
    if (
      receipt.transactionHash.toLowerCase() !== hash.toLowerCase() ||
      receipt.status !== "success"
    )
      throw new TasksValidationError(
        "The task transaction has no successful matching RPC receipt.",
      );
    const tx = await rpc.getTransaction({ hash });
    const saved = await pending.get(operation.id, operation.step);
    if (saved) {
      const decoded = parseTransaction(saved.raw);
      if (
        keccak256(saved.raw) !== saved.txHash ||
        decoded.chainId !== expected.deployment.chainId ||
        !decoded.to ||
        !tx.to ||
        !isAddressEqual(decoded.to, tx.to) ||
        decoded.data !== tx.input ||
        (decoded.value ?? 0n) !== tx.value
      )
        throw new TasksValidationError(
          "The RPC transaction does not match the saved verified task plan.",
        );
    }
    if (
      !tx.to ||
      tx.hash.toLowerCase() !== hash.toLowerCase() ||
      tx.chainId !== expected.deployment.chainId ||
      tx.value !== 0n ||
      !isAddressEqual(tx.from, account.address) ||
      !receipt.to ||
      !isAddressEqual(receipt.to, tx.to) ||
      !isAddressEqual(receipt.from, tx.from)
    )
      throw new TasksValidationError(
        "The RPC transaction envelope does not match the verified task plan.",
      );
    verifyPlan(
      {
        ...operation,
        plan: {
          version: "work-transaction-plan-v2",
          operationId: operation.id,
          step: operation.step,
          chainId: expected.deployment.chainId,
          network: expected.deployment.network,
          from: tx.from,
          to: tx.to,
          data: tx.input,
          value: "0",
        },
      },
      expected,
    );
    if (
      operation.plan &&
      (operation.plan.data !== tx.input || !isAddressEqual(operation.plan.to, tx.to))
    )
      throw new TasksValidationError(
        "The RPC transaction input does not match the verified task plan.",
      );
  }

  async function retryConflict<T>(call: () => Promise<T>): Promise<T> {
    let waited = 0;
    const started = now().getTime();
    for (let attempt = 0; ; attempt++) {
      try {
        return await call();
      } catch (error) {
        if (
          !(error instanceof TasksClientError) ||
          error.status !== 409 ||
          error.retryAfter === undefined
        )
          throw error;
        const delay = retryDelay(error.retryAfter, now().getTime());
        if (
          delay === undefined ||
          attempt >= 30 ||
          Math.max(waited, now().getTime() - started) + delay > 30_000
        )
          throw error;
        await sleep(delay);
        waited += delay;
      }
    }
  }

  async function execute(
    initial: Prepared,
    expected: VerifiedContext,
    idempotencyKey: string,
    authorizationExposed = false,
    beforeSign?: () => Promise<void>,
  ): Promise<TasksChainResult> {
    let current = initial;
    const live = expected.milestone.chainOperation;
    const rank = { prepared: 0, submitted: 1, confirmed: 2 };
    const afterApproval =
      expected.verb === "fund"
        ? "deposit-funds"
        : expected.verb === "dispute"
          ? "raise-dispute"
          : expected.verb === "counter-evidence"
            ? "submit-counter-evidence"
            : undefined;
    // A newer server hint selects the resume path; RPC still proves completion below.
    if (
      live?.id === initial.operation.id &&
      (live.step === initial.operation.step ||
        ((expected.verb === "dispute" || expected.verb === "counter-evidence") &&
          initial.operation.step === "approve-usdc" &&
          live.step === afterApproval)) &&
      rank[live.state] > rank[initial.operation.state]
    )
      current = { ...initial, operation: live };
    let broadcast = current.operation.state === "submitted";
    let txHash = current.operation.transactionHash ?? undefined;
    const operationId = initial.operation.id;
    function checkTransition(previous: string, next: string) {
      if (previous !== next && !(previous === "approve-usdc" && next === afterApproval))
        throw new TasksValidationError("The task operation advanced to an unexpected step.");
    }
    function checkResponse(response: Prepared) {
      if (
        response.operation.id !== operationId ||
        !expected.steps.includes(response.operation.step) ||
        response.milestone.id !== expected.milestone.id ||
        response.milestone.workOrderId !== expected.milestone.workOrderId
      )
        throw new TasksValidationError(
          "The operation response does not match the requested task milestone.",
        );
    }
    try {
      await pending.bindPreparationOperation(expected.milestone.id, expected.verb, operationId);
      for (let transition = 0; transition < 4; transition++) {
        checkResponse(current);
        let operation = current.operation;
        const savedForStep = await pending.get(operation.id, operation.step);
        if (savedForStep) {
          broadcast = true;
          txHash = savedForStep.txHash;
        }
        const checkpoint = await pending.reconciled(operation.id, operation.step);
        if (checkpoint && checkpoint.operation.state === "confirmed") {
          current = checkpoint;
          operation = current.operation;
        }
        if (operation.state === "confirmed") {
          broadcast = true;
          if (operation.step === "approve-usdc")
            throw new TasksValidationError(
              "A fee or funding approval alone does not complete the task action.",
            );
          if (!operation.transactionHash)
            throw new TasksValidationError("The confirmed task operation has no transaction hash.");
          if (!checkpoint) {
            await verifyReceipt(operation, expected, operation.transactionHash);
            await pending.complete(operation.id, operation.step, current);
          }
          const fresh = await order(expected.milestone.workOrderId);
          const resultMilestone = fresh.milestones.find(
            (item) => item.id === expected.milestone.id,
          );
          if (!resultMilestone)
            throw new TasksValidationError("The reconciled task milestone is unavailable.");
          return { txHash: operation.transactionHash, operation, milestone: resultMilestone };
        }
        const rpc = rpcFor(expected.deployment.chainId);
        if (operation.state === "prepared") {
          const reconciled = await pending.reconciled(operation.id, operation.step);
          if (reconciled) {
            checkResponse(reconciled);
            checkTransition(operation.step, reconciled.operation.step);
            current = reconciled;
            continue;
          }
          let cursor = await pending.recoveryCursor(operation.id, operation.step);
          let scanComplete = false;
          let recoveredTransaction = false;
          for (let scan = 0; scan < 128; scan++) {
            const recovered = await client.recoverOperation(
              operation.id,
              { step: operation.step },
              {
                idempotencyKey: callKey(
                  idempotencyKey,
                  operation.id,
                  operation.step,
                  `recover:${cursor}`,
                ),
              },
            );
            checkResponse(recovered);
            await pending.advanceRecovery(operation.id, operation.step, cursor);
            cursor++;
            current = recovered;
            if (recovered.recovered) {
              recoveredTransaction = true;
              scanComplete = true;
              break;
            }
            if (
              recovered.operation.state !== "prepared" ||
              recovered.operation.step !== operation.step
            )
              throw new TasksValidationError(
                "Recovery changed the task operation without reporting recovery.",
              );
            if (recovered.scanComplete) {
              scanComplete = true;
              break;
            }
          }
          if (!scanComplete)
            throw new TasksValidationError(
              "Task recovery did not complete after 128 scans; refusing to broadcast.",
            );
          const scannedOperation = operation;
          operation = current.operation;
          if (recoveredTransaction) {
            broadcast = true;
            const original = scannedOperation;
            // Recovery may advance approval to deposit. Prove the departed step before deleting its bytes.
            const previousStep = original.step;
            if (current.operation.step !== previousStep) {
              checkTransition(previousStep, current.operation.step);
              const previous = await pending.get(operationId, previousStep);
              if (!previous)
                throw new TasksValidationError(
                  "Recovery advanced the task step without an independently provable transaction.",
                );
              await verifyReceipt(
                { ...original, transactionHash: previous.txHash },
                expected,
                previous.txHash,
              );
              await pending.complete(operationId, previousStep, current);
            }
            continue;
          }
          if (operation.state !== "prepared")
            throw new TasksValidationError("Recovery returned an unexpected task operation state.");
          verifyPlan(operation, expected);
          const plan = operation.plan!;
          const send = async (transaction: Awaited<ReturnType<PendingTransactions["get"]>>) => {
            if (!transaction)
              throw new TasksValidationError("The pending task transaction is unavailable.");
            broadcast = true;
            txHash = transaction.txHash;
            try {
              const sent = await rpc.sendRawTransaction({ serializedTransaction: transaction.raw });
              if (sent.toLowerCase() !== transaction.txHash.toLowerCase())
                throw new TasksValidationError(
                  "The RPC returned a different task transaction hash.",
                );
            } catch (error) {
              if (!alreadySent(error)) throw error;
              await verifyReceipt(operation, expected, transaction.txHash);
            }
          };
          const saved = await pending.withStepLock(operation.id, operation.step, () =>
            pending.withSignerLock(plan.chainId, account.address, async () => {
              const completed = await pending.reconciled(operation.id, operation.step);
              if (completed) return { kind: "checkpoint" as const, checkpoint: completed };
              const existing = await pending.get(operation.id, operation.step);
              if (existing) {
                // A previous process may already have sent these exact bytes.
                broadcast = true;
                const decoded = parseTransaction(existing.raw);
                if (
                  existing.chainId !== plan.chainId ||
                  !isAddressEqual(existing.signer, account.address) ||
                  keccak256(existing.raw) !== existing.txHash ||
                  decoded.chainId !== plan.chainId ||
                  !decoded.to ||
                  !isAddressEqual(decoded.to, plan.to) ||
                  decoded.data !== plan.data ||
                  (decoded.value ?? 0n) !== 0n ||
                  !isAddressEqual(
                    await recoverTransactionAddress({
                      serializedTransaction: existing.raw as TransactionSerialized,
                    }),
                    account.address,
                  )
                )
                  throw new TasksValidationError(
                    "The pending transaction does not match the verified task plan.",
                  );
                await send(existing);
                return { kind: "transaction" as const, transaction: existing };
              }
              if ((await rpc.getChainId()) !== plan.chainId)
                throw new TasksValidationError(
                  "The RPC chain ID does not match the task deployment.",
                );
              await beforeSign?.();
              expected.nowSeconds = BigInt(Math.floor(now().getTime() / 1000));
              await verifyClone(rpc, expected, true);
              if (
                operation.step === "raise-dispute" ||
                operation.step === "submit-counter-evidence"
              ) {
                const allowance = await rpc.readContract({
                  address: expected.deployment.usdc,
                  abi: TASKS_CHAIN_ABI,
                  functionName: "allowance",
                  args: [account.address, expected.milestone.escrowContract],
                });
                if (allowance < expected.disputeFee!)
                  throw new TasksValidationError(
                    `The task dispute fee allowance is below ${formatBaseUnitsUsd(expected.disputeFee!)} USDC.`,
                  );
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
              if (expected.verb === "dispute" || expected.verb === "counter-evidence") {
                // Retain spend even if signing or persisting bytes fails ambiguously.
                authorizationExposed = true;
                await pending.markExposure(
                  taskFeeReservationKey(expected.milestone.id, expected.verb),
                );
              }
              const raw = await account.signTransaction(request as TransactionSerializable);
              const entry = {
                chainId: plan.chainId,
                txHash: keccak256(raw),
                raw,
                signer: account.address,
                createdAt: now().toISOString(),
                nonce,
              };
              await pending.put(operation.id, operation.step, entry);
              await send(entry);
              return { kind: "transaction" as const, transaction: entry };
            }),
          );
          if (saved.kind === "checkpoint") {
            checkResponse(saved.checkpoint);
            current = saved.checkpoint;
            continue;
          }
          const transaction = saved.transaction;
          const recorded = await retryConflict(() =>
            client.recordTransaction(
              operation.id,
              { step: operation.step, transactionHash: transaction.txHash },
              {
                idempotencyKey: callKey(
                  idempotencyKey,
                  operation.id,
                  operation.step,
                  "transactions",
                ),
              },
            ),
          );
          checkResponse(recorded);
          if (
            recorded.operation.step !== operation.step ||
            recorded.operation.transactionHash !== transaction.txHash ||
            recorded.operation.state !== "submitted"
          )
            throw new TasksValidationError("The server did not record the task transaction.");
          current = recorded;
          operation = current.operation;
        } else {
          // Submitted resumes never sign or broadcast another transaction.
          broadcast = true;
          verifyPlan(operation, expected);
        }
        if (operation.state !== "submitted" || !operation.transactionHash)
          throw new TasksValidationError("The task operation has no submitted transaction.");
        await verifyReceipt(operation, expected, operation.transactionHash);
        const reconciled = await retryConflict(() =>
          client.reconcileOperation(
            operation.id,
            { step: operation.step, transactionHash: operation.transactionHash! },
            {
              idempotencyKey: callKey(idempotencyKey, operation.id, operation.step, "reconcile"),
            },
          ),
        );
        checkResponse(reconciled);
        checkTransition(operation.step, reconciled.operation.step);
        if (
          reconciled.operation.state === "confirmed" &&
          reconciled.operation.step === "approve-usdc"
        )
          throw new TasksValidationError(
            "A fee or funding approval alone does not complete the task action.",
          );
        if (
          reconciled.operation.state === "confirmed" &&
          reconciled.operation.transactionHash !== operation.transactionHash
        )
          throw new TasksValidationError(
            "The reconciled operation has a different transaction hash.",
          );
        if (
          reconciled.operation.state !== "confirmed" &&
          !(
            operation.step === "approve-usdc" &&
            reconciled.operation.state === "prepared" &&
            reconciled.operation.step === afterApproval
          )
        )
          throw new TasksValidationError("The task transaction was not reconciled.");
        await pending.complete(operation.id, operation.step, reconciled);
        current = reconciled;
      }
      throw new TasksValidationError("The task operation exceeded its allowed step transitions.");
    } catch (cause) {
      throw chainError(cause, broadcast, authorizationExposed, txHash);
    }
  }

  async function safe<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (cause) {
      throw chainError(cause, false, false);
    }
  }

  async function feeOperation(
    input: TasksEscrowOperation & {
      evidenceHash: Hex;
      feeBaseUnits?: bigint;
      beforeSign?: () => Promise<void>;
    },
    verb: "dispute" | "counter-evidence",
  ): Promise<TasksChainResult> {
    let exposed = false;
    try {
      exposed = await pending.exposure(taskFeeReservationKey(input.escrowId, verb));
      const { selected } = await milestone(input);
      const ready = await deployment();
      const finalStep = verb === "dispute" ? "raise-dispute" : "submit-counter-evidence";
      const expected = await expectation(
        selected,
        ready,
        verb,
        ["approve-usdc", finalStep],
        input.counterparty,
      );
      if (input.feeBaseUnits !== undefined && input.feeBaseUnits !== expected.disputeFee)
        throw new TasksValidationError(
          "The policy-checked dispute fee does not match the verified onchain fee.",
        );
      const prepareKey = await preparation(input, verb, { evidenceHash: input.evidenceHash });
      const call =
        verb === "dispute"
          ? client.disputeEscrow.bind(client)
          : client.counterEvidenceEscrow.bind(client);
      return await execute(
        await call(
          input.escrowId,
          { evidenceHash: input.evidenceHash },
          { idempotencyKey: prepareKey },
        ),
        { ...expected, evidenceHash: input.evidenceHash },
        prepareKey,
        exposed,
        input.beforeSign,
      );
    } catch (cause) {
      throw chainError(cause, false, exposed);
    }
  }

  return {
    available: true,
    signingAddress: account.address,
    getSigningAddress: async () => account.address,
    bindScope: async (binding) => {
      if (!options.bindings)
        throw new TasksValidationError(
          "A durable local task party store is required before signing.",
        );
      await options.bindings.put(binding);
    },
    createEscrow: (input) =>
      safe(async () => {
        const workOrder = await order(input.orderId);
        const ready = await deployment();
        const prepared = await client.createEscrow(input.orderId, {
          idempotencyKey: input.idempotencyKey,
        });
        const selected = workOrder.milestones.find((item) => item.id === prepared.milestone.id);
        if (!selected || selected.workOrderId !== input.orderId)
          throw new TasksValidationError(
            "The prepared escrow milestone does not match the task order.",
          );
        const prepareKey = await preparation(
          { escrowId: selected.id, idempotencyKey: input.idempotencyKey },
          "createEscrow",
        );
        return await execute(
          prepared,
          await expectation(selected, ready, "createEscrow", ["create-escrow"], input.counterparty),
          prepareKey,
        );
      }),
    async fund(input) {
      let exposed = true;
      try {
        exposed = await pending.exposure(input.escrowId);
        const { selected } = await milestone(input);
        if (selected.chainOperation?.kind === "escrow-funding") exposed = true;
        const ready = await deployment();
        if (BigInt(selected.amountBaseUnits) !== input.grossBaseUnits)
          throw new TasksValidationError(
            "The task funding amount does not match the frozen milestone amount.",
          );
        const expected = await expectation(
          selected,
          ready,
          "fund",
          ["approve-usdc", "deposit-funds"],
          input.counterparty,
        );
        if (BigInt(expected.milestone.amountBaseUnits) !== input.grossBaseUnits)
          throw new TasksValidationError(
            "The signed scope budget does not match the policy-checked funding amount.",
          );
        const prepareKey = await preparation(input, "fund", {
          grossBaseUnits: input.grossBaseUnits.toString(),
        });
        const savedAuthorization = await pending.savedFundingAuthorization(selected.id, prepareKey);
        exposed = exposed || savedAuthorization !== undefined;
        let body = {};
        if (savedAuthorization || ready.capabilities.erc3009Funding) {
          const domain = ready.eip3009Domain!;
          const validBefore = expected.offerDeadline! + 1n;
          const messageFor = (nonce: Hex) => ({
            from: getAddress(account.address),
            to: getAddress(selected.escrowContract),
            value: input.grossBaseUnits,
            validAfter: 0n,
            validBefore,
            nonce,
          });
          const authorization =
            savedAuthorization ??
            (await pending.fundingAuthorization(selected.id, prepareKey, async () => {
              if (exposed)
                throw new TasksValidationError(
                  "Exposed task funding cannot create a replacement authorization.",
                );
              await verifyClone(rpcFor(ready.chainId), expected, true);
              if (validBefore <= BigInt(Math.floor(now().getTime() / 1000)))
                throw new TasksValidationError("The task funding offer has expired.");
              const bytes = randomBytes(32);
              if (bytes.length !== 32)
                throw new TasksValidationError(
                  "Funding authorization randomness must contain 32 bytes.",
                );
              const nonce = `0x${Buffer.from(bytes).toString("hex")}` as Hex;
              const signature = await account.signTypedData({
                domain,
                types: authorizationTypes,
                primaryType: "ReceiveWithAuthorization",
                message: messageFor(nonce),
              });
              exposed = true;
              return { validAfter: "0", validBefore: validBefore.toString(), nonce, signature };
            }));
          // A saved authorization is exposure even if the process crashed before the explicit marker.
          exposed = true;
          if (
            authorization.validAfter !== "0" ||
            authorization.validBefore !== validBefore.toString() ||
            !isAddressEqual(
              await recoverTypedDataAddress({
                domain,
                types: authorizationTypes,
                primaryType: "ReceiveWithAuthorization",
                message: messageFor(authorization.nonce as Hex),
                signature: authorization.signature as Hex,
              }),
              account.address,
            )
          )
            throw new TasksValidationError(
              "The saved funding authorization does not match this task and signer.",
            );
          expected.authorization = authorization;
          expected.steps = ["fund-with-authorization"];
          body = { authorization };
        } else if (!exposed) {
          await verifyClone(rpcFor(ready.chainId), expected, true);
          if (expected.offerDeadline! < BigInt(Math.floor(now().getTime() / 1000)))
            throw new TasksValidationError("The task funding offer has expired.");
        }
        // Persist uncertainty before the request can expose a redeemable authorization or operation.
        exposed = true;
        await pending.markExposure(selected.id);
        const prepared = await client.fundEscrow(input.escrowId, body, {
          idempotencyKey: prepareKey,
        });
        return await execute(prepared, expected, prepareKey, exposed);
      } catch (cause) {
        throw chainError(cause, false, exposed);
      }
    },
    deliver: (input) =>
      safe(async () => {
        const { selected } = await milestone(input);
        const ready = await deployment();
        const frozen = freezeDeliveryManifest(input.manifest.manifest);
        if (
          frozen.manifestHash !== input.manifest.manifestHash ||
          frozen.manifest.noteSha256 !== (await sha256Hex(new TextEncoder().encode(input.note)))
        )
          throw new TasksValidationError(
            "The local task delivery manifest does not match its hash and note.",
          );
        const expected = await expectation(
          selected,
          ready,
          "deliver",
          ["submit-delivery"],
          input.counterparty,
        );
        const prepareKey = await preparation(input, "deliver", {
          manifestHash: frozen.manifestHash,
          manifest: frozen.manifest,
          note: input.note,
        });
        const prepared = await client.deliverEscrow(
          input.escrowId,
          { fileIds: frozen.manifest.files.map((file) => file.fileId), note: input.note },
          { idempotencyKey: prepareKey },
        );
        if (prepared.delivery.manifestHash !== frozen.manifestHash)
          throw new TasksValidationError(
            "The server task delivery manifest hash does not match the local manifest.",
          );
        return await execute(
          prepared,
          {
            ...expected,
            manifestHash: frozen.manifestHash,
          },
          prepareKey,
        );
      }),
    release: (input) =>
      safe(async () => {
        const { selected } = await milestone(input);
        const ready = await deployment();
        const expected = await expectation(
          selected,
          ready,
          "release",
          ["release-funds"],
          input.counterparty,
        );
        const prepareKey = await preparation(input, "release");
        return await execute(
          await client.releaseEscrow(input.escrowId, { idempotencyKey: prepareKey }),
          expected,
          prepareKey,
        );
      }),
    refund: (input) =>
      safe(async () => {
        const { selected } = await milestone(input);
        const ready = await deployment();
        const expected = await expectation(
          selected,
          ready,
          "refund",
          ["refund-buyer"],
          input.counterparty,
        );
        const prepareKey = await preparation(input, "refund");
        return await execute(
          await client.refundEscrow(input.escrowId, { idempotencyKey: prepareKey }),
          expected,
          prepareKey,
        );
      }),
    disputeFee: (input) =>
      safe(async () => {
        const { selected } = await milestone(input);
        const ready = await deployment();
        const expected = await expectation(
          selected,
          ready,
          "dispute",
          ["approve-usdc", "raise-dispute"],
          input.counterparty,
        );
        return expected.disputeFee!;
      }),
    dispute: (input) => feeOperation(input, "dispute"),
    counterEvidence: (input) => feeOperation(input, "counter-evidence"),
    resolveUnmatched: (input) =>
      safe(async () => {
        const { selected } = await milestone(input);
        const ready = await deployment();
        const expected = await expectation(
          selected,
          ready,
          "resolve-unmatched",
          ["resolve-unmatched-dispute"],
          input.counterparty,
        );
        const prepareKey = await preparation(input, "resolve-unmatched");
        return execute(
          await client.resolveUnmatchedEscrow(input.escrowId, { idempotencyKey: prepareKey }),
          expected,
          prepareKey,
        );
      }),
    signScopeMessage: (message) => safe(() => account.signMessage({ message })),
  };
}

const chainError = safeTasksChainError;

function retryDelay(header: string, now: number): number | undefined {
  if (/^\d+(?:\.\d+)?$/u.test(header.trim())) return Math.max(1, Math.ceil(Number(header) * 1000));
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(1, date - now) : undefined;
}

/** Stable UUID keys segregate bodies by operation, step and endpoint (including recovery pages). */
function callKey(base: string, operationId: string, step: string, kind: string): string {
  const bytes = createHash("sha256")
    .update(JSON.stringify([base, operationId, step, kind]))
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function alreadySent(error: unknown): boolean {
  return (
    error instanceof Error &&
    /already known|known transaction|nonce (?:is )?too low/iu.test(error.message)
  );
}
