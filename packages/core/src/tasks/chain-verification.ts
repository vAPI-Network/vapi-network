import {
  getAddress,
  isAddressEqual,
  keccak256,
  stringToHex,
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
import { disputeFeeBaseUnits } from "./dispute-fee.js";
import type { ScopeBindings } from "./scope-bindings.js";
import { freezeScopeTerms } from "./scope-terms.js";
import {
  getTrustedTasksFactory,
  getTrustedTasksDurations,
  type TasksDurationOverrides,
} from "./trusted-deployments.js";
import type { DeploymentResponse } from "./types.js";

type Deployment = Extract<DeploymentResponse, { configured: true }>;
export type EscrowVerb =
  | "createEscrow"
  | "fund"
  | "deliver"
  | "release"
  | "refund"
  | "dispute"
  | "counter-evidence"
  | "resolve-unmatched";
export type VerifiedContext = PlanExpectation & {
  parties: readonly [Address, Address];
  verb: EscrowVerb;
  offerDeadline?: bigint;
  seller: Address;
  workDurationSeconds: number;
  reviewWindowSeconds: number;
  disputeFee?: bigint;
  nowSeconds?: bigint;
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
  options: {
    bindings?: ScopeBindings;
    counterparty?: Address;
    role?: "client" | "provider";
    rpc?: PublicClient;
    now?: () => Date;
    trustedDurations?: TasksDurationOverrides;
  } = {},
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
  const identity = {
    orderId: selected.workOrderId,
    trancheOrdinal: selected.ordinal,
    scopeVersion: scope.version,
    termsHash: frozen.termsHash,
    self: getAddress(signer),
  };
  let binding = await options.bindings?.get(identity);
  if (
    binding &&
    options.counterparty &&
    !isAddressEqual(binding.counterparty, options.counterparty)
  )
    throw new TasksValidationError(
      "The confirmed counterparty differs from the locally bound parties.",
    );
  if (!binding) {
    if (!options.counterparty)
      throw new TasksValidationError(
        "The task parties are not bound on this machine. Re-run with --counterparty <address> to confirm who you are working with.",
      );
    const counterparty = getAddress(options.counterparty);
    if (
      isAddressEqual(counterparty, signer) ||
      ![scope.proposerAddress, scope.counterpartyAddress].some((address) =>
        isAddressEqual(counterparty, address),
      )
    )
      throw new TasksValidationError(
        "The confirmed counterparty did not produce a valid accepted scope signature.",
      );
    let role = options.role;
    // Role comes from explicit createEscrow intent or trusted RPC, never the server's role labels.
    if (!role && verb === "createEscrow") role = "provider";
    if (!role && options.rpc) {
      const [buyer, seller] = await Promise.all([
        options.rpc.readContract({
          address: selected.escrowContract,
          abi: TASKS_READ_ABI,
          functionName: "buyer",
        }),
        options.rpc.readContract({
          address: selected.escrowContract,
          abi: TASKS_READ_ABI,
          functionName: "seller",
        }),
      ]);
      if (isAddressEqual(signer, buyer) && isAddressEqual(counterparty, seller)) role = "client";
      else if (isAddressEqual(signer, seller) && isAddressEqual(counterparty, buyer))
        role = "provider";
    }
    if (!role || !options.bindings)
      throw new TasksValidationError(
        "The task parties cannot be bound without a trusted local role and durable store.",
      );
    binding = {
      ...identity,
      role,
      counterparty,
      signedAt: (options.now ?? (() => new Date()))().toISOString(),
    };
    await options.bindings.put(binding);
  }
  if (
    !isAddressEqual(binding.self, signer) ||
    binding.orderId !== identity.orderId ||
    binding.trancheOrdinal !== identity.trancheOrdinal ||
    binding.scopeVersion !== identity.scopeVersion ||
    binding.termsHash.toLowerCase() !== identity.termsHash.toLowerCase() ||
    ![scope.proposerAddress, scope.counterpartyAddress].every(
      (address) =>
        isAddressEqual(address, binding.self) || isAddressEqual(address, binding.counterparty),
    )
  )
    throw new TasksValidationError(
      "The accepted scope parties do not match the locally bound parties.",
    );
  const buyer = getAddress(binding.role === "client" ? binding.self : binding.counterparty);
  const seller = getAddress(binding.role === "provider" ? binding.self : binding.counterparty);
  if (verb === "createEscrow" && !isAddressEqual(signer, seller))
    throw new TasksValidationError("Task createEscrow requires the locally bound seller's wallet.");
  const workDurationSeconds =
    terms.workDurationSeconds ??
    getTrustedTasksDurations(ready.chainId, options.trustedDurations).workDurationSeconds;
  if (workDurationSeconds === undefined)
    throw new TasksValidationError(
      "The signed task scope has no work duration and no trusted default is configured.",
    );
  return {
    signer,
    buyer,
    seller,
    parties: [buyer, seller],
    workDurationSeconds,
    ...(verb === "fund" ? { approveAmount: BigInt(terms.budget.amountBaseUnits) } : {}),
    reviewWindowSeconds: terms.acceptanceWindowSeconds,
    nowSeconds: BigInt(Math.floor((options.now ?? (() => new Date()))().getTime() / 1000)),
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
  const predicted = await rpc.readContract({
    address: expected.deployment.escrowContract,
    abi: TASKS_READ_ABI,
    functionName: "predictEscrow",
    args: [expected.seller, keccak256(stringToHex(expected.milestone.id))],
  });
  if (!isAddressEqual(predicted, clone))
    throw new TasksValidationError(
      "The escrow clone does not match the signed milestone salt and bound seller.",
    );
  const read = <
    N extends
      | "buyer"
      | "seller"
      | "token"
      | "amount"
      | "termsHash"
      | "state"
      | "resolution"
      | "offerDeadline"
      | "workDeadline"
      | "reviewDeadline"
      | "disputedAt"
      | "counterEvidenceDeadline"
      | "disputeFee",
  >(
    functionName: N,
  ) => rpc.readContract({ address: clone, abi: TASKS_READ_ABI, functionName });
  const [
    buyer,
    seller,
    token,
    amount,
    termsHash,
    state,
    resolution,
    offerDeadline,
    workDeadline,
    reviewDeadline,
    disputedAt,
    counterEvidenceDeadline,
    slot0,
    slot6,
    slot7,
  ] = await Promise.all([
    read("buyer"),
    read("seller"),
    read("token"),
    read("amount"),
    read("termsHash"),
    read("state"),
    read("resolution"),
    read("offerDeadline"),
    read("workDeadline"),
    read("reviewDeadline"),
    read("disputedAt"),
    read("counterEvidenceDeadline"),
    rpc.getStorageAt({ address: clone, slot: "0x0" }),
    rpc.getStorageAt({ address: clone, slot: "0x6" }),
    rpc.getStorageAt({ address: clone, slot: "0x7" }),
  ]);
  if (
    isAddressEqual(buyer, seller) ||
    !isAddressEqual(buyer, expected.buyer) ||
    !isAddressEqual(seller, expected.seller) ||
    !isAddressEqual(token, expected.deployment.usdc) ||
    amount !== BigInt(expected.milestone.amountBaseUnits) ||
    termsHash.toLowerCase() !== expected.milestone.termsHash.toLowerCase()
  )
    throw new TasksValidationError(
      "The onchain escrow parties, token, amount or terms hash do not match the signed scope.",
    );
  const s0 = storageWord(slot0);
  const s6 = storageWord(slot6);
  const s7 = storageWord(slot7);
  if (
    field(s0, 0, 1) !== BigInt(state) ||
    field(s0, 1, 1) !== BigInt(resolution) ||
    !isAddressEqual(storageAddress(s0, 2), buyer) ||
    field(s6, 0, 8) !== offerDeadline ||
    field(s6, 8, 8) !== workDeadline ||
    field(s6, 16, 8) !== reviewDeadline ||
    field(s6, 24, 8) !== disputedAt ||
    field(s7, 0, 8) !== counterEvidenceDeadline
  )
    throw new TasksValidationError("unsupported escrow layout");
  if (
    field(s7, 8, 8) !== BigInt(expected.workDurationSeconds) ||
    field(s7, 16, 8) !== BigInt(expected.reviewWindowSeconds)
  )
    throw new TasksValidationError(
      "The onchain escrow durations do not match the signed terms and trusted defaults.",
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
    "counter-evidence": [4],
    "resolve-unmatched": [4],
  };
  if (checkState && !states[expected.verb]?.includes(state))
    throw new TasksValidationError(
      `The onchain escrow state is not eligible for task ${expected.verb}.`,
    );
  if (["dispute", "counter-evidence"].includes(expected.verb)) {
    const fee = disputeFeeBaseUnits(amount);
    if ((await read("disputeFee")) !== fee)
      throw new TasksValidationError(
        "The onchain dispute fee does not match the verified amount fee rule.",
      );
    expected.disputeFee = fee;
    expected.approveAmount = fee;
  }
  if (checkState && ["counter-evidence", "resolve-unmatched"].includes(expected.verb)) {
    const slot8 = storageWord(await rpc.getStorageAt({ address: clone, slot: "0x8" }));
    const opener = storageAddress(slot8, 0);
    const submitted = field(slot8, 20, 1);
    if (
      (!isAddressEqual(opener, buyer) && !isAddressEqual(opener, seller)) ||
      submitted > 1n ||
      field(slot8, 21, 11) !== 0n
    )
      throw new TasksValidationError("unsupported escrow layout");
    const now = expected.nowSeconds;
    if (now === undefined)
      throw new TasksValidationError("A trusted clock is required for dispute eligibility.");
    if (submitted === 1n)
      throw new TasksValidationError(
        "Counter-evidence has already been submitted for this dispute.",
      );
    if (expected.verb === "counter-evidence") {
      if (isAddressEqual(opener, expected.signer))
        throw new TasksValidationError("Only the non-opener party can submit counter-evidence.");
      if (now >= counterEvidenceDeadline)
        throw new TasksValidationError("The counter-evidence deadline has passed.");
    } else if (now <= counterEvidenceDeadline)
      throw new TasksValidationError(
        "The counter-evidence deadline has not passed; unmatched resolution is unavailable.",
      );
  }
  expected.offerDeadline = offerDeadline;
}

function storageWord(value: Hex | undefined): bigint {
  if (!value || !/^0x[0-9a-fA-F]{64}$/.test(value))
    throw new TasksValidationError("unsupported escrow layout");
  return BigInt(value);
}
function field(word: bigint, offset: number, bytes: number): bigint {
  return (word >> BigInt(offset * 8)) & ((1n << BigInt(bytes * 8)) - 1n);
}
function storageAddress(word: bigint, offset: number): Address {
  return getAddress(`0x${field(word, offset, 20).toString(16).padStart(40, "0")}`);
}
