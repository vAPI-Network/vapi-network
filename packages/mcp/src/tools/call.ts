import { randomUUID } from "node:crypto";

import {
  MARKETPLACE_EXECUTION_METHODS,
  appendReceipt,
  assertPublicUrl,
  createPublicFetch,
  DiscoveryCatalogError,
  formatUsdc,
  getVapiPaths,
  isNetworkConfigured,
  marketplaceExecutionMethodSchema,
  marketplaceHitSchema,
  parseEip155ChainId,
  reserveSpend,
  type LookupFn,
  type MarketplaceExecutionMethod,
  type MarketplaceHit,
  type Receipt,
  type VapiConfig,
} from "@vapi-network/core";
import type { PrivateKeyAccount } from "viem/accounts";

import {
  assertMaxPrice,
  buildX402Payment,
  classifySettlement,
  parse402Response,
  parseSettlementResponse,
} from "../x402.js";
import { findMarketplaceApiByRef, resolveServiceEndpoint } from "./search.js";

export type CallToolInput = {
  id?: string;
  url?: string;
  method?: string;
  endpoint?: string;
  body?: unknown;
  maxPriceUsd?: number | string;
  network?: string;
  expectedPayTo?: string;
  contentType?: string;
};

export type PossibleSettlement = {
  network: string;
  asset: string;
  amountAtomic: string;
  payTo: string;
  payer: string;
  authorizationNonce: string;
  authorizationExpiresAt: string;
  receipt: unknown | null;
};

export type PaymentRejection = {
  httpStatus: number;
  receipt: unknown;
};

export type ConfirmedSettlement = {
  httpStatus: number;
  receipt: unknown;
};

export class VapiCallError extends Error {
  readonly name = "VapiCallError";
  readonly paymentRejection?: PaymentRejection;
  readonly confirmedSettlement?: ConfirmedSettlement;

  constructor(
    public readonly code:
      | "invalid_request"
      | "payment_rejected"
      | "receipt_write_failed"
      | "response_unreadable"
      | "settlement_unknown",
    message: string,
    public readonly possibleSettlement?: PossibleSettlement,
    options?: ErrorOptions & {
      paymentRejection?: PaymentRejection;
      confirmedSettlement?: ConfirmedSettlement;
    },
  ) {
    super(message, options);
    this.paymentRejection = options?.paymentRejection;
    this.confirmedSettlement = options?.confirmedSettlement;
  }
}

const MAX_RESPONSE_BYTES = 1_048_576;
const BODY_HEADER_NAMES = [
  "content-encoding",
  "content-language",
  "content-length",
  "content-location",
  "content-type",
] as const;

type ResolvedCallEndpoint = {
  url: string;
  method: string;
  registered: boolean;
  resolvedListing: boolean;
  requiresExplicitMethod?: boolean;
  requestContentType?: string;
  requestSchema?: unknown;
  payment?: {
    network: string;
    payTo?: string;
  };
};

export type CallToolResult = {
  status: number;
  body: unknown;
  payment: null | {
    network: string;
    amountAtomic: string;
    amountUsd: string;
    asset: string;
    payTo: string;
    settlement: unknown | null;
    proof: string | null;
  };
  expectedRequest?: {
    contentType?: string;
    schema?: unknown;
  };
};

export type CallServiceArgs = {
  input: CallToolInput;
  marketplaceHit?: MarketplaceHit;
  account: PrivateKeyAccount;
  config: VapiConfig;
  fetchImpl?: typeof fetch;
  lookup?: LookupFn;
  ledgerPath?: string;
  receiptsPath?: string;
  now?: Date;
  timeoutMs?: number;
};

type CallExecution = {
  result: CallToolResult;
  resourceUrl: string;
  method: string;
};

