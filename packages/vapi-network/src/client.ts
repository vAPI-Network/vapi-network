import { homedir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_WALLET_NAME,
  KeystoreError,
  WalletStore,
  assertWalletName,
  getVapiPaths,
  loadConfig,
  readAgentProfile,
  resolvePassphrase,
  resolveRegistryUrl,
  secretStore as createSecretStore,
  spendCapsForWallet,
  staleStoredPassphraseMessage,
  type AgentRouterUsage,
  type ChatRequest,
  type ChatResult,
  type Receipt,
  type RouterModel,
  type ResolvedWallet,
  type SecretStore,
  type VapiConfig,
  type VapiPaymentAccount,
} from "@vapi-network/core";
import {
  buyRouterBalance,
  listRouterModels,
  routerChat,
  routerCredentials,
  routerUsage,
  type RouterClientDeps,
  type RouterTopupTier,
} from "@vapi-network/core/router-client";
import {
  callService,
  createAgentRunDeps,
  inspectService,
  runAgent,
  searchMarketplace,
  type CallToolInput,
  type CallToolResult,
  type InspectToolResult,
  type RunAgentDeps,
  type RunAgentResult,
} from "@vapi-network/mcp";

const ACCOUNT_NOT_LINKED =
  "Not linked. Run vapi login on this machine, or set VAPI_HOME to a linked home.";
const DISCOVERY_PATH = "/api/call/discovery";

export type VapiClientOptions = {
  /** Wallet name. Defaults to VAPI_WALLET, then the machine default. */
  wallet?: string;
  /** Local state directory. Defaults to VAPI_HOME or ~/.vapi. */
  home?: string;
  /**
   * Server use: sign with this account instead of the local keystore, for
   * example a KMS or CDP server wallet represented as a viem account.
   */
  account?: VapiPaymentAccount;
  /** Used only without account, VAPI_KEYSTORE_PASSWORD, or a keychain entry. */
  passphrase?: string;
  fetch?: typeof fetch;
  /** Test or embedded-runtime override for the OS secret store. */
  secretStore?: SecretStore;
  /** Test or embedded-runtime override for VAPI_HOME, VAPI_WALLET, and passphrase lookup. */
  env?: NodeJS.ProcessEnv;
};

export type VapiClient = {
  wallet: { name: string; address: `0x${string}`; owner: `0x${string}` | null };
  call: {
    search(
      query: string,
      opts?: { network?: string; includeUnverified?: boolean },
    ): Promise<unknown[]>;
    inspect(ref: string): Promise<InspectToolResult>;
    pay(input: CallToolInput): Promise<CallToolResult>;
  };
  router: {
    models(): Promise<RouterModel[]>;
    usage(): Promise<AgentRouterUsage>;
    buy(usd: RouterTopupTier): Promise<{ receipt: Receipt; balance: AgentRouterUsage["balance"] }>;
    chat(req: ChatRequest): Promise<ChatResult>;
    /**
     * Base URL and key for any OpenAI-compatible framework. The key stays in
     * your process. Use this in your own code. Do not pass it into a model prompt.
     */
    openai(): Promise<{ baseURL: string; apiKey: string }>;
  };
  agent: {
    run(
      profileName: string,
      task: string,
      opts?: { approve?: RunAgentDeps["approve"]; onEvent?: RunAgentDeps["onEvent"] },
    ): Promise<RunAgentResult>;
  };
};

