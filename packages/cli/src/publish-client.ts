/**
 * The registry's listing write API, as seen from one person's terminal.
 *
 * Everything else in this client reads the registry without an account. Listing
 * an API is the one thing that writes, so it is the one thing that carries a
 * bearer credential and a wallet signature. It lives in the CLI package rather
 * than in a source adapter because it is not discovery: there is no MCP tool,
 * and the only caller is the CLI.
 *
 * Every response is returned exactly as the registry sent it, so `--json` can
 * hand it on untouched and an unknown field is carried rather than dropped. The
 * readers below only look for what the human output needs.
 */

import { createPublicFetch, createSIWxMessage } from "@vapi-network/core";
import type { Address } from "viem";

/** The categories the registry's listing form accepts. */
export const LISTING_CATEGORIES = ["ai", "data", "crypto", "compute", "search"] as const;
export type ListingCategory = (typeof LISTING_CATEGORIES)[number];

/** How the registry should read the URL it was handed. Left out, it decides. */
export const PROBE_MODES = ["origin", "endpoint", "openapi"] as const;
export type ProbeMode = (typeof PROBE_MODES)[number];

/** The states `vapi publish` can ask a listing to move to. */
export type ListingStatusAction = "activate" | "request_verification" | "suspend";

/** Payouts settle in USDC on Base, so the payout signature is bound to Base. */
export const PAYOUT_CHAIN_ID = "eip155:8453" as const;

/**
 * The sentence the provider signs. It is not a login: it says which wallet the
 * registry should pay, and it is the only thing this command ever signs.
 */
export const PAYOUT_STATEMENT = "Confirm this wallet receives vAPI Call payouts";

/** The sentence a claim message states, completed with the origin being claimed. */
export const CLAIM_STATEMENT_PREFIX = "Claim the vAPI Call listings served from";

/** Where a person creates the key this client authenticates with. */
export const API_KEY_CONSOLE_PATH = "/account";

/** One candidate endpoint the probe found behind the URL it was given. */
export type ProbeOperation = Readonly<{
  name: string;
  method?: string;
  url?: string;
  description?: string;
  operationId?: string;
  requestContentType?: string;
  requestSchema?: unknown;
  responseContentType?: string;
  pathTemplate?: string;
  pathParameters?: unknown;
}> &
  Readonly<Record<string, unknown>>;

/** Why the registry will not list this URL, in the registry's own words. */
export type ProbeRejection = Readonly<{
  code?: string;
  message?: string;
  hint?: string;
}> &
  Readonly<Record<string, unknown>>;

/** The console's `VendorProbeResult`, read tolerantly. */
export type ProbeResult = Readonly<{
  operations?: readonly ProbeOperation[];
  accepts?: readonly unknown[];
  diagnostics?: Readonly<{
    steps?: readonly unknown[];
    rejection?: ProbeRejection | null;
  }>;
}> &
  Readonly<Record<string, unknown>>;

export type PayoutNonce = Readonly<{ nonce: string; message?: string }> &
  Readonly<Record<string, unknown>>;

export type SplitterNetworkState = Readonly<{
  network?: string;
  name?: string;
  chainId?: number;
  factoryAddress?: string;
  splitterAddress?: string;
  deployed?: boolean;
  balanceWei?: string;
}> &
  Readonly<Record<string, unknown>>;

export type SplitterStates = Readonly<{
  networkStates?: readonly SplitterNetworkState[];
  feeBp?: number;
}> &
  Readonly<Record<string, unknown>>;

export type ListingEndpointInput = {
  name: string;
  method: string;
  url: string;
  description: string;
  operationId?: string;
  requestContentType?: string;
  requestSchema?: unknown;
  responseContentType?: string;
  pathTemplate?: string;
  pathParameters?: unknown;
};

export type CreateListingInput = {
  name: string;
  description: string;
  category: ListingCategory;
  endpoints: ListingEndpointInput[];
  payoutWallet: string;
  siweMessage: string;
  signature: string;
};

