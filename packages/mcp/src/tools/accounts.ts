import {
  AccountCapsRaiseError,
  activeAgentMarker,
  addAccount,
  appendAudit,
  formatCeilingUsd,
  formatUsdc,
  lowerAccountCaps,
  transferBetweenAccounts,
  usdToAtomic,
  walletNameSchema,
  type AccountAddResult,
  type AddAccountArgs,
  type SecretStore,
  type TransferArgs,
  type WalletName,
  type WalletStore,
} from "@vapi-network/core";
import { z } from "zod";

import {
  accountsSend,
  accountsSendInputSchema,
  accountsSendOutputSchema,
} from "../actions/accounts.js";
import type { AccountsPort } from "../actions/context.js";
import type { WalletSession } from "../wallet-session.js";

export { accountsSendInputSchema, accountsSendOutputSchema } from "../actions/accounts.js";

const NO_STORE_MESSAGE =
  "No wallet store is available on this machine, so accounts cannot be changed. Run vapi setup.";

const spendCapsSchema = z.object({
  perCallUsd: z.string(),
  perDayUsd: z.string(),
});

const capsSchema = spendCapsSchema.extend({
  ceilingUsd: z.string(),
});

const publicLinkSchema = z.object({
  userCode: z.string(),
  verificationUri: z.url(),
  verificationUriComplete: z.url(),
  expiresInSeconds: z.number().int().positive(),
});

const accountsAddOutputSchema = z.object({
  account: z.string(),
  address: z.string(),
  caps: spendCapsSchema,
  created: z.boolean(),
  linked: z.boolean(),
  autoApproved: z.boolean(),
  link: publicLinkSchema.optional(),
  message: z.string(),
});

const accountsCapsOutputSchema = z.object({
  account: z.string(),
  address: z.string(),
  caps: capsSchema,
  message: z.string(),
});

export const accountsAddTool = {
  description:
    "Create a derived local account with spend caps and link it to the owner. Existing names are returned unchanged. The recovery phrase and signing keys never leave the local vault.",
  strictInput: true,
  inputSchema: {
    name: walletNameSchema.describe(
      "New account name: lowercase letters, digits and hyphens, up to 32 characters.",
    ),
    caps: z
      .object({
        perCallUsd: z
          .number()
          .nonnegative()
          .optional()
          .describe("Most this account may spend on one paid API call, in USD."),
        perDayUsd: z
          .number()
          .nonnegative()
          .optional()
          .describe("Most this account may spend on paid API calls per day, in USD."),
      })
      .optional()
      .describe("Local paid-API spend limits. Omitted values use the new-account defaults."),
    routerAllowanceUsd: z
      .number()
      .positive()
      .optional()
      .describe(
        "Daily vAPI Router allowance requested from the owner. Omit it to use caps.perDayUsd on a trusted device, or to let the owner choose it on the consent page otherwise. Ignored when link scopes exclude router.use.",
      ),
    link: z
      .boolean()
      .optional()
      .describe("Whether to link the new account to the owner now. Defaults to true."),
  },
  outputSchema: accountsAddOutputSchema,
};

export const accountsCapsTool = {
  description:
    "Lower a local account's paid-API spend caps or automatic balance ceiling. Raising a cap, raising the ceiling, or turning the ceiling off is refused and must be done by a person in the terminal.",
  strictInput: true,
  inputSchema: {
    name: walletNameSchema.describe("Existing local account name."),
    perCallUsd: z
      .number()
      .nonnegative()
      .optional()
      .describe("New maximum spend for one paid API call, in USD. It may only be lowered."),
    perDayUsd: z
      .number()
      .nonnegative()
      .optional()
      .describe("New maximum spend on paid API calls per day, in USD. It may only be lowered."),
    ceilingUsd: z
      .union([z.number().nonnegative(), z.literal("off")])
      .optional()
      .describe(
        "New automatic-sweep ceiling in USDC. A number may only lower it; off is accepted only to return the terminal command required to disable it.",
      ),
  },
  outputSchema: accountsCapsOutputSchema,
};

export const accountsSendTool = {
  description: accountsSend.description,
  strictInput: true,
  inputSchema: accountsSendInputSchema.shape,
  outputSchema: accountsSendOutputSchema,
};

export type AccountsToolOverrides = {
  configPath?: string | undefined;
  hostname?: string | undefined;
  now?: (() => number) | undefined;
  sleep?: AddAccountArgs["sleep"];
  startDeviceLink?: AddAccountArgs["startDeviceLink"];
  pollDeviceLink?: AddAccountArgs["pollDeviceLink"];
  saveAgentLink?: AddAccountArgs["saveAgentLink"];
  scopes?: AddAccountArgs["scopes"];
  nonce?: TransferArgs["nonce"];
};

