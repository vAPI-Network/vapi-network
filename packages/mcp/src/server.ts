import { createInterface, type Interface } from "node:readline";
import {
  MARKETPLACE_KINDS,
  ONRAMP_NETWORK,
  STATS_RANGES,
  VAPI_CLIENT_VERSION,
  aggregateStats,
  createSupportReport,
  createPublicFetch,
  formatUsdc,
  fundingPageUrl,
  getVapiPaths,
  isMirroredHit,
  isSolanaAddress,
  isSupportedPaymentNetwork,
  listingConformanceSchema,
  listingFeeSchema,
  listingGroupSchema,
  listingLivenessSchema,
  listingVerificationSchema,
  loadConfig,
  listAccounts,
  marketplaceDiscoveryPageSchema,
  marketplaceKindSchema,
  readReceipts,
  readSearchEvents,
  resolveRegistryUrl,
  secretStore,
  walletNameSchema,
  type SecretStore,
  type SpendCaps,
  type VapiPaymentAccount,
  type MarketplaceHit,
  type VapiConfig,
  type StatsRange,
  type WalletStore,
} from "@vapi-network/core";
import { z } from "zod";

import {
  VapiCallError,
  callService,
  type CallToolInput,
  type CallToolResult,
} from "./tools/call.js";
import {
  authLinkTool,
  authStatusTool,
  createAuthTools,
  type AuthAgentLinkOverrides,
} from "./tools/auth.js";
import { inspectService } from "./tools/inspect.js";
import {
  createRouterTools,
  routerBuyTool,
  routerChatTool,
  routerModelsTool,
  routerUsageTool,
  type RouterCoreOverrides,
} from "./tools/router.js";
import { searchMarketplace } from "./tools/search.js";
import { getWallet, type WalletBalance } from "./tools/wallet.js";
import { WalletSession, type SessionWalletInfo } from "./wallet-session.js";

export { callService, type CallToolInput, type CallToolResult };

export type VapiServerOptions = {
  /** The wallet unlocked before stdio was connected. */
  account: VapiPaymentAccount;
  config: VapiConfig;
  fetchImpl?: typeof fetch;
  ledgerPath?: string;
  receiptsPath?: string;
  searchesPath?: string;
  reportsDirectory?: string;
  /** The wallets on this machine. Without it the server has exactly one. */
  store?: WalletStore | undefined;
  /** The wallet the session starts on; `VAPI_WALLET` and the default follow. */
  wallet?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  /** The passphrase a payment unlocks with; see `WalletSession`. */
  passphrase?: (() => string | Promise<string>) | undefined;
  /** The OS secret store `vapi unlock` writes to; see `WalletSession`. */
  secretStore?: SecretStore | undefined;
  /** Device-link functions and API base overridden by deterministic tests. */
  agentLink?: AuthAgentLinkOverrides | undefined;
  /** Core Router functions overridden by deterministic tests. */
  router?: RouterCoreOverrides | undefined;
};

const MAX_CACHED_MARKETPLACE_REFS = 200;

/**
 * The wallet argument every wallet-aware tool takes. Left out, the session's
 * active wallet pays, which is `VAPI_WALLET` or the machine default until
 * `wallet.use` moves it.
 */
const walletArgument = {
  wallet: walletNameSchema
    .optional()
    .describe(
      "Wallet name. Without it: the session's active wallet, then VAPI_WALLET, then the machine default.",
    ),
};

const allWalletsArgument = {
  allWallets: z.boolean().optional().describe("Read every wallet's rows instead of one wallet's."),
};

const callToolResultSchema = z.object({
  wallet: z.string(),
  status: z.number().int(),
  body: z.unknown(),
  // Absent when the call went to an explicit URL, which has no listing.
  verification: listingVerificationSchema.optional(),
  payment: z
    .object({
      network: z.string(),
      amountAtomic: z.string(),
      amountUsd: z.string(),
      asset: z.string(),
      payTo: z.string(),
      settlement: z.unknown().nullable(),
      proof: z.string().nullable(),
    })
    .nullable(),
  outcome: z.literal("signed_in").optional(),
  expectedRequest: z
    .object({
      contentType: z.string().optional(),
      schema: z.unknown().optional(),
    })
    .optional(),
});

