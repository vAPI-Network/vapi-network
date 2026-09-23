import type { SecretStore, WalletStore } from "@vapi-network/core";
import { walletNameSchema } from "@vapi-network/core";
import {
  listRouterModels,
  ownerStake,
  routerChat,
  routerUsage,
  type AgentRouterUsage,
  type RouterClientDeps,
} from "@vapi-network/core/router-client";
import { z } from "zod";

import type { WalletSession } from "../wallet-session.js";

const walletArgument = {
  wallet: walletNameSchema
    .optional()
    .describe(
      "Wallet name. Without it: the session's active wallet, then VAPI_WALLET, then the machine default.",
    ),
};

const usageSchema = z.object({
  prompt_tokens: z.number(),
  completion_tokens: z.number(),
  total_tokens: z.number(),
});

const routerUsageSchema = {
  compute: z.object({
    allowanceUsd: z.number(),
    spentTodayUsd: z.number(),
    remainingTodayUsd: z.number(),
    resetsAt: z.string(),
    ownerLimitUsd: z.number(),
    ownerSpentUsd: z.number(),
  }),
  balance: z
    .object({
      purchasedUsd: z.number(),
      spentUsd: z.number(),
      remainingUsd: z.number(),
    })
    .nullable(),
};

const chatMessageSchema = z.strictObject({
  role: z.enum(["system", "user", "assistant"]),
  content: z.string(),
});

const routerChatInputShape = {
  model: z.string().min(1).max(200),
  messages: z.array(chatMessageSchema).min(1).max(50),
  max_tokens: z.number().int().min(1).max(4096).optional(),
  ...walletArgument,
};

const routerChatInputSchema = z.strictObject(routerChatInputShape);

const KEY_SAFETY_DESCRIPTION = "The Router key stays in the OS secret store and is never returned.";

export const routerModelsTool = {
  description: `List model ids available from vAPI Router. ${KEY_SAFETY_DESCRIPTION}`,
  inputSchema: {},
  outputSchema: z.object({ models: z.array(z.string()) }),
};

export const routerUsageTool = {
  description: `Show this linked wallet's vAPI Router usage and its owner's stake-funded Compute. ${KEY_SAFETY_DESCRIPTION}`,
  inputSchema: { ...walletArgument },
  outputSchema: z.object({
    ...routerUsageSchema,
    stake: z.object({
      owner: z.string(),
      stake: z.string(),
      computeTodayUsd: z.number(),
    }),
  }),
};

export const routerChatTool = {
  description: `Send a text conversation through vAPI Router. Tool calls are not accepted. ${KEY_SAFETY_DESCRIPTION}`,
  inputSchema: routerChatInputShape,
  strictInput: true,
  outputSchema: z.object({
    content: z.string().nullable(),
    model: z.string(),
    usage: usageSchema.optional(),
  }),
};

export type RouterCoreOverrides = {
  listRouterModels?: typeof listRouterModels | undefined;
  routerUsage?: typeof routerUsage | undefined;
  routerChat?: typeof routerChat | undefined;
  ownerStake?: typeof ownerStake | undefined;
};

export type RouterToolsOptions = RouterCoreOverrides & {
  session: WalletSession;
  secrets: SecretStore;
  wallets?: WalletStore | undefined;
  fetchImpl: typeof fetch;
  apiBase: string;
};

type ToolResult = {
  structuredContent: Record<string, unknown>;
  content: Array<{ type: "text"; text: string }>;
};

export function createRouterTools(options: RouterToolsOptions): {
  models(input: Record<string, never>): Promise<ToolResult>;
  usage(input: { wallet?: string }): Promise<ToolResult>;
  chat(input: z.infer<typeof routerChatInputSchema>): Promise<ToolResult>;
} {
  const listModels = options.listRouterModels ?? listRouterModels;
  const readUsage = options.routerUsage ?? routerUsage;
  const chat = options.routerChat ?? routerChat;
  const readStake = options.ownerStake ?? ownerStake;

  return {
    async models() {
      const models = await listModels({ apiBase: options.apiBase, fetchImpl: options.fetchImpl });
      return toolResult({ models: models.map((model) => model.id) });
    },

    async usage(input) {
      const deps = routerDeps(options, input.wallet);
      const [usage, stake] = await Promise.all([readUsage(deps), readStake(deps)]);
      return toolResult({
        ...publicUsage(usage),
        stake: {
          owner: stake.owner,
          stake: stake.stake,
          computeTodayUsd: stake.computeTodayUsd,
        },
      });
    },

    async chat(input) {
      const parsed = routerChatInputSchema.parse(input);
      const result = await chat(routerDeps(options, parsed.wallet), {
        model: parsed.model,
        messages: parsed.messages,
        ...(parsed.max_tokens === undefined ? {} : { max_tokens: parsed.max_tokens }),
      });
      return toolResult({
        content: result.content,
        model: result.model,
        ...(result.usage === undefined ? {} : { usage: result.usage }),
      });
    },
  };
}

function publicUsage(usage: AgentRouterUsage): AgentRouterUsage {
  return {
    compute: {
      allowanceUsd: usage.compute.allowanceUsd,
      spentTodayUsd: usage.compute.spentTodayUsd,
      remainingTodayUsd: usage.compute.remainingTodayUsd,
      resetsAt: usage.compute.resetsAt,
      ownerLimitUsd: usage.compute.ownerLimitUsd,
      ownerSpentUsd: usage.compute.ownerSpentUsd,
    },
    balance:
      usage.balance === null
        ? null
        : {
            purchasedUsd: usage.balance.purchasedUsd,
            spentUsd: usage.balance.spentUsd,
            remainingUsd: usage.balance.remainingUsd,
          },
  };
}

function routerDeps(options: RouterToolsOptions, wallet?: string): RouterClientDeps {
  if (options.wallets === undefined) {
    throw new Error("No wallet store is available, so no linked wallet can be selected.");
  }
  return {
    secrets: options.secrets,
    wallets: options.wallets,
    wallet: options.session.resolve(wallet).name,
    fetchImpl: options.fetchImpl,
  };
}

function toolResult(value: Record<string, unknown>): ToolResult {
  return {
    structuredContent: value,
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  };
}