export async function callService(args: CallServiceArgs): Promise<CallToolResult> {
  const startedAt = args.now ?? new Date();
  let execution: CallExecution;
  try {
    execution = await executeCallService(args);
  } catch (error) {
    // Receipt errors must never hide the primary call/settlement error.
    await recordCallError(args, error, startedAt).catch(() => undefined);
    throw error;
  }
  try {
    await recordCallReceipt(args, execution, startedAt);
  } catch (error) {
    const settlement = execution.result.payment?.settlement;
    const confirmedSettlement =
      classifySettlement(settlement) === "succeeded"
        ? { httpStatus: execution.result.status, receipt: settlement }
        : undefined;
    throw new VapiCallError(
      "receipt_write_failed",
      "The API call completed, but its local receipt could not be written. Do not retry automatically.",
      undefined,
      {
        cause: error,
        ...(confirmedSettlement ? { confirmedSettlement } : {}),
      },
    );
  }
  return execution.result;
}

async function executeCallService(args: CallServiceArgs): Promise<CallExecution> {
  const { input, account, config } = args;
  if ((!input.id && !input.url) || (input.id && input.url)) {
    throw new Error("call requires exactly one of id or url.");
  }
  if (input.endpoint && !input.id) {
    throw new Error("call endpoint can only be used together with a marketplace API id.");
  }
  const requestedMethod =
    input.method === undefined ? undefined : normalizeCallMethod(input.method);
  if (input.method !== undefined && !requestedMethod) {
    throw new Error(`call method must be one of ${MARKETPLACE_EXECUTION_METHODS.join(", ")}.`);
  }
  const fetchImpl =
    args.fetchImpl ??
    createPublicFetch({
      allowPrivateNetwork: config.allowPrivateNetwork ?? false,
      lookup: args.lookup,
    });
  const marketplaceHit =
    args.marketplaceHit === undefined ? undefined : marketplaceHitSchema.parse(args.marketplaceHit);
  const endpoint = input.id
    ? await resolveCallEndpoint(input.id, input.endpoint, marketplaceHit, config, fetchImpl)
    : null;
  const requestedNetwork = normalizeRequiredNetwork(input.network);
  const listingNetwork = endpoint?.payment?.network;
  if (requestedNetwork && listingNetwork && requestedNetwork !== listingNetwork) {
    throw new Error(
      `The registered endpoint requires ${listingNetwork}; the requested network was ${requestedNetwork}.`,
    );
  }
  const requiredNetwork = validateRequiredNetwork(
    listingNetwork ?? requestedNetwork,
    config.networks,
  );
  const inputExpectedPayTo = validateExpectedPayTo(input.expectedPayTo);
  if (
    endpoint?.payment?.payTo &&
    inputExpectedPayTo &&
    endpoint.payment.payTo.toLowerCase() !== inputExpectedPayTo.toLowerCase()
  ) {
    throw new Error("The requested expected payee conflicts with the registered payout wallet.");
  }
  const expectedPayTo = endpoint?.payment?.payTo ?? inputExpectedPayTo;
  if (endpoint?.requiresExplicitMethod && !requestedMethod) {
    throw new Error(
      "Direct external-catalog APIs without a published method require an explicit method.",
    );
  }
  if (input.id && endpoint?.registered && requestedMethod && requestedMethod !== endpoint.method) {
    throw new Error(
      `The registered endpoint method is ${endpoint.method}; a conflicting method override is not allowed.`,
    );
  }
  const method = (
    endpoint?.registered ? endpoint.method : (requestedMethod ?? endpoint?.method ?? "POST")
  ).toUpperCase();
  assertRequiredRequestKeys(endpoint, method, input.body);
  const endpointUrl = input.url ?? endpoint?.url;
  if (!endpointUrl) {
    throw new Error(`Resolved service endpoint ${JSON.stringify(input.id)} is missing a URL.`);
  }
  const url = new URL(endpointUrl);
  assertSecureCallUrl(url, config.allowPrivateNetwork ?? false);
  await assertPublicUrl(url, {
    allowPrivateNetwork: config.allowPrivateNetwork ?? false,
    lookup: args.lookup,
    timeoutMs: Math.min(args.timeoutMs ?? 30_000, 5_000),
  });
  const headers = new Headers({ accept: "application/json" });
  const requestBody = serializeRequestBody(input.body, headers, method, url, input.contentType);
  const createRequest = (requestHeaders: Headers) =>
    new Request(url, {
      method,
      headers: requestHeaders,
      body: method === "GET" || method === "HEAD" ? undefined : requestBody,
    });
  const request = createRequest(headers);

  const fetchWithGuardedRedirects = async (
    candidateRequest: Request,
    followRedirects = true,
  ): Promise<{
    response: Response;
    request: Request;
    finish: () => void;
    waitFor<T>(operation: Promise<T>, response: Response): Promise<T>;
  }> => {
    let currentRequest = candidateRequest;
    let followedRedirects = 0;

    while (true) {
      const attempt = await fetchAttempt(
        fetchImpl,
        new Request(currentRequest.clone(), { redirect: "manual" }),
        args.timeoutMs ?? 30_000,
      );
      const response = attempt.response;
      if (!isRedirectStatus(response.status)) {
        return { ...attempt, request: currentRequest };
      }
      if (!followRedirects) {
        return { ...attempt, request: currentRequest };
      }

      const location = response.headers.get("location");
      if (!location) {
        return { ...attempt, request: currentRequest };
      }
      await response.body?.cancel().catch(() => undefined);
      attempt.finish();
      if (followedRedirects >= 5) {
        throw new Error("call exceeded the maximum of 5 HTTP redirect hops.");
      }

      const redirectUrl = new URL(location, currentRequest.url);
      assertSecureCallUrl(redirectUrl, config.allowPrivateNetwork ?? false);
      await assertPublicUrl(redirectUrl, {
        allowPrivateNetwork: config.allowPrivateNetwork ?? false,
        lookup: args.lookup,
        timeoutMs: Math.min(args.timeoutMs ?? 30_000, 5_000),
      });

      const rewritesToGet =
        ((response.status === 301 || response.status === 302) &&
          currentRequest.method === "POST") ||
        (response.status === 303 &&
          currentRequest.method !== "GET" &&
          currentRequest.method !== "HEAD");
      const redirectMethod = rewritesToGet ? "GET" : currentRequest.method;
      const redirectHeaders = new Headers(currentRequest.headers);
      if (rewritesToGet) {
        for (const name of BODY_HEADER_NAMES) {
          redirectHeaders.delete(name);
        }
      }
      const redirectBody =
        rewritesToGet || currentRequest.body === null
          ? undefined
          : await currentRequest.clone().arrayBuffer();
      currentRequest = new Request(redirectUrl, {
        method: redirectMethod,
        headers: redirectHeaders,
        body: redirectBody,
      });
      followedRedirects += 1;
    }
  };

  const initial = await fetchWithGuardedRedirects(request.clone());
  const initialResponse = initial.response;
  if (initialResponse.status !== 402) {
    try {
      return {
        resourceUrl: initial.request.url,
        method: initial.request.method,
        result: {
          status: initialResponse.status,
          body: await initial.waitFor(readResponseBody(initialResponse), initialResponse),
          payment: null,
          ...expectedRequestFor(endpoint, initialResponse.status),
        },
      };
    } finally {
      initial.finish();
    }
  }

  let quote: Awaited<ReturnType<typeof parse402Response>>;
  try {
    quote = await initial.waitFor(
      parse402Response(initialResponse, config.networks, requiredNetwork, expectedPayTo),
      initialResponse,
    );
  } finally {
    initial.finish();
  }
  if (new URL(initial.request.url).protocol !== "https:") {
    throw new Error("vAPI will only send a signed x402 payment to an HTTPS endpoint.");
  }
  assertMaxPrice(quote.amountAtomic, input.maxPriceUsd);
  await reserveSpend(quote.amountAtomic, config.spendCaps, {
    ledgerPath: args.ledgerPath ?? getVapiPaths().ledger,
    now: args.now,
  });

  // The reservation above is intentionally complete before this signing call.
  const payment = await buildX402Payment({
    account,
    quote,
    nowSeconds: args.now ? Math.floor(args.now.getTime() / 1_000) : undefined,
  });
  const paidHeaders = new Headers(initial.request.headers);
  for (const [name, value] of Object.entries(payment.headers)) {
    paidHeaders.set(name, value);
  }
  const paidBody =
    initial.request.method === "GET" || initial.request.method === "HEAD"
      ? undefined
      : await initial.request.clone().arrayBuffer();
  const paidRequest = new Request(initial.request.url, {
    method: initial.request.method,
    headers: paidHeaders,
    body: paidBody,
  });
  let paidAttempt: Awaited<ReturnType<typeof fetchWithGuardedRedirects>>;
  try {
    paidAttempt = await fetchWithGuardedRedirects(paidRequest, false);
  } catch (error) {
    throw settlementUnknown(
      "The paid request lost its response. Do not retry automatically; inspect the authorization and settlement state first.",
      quote,
      payment.payload.payload.authorization,
      null,
      error,
    );
  }
  const paidResponse = paidAttempt.response;
  const settlement = parseSettlementResponse(paidResponse.headers);
  const settlementOutcome = classifySettlement(settlement);
  try {
    if (settlementOutcome === "rejected") {
      await paidResponse.body?.cancel().catch(() => undefined);
      throw paymentRejected(paidResponse.status, settlement);
    }
    if (isRedirectStatus(paidResponse.status) && settlementOutcome !== "succeeded") {
      await paidResponse.body?.cancel().catch(() => undefined);
      throw settlementUnknown(
        "The paid endpoint returned a redirect. The payment header was not forwarded; do not retry automatically until settlement is checked.",
        quote,
        payment.payload.payload.authorization,
        settlement,
      );
    }
    if (paidResponse.status === 402 && settlementOutcome !== "succeeded") {
      let message =
        "The endpoint returned HTTP 402 after receiving the authorization. Settlement is uncertain; do not retry automatically.";
      try {
        const changed = await paidAttempt.waitFor(
          parse402Response(paidResponse, config.networks, requiredNetwork, expectedPayTo),
          paidResponse,
        );
        if (changed.amountAtomic !== quote.amountAtomic) {
          message = `The endpoint returned a changed quote (${quote.amountAtomic} → ${changed.amountAtomic} atomic USDC) after receiving the authorization. Settlement is uncertain; do not retry automatically.`;
        }
      } catch {
        // The repeated response does not need a parseable next quote to remain ambiguous.
      }
      throw settlementUnknown(message, quote, payment.payload.payload.authorization, settlement);
    }
    if (!paidResponse.ok && settlementOutcome !== "succeeded") {
      await paidResponse.body?.cancel().catch(() => undefined);
      throw settlementUnknown(
        `The paid endpoint returned HTTP ${paidResponse.status} without decisive settlement evidence. Do not retry automatically.`,
        quote,
        payment.payload.payload.authorization,
        settlement,
      );
    }
    let body: unknown;
    try {
      body = await paidAttempt.waitFor(readResponseBody(paidResponse), paidResponse);
    } catch (error) {
      if (settlementOutcome === "succeeded") {
        throw responseUnreadableAfterSettlement(paidResponse.status, settlement, error);
      }
      throw settlementUnknown(
        "The paid response could not be read. Do not retry automatically; inspect the authorization and settlement state first.",
        quote,
        payment.payload.payload.authorization,
        settlement,
        error,
      );
    }

    return {
      resourceUrl: paidAttempt.request.url,
      method: paidAttempt.request.method,
      result: {
        status: paidResponse.status,
        body,
        payment: {
          network: quote.accepted.network,
          amountAtomic: quote.amountAtomic.toString(),
          amountUsd: formatUsdc(quote.amountAtomic),
          asset: quote.accepted.asset,
          payTo: quote.accepted.payTo,
          settlement,
          proof: paidResponse.headers.get("x-vapi-payment-proof"),
        },
        ...expectedRequestFor(endpoint, paidResponse.status),
      },
    };
  } finally {
    paidAttempt.finish();
  }
}