const inspectToolResultSchema = z.object({
  name: z.string(),
  method: z.string().nullable(),
  url: z.url(),
  price: z.string(),
  description: z.string(),
  operationId: z.string().optional(),
  requestContentType: z.string().optional(),
  requestSchema: z.unknown().optional(),
  responseContentType: z.string().optional(),
  network: z.string().optional(),
  // Registry-owned listing disclosures, mirrored from call.search.
  group: listingGroupSchema.optional(),
  fee: listingFeeSchema.optional(),
  verification: listingVerificationSchema,
  liveness: listingLivenessSchema.optional(),
  conformance: listingConformanceSchema.optional(),
  payment: z
    .object({
      scheme: z.literal("exact"),
      network: z.string(),
      asset: z.string(),
      payTo: z.string(),
      checkedAt: z.string(),
    })
    .nullable(),
});

const balanceSchema = z.object({
  network: z.string(),
  name: z.string(),
  usdcAtomic: z.string().nullable(),
  usdc: z.string().nullable(),
  error: z.string().optional(),
});

const walletToolResultSchema = z.object({
  wallet: z.string(),
  address: z.string(),
  balances: z.array(balanceSchema),
});

const walletListToolResultSchema = z.object({
  wallet: z.string().nullable(),
  default: z.string().nullable(),
  wallets: z.array(
    z.object({
      name: z.string(),
      address: z.string().optional(),
      solanaAddress: z.string().optional(),
      label: z.string().optional(),
      isDefault: z.boolean(),
      isActive: z.boolean(),
      spendCaps: z.object({
        perCallAtomic: z.string(),
        perDayAtomic: z.string(),
        perCallUsd: z.string(),
        perDayUsd: z.string(),
      }),
      balances: z.array(balanceSchema),
      balanceError: z.string().optional(),
    }),
  ),
});

const walletUseToolResultSchema = z.object({
  wallet: z.string(),
  active: z.string(),
  address: z.string().optional(),
  previous: z.string().nullable(),
  scope: z.literal("session"),
});

const fundingToolResultSchema = z.object({
  wallet: z.string(),
  address: z.string(),
  network: z.string(),
  url: z.url(),
  instructions: z.string(),
});

/** What an agent should do with the funding link: only a human can finish the payment. */
const FUNDING_PAGE_INSTRUCTIONS =
  "Give this link to your human; only they can complete the payment. USDC lands on Base at the address above, usually within a few minutes.";

const accountInfoSchema = z.object({
  caip2: z.string(),
  name: z.string(),
  address: z.string(),
  usdcBalance: z.object({ atomic: z.string(), formatted: z.string() }).nullable(),
  gasTokenBalance: z
    .object({ symbol: z.string(), atomic: z.string(), formatted: z.string() })
    .nullable()
    .optional(),
  depositUrl: z.string().optional(),
  depositInstructions: z.string().optional(),
  error: z.string().optional(),
});

const supportReportResultSchema = z.object({
  path: z.string(),
  issueUrl: z.string(),
  responseCode: z.number().int().optional(),
  report: z.object({
    message: z.string(),
    clientVersion: z.string(),
    os: z.object({ platform: z.string(), release: z.string(), arch: z.string() }),
    node: z.string(),
    receiptIds: z.array(z.string()),
    receiptAddresses: z
      .array(
        z.object({
          receiptId: z.string(),
          payer: z.string().optional(),
          payTo: z.string().optional(),
        }),
      )
      .optional(),
  }),
});

const latencyPercentilesSchema = z.object({
  p50Ms: z.number().nullable(),
  p95Ms: z.number().nullable(),
});
const outcomeValueSchema = z.object({ count: z.number().int(), rate: z.number() });
const serviceStatsSchema = z.object({
  name: z.string(),
  resourceUrl: z.string(),
  providerHost: z.string().optional(),
  spendUsd: z.string(),
  calls: z.number().int(),
});
const statsToolResultSchema = z.object({
  wallet: z.string().nullable(),
  range: z.enum(STATS_RANGES),
  generatedAt: z.string(),
  totals: z.object({
    spendUsd: z.string(),
    calls: z.number().int(),
    uniqueApis: z.number().int(),
    policyDeclines: z.number().int(),
  }),
  outcomes: z.object({
    paid: outcomeValueSchema,
    signed_in: outcomeValueSchema,
    declined_policy: outcomeValueSchema,
    failed_request: outcomeValueSchema,
    settlement_rejected: outcomeValueSchema,
    settlement_unknown: outcomeValueSchema,
  }),
  latency: z.object({
    total: latencyPercentilesSchema,
    phases: z.object({
      discover: latencyPercentilesSchema,
      quote: latencyPercentilesSchema,
      sign: latencyPercentilesSchema,
      request: latencyPercentilesSchema,
      settle: latencyPercentilesSchema,
    }),
  }),
  topServices: z.object({
    bySpend: z.array(serviceStatsSchema),
    byCalls: z.array(serviceStatsSchema),
  }),
  search: z.object({
    count: z.number().int(),
    zeroResultRate: z.number(),
    sources: z.record(
      z.string(),
      z.object({ count: z.number().int(), p95Ms: z.number().nullable() }),
    ),
  }),
});

