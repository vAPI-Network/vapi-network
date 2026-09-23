import { z } from "zod";

import {
  AgentLinkError,
  agentFetch,
  agentSecretAccounts,
  withAgentCredentialLock,
} from "./agent-link.js";
import { createPublicFetch } from "./net-guard.js";
import type { SecretStore } from "./secret-store.js";
import type { AgentLink, WalletName, WalletStore } from "./wallet-store.js";

export type RouterModel = { id: string; [k: string]: unknown };

export type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  name?: string;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
};

export type ChatRequest = {
  model: string;
  messages: ChatMessage[];
  max_tokens?: number;
  temperature?: number;
  tools?: unknown[];
  tool_choice?: unknown;
};

export type ChatResult = {
  content: string | null;
  toolCalls: Array<{ id: string; name: string; arguments: string }>;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  model: string;
  keyUsed: "stake" | "balance";
};

export type AgentRouterUsage = {
  compute: {
    allowanceUsd: number;
    spentTodayUsd: number;
    remainingTodayUsd: number;
    resetsAt: string;
    ownerLimitUsd: number;
    ownerSpentUsd: number;
  };
  balance: { purchasedUsd: number; spentUsd: number; remainingUsd: number } | null;
};

export class RouterClientError extends Error {
  constructor(
    readonly code: "not_linked" | "no_router_key" | "budget_exhausted" | "http",
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "RouterClientError";
  }
}

export type RouterClientDeps = {
  secrets: SecretStore;
  wallets: WalletStore;
  wallet: WalletName;
  fetchImpl?: typeof fetch;
};

export const DEFAULT_ROUTER_BASE_URL = "https://router.vapinetwork.ai";

const publicFetch = createPublicFetch({ allowPrivateNetwork: false });

const routerModelSchema = z.object({ id: z.string() }).passthrough();
const routerModelsResponseSchema = z.object({ models: z.array(routerModelSchema) });

const routerUsageSchema: z.ZodType<AgentRouterUsage> = z.object({
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
});

const routerKeyResponseSchema = z.object({
  router_key: z.string().min(1),
  router_base_url: z.string().min(1),
});

const ownerStakeResponseSchema = z.object({
  owner: z.string(),
  epoch: z.number(),
  stake: z.string().regex(/^\d+$/u),
  computeTodayUsd: z.number(),
  stakeUrl: z.string(),
});

const chatResponseSchema = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({
          content: z.string().nullable(),
          tool_calls: z
            .array(
              z.object({
                id: z.string(),
                type: z.literal("function"),
                function: z.object({ name: z.string(), arguments: z.string() }),
              }),
            )
            .optional(),
        }),
      }),
    )
    .min(1),
  usage: z
    .object({
      prompt_tokens: z.number(),
      completion_tokens: z.number(),
      total_tokens: z.number(),
    })
    .optional(),
  model: z.string().optional(),
});

export async function listRouterModels(deps: {
  apiBase: string;
  fetchImpl?: typeof fetch;
}): Promise<RouterModel[]> {
  const fetchImpl = deps.fetchImpl ?? publicFetch;
  let response: Response;
  try {
    response = await fetchImpl(`${trimTrailingSlashes(deps.apiBase)}/api/router/models`, {
      method: "GET",
    });
  } catch {
    throw new RouterClientError("http", "The vAPI Router model request failed.");
  }
  if (!response.ok) {
    throw new RouterClientError(
      "http",
      `The vAPI Router model request returned HTTP ${response.status}.`,
      response.status,
    );
  }
  const parsed = routerModelsResponseSchema.safeParse(await responseJson(response));
  if (!parsed.success) {
    throw new RouterClientError("http", "The vAPI Router model response was invalid.");
  }
  return parsed.data.models;
}

export async function routerUsage(deps: RouterClientDeps): Promise<AgentRouterUsage> {
  const response = await consoleRequest(
    deps,
    "/api/agents/self/router",
    { method: "GET" },
    "The vAPI Router usage request failed.",
  );
  if (!response.ok) {
    throw new RouterClientError(
      "http",
      `The vAPI Router usage request returned HTTP ${response.status}.`,
      response.status,
    );
  }
  const parsed = routerUsageSchema.safeParse(await responseJson(response));
  if (!parsed.success) {
    throw new RouterClientError("http", "The vAPI Router usage response was invalid.");
  }
  return parsed.data;
}