export type CreatedListing = Readonly<{
  ok?: boolean;
  listing?: Readonly<{ slug?: string; status?: string; verification?: string }> &
    Readonly<Record<string, unknown>>;
}> &
  Readonly<Record<string, unknown>>;

export type ListingStatusResult = Readonly<{
  ok?: boolean;
  status?: string;
  verification?: string;
}> &
  Readonly<Record<string, unknown>>;

export type MyListings = Readonly<{ listings?: readonly unknown[] }> &
  Readonly<Record<string, unknown>>;

export type ClaimNonce = Readonly<{ message?: string }> & Readonly<Record<string, unknown>>;

export type ClaimInput = { origin: string; message: string; signature: string };

export type ClaimResult = Readonly<{ claimed?: readonly unknown[] }> &
  Readonly<Record<string, unknown>>;

/**
 * A refusal from the registry, already turned into the sentence a person
 * should read. The status is kept so a caller can tell a rejection from an
 * outage without parsing the message.
 */
export class RegistryApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = "RegistryApiError";
  }
}

export type ListingsClientOptions = {
  /** The registry base URL, with any mount prefix it carries. */
  baseUrl: string;
  /** The `vapi_sk_…` key, sent as a bearer token and never logged. */
  apiKey?: string;
  /** A caller that adds and refreshes its own bearer credential. */
  authenticatedFetch?: typeof fetch;
  fetchImpl?: typeof fetch;
  allowPrivateNetwork?: boolean;
};

export type ListingsClient = {
  readonly baseUrl: string;
  probe(input: { url: string; method?: string; mode?: ProbeMode }): Promise<ProbeResult>;
  payoutNonce(wallet: string): Promise<PayoutNonce>;
  splitters(wallet: string): Promise<SplitterStates>;
  create(input: CreateListingInput): Promise<CreatedListing>;
  status(slug: string, action: ListingStatusAction): Promise<ListingStatusResult>;
  mine(): Promise<MyListings>;
  claimNonce(origin: string, wallet: string): Promise<ClaimNonce>;
  claim(input: ClaimInput): Promise<ClaimResult>;
};

/** Appends one absolute path to the registry base, keeping any mount prefix. */
export function listingsUrl(baseUrl: string, path: string): URL {
  const url = new URL(baseUrl);
  url.search = "";
  url.hash = "";
  const prefix = url.pathname === "/" ? "" : url.pathname.replace(/\/+$/, "");
  url.pathname = `${prefix}${path}`;
  return url;
}

