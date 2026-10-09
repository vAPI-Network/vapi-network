import { z } from "zod";

const uuidSchema = z.uuid();
const isoDateTimeSchema = z.iso.datetime();
const addressSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/)
  .transform((value) => value.toLowerCase() as `0x${string}`);
const bytes32Schema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/)
  .transform((value) => value.toLowerCase() as `0x${string}`);
const signatureSchema = z
  .string()
  .regex(/^0x(?:[0-9a-fA-F]{2})+$/)
  .max(32_770);
const unsignedDecimalSchema = z.string().regex(/^(0|[1-9][0-9]*)$/);
const positiveDecimalSchema = unsignedDecimalSchema.pipe(
  z.string().refine((value) => BigInt(value) > 0n, "Amount must be greater than zero"),
);
const networkSchema = z
  .string()
  .regex(/^eip155:[1-9][0-9]*$/)
  .transform((value) => value as `eip155:${string}`);
// Tasks milestone terms permit CAIP-2 chain id zero; transaction plans and
// deployment responses use the positive-chain schema above.
const milestoneNetworkSchema = z
  .string()
  .regex(/^eip155:(0|[1-9][0-9]*)$/)
  .transform((value) => value as `eip155:${number}`);
const assetSchema = z.string().regex(/^eip155:[^/]+\/erc20:0x[0-9a-fA-F]{40}$/);
const hexDataSchema = z
  .string()
  .regex(/^0x(?:[0-9a-fA-F]{2})*$/)
  .transform((value) => value.toLowerCase() as `0x${string}`);

export const workPolicyFamilySchema = z.enum([
  "general-digital",
  "software-api",
  "research-data",
  "design-content",
]);

export const milestoneTermsSchema = z
  .object({
    version: z.literal("work-milestone-terms-v1"),
    title: z.string().trim().min(3).max(120),
    description: z.string().trim().min(10).max(8_000),
    acceptanceCriteria: z.array(z.string().trim().min(3).max(500)).min(1).max(20),
    workDurationSeconds: z.number().int().min(600).max(7_776_000).optional(),
    acceptanceWindowSeconds: z.number().int().min(60).max(2_592_000).default(604_800),
    budget: z.object({
      network: milestoneNetworkSchema,
      asset: assetSchema,
      amountBaseUnits: positiveDecimalSchema,
    }),
    escrow: z.object({ protocol: z.literal("escrow-v1"), contract: addressSchema }),
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
  .superRefine((terms, context) => {
    if (terms.budget.asset.split("/")[0] !== terms.budget.network) {
      context.addIssue({
        code: "custom",
        path: ["budget", "asset"],
        message: "Asset and escrow must use the same network",
      });
    }
  });

const scopeStructuredTermsSchema = milestoneTermsSchema.safeExtend({
  deliverables: z.array(z.string().trim().min(3).max(500)).min(1).max(50),
  revisionCount: z.number().int().min(0).max(100),
  deadline: isoDateTimeSchema,
});

export const submissionProofSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("url"),
    value: z.url({ protocol: /^https$/u }),
    label: z.string().optional(),
  }),
  z.object({
    kind: z.literal("file"),
    value: z.string().regex(/^[0-9a-f]{64}$/),
    label: z.string().optional(),
  }),
]);

export const proposalSigningPayloadSchema = z
  .object({
    version: z.literal("work-proposal-v1"),
    workOrderId: uuidSchema,
    providerAddress: addressSchema,
    pricingModel: z.literal("fixed"),
    milestones: z.array(milestoneTermsSchema).length(1),
    kind: z.enum(["proposal", "submission"]).optional(),
    proof: z.array(submissionProofSchema).optional(),
  })
  .superRefine((payload, context) => {
    if (payload.kind === "submission" && payload.proof === undefined) {
      context.addIssue({
        code: "custom",
        path: ["proof"],
        message: "Submission proof is required",
      });
    }
  });

export const scopeSigningPayloadSchema = z.object({
  version: z.literal("work-scope-signature-v1"),
  workOrderId: uuidSchema,
  trancheOrdinal: z.number().int().positive(),
  scopeVersion: z.number().int().positive(),
  termsHash: bytes32Schema,
});

