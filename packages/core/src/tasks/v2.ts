/** Tasks v2 wire contracts, mirrored from vapi-app tasks-v1 (T7, PR #468).
 * Apache-2.0. Keep base-unit amounts as strings across every transport boundary.
 */
import { z } from "zod";

const amount = z.string().regex(/^[1-9][0-9]*$/u);
const instant = z.iso.datetime();
const label = { label: z.string().trim().min(1).max(200).optional() };
const contains = { mustContain: z.string().min(1).max(8_000).optional() };
export const proofRequirementSchema = z.discriminatedUnion("preset", [
  z.strictObject({ preset: z.literal("link"), ...label, ...contains }),
  z.strictObject({ preset: z.literal("file"), ...label }),
  z.strictObject({
    preset: z.literal("x-post"),
    ...label,
    ...contains,
    holdForSeconds: z.number().int().positive().optional(),
  }),
  z.strictObject({
    preset: z.literal("onchain-tx"),
    ...label,
    chain: z.enum(["base", "base-sepolia", "solana"]).optional(),
  }),
  z.strictObject({ preset: z.literal("pr"), ...label, ...contains }),
  z.strictObject({
    preset: z.literal("text"),
    ...label,
    minLength: z.number().int().positive().optional(),
  }),
  z.strictObject({
    preset: z.literal("media"),
    ...label,
    maxSizeMb: z.number().positive().max(200).optional(),
    kinds: z
      .array(z.enum(["photo", "video"]))
      .min(1)
      .max(2)
      .refine((items) => new Set(items).size === items.length),
    window: z
      .strictObject({
        fromIso: z.iso.datetime({ offset: true }),
        toIso: z.iso.datetime({ offset: true }),
      })
      .refine((value) => Date.parse(value.fromIso) <= Date.parse(value.toIso))
      .optional(),
    geofence: z
      .strictObject({
        lat: z.number().min(-90).max(90),
        lng: z.number().min(-180).max(180),
        radiusKm: z.number().positive(),
      })
      .optional(),
  }),
]);
const proofItems = z.array(proofRequirementSchema).min(1).max(6);
export const proofSpecSchema = z.union([
  proofItems,
  z.strictObject({ items: proofItems, anyOf: z.boolean().optional() }),
]);
export const taskShapeSchema = z.enum(["task", "bounty", "pool"]);
export const checkinCadenceSchema = z.enum(["none", "6h", "24h", "72h", "7d"]);
export const declaredMilestonesSchema = z
  .array(
    z.strictObject({
      index: z.number().int().min(1).max(5),
      amountBaseUnits: amount,
      acceptance: z.string().trim().min(1).max(2_000),
      deadlineAt: instant,
    }),
  )
  .min(1)
  .max(5)
  .refine(
    (items) => items.every((item, index) => item.index === index + 1),
    "Milestone indices must be consecutive, starting at 1",
  );
export const bountyTermsSchema = z.strictObject({
  winners: z.number().int().min(1).max(50),
  rewardPerWinnerBaseUnits: amount,
  deadlineAt: instant,
  choiceWindowSeconds: z.number().int().positive().optional(),
});
export const poolTermsSchema = z.strictObject({
  rewardPerClaimBaseUnits: amount,
  budgetBaseUnits: amount,
  gate: z.enum(["open", "proven"]).optional(),
  verifier: z.enum(["poster", "vapi"]).optional(),
  openCheck: z.enum(["allowlist", "invite", "x-age", "phone"]).optional(),
});
export const taskTermsFields = {
  shape: taskShapeSchema.optional(),
  milestones: declaredMilestonesSchema.optional(),
  proofSpec: proofSpecSchema.optional(),
  checkin: checkinCadenceSchema.optional(),
  bounty: bountyTermsSchema.optional(),
  pool: poolTermsSchema.optional(),
};
export const taskTermsSchema = z.looseObject({
  ...taskTermsFields,
  shape: taskShapeSchema,
  liveness: z
    .looseObject({
      nextDueAt: instant.nullable().optional(),
      stalledAt: instant.nullable().optional(),
    })
    .optional(),
});
export const checkinInputSchema = z.strictObject({
  status: z.enum(["on-track", "blocked", "need-input"]),
  note: z.string().trim().min(1).max(1_000),
  link: z
    .url({ protocol: /^https?$/u })
    .max(2_048)
    .optional(),
});
export const checkinResponseSchema = z.looseObject({
  entries: z.array(
    checkinInputSchema.extend({
      at: instant,
      byAddress: z.string(),
      idempotencyKey: z.uuid().optional(),
    }),
  ),
  nextDueAt: instant.optional(),
  stalledAt: instant.optional(),
});
export const nextActionSchema = z.looseObject({
  action: z.enum(["award", "release", "deliver", "counter-evidence", "checkin", "judge", "none"]),
  amountBaseUnits: amount.optional(),
  dueAt: instant.optional(),
});
const lifecycleMilestone = z.looseObject({
  id: z.string(),
  status: z.enum(["pending", "submitted", "released", "refunded", "disputed", "split"]),
  amountBaseUnits: amount,
  dueAt: instant.optional(),
});
export const taskLifecycleSchema = z.union([
  z.looseObject({
    shape: z.literal("task"),
    state: z.enum(["Draft", "Open", "Active", "Settled", "Refunded", "Cancelled"]),
    substate: z.enum(["InProgress", "Submitted", "Stalled", "Disputed"]).optional(),
    milestones: z.array(lifecycleMilestone),
  }),
  z.looseObject({
    shape: z.literal("bounty"),
    state: z.enum(["Draft", "Open", "Judging", "Awarded", "Refunded", "Cancelled"]),
    amountBaseUnits: amount.optional(),
    dueAt: instant.optional(),
  }),
  z.looseObject({ shape: z.literal("pool"), state: z.enum(["Draft", "Open", "Paused", "Closed"]) }),
]);
export const taskViewFields = {
  terms: taskTermsSchema.optional(),
  lifecycle: taskLifecycleSchema.nullable().optional(),
  nextAction: nextActionSchema.optional(),
};
export const pendingActionsResponseSchema = z.looseObject({
  pendingActions: z.array(
    nextActionSchema.extend({
      orderId: z.string().min(1),
      title: z.string(),
      role: z.enum(["poster", "worker"]),
      clientVerb: z.string(),
      deepLink: z.string().startsWith("/orders/"),
    }),
  ),
});
export type TaskTerms = z.infer<typeof taskTermsSchema>;
export type TaskShape = z.infer<typeof taskShapeSchema>;
export type TaskLifecycle = z.infer<typeof taskLifecycleSchema>;
export type TaskNextAction = z.infer<typeof nextActionSchema>;
export type CheckinInput = z.infer<typeof checkinInputSchema>;
export type CheckinResponse = z.infer<typeof checkinResponseSchema>;
export type PendingActionsResponse = z.infer<typeof pendingActionsResponseSchema>;
export type ProofRequirement = z.infer<typeof proofRequirementSchema>;

/** Typed payloads for the Tasks v2 alerts. Existing event envelopes remain forward compatible. */
export type TasksV2Event =
  | { type: "task.claimed"; payload: { taskId: string; submissionCount: 1 } }
  | {
      type: "task.judging";
      payload: { taskId: string; submissionCount: number; choiceDeadline: string };
    }
  | {
      type: "task.checkin";
      payload: { taskId: string; status: CheckinInput["status"]; note?: string; link?: string };
    }
  | { type: "task.stalled"; payload: { taskId: string; reason?: string } }
  | { type: "task.milestone" | "task.released"; payload: { taskId: string; milestoneId?: string } };
