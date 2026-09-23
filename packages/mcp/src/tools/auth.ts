import type { SecretStore, WalletName, WalletStore } from "@vapi-network/core";
import { walletNameSchema } from "@vapi-network/core";
import {
  DEFAULT_AGENT_SCOPES,
  agentSecretAccounts,
  pollDeviceLink,
  saveAgentLink,
  startDeviceLink,
  type DeviceLinkStart,
} from "@vapi-network/core/agent-link";
import { z } from "zod";

import type { WalletSession } from "../wallet-session.js";

const walletArgument = {
  wallet: walletNameSchema
    .optional()
    .describe(
      "Wallet name. Without it: the session's active wallet, then VAPI_WALLET, then the machine default.",
    ),
};

const pendingSchema = z.object({
  userCode: z.string(),
  verificationUriComplete: z.url(),
  expiresAt: z.iso.datetime(),
});

const statusBaseSchema = {
  wallet: z.string(),
  address: z.string(),
  pending: pendingSchema.optional(),
  lastError: z.string().optional(),
};

export const authStatusTool = {
  description:
    "Show whether a local wallet is linked to a person's vAPI account, including any approval still pending in their browser.",
  inputSchema: { ...walletArgument },
  outputSchema: z.discriminatedUnion("linked", [
    z.object({ ...statusBaseSchema, linked: z.literal(false) }),
    z.object({
      ...statusBaseSchema,
      linked: z.literal(true),
      owner: z.string(),
      label: z.string(),
      scopes: z.array(z.string()),
      linkedAt: z.iso.datetime(),
      router: z.boolean(),
    }),
  ]),
};

export const authLinkTool = {
  description:
    "Start linking this session's active wallet to a person's vAPI account. The person approves in their browser, and only the default permissions are requested.",
  inputSchema: {
    label: z.string().trim().min(1).max(80).optional(),
  },
  outputSchema: z.object({
    wallet: z.string(),
    address: z.string(),
    userCode: z.string(),
    verificationUriComplete: z.url(),
    expiresAt: z.iso.datetime(),
  }),
};

export type AuthAgentLinkOverrides = {
  apiBase?: string | undefined;
  startDeviceLink?: typeof startDeviceLink | undefined;
  pollDeviceLink?: typeof pollDeviceLink | undefined;
  saveAgentLink?: typeof saveAgentLink | undefined;
  now?: (() => number) | undefined;
};

export type AuthToolsOptions = AuthAgentLinkOverrides & {
  session: WalletSession;
  secrets: SecretStore;
  wallets?: WalletStore | undefined;
  fetchImpl: typeof fetch;
  apiBase: string;
};

type ToolResult = {
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
  content: Array<{ type: "text"; text: string }>;
};

type PendingSummary = {
  userCode: string;
  verificationUriComplete: string;
  expiresAt: string;
};

type PendingLink = {
  start: DeviceLinkStart;
  label: string;
  address: string;
  summary: PendingSummary;
};

