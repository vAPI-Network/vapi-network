// SPDX-License-Identifier: Apache-2.0
// Wire contracts mirrored from vapi-app tasks-v1, PR #490 (T11), shared/v2-write.ts
// and client/domain/{chain-operation,v2-operation}. No calldata is built locally.
import { z } from "zod";

const address = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/u)
  .transform((v) => v.toLowerCase() as `0x${string}`);
const hex = z
  .string()
  .regex(/^0x(?:[0-9a-fA-F]{2})*$/u)
  .transform((v) => v.toLowerCase() as `0x${string}`);
const hash = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/u)
  .transform((v) => v.toLowerCase() as `0x${string}`);
const amount = z
  .string()
  .regex(/^(0|[1-9][0-9]*)$/u)
  .refine((v) => BigInt(v) < 2n ** 96n);
export const taskV2IndexSchema = z.number().int().min(0).max(4);
// ProofFill preset boundary extracted from shared/proof-spec.ts (T11).
const labelSchema = z
  .string()
  .max(200)
  .refine((value) => value.trim().length > 0 && value === value.trim());
const httpsSchema = z
  .string()
  .refine((value) => value === value.trim())
  .pipe(z.url({ protocol: /^https$/ }));
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const evmHashSchema = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const solanaSignatureSchema = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{87,88}$/);
const base = { label: labelSchema.optional() };
const fillItemSchema = z.discriminatedUnion("preset", [
  z.strictObject({ preset: z.literal("link"), value: httpsSchema, ...base }),
  z.strictObject({ preset: z.literal("file"), value: sha256Schema, ...base }),
  z.strictObject({
    preset: z.literal("x-post"),
    value: httpsSchema.refine((value) =>
      /^https:\/\/(?:www\.)?(?:x\.com|twitter\.com)\/[A-Za-z0-9_]+\/status\/[0-9]+\/?(?:[?#].*)?$/.test(
        value,
      ),
    ),
    ...base,
  }),
  z.strictObject({
    preset: z.literal("onchain-tx"),
    value: z.union([evmHashSchema, solanaSignatureSchema]),
    ...base,
  }),
  z.strictObject({
    preset: z.literal("pr"),
    value: httpsSchema.refine((value) =>
      /^https:\/\/github\.com\/[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+\/pull\/[1-9][0-9]*\/?(?:[?#].*)?$/.test(
        value,
      ),
    ),
    ...base,
  }),
  z.strictObject({ preset: z.literal("text"), value: z.string().min(1).max(24_000), ...base }),
  z.strictObject({ preset: z.literal("media"), value: z.uuid(), ...base }),
]);

export const taskV2ProofSchema = z.array(fillItemSchema).min(1).max(20);

const i = taskV2IndexSchema;
export const taskV2ActionSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("fund") }),
  z.strictObject({ action: z.literal("award"), worker: address }),
  z.strictObject({ action: z.literal("award-bounty"), winners: z.array(address).min(1).max(50) }),
  z.strictObject({ action: z.literal("submit"), i, proof: taskV2ProofSchema }),
  z.strictObject({ action: z.literal("approve"), i }),
  z.strictObject({ action: z.literal("reject"), i, reason: z.string().trim().min(1).max(8000) }),
  z.strictObject({ action: z.literal("finalize"), i }),
  z.strictObject({ action: z.literal("cancel-offer") }),
  z.strictObject({ action: z.literal("cancel-remainder") }),
  z.strictObject({ action: z.literal("expire") }),
  z.strictObject({ action: z.literal("refund") }),
  z.strictObject({ action: z.literal("pay-claim"), claimant: address }),
  z.strictObject({ action: z.literal("raise-dispute"), i, evidence: z.string().min(1).max(8000) }),
  z.strictObject({
    action: z.literal("counter-evidence"),
    i,
    evidence: z.string().min(1).max(8000),
  }),
  z.strictObject({ action: z.literal("resolve-unmatched"), i }),
  z.strictObject({ action: z.literal("split"), i, toWorker: amount }),
]);
export const taskV2ConsentSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("award-consent") }),
  z.strictObject({ action: z.literal("split-consent"), i, toWorker: amount }),
]);
export const taskV2StepSchema = z.enum([
  "v2-fund",
  "v2-approve-usdc",
  "v2-create-pool",
  "v2-award",
  "v2-award-bounty",
  "v2-submit",
  "v2-approve",
  "v2-reject",
  "v2-finalize",
  "v2-cancel-offer",
  "v2-cancel-remainder",
  "v2-expire",
  "v2-refund",
  "v2-pay-claim",
  "v2-raise-dispute",
  "v2-counter-evidence",
  "v2-resolve-unmatched",
  "v2-split",
]);
export const taskV2PlanSchema = z
  .object({
    version: z.literal("work-transaction-plan-v2"),
    operationId: z.uuid(),
    step: taskV2StepSchema,
    chainId: z.number().int().positive(),
    network: z.string(),
    from: address,
    to: address,
    data: hex,
    value: z.literal("0"),
  })
  .refine((v) => v.network === `eip155:${v.chainId}`, "Plan network must match chain id");