export type AccountsToolsOptions = AccountsToolOverrides & {
  session: WalletSession;
  secrets: SecretStore;
  wallets?: WalletStore | undefined;
  fetchImpl: typeof fetch;
  apiBase: string;
  env?: NodeJS.ProcessEnv | undefined;
  signal?: AbortSignal | undefined;
};

export type CreateAccountsPortOptions = Pick<
  AccountsToolsOptions,
  "session" | "secrets" | "wallets" | "fetchImpl" | "apiBase" | "now" | "nonce"
>;

type ToolResult =
  | {
      structuredContent: Record<string, unknown>;
      content: Array<{ type: "text"; text: string }>;
    }
  | {
      isError: true;
      content: Array<{ type: "text"; text: string }>;
    };

type PublicLink = NonNullable<AccountAddResult["link"]>;

/** Account mutation tools. Link credentials and the device code stay inside core. */
export function createAccountsTools(options: AccountsToolsOptions): {
  add(input: {
    name: string;
    caps?: { perCallUsd?: number; perDayUsd?: number };
    routerAllowanceUsd?: number;
    link?: boolean;
  }): Promise<ToolResult>;
  caps(input: {
    name: string;
    perCallUsd?: number;
    perDayUsd?: number;
    ceilingUsd?: number | "off";
  }): Promise<ToolResult>;
} {
  const pending = new Map<WalletName, PublicLink>();
  const starting = new Map<WalletName, Promise<AccountAddResult>>();

  const start = async (input: {
    name: string;
    caps?: { perCallUsd?: number; perDayUsd?: number };
    routerAllowanceUsd?: number;
    link?: boolean;
  }): Promise<AccountAddResult> => {
    const wallets = requireWalletStore(options.wallets ?? options.session.store);
    const result = await addAccount({
      store: wallets,
      secrets: options.secrets,
      name: input.name,
      existing: "return",
      apiBase: options.apiBase,
      fetchImpl: options.fetchImpl,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.scopes === undefined ? {} : { scopes: options.scopes }),
      ...(input.caps === undefined ? {} : { caps: input.caps }),
      ...(input.routerAllowanceUsd === undefined
        ? {}
        : { routerAllowanceUsd: input.routerAllowanceUsd }),
      ...(input.link === undefined ? {} : { link: input.link }),
      ...(options.env === undefined ? {} : { env: options.env }),
      ...(options.configPath === undefined ? {} : { configPath: options.configPath }),
      ...(options.hostname === undefined ? {} : { hostname: options.hostname }),
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
      ...(options.startDeviceLink === undefined
        ? {}
        : { startDeviceLink: options.startDeviceLink }),
      ...(options.pollDeviceLink === undefined ? {} : { pollDeviceLink: options.pollDeviceLink }),
      ...(options.saveAgentLink === undefined ? {} : { saveAgentLink: options.saveAgentLink }),
    });

    if (result.created) {
      const marker = activeAgentMarker(options.env ?? process.env);
      await appendAudit(options.session.home, {
        event: "wallet.create",
        wallet: result.account,
        tty: false,
        ...(marker === undefined ? {} : { agentMarker: marker }),
        detail: "mcp accounts.add",
      });
    }

    if (result.link !== undefined && result.completion !== undefined) {
      pending.set(result.account, result.link);
      void result.completion.then(
        () => {
          if (pending.get(result.account) === result.link) pending.delete(result.account);
        },
        () => {
          if (pending.get(result.account) === result.link) pending.delete(result.account);
        },
      );
    }
    return result;
  };

  return {
    async add(input) {
      if ((options.wallets ?? options.session.store) === undefined) return noStoreResult();
      const name = walletNameSchema.parse(input.name);
      let operation = starting.get(name);
      if (operation === undefined) {
        operation = start(input);
        starting.set(name, operation);
      }

      let result: AccountAddResult;
      try {
        result = await operation;
      } catch (error) {
        return errorResult(error);
      } finally {
        if (starting.get(name) === operation) starting.delete(name);
      }

      const existingPending = pending.get(result.account);
      const link = result.link ?? existingPending;
      const message = addMessage(result, link, input.link === false);
      return successResult({
        account: result.account,
        address: result.address,
        caps: result.caps,
        created: result.created,
        linked: result.linked,
        autoApproved: result.autoApproved,
        ...(link === undefined ? {} : { link }),
        message,
      });
    },

    async caps(input) {
      const wallets = options.wallets ?? options.session.store;
      if (wallets === undefined) return noStoreResult();
      if (
        input.perCallUsd === undefined &&
        input.perDayUsd === undefined &&
        input.ceilingUsd === undefined
      ) {
        return errorResult("Set at least one of perCallUsd, perDayUsd or ceilingUsd.");
      }
      try {
        const name = walletNameSchema.parse(input.name);
        const requestedCeiling =
          input.ceilingUsd === undefined
            ? undefined
            : input.ceilingUsd === "off"
              ? null
              : usdToAtomic(input.ceilingUsd);
        if (requestedCeiling === null) {
          return errorResult(
            `Turn off the ceiling in the terminal: vapi accounts caps ${name} --ceiling off`,
          );
        }
        const spendResult =
          input.perCallUsd === undefined && input.perDayUsd === undefined
            ? undefined
            : await lowerAccountCaps({
                store: wallets,
                name,
                ...(input.perCallUsd === undefined ? {} : { perCallUsd: input.perCallUsd }),
                ...(input.perDayUsd === undefined ? {} : { perDayUsd: input.perDayUsd }),
              });
        let ceilingChanged = false;
        if (requestedCeiling !== undefined) {
          await wallets.updateCeiling(name, (current) => {
            if (current !== null && requestedCeiling > current) {
              throw new AccountCapsRaiseError(
                `Raise the ceiling in the terminal: vapi accounts caps ${name} --ceiling ${formatCeilingUsd(requestedCeiling)}`,
              );
            }
            ceilingChanged = requestedCeiling !== current;
            return requestedCeiling;
          });
        }
        const entry = wallets.entry(name);
        if (entry === undefined) throw new Error(`No wallet named ${name}.`);
        const address = spendResult?.address ?? (await wallets.readAddress(name));
        if (address === undefined) throw new Error(`No key for wallet ${name} in the vault.`);
        const caps = {
          perCallUsd:
            spendResult?.caps.perCallUsd ?? formatUsdc(BigInt(entry.spendCaps.perCallAtomic)),
          perDayUsd:
            spendResult?.caps.perDayUsd ?? formatUsdc(BigInt(entry.spendCaps.perDayAtomic)),
          ceilingUsd: formatCeilingUsd(wallets.ceilingCaps(name).ceilingAtomic),
        };
        const changed = (spendResult?.changed ?? false) || ceilingChanged;
        if (changed) {
          const marker = activeAgentMarker(options.env ?? process.env);
          await appendAudit(options.session.home, {
            event: "wallet.caps",
            wallet: name,
            tty: false,
            ...(marker === undefined ? {} : { agentMarker: marker }),
            detail: `${caps.perCallUsd} USD per call, ${caps.perDayUsd} USD per day, ceilingUsd=${caps.ceilingUsd}`,
          });
        }
        return successResult({
          account: name,
          address,
          caps,
          message: changed
            ? input.ceilingUsd === undefined
              ? `Account ${name} caps lowered to ${caps.perCallUsd} USD per call and ${caps.perDayUsd} USD per day.`
              : `Account ${name} caps lowered to ${caps.perCallUsd} USD per call, ${caps.perDayUsd} USD per day, and a ${caps.ceilingUsd} USDC ceiling.`
            : `Account ${name} already has those caps. Nothing was changed.`,
        });
      } catch (error) {
        if (error instanceof AccountCapsRaiseError) return errorResult(error.message);
        return errorResult(error);
      }
    },
  };
}