export async function routerChat(
  deps: RouterClientDeps,
  request: ChatRequest,
): Promise<ChatResult> {
  const { routerBaseUrl, routerKey } = await routerCredentialSnapshot(deps);
  const fetchImpl = deps.fetchImpl ?? publicFetch;
  let response: Response;
  try {
    response = await fetchImpl(`${routerBaseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${routerKey}`,
        "content-type": "application/json",
      },
      redirect: "error",
      body: JSON.stringify({
        model: request.model,
        messages: request.messages,
        ...(request.max_tokens === undefined ? {} : { max_tokens: request.max_tokens }),
        ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
        ...(request.tools === undefined ? {} : { tools: request.tools }),
        ...(request.tool_choice === undefined ? {} : { tool_choice: request.tool_choice }),
      }),
    });
  } catch {
    throw new RouterClientError("http", "The vAPI Router request failed.");
  }

  const body = await responseText(response);
  if (!response.ok) {
    if (
      response.status === 429 ||
      body.includes("Budget has been exceeded") ||
      body.includes("ExceededBudget")
    ) {
      let resetsAt = "00:00 UTC";
      try {
        resetsAt = (await routerUsage(deps)).compute.resetsAt;
      } catch {
        // The safe fallback does not expose a failed console response.
      }
      throw new RouterClientError(
        "budget_exhausted",
        `Today's Router allowance is used up. It resets at ${resetsAt}.`,
        response.status,
      );
    }
    if (response.status === 401) {
      throw new RouterClientError(
        "no_router_key",
        "The Router key was revoked. Run vapi router key --rotate.",
        401,
      );
    }
    throw new RouterClientError(
      "http",
      `vAPI Router returned HTTP ${response.status}.`,
      response.status,
    );
  }

  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    throw new RouterClientError("http", "The vAPI Router response was invalid.", response.status);
  }
  const parsed = chatResponseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new RouterClientError("http", "The vAPI Router response was invalid.", response.status);
  }
  const message = parsed.data.choices[0]!.message;
  return {
    content: message.content,
    toolCalls: (message.tool_calls ?? []).map((call) => ({
      id: call.id,
      name: call.function.name,
      arguments: call.function.arguments,
    })),
    ...(parsed.data.usage === undefined ? {} : { usage: parsed.data.usage }),
    model: parsed.data.model ?? request.model,
    keyUsed: "stake",
  };
}

export async function rotateRouterKey(deps: RouterClientDeps): Promise<void> {
  const link = await linkedWallet(deps);
  if (!deps.secrets.available) {
    throw new Error(
      "No OS secret store is available on this machine, so the Router key cannot be stored safely.",
    );
  }
  const response = await consoleRequest(
    deps,
    "/api/agents/self/router-key",
    { method: "POST" },
    "The vAPI Router key rotation request failed.",
    link,
  );
  if (!response.ok) {
    throw new RouterClientError(
      "http",
      `The vAPI Router key rotation request returned HTTP ${response.status}.`,
      response.status,
    );
  }
  const parsed = routerKeyResponseSchema.safeParse(await responseJson(response));
  if (!parsed.success) {
    throw new RouterClientError("http", "The vAPI Router key rotation response was invalid.");
  }
  validRouterBaseUrl(parsed.data.router_base_url);

  try {
    await withAgentCredentialLock(deps.wallets, link.clientId, async () => {
      const currentLink = await linkedWallet(deps);
      if (!sameAgentLink(currentLink, link)) {
        throw new RouterClientError("http", "The agent link changed during Router key rotation.");
      }
      const account = agentSecretAccounts(deps.wallet).routerStake;
      let previousKey: string | undefined;
      try {
        previousKey = await deps.secrets.get(account);
        await deps.secrets.set(account, parsed.data.router_key);
      } catch {
        throw new RouterClientError("http", "The Router key could not be stored safely.");
      }
      try {
        await deps.wallets.setLink(deps.wallet, {
          ...currentLink,
          routerBaseUrl: parsed.data.router_base_url,
        });
      } catch {
        try {
          if (previousKey === undefined) await deps.secrets.remove(account);
          else await deps.secrets.set(account, previousKey);
        } catch {
          await deps.wallets.clearLink(deps.wallet).catch(() => undefined);
        }
        throw new RouterClientError("http", "The Router key could not be stored safely.");
      }
    });
  } catch (error) {
    if (error instanceof RouterClientError) throw error;
    throw new RouterClientError("http", "The Router key could not be stored safely.");
  }
}