async function recordCallReceipt(
  args: CallServiceArgs,
  execution: CallExecution,
  startedAt: Date,
): Promise<void> {
  if (!args.receiptsPath) return;
  const payment = execution.result.payment;
  const evidence = payment?.settlement ?? undefined;
  const transaction = settlementTransaction(evidence);
  const receipt: Receipt = {
    id: randomUUID(),
    timestamp: startedAt.toISOString(),
    resourceUrl: execution.resourceUrl,
    method: execution.method,
    ...(payment
      ? {
          quote: {
            network: payment.network,
            asset: payment.asset,
            amountAtomic: payment.amountAtomic,
            payTo: payment.payTo,
          },
          payer: args.account.address,
          settlement: {
            outcome: classifySettlement(evidence),
            ...(transaction ? { transaction } : {}),
            ...(evidence === undefined ? {} : { evidence }),
          },
        }
      : {}),
    latencyMs: Math.max(0, Date.now() - startedAt.getTime()),
    status: execution.result.status,
  };
  await appendReceipt(receipt, args.receiptsPath);
}

async function recordCallError(
  args: CallServiceArgs,
  error: unknown,
  startedAt: Date,
): Promise<void> {
  if (!args.receiptsPath) return;
  const resourceUrl = receiptResourceUrl(args.input, args.marketplaceHit);
  if (!resourceUrl) return;
  const message = error instanceof Error ? error.message : String(error);
  const code = error instanceof VapiCallError ? error.code : "call_failed";
  await appendReceipt(
    {
      id: randomUUID(),
      timestamp: startedAt.toISOString(),
      resourceUrl,
      ...(args.input.method ? { method: args.input.method.toUpperCase() } : {}),
      payer: args.account.address,
      latencyMs: Math.max(0, Date.now() - startedAt.getTime()),
      error: { code, message },
    },
    args.receiptsPath,
  );
}

