import {
  getAddress,
  isAddressEqual,
  verifyMessage,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";

import { TasksValidationError } from "./chain-error.js";
import { canonicalJson } from "./canonical-json.js";
import { TasksChainError, type TaskMilestone } from "./chain-port.js";
import type { TasksClient } from "./client.js";
import { TASKS_READ_ABI, type PlanExpectation } from "./plan-guard.js";
import { freezeScopeTerms } from "./scope-terms.js";
import { getTrustedTasksFactory } from "./trusted-deployments.js";
import type { DeploymentResponse } from "./types.js";

type Deployment = Extract<DeploymentResponse, { configured: true }>;
export type EscrowVerb = "createEscrow" | "fund" | "deliver" | "release" | "refund" | "dispute";
export type VerifiedContext = PlanExpectation & {
  parties: readonly [Address, Address];
  verb: EscrowVerb;
  offerDeadline?: bigint;
};

export async function verifyDeployment(
  ready: Deployment,
  rpc: PublicClient,
  overrides?: Record<string, string>,
): Promise<Deployment> {
  const factory = getTrustedTasksFactory(ready.chainId, overrides);
  if (!factory)
    throw new TasksChainError(
      `No trusted Tasks escrow factory is configured for chain ${ready.chainId}. Set VAPI_TASKS_ESCROW_FACTORY_${ready.chainId}.`,
      false,
      { authorizationExposed: false },
    );
  if (!isAddressEqual(factory, ready.escrowContract))
    throw new TasksValidationError(
      "The Tasks readiness factory does not match the trusted factory.",
    );
  if ((await rpc.getChainId()) !== ready.chainId)
    throw new TasksValidationError("The RPC chain ID does not match the task deployment.");
  const token = await rpc.readContract({
    address: factory,
    abi: TASKS_READ_ABI,
    functionName: "paymentToken",
  });
  if (!isAddressEqual(token, ready.usdc))
    throw new TasksValidationError(
      "The Tasks readiness token does not match the trusted factory payment token.",
    );
  const [name, version] = await Promise.all([
    rpc.readContract({ address: token, abi: TASKS_READ_ABI, functionName: "name" }),
    rpc.readContract({ address: token, abi: TASKS_READ_ABI, functionName: "version" }),
  ]);
  const domain = { name, version, chainId: ready.chainId, verifyingContract: getAddress(token) };
  if (
    ready.eip3009Domain &&
    (ready.eip3009Domain.name !== name ||
      ready.eip3009Domain.version !== version ||
      ready.eip3009Domain.chainId !== ready.chainId ||
      !isAddressEqual(ready.eip3009Domain.verifyingContract, token))
  )
    throw new TasksValidationError(
      "The funding authorization domain does not match the onchain token domain.",
    );
  return {
    ...ready,
    escrowContract: getAddress(factory),
    usdc: getAddress(token),
    eip3009Domain: domain,
  };
}

export async function verifyScope(
  client: TasksClient,
  signer: Address,
  selected: TaskMilestone,
  ready: Deployment,
  verb: EscrowVerb,
  steps: readonly string[],
): Promise<VerifiedContext> {
  const { scopes } = await client.getScopes(selected.workOrderId);
  const matches = scopes.filter(
    (scope) => scope.state === "accepted" && scope.milestoneId === selected.id,
  );
  if (matches.length !== 1)
    throw new TasksValidationError("The task milestone requires one accepted signed scope.");
  const scope = matches[0]!;
  const payload = scope.signingPayload;
  const frozen = freezeScopeTerms(scope.structuredTerms, scope.brief);
  if (
    scope.workOrderId !== selected.workOrderId ||
    payload.workOrderId !== selected.workOrderId ||
    payload.trancheOrdinal !== selected.ordinal ||
    scope.trancheOrdinal !== selected.ordinal ||
    payload.scopeVersion !== scope.version ||
    frozen.termsHash !== scope.termsHash ||
    frozen.termsHash !== payload.termsHash ||
    frozen.termsHash !== selected.termsHash
  )
    throw new TasksValidationError(
      "The accepted task scope does not match its locally verified terms hash and milestone.",
    );
  if (
    !scope.counterpartyAddress ||
    !scope.counterpartySignature ||
    isAddressEqual(scope.proposerAddress, scope.counterpartyAddress) ||
    !(
      isAddressEqual(signer, scope.proposerAddress) ||
      isAddressEqual(signer, scope.counterpartyAddress)
    )
  )
    throw new TasksValidationError(
      "The local signer is not one of the two accepted scope parties.",
    );
  const message = canonicalJson(payload);
  const signatures = await Promise.all([
    verifyMessage({
      address: scope.proposerAddress,
      message,
      signature: scope.proposerSignature as Hex,
    }),
    verifyMessage({
      address: scope.counterpartyAddress,
      message,
      signature: scope.counterpartySignature as Hex,
    }),
  ]);
  if (signatures.some((valid) => !valid))
    throw new TasksValidationError("Both accepted task scope signatures must verify.");
  const terms = frozen.structured;
  if (
    terms.budget.network !== ready.network ||
    terms.budget.asset.toLowerCase() !== `${ready.network}/erc20:${ready.usdc}`.toLowerCase() ||
    !isAddressEqual(terms.escrow.contract, ready.escrowContract) ||
    selected.network !== terms.budget.network ||
    selected.asset.toLowerCase() !== terms.budget.asset.toLowerCase() ||
    selected.amountBaseUnits !== terms.budget.amountBaseUnits
  )
    throw new TasksValidationError(
      "The signed task scope asset, factory or amount does not match the deployment and milestone.",
    );
  return {
    signer,
    buyer: getAddress(
      isAddressEqual(signer, scope.proposerAddress)
        ? scope.counterpartyAddress
        : scope.proposerAddress,
    ),
    parties: [getAddress(scope.proposerAddress), getAddress(scope.counterpartyAddress)],
    verb,
    deployment: ready,
    milestone: {
      ...selected,
      terms,
      termsHash: frozen.termsHash,
      amountBaseUnits: terms.budget.amountBaseUnits,
    },
    steps,
  };
}

/** Immutable identity is checked even on resumes; live-state eligibility is checked only for a new signature. */
export async function verifyClone(
  rpc: PublicClient,
  expected: VerifiedContext,
  checkState: boolean,
): Promise<void> {
  if (expected.verb === "createEscrow") return;
  const clone = expected.milestone.escrowContract;
  const registered = await rpc.readContract({
    address: expected.deployment.escrowContract,
    abi: TASKS_READ_ABI,
    functionName: "isEscrow",
    args: [clone],
  });
  if (!registered)
    throw new TasksValidationError(
      "The task escrow clone is not registered by the trusted factory.",
    );
  const read = <
    N extends "buyer" | "seller" | "token" | "amount" | "termsHash" | "state" | "offerDeadline",
  >(
    functionName: N,
  ) => rpc.readContract({ address: clone, abi: TASKS_READ_ABI, functionName });
  const [buyer, seller, token, amount, termsHash, state, deadline] = await Promise.all([
    read("buyer"),
    read("seller"),
    read("token"),
    read("amount"),
    read("termsHash"),
    read("state"),
    read("offerDeadline"),
  ]);
  if (
    isAddressEqual(buyer, seller) ||
    !expected.parties.every(
      (party) => isAddressEqual(party, buyer) || isAddressEqual(party, seller),
    ) ||
    !isAddressEqual(token, expected.deployment.usdc) ||
    amount !== BigInt(expected.milestone.amountBaseUnits) ||
    termsHash.toLowerCase() !== expected.milestone.termsHash.toLowerCase()
  )
    throw new TasksValidationError(
      "The onchain escrow parties, token, amount or terms hash do not match the signed scope.",
    );
  const actor =
    expected.verb === "fund" || expected.verb === "release"
      ? buyer
      : expected.verb === "deliver" || expected.verb === "refund"
        ? seller
        : expected.signer;
  if (!isAddressEqual(actor, expected.signer))
    throw new TasksValidationError(
      `Task ${expected.verb} requires the onchain escrow party's local wallet.`,
    );
  const states: Record<string, readonly number[]> = {
    fund: [1],
    deliver: [2],
    release: [3],
    refund: [2, 3],
    dispute: [2, 3],
  };
  if (checkState && !states[expected.verb]?.includes(state))
    throw new TasksValidationError(
      `The onchain escrow state is not eligible for task ${expected.verb}.`,
    );
  expected.buyer = buyer;
  expected.offerDeadline = deadline;
}