export const taskV2OperationSchema = z
  .object({
    id: z.uuid(),
    kind: z.literal("tasks-v2-write"),
    state: z.enum(["prepared", "submitted", "confirmed", "abandoned"]),
    step: taskV2StepSchema,
    expectedActor: address,
    transactionHash: hash.nullable(),
    plan: taskV2PlanSchema,
  })
  .refine(
    (v) => v.plan.operationId === v.id && v.plan.step === v.step && v.plan.from === v.expectedActor,
    "Operation plan binding mismatch",
  )
  .refine(
    (v) => !["submitted", "confirmed"].includes(v.state) || v.transactionHash !== null,
    "Transaction hash required",
  );
export const taskV2OperationResponseSchema = z.looseObject({
  orderId: z.uuid(),
  operation: taskV2OperationSchema,
});
export const taskV2RecoverySchema = taskV2OperationResponseSchema
  .extend({ recovered: z.boolean(), scanComplete: z.boolean() })
  .refine((v) => !v.recovered || v.scanComplete, "Recovery must complete its scan");
export const taskV2AbandonSchema = z
  .looseObject({
    orderId: z.uuid(),
    outcome: z.enum(["abandoned", "recovered", "scanning"]),
    operation: taskV2OperationSchema.nullable(),
  })
  .refine(
    (v) => (v.outcome === "abandoned") === (v.operation === null),
    "Abandon outcome mismatch",
  );
export const taskV2TypedDataSchema = z.strictObject({
  domain: z.strictObject({
    name: z.string(),
    version: z.string(),
    chainId: z.number().int().positive(),
    verifyingContract: address,
  }),
  types: z.record(z.string(), z.array(z.strictObject({ name: z.string(), type: z.string() }))),
  primaryType: z.string().min(1),
  message: z.record(z.string(), z.json()),
});
export const taskV2IntentSchema = z.looseObject({
  kind: z.literal("eip712"),
  operationId: z.string().min(1),
  signer: address,
  typedData: taskV2TypedDataSchema,
});
export const taskV2ConsentResponseSchema = z.looseObject({
  kind: z.literal("consent"),
  workOrderId: z.uuid(),
  consent: z.enum(["award", "split"]),
  signer: address,
  expiry: z.string().regex(/^\d+$/u),
});
export const taskV2PreparedSchema = z.union([taskV2IntentSchema, taskV2OperationResponseSchema]);
export const taskV2SignatureResponseSchema = z.union([
  taskV2ConsentResponseSchema,
  taskV2OperationResponseSchema,
]);
export type TaskV2Action = z.infer<typeof taskV2ActionSchema>;
export type TaskV2Consent = z.infer<typeof taskV2ConsentSchema>;
export type TaskV2Operation = z.infer<typeof taskV2OperationSchema>;
export type TaskV2OperationResponse = z.infer<typeof taskV2OperationResponseSchema>;
export type TaskV2Prepared = z.infer<typeof taskV2PreparedSchema>;
export type TaskV2ConsentResponse = z.infer<typeof taskV2ConsentResponseSchema>;