export function createListingsClient(options: ListingsClientOptions): ListingsClient {
  if (options.apiKey === undefined && options.authenticatedFetch === undefined) {
    throw new Error("The listings client needs an API key or authenticated fetch.");
  }
  const request =
    options.authenticatedFetch ??
    options.fetchImpl ??
    createPublicFetch({ allowPrivateNetwork: options.allowPrivateNetwork ?? false });

  async function call(
    path: string,
    init: { method: "GET" | "POST"; body?: unknown; query?: Record<string, string> },
  ): Promise<unknown> {
    const url = listingsUrl(options.baseUrl, path);
    for (const [name, value] of Object.entries(init.query ?? {})) {
      url.searchParams.set(name, value);
    }
    const response = await request(url, {
      method: init.method,
      headers: {
        accept: "application/json",
        ...(options.apiKey === undefined ? {} : { authorization: `Bearer ${options.apiKey}` }),
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
    if (!response.ok) throw await registryError(response, options.baseUrl);
    return await readJson(response);
  }

  return {
    baseUrl: options.baseUrl,
    async probe(input) {
      return (await call("/api/call/listings/probe", {
        method: "POST",
        body: {
          url: input.url,
          ...(input.method === undefined ? {} : { method: input.method }),
          ...(input.mode === undefined ? {} : { mode: input.mode }),
        },
      })) as ProbeResult;
    },
    async payoutNonce(wallet) {
      return (await call("/api/call/listings/payout-nonce", {
        method: "GET",
        query: { wallet },
      })) as PayoutNonce;
    },
    async splitters(wallet) {
      return (await call("/api/call/listings/splitters", {
        method: "GET",
        query: { wallet },
      })) as SplitterStates;
    },
    async create(input) {
      return (await call("/api/call/listings", { method: "POST", body: input })) as CreatedListing;
    },
    async status(slug, action) {
      return (await call(`/api/call/listings/${encodeURIComponent(slug)}/status`, {
        method: "POST",
        body: { action },
      })) as ListingStatusResult;
    },
    async mine() {
      return (await call("/api/call/listings/mine", { method: "GET" })) as MyListings;
    },
    async claimNonce(origin, wallet) {
      return (await call("/api/call/listings/claim-nonce", {
        method: "GET",
        query: { origin, wallet },
      })) as ClaimNonce;
    },
    async claim(input) {
      try {
        return (await call("/api/call/listings/claim", {
          method: "POST",
          body: input,
        })) as ClaimResult;
      } catch (error) {
        throw claimRefusal(error, input.origin);
      }
    },
  };
}

/** The three refusals a claim can meet, each as the sentence that explains it. */
function claimRefusal(error: unknown, origin: string): unknown {
  if (!(error instanceof RegistryApiError)) return error;
  const sentences: Partial<Record<number, string>> = {
    403: `This wallet is not the payee of the listings served from ${origin}. Sign with the wallet their payments go to: vapi claim ${origin} --wallet <name>.`,
    404: `vAPI has no unclaimed listing served from ${origin}. To list it yourself, run vapi publish ${origin}.`,
    409: `The listings served from ${origin} already have an owner. vapi publish list shows the ones this key owns.`,
  };
  const sentence = sentences[error.status];
  return sentence === undefined ? error : new RegistryApiError(error.status, sentence, error.body);
}

/**
 * Refuses to sign a claim message that is not the one the claim contract
 * describes: an EIP-4361 message from this registry's host, for this wallet,
 * on Base, stating the origin being claimed. The registry writes the message,
 * so this is the line that keeps a wallet from signing anything else it sends.
 */
export function assertClaimMessage(
  message: string,
  expected: { baseUrl: string; origin: string; address: Address },
): void {
  const lines = message.split("\n").map((line) => line.trim());
  const host = new URL(expected.baseUrl).host;
  const bound =
    lines[0] === `${host} wants you to sign in with your Ethereum account:` &&
    lines[1]?.toLowerCase() === expected.address.toLowerCase() &&
    lines.includes(`${CLAIM_STATEMENT_PREFIX} ${expected.origin}`) &&
    lines.includes(`Chain ID: ${PAYOUT_CHAIN_ID.slice("eip155:".length)}`);
  if (!bound) {
    throw new Error(
      `vAPI sent a claim message that is not bound to ${host}, this wallet, Base and ${expected.origin}, so nothing was signed.`,
    );
  }
}

/**
 * The canonical EIP-4361 message a provider signs to name their payout wallet.
 * The registry may send its own `message`, in which case that one is signed
 * verbatim; this is what the client builds when it does not, so the two sides
 * agree byte for byte.
 */
export function buildPayoutSiweMessage(args: {
  baseUrl: string;
  address: Address;
  nonce: string;
  issuedAt: string;
}): string {
  const registry = new URL(args.baseUrl);
  return createSIWxMessage(
    {
      info: {
        domain: registry.host,
        uri: registry.origin,
        statement: PAYOUT_STATEMENT,
        version: "1",
        nonce: args.nonce,
        issuedAt: args.issuedAt,
      },
      chain: { chainId: PAYOUT_CHAIN_ID, type: "eip191" },
    },
    args.address,
  );
}

/** The operations a probe found, normalized to the fields a listing needs. */
export function readProbeOperations(probe: ProbeResult): ProbeOperation[] {
  const operations = probe.operations;
  if (!Array.isArray(operations)) return [];
  return operations.filter((operation): operation is ProbeOperation => {
    return isRecord(operation) && typeof operation.name === "string" && operation.name.length > 0;
  });
}

/** The rejection a probe carries, or undefined when the URL passed. */
export function readProbeRejection(probe: ProbeResult): ProbeRejection | undefined {
  const rejection = probe.diagnostics?.rejection;
  return isRecord(rejection) ? (rejection as ProbeRejection) : undefined;
}

/** One line per probe step, whatever shape the registry sends them in. */
export function formatProbeSteps(probe: ProbeResult): string[] {
  const steps = probe.diagnostics?.steps;
  if (!Array.isArray(steps)) return [];
  return steps.map((step) => `  ${formatProbeStep(step)}`);
}

function formatProbeStep(step: unknown): string {
  if (typeof step === "string") return step;
  if (!isRecord(step)) return JSON.stringify(step);
  const label = asString(step.name) ?? asString(step.step) ?? asString(step.label) ?? "step";
  const outcome =
    asString(step.status) ??
    asString(step.outcome) ??
    asString(step.result) ??
    (typeof step.ok === "boolean" ? (step.ok ? "ok" : "failed") : undefined);
  const detail = asString(step.detail) ?? asString(step.message) ?? asString(step.description);
  return [label, outcome, detail].filter(Boolean).join(" — ");
}

/** Turns a failed response into the one sentence a person can act on. */
async function registryError(response: Response, baseUrl: string): Promise<RegistryApiError> {
  const body = await readJson(response).catch(() => undefined);
  const detail = readErrorMessage(body);
  if (response.status === 401) {
    return new RegistryApiError(
      401,
      [
        "The vAPI API key was rejected.",
        detail,
        `Create a key in the console at ${listingsUrl(baseUrl, API_KEY_CONSOLE_PATH).href} and store it with vapi auth set-key.`,
      ]
        .filter(Boolean)
        .join(" "),
      body,
    );
  }
  if (response.status === 409) {
    return new RegistryApiError(409, detail ?? "vAPI refused this listing (HTTP 409).", body);
  }
  if (response.status === 422) {
    const issues = readErrorIssues(body);
    return new RegistryApiError(
      422,
      [
        `vAPI rejected the listing as invalid.${detail === undefined ? "" : ` ${detail}`}`,
        ...issues.map((issue) => `  ${issue}`),
      ].join("\n"),
      body,
    );
  }
  if (response.status === 429) {
    const retryAfter = response.headers.get("retry-after");
    return new RegistryApiError(
      429,
      [
        "vAPI rate-limited this request.",
        retryAfter ? `Try again in ${retryAfter} seconds.` : "Try again shortly.",
        detail,
      ]
        .filter(Boolean)
        .join(" "),
      body,
    );
  }
  return new RegistryApiError(
    response.status,
    [
      `vAPI listings API returned HTTP ${response.status}${
        response.statusText ? ` ${response.statusText}` : ""
      }.`,
      detail,
    ]
      .filter(Boolean)
      .join(" "),
    body,
  );
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.trim().length === 0) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function readErrorMessage(body: unknown): string | undefined {
  if (typeof body === "string") return body.trim() || undefined;
  if (!isRecord(body)) return undefined;
  const error = body.error;
  if (isRecord(error)) return asString(error.message) ?? asString(error.code);
  return asString(body.message) ?? asString(body.error) ?? asString(body.detail);
}

function readErrorIssues(body: unknown): string[] {
  if (!isRecord(body)) return [];
  const candidates = [body.issues, body.errors, body.details];
  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) continue;
    const issues = candidate.map((issue) => {
      if (typeof issue === "string") return issue;
      if (!isRecord(issue)) return JSON.stringify(issue);
      const path = Array.isArray(issue.path) ? issue.path.join(".") : asString(issue.path);
      const message = asString(issue.message) ?? asString(issue.code) ?? JSON.stringify(issue);
      return path ? `${path}: ${message}` : message;
    });
    if (issues.length > 0) return issues;
  }
  return [];
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