/** A wallet-bound SDK facade over vAPI Call, vAPI Router, and local agents. */
export async function createVapiClient(options: VapiClientOptions = {}): Promise<VapiClient> {
  const env = options.env ?? process.env;
  const home = options.home ?? (env.VAPI_HOME?.trim() || join(homedir(), ".vapi"));
  const paths = getVapiPaths(home);
  const [config, wallets] = await Promise.all([
    loadConfig(paths.config, env),
    WalletStore.open(paths.directory),
  ]);
  const selected =
    options.account === undefined
      ? wallets.resolve({
          ...(options.wallet === undefined ? {} : { name: options.wallet }),
          env,
        })
      : injectedAccountWallet(wallets, config, options.wallet, env);
  const secrets = options.secretStore ?? createSecretStore();
  const storedAddress = options.account?.address ?? (await wallets.readAddress(selected.name));
  if (storedAddress === undefined || !/^0x[0-9a-fA-F]{40}$/u.test(storedAddress)) {
    throw new KeystoreError(
      `Wallet ${selected.name} records no address. Its keystore at ${selected.path} is missing or unreadable.`,
    );
  }
  const address = storedAddress as `0x${string}`;

  let accountPromise: Promise<VapiPaymentAccount> | undefined;

  const account = (): Promise<VapiPaymentAccount> => {
    if (options.account !== undefined) return Promise.resolve(options.account);
    accountPromise ??= unlockOnce();
    return accountPromise;
  };

  const unlockOnce = async (): Promise<VapiPaymentAccount> => {
    const supplied = options.passphrase;
    const resolved = await resolvePassphrase(selected.name, {
      env,
      store: secrets,
      interactive: supplied !== undefined,
      ...(supplied === undefined ? {} : { prompt: async () => supplied }),
    });
    try {
      return await wallets.unlock(selected.name, resolved.passphrase);
    } catch (error) {
      if (resolved.source !== "secret-store" || !(error instanceof KeystoreError)) throw error;
      throw new KeystoreError(staleStoredPassphraseMessage(selected.name, secrets), {
        cause: error,
      });
    }
  };

  const requireAccountLink = async (): Promise<void> => {
    if (options.account === undefined) return;
    await wallets.reload();
    if (wallets.entry(selected.name)?.link === undefined) throw new Error(ACCOUNT_NOT_LINKED);
  };

  const currentSpendCaps = async () => {
    await wallets.reload();
    return await spendCapsForWallet(wallets, selected.name);
  };

  const deps: RouterClientDeps = {
    secrets,
    wallets,
    wallet: selected.name,
    ...(options.fetch === undefined ? {} : { fetchImpl: options.fetch }),
    refill: {
      account,
      config,
      caps: currentSpendCaps,
      paths: { ledgerPath: paths.ledger, receiptsPath: paths.receipts },
    },
  };

  return {
    wallet: {
      name: selected.name,
      address,
      owner: selected.entry.link?.owner ?? null,
    },
    call: {
      async search(query, searchOptions = {}) {
        const page = await searchMarketplace(
          {
            query,
            ...(searchOptions.network === undefined ? {} : { network: searchOptions.network }),
            ...(searchOptions.includeUnverified === undefined
              ? {}
              : { includeUnverified: searchOptions.includeUnverified }),
          },
          config,
          options.fetch,
          { searchesPath: paths.searches },
        );
        return page.items;
      },
      async inspect(ref) {
        return await inspectService({ id: ref }, config, options.fetch);
      },
      async pay(input) {
        return await callService({
          input,
          account: await account(),
          config,
          wallet: selected.name,
          spendCaps: await currentSpendCaps(),
          ledgerPath: paths.ledger,
          receiptsPath: paths.receipts,
          ...(options.fetch === undefined ? {} : { fetchImpl: options.fetch }),
        });
      },
    },
    router: {
      async models() {
        await requireAccountLink();
        return await listRouterModels({
          apiBase: registryBaseUrl(config.marketplaceDiscoveryUrl, env),
          ...(options.fetch === undefined ? {} : { fetchImpl: options.fetch }),
        });
      },
      async usage() {
        await requireAccountLink();
        return await routerUsage(deps);
      },
      async buy(usd) {
        await requireAccountLink();
        return await buyRouterBalance(
          {
            ...deps,
            account: await account(),
            config,
            caps: await currentSpendCaps(),
            paths: { ledgerPath: paths.ledger, receiptsPath: paths.receipts },
          },
          usd,
        );
      },
      async chat(request) {
        await requireAccountLink();
        return await routerChat(deps, request);
      },
      async openai() {
        await requireAccountLink();
        return await routerCredentials(deps);
      },
    },
    agent: {
      async run(profileName, task, runOptions = {}) {
        await requireAccountLink();
        const profile = await readAgentProfile(home, profileName);
        if (profile.wallet !== selected.name) {
          throw new Error(
            `Agent ${profile.name} uses wallet ${profile.wallet}; this client uses ${selected.name}.`,
          );
        }
        const spendCaps = await currentSpendCaps();
        const runDeps = createAgentRunDeps({
          profile,
          config,
          home,
          account: await account(),
          wallet: selected.name,
          spendCaps,
          chat: async (request) => await routerChat(deps, request),
          approve: runOptions.approve ?? (async () => false),
          ...(runOptions.onEvent === undefined ? {} : { onEvent: runOptions.onEvent }),
          ...(options.fetch === undefined ? {} : { fetchImpl: options.fetch }),
          ledgerPath: paths.ledger,
          receiptsPath: paths.receipts,
        });
        return await runAgent(task, runDeps);
      },
    },
  };
}

function injectedAccountWallet(
  wallets: WalletStore,
  config: VapiConfig,
  requestedWallet: string | undefined,
  env: NodeJS.ProcessEnv,
): ResolvedWallet {
  const name = assertWalletName(
    requestedWallet?.trim() ||
      env.VAPI_WALLET?.trim() ||
      wallets.defaultName ||
      DEFAULT_WALLET_NAME,
  );
  if (wallets.has(name)) return wallets.resolve({ name, env });
  return {
    name,
    path: wallets.pathFor(name),
    entry: {
      createdAt: "1970-01-01T00:00:00.000Z",
      spendCaps: { ...config.spendCaps },
    },
  };
}

function registryBaseUrl(discoveryUrl: string, env: NodeJS.ProcessEnv): string {
  try {
    const url = new URL(discoveryUrl);
    const path = url.pathname.replace(/\/+$/u, "");
    if (!path.endsWith(DISCOVERY_PATH)) return resolveRegistryUrl(env);
    url.search = "";
    url.hash = "";
    url.pathname = path.slice(0, path.length - DISCOVERY_PATH.length) || "/";
    return url.href;
  } catch {
    return resolveRegistryUrl(env);
  }
}