function receiptResourceUrl(
  input: CallToolInput,
  marketplaceHit: MarketplaceHit | undefined,
): string | undefined {
  if (input.url) return input.url;
  if (marketplaceHit?.kind === "api" && marketplaceHit.provenance === "indexed") {
    return marketplaceHit.execution.url;
  }
  return undefined;
}

function settlementTransaction(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const transaction = Reflect.get(value, "transaction");
  return typeof transaction === "string" && transaction ? transaction : undefined;
}

function expectedRequestFor(
  endpoint: ResolvedCallEndpoint | null,
  status: number,
): Pick<CallToolResult, "expectedRequest"> {
  if (status < 400 || !endpoint?.resolvedListing) {
    return {};
  }
  return {
    expectedRequest: {
      ...(endpoint.requestContentType === undefined
        ? {}
        : { contentType: endpoint.requestContentType }),
      ...(endpoint.requestSchema === undefined ? {} : { schema: endpoint.requestSchema }),
    },
  };
}

async function resolveCallEndpoint(
  id: string,
  endpointName: string | undefined,
  marketplaceHit: MarketplaceHit | undefined,
  config: VapiConfig,
  fetchImpl: typeof fetch,
): Promise<ResolvedCallEndpoint> {
  if (!marketplaceHit) {
    try {
      return {
        ...(await resolveServiceEndpoint(id, config, fetchImpl, endpointName)),
        registered: true,
        resolvedListing: true,
      };
    } catch (error) {
      if (!(error instanceof DiscoveryCatalogError) || error.code !== "service_not_found") {
        throw error;
      }
      const discovered = await findMarketplaceApiByRef(id, config, fetchImpl);
      if (!discovered) throw error;
      return await resolveCallEndpoint(id, endpointName, discovered, config, fetchImpl);
    }
  }
  if (marketplaceHit.ref !== id) {
    throw new Error("The supplied marketplace result does not match the requested call id.");
  }
  if (marketplaceHit.kind !== "api") {
    throw new Error(
      `vAPI only invokes API marketplace results; ${marketplaceHit.kind} is a web action.`,
    );
  }
  if (marketplaceHit.provenance === "indexed") {
    if (endpointName) {
      throw new Error("Direct external-catalog URLs do not expose named endpoint selectors.");
    }
    const publishedMethod = marketplaceHit.execution.method;
    return {
      url: marketplaceHit.execution.url,
      method: publishedMethod ?? "",
      registered: publishedMethod !== null,
      resolvedListing: false,
      requiresExplicitMethod: publishedMethod === null,
      payment: { network: marketplaceHit.execution.network },
    };
  }
  return {
    ...(await resolveServiceEndpoint(marketplaceHit.ref, config, fetchImpl, endpointName)),
    registered: true,
    resolvedListing: true,
  };
}

