import {
  BASE_MAINNET_CAIP2,
  buildStatus,
  readUsdcBalance,
  type AgentLink,
  type SecretStore,
  type StatusDeps,
  type StatusReport,
  type VapiConfig,
  type WalletStore,
} from "@vapi-network/core";
import {
  AgentLinkError,
  agentFetch,
  agentSecretAccounts,
  withAgentCredentialLock,
} from "@vapi-network/core/agent-link";
import { routerUsage } from "@vapi-network/core/router-client";
import { z } from "zod";

const NO_STORE_MESSAGE =
  "No wallet store is available on this machine, so there is no status to read. Run vapi setup.";

const statusAccountSchema = z.object({
  name: z.string(),
  default: z.boolean(),
  address: z.string(),
  usdc: z.string().optional(),
  routerTodayUsd: z.string().optional(),
  routerAllowanceUsd: z.string().optional(),
  caps: z.object({
    perCallUsd: z.string(),
    perDayUsd: z.string(),
    ceilingUsd: z.string(),
    ceilingFloorUsd: z.string().optional(),
  }),
  link: z.enum(["active", "paused", "revoked", "not_linked", "unknown"]),
});

const statusReportSchema = z.object({
  version: z.string(),
  home: z.string(),
  registry: z.string(),
  owner: z
    .object({
      address: z.string(),
      linked: z.boolean(),
      console: z.string(),
    })
    .optional(),
  vault: z.object({
    exists: z.boolean(),
    unlocked: z.boolean(),
    store: z.string(),
    protected: z.boolean(),
  }),
  accounts: z.array(statusAccountSchema),
  unfinishedMovements: z.array(
    z.object({
      id: z.string(),
      from: z.string(),
      network: z.string(),
      createdAt: z.string(),
      pendingLegs: z.number().int().nonnegative(),
      unknownLegs: z.number().int().nonnegative(),
    }),
  ),
  next: z.array(z.string()),
});

export const vapiStatusTool = {
  description:
    "The vAPI status screen as JSON: home, registry, owner link, vault state, every account with balances, Router usage, caps and link status, and suggested next commands. Read-only; the same object `vapi --json` prints.",
  inputSchema: {},
  outputSchema: statusReportSchema,
};

export const vapiAccountsTool = {
  description:
    "List the accounts in the vault with address, USDC balance, Router usage, caps and link status. Read-only.",
  inputSchema: {},
  outputSchema: z.object({ accounts: z.array(statusAccountSchema) }),
};

export type StatusCoreOverrides = {
  usdcBalance?: StatusDeps["chain"]["usdcBalance"] | undefined;
  routerUsage?: StatusDeps["agents"]["routerUsage"] | undefined;
  linkStatus?: StatusDeps["agents"]["linkStatus"] | undefined;
  timeoutMs?: number | undefined;
  now?: (() => Date) | undefined;
};

export type StatusToolsOptions = StatusCoreOverrides & {
  version: string;
  home: string;
  registry: string;
  wallets?: WalletStore | undefined;
  secrets: SecretStore;
  env?: NodeJS.ProcessEnv | undefined;
  fetchImpl: typeof fetch;
  config: VapiConfig;
  routerClientUsage?: typeof routerUsage | undefined;
};

type StatusToolResult =
  | {
      structuredContent: Record<string, unknown>;
      content: Array<{ type: "text"; text: string }>;
    }
  | {
      isError: true;
      content: Array<{ type: "text"; text: string }>;
    };

export function createStatusTools(options: StatusToolsOptions): {
  status(input: Record<string, never>): Promise<StatusToolResult>;
  accounts(input: Record<string, never>): Promise<StatusToolResult>;
} {
  const readStatus = async (): Promise<StatusReport | undefined> => {
    if (options.wallets === undefined) return undefined;
    const wallets = options.wallets;
    await wallets.reload();
    const readRouterUsage = options.routerUsage ?? routerUsageFor(options, wallets);
    const readLinkStatus = options.linkStatus ?? linkStatusFor(options, wallets);

    return await buildStatus({
      version: options.version,
      home: options.home,
      registry: options.registry,
      wallets,
      secrets: options.secrets,
      env: options.env,
      chain: {
        usdcBalance: options.usdcBalance ?? usdcBalanceFor(options),
      },
      agents: {
        routerUsage: readRouterUsage,
        linkStatus: readLinkStatus,
      },
      now: options.now ?? (() => new Date()),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    });
  };

  return {
    async status() {
      const report = await readStatus();
      return report === undefined ? noStoreResult() : toolResult(report);
    },
    async accounts() {
      const report = await readStatus();
      return report === undefined ? noStoreResult() : toolResult({ accounts: report.accounts });
    },
  };
}

