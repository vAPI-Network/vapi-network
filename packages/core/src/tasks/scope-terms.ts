import { keccak256, toBytes } from "viem";
import { z } from "zod";

import { canonicalJson } from "./canonical-json.js";

const addressSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/)
  .transform((address) => address.toLowerCase() as `0x${string}`);

const networkSchema = z
  .string()
  .regex(/^eip155:(0|[1-9][0-9]*)$/)
  .transform((network) => network as `eip155:${number}`);

const unsignedDecimalSchema = z
  .string()
  .regex(/^(0|[1-9][0-9]*)$/)
  .refine((value) => BigInt(value) > 0n, "Amount must be greater than zero");

export const DEFAULT_ACCEPTANCE_WINDOW_SECONDS = 604_800;

export const milestoneTermsSchema = z
  .object({
    version: z.literal("work-milestone-terms-v1"),
    title: z.string().trim().min(3).max(120),
    description: z.string().trim().min(10).max(8_000),
    acceptanceCriteria: z.array(z.string().trim().min(3).max(500)).min(1).max(20),
    workDurationSeconds: z
      .number()
      .int()
      .min(600, "Task duration must be at least 10 minutes.")
      .max(7_776_000)
      .optional(),
    acceptanceWindowSeconds: z
      .number()
      .int()
      .min(60)
      .max(2_592_000)
      .default(DEFAULT_ACCEPTANCE_WINDOW_SECONDS),
    budget: z.object({
      network: networkSchema,
      asset: z.string().regex(/^eip155:[^/]+\/erc20:0x[0-9a-fA-F]{40}$/),
      amountBaseUnits: unsignedDecimalSchema,
    }),
    escrow: z.object({
      protocol: z.literal("escrow-v1"),
      contract: addressSchema,
    }),
    evidenceRules: z.object({
      acceptedInputs: z
        .array(z.enum(["text", "private-file", "git-commit"]))
        .min(1)
        .max(3)
        .refine(
          (values) => new Set(values).size === values.length,
          "Evidence inputs must be unique",
        ),
      exactCommitRequired: z.boolean(),
    }),
  })
  .strict()
  .superRefine((terms, context) => {
    const assetNetwork = terms.budget.asset.split("/")[0];
    if (assetNetwork !== terms.budget.network) {
      context.addIssue({
        code: "custom",
        path: ["budget", "asset"],
        message: "Asset and escrow must use the same network",
      });
    }
  });

export type MilestoneTerms = z.infer<typeof milestoneTermsSchema>;
export type MilestoneTermsInput = z.input<typeof milestoneTermsSchema>;

export const scopeStructuredTermsSchema = milestoneTermsSchema.safeExtend({
  deliverables: z.array(z.string().trim().min(3).max(500)).min(1).max(50),
  revisionCount: z.number().int().min(0).max(100),
  deadline: z.iso.datetime(),
});

export const scopeBriefSchema = z
  .string()
  .max(32_000)
  .refine((brief) => brief.trim().length > 0, "Scope brief is required");

export type ScopeStructuredTerms = z.infer<typeof scopeStructuredTermsSchema>;
export type ScopeStructuredTermsInput = z.input<typeof scopeStructuredTermsSchema>;

export const scopeSigningPayloadSchema = z
  .object({
    version: z.literal("work-scope-signature-v1"),
    workOrderId: z.uuid(),
    trancheOrdinal: z.number().int().positive(),
    scopeVersion: z.number().int().positive(),
    termsHash: z
      .string()
      .regex(/^0x[0-9a-fA-F]{64}$/)
      .transform((digest) => digest.toLowerCase() as `0x${string}`),
  })
  .strict();

export type ScopeSigningPayload = z.infer<typeof scopeSigningPayloadSchema>;

export type FrozenScopeTerms = {
  structured: ScopeStructuredTerms;
  brief: string;
  termsHash: `0x${string}`;
};

export function freezeScopeTerms(structuredInput: unknown, briefInput: unknown): FrozenScopeTerms {
  const structured = scopeStructuredTermsSchema.parse(structuredInput);
  const brief = scopeBriefSchema.parse(briefInput);
  return {
    structured,
    brief,
    termsHash: keccak256(toBytes(canonicalJson({ structured, brief }))),
  };
}