/** One server instance's link state. No device code or token crosses the tool boundary. */
export function createAuthTools(options: AuthToolsOptions): {
  link(input: { label?: string }): Promise<ToolResult>;
  status(input: { wallet?: string }): Promise<ToolResult>;
} {
  const pending = new Map<WalletName, PendingLink>();
  const starting = new Map<WalletName, Promise<PendingLink>>();
  const lastErrors = new Map<WalletName, string>();
  const begin = options.startDeviceLink ?? startDeviceLink;
  const poll = options.pollDeviceLink ?? pollDeviceLink;
  const save = options.saveAgentLink ?? saveAgentLink;
  const now = options.now ?? Date.now;

  const linkResult = (wallet: WalletName, entry: PendingLink): ToolResult => {
    const value = {
      wallet,
      address: entry.address,
      ...entry.summary,
    };
    return {
      structuredContent: value,
      content: [
        {
          type: "text",
          text: `Ask the person to open ${entry.summary.verificationUriComplete} and approve with their own wallet. The code is ${entry.summary.userCode}. Then call auth.status.`,
        },
      ],
    };
  };

  const finishLink = async (wallet: WalletName, entry: PendingLink): Promise<void> => {
    try {
      let result;
      try {
        result = await poll({
          apiBase: options.apiBase,
          start: entry.start,
          fetchImpl: options.fetchImpl,
        });
      } catch (error) {
        lastErrors.set(wallet, publicErrorMessage(error, "The vAPI agent link did not complete."));
        return;
      }
      try {
        await save({
          secrets: options.secrets,
          wallets: requireWalletStore(options.wallets),
          wallet,
          start: entry.start,
          result,
          apiBase: options.apiBase,
          label: entry.label,
        });
      } catch {
        lastErrors.set(wallet, "The vAPI agent link could not be stored safely.");
        return;
      }
      lastErrors.delete(wallet);
    } finally {
      if (pending.get(wallet) === entry) pending.delete(wallet);
    }
  };

  return {
    async link(input) {
      requireSafeSecretStore(options.secrets);
      requireWalletStore(options.wallets);

      const wallet = options.session.resolve().name;
      const existing = pending.get(wallet);
      if (existing !== undefined) return linkResult(wallet, existing);

      let startup = starting.get(wallet);
      if (startup === undefined) {
        startup = (async () => {
          const selected = await options.session.payment(wallet);
          const label = input.label ?? selected.wallet.name;
          let start: DeviceLinkStart;
          try {
            start = await begin({
              apiBase: options.apiBase,
              account: selected.account,
              label,
              scopes: [...DEFAULT_AGENT_SCOPES],
              fetchImpl: options.fetchImpl,
            });
          } catch (error) {
            const message = publicErrorMessage(error, "The vAPI agent link could not be started.");
            lastErrors.set(selected.wallet.name, message);
            throw new Error(message);
          }

          const entry: PendingLink = {
            start,
            label,
            address: selected.account.address,
            summary: {
              userCode: start.userCode,
              verificationUriComplete: start.verificationUriComplete,
              expiresAt: new Date(now() + start.expiresIn * 1_000).toISOString(),
            },
          };
          pending.set(selected.wallet.name, entry);
          lastErrors.delete(selected.wallet.name);
          void finishLink(selected.wallet.name, entry);
          return entry;
        })();
        starting.set(wallet, startup);
      }

      try {
        return linkResult(wallet, await startup);
      } finally {
        if (starting.get(wallet) === startup) starting.delete(wallet);
      }
    },

    async status(input) {
      await options.wallets?.reload();
      const { wallet, address } = await options.session.addressesFor(input.wallet);
      const link = options.wallets?.entry(wallet.name)?.link;
      const pendingLink = pending.get(wallet.name)?.summary;
      const lastError = lastErrors.get(wallet.name);
      const state = {
        wallet: wallet.name,
        address,
        ...(pendingLink === undefined ? {} : { pending: pendingLink }),
        ...(lastError === undefined ? {} : { lastError }),
      };
      const value =
        link === undefined
          ? { ...state, linked: false as const }
          : {
              ...state,
              linked: true as const,
              owner: link.owner,
              label: link.label,
              scopes: [...link.scopes],
              linkedAt: link.linkedAt,
              router:
                options.secrets.available &&
                (await options.secrets.has(agentSecretAccounts(wallet.name).routerStake)),
            };
      return {
        structuredContent: value,
        content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
      };
    },
  };
}

function requireSafeSecretStore(store: SecretStore): void {
  if (store.available) return;
  throw new Error(
    "No OS secret store is available on this machine, so the agent link cannot be stored safely. Nothing was started.",
  );
}

function requireWalletStore(store: WalletStore | undefined): WalletStore {
  if (store !== undefined) return store;
  throw new Error(
    "No wallet store is available, so the agent link cannot be recorded safely. Nothing was started.",
  );
}

function publicErrorMessage(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : String(error);
  if (
    message.length === 0 ||
    /device[_ -]?code|(?:access|refresh)[_ -]?token|router[_ -]?key|bearer\s/iu.test(message)
  ) {
    return fallback;
  }
  return error instanceof Error ? message : fallback;
}
