import { encodeFunctionData, toFunctionSelector } from "viem";
import { expect, it } from "vitest";

import { TasksChainError } from "./chain-port.js";
import { TASKS_CHAIN_ABI, verifyPlan } from "./plan-guard.js";

it.each([
  ["createEscrow", "0x23b2942c"],
  ["fundWithAuthorization", "0xc6e8d703"],
  ["approve", "0x095ea7b3"],
  ["depositFunds", "0xe2c41dbc"],
  ["submitDelivery", "0x332311bf"],
  ["releaseFunds", "0x69d89575"],
  ["refundBuyer", "0xe8a61cc8"],
  ["raiseDispute", "0xe14f5b7d"],
  ["timeoutRefund", "0xd5506d79"],
  ["finalize", "0x4bb278f3"],
  ["disputeFee", "0xb9ce896b"],
  ["allowance", "0xdd62ed3e"],
])("keeps the server selector for %s", (name, selector) => {
  const item = TASKS_CHAIN_ABI.find((entry) => entry.name === name);
  expect(item).toBeDefined();
  expect(toFunctionSelector(item!)).toBe(selector);
});

const operationId = "11111111-1111-4111-8111-111111111111";
const milestoneId = "22222222-2222-4222-8222-222222222222";
const signer = "0x1111111111111111111111111111111111111111" as const;
const usdc = "0x2222222222222222222222222222222222222222" as const;
const escrow = "0x3333333333333333333333333333333333333333" as const;
const factory = "0x4444444444444444444444444444444444444444" as const;
const hash = `0x${"ab".repeat(32)}` as const;

it.each([
  ["create-escrow", "releaseFunds", []],
  ["fund-with-authorization", "releaseFunds", []],
  ["approve-usdc", "releaseFunds", []],
  ["deposit-funds", "releaseFunds", []],
  ["submit-delivery", "releaseFunds", []],
  ["release-funds", "refundBuyer", []],
  ["refund-buyer", "releaseFunds", []],
  ["raise-dispute", "releaseFunds", []],
  ["timeout-refund", "releaseFunds", []],
  ["finalize", "releaseFunds", []],
] as const)("rejects mismatched calldata for %s", (step, wrongFunction, args) => {
  const operation = {
    id: operationId,
    kind: "escrow-funding",
    state: "prepared",
    step,
    expectedActor: signer,
    transactionHash: null,
    plan: {
      version: "work-transaction-plan-v2",
      operationId,
      step,
      chainId: 84532,
      network: "eip155:84532",
      from: signer,
      to: step === "create-escrow" ? factory : step === "approve-usdc" ? usdc : escrow,
      data: encodeFunctionData({ abi: TASKS_CHAIN_ABI, functionName: wrongFunction, args }),
      value: "0",
    },
  } as Parameters<typeof verifyPlan>[0];
  const expectation = {
    signer,
    buyer: signer,
    steps: [step],
    deployment: {
      configured: true,
      chainId: 84532,
      network: "eip155:84532",
      explorerUrl: "https://example.com",
      escrowContract: factory,
      feeRouter: signer,
      usdc,
      capabilities: { erc3009Funding: true, vapiVerify: false },
      eip3009Domain: null,
      maxEscrowAmountBaseUnits: "100",
      defaults: { workDurationSeconds: 600 },
      verifyReviewPriceBaseUnits: null,
    },
    milestone: {
      id: milestoneId,
      workOrderId: operationId,
      network: "eip155:84532",
      asset: `eip155:84532/erc20:${usdc}`,
      amountBaseUnits: "100",
      escrowContract: escrow,
      termsHash: hash,
      terms: { workDurationSeconds: 600, acceptanceWindowSeconds: 3600 },
    },
  } as unknown as Parameters<typeof verifyPlan>[1];
  expect(() => verifyPlan(operation, expectation)).toThrow(TasksChainError);
});

// Calldata uses the exact server signatures, including the appended builder attribution bytes.
import { keccak256, stringToHex, type Hex } from "viem";
import type { PlanExpectation } from "./plan-guard.js";