const searchTool = {
  description:
    "Search the public vAPI Marketplace for APIs, services, and open requests. API results can be paid locally; other results continue at their web action. Search returns public cards, not request bodies — use call.inspect before call.pay whenever the request contract is not already known.",
  inputSchema: {
    query: z.string().trim().max(200).optional().describe("Capability, API, service, or request."),
    kinds: z
      .array(marketplaceKindSchema)
      .min(1)
      .max(MARKETPLACE_KINDS.length)
      .refine((values) => new Set(values).size === values.length, "Kinds must be unique.")
      .optional(),
    network: z.string().trim().min(1).max(160).optional(),
    limit: z.number().int().min(1).max(50).optional(),
    cursor: z.string().trim().min(1).max(4_096).optional(),
    includeUnverified: z
      .boolean()
      .optional()
      .describe(
        "Default results are vAPI-verified listings plus mirrored external catalogs; includeUnverified: true adds unverified self-listed APIs, which passed vAPI's automated x402 probe but were not reviewed.",
      ),
  },
  outputSchema: marketplaceDiscoveryPageSchema,
};

const inspectTool = {
  description:
    "Read a listing's executable request contract for free. Use this before call.pay whenever the required request body is not already known.",
  inputSchema: {
    id: z.string().min(1).describe("API ref returned by call.search in this vAPI process."),
    endpoint: z.string().trim().min(1).optional().describe("Named endpoint to inspect."),
  },
  outputSchema: inspectToolResultSchema,
};

const payTool = {
  description:
    "Call an API retained from this process's call.search, or an explicit x402 URL, and pay it directly from the local wallet. The wallet's own per-call and per-day spend caps are applied before anything is signed. Prefer a listing whose verification is \"verified\"; before paying one that is not, read its request contract and its price with call.inspect.",
  inputSchema: {
    ...walletArgument,
    id: z.string().min(1).optional().describe("API ref returned by call.search."),
    url: z.url().optional().describe("Explicit published API URL for a direct call."),
    method: z.string().min(1).optional(),
    endpoint: z.string().trim().min(1).optional().describe("Named endpoint to invoke."),
    body: z.unknown().optional(),
    contentType: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .regex(/^[^\r\n]+$/)
      .optional(),
    network: z
      .string()
      .refine(isSupportedPaymentNetwork, "Expected a supported EVM or Solana network identifier.")
      .optional(),
    expectedPayTo: z
      .string()
      .refine(
        (value) => /^0x[0-9a-fA-F]{40}$/.test(value) || isSolanaAddress(value),
        "Expected an EVM or Solana address.",
      )
      .optional(),
    maxPriceUsd: z
      .union([z.number().nonnegative(), z.string().regex(/^\d+(?:\.\d{1,6})?$/)])
      .optional(),
  },
  outputSchema: callToolResultSchema,
};

type ToolResult = {
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
  content: Array<{ type: "text"; text: string }>;
};

type ToolDefinition<Shape extends z.ZodRawShape> = {
  description?: string;
  deprecatedReplacement?: string;
  inputSchema: Shape;
  strictInput?: boolean;
  outputSchema?: z.ZodType;
};

type StoredTool = {
  description?: string;
  deprecatedReplacement?: string;
  inputSchema: z.ZodObject<z.ZodRawShape>;
  outputSchema?: z.ZodType;
  handler(input: unknown): Promise<ToolResult>;
};

type ListedTool = {
  name: string;
  description?: string;
  inputSchema: unknown;
  outputSchema?: unknown;
};

/** Minimal MCP server implementation for stdio and deterministic in-memory tests. */
export class VapiMcpServer {
  readonly #tools = new Map<string, StoredTool>();
  #stdio: Interface | undefined;