export const createOrderInputSchema = z
  .object({
    title: z.string().trim().min(3).max(120),
    description: z.string().trim().min(10).max(8_000),
    policyFamily: workPolicyFamilySchema,
    listingDeliveryTimeSeconds: z.number().int().min(3_600).max(7_776_000).optional(),
    invitedProviderAddress: addressSchema.optional(),
    market: z
      .object({
        intake: z.enum(["proposals", "submissions"]).optional(),
        maxAwards: z.number().int().min(1).max(50).optional(),
        audience: z.enum(["anyone", "verified", "agents", "humans", "invited"]).optional(),
        proofKinds: z
          .array(z.enum(["url", "file", "photo"]))
          .max(3)
          .refine((values) => new Set(values).size === values.length, "Proof kinds must be unique")
          .optional(),
        budget: z
          .object({
            network: milestoneNetworkSchema,
            asset: z.literal("USDC"),
            amountBaseUnits: positiveDecimalSchema,
          })
          .strict()
          .optional(),
        deadlineAt: isoDateTimeSchema.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const proposeInputSchema = z.object({
  signedPayload: proposalSigningPayloadSchema,
  signature: signatureSchema,
});

export const submitInputSchema = z.object({
  signedPayload: proposalSigningPayloadSchema.safeExtend({
    kind: z.literal("submission"),
    proof: z.array(submissionProofSchema),
  }),
  signature: signatureSchema,
});

export const acceptProposalInputSchema = z.object({ proposalId: uuidSchema });

export const proposeScopeInputSchema = z.object({
  structuredTerms: scopeStructuredTermsSchema,
  brief: z
    .string()
    .max(32_000)
    .refine((value) => value.trim().length > 0, "Scope brief is required"),
  signedPayload: scopeSigningPayloadSchema,
  signature: signatureSchema,
});

export const signScopeInputSchema = z.object({
  signedPayload: scopeSigningPayloadSchema,
  signature: signatureSchema,
});

const uint256Schema = unsignedDecimalSchema.refine(
  (value) => BigInt(value) < 1n << 256n,
  "value exceeds uint256",
);
const fundingAuthorizationSchema = z
  .object({
    validAfter: uint256Schema,
    validBefore: uint256Schema,
    nonce: bytes32Schema,
    signature: signatureSchema,
  })
  .superRefine((authorization, context) => {
    if (BigInt(authorization.validBefore) <= BigInt(authorization.validAfter)) {
      context.addIssue({
        code: "custom",
        path: ["validBefore"],
        message: "validBefore must be later than validAfter",
      });
    }
  });

export const fundEscrowInputSchema = z.union([
  z.object({ authorization: fundingAuthorizationSchema }),
  z.record(z.string(), z.never()),
]);
export const deliverEscrowInputSchema = z.object({
  fileIds: z
    .array(uuidSchema)
    .min(0)
    .max(20)
    .refine((values) => new Set(values).size === values.length, "File ids must be unique"),
  note: z
    .string()
    .max(32_000)
    .refine((value) => value.trim().length > 0, "Delivery note is required"),
});
export const disputeEscrowInputSchema = z.object({ evidenceHash: bytes32Schema });

export const workFileMimeTypeSchema = z.enum([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "application/pdf",
  "application/zip",
  "text/plain",
  "text/markdown",
  "application/json",
  "text/csv",
]);
export const workFilePurposeSchema = z.enum(["message-attachment", "delivery", "portfolio"]);
export const createUploadInputSchema = z.object({
  purpose: workFilePurposeSchema,
  fileName: z.string().trim().min(1).max(255),
  mimeType: workFileMimeTypeSchema,
  sizeBytes: z
    .number()
    .int()
    .min(1)
    .max(50 * 1024 * 1024),
});

export const listOrdersQuerySchema = z.object({
  scope: z.enum(["public", "private"]).optional(),
  cursor: uuidSchema.optional(),
});
export const listMessagesQuerySchema = z.object({ beforeSeq: z.number().int().min(1).optional() });
export const sendMessageInputSchema = z.object({
  body: z
    .string()
    .trim()
    .superRefine((body, context) => {
      const characterCount = Array.from(body).length;
      if (characterCount < 1 || characterCount > 10_000) {
        context.addIssue({
          code: "custom",
          message: "Message body must be between 1 and 10000 characters",
        });
      }
    }),
  fileIds: z
    .array(uuidSchema)
    .max(5)
    .optional()
    .superRefine((fileIds, context) => {
      if (fileIds && new Set(fileIds).size !== fileIds.length) {
        context.addIssue({ code: "custom", message: "Attachment ids must be unique" });
      }
    }),
});

export const eventsQuerySchema = z.object({
  after: z.number().int().nonnegative().safe().optional(),
  wait: z
    .number()
    .int()
    .safe()
    .transform((value) => Math.min(25, Math.max(0, value)))
    .optional(),
});

export const operationMutationInputSchema = z
  .object({
    step: z.union([
      z.enum([
        "create-escrow",
        "approve-usdc",
        "deposit-funds",
        "fund-with-authorization",
        "submit-delivery",
        "release-funds",
        "refund-buyer",
        "raise-dispute",
        "timeout-refund",
        "finalize",
        "vote-dispute",
        "mint-vendor-credential",
      ]),
      z.literal("register-erc8004"),
    ]),
    transactionHash: bytes32Schema,
  })
  .strict();
export const operationStepInputSchema = z
  .object({ step: operationMutationInputSchema.shape.step })
  .strict();
export const configureWebhookInputSchema = z.object({ url: z.url().max(2048).nullable() }).strict();

export const boardQuerySchema = z.object({
  tab: z.enum(["trending", "new", "closing", "paid"]).optional(),
  limit: z.number().int().positive().optional(),
  cursor: z.string().optional(),
});

export const feedQuerySchema = z.object({
  after: z.string().optional(),
  limit: z.number().int().positive().optional(),
});

const proposalResponseSchema = z.looseObject({
  id: uuidSchema,
  workOrderId: uuidSchema,
  providerAddress: addressSchema,
  state: z.enum(["pending", "accepted", "rejected"]),
  signedPayload: proposalSigningPayloadSchema.loose(),
  signature: signatureSchema,
  signatureHash: bytes32Schema,
  proposedMilestones: z.array(milestoneTermsSchema).length(1),
  acceptedAt: isoDateTimeSchema.nullable(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});

const chainPlanSchema = z
  .looseObject({
    version: z.literal("work-transaction-plan-v2"),
    operationId: uuidSchema,
    step: z.enum([
      "create-escrow",
      "approve-usdc",
      "deposit-funds",
      "fund-with-authorization",
      "submit-delivery",
      "release-funds",
      "refund-buyer",
      "raise-dispute",
      "timeout-refund",
      "finalize",
      "vote-dispute",
      "mint-vendor-credential",
      "register-erc8004",
    ]),
    chainId: z.number().int().positive(),
    network: networkSchema,
    from: addressSchema,
    to: addressSchema,
    data: hexDataSchema,
    value: z.literal("0"),
  })
  .superRefine((plan, context) => {
    if (plan.network !== `eip155:${plan.chainId}`) {
      context.addIssue({
        code: "custom",
        path: ["network"],
        message: "Network must match chain id",
      });
    }
  });

const chainOperationSchema = z
  .looseObject({
    id: uuidSchema,
    kind: z.enum([
      "escrow-create",
      "escrow-funding",
      "escrow-delivery",
      "escrow-release",
      "escrow-dispute",
      "escrow-vote",
      "escrow-finalize",
      "vendor-credential-mint",
    ]),
    state: z.enum(["prepared", "submitted", "confirmed"]),
    step: z.enum([
      "create-escrow",
      "approve-usdc",
      "deposit-funds",
      "fund-with-authorization",
      "submit-delivery",
      "release-funds",
      "refund-buyer",
      "raise-dispute",
      "timeout-refund",
      "finalize",
      "vote-dispute",
      "mint-vendor-credential",
    ]),
    expectedActor: addressSchema.nullable(),
    transactionHash: bytes32Schema.nullable(),
    plan: chainPlanSchema.nullable(),
  })
  .superRefine((operation, context) => {
    if ((operation.state === "prepared" || operation.state === "submitted") && !operation.plan) {
      context.addIssue({ code: "custom", path: ["plan"], message: "Operation plan is required" });
    }
    if (
      (operation.state === "submitted" || operation.state === "confirmed") &&
      !operation.transactionHash
    ) {
      context.addIssue({
        code: "custom",
        path: ["transactionHash"],
        message: "Transaction hash is required",
      });
    }
    if (operation.plan && operation.plan.operationId !== operation.id) {
      context.addIssue({
        code: "custom",
        path: ["plan", "operationId"],
        message: "Plan operation mismatch",
      });
    }
    if (operation.plan && operation.plan.step !== operation.step) {
      context.addIssue({ code: "custom", path: ["plan", "step"], message: "Plan step mismatch" });
    }
    if (
      operation.plan &&
      operation.expectedActor &&
      operation.plan.from !== operation.expectedActor
    ) {
      context.addIssue({
        code: "custom",
        path: ["plan", "from"],
        message: "Plan sender mismatch",
      });
    }
  });

const escrowActionResponseSchema = z.looseObject({
  operation: chainOperationSchema,
  milestone: z.looseObject({ id: uuidSchema, workOrderId: uuidSchema }),
});

const manifestResponseSchema = z.looseObject({
  files: z
    .array(
      z.looseObject({
        fileId: uuidSchema,
        fileName: z.string().min(1).max(255),
        sha256: z.string().regex(/^[0-9a-fA-F]{64}$/),
        sizeBytes: z.number().int().positive(),
      }),
    )
    .min(0)
    .max(20)
    .refine((files) => new Set(files.map((file) => file.fileId)).size === files.length, {
      message: "File ids must be unique",
    }),
  noteSha256: z.string().regex(/^[0-9a-fA-F]{64}$/),
});

const deliveryResponseSchema = z.looseObject({
  id: uuidSchema,
  milestoneId: uuidSchema,
  version: z.number().int().positive(),
  manifest: manifestResponseSchema,
  manifestHash: bytes32Schema,
  submittedByProfileId: uuidSchema,
  createdAt: isoDateTimeSchema,
});

const orderDeliveryResponseSchema = z.looseObject({
  id: uuidSchema,
  version: z.number().int().positive(),
  note: z.string().max(32_000),
  manifest: manifestResponseSchema,
  manifestHash: bytes32Schema,
  submittedAt: isoDateTimeSchema,
});

const escrowStateSchema = z.enum([
  "created",
  "locked",
  "submitted",
  "disputed",
  "resolved",
  "expired",
]);
const escrowResolutionSchema = z.enum(["release", "refund", "split"]);
const disputeResponseSchema = z.looseObject({
  id: z.string().min(1),
  state: z.enum(["open", "evidence", "resolvable", "executed"]),
  network: z.string().min(1),
  escrowAddress: addressSchema,
  raisedByRole: z.enum(["client", "vendor"]),
  raisedByAddress: addressSchema,
  evidenceHash: bytes32Schema,
  evidenceDeadlineAt: isoDateTimeSchema,
  reviewers: z
    .array(
      z.looseObject({
        address: addressSchema,
        vote: z
          .looseObject({
            outcome: escrowResolutionSchema,
            txHash: bytes32Schema,
            votedAt: isoDateTimeSchema,
          })
          .nullable(),
      }),
    )
    .max(3),
  outcome: escrowResolutionSchema.nullable(),
  executedTxHash: bytes32Schema.nullable(),
  resolvedAt: isoDateTimeSchema.nullable(),
});

const milestoneResponseSchema = z
  .looseObject({
    id: uuidSchema,
    workOrderId: uuidSchema,
    ordinal: z.number().int().positive(),
    state: z.enum([
      "agreed",
      "funding",
      "funded",
      "delivering",
      "delivered",
      "evaluating",
      "released",
      "refunded",
    ]),
    terms: milestoneTermsSchema,
    termsHash: bytes32Schema,
    termsFrozenAt: isoDateTimeSchema,
    network: milestoneNetworkSchema,
    asset: assetSchema,
    amountBaseUnits: unsignedDecimalSchema,
    escrowProtocol: z.literal("escrow-v1"),
    escrowContract: addressSchema,
    escrowState: escrowStateSchema.nullable(),
    resolution: escrowResolutionSchema.nullable(),
    offerDeadlineAt: isoDateTimeSchema.nullable(),
    workDeadlineAt: isoDateTimeSchema.nullable(),
    acceptanceDeadlineAt: isoDateTimeSchema.nullable(),
    dispute: disputeResponseSchema.nullable(),
    chainOperation: chainOperationSchema.nullable(),
    artifact: z.looseObject({ digest: bytes32Schema }).nullable(),
    delivery: orderDeliveryResponseSchema.nullable().optional(),
    fundingTxHash: bytes32Schema.nullable(),
    settlementTxHash: bytes32Schema.nullable(),
    fundedAt: isoDateTimeSchema.nullable(),
    deliveredAt: isoDateTimeSchema.nullable(),
    settledAt: isoDateTimeSchema.nullable(),
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
  })
  .superRefine((milestone, context) => {
    if (milestone.asset.split("/")[0] !== milestone.network) {
      context.addIssue({
        code: "custom",
        path: ["asset"],
        message: "Asset and escrow must use the same network",
      });
    }
  });

const publicOrderSchema = z.looseObject({
  version: z.undefined().optional(),
  id: uuidSchema,
  state: z.literal("open"),
  title: z.string(),
  description: z.string(),
  policyFamily: workPolicyFamilySchema,
  listingDeliveryTimeSeconds: z.number().int().positive().nullable(),
  publishedAt: isoDateTimeSchema,
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});

const reviewResponseSchema = z.looseObject({
  id: uuidSchema,
  workOrderId: uuidSchema,
  clientAddress: addressSchema,
  vendorProfileId: uuidSchema,
  rating: z.number().int().min(1).max(5),
  body: z.string(),
  subRatings: z.json().nullable(),
  vendorResponse: z.string().nullable(),
  vendorRespondedAt: isoDateTimeSchema.nullable(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});

const eventResponseSchema = z.looseObject({
  id: z.string().trim().min(1),
  sequence: z.number().int().positive(),
  type: z.string().min(1),
  actor: z.string().min(1),
  milestoneId: uuidSchema.nullable(),
  payload: z.json(),
  txHash: bytes32Schema.nullable(),
  createdAt: isoDateTimeSchema,
});

const privateOrderSchema = z.looseObject({
  version: z.literal("work-order-view-v1"),
  id: uuidSchema,
  state: z.enum(["open", "awarded", "completed", "cancelled"]),
  title: z.string(),
  description: z.string(),
  policyFamily: workPolicyFamilySchema,
  listingDeliveryTimeSeconds: z.number().int().positive().nullable(),
  clientAddress: addressSchema,
  invitedProviderAddress: addressSchema.nullable(),
  acceptedProposalId: uuidSchema.nullable(),
  threadId: uuidSchema.nullable(),
  role: z.enum(["client", "provider", "proposer"]),
  canFinalize: z.boolean(),
  proposals: z.array(proposalResponseSchema),
  milestones: z.array(milestoneResponseSchema),
  events: z.array(eventResponseSchema),
  review: reviewResponseSchema.nullable(),
  publishedAt: isoDateTimeSchema.nullable(),
  completedAt: isoDateTimeSchema.nullable(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});

const orderSchema = z.discriminatedUnion("version", [privateOrderSchema, publicOrderSchema]);
const pageSchema = z.looseObject({ nextCursor: uuidSchema.nullable() });

const scopeResponseSchema = z.looseObject({
  id: uuidSchema,
  workOrderId: uuidSchema,
  trancheOrdinal: z.number().int().positive(),
  version: z.number().int().positive(),
  state: z.enum(["proposed", "accepted", "superseded", "withdrawn"]),
  structuredTerms: scopeStructuredTermsSchema,
  brief: z.string(),
  termsHash: bytes32Schema,
  proposedByRole: z.enum(["client", "provider"]),
  proposerAddress: addressSchema,
  proposerSignature: signatureSchema,
  counterpartyAddress: addressSchema.nullable(),
  counterpartySignature: signatureSchema.nullable(),
  acceptedAt: isoDateTimeSchema.nullable(),
  milestoneId: uuidSchema.nullable(),
  createdAt: isoDateTimeSchema,
  signingPayload: scopeSigningPayloadSchema,
});

const messageSchema = z.looseObject({
  id: z.string().min(1),
  threadId: uuidSchema,
  senderProfileId: z.string().min(1),
  senderRole: z.enum(["client", "provider", "reviewer"]),
  kind: z.enum(["text", "order-pin", "scope-pin", "delivery-pin", "system"]),
  body: z.string(),
  refType: z.string().nullable(),
  refId: z.string().nullable(),
  workOrderId: uuidSchema.nullable(),
  orderId: uuidSchema,
  seq: z.number().int().positive(),
  createdAt: isoDateTimeSchema,
  attachments: z.array(
    z.looseObject({
      id: uuidSchema,
      fileName: z.string(),
      mimeType: z.string(),
      sizeBytes: z.number().int().nonnegative(),
    }),
  ),
});

const fileSchema = z.looseObject({
  id: uuidSchema,
  purpose: workFilePurposeSchema,
  fileName: z.string(),
  mimeType: workFileMimeTypeSchema,
  sizeBytes: z.number().int().positive(),
  sha256: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/)
    .nullable(),
  state: z.enum(["pending", "ready"]),
  createdAt: isoDateTimeSchema,
});

const chainReadSchema = z.discriminatedUnion("status", [
  z.looseObject({ status: z.literal("pending") }),
  z.looseObject({
    status: z.literal("confirmed"),
    state: escrowStateSchema,
    resolution: z.enum(["released", "refunded", "split"]).nullable(),
    offerDeadlineAt: isoDateTimeSchema.nullable(),
    workDeadlineAt: isoDateTimeSchema.nullable(),
    reviewDeadlineAt: isoDateTimeSchema.nullable(),
    amountBaseUnits: unsignedDecimalSchema.optional(),
    token: addressSchema.optional(),
    buyer: addressSchema.optional(),
    seller: addressSchema.optional(),
    termsHash: bytes32Schema.optional(),
    deliveryHash: bytes32Schema.optional(),
  }),
  z.looseObject({
    status: z.literal("mirror"),
    state: escrowStateSchema,
  }),
  z.looseObject({
    status: z.literal("unavailable"),
    reason: z.enum(["rpc", "unsupported-network", "invalid-escrow", "frozen-terms-mismatch"]),
  }),
]);

const deploymentSchema = z
  .discriminatedUnion("configured", [
    z.looseObject({
      configured: z.literal(false),
      feeBp: z.number().int().min(0).max(10_000).nullable().optional(),
      chainId: z.number().int().positive(),
      network: networkSchema,
      explorerUrl: z.url().nullable(),
      capabilities: z.looseObject({
        erc3009Funding: z.literal(false),
        vapiVerify: z.literal(false),
      }),
      eip3009Domain: z.null(),
    }),
    z.looseObject({
      configured: z.literal(true),
      feeBp: z.number().int().min(0).max(10_000).nullable().optional(),
      chainId: z.number().int().positive(),
      network: networkSchema,
      explorerUrl: z.url(),
      escrowContract: addressSchema,
      feeRouter: addressSchema,
      usdc: addressSchema,
      capabilities: z.looseObject({ erc3009Funding: z.boolean(), vapiVerify: z.boolean() }),
      eip3009Domain: z
        .looseObject({
          name: z.string(),
          version: z.string(),
          chainId: z.number().int().positive(),
          verifyingContract: addressSchema,
        })
        .nullable(),
      maxEscrowAmountBaseUnits: unsignedDecimalSchema,
      defaults: z.looseObject({ workDurationSeconds: z.number().int().positive() }),
      verifyReviewPriceBaseUnits: z.null(),
    }),
  ])
  .superRefine((deployment, context) => {
    if (deployment.network !== `eip155:${deployment.chainId}`) {
      context.addIssue({
        code: "custom",
        path: ["network"],
        message: "Deployment network must match chain id",
      });
    }
    if (
      deployment.configured &&
      deployment.eip3009Domain &&
      deployment.eip3009Domain.chainId !== deployment.chainId
    ) {
      context.addIssue({
        code: "custom",
        path: ["eip3009Domain", "chainId"],
        message: "EIP-3009 domain chain id must match deployment",
      });
    }
    if (
      deployment.configured &&
      deployment.eip3009Domain &&
      deployment.eip3009Domain.verifyingContract !== deployment.usdc
    ) {
      context.addIssue({
        code: "custom",
        path: ["eip3009Domain", "verifyingContract"],
        message: "EIP-3009 verifying contract must match USDC",
      });
    }
  });

export const partyBadgeSchema = z.looseObject({
  kind: z.enum(["agent", "human"]),
  source: z.enum(["agent-link", "erc8004", "none"]),
  owner: z.looseObject({ profileId: z.string(), label: z.string() }).nullable(),
  verifiedWorker: z.boolean(),
});

const publicPartySchema = z.looseObject({ address: z.string(), badge: partyBadgeSchema });
const publicAmountSchema = z.looseObject({
  gross: z.string(),
  fee: z.string().nullable(),
  net: z.string().nullable(),
  asset: z.literal("USDC"),
  feeBp: z.number().nullable(),
});
const publicTaskStateSchema = z.enum([
  "open",
  "awarded",
  "funded",
  "delivered",
  "paid",
  "refunded",
  "disputed",
  "expired",
  "closed",
]);

export const publicTaskCardSchema = z.looseObject({
  id: z.string(),
  title: z.string(),
  brief: z.string(),
  shape: z.enum(["task", "open-bounty"]),
  amount: publicAmountSchema.nullable(),
  deadlineAt: z.string().nullable(),
  durationSeconds: z.number().nullable(),
  createdAt: z.string(),
  state: publicTaskStateSchema,
  poster: publicPartySchema,
  takers: z.number(),
  awards: z.number(),
  maxAwards: z.number(),
  proofKinds: z.array(z.string()),
  audience: z.string(),
  receiptUrl: z.string().nullable(),
});

export const publicReceiptSchema = z.looseObject({
  escrow: z.string(),
  orderId: z.string(),
  title: z.string(),
  poster: publicPartySchema,
  worker: publicPartySchema,
  amount: publicAmountSchema,
  postedAt: z.string(),
  fundedAt: z.string().nullable(),
  deliveredAt: z.string().nullable(),
  settledAt: z.string(),
  outcome: z.enum(["released", "refunded", "split", "expired"]),
  allocations: z
    .looseObject({
      worker: z.string(),
      poster: z.string(),
      fee: z.string(),
      reviewers: z.string(),
    })
    .nullable(),
  txs: z.looseObject({ funded: z.string().nullable(), settled: z.string().nullable() }),
  explorerUrl: z.string(),
  disputed: z.boolean(),
  network: z.string(),
});

export const boardNumbersSchema = z.looseObject({
  escrowedNow: z.string(),
  paidOutAllTime: z.string(),
  tasksSettled: z.number(),
  agentsActive30d: z.number(),
  feeBp: z.number().nullable(),
  call: z
    .looseObject({
      routedThroughVapi30d: z.number(),
      paymentsOnBase30d: z.number(),
      volumeUsdOnBase30d: z.string(),
      asOf: z.string(),
    })
    .nullable()
    .optional(),
});

export const feedRowSchema = z.looseObject({
  cursor: z.string(),
  at: z.string(),
  kind: z.enum([
    "posted",
    "taken",
    "awarded",
    "funded",
    "delivered",
    "paid",
    "refunded",
    "disputed",
  ]),
  orderId: z.string(),
  title: z.string(),
  amount: z.string().nullable(),
  actor: publicPartySchema,
  counterparty: publicPartySchema.nullable(),
  receiptUrl: z.string().nullable(),
});

export const publicTaskDetailSchema = publicTaskCardSchema.extend({
  briefFull: z.string(),
  children: z.array(
    z.looseObject({
      orderId: z.string(),
      worker: publicPartySchema,
      state: publicTaskStateSchema,
      receiptUrl: z.string().nullable(),
    }),
  ),
});

export const boardResponseSchema = z.looseObject({
  pinned: publicTaskCardSchema.nullable(),
  numbers: boardNumbersSchema,
  cards: z.array(publicTaskCardSchema),
  nextCursor: z.string().nullable(),
});

export const feedResponseSchema = z.looseObject({
  rows: z.array(feedRowSchema),
  nextCursor: z.string().nullable(),
});

export const earnResponseSchema = z.looseObject({
  numbers: boardNumbersSchema,
  topEarners: z.looseObject({
    humans: z.array(
      z.looseObject({
        address: z.string(),
        badge: partyBadgeSchema,
        paidOut30d: z.string(),
        tasks: z.number(),
      }),
    ),
    agents: z.array(
      z.looseObject({
        address: z.string(),
        badge: partyBadgeSchema,
        paidOut30d: z.string(),
        tasks: z.number(),
      }),
    ),
  }),
  openByPayout: z.array(publicTaskCardSchema),
});

export const eventsResponseSchema = z.looseObject({
  events: z.array(
    z.looseObject({
      sequence: z.number(),
      type: z.string(),
      at: z.string(),
      actor: z.string(),
      payload: z.record(z.string(), z.unknown()),
    }),
  ),
  nextAfter: z.number(),
});

const proposalMutationResponseSchema = z.looseObject({ proposal: proposalResponseSchema });

// Mirrors the server response boundaries in Tasks while allowing additive fields.
export const tasksResponseSchemas = {
  listOrders: z.looseObject({ workOrders: z.array(orderSchema), page: pageSchema }),
  getOrder: z.looseObject({ workOrder: orderSchema }),
  createOrder: z.looseObject({ workOrder: privateOrderSchema }),
  propose: proposalMutationResponseSchema,
  submit: proposalMutationResponseSchema,
  events: eventsResponseSchema,
  board: boardResponseSchema,
  feed: feedResponseSchema,
  publicTask: publicTaskDetailSchema.nullable(),
  receipt: publicReceiptSchema.nullable(),
  earn: earnResponseSchema,
  acceptProposal: z.union([
    z.looseObject({ workOrder: privateOrderSchema }),
    z.looseObject({
      childOrderId: uuidSchema,
      awards: z.number().int().positive(),
      maxAwards: z.number().int().min(1).max(50),
      parentState: z.enum(["open", "completed"]),
    }),
  ]),
  getScopes: z.looseObject({ scopes: z.array(scopeResponseSchema) }),
  proposeScope: z.looseObject({ scope: scopeResponseSchema }),
  signScope: z.looseObject({
    scope: scopeResponseSchema,
    milestone: z.looseObject({
      id: uuidSchema,
      workOrderId: uuidSchema,
      ordinal: z.number().int().positive(),
      termsHash: bytes32Schema,
      termsFrozenAt: isoDateTimeSchema,
    }),
  }),
  listMessages: z.looseObject({
    messages: z.array(messageSchema),
    page: z.looseObject({ nextBeforeSeq: z.number().int().positive().nullable() }),
  }),
  sendMessage: z.looseObject({ message: messageSchema }),
  createEscrow: escrowActionResponseSchema,
  fundEscrow: escrowActionResponseSchema,
  deliverEscrow: escrowActionResponseSchema.extend({ delivery: deliveryResponseSchema }),
  releaseEscrow: escrowActionResponseSchema,
  refundEscrow: escrowActionResponseSchema,
  disputeEscrow: escrowActionResponseSchema,
  chainState: z.looseObject({
    workOrderId: uuidSchema,
    milestones: z.array(
      z.looseObject({
        milestoneId: uuidSchema,
        network: networkSchema,
        escrowAddress: addressSchema,
        explorerUrl: z.url().nullable(),
        read: chainReadSchema,
      }),
    ),
    observedAt: isoDateTimeSchema,
  }),
  createUpload: z.looseObject({
    file: fileSchema.extend({ state: z.literal("pending"), sha256: z.null() }),
    uploadUrl: z.url(),
  }),
  finalizeUpload: z.looseObject({
    file: fileSchema.extend({
      state: z.literal("ready"),
      sha256: z.string().regex(/^[0-9a-fA-F]{64}$/),
    }),
  }),
  deployment: deploymentSchema,
  recordTransaction: escrowActionResponseSchema,
  reconcileOperation: escrowActionResponseSchema,
  recoverOperation: escrowActionResponseSchema
    .extend({ recovered: z.boolean(), scanComplete: z.boolean().default(true) })
    .superRefine((value, context) => {
      if (value.recovered && !value.scanComplete)
        context.addIssue({
          code: "custom",
          path: ["scanComplete"],
          message: "Recovered operations require a complete scan",
        });
    }),
  abandonOperation: z
    .looseObject({
      outcome: z.enum(["abandoned", "recovered", "scanning"]),
      operation: chainOperationSchema.nullable(),
      milestone: z.looseObject({ id: uuidSchema, workOrderId: uuidSchema }),
    })
    .superRefine((value, context) => {
      if (
        (value.outcome === "abandoned" && value.operation !== null) ||
        (value.outcome !== "abandoned" && value.operation === null)
      ) {
        context.addIssue({
          code: "custom",
          path: ["operation"],
          message:
            "Abandoned operations must be cleared; recovered or scanning operations must be returned",
        });
      }
    }),
  finalizeEscrow: escrowActionResponseSchema,
  finalizeOrder: z.looseObject({
    workOrder: z.looseObject({
      id: uuidSchema,
      state: z.enum(["completed", "cancelled"]),
      completedAt: isoDateTimeSchema.nullable(),
    }),
  }),
  configureWebhook: z.looseObject({
    webhookUrl: z.url().nullable(),
    secret: z.string().optional(),
  }),
} as const;

export type ListOrdersQuery = z.input<typeof listOrdersQuerySchema>;
export type ListMessagesQuery = z.input<typeof listMessagesQuerySchema>;
export type SendMessageInput = z.input<typeof sendMessageInputSchema>;
export type CreateOrderInput = z.input<typeof createOrderInputSchema>;
export type OperationMutationInput = z.input<typeof operationMutationInputSchema>;
export type OperationStepInput = z.input<typeof operationStepInputSchema>;
export type ConfigureWebhookInput = z.input<typeof configureWebhookInputSchema>;
export type ProposeInput = z.input<typeof proposeInputSchema>;
export type SubmissionProof = z.input<typeof submissionProofSchema>;
export type SubmitInput = z.input<typeof submitInputSchema>;
export type EventsQuery = z.input<typeof eventsQuerySchema>;
export type BoardQuery = z.input<typeof boardQuerySchema>;
export type FeedQuery = z.input<typeof feedQuerySchema>;
export type AcceptProposalInput = z.input<typeof acceptProposalInputSchema>;
export type ProposeScopeInput = z.input<typeof proposeScopeInputSchema>;
export type SignScopeInput = z.input<typeof signScopeInputSchema>;
export type FundEscrowInput = z.input<typeof fundEscrowInputSchema>;
export type DeliverEscrowInput = z.input<typeof deliverEscrowInputSchema>;
export type DisputeEscrowInput = z.input<typeof disputeEscrowInputSchema>;
export type CreateUploadInput = z.input<typeof createUploadInputSchema>;
export type UploadFileInput = {
  fileName: string;
  bytes: Uint8Array;
  contentType?: z.infer<typeof workFileMimeTypeSchema>;
  purpose?: z.infer<typeof workFilePurposeSchema>;
};

export type ListOrdersResponse = z.infer<typeof tasksResponseSchemas.listOrders>;
export type GetOrderResponse = z.infer<typeof tasksResponseSchemas.getOrder>;
export type CreateOrderResponse = z.infer<typeof tasksResponseSchemas.createOrder>;
export type ProposeResponse = z.infer<typeof tasksResponseSchemas.propose>;
export type PartyBadge = z.infer<typeof partyBadgeSchema>;
export type PublicTaskCard = z.infer<typeof publicTaskCardSchema>;
export type PublicReceipt = z.infer<typeof publicReceiptSchema>;
export type BoardNumbers = z.infer<typeof boardNumbersSchema>;
export type FeedRow = z.infer<typeof feedRowSchema>;
export type PublicTaskDetail = z.infer<typeof publicTaskDetailSchema>;
export type EventsResponse = z.infer<typeof tasksResponseSchemas.events>;
export type BoardResponse = z.infer<typeof tasksResponseSchemas.board>;
export type FeedResponse = z.infer<typeof tasksResponseSchemas.feed>;
export type PublicTaskResponse = z.infer<typeof tasksResponseSchemas.publicTask>;
export type ReceiptResponse = z.infer<typeof tasksResponseSchemas.receipt>;
export type EarnResponse = z.infer<typeof tasksResponseSchemas.earn>;
export type SubmitResponse = z.infer<typeof tasksResponseSchemas.submit>;
export type AcceptProposalResponse = z.infer<typeof tasksResponseSchemas.acceptProposal>;
export type GetScopesResponse = z.infer<typeof tasksResponseSchemas.getScopes>;
export type ProposeScopeResponse = z.infer<typeof tasksResponseSchemas.proposeScope>;
export type SignScopeResponse = z.infer<typeof tasksResponseSchemas.signScope>;
export type ListMessagesResponse = z.infer<typeof tasksResponseSchemas.listMessages>;
export type SendMessageResponse = z.infer<typeof tasksResponseSchemas.sendMessage>;
export type CreateEscrowResponse = z.infer<typeof tasksResponseSchemas.createEscrow>;
export type FundEscrowResponse = z.infer<typeof tasksResponseSchemas.fundEscrow>;
export type DeliverEscrowResponse = z.infer<typeof tasksResponseSchemas.deliverEscrow>;
export type ReleaseEscrowResponse = z.infer<typeof tasksResponseSchemas.releaseEscrow>;
export type RefundEscrowResponse = z.infer<typeof tasksResponseSchemas.refundEscrow>;
export type DisputeEscrowResponse = z.infer<typeof tasksResponseSchemas.disputeEscrow>;
export type ChainStateResponse = z.infer<typeof tasksResponseSchemas.chainState>;
export type CreateUploadResponse = z.infer<typeof tasksResponseSchemas.createUpload>;
export type FinalizeUploadResponse = z.infer<typeof tasksResponseSchemas.finalizeUpload>;
export type DeploymentResponse = z.infer<typeof tasksResponseSchemas.deployment>;
export type RecordTransactionResponse = z.infer<typeof tasksResponseSchemas.recordTransaction>;
export type ReconcileOperationResponse = z.infer<typeof tasksResponseSchemas.reconcileOperation>;
export type RecoverOperationResponse = z.infer<typeof tasksResponseSchemas.recoverOperation>;
export type AbandonOperationResponse = z.infer<typeof tasksResponseSchemas.abandonOperation>;
export type FinalizeEscrowResponse = z.infer<typeof tasksResponseSchemas.finalizeEscrow>;
export type FinalizeOrderResponse = z.infer<typeof tasksResponseSchemas.finalizeOrder>;
export type ConfigureWebhookResponse = z.infer<typeof tasksResponseSchemas.configureWebhook>;
