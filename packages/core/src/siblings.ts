import { getAddress, isAddress } from "viem";
import { z } from "zod";

import { AgentLinkError, agentFetch, withAgentCredentialLock } from "./agent-link.js";
import type { SecretStore } from "./secret-store.js";
import type { WalletName, WalletStore } from "./wallet-store.js";

export type SiblingStatus = "active" | "revoked";
export type Sibling = {
  name: string;
  address: `0x${string}`;
  device: string | null;
  status: SiblingStatus;
  allowance: {
    routerPerDayUsd: number | null;
    perCallUsd: number | null;
    perDayUsd: number | null;
  };
  self: boolean;
};
export type SiblingsResult = {
  owner: `0x${string}` | null;
  siblings: Sibling[];
  source: { account: WalletName };
};
export type SiblingsErrorCode = "not_linked" | "unsupported" | "invalid_response" | "http";

export class SiblingsError extends Error {
  constructor(
    readonly code: SiblingsErrorCode,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "SiblingsError";
  }
}

export const SIBLINGS_UNSUPPORTED_MESSAGE = "This vAPI server does not list siblings yet.";
// The request runs under the account's credential lock, so it must always end.
export const SIBLINGS_DEFAULT_TIMEOUT_MS = 10_000;

const addressSchema = z
  .string()
  .refine((value) => isAddress(value, { strict: false }))
  .transform((value) => getAddress(value));

const siblingsResponseSchema = z.object({
  owner: addressSchema.nullable(),
  siblings: z.array(
    z.object({
      name: z.string(),
      address: addressSchema,
      device: z.string().nullable(),
      status: z.enum(["active", "revoked"]),
      allowance: z.object({
        routerPerDayUsd: z.number().finite().nullable(),
        perCallUsd: z.number().finite().nullable(),
        perDayUsd: z.number().finite().nullable(),
      }),
      self: z.boolean(),
    }),
  ),
});

export async function fetchSiblings(args: {
  apiBase: string;
  account: WalletName;
  secrets: SecretStore;
  wallets: WalletStore;
  fetchImpl?: typeof fetch;
  now?: () => number;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<SiblingsResult> {
  const deadline = AbortSignal.timeout(args.timeoutMs ?? SIBLINGS_DEFAULT_TIMEOUT_MS);
  const signal = args.signal === undefined ? deadline : AbortSignal.any([args.signal, deadline]);
  let response: Response;
  try {
    response = await withAgentCredentialLock(args.wallets, `wallet:${args.account}`, async () => {
      await args.wallets.reload();
      const link = args.wallets.entry(args.account)?.link;
      if (link === undefined || new URL(link.apiBase).origin !== new URL(args.apiBase).origin) {
        throw new SiblingsError(
          "not_linked",
          "The selected account is not linked to this vAPI server.",
        );
      }
      return await agentFetch(
        {
          secrets: args.secrets,
          wallets: args.wallets,
          wallet: args.account,
          ...(args.fetchImpl === undefined ? {} : { fetchImpl: args.fetchImpl }),
          ...(args.now === undefined ? {} : { now: args.now }),
        },
        new URL("/api/agents/self/siblings", new URL(link.apiBase).origin).toString(),
        { method: "GET", signal },
      );
    });
  } catch (error) {
    if (error instanceof SiblingsError) throw error;
    if (error instanceof AgentLinkError && error.code === "not_linked") {
      throw new SiblingsError("not_linked", error.message);
    }
    throw new SiblingsError("http", "The vAPI siblings request failed.");
  }

  if (response.status === 404) {
    throw new SiblingsError("unsupported", SIBLINGS_UNSUPPORTED_MESSAGE, 404);
  }
  if (!response.ok) {
    throw new SiblingsError(
      "http",
      `The vAPI siblings request returned HTTP ${response.status}.`,
      response.status,
    );
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw invalidResponseError();
  }
  const parsed = siblingsResponseSchema.safeParse(body);
  if (!parsed.success) throw invalidResponseError();
  return {
    owner: parsed.data.owner,
    siblings: parsed.data.siblings,
    source: { account: args.account },
  };
}

function invalidResponseError(): SiblingsError {
  return new SiblingsError("invalid_response", "The vAPI siblings response was invalid.");
}