function assertRequiredRequestKeys(
  endpoint: ResolvedCallEndpoint | null,
  method: string,
  body: unknown,
): void {
  if (!endpoint?.resolvedListing || method === "GET" || method === "HEAD") {
    return;
  }
  const schema = endpoint.requestSchema;
  if (
    !isPlainObject(schema) ||
    schema.type !== "object" ||
    !Array.isArray(schema.required) ||
    schema.required.length === 0 ||
    !schema.required.every((key): key is string => typeof key === "string")
  ) {
    return;
  }
  const missing = isPlainObject(body)
    ? schema.required.filter((key) => !Object.hasOwn(body, key))
    : schema.required;
  if (missing.length === 0) {
    return;
  }
  const contentType = endpoint.requestContentType
    ? ` Expected request content type: ${endpoint.requestContentType}.`
    : "";
  throw new VapiCallError(
    "invalid_request",
    `Call request is missing required keys: ${missing.map((key) => JSON.stringify(key)).join(", ")}. Expected request schema: ${JSON.stringify(schema)}.${contentType}`,
  );
}

function normalizeCallMethod(value: string): MarketplaceExecutionMethod | null {
  const parsed = marketplaceExecutionMethodSchema.safeParse(value.trim().toUpperCase());
  return parsed.success ? parsed.data : null;
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function assertSecureCallUrl(url: URL, allowPrivateNetwork: boolean): void {
  if (url.protocol === "https:") return;
  if (
    url.protocol === "http:" &&
    allowPrivateNetwork &&
    isExplicitLocalDevelopmentHost(url.hostname)
  ) {
    return;
  }
  throw new Error(
    "vAPI calls require HTTPS; HTTP is allowed only for an explicitly enabled localhost development target.",
  );
}

function isExplicitLocalDevelopmentHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized === "[::1]" ||
    /^127(?:\.\d{1,3}){3}$/.test(normalized)
  );
}

