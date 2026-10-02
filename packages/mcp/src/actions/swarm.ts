import {
  ARC_MAINNET_CAIP2,
  BASE_MAINNET_CAIP2,
  SWARM_NAME_PATTERN,
  SWARM_ROLE_PATTERN,
  swarmFileSchema,
  walletNameSchema,
} from "@vapi-network/core";
import { z } from "zod";

import { defineAction } from "./define.js";

const swarmNameSchema = z
  .string()
  .regex(SWARM_NAME_PATTERN)
  .describe(
    "Swarm name: lowercase letters, digits and hyphens, up to 16 characters, starting with a letter.",
  );
const swarmRoleSchema = z
  .string()
  .regex(SWARM_ROLE_PATTERN)
  .describe("Short member role: up to 8 lowercase letters or digits, starting with a letter.");
const usdSchema = z
  .union([z.string(), z.number()])
  .describe("USDC amount with no more than six decimal places.");
const capsInputSchema = z
  .object({
    perCallUsd: usdSchema.describe("Most this account may spend on one paid API call, in USD."),
    perDayUsd: usdSchema.describe("Most this account may spend on paid API calls per day, in USD."),
  })
  .describe("Local paid-API spend limits for each member account.");
const treasuryCapsInputSchema = z
  .object({
    perCallUsd: usdSchema.describe("Most the treasury may send in one movement, in USD."),
    perDayUsd: usdSchema.describe("Most the treasury may send per day, in USD."),
  })
  .describe("Local movement limits for the swarm treasury.");

export const swarmSetupInputSchema = z
  .object({
    name: swarmNameSchema,
    agents: z
      .number()
      .int()
      .min(1)
      .max(20)
      .optional()
      .describe("Number of member agents to prepare. Defaults to two."),
    roles: z
      .array(swarmRoleSchema)
      .optional()
      .describe("Ordered member roles. When present, these replace the generated default roles."),
    strategy: z
      .enum(["targets", "even", "weights"])
      .optional()
      .describe("How treasury funds are allocated to linked members. Defaults to targets."),
    targetsUsd: z
      .record(swarmRoleSchema, usdSchema)
      .optional()
      .describe("Target USDC balance for each role when using the targets strategy."),
    caps: capsInputSchema.optional().describe("Spend limits applied to each member account."),
    treasuryCaps: treasuryCapsInputSchema
      .optional()
      .describe("Movement limits applied to the treasury account."),
    network: z
      .enum(["base", "arc"])
      .optional()
      .describe("USDC network for the swarm. Defaults to Base."),
    model: z
      .string()
      .optional()
      .describe("Model id stored in each new member's local agent profile."),
    fundUsd: usdSchema
      .optional()
      .describe("USDC to move from a local account into the treasury after setup."),
    from: walletNameSchema
      .optional()
      .describe("Linked local account that supplies fundUsd. Required when fundUsd is set."),
  })
  .refine((input) => input.fundUsd === undefined || input.from !== undefined, {
    message: "from is required when fundUsd is set.",
    path: ["from"],
  });

export const swarmAddInputSchema = z.object({
  name: swarmNameSchema,
  role: swarmRoleSchema,
  targetUsd: usdSchema.optional().describe("Target USDC balance for the new member."),
  weight: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Positive allocation weight for the new member."),
});

export const swarmLeaveInputSchema = z.object({
  name: swarmNameSchema,
  member: walletNameSchema.describe("Member account to sweep to the treasury and remove."),
});

export const swarmFundInputSchema = z.object({
  name: swarmNameSchema,
  amountUsd: usdSchema.describe("USDC amount for the treasury."),
  from: walletNameSchema
    .optional()
    .describe("Linked local funding account. Omit it to return owner funding instructions."),
});

export const swarmRebalanceInputSchema = z.object({
  name: swarmNameSchema,
  targetsUsd: z
    .record(z.string(), usdSchema)
    .optional()
    .describe("Temporary target USDC balances keyed by member account or role."),
});

export const swarmStatusInputSchema = z.object({
  name: swarmNameSchema,
});

export const swarmDissolveInputSchema = z.object({
  name: swarmNameSchema,
});