  registerTool<Shape extends z.ZodRawShape>(
    name: string,
    definition: ToolDefinition<Shape>,
    handler: (input: z.infer<z.ZodObject<Shape>>) => Promise<ToolResult>,
  ): void {
    const inputSchema = definition.strictInput
      ? z.strictObject(definition.inputSchema)
      : z.object(definition.inputSchema);
    this.#tools.set(name, {
      ...(definition.description ? { description: definition.description } : {}),
      ...(definition.deprecatedReplacement
        ? { deprecatedReplacement: definition.deprecatedReplacement }
        : {}),
      inputSchema,
      ...(definition.outputSchema ? { outputSchema: definition.outputSchema } : {}),
      handler: async (input) => await handler(inputSchema.parse(input ?? {})),
    });
  }

  async listTools(): Promise<{ tools: ListedTool[] }> {
    return {
      tools: [...this.#tools].map(([name, tool]) => ({
        name,
        ...(tool.description ? { description: tool.description } : {}),
        inputSchema: z.toJSONSchema(tool.inputSchema),
        ...(tool.outputSchema ? { outputSchema: z.toJSONSchema(tool.outputSchema) } : {}),
      })),
    };
  }

  async callTool(request: {
    name: string;
    arguments?: Record<string, unknown>;
  }): Promise<ToolResult> {
    const tool = this.#tools.get(request.name);
    if (!tool) {
      return {
        isError: true,
        content: [{ type: "text", text: `Unknown tool ${JSON.stringify(request.name)}.` }],
      };
    }
    try {
      const result = await tool.handler(request.arguments ?? {});
      return tool.deprecatedReplacement
        ? withDeprecation(result, tool.deprecatedReplacement)
        : result;
    } catch (error) {
      const result = toolError(error);
      return tool.deprecatedReplacement
        ? withDeprecation(result, tool.deprecatedReplacement)
        : result;
    }
  }

  connectStdio(): void {
    if (this.#stdio) return;
    this.#stdio = createInterface({ input: process.stdin, crlfDelay: Infinity });
    this.#stdio.on("line", (line) => {
      void this.#handleLine(line);
    });
  }

  async close(): Promise<void> {
    this.#stdio?.close();
    this.#stdio = undefined;
  }

  async #handleLine(line: string): Promise<void> {
    if (!line.trim()) return;
    let request: Record<string, unknown>;
    try {
      request = JSON.parse(line) as Record<string, unknown>;
    } catch {
      this.#write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      return;
    }
    const id = request.id;
    const method = request.method;
    if (typeof method !== "string" || id === undefined) return;
    try {
      let result: unknown;
      if (method === "initialize") {
        const params = asRecord(request.params);
        result = {
          protocolVersion:
            typeof params?.protocolVersion === "string" ? params.protocolVersion : "2025-11-25",
          capabilities: { tools: {} },
          serverInfo: { name: "@vapi-network/mcp", version: VAPI_CLIENT_VERSION },
        };
      } else if (method === "tools/list") {
        result = await this.listTools();
      } else if (method === "tools/call") {
        const params = asRecord(request.params);
        result = await this.callTool({
          name: typeof params?.name === "string" ? params.name : "",
          arguments: asRecord(params?.arguments),
        });
      } else if (method === "ping") {
        result = {};
      } else {
        this.#write({
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: `Method not found: ${method}` },
        });
        return;
      }
      this.#write({ jsonrpc: "2.0", id, result });
    } catch (error) {
      this.#write({
        jsonrpc: "2.0",
        id,
        error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
      });
    }
  }

  #write(message: unknown): void {
    process.stdout.write(`${JSON.stringify(message)}\n`);
  }
}

