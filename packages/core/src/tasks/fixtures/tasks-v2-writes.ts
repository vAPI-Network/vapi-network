// SPDX-License-Identifier: Apache-2.0
// Recorded from vapi-app PR #490's v2-operation-journal.server.test.ts:
// "V2 order operation journal without milestone rows". Actor may be replaced by
// a deterministic local account in signing tests. No deployed tuple is implied.
export const V2_WRITE_ORDER = "22222222-2222-4222-8222-222222222222";
export const V2_WRITE_OPERATION = "11111111-1111-4111-8111-111111111111";
export const v2WritePlan = {
  version: "work-transaction-plan-v2",
  operationId: V2_WRITE_OPERATION,
  step: "v2-approve",
  chainId: 84532,
  network: "eip155:84532",
  from: `0x${"11".repeat(20)}`,
  to: `0x${"22".repeat(20)}`,
  value: "0",
  data: "0x1234",
} as const;
export const v2WritePrepared = {
  orderId: V2_WRITE_ORDER,
  operation: {
    id: V2_WRITE_OPERATION,
    kind: "tasks-v2-write",
    state: "prepared",
    step: v2WritePlan.step,
    expectedActor: v2WritePlan.from,
    transactionHash: null,
    plan: v2WritePlan,
  },
} as const;
export const v2WriteHash = `0x${"33".repeat(32)}` as const;
export const v2WriteSubmitted = {
  ...v2WritePrepared,
  operation: { ...v2WritePrepared.operation, state: "submitted", transactionHash: v2WriteHash },
} as const;
export const v2WriteConfirmed = {
  ...v2WritePrepared,
  operation: { ...v2WritePrepared.operation, state: "confirmed", transactionHash: v2WriteHash },
} as const;