function validateRequiredNetwork(
  network: string | undefined,
  configuredNetworks: VapiConfig["networks"],
): string | undefined {
  const normalized = normalizeRequiredNetwork(network);
  if (normalized === undefined) {
    return undefined;
  }
  if (!isNetworkConfigured(configuredNetworks, normalized)) {
    throw new Error(`Network ${normalized} is not configured with a nonblank RPC URL.`);
  }
  return normalized;
}

function normalizeRequiredNetwork(network: string | undefined): string | undefined {
  if (network === undefined) {
    return undefined;
  }
  const normalized = network.trim();
  try {
    parseEip155ChainId(normalized);
  } catch {
    throw new Error(`call network must be an eip155:<chainId> identifier; received ${network}.`);
  }
  return normalized;
}

function validateExpectedPayTo(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(normalized)) {
    throw new Error("call expectedPayTo must be a 20-byte 0x address.");
  }
  return normalized;
}

function serializeRequestBody(
  body: unknown,
  headers: Headers,
  method: string,
  url: URL,
  rawContentType?: string,
): string | undefined {
  if (body === undefined) {
    return undefined;
  }
  if (method === "GET" || method === "HEAD") {
    if (!isRecord(body)) {
      throw new Error(`${method} call input must be an object so it can be encoded as query data.`);
    }
    for (const [key, value] of Object.entries(body)) {
      if (value !== undefined && value !== null && String(value).length > 0) {
        url.searchParams.set(key, String(value));
      }
    }
    return undefined;
  }
  if (typeof body === "string") {
    if (rawContentType) {
      headers.set("content-type", validateContentType(rawContentType));
    }
    return body;
  }
  const contentType = rawContentType ? validateContentType(rawContentType) : "application/json";
  if (!isJsonContentType(contentType)) {
    throw new Error("Object call bodies require an application/json or +json content type.");
  }
  headers.set("content-type", contentType);
  return JSON.stringify(body);
}