export function createVapiServer(options: VapiServerOptions) {
  const server = new VapiMcpServer();
  const searchedMarketplaceHits = new Map<string, MarketplaceHit[]>();
  const secrets = options.secretStore ?? secretStore();
  const session = new WalletSession({
    account: options.account,
    store: options.store,
    wallet: options.wallet,
    env: options.env,
    passphrase: options.passphrase,
    secretStore: secrets,
  });
  const guardedFetch =
    options.fetchImpl ??
    createPublicFetch({ allowPrivateNetwork: options.config.allowPrivateNetwork ?? false });
  const apiBase = options.agentLink?.apiBase ?? agentApiBase(options.config, options.env);
  const auth = createAuthTools({
    session,
    secrets,
    wallets: options.store,
    fetchImpl: guardedFetch,
    apiBase,
    ...(options.agentLink?.startDeviceLink
      ? { startDeviceLink: options.agentLink.startDeviceLink }
      : {}),
    ...(options.agentLink?.pollDeviceLink
      ? { pollDeviceLink: options.agentLink.pollDeviceLink }
      : {}),
    ...(options.agentLink?.saveAgentLink ? { saveAgentLink: options.agentLink.saveAgentLink } : {}),
    ...(options.agentLink?.now ? { now: options.agentLink.now } : {}),
  });

  server.registerTool("auth.link", authLinkTool, auth.link);
  server.registerTool("auth.status", authStatusTool, auth.status);

  const router = createRouterTools({
    session,
    secrets,
    wallets: options.store,
    fetchImpl: guardedFetch,
    apiBase,
    account: options.account,
    config: options.config,
    ...(options.ledgerPath === undefined ? {} : { ledgerPath: options.ledgerPath }),
    ...(options.receiptsPath === undefined ? {} : { receiptsPath: options.receiptsPath }),
    ...(options.router?.listRouterModels
      ? { listRouterModels: options.router.listRouterModels }
      : {}),
    ...(options.router?.routerUsage ? { routerUsage: options.router.routerUsage } : {}),
    ...(options.router?.routerChat ? { routerChat: options.router.routerChat } : {}),
    ...(options.router?.ownerStake ? { ownerStake: options.router.ownerStake } : {}),
    ...(options.router?.buyRouterBalance
      ? { buyRouterBalance: options.router.buyRouterBalance }
      : {}),
  });
  server.registerTool("router.models", routerModelsTool, router.models);
  server.registerTool("router.usage", routerUsageTool, router.usage);
  server.registerTool("router.chat", routerChatTool, router.chat);
  server.registerTool("router.buy", routerBuyTool, router.buy);

  const search = async (input: {
    query?: string;
    kinds?: Array<(typeof MARKETPLACE_KINDS)[number]>;
    network?: string;
    limit?: number;
    cursor?: string;
    includeUnverified?: boolean;
  }) =>
    asStructuredToolResult(async () => {
      const page = await searchMarketplace(input, options.config, guardedFetch, {
        ...(options.searchesPath ? { searchesPath: options.searchesPath } : {}),
      });
      rememberMarketplaceHits(searchedMarketplaceHits, page.items);
      return page;
    });
  server.registerTool("call.search", searchTool, search);
  server.registerTool("search", deprecatedTool(searchTool, "call.search"), search);

  const inspect = async (input: { id: string; endpoint?: string }) =>
    asStructuredToolResult(() => inspectService(input, options.config, guardedFetch));
  server.registerTool("call.inspect", inspectTool, inspect);
  server.registerTool("inspect", deprecatedTool(inspectTool, "call.inspect"), inspect);

  const pay = async (input: CallToolInput & { wallet?: string }) =>
    asStructuredToolResult(async () => {
      const { wallet, ...call } = input;
      // Resolve and unlock here, not at startup: wallet.use must be able to
      // move the session onto another wallet and have the next payment come
      // out of that one, under that one's caps.
      const selected = await session.payment(wallet);
      const result = await callService({
        input: call,
        marketplaceHit: cachedMarketplaceHit(searchedMarketplaceHits, call.id),
        account: selected.account,
        config: options.config,
        fetchImpl: guardedFetch,
        ledgerPath: options.ledgerPath ?? getVapiPaths().ledger,
        receiptsPath: options.receiptsPath ?? getVapiPaths().receipts,
        wallet: selected.wallet.name,
        ...(selected.spendCaps ? { spendCaps: selected.spendCaps } : {}),
      });
      return { wallet: selected.wallet.name, ...result };
    });
  server.registerTool("call.pay", payTool, pay);
  server.registerTool("call", deprecatedTool(payTool, "call.pay"), pay);

  const balance = async (input: { wallet?: string }) =>
    asStructuredToolResult(async () => {
      const { wallet, ...addresses } = await session.addressesFor(input.wallet);
      return {
        wallet: wallet.name,
        ...(await getWallet(addresses, options.config, {
          fetchImpl: guardedFetch,
        })),
      };
    });
  server.registerTool(
    "wallet.address",
    {
      description: "Show the address of a local non-custodial wallet.",
      inputSchema: { ...walletArgument },
      outputSchema: z.object({ wallet: z.string(), address: z.string() }),
    },
    async (input) =>
      asStructuredToolResult(async () => {
        const { wallet, address } = await session.addressesFor(input.wallet);
        return { wallet: wallet.name, address };
      }),
  );
  server.registerTool(
    "wallet.balance",
    {
      description: "Show a local wallet's address and USDC balances on configured networks.",
      inputSchema: { ...walletArgument },
      outputSchema: walletToolResultSchema,
    },
    balance,
  );
  server.registerTool(
    "wallet.accounts",
    {
      description:
        "List configured network accounts, USDC and gas balances, and local deposit instructions for one wallet.",
      inputSchema: { ...walletArgument },
      outputSchema: z.object({ wallet: z.string(), accounts: z.array(accountInfoSchema) }),
    },
    async (input) =>
      asStructuredToolResult(async () => {
        const { wallet, address, solana } = await session.addressesFor(input.wallet);
        return {
          wallet: wallet.name,
          accounts: await listAccounts({
            address,
            ...(solana ? { solanaAddress: solana.address } : {}),
            config: options.config,
            fetchImpl: guardedFetch,
          }),
        };
      }),
  );
  server.registerTool(
    "wallet.list",
    {
      description:
        "List every wallet on this machine with its address, spend caps and USDC balances, and say which one this session pays from. Read-only and never needs a passphrase.",
      inputSchema: {},
      outputSchema: walletListToolResultSchema,
    },
    async () =>
      asStructuredToolResult(async () => ({
        wallet: session.activeName ?? null,
        default: session.store?.defaultName ?? session.activeName ?? null,
        wallets: await Promise.all(
          (await session.list()).map((info) => describeWallet(info, options.config, guardedFetch)),
        ),
      })),
  );
  server.registerTool(
    "wallet.use",
    {
      description:
        "Point this MCP session at another wallet for the rest of the process. Session-only: it never writes wallets.json and never changes the default your human set, so their terminal keeps using their own wallet. Only a human, at the CLI, can create, rename, remove, back up or export a wallet.",
      inputSchema: {
        name: walletNameSchema.describe("Name of an existing wallet, as shown by wallet.list."),
      },
      outputSchema: walletUseToolResultSchema,
    },
    async (input) =>
      asStructuredToolResult(async () => {
        const used = await session.use(input.name);
        return { wallet: used.active, scope: "session" as const, ...used };
      }),
  );
  server.registerTool(
    "wallet.fund",
    {
      description:
        "Return the hosted funding page for a local wallet so you can hand the link to your human. The page takes a card via Coinbase (needs a Coinbase account; US guest checkout), a transfer from MetaMask/Coinbase Wallet/WalletConnect, or a bridge from another chain. No network call, no expiring link, and vAPI never holds the funds.",
      inputSchema: {
        ...walletArgument,
        amountUsd: z
          .number()
          .positive()
          .max(100_000)
          .optional()
          .describe("Fiat amount in USD to prefill on the funding page."),
      },
      outputSchema: fundingToolResultSchema,
    },
    async (input) =>
      asStructuredToolResult(async () => {
        const { wallet, address } = await session.addressesFor(input.wallet);
        return {
          wallet: wallet.name,
          address,
          network: ONRAMP_NETWORK,
          url: fundingPageUrl(
            resolveRegistryUrl(),
            address,
            input.amountUsd === undefined ? {} : { amount: input.amountUsd },
          ),
          instructions: FUNDING_PAGE_INSTRUCTIONS,
        };
      }),
  );
  server.registerTool(
    "wallet",
    deprecatedTool(
      {
        description: "Show a local wallet's address and USDC balances on configured networks.",
        inputSchema: { ...walletArgument },
        outputSchema: walletToolResultSchema,
      },
      "wallet.balance",
    ),
    balance,
  );

  /** The wallet a ledger view is filtered by, or null for every wallet. */
  const ledgerWallet = (input: { wallet?: string; allWallets?: boolean }): string | null =>
    input.allWallets === true ? null : session.resolve(input.wallet).name;

  server.registerTool(
    "receipts.list",
    {
      description: "List local append-only x402 call receipts for one wallet, newest entries last.",
      inputSchema: {
        ...walletArgument,
        ...allWalletsArgument,
        limit: z.number().int().min(0).max(1_000).optional(),
      },
      outputSchema: z.object({ wallet: z.string().nullable(), receipts: z.array(z.unknown()) }),
    },
    async (input) =>
      asStructuredToolResult(async () => {
        const wallet = ledgerWallet(input);
        return {
          wallet,
          receipts: await readReceipts(options.receiptsPath ?? getVapiPaths().receipts, {
            ...(input.limit === undefined ? {} : { limit: input.limit }),
            ...(wallet === null ? {} : { wallet }),
          }),
        };
      }),
  );
  server.registerTool(
    "receipts.stats",
    {
      description: "Aggregate local call and search metrics for one wallet. No data is uploaded.",
      inputSchema: {
        ...walletArgument,
        ...allWalletsArgument,
        range: z.enum(STATS_RANGES).optional(),
      },
      outputSchema: statsToolResultSchema,
    },
    async (input) =>
      asStructuredToolResult(async () => {
        const paths = getVapiPaths();
        const wallet = ledgerWallet(input);
        return {
          wallet,
          ...aggregateStats({
            receipts: await readReceipts(options.receiptsPath ?? paths.receipts, {
              ...(wallet === null ? {} : { wallet }),
            }),
            searches: await readSearchEvents(options.searchesPath ?? paths.searches),
            range: (input.range ?? "24h") as StatsRange,
          }),
        };
      }),
  );
  server.registerTool(
    "support.report",
    {
      description:
        "Write a privacy-preserving bug report locally. Upload only when send is explicitly true.",
      inputSchema: {
        message: z.string().trim().min(1).max(10_000),
        includeAddresses: z.boolean().optional(),
        send: z.boolean().optional(),
      },
      outputSchema: supportReportResultSchema,
    },
    async (input) =>
      asStructuredToolResult(() =>
        createSupportReport({
          message: input.message,
          includeAddresses: input.includeAddresses,
          send: input.send,
          receiptsPath: options.receiptsPath ?? getVapiPaths().receipts,
          ...(options.reportsDirectory ? { reportsDirectory: options.reportsDirectory } : {}),
          fetchImpl: guardedFetch,
          allowPrivateNetwork: options.config.allowPrivateNetwork,
        }),
      ),
  );

  return server;
}