export function createAccountsPort(options: CreateAccountsPortOptions): AccountsPort {
  return {
    async send(input) {
      const wallets = requireWalletStore(options.wallets ?? options.session.store);
      return await transferBetweenAccounts({
        store: wallets,
        secrets: options.secrets,
        apiBase: options.apiBase,
        from: input.from,
        to: input.to,
        amountUsd: input.amountUsd,
        ...(input.network === undefined ? {} : { network: input.network }),
        purpose: "send",
        fetchImpl: options.fetchImpl,
        unlock: async (from) => {
          const { account } = await options.session.payment(from);
          return {
            address: account.address,
            signTypedData: async (typedData) => await account.signTypedData(typedData),
          };
        },
        ...(options.now === undefined ? {} : { now: options.now }),
        ...(options.nonce === undefined ? {} : { nonce: options.nonce }),
      });
    },
  };
}

function addMessage(
  result: AccountAddResult,
  link: PublicLink | undefined,
  skipped: boolean,
): string {
  if (!result.created) return `Account ${result.account} already exists. Nothing was changed.`;
  if (result.linked && result.autoApproved) {
    return `Account ${result.account} added and linked on this trusted device.`;
  }
  if (skipped) return `Account ${result.account} added with its caps. Linking was skipped.`;
  if (result.linkError !== undefined) {
    return `Account ${result.account} was added with its caps, but the link did not start. Run auth.link to try again.`;
  }
  if (link !== undefined) {
    return `Account ${result.account} added. Ask the owner to open ${link.verificationUriComplete} and approve. The code is ${link.userCode}. The link is saved on this machine once they approve.`;
  }
  return `Account ${result.account} added with its caps.`;
}

function requireWalletStore(store: WalletStore | undefined): WalletStore {
  if (store !== undefined) return store;
  throw new Error(NO_STORE_MESSAGE);
}

function successResult(value: Record<string, unknown>): ToolResult {
  return {
    structuredContent: value,
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  };
}

function noStoreResult(): ToolResult {
  return errorResult(NO_STORE_MESSAGE);
}

function errorResult(error: unknown): ToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
  };
}