const memberSetupStatusSchema = z.object({
  account: z.string(),
  address: z.string(),
  role: z.string(),
  created: z.boolean(),
  capped: z.boolean(),
  profiled: z.boolean(),
  linked: z.boolean(),
});
const nextStepSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("link"),
    account: z.string(),
    userCode: z.string(),
    verificationUri: z.url(),
    expiresInSeconds: z.number().int().positive(),
  }),
  z.object({
    kind: z.literal("caps"),
    account: z.string(),
    command: z.string(),
  }),
]);
const movementLegSchema = z.object({
  from: z.string(),
  to: z.string(),
  amountUsd: z.string(),
  purpose: z.enum(["send", "sweep"]),
  status: z.enum(["planned", "sent", "failed", "unknown", "cancelled"]),
  txHash: z.string().optional(),
  reason: z.string().optional(),
});
const movementResultSchema = z.object({
  movementId: z.string(),
  reason: z.string(),
  resumed: z.boolean(),
  legs: z.array(movementLegSchema),
  complete: z.boolean(),
});
const skippedMemberSchema = z.object({ account: z.string(), reason: z.string() });
const blockedLegSchema = z.object({ to: z.string(), amountUsd: z.string(), reason: z.string() });

export const swarmRebalanceOutputSchema = z.object({
  status: z.enum(["sent", "incomplete", "balanced", "resumed"]),
  movement: movementResultSchema.optional(),
  blocked: z.array(blockedLegSchema),
  skipped: z.array(skippedMemberSchema),
  message: z.string(),
});

export const swarmFundOutputSchema = z.object({
  status: z.enum(["sent", "incomplete", "waiting_for_owner", "resumed"]),
  treasury: z.object({ account: z.string(), address: z.string() }),
  network: z.enum([BASE_MAINNET_CAIP2, ARC_MAINNET_CAIP2]),
  amountUsd: z.string(),
  fund: movementResultSchema.optional(),
  policy: z.union([movementResultSchema, swarmRebalanceOutputSchema]).optional(),
  blocked: z.array(blockedLegSchema),
  skipped: z.array(skippedMemberSchema),
  message: z.string(),
});

export const swarmSetupOutputSchema = z.object({
  swarm: swarmFileSchema,
  members: z.array(memberSetupStatusSchema),
  next: z.array(nextStepSchema),
  fund: swarmFundOutputSchema.optional(),
  message: z.string(),
});

export const swarmLeaveOutputSchema = z.object({
  status: z.enum(["left", "kept", "resumed"]),
  member: z.string(),
  movement: movementResultSchema.optional(),
  message: z.string(),
});

export const swarmDissolveOutputSchema = z.object({
  status: z.enum(["dissolved", "incomplete", "resumed"]),
  movements: z.array(movementResultSchema),
  message: z.string(),
});

export const swarmStatusOutputSchema = z.object({
  swarm: z.string(),
  network: z.enum([BASE_MAINNET_CAIP2, ARC_MAINNET_CAIP2]),
  strategy: z.enum(["targets", "even", "weights"]),
  treasury: z.object({
    account: z.string(),
    address: z.string(),
    linked: z.boolean(),
    balanceAtomic: z.string(),
    balanceUsd: z.string(),
  }),
  members: z.array(
    z.object({
      account: z.string(),
      address: z.string(),
      role: z.string(),
      weight: z.number().int().positive(),
      targetUsd: z.string(),
      ceilingUsd: z.string().nullable(),
      linked: z.boolean(),
      profile: z.boolean(),
      balanceAtomic: z.string(),
      balanceUsd: z.string(),
      allocatedInUsd: z.string(),
      sweptOutUsd: z.string(),
      netUsd: z.string(),
    }),
  ),
  openMovements: z.array(
    z.object({
      id: z.string(),
      from: z.string(),
      network: z.enum([BASE_MAINNET_CAIP2, ARC_MAINNET_CAIP2]),
      createdAt: z.string(),
      pendingLegs: z.number().int().nonnegative(),
      unknownLegs: z.number().int().nonnegative(),
    }),
  ),
});

export type SwarmSetupInput = z.infer<typeof swarmSetupInputSchema>;
export type SwarmAddInput = z.infer<typeof swarmAddInputSchema>;
export type SwarmLeaveInput = z.infer<typeof swarmLeaveInputSchema>;
export type SwarmFundInput = z.infer<typeof swarmFundInputSchema>;
export type SwarmRebalanceInput = z.infer<typeof swarmRebalanceInputSchema>;
export type SwarmStatusInput = z.infer<typeof swarmStatusInputSchema>;
export type SwarmDissolveInput = z.infer<typeof swarmDissolveInputSchema>;
export type SwarmSetupOutput = z.infer<typeof swarmSetupOutputSchema>;
export type SwarmLeaveOutput = z.infer<typeof swarmLeaveOutputSchema>;
export type SwarmFundOutput = z.infer<typeof swarmFundOutputSchema>;
export type SwarmRebalanceOutput = z.infer<typeof swarmRebalanceOutputSchema>;
export type SwarmStatusOutput = z.infer<typeof swarmStatusOutputSchema>;
export type SwarmDissolveOutput = z.infer<typeof swarmDissolveOutputSchema>;