const MARKETPLACE_DISCOVERY_PATH = "/api/call/discovery";

/** Derive the API origin from the same configured discovery endpoint the CLI uses. */
function agentApiBase(config: VapiConfig, env: NodeJS.ProcessEnv | undefined): string {
  try {
    const url = new URL(config.marketplaceDiscoveryUrl);
    const path = url.pathname.replace(/\/+$/u, "");
    if (!path.endsWith(MARKETPLACE_DISCOVERY_PATH)) return resolveRegistryUrl(env);
    url.search = "";
    url.hash = "";
    url.pathname = path.slice(0, path.length - MARKETPLACE_DISCOVERY_PATH.length) || "/";
    return url.href;
  } catch {
    return resolveRegistryUrl(env);
  }
}

/**
 * One `wallet.list` row: what the registry knows, the caps in both atomic USDC
 * and US dollars, and the balances. A wallet whose RPC call fails reports it in
 * `balanceError` and does not take the rest of the list down with it.
 */
async function describeWallet(
  info: SessionWalletInfo,
  config: VapiConfig,
  fetchImpl: typeof fetch,
): Promise<{
  name: string;
  address?: string;
  solanaAddress?: string;
  label?: string;
  isDefault: boolean;
  isActive: boolean;
  spendCaps: {
    perCallAtomic: string;
    perDayAtomic: string;
    perCallUsd: string;
    perDayUsd: string;
  };
  balances: WalletBalance[];
  balanceError?: string;
}> {
  const caps = info.spendCaps ?? config.spendCaps;
  const row = {
    name: info.name,
    ...(info.address === undefined ? {} : { address: info.address }),
    ...(info.solanaAddress === undefined ? {} : { solanaAddress: info.solanaAddress }),
    ...(info.label === undefined ? {} : { label: info.label }),
    isDefault: info.isDefault,
    isActive: info.isActive,
    spendCaps: capsInBothUnits(caps),
  };
  if (info.address === undefined) {
    return {
      ...row,
      balances: [],
      balanceError: `Wallet ${info.name} records no address; its keystore is missing or unreadable.`,
    };
  }
  try {
    const wallet = await getWallet(
      {
        address: info.address as `0x${string}`,
        ...(info.solanaAddress ? { solana: { address: info.solanaAddress } } : {}),
      },
      config,
      { fetchImpl },
    );
    // One wallet's unreachable RPC must not take the whole list down, so the
    // failure is reported on its row and the other wallets still answer.
    const failed = wallet.balances.filter((entry) => entry.error !== undefined);
    return {
      ...row,
      balances: wallet.balances,
      ...(failed.length > 0 && failed.length === wallet.balances.length
        ? { balanceError: failed[0]?.error ?? "No balance could be read." }
        : {}),
    };
  } catch (error) {
    return {
      ...row,
      balances: [],
      balanceError: error instanceof Error ? error.message : String(error),
    };
  }
}

