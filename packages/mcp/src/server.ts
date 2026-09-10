import { createInterface, type Interface } from "node:readline";
import {
  MARKETPLACE_KINDS,
  STATS_RANGES,
  aggregateStats,
  createPublicFetch,
  getVapiPaths,
  isMirroredHit,
  loadConfig,
  marketplaceDiscoveryPageSchema,
  marketplaceKindSchema,
  readReceipts,
  readSearchEvents,
  type MarketplaceHit,
  type VapiConfig,
  type StatsRange,
} from "@vapi-network/core";
import type { PrivateKeyAccount } from "viem/accounts";
import { z } from "zod";

import {
  VapiCallError,
  callService,
  type CallToolInput,
  type CallToolResult,
} from "./tools/call.js";
import { inspectService } from "./tools/inspect.js";
import { searchMarketplace } from "./tools/search.js";
import { getWallet } from "./tools/wallet.js";

export { callService, type CallToolInput, type CallToolResult };

export type VapiServerOptions = {
  account: PrivateKeyAccount;
  config: VapiConfig;
  fetchImpl?: typeof fetch;
  ledgerPath?: string;
  receiptsPath?: string;
  searchesPath?: string;
};

const MAX_CACHED_MARKETPLACE_REFS = 200;

const callToolResultSchema = z.object({
  status: z.number().int(),
  body: z.unknown(),
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

const walletToolResultSchema = z.object({
  address: z.string(),
  balances: z.array(
    z.object({
      network: z.string(),
      name: z.string(),
      usdcAtomic: z.string().nullable(),
      usdc: z.string().nullable(),
      error: z.string().optional(),
    }),
  ),
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
    "Call an API retained from this process's call.search, or an explicit x402 URL, and pay it directly from the local wallet.",
  inputSchema: {
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
      .regex(/^eip155:[1-9]\d*$/)
      .optional(),
    expectedPayTo: z
      .string()
      .regex(/^0x[0-9a-fA-F]{40}$/)
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
    const inputSchema = z.object(definition.inputSchema);
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
          serverInfo: { name: "@vapi-network/mcp", version: "0.2.0-dev.2" },
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
  const guardedFetch =
    options.fetchImpl ??
    createPublicFetch({ allowPrivateNetwork: options.config.allowPrivateNetwork ?? false });

  const search = async (input: {
    query?: string;
    kinds?: Array<(typeof MARKETPLACE_KINDS)[number]>;
    network?: string;
    limit?: number;
    cursor?: string;
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

  const pay = async (input: CallToolInput) =>
    asStructuredToolResult(() =>
      callService({
        input,
        marketplaceHit: cachedMarketplaceHit(searchedMarketplaceHits, input.id),
        account: options.account,
        config: options.config,
        fetchImpl: guardedFetch,
        ledgerPath: options.ledgerPath ?? getVapiPaths().ledger,
        receiptsPath: options.receiptsPath ?? getVapiPaths().receipts,
      }),
    );
  server.registerTool("call.pay", payTool, pay);
  server.registerTool("call", deprecatedTool(payTool, "call.pay"), pay);

  const balance = async () =>
    asStructuredToolResult(() => getWallet(options.account.address, options.config));
  server.registerTool(
    "wallet.address",
    {
      description: "Show the address of the local non-custodial wallet.",
      inputSchema: {},
      outputSchema: z.object({ address: z.string() }),
    },
    async () => asStructuredToolResult(async () => ({ address: options.account.address })),
  );
  server.registerTool(
    "wallet.balance",
    {
      description: "Show the local wallet address and USDC balances on configured networks.",
      inputSchema: {},
      outputSchema: walletToolResultSchema,
    },
    balance,
  );
  server.registerTool(
    "wallet",
    deprecatedTool(
      {
        description: "Show the local wallet address and USDC balances on configured networks.",
        inputSchema: {},
        outputSchema: walletToolResultSchema,
      },
      "wallet.balance",
    ),
    balance,
  );

  server.registerTool(
    "receipts.list",
    {
      description: "List local append-only x402 call receipts, newest entries last.",
      inputSchema: { limit: z.number().int().min(0).max(1_000).optional() },
      outputSchema: z.object({ receipts: z.array(z.unknown()) }),
    },
    async (input) =>
      asStructuredToolResult(async () => ({
        receipts: await readReceipts(options.receiptsPath ?? getVapiPaths().receipts, {
          ...(input.limit === undefined ? {} : { limit: input.limit }),
        }),
      })),
  );
  server.registerTool(
    "receipts.stats",
    {
      description: "Aggregate local call and search metrics. No data is uploaded.",
      inputSchema: { range: z.enum(STATS_RANGES).optional() },
      outputSchema: statsToolResultSchema,
    },
    async (input) =>
      asStructuredToolResult(async () => {
        const paths = getVapiPaths();
        return aggregateStats({
          receipts: await readReceipts(options.receiptsPath ?? paths.receipts),
          searches: await readSearchEvents(options.searchesPath ?? paths.searches),
          range: (input.range ?? "24h") as StatsRange,
        });
      }),
  );

  return server;
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