function usdcBalanceFor(options: StatusToolsOptions): StatusDeps["chain"]["usdcBalance"] {
  return async (address, signal) => {
    const configured = options.config.networks[BASE_MAINNET_CAIP2];
    if (configured === undefined) throw new Error("Base mainnet is not configured.");
    return await readUsdcBalance({
      network: BASE_MAINNET_CAIP2,
      configured,
      address,
      ...(options.config.allowPrivateNetwork === undefined
        ? {}
        : { allowPrivateNetwork: options.config.allowPrivateNetwork }),
      fetchImpl: withDeadlineSignal(options.fetchImpl, signal),
    });
  };
}

function routerUsageFor(
  options: StatusToolsOptions,
  wallets: WalletStore,
): StatusDeps["agents"]["routerUsage"] {
  const readUsage = options.routerClientUsage ?? routerUsage;
  return async (account, signal) =>
    await readUsage({
      secrets: options.secrets,
      wallets,
      wallet: account,
      fetchImpl: withDeadlineSignal(options.fetchImpl, signal),
    });
}

function linkStatusFor(
  options: StatusToolsOptions,
  wallets: WalletStore,
): StatusDeps["agents"]["linkStatus"] {
  return async (account, signal) => {
    const link = wallets.entry(account)?.link;
    if (link === undefined) return "unknown";
    try {
      if (
        !options.secrets.available ||
        !(await options.secrets.has(agentSecretAccounts(account).tokens))
      ) {
        return "unknown";
      }

      return await withAgentCredentialLock(wallets, `wallet:${account}`, async () => {
        await wallets.reload();
        const currentLink = wallets.entry(account)?.link;
        if (currentLink === undefined || !sameLink(currentLink, link)) return "unknown";
        const response = await agentFetch(
          {
            secrets: options.secrets,
            wallets,
            wallet: account,
            fetchImpl: withDeadlineSignal(options.fetchImpl, signal),
            ...(options.now === undefined ? {} : { now: () => options.now!().getTime() }),
          },
          `${link.apiBase.replace(/\/+$/u, "")}/api/agents/self`,
          { method: "GET" },
        );
        const body = await response
          .clone()
          .json()
          .catch(() => undefined);
        if (response.status === 200) {
          return isPaused(body) ? "paused" : "active";
        }
        if (response.status === 401 || isNotLinked(body)) return "revoked";
        return "unknown";
      });
    } catch (error) {
      return error instanceof AgentLinkError && error.code === "not_linked" ? "revoked" : "unknown";
    }
  };
}

function sameLink(left: AgentLink, right: AgentLink): boolean {
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

function isPaused(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    (("status" in value && value.status === "paused") ||
      ("paused" in value && value.paused === true))
  );
}

function isNotLinked(value: unknown): boolean {
  return (
    typeof value === "object" && value !== null && "error" in value && value.error === "not_linked"
  );
}

function withDeadlineSignal(fetchImpl: typeof fetch, deadline?: AbortSignal): typeof fetch {
  if (deadline === undefined) return fetchImpl;
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const requestSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    const signal =
      requestSignal === undefined || requestSignal === deadline
        ? deadline
        : AbortSignal.any([requestSignal, deadline]);
    return await fetchImpl(input, { ...init, signal });
  }) as typeof fetch;
}

function toolResult(
  value: StatusReport | { accounts: StatusReport["accounts"] },
): StatusToolResult {
  return {
    structuredContent: value,
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  };
}

function noStoreResult(): StatusToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: NO_STORE_MESSAGE }],
  };
}