function capsInBothUnits(caps: SpendCaps): {
  perCallAtomic: string;
  perDayAtomic: string;
  perCallUsd: string;
  perDayUsd: string;
} {
  return {
    perCallAtomic: caps.perCallAtomic,
    perDayAtomic: caps.perDayAtomic,
    perCallUsd: formatUsdc(BigInt(caps.perCallAtomic)),
    perDayUsd: formatUsdc(BigInt(caps.perDayAtomic)),
  };
}

function deprecatedTool<T extends { description?: string }>(
  tool: T,
  replacement: string,
): T & { deprecatedReplacement: string } {
  return {
    ...tool,
    description: `Deprecated: use ${replacement}. ${tool.description ?? ""}`.trim(),
    deprecatedReplacement: replacement,
  };
}

function withDeprecation<T extends { content: Array<{ type: "text"; text: string }> }>(
  result: T,
  replacement: string,
): T {
  const [first, ...rest] = result.content;
  const notice = `DEPRECATED: use ${replacement}; this alias will be removed in a later release.`;
  return {
    ...result,
    content: [{ type: "text", text: first ? `${notice}\n${first.text}` : notice }, ...rest],
  };
}

async function asStructuredToolResult<T extends object>(operation: () => Promise<T>) {
  try {
    const value = await operation();
    return {
      structuredContent: value as Record<string, unknown>,
      content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    };
  } catch (error) {
    return toolError(error);
  }
}