export async function ownerStake(deps: RouterClientDeps): Promise<{
  owner: string;
  stake: string;
  computeTodayUsd: number;
  stakeUrl: string;
}> {
  const response = await consoleRequest(
    deps,
    "/api/agents/self/stake",
    { method: "GET" },
    "The vAPI stake request failed.",
  );
  if (!response.ok) {
    throw new RouterClientError(
      "http",
      `The vAPI stake request returned HTTP ${response.status}.`,
      response.status,
    );
  }
  const parsed = ownerStakeResponseSchema.safeParse(await responseJson(response));
  if (!parsed.success) {
    throw new RouterClientError("http", "The vAPI stake response was invalid.");
  }
  return {
    owner: parsed.data.owner,
    stake: parsed.data.stake,
    computeTodayUsd: parsed.data.computeTodayUsd,
    stakeUrl: parsed.data.stakeUrl,
  };
}

/** For the SDK (plan 029): base URL + key for OpenAI-compatible frameworks. Never exposed via MCP. */
export async function routerCredentials(
  deps: RouterClientDeps,
): Promise<{ baseURL: string; apiKey: string }> {
  const { routerBaseUrl, routerKey } = await routerCredentialSnapshot(deps);
  return { baseURL: `${routerBaseUrl}/v1`, apiKey: routerKey };
}

async function routerCredentialSnapshot(
  deps: RouterClientDeps,
): Promise<{ routerBaseUrl: string; routerKey: string }> {
  const observedLink = await linkedWallet(deps);
  try {
    return await withAgentCredentialLock(deps.wallets, observedLink.clientId, async () => {
      const link = await linkedWallet(deps);
      if (link.clientId !== observedLink.clientId) {
        throw new RouterClientError(
          "http",
          "The agent link changed while reading Router credentials.",
        );
      }
      return {
        routerBaseUrl: validRouterBaseUrl(link.routerBaseUrl ?? DEFAULT_ROUTER_BASE_URL),
        routerKey: await storedRouterKey(deps),
      };
    });
  } catch (error) {
    if (error instanceof RouterClientError) throw error;
    throw new RouterClientError("http", "The Router credentials could not be read safely.");
  }
}

async function linkedWallet(deps: RouterClientDeps): Promise<AgentLink> {
  try {
    await deps.wallets.reload();
  } catch {
    throw new RouterClientError("http", "The wallet link could not be read.");
  }
  const link = deps.wallets.entry(deps.wallet)?.link;
  if (link === undefined) throw notLinkedError();
  return link;
}

async function storedRouterKey(deps: RouterClientDeps): Promise<string> {
  if (!deps.secrets.available) throw noRouterKeyError();
  let key: string | undefined;
  try {
    key = await deps.secrets.get(agentSecretAccounts(deps.wallet).routerStake);
  } catch {
    throw new RouterClientError("http", "The Router key could not be read safely.");
  }
  if (key === undefined || key.length === 0) throw noRouterKeyError();
  return key;
}

function sameAgentLink(left: AgentLink, right: AgentLink): boolean {
  return (
    left.apiBase === right.apiBase &&
    left.clientId === right.clientId &&
    left.owner === right.owner &&
    left.label === right.label &&
    left.linkedAt === right.linkedAt &&
    left.routerBaseUrl === right.routerBaseUrl &&
    left.scopes.length === right.scopes.length &&
    left.scopes.every((scope, index) => scope === right.scopes[index])
  );
}

async function consoleRequest(
  deps: RouterClientDeps,
  path: string,
  init: RequestInit,
  failureMessage: string,
  knownLink?: AgentLink,
): Promise<Response> {
  const link = knownLink ?? (await linkedWallet(deps));
  try {
    return await agentFetch(
      {
        secrets: deps.secrets,
        wallets: deps.wallets,
        wallet: deps.wallet,
        ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
      },
      `${trimTrailingSlashes(link.apiBase)}${path}`,
      init,
    );
  } catch (error) {
    if (error instanceof AgentLinkError && error.code === "not_linked") throw notLinkedError();
    throw new RouterClientError("http", failureMessage);
  }
}

function validRouterBaseUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw invalidRouterBaseUrlError();
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.hostname.length === 0 ||
    parsed.username.length > 0 ||
    parsed.password.length > 0
  ) {
    throw invalidRouterBaseUrlError();
  }
  return trimTrailingSlashes(value);
}

function invalidRouterBaseUrlError(): RouterClientError {
  return new RouterClientError("http", "The vAPI Router base URL is invalid.");
}

function notLinkedError(): RouterClientError {
  return new RouterClientError("not_linked", "Not linked. Run vapi login.");
}

function noRouterKeyError(): RouterClientError {
  return new RouterClientError(
    "no_router_key",
    "No Router key is stored for this wallet. Run vapi router key --rotate.",
  );
}

function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/u, "");
}

async function responseJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

async function responseText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}
