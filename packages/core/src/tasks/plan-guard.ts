import {
  decodeFunctionData,
  getAddress,
  keccak256,
  parseAbi,
  stringToHex,
  type Address,
  type Hex,
} from "viem";

import { TasksChainError, type TaskMilestone, type TasksChainResult } from "./chain-port.js";
import type { DeploymentResponse, FundEscrowInput } from "./types.js";

// SPDX-License-Identifier: Apache-2.0
// Signatures extracted from vapi-app EscrowFactoryV1/EscrowV1 and IERC20 contracts.
export const TASKS_CHAIN_ABI = [
  {
    type: "function",
    name: "createEscrow",
    stateMutability: "nonpayable",
    inputs: [
      { name: "buyer", type: "address" },
      { name: "token", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "workDuration", type: "uint64" },
      { name: "acceptanceWindow", type: "uint64" },
      { name: "termsHash", type: "bytes32" },
      { name: "salt", type: "bytes32" },
    ],
    outputs: [{ name: "escrow", type: "address" }],
  },
  {
    type: "function",
    name: "fundWithAuthorization",
    stateMutability: "nonpayable",
    inputs: [
      { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" },
      { name: "nonce", type: "bytes32" },
      { name: "signature", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "ok", type: "bool" }],
  },
  {
    type: "function",
    name: "depositFunds",
    stateMutability: "nonpayable",
    inputs: [],
    outputs: [],
  },
  {
    type: "function",
    name: "submitDelivery",
    stateMutability: "nonpayable",
    inputs: [{ name: "manifestHash", type: "bytes32" }],
    outputs: [],
  },
  {
    type: "function",
    name: "releaseFunds",
    stateMutability: "nonpayable",
    inputs: [],
    outputs: [],
  },
  { type: "function", name: "refundBuyer", stateMutability: "nonpayable", inputs: [], outputs: [] },
  {
    type: "function",
    name: "raiseDispute",
    stateMutability: "nonpayable",
    inputs: [{ name: "evidenceHash", type: "bytes32" }],
    outputs: [],
  },
  {
    type: "function",
    name: "timeoutRefund",
    stateMutability: "nonpayable",
    inputs: [],
    outputs: [],
  },
  { type: "function", name: "finalize", stateMutability: "nonpayable", inputs: [], outputs: [] },
  {
    type: "function",
    name: "disputeFee",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "fee", type: "uint256" }],
  },
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "amount", type: "uint256" }],
  },
] as const;

// SPDX-License-Identifier: Apache-2.0
// Read signatures from ../app-main/contracts/src/{EscrowFactoryV1,EscrowV1}.sol
// and interfaces/IEscrowV1.sol; token domain getters are the EIP-3009 token's ABI.
export const TASKS_READ_ABI = parseAbi([
  "function paymentToken() view returns (address)",
  "function isEscrow(address escrow) view returns (bool)",
  "function name() view returns (string)",
  "function version() view returns (string)",
  "function buyer() view returns (address)",
  "function seller() view returns (address)",
  "function token() view returns (address)",
  "function amount() view returns (uint256)",
  "function termsHash() view returns (bytes32)",
  "function state() view returns (uint8)",
  "function offerDeadline() view returns (uint64)",
]);

export type PlanExpectation = {
  signer: Address;
  deployment: Extract<DeploymentResponse, { configured: true }>;
  milestone: TaskMilestone;
  buyer: Address;
  steps: readonly string[];
  authorization?: NonNullable<FundEscrowInput["authorization"]>;
  manifestHash?: Hex;
  evidenceHash?: Hex;
};

export function verifyPlan(
  operation: TasksChainResult["operation"],
  expectation: PlanExpectation,
): void {
  const fail = (message: string): never => {
    throw new TasksChainError(`Unsafe transaction plan: ${message}`, false);
  };
  const plan = operation.plan;
  if (!plan) throw new TasksChainError("Unsafe transaction plan: missing plan", false);
  if (plan.operationId !== operation.id || plan.step !== operation.step) fail("operation mismatch");
  if (!expectation.steps.includes(plan.step)) fail("unexpected step");
  if (
    !operation.expectedActor ||
    getAddress(operation.expectedActor) !== getAddress(expectation.signer) ||
    getAddress(plan.from) !== getAddress(expectation.signer)
  )
    fail("unexpected signer");
  if (
    plan.chainId !== expectation.deployment.chainId ||
    plan.network !== expectation.deployment.network ||
    plan.network !== `eip155:${plan.chainId}` ||
    plan.value !== "0"
  )
    fail("unexpected network or value");
  if (
    expectation.milestone.network !== plan.network ||
    expectation.milestone.asset.toLowerCase() !==
      `${plan.network}/erc20:${expectation.deployment.usdc}`.toLowerCase()
  )
    fail("milestone asset mismatch");
  const target =
    plan.step === "create-escrow"
      ? expectation.deployment.escrowContract
      : plan.step === "approve-usdc"
        ? expectation.deployment.usdc
        : expectation.milestone.escrowContract;
  if (getAddress(plan.to) !== getAddress(target)) fail("unexpected target");
  const decoded = (() => {
    try {
      return decodeFunctionData({ abi: TASKS_CHAIN_ABI, data: plan.data });
    } catch {
      return fail("invalid calldata");
    }
  })();
  const expectedName: Record<string, string> = {
    "create-escrow": "createEscrow",
    "fund-with-authorization": "fundWithAuthorization",
    "approve-usdc": "approve",
    "deposit-funds": "depositFunds",
    "submit-delivery": "submitDelivery",
    "release-funds": "releaseFunds",
    "refund-buyer": "refundBuyer",
    "raise-dispute": "raiseDispute",
    "timeout-refund": "timeoutRefund",
    finalize: "finalize",
  };
  if (decoded.functionName !== expectedName[plan.step]) fail("unexpected selector");
  const args = [...(decoded.args ?? [])] as unknown[];
  const eq = (a: unknown, b: unknown) =>
    typeof a === "string" && typeof b === "string" ? a.toLowerCase() === b.toLowerCase() : a === b;
  const requireArgs = (values: unknown[]) => {
    if (args.length !== values.length || args.some((v, i) => !eq(v, values[i])))
      fail("unexpected arguments");
  };
  if (plan.step === "create-escrow")
    requireArgs([
      expectation.buyer,
      expectation.deployment.usdc,
      BigInt(expectation.milestone.amountBaseUnits),
      BigInt(
        expectation.milestone.terms.workDurationSeconds ??
          expectation.deployment.defaults.workDurationSeconds,
      ),
      BigInt(expectation.milestone.terms.acceptanceWindowSeconds),
      expectation.milestone.termsHash,
      keccak256(stringToHex(expectation.milestone.id)),
    ]);
  else if (plan.step === "fund-with-authorization") {
    const a = expectation.authorization;
    if (!a)
      throw new TasksChainError("Unsafe transaction plan: missing local authorization", false);
    requireArgs([BigInt(a.validAfter), BigInt(a.validBefore), a.nonce, a.signature]);
  } else if (plan.step === "approve-usdc")
    requireArgs([
      expectation.milestone.escrowContract,
      BigInt(expectation.milestone.amountBaseUnits),
    ]);
  else if (plan.step === "submit-delivery") {
    if (!expectation.manifestHash) fail("missing manifest hash");
    requireArgs([expectation.manifestHash]);
  } else if (plan.step === "raise-dispute") {
    if (!expectation.evidenceHash) fail("missing evidence hash");
    requireArgs([expectation.evidenceHash]);
  } else requireArgs([]);
}