function indexMarketplaceHits(items: MarketplaceHit[]): Map<string, MarketplaceHit[]> {
  const indexed = new Map<string, MarketplaceHit[]>();
  for (const item of items) {
    const matches = indexed.get(item.ref) ?? [];
    matches.push(item);
    indexed.set(item.ref, matches);
  }
  return indexed;
}

function rememberMarketplaceHits(
  indexed: Map<string, MarketplaceHit[]>,
  items: MarketplaceHit[],
): void {
  for (const [ref, incoming] of indexMarketplaceHits(items)) {
    const incomingIdentities = new Set(incoming.map(marketplaceHitIdentity));
    const retained = (indexed.get(ref) ?? []).filter(
      (hit) => !incomingIdentities.has(marketplaceHitIdentity(hit)),
    );
    indexed.delete(ref);
    indexed.set(ref, [...retained, ...incoming]);
  }
  while (indexed.size > MAX_CACHED_MARKETPLACE_REFS) {
    const oldestRef = indexed.keys().next().value;
    if (oldestRef === undefined) break;
    indexed.delete(oldestRef);
  }
}

function marketplaceHitIdentity(hit: MarketplaceHit): string {
  return `${hit.kind}\u0000${isMirroredHit(hit) ? "external" : "first_party"}`;
}

function cachedMarketplaceHit(
  indexed: Map<string, MarketplaceHit[]>,
  id: string | undefined,
): MarketplaceHit | undefined {
  if (!id) return undefined;
  const matches = indexed.get(id) ?? [];
  if (matches.length === 0) {
    throw new Error(
      `Marketplace result ${JSON.stringify(id)} is not retained by this vAPI process; run call.search again or call its published URL directly.`,
    );
  }
  if (matches.length > 1) {
    throw new Error(
      `Marketplace ref ${JSON.stringify(id)} is ambiguous across result sources or kinds; use the result's canonical action instead.`,
    );
  }
  return matches[0];
}

export async function startStdioServer(options: VapiServerOptions) {
  const server = createVapiServer(options);
  server.connectStdio();
  return server;
}

export async function loadServerConfig() {
  return await loadConfig();
}

function toolError(error: unknown) {
  const text =
    error instanceof VapiCallError
      ? JSON.stringify(
          {
            error: error.message,
            code: error.code,
            ...(error.possibleSettlement ? { possibleSettlement: error.possibleSettlement } : {}),
            ...(error.paymentRejection ? { paymentRejection: error.paymentRejection } : {}),
            ...(error.confirmedSettlement
              ? { confirmedSettlement: error.confirmedSettlement }
              : {}),
          },
          null,
          2,
        )
      : error instanceof Error
        ? error.message
        : String(error);
  return {
    isError: true as const,
    content: [{ type: "text" as const, text }],
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