export const swarmSetup = defineAction<SwarmSetupInput, SwarmSetupOutput>({
  name: "swarm.setup",
  money: "moves",
  grant: "allocate",
  description:
    "Set up or resume a local swarm. Setup funding is journaled in swarm state, so rerunning the same request never funds twice. Returns every next step: a link code for the owner to approve, or a cap to raise in a terminal. Keys never leave this machine.",
  input: swarmSetupInputSchema,
  output: swarmSetupOutputSchema,
  async run(input, ctx) {
    if (ctx.swarm === undefined) {
      throw new Error("swarm.setup is not available in this action context.");
    }
    return await ctx.swarm.setup(input);
  },
});

export const swarmAdd = defineAction<SwarmAddInput, SwarmSetupOutput>({
  name: "swarm.add",
  money: "moves",
  grant: "allocate",
  description:
    "Add or resume one local swarm member. Returns any owner link approval or terminal cap step still needed; signing keys stay on this machine.",
  input: swarmAddInputSchema,
  output: swarmSetupOutputSchema,
  async run(input, ctx) {
    if (ctx.swarm === undefined) {
      throw new Error("swarm.add is not available in this action context.");
    }
    return await ctx.swarm.add(input);
  },
});

export const swarmLeave = defineAction<SwarmLeaveInput, SwarmLeaveOutput>({
  name: "swarm.leave",
  money: "moves",
  grant: "allocate",
  description:
    "Sweep one member back to its local treasury and leave the swarm. The member account and key remain on this machine.",
  input: swarmLeaveInputSchema,
  output: swarmLeaveOutputSchema,
  async run(input, ctx) {
    if (ctx.swarm === undefined) {
      throw new Error("swarm.leave is not available in this action context.");
    }
    return await ctx.swarm.leave(input);
  },
});

export const swarmFund = defineAction<SwarmFundInput, SwarmFundOutput>({
  name: "swarm.fund",
  money: "moves",
  grant: "allocate",
  description:
    "Fund a swarm treasury from a linked local account, first resuming any unfinished swarm movement, or return the address and network for the owner to fund it directly.",
  input: swarmFundInputSchema,
  output: swarmFundOutputSchema,
  async run(input, ctx) {
    if (ctx.swarm === undefined) {
      throw new Error("swarm.fund is not available in this action context.");
    }
    return await ctx.swarm.fund(input);
  },
});

export const swarmRebalance = defineAction<SwarmRebalanceInput, SwarmRebalanceOutput>({
  name: "swarm.rebalance",
  money: "moves",
  grant: "allocate",
  description:
    "Rebalance a swarm through its local treasury under the treasury caps, resuming unfinished movement work when present.",
  input: swarmRebalanceInputSchema,
  output: swarmRebalanceOutputSchema,
  async run(input, ctx) {
    if (ctx.swarm === undefined) {
      throw new Error("swarm.rebalance is not available in this action context.");
    }
    return await ctx.swarm.rebalance(input);
  },
});

export const swarmStatus = defineAction<SwarmStatusInput, SwarmStatusOutput>({
  name: "swarm.status",
  money: "none",
  grant: "read",
  description:
    "Show the local swarm's treasury, member balances, allocation history, links and unfinished movements without moving money.",
  input: swarmStatusInputSchema,
  output: swarmStatusOutputSchema,
  async run(input, ctx) {
    if (ctx.swarm === undefined) {
      throw new Error("swarm.status is not available in this action context.");
    }
    return await ctx.swarm.status(input);
  },
});

export const swarmDissolve = defineAction<SwarmDissolveInput, SwarmDissolveOutput>({
  name: "swarm.dissolve",
  money: "moves",
  grant: "allocate",
  description:
    "Sweep members to the treasury and the treasury to the owner, then dissolve the swarm. Local accounts, profiles and keys remain.",
  input: swarmDissolveInputSchema,
  output: swarmDissolveOutputSchema,
  async run(input, ctx) {
    if (ctx.swarm === undefined) {
      throw new Error("swarm.dissolve is not available in this action context.");
    }
    return await ctx.swarm.dissolve(input);
  },
});

export const swarmActions = [
  swarmSetup,
  swarmAdd,
  swarmLeave,
  swarmFund,
  swarmRebalance,
  swarmStatus,
  swarmDissolve,
] as const;