function validateContentType(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 200 || /[\r\n]/.test(normalized)) {
    throw new Error("call contentType must be a valid media type of at most 200 characters.");
  }
  return normalized;
}

function isJsonContentType(value: string): boolean {
  const mediaType = value.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return mediaType === "application/json" || mediaType.endsWith("+json");
}

async function readResponseBody(response: Response): Promise<unknown> {
  const length = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`API response exceeds the ${MAX_RESPONSE_BYTES}-byte display limit.`);
  }
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    total += next.value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error(`API response exceeds the ${MAX_RESPONSE_BYTES}-byte display limit.`);
    }
    chunks.push(next.value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder().decode(bytes);
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

async function fetchAttempt(
  fetchImpl: typeof fetch,
  request: Request,
  timeoutMs: number,
): Promise<{
  response: Response;
  finish: () => void;
  waitFor<T>(operation: Promise<T>, response: Response): Promise<T>;
}> {
  const controller = new AbortController();
  let rejectTimeout: ((error: Error) => void) | null = null;
  const timeoutError = new Error(`API request timed out after ${timeoutMs}ms.`);
  const timedOut = new Promise<never>((_resolve, reject) => {
    rejectTimeout = reject;
  });
  const timeout = setTimeout(() => {
    controller.abort();
    rejectTimeout?.(timeoutError);
  }, timeoutMs);
  let finished = false;
  const finish = () => {
    if (finished) {
      return;
    }
    finished = true;
    clearTimeout(timeout);
  };
  try {
    const response = await Promise.race([
      fetchImpl(new Request(request, { signal: controller.signal })),
      timedOut,
    ]);
    return {
      response,
      finish,
      async waitFor<T>(operation: Promise<T>, operationResponse: Response): Promise<T> {
        try {
          return await Promise.race([operation, timedOut]);
        } catch (error) {
          if (error === timeoutError) {
            await operationResponse.body?.cancel().catch(() => undefined);
          }
          throw error;
        }
      },
    };
  } catch (error) {
    finish();
    throw error;
  }
}

function settlementUnknown(
  message: string,
  quote: Awaited<ReturnType<typeof parse402Response>>,
  authorization: {
    from: string;
    to: string;
    nonce: string;
    validBefore: string;
  },
  receipt: unknown | null,
  cause?: unknown,
): VapiCallError {
  return new VapiCallError(
    "settlement_unknown",
    message,
    {
      network: quote.accepted.network,
      asset: quote.accepted.asset,
      amountAtomic: quote.amountAtomic.toString(),
      payTo: authorization.to,
      payer: authorization.from,
      authorizationNonce: authorization.nonce,
      authorizationExpiresAt: authorization.validBefore,
      receipt,
    },
    cause === undefined ? undefined : { cause },
  );
}

function paymentRejected(httpStatus: number, receipt: unknown): VapiCallError {
  return new VapiCallError(
    "payment_rejected",
    `The paid endpoint reported that x402 settlement was rejected (HTTP ${httpStatus}).`,
    undefined,
    { paymentRejection: { httpStatus, receipt } },
  );
}

function responseUnreadableAfterSettlement(
  httpStatus: number,
  receipt: unknown,
  cause: unknown,
): VapiCallError {
  return new VapiCallError(
    "response_unreadable",
    "The paid response could not be read after settlement was confirmed. Do not retry the authorization automatically.",
    undefined,
    {
      cause,
      confirmedSettlement: { httpStatus, receipt },
    },
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}
