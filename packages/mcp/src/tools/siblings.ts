import {
  SIBLINGS_UNSUPPORTED_MESSAGE,
  SiblingsError,
  fetchSiblings,
  type SecretStore,
  type WalletStore,
} from "@vapi-network/core";
import { z } from "zod";

const NO_STORE_MESSAGE =
  "No wallet store is available on this machine, so there are no accounts to read. Run vapi setup.";
const NO_LINK_NOTE =
  "No local account is linked. Link one with auth.link or vapi login to see accounts on other devices.";

const siblingSchema = z.object({
  name: z.string(),
  address: z.string(),
  device: z.string().nullable(),
  status: z.enum(["active", "revoked"]),
  allowance: z.object({
    routerPerDayUsd: z.number().nullable(),
    perCallUsd: z.number().nullable(),
    perDayUsd: z.number().nullable(),
  }),
  self: z.boolean(),
  onThisDevice: z.boolean(),
});

const siblingsOutputSchema = z.object({
  owner: z.string().nullable(),
  siblings: z.array(siblingSchema),
  note: z.string().optional(),
});

export const vapiSiblingsTool = {
  description:
    "Read-only. Lists every account of the same owner, including accounts on other devices, and never returns keys, phrases, or tokens.",
  inputSchema: {
    account: z
      .string()
      .optional()
      .describe(
        "Local account whose link is used. Without it: the default account's link, then the first linked account.",
      ),
  },
  outputSchema: siblingsOutputSchema,
};

type ToolResult =
  | {
      structuredContent: z.infer<typeof siblingsOutputSchema>;
      content: Array<{ type: "text"; text: string }>;
    }
  | {
      isError: true;
      content: Array<{ type: "text"; text: string }>;
    };

export function createSiblingsTool(options: {
  wallets?: WalletStore | undefined;
  secrets: SecretStore;
  fetchImpl: typeof fetch;
  now?: (() => Date) | undefined;
}): (input: { account?: string }) => Promise<ToolResult> {
  return async (input) => {
    if (options.wallets === undefined) return errorResult(NO_STORE_MESSAGE);
    const wallets = options.wallets;
    await wallets.reload();
    const localAccounts = await wallets.list();

    const selected =
      input.account === undefined
        ? (() => {
            const defaultAccount = localAccounts.find(
              (account) => account.name === wallets.defaultName,
            );
            return defaultAccount?.entry.link === undefined
              ? localAccounts.find((account) => account.entry.link !== undefined)
              : defaultAccount;
          })()
        : localAccounts.find((account) => account.name === input.account);

    if (input.account !== undefined && selected === undefined) {
      return errorResult(`Account ${input.account} is not in the vault.`);
    }
    if (input.account !== undefined && selected?.entry.link === undefined) {
      return errorResult(
        `Account ${input.account} is not linked. Link it with auth.link or vapi login.`,
      );
    }
    if (selected?.entry.link === undefined) {
      return toolResult({ owner: null, siblings: [], note: NO_LINK_NOTE });
    }

    const link = selected.entry.link;
    const localAddresses = new Set(
      localAccounts.flatMap((account) =>
        account.address === undefined ? [] : [account.address.toLowerCase()],
      ),
    );
    try {
      const result = await fetchSiblings({
        apiBase: link.apiBase,
        account: selected.name,
        secrets: options.secrets,
        wallets,
        fetchImpl: options.fetchImpl,
        ...(options.now === undefined ? {} : { now: () => options.now!().getTime() }),
      });
      return toolResult({
        owner: result.owner,
        siblings: result.siblings.map((sibling) => ({
          ...sibling,
          onThisDevice: localAddresses.has(sibling.address.toLowerCase()),
        })),
      });
    } catch (error) {
      if (error instanceof SiblingsError && error.code === "unsupported") {
        return toolResult({
          owner: link.owner,
          siblings: [],
          note: SIBLINGS_UNSUPPORTED_MESSAGE,
        });
      }
      return errorResult(
        error instanceof SiblingsError ? error.message : "The vAPI siblings request failed.",
      );
    }
  };
}

function toolResult(value: z.infer<typeof siblingsOutputSchema>): ToolResult {
  return {
    structuredContent: value,
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  };
}

function errorResult(message: string): ToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}