const authorization = {
  validAfter: "0",
  validBefore: "2000000000",
  nonce: `0x${"12".repeat(32)}`,
  signature: "0xabcd",
};
const baseExpectation = {
  signer,
  buyer: signer,
  steps: [],
  deployment: {
    configured: true,
    chainId: 84532,
    network: "eip155:84532",
    escrowContract: factory,
    usdc,
    defaults: { workDurationSeconds: 600 },
  },
  milestone: {
    id: milestoneId,
    workOrderId: operationId,
    network: "eip155:84532",
    asset: `eip155:84532/erc20:${usdc}`,
    amountBaseUnits: "100",
    escrowContract: escrow,
    termsHash: hash,
    terms: { workDurationSeconds: 600, acceptanceWindowSeconds: 3600 },
  },
  authorization,
  manifestHash: hash,
  evidenceHash: hash,
} as unknown as PlanExpectation;
const calldata = {
  "create-escrow": encodeFunctionData({
    abi: TASKS_CHAIN_ABI,
    functionName: "createEscrow",
    args: [signer, usdc, 100n, 600n, 3600n, hash, keccak256(stringToHex(milestoneId))],
  }),
  "fund-with-authorization": encodeFunctionData({
    abi: TASKS_CHAIN_ABI,
    functionName: "fundWithAuthorization",
    args: [0n, 2000000000n, authorization.nonce as Hex, authorization.signature as Hex],
  }),
  "approve-usdc": encodeFunctionData({
    abi: TASKS_CHAIN_ABI,
    functionName: "approve",
    args: [escrow, 100n],
  }),
  "deposit-funds": encodeFunctionData({ abi: TASKS_CHAIN_ABI, functionName: "depositFunds" }),
  "submit-delivery": encodeFunctionData({
    abi: TASKS_CHAIN_ABI,
    functionName: "submitDelivery",
    args: [hash],
  }),
  "release-funds": encodeFunctionData({ abi: TASKS_CHAIN_ABI, functionName: "releaseFunds" }),
  "refund-buyer": encodeFunctionData({ abi: TASKS_CHAIN_ABI, functionName: "refundBuyer" }),
  "raise-dispute": encodeFunctionData({
    abi: TASKS_CHAIN_ABI,
    functionName: "raiseDispute",
    args: [hash],
  }),
  "timeout-refund": encodeFunctionData({ abi: TASKS_CHAIN_ABI, functionName: "timeoutRefund" }),
  finalize: encodeFunctionData({ abi: TASKS_CHAIN_ABI, functionName: "finalize" }),
};
const steps = Object.keys(calldata) as (keyof typeof calldata)[];
function guardedOperation(step: keyof typeof calldata) {
  return {
    id: operationId,
    kind: "escrow-funding",
    state: "prepared",
    step,
    expectedActor: signer,
    transactionHash: null,
    plan: {
      version: "work-transaction-plan-v2",
      operationId,
      step,
      chainId: 84532,
      network: "eip155:84532",
      from: signer,
      to: step === "create-escrow" ? factory : step === "approve-usdc" ? usdc : escrow,
      data: `${calldata[step]}abcd000080218021802180218021802180218021` as Hex,
      value: "0",
    },
  } as Parameters<typeof verifyPlan>[0];
}

it.each(steps)("accepts the server ABI prefix and preserves builder data for %s", (step) => {
  const op = guardedOperation(step);
  const original = op.plan!.data;
  verifyPlan(op, { ...baseExpectation, steps: [step] });
  expect(op.plan!.data).toBe(original);
});

const mutations = [
  "from",
  "actor",
  "to",
  "chainId",
  "network",
  "value",
  "selector",
  "operationId",
  "step",
] as const;
it.each(steps.flatMap((step) => mutations.map((field) => [step, field] as const)))(
  "rejects %s with an invalid %s",
  (step, field) => {
    const op = guardedOperation(step);
    const plan = op.plan!;
    if (field === "from") plan.from = factory;
    if (field === "actor") op.expectedActor = factory;
    if (field === "to") plan.to = signer;
    if (field === "chainId") plan.chainId = 8453;
    if (field === "network") plan.network = "eip155:8453";
    if (field === "value") Object.assign(plan, { value: "1" });
    if (field === "selector") plan.data = `0x00000000${plan.data.slice(10)}`;
    if (field === "operationId") plan.operationId = milestoneId;
    if (field === "step") plan.step = "vote-dispute";
    expect(() => verifyPlan(op, { ...baseExpectation, steps: [step] })).toThrow(TasksChainError);
  },
);

it.each([
  "create-escrow",
  "fund-with-authorization",
  "approve-usdc",
  "submit-delivery",
  "raise-dispute",
] as const)("rejects decoded argument substitution for %s", (step) => {
  const op = guardedOperation(step);
  const expected = { ...baseExpectation, steps: [step] };
  if (step === "create-escrow") expected.buyer = factory;
  if (step === "fund-with-authorization")
    expected.authorization = { ...authorization, validBefore: "2000000001" };
  if (step === "approve-usdc")
    expected.milestone = { ...expected.milestone, amountBaseUnits: "101" };
  if (step === "submit-delivery") expected.manifestHash = `0x${"34".repeat(32)}`;
  if (step === "raise-dispute") expected.evidenceHash = `0x${"34".repeat(32)}`;
  expect(() => verifyPlan(op, expected)).toThrow(TasksChainError);
});
