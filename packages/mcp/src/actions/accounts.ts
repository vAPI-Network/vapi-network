import { ARC_MAINNET_CAIP2, BASE_MAINNET_CAIP2, walletNameSchema } from "@vapi-network/core";
import { z } from "zod";

import { defineAction } from "./define.js";

export const accountsSendInputSchema = z.object({
  from: walletNameSchema.describe("Linked local account that sends the USDC."),
  to: z
    .string()
    .min(1)
    .describe("Active account name, owner, or an allowed owner or account address."),
  amountUsd: z
    .union([z.string(), z.number()])
    .describe("Positive USDC amount with no more than six decimal places."),
  network: z.enum(["base", "arc"]).optional().describe("Base by default, or Arc."),
});

export type AccountsSendInput = z.infer<typeof accountsSendInputSchema>;

export const accountsSendOutputSchema = z.object({
  status: z.enum(["sent", "unknown"]),
  from: walletNameSchema,
  to: z.string(),
  toName: z.string(),
  toKind: z.enum(["owner", "account"]),
  amountUsd: z.string(),
  amountAtomic: z.string(),
  network: z.enum([BASE_MAINNET_CAIP2, ARC_MAINNET_CAIP2]),
  txHash: z.string().nullable(),
  nonce: z.string(),
  replayed: z.boolean(),
  message: z.string(),
});

export const accountsSend = defineAction<
  AccountsSendInput,
  z.infer<typeof accountsSendOutputSchema>
>({
  name: "accounts.send",
  money: "moves",
  grant: "send",
  description:
    "Send USDC between the owner's accounts or back to the owner. The key never leaves this machine, spend caps always apply, and vAPI pays the gas. Revoked and unrelated recipients are refused.",
  input: accountsSendInputSchema,
  output: accountsSendOutputSchema,
  async run(input, ctx) {
    if (ctx.accounts === undefined) {
      throw new Error("accounts.send is not available in this action context.");
    }
    const result = await ctx.accounts.send(input);
    const message =
      result.status === "unknown"
        ? `The transfer outcome is unknown; the spend stays reserved. Run vapi send ${result.amountUsd} --from ${result.from} --to ${result.toName} --network ${input.network ?? "base"} --resume ${result.nonce} in a terminal. Do not send it again.`
        : `Sent ${result.amountUsd} USDC from ${result.from} to ${result.toName}.`;
    return { ...result, message };
  },
});
