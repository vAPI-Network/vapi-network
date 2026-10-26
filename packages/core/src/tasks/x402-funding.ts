import { withFundingAttempt } from "./funding-attempts.js";
import type { VapiConfig, SpendCaps } from "../config.js";
import type { VapiPaymentAccount } from "../keystore.js";
import { assertPublicUrl, createPublicFetch, type LookupFn } from "../net-guard.js";
import { parse402Response } from "../x402.js";
import { completeX402Payment, type X402PaymentAttempt } from "../x402-pay.js";
import { escrowFundingDayRemainingAtomic, taskReservedAtomic } from "../spend-policy.js";
import type { WalletName } from "../wallet-name.js";
import {
  fundingRefusalReason,
  TaskOperationError,
  type MoneySnapshot,
  type TaskOperationContext,
  type TaskPolicy,
  taskRequest,
} from "./operation-support.js";
import { formatBaseUnitsUsd, taskPolicyAtomic as policyAtomic } from "./money.js";
import type { TaskFundingApproval } from "./actions.js";

function attempt(request: Request, response: Response): X402PaymentAttempt {
  return { request, response, finish() {}, waitFor: async (operation) => await operation };
}
/** Optional T26 path. Only a 402 starts a payment; callers retain the existing intent path otherwise. */
export async function fundTaskWithX402(
  context: TaskOperationContext,
  input: {
    id: string;
    counterparty?: string;
    snapshot: MoneySnapshot;
    policy: TaskPolicy;
    caps: SpendCaps;
    wallet: WalletName;
    ledgerPath: string;
    config: VapiConfig;
    now: () => Date;
    unlock: () => Promise<VapiPaymentAccount>;
    approval?: TaskFundingApproval;
    fetchImpl?: typeof fetch;
    lookup?: LookupFn;
  },
) {
  return withFundingAttempt(
    {
      ledgerPath: input.ledgerPath,
      wallet: input.wallet,
      taskId: input.id,
      milestoneId: input.snapshot.escrowId,
      client: context.client,
      chain: context.chain,
      now: input.now,
      ...(context.pending ? { pending: context.pending } : {}),
    },
    async (journal) => {
      const probe = context.client.fundingChallenge;
      if (!probe) return null;
      const challenge = await taskRequest(
        "fund",
        "fundingChallenge",
        () => probe(input.id),
        context,
      );
      if (!challenge) return null;
      const money = input.snapshot.money;
      const order = input.snapshot.order.workOrder;
      if (order.version !== "work-order-view-v1" || order.id !== input.id)
        throw new TaskOperationError(
          "invalid_response",
          "A matching private task order is required for funding.",
        );
      const milestone = order.milestones.find(
        (item) => item.id === input.snapshot.escrowId && item.workOrderId === input.id,
      );
      if (!milestone || milestone.escrowState !== "created")
        throw new TaskOperationError(
          "invalid_response",
          "The task escrow is not awaiting funding.",
        );
      const networks = Object.fromEntries(
        Object.entries(input.config.networks).map(([network, value]) => [
          network,
          {
            usdc: value.usdc,
            rpcUrl: value.rpcUrl,
            enabled: Boolean(value.rpcUrl.trim()),
            ...(value.eip712Domain ? { eip712Domain: value.eip712Domain } : {}),
          },
        ]),
      );
      const mismatch = () =>
        new TaskOperationError(
          "funding_coordinates_mismatch",
          "The funding snapshot, challenge and verified escrow coordinates must match exactly.",
        );
      let quote;
      try {
        quote = await parse402Response(challenge.response.clone(), networks);
      } catch {
        throw mismatch();
      }
      if (
        quote.amountAtomic !== BigInt(milestone.amountBaseUnits) ||
        input.snapshot.money.gross.baseUnits !== milestone.amountBaseUnits
      )
        throw mismatch();
      // Check policy before unlocking; reserveSpend repeats both caps atomically before signing.
      const maxPerTaskAtomic = policyAtomic(input.policy.maxPerTaskUsd);
      const taskSpent = await taskReservedAtomic({
        ledgerPath: input.ledgerPath,
        wallet: input.wallet,
        taskKey: input.id,
        now: input.now(),
      });
      const dayRemaining = await escrowFundingDayRemainingAtomic({
        caps: input.caps,
        ledgerPath: input.ledgerPath,
        wallet: input.wallet,
        now: input.now(),
      });
      const common = { money, policySource: input.policy.source, method: "x402" as const };
      if (taskSpent + quote.amountAtomic > maxPerTaskAtomic)
        return { ...common, ok: false as const, reason: "policy.perTask" as const };
      if (quote.amountAtomic > dayRemaining)
        return { ...common, ok: false as const, reason: "policy.perDay" as const };
      if (quote.amountAtomic > policyAtomic(input.policy.approveAboveUsd)) {
        if (input.approval && "ask" in input.approval) {
          if (
            !(await input.approval.ask({
              money,
              dayRemainingUsd: Number(formatBaseUnitsUsd(dayRemaining)),
            }))
          )
            return { ...common, ok: false as const, declined: true as const };
        } else if (!input.approval?.granted)
          return { ...common, ok: false as const, approval: true as const };
      }
      if (!context.chain.validateFunding)
        throw new TaskOperationError(
          "chain_unavailable",
          "Local task scope verification is required before x402 funding.",
        );
      const verified = await context.chain.validateFunding({
        orderId: input.id,
        ...(input.counterparty === undefined ? {} : { counterparty: input.counterparty }),
        escrowId: milestone.id,
        grossBaseUnits: quote.amountAtomic,
        idempotencyKey: context.randomUUID(),
      });
      const snapshotAsset = milestone.asset?.split("/erc20:")[1];
      if (
        !verified ||
        verified.network !== milestone.network ||
        verified.network !== quote.accepted.network ||
        verified.amount !== milestone.amountBaseUnits ||
        BigInt(verified.amount) !== quote.amountAtomic ||
        verified.payTo.toLowerCase() !== milestone.escrowContract.toLowerCase() ||
        verified.payTo.toLowerCase() !== quote.accepted.payTo.toLowerCase() ||
        verified.asset.toLowerCase() !== snapshotAsset?.toLowerCase() ||
        verified.asset.toLowerCase() !== quote.accepted.asset.toLowerCase() ||
        verified.poster.toLowerCase() !== order.clientAddress.toLowerCase()
      )
        throw mismatch();
      const account = await input.unlock();
      if (account.address.toLowerCase() !== verified.poster.toLowerCase())
        throw new TaskOperationError("wrong_role", "Only the task poster can fund this escrow.");
      const transport =
        input.fetchImpl ??
        createPublicFetch({
          allowPrivateNetwork: false,
          ...(input.lookup ? { lookup: input.lookup } : {}),
        });
      const paymentId = context.randomUUID();
      try {
        const payment = await completeX402Payment({
          challenge: attempt(challenge.request, challenge.response),
          account,
          caps: input.caps,
          config: input.config,
          wallet: input.wallet,
          ledgerPath: input.ledgerPath,
          now: input.now(),
          paymentId,
          requiredNetwork: verified.network,
          expectedPayTo: verified.payTo,
          maxAtomic: BigInt(verified.amount),
          taskFunding: {
            taskKey: input.id,
            maxPerTaskAtomic,
            beforeSign: async (data, reservation) => {
              if (
                data.message.from.toLowerCase() !== verified.poster.toLowerCase() ||
                data.message.to.toLowerCase() !== verified.payTo.toLowerCase() ||
                data.message.value !== BigInt(verified.amount) ||
                data.domain.verifyingContract.toLowerCase() !== verified.asset.toLowerCase() ||
                `eip155:${data.domain.chainId}` !== verified.network
              )
                throw mismatch();
              await journal.record({
                protocol: "x402",
                amount: verified.amount,
                reservationId: reservation.id,
                reservedOn: reservation.date,
                authorization: {
                  coordinates: verified,
                  nonce: data.message.nonce,
                  validBefore: data.message.validBefore.toString(),
                },
              });
            },
            onUnsent: () => journal.abandonUnsent(),
          },
          fetchImpl: transport,
          send: async (request) => {
            await assertPublicUrl(new URL(request.url), {
              allowPrivateNetwork: false,
              ...(input.lookup ? { lookup: input.lookup } : {}),
            });
            const response = await transport(
              new Request(request, { redirect: "manual", signal: AbortSignal.timeout(30_000) }),
            );
            return attempt(request, response);
          },
        });
        await payment.response.body?.cancel();
        return {
          ...common,
          ok: true as const,
          milestoneId: milestone.id,
          settlement: payment.settlement,
          paymentId,
        };
      } catch (error) {
        const reason = fundingRefusalReason(error);
        if (reason) return { ...common, ok: false as const, reason };
        throw error;
      }
    },
  );
}
