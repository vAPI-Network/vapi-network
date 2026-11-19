import type { Address } from "viem";
import {
  createPublicFetch,
  getVapiPaths,
  KeystoreError,
  resolveRegistryUrl,
  type VapiConfig,
} from "@vapi-network/core";
import { API_KEY_ENV, resolveApiKey } from "@vapi-network/core/api-key";
import { agentFetch } from "@vapi-network/core/agent-link";

import {
  isHttpUrl,
  parseArguments,
  requiredPositional,
  requireNoArguments,
  RESUME_OPTION,
  UsageError,
  WALLET_OPTION,
} from "./args.js";
import {
  type CliDependencies,
  type CliIo,
  getLinePrompt,
  isInteractive,
  output,
  readConfig,
} from "./cli-context.js";
import {
  apiKeyConsoleUrl,
  assertClaimMessage,
  buildPayoutSiweMessage,
  type CreatedListing,
  createListingsClient,
  formatProbeSteps,
  LISTING_CATEGORIES,
  type ListingCategory,
  type ListingEndpointInput,
  type ListingsClient,
  type ListingStatusAction,
  type MyListings,
  PROBE_MODES,
  type ProbeMode,
  type ProbeOperation,
  type ProbeRejection,
  type ProbeResult,
  readProbeOperations,
  readProbeRejection,
  RegistryApiError,
} from "./publish-client.js";
import {
  getSecretStore,
  outputForWallet,
  recordAudit,
  targetWallet,
  unlockTarget,
  walletHeader,
  type WalletTarget,
} from "./wallet-session.js";

const YES_OPTION = "--yes";

const PUBLISH_USAGE =
  "Usage: vapi publish <url> [--method <method>] [--mode <origin|endpoint|openapi>] [--name <text>] [--description <text>] [--category <ai|data|crypto|compute|search>] [--select <names>] [--account <name>] [--yes] [--resume]";

const PUBLISH_NEEDS_TERMINAL =
  "vapi publish needs a terminal to choose endpoints. Name them with --select <name,name>, or pass --yes to list every endpoint the probe found.";

/**
 * The provider side of the registry. `vapi publish <url>` probes, lets the
 * person choose, signs one payout line with the local wallet and creates the
 * listing; the three subcommands move it afterwards. Returns the exit code
 * itself, because a probe the registry refuses is a `2` with the registry's
 * own words rather than a thrown error.
 */
export async function publishCommand(
  argv: string[],
  json: boolean,
  io: CliIo,
  dependencies: CliDependencies,
): Promise<number> {
  const subcommand = argv[0];
  if (subcommand === "activate") {
    await publishStatusCommand(
      argv.slice(1),
      "activate",
      "vapi publish activate <slug>",
      json,
      io,
      dependencies,
    );
    return 0;
  }
  if (subcommand === "verify-request") {
    await publishStatusCommand(
      argv.slice(1),
      "request_verification",
      "vapi publish verify-request <slug>",
      json,
      io,
      dependencies,
    );
    return 0;
  }
  if (subcommand === "list") {
    await publishListCommand(argv.slice(1), json, io, dependencies);
    return 0;
  }
  return await publishListingCommand(argv, json, io, dependencies);
}

async function publishListingCommand(
  argv: string[],
  json: boolean,
  io: CliIo,
  dependencies: CliDependencies,
): Promise<number> {
  const parsed = parseArguments(argv, {
    valueOptions: new Set([
      "--method",
      "--mode",
      "--name",
      "--description",
      "--category",
      "--select",
      WALLET_OPTION,
    ]),
    booleanOptions: new Set([YES_OPTION, RESUME_OPTION]),
    maximumPositionals: 1,
  });
  const url = requiredPositional(parsed.positionals[0], "<url>", PUBLISH_USAGE);
  if (!isHttpUrl(url)) {
    throw new UsageError(
      "vapi publish takes the http(s) URL of the API you own: its origin, one endpoint, or an OpenAPI document.",
    );
  }
  const method = parsed.one("--method");
  const mode = parseProbeMode(parsed.one("--mode"));
  const { client, baseUrl } = await listingsClient(io, dependencies, parsed);

  const probe = await client.probe({
    url,
    ...(method === undefined ? {} : { method }),
    ...(mode === undefined ? {} : { mode }),
  });
  const steps = formatProbeSteps(probe);
  if (!json) {
    io.stdout(`Probe: ${url}`);
    for (const line of steps) io.stdout(line);
  }
  const rejection = readProbeRejection(probe);
  if (rejection) {
    if (json) {
      io.stdout(JSON.stringify({ probe }));
      return 2;
    }
    io.stderr(formatProbeRejection(rejection));
    return 2;
  }

  const operations = readProbeOperations(probe);
  if (operations.length === 0) {
    throw new Error(
      `The probe found no callable endpoint behind ${url}. Point vapi publish at one endpoint, or at an OpenAPI document that describes them.`,
    );
  }
  const interactive = !json && isInteractive(dependencies);
  const selected = await selectOperations(operations, {
    select: parsed.one("--select"),
    all: parsed.has(YES_OPTION),
    interactive,
    io,
    dependencies,
  });
  const asking = interactive && !parsed.has(YES_OPTION);
  const name = await publishField(parsed.one("--name") ?? probeString(probe, ["name", "title"]), {
    asking,
    prompt: "Listing name: ",
    missing: "vapi publish needs a name for the listing: --name <text>.",
    dependencies,
  });
  const description = await publishField(
    parsed.one("--description") ?? probeString(probe, ["description", "summary"]),
    {
      asking,
      prompt: "One-line description: ",
      missing: "vapi publish needs a description: --description <text>.",
      dependencies,
    },
  );
  const category = parseCategory(
    await publishField(parsed.one("--category") ?? probeCategory(probe), {
      asking,
      prompt: `Category (${LISTING_CATEGORIES.join(", ")}): `,
      missing: `vapi publish needs a category: --category <${LISTING_CATEGORIES.join("|")}>.`,
      dependencies,
    }),
  );

  const batches = publishBatches(
    selected.map((operation) => toListingEndpoint(operation, description)),
    name,
  );
  // --resume trusts the registry's own record of what this key already lists,
  // so a run that stopped halfway, for whatever reason, picks up exactly there.
  const listed = parsed.has(RESUME_OPTION)
    ? listedEndpointSlugs(await client.mine())
    : new Map<string, string>();
  const results: PublishedEndpoint[] = [];
  const pending = batches.map((batch) => ({
    name: batch.name,
    endpoints: batch.endpoints.filter((endpoint) => {
      const slug = listed.get(endpointKey(endpoint));
      if (slug !== undefined) results.push(endpointResult(endpoint, "skipped", { slug }));
      return slug === undefined;
    }),
  }));
  const say = (line: string) => {
    if (!json) io.stdout(line);
  };
  if (!json) io.stdout("");
  for (const result of results) say(formatPublishedEndpoint(result));
  if (pending.every((batch) => batch.endpoints.length === 0)) {
    const message = "Every selected endpoint is already listed by this key; nothing was signed.";
    if (json) io.stdout(JSON.stringify({ probe, listings: [], results, message }));
    else io.stdout(message);
    return 0;
  }

  const wallet = await targetWallet(parsed, dependencies);
  const { account } = await unlockTarget(wallet, dependencies);
  const payoutWallet = requireEvmAddress(account.address, wallet.name);
  say(walletHeader(wallet));
  if (batches.length > 1) {
    say(
      `Publishing ${selected.length} endpoints as ${batches.length} listings of up to ${PUBLISH_BATCH_SIZE} each.`,
    );
  }

  // One listing per batch, each with its own nonce and its own signature of
  // the same payout line. A batch the registry refuses on its merits does not
  // stop the next one; a refusal that would repeat (a bad key, a rate limit)
  // or an outage does, and --resume picks up from there.
  const created: CreatedListing[] = [];
  const failures: Error[] = [];
  let stopped = false;
  for (const batch of pending) {
    if (batch.endpoints.length === 0) continue;
    if (stopped) {
      for (const endpoint of batch.endpoints) {
        const result = endpointResult(endpoint, "not_attempted");
        results.push(result);
        say(formatPublishedEndpoint(result));
      }
      continue;
    }
    let listing: CreatedListing;
    try {
      const nonce = await client.payoutNonce(payoutWallet);
      const siweMessage = payoutSiweMessage(nonce, baseUrl, payoutWallet, dependencies);
      const signature = await account.signMessage({ message: siweMessage });
      listing = await client.create({
        name: batch.name,
        description,
        category,
        endpoints: batch.endpoints,
        payoutWallet,
        siweMessage,
        signature,
      });
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      failures.push(failure);
      stopped = !refusedOnItsMerits(failure);
      for (const endpoint of batch.endpoints) {
        const result = endpointResult(endpoint, "failed", { error: failure.message });
        results.push(result);
        say(formatPublishedEndpoint(result));
      }
      continue;
    }
    created.push(listing);
    const slug = listingSlug(listing);
    await recordAudit(dependencies, "listing.publish", {
      wallet: wallet.name,
      detail: slug ?? url,
    });
    for (const endpoint of batch.endpoints) {
      const result = endpointResult(endpoint, "listed", slug === undefined ? {} : { slug });
      results.push(result);
      say(formatPublishedEndpoint(result));
    }
    say(formatCreatedListing(listing, batch.name, payoutWallet, batch.endpoints.length));
  }

  const failed = failures.length > 0;
  const resumeHint = `Run the same vapi publish command with ${RESUME_OPTION} to list the rest; it skips what is already listed.`;

  if (json) {
    io.stdout(
      JSON.stringify({
        wallet: wallet.name,
        probe,
        listings: created,
        results,
        ...(failed
          ? {
              error: [...new Set(failures.map((failure) => failure.message))].join("\n"),
              exitCode: 1,
            }
          : {}),
      }),
    );
    return failed ? 1 : 0;
  }
  if (created.length > 0) {
    for (const line of formatDescriptionWarnings(created[0]!)) io.stdout(line);
    io.stdout("vAPI Call takes no fee. Providers are paid directly.");
    io.stdout(`Set each endpoint's payTo to your payout wallet ${payoutWallet}, then run:`);
    for (const listing of created) {
      io.stdout(`  vapi publish activate ${listingSlug(listing) ?? "<slug>"}`);
    }
  }
  if (!failed) return 0;
  for (const message of new Set(failures.map((failure) => failure.message))) io.stderr(message);
  if (batches.length > 1 || created.length > 0) io.stderr(resumeHint);
  return 1;
}

/** The registry's cap on endpoints per listing; a larger catalog becomes several. */
const PUBLISH_BATCH_SIZE = 20;
/** The registry's cap on a listing name. */
const LISTING_NAME_MAX_LENGTH = 100;

type ListingBatch = { name: string; endpoints: ListingEndpointInput[] };

/**
 * Splits the chosen endpoints, in probe order, into listings of at most
 * {@link PUBLISH_BATCH_SIZE}. A catalog that fits keeps its name; a larger one
 * is numbered `Name (2/4)`. The split depends only on the selection, so a
 * resumed run numbers every batch the way the first run did.
 */
function publishBatches(endpoints: readonly ListingEndpointInput[], name: string): ListingBatch[] {
  const count = Math.ceil(endpoints.length / PUBLISH_BATCH_SIZE);
  return Array.from({ length: count }, (_, index) => {
    const suffix = count === 1 ? "" : ` (${index + 1}/${count})`;
    return {
      name: `${name.slice(0, LISTING_NAME_MAX_LENGTH - suffix.length).trimEnd()}${suffix}`,
      endpoints: endpoints.slice(index * PUBLISH_BATCH_SIZE, (index + 1) * PUBLISH_BATCH_SIZE),
    };
  });
}

/** One endpoint by what makes it callable: its method and its URL. */
function endpointKey(endpoint: { method?: unknown; url?: unknown }): string {
  const method = typeof endpoint.method === "string" ? endpoint.method.toUpperCase() : "GET";
  const url = typeof endpoint.url === "string" ? endpoint.url : "";
  try {
    return `${method} ${new URL(url).href}`;
  } catch {
    return `${method} ${url}`;
  }
}

/** Every endpoint this key already lists, mapped to the slug that lists it. */
function listedEndpointSlugs(mine: MyListings): Map<string, string> {
  const listed = new Map<string, string>();
  for (const listing of Array.isArray(mine.listings) ? mine.listings : []) {
    if (typeof listing !== "object" || listing === null) continue;
    const { slug, endpoints } = listing as { slug?: unknown; endpoints?: unknown };
    if (typeof slug !== "string" || !Array.isArray(endpoints)) continue;
    for (const endpoint of endpoints) {
      if (typeof endpoint === "object" && endpoint !== null) {
        listed.set(endpointKey(endpoint as Record<string, unknown>), slug);
      }
    }
  }
  return listed;
}

/**
 * A refusal of this batch alone — a 4xx about its content — rather than one
 * every later batch would meet too: a rejected key, a rate limit, an outage.
 */
function refusedOnItsMerits(error: Error): boolean {
  return (
    error instanceof RegistryApiError &&
    error.status >= 400 &&
    error.status < 500 &&
    error.status !== 401 &&
    error.status !== 429
  );
}

type PublishedEndpoint = {
  name: string;
  method: string;
  url: string;
  result: "listed" | "skipped" | "failed" | "not_attempted";
  slug?: string;
  error?: string;
};

function endpointResult(
  endpoint: ListingEndpointInput,
  result: PublishedEndpoint["result"],
  detail: { slug?: string; error?: string } = {},
): PublishedEndpoint {
  return { name: endpoint.name, method: endpoint.method, url: endpoint.url, result, ...detail };
}

function formatPublishedEndpoint(endpoint: PublishedEndpoint): string {
  const detail =
    endpoint.result === "listed"
      ? (endpoint.slug ?? "")
      : endpoint.result === "skipped"
        ? `already listed as ${endpoint.slug ?? "?"}`
        : endpoint.result === "failed"
          ? (endpoint.error?.split("\n")[0] ?? "")
          : "not attempted";
  const label = endpoint.result === "not_attempted" ? "pending" : endpoint.result;
  return `  ${label.padEnd(7)} ${endpoint.name}\t${endpoint.method} ${endpoint.url}\t${detail}`;
}

/** Moves one listing through the registry's states: live, or up for review. */
async function publishStatusCommand(
  argv: string[],
  action: ListingStatusAction,
  usage: string,
  json: boolean,
  io: CliIo,
  dependencies: CliDependencies,
): Promise<void> {
  const parsed = parseArguments(argv, { valueOptions: new Set(), maximumPositionals: 1 });
  const slug = requiredPositional(parsed.positionals[0], "<slug>", `Usage: ${usage}`);
  const { client } = await listingsClient(io, dependencies);
  const result = await client.status(slug, action);
  await recordAudit(dependencies, "listing.status", { detail: `${slug} ${action}` });
  output(io, json, result, formatListingStatus(slug, action, result));
}

/** Every listing this key owns, whatever state it is in. */
async function publishListCommand(
  argv: string[],
  json: boolean,
  io: CliIo,
  dependencies: CliDependencies,
): Promise<void> {
  requireNoArguments(argv, "publish list");
  const { client } = await listingsClient(io, dependencies);
  const result = await client.mine();
  output(io, json, result, formatMyListings(result));
}

/**
 * The registry write API, ready to call: the base URL this install already
 * talks to, plus an API key or linked agent bearer. Credential failures and an
 * unreadable config happen here, before anything is probed or signed.
 */
async function listingsClient(
  io: CliIo,
  dependencies: CliDependencies,
  selection: { one(name: string): string | undefined } = { one: () => undefined },
): Promise<{ client: ListingsClient; baseUrl: string }> {
  const paths = getVapiPaths();
  const config = await readConfig(paths.config, io);
  const baseUrl = registryBaseUrl(config);
  // The variable belongs to the process, like VAPI_KEYSTORE_PASSWORD; the
  // injected environment models wallet selection and agent markers.
  const resolved = await resolveApiKey({
    env: process.env,
    store: getSecretStore(dependencies),
    configPath: paths.config,
  });
  if (resolved !== undefined) {
    return {
      baseUrl,
      client: createListingsClient({
        baseUrl,
        apiKey: resolved.key,
        allowPrivateNetwork: config.allowPrivateNetwork ?? false,
        ...(dependencies.fetchImpl ? { fetchImpl: dependencies.fetchImpl } : {}),
      }),
    };
  }

  let target: WalletTarget;
  try {
    target = await targetWallet(selection, dependencies);
  } catch (error) {
    if (error instanceof KeystoreError) throw new Error(noApiKeyMessage(baseUrl));
    throw error;
  }
  const link = target.entry.link;
  if (
    link === undefined ||
    !link.scopes.includes("call.publish") ||
    !sameOrigin(link.apiBase, baseUrl)
  ) {
    throw new Error(noApiKeyMessage(baseUrl));
  }
  const guardedFetch =
    dependencies.fetchImpl ??
    createPublicFetch({ allowPrivateNetwork: config.allowPrivateNetwork ?? false });
  const authenticatedFetch: typeof fetch = async (input, init) =>
    await agentFetch(
      {
        secrets: getSecretStore(dependencies),
        wallets: target.store,
        wallet: target.name,
        fetchImpl: guardedFetch,
      },
      requestUrl(input),
      init,
    );
  return {
    baseUrl,
    client: createListingsClient({
      baseUrl,
      authenticatedFetch,
      allowPrivateNetwork: config.allowPrivateNetwork ?? false,
    }),
  };
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}

function sameOrigin(left: string, right: string): boolean {
  try {
    return new URL(left).origin === new URL(right).origin;
  } catch {
    return false;
  }
}

export function noApiKeyMessage(baseUrl: string): string {
  return [
    "No vAPI API key on this machine.",
    `Create one in the console at ${apiKeyConsoleUrl(baseUrl).href}, then store it with vapi auth set-key.`,
    `In CI, set ${API_KEY_ENV} instead.`,
  ].join("\n");
}

const DISCOVERY_PATH = "/api/call/discovery";

/**
 * The registry behind the configured discovery URLs. `VAPI_REGISTRY_URL` has
 * already moved those by the time the config is loaded, so deriving the base
 * from them follows the env override, a self-hosted registry and a mount
 * prefix alike. A hand-edited discovery URL falls back to the shipped default.
 */
export function registryBaseUrl(config: VapiConfig): string {
  try {
    const url = new URL(config.marketplaceDiscoveryUrl);
    const path = url.pathname.replace(/\/+$/, "");
    if (!path.endsWith(DISCOVERY_PATH)) return resolveRegistryUrl();
    url.search = "";
    url.hash = "";
    url.pathname = path.slice(0, path.length - DISCOVERY_PATH.length) || "/";
    return url.href;
  } catch {
    return resolveRegistryUrl();
  }
}

/** Which endpoints of the probed API this listing offers. */
async function selectOperations(
  operations: readonly ProbeOperation[],
  args: {
    select: string | undefined;
    all: boolean;
    interactive: boolean;
    io: CliIo;
    dependencies: CliDependencies;
  },
): Promise<ProbeOperation[]> {
  if (args.select !== undefined) return pickOperations(operations, args.select);
  if (args.all) return [...operations];
  if (!args.interactive) throw new UsageError(PUBLISH_NEEDS_TERMINAL);
  args.io.stdout("");
  args.io.stdout("Endpoints found:");
  for (const [index, operation] of operations.entries()) {
    args.io.stdout(formatOperation(index + 1, operation));
  }
  const answer = await getLinePrompt(args.dependencies)(
    "Endpoints to list (numbers or names, comma separated; blank for all): ",
  );
  return answer.trim().length === 0 ? [...operations] : pickOperations(operations, answer);
}

function pickOperations(
  operations: readonly ProbeOperation[],
  selection: string,
): ProbeOperation[] {
  const wanted = selection
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  if (wanted.length === 0) throw new UsageError("--select needs at least one endpoint name.");
  const picked: ProbeOperation[] = [];
  for (const value of wanted) {
    const byIndex = /^\d+$/.test(value) ? operations[Number(value) - 1] : undefined;
    const match =
      byIndex ??
      operations.find((operation) => operation.name.toLowerCase() === value.toLowerCase());
    if (match === undefined) {
      throw new UsageError(
        `No endpoint named ${JSON.stringify(value)}. The probe found ${operations
          .map((operation) => operation.name)
          .join(", ")}.`,
      );
    }
    if (!picked.includes(match)) picked.push(match);
  }
  return picked;
}

/** A field the listing needs: the option, what the probe knew, or a question. */
async function publishField(
  supplied: string | undefined,
  args: { asking: boolean; prompt: string; missing: string; dependencies: CliDependencies },
): Promise<string> {
  const value = supplied?.trim();
  if (value) return value;
  if (!args.asking) throw new UsageError(args.missing);
  const typed = (await getLinePrompt(args.dependencies)(args.prompt)).trim();
  if (typed.length === 0) throw new UsageError(args.missing);
  return typed;
}

function parseCategory(value: string): ListingCategory {
  const normalized = value.trim().toLowerCase();
  if ((LISTING_CATEGORIES as readonly string[]).includes(normalized)) {
    return normalized as ListingCategory;
  }
  throw new UsageError(`--category must be one of ${LISTING_CATEGORIES.join(", ")}.`);
}

function parseProbeMode(value: string | undefined): ProbeMode | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if ((PROBE_MODES as readonly string[]).includes(normalized)) return normalized as ProbeMode;
  throw new UsageError(`--mode must be one of ${PROBE_MODES.join(", ")}.`);
}

/** Payouts are an EVM transfer, so a wallet without an EVM key cannot receive them. */
function requireEvmAddress(
  address: string | undefined,
  wallet: string,
  retry = "vapi publish <url> --account <name>",
): Address {
  if (address === undefined || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
    throw new Error(
      `Wallet ${wallet} has no EVM account, so it cannot receive vAPI Call payouts. Use a wallet that has one: ${retry}.`,
    );
  }
  return address as Address;
}

/**
 * The line the wallet signs. The registry may send its own message, which is
 * then signed verbatim; otherwise the client builds the canonical EIP-4361
 * message so both sides agree byte for byte.
 */
function payoutSiweMessage(
  nonce: { nonce?: unknown; message?: unknown },
  baseUrl: string,
  address: Address,
  dependencies: CliDependencies,
): string {
  const supplied = typeof nonce.message === "string" ? nonce.message.trim() : "";
  if (supplied.length > 0) return supplied;
  const value = typeof nonce.nonce === "string" ? nonce.nonce.trim() : "";
  if (value.length === 0) {
    throw new Error("The registry returned no payout nonce, so there is nothing to sign.");
  }
  return buildPayoutSiweMessage({
    baseUrl,
    address,
    nonce: value,
    issuedAt: (dependencies.now?.() ?? new Date()).toISOString(),
  });
}

function toListingEndpoint(
  operation: ProbeOperation,
  fallbackDescription: string,
): ListingEndpointInput {
  const url = typeof operation.url === "string" ? operation.url.trim() : "";
  if (!isHttpUrl(url)) {
    throw new Error(
      `The probe returned no callable URL for endpoint ${operation.name}, so it cannot be listed.`,
    );
  }
  const method = typeof operation.method === "string" ? operation.method.trim() : "";
  const description = typeof operation.description === "string" ? operation.description.trim() : "";
  return {
    name: operation.name,
    method: (method || "GET").toUpperCase(),
    url,
    description: description || fallbackDescription,
    ...optionalStringField(operation, "operationId"),
    ...optionalStringField(operation, "requestContentType"),
    ...(operation.requestSchema === undefined ? {} : { requestSchema: operation.requestSchema }),
    ...optionalStringField(operation, "responseContentType"),
    ...optionalStringField(operation, "pathTemplate"),
    ...(operation.pathParameters === undefined ? {} : { pathParameters: operation.pathParameters }),
    ...optionalStringField(operation, "metadataEvidence"),
  };
}

function optionalStringField<Key extends keyof ListingEndpointInput>(
  operation: ProbeOperation,
  key: Key,
): Partial<Record<Key, string>> {
  const value = operation[key as string];
  return typeof value === "string" && value.trim().length > 0
    ? ({ [key]: value.trim() } as Partial<Record<Key, string>>)
    : {};
}

function probeString(probe: ProbeResult, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = probe[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

/** A category the probe guessed, used only when it is one the registry accepts. */
function probeCategory(probe: ProbeResult): string | undefined {
  const value = probeString(probe, ["category"])?.toLowerCase();
  return value !== undefined && (LISTING_CATEGORIES as readonly string[]).includes(value)
    ? value
    : undefined;
}

function listingSlug(created: CreatedListing): string | undefined {
  const slug = created.listing?.slug;
  return typeof slug === "string" && slug.trim().length > 0 ? slug.trim() : undefined;
}

function formatProbeRejection(rejection: ProbeRejection): string {
  const code = typeof rejection.code === "string" ? rejection.code : "rejected";
  return [
    `Probe rejected: ${code}`,
    ...(typeof rejection.message === "string" ? [rejection.message] : []),
    ...(typeof rejection.hint === "string" ? [`Hint: ${rejection.hint}`] : []),
  ].join("\n");
}

function formatOperation(index: number, operation: ProbeOperation): string {
  const method = typeof operation.method === "string" ? operation.method.toUpperCase() : "GET";
  const url = typeof operation.url === "string" ? operation.url : "";
  const description = typeof operation.description === "string" ? operation.description.trim() : "";
  return [
    `  ${index}  ${operation.name}\t${method}\t${url}`,
    ...(description.length > 0 ? [`     ${description}`] : []),
  ].join("\n");
}

function formatCreatedListing(
  created: CreatedListing,
  name: string,
  payoutWallet: string,
  endpoints: number,
): string {
  const slug = listingSlug(created) ?? "(no slug returned)";
  const status = typeof created.listing?.status === "string" ? created.listing.status : "unknown";
  const verification =
    typeof created.listing?.verification === "string" ? created.listing.verification : "none";
  return [
    `Listed ${name} as ${slug} with ${endpoints} endpoint${endpoints === 1 ? "" : "s"}.`,
    `Status: ${status} · verification: ${verification}`,
    `Payout wallet: ${payoutWallet}`,
  ].join("\n");
}

/**
 * The registry grades the description agents read when they choose a listing:
 * what one call does, what it takes, when to use something else. The findings
 * never block, and every batch shares one description, so they print once.
 */
function formatDescriptionWarnings(created: CreatedListing): string[] {
  const warnings = Array.isArray(created.descriptionWarnings) ? created.descriptionWarnings : [];
  const lines = warnings.flatMap((warning: unknown) => {
    if (typeof warning !== "object" || warning === null) return [];
    const { message, hint } = warning as { message?: unknown; hint?: unknown };
    if (typeof message !== "string") return [];
    return [`- ${message}${typeof hint === "string" ? ` ${hint}` : ""}`];
  });
  return lines.length === 0
    ? []
    : ["Description check (the listing is published either way):", ...lines];
}

function formatListingStatus(
  slug: string,
  action: ListingStatusAction,
  result: { status?: unknown; verification?: unknown },
): string {
  const status = typeof result.status === "string" ? result.status : "unknown";
  const verification = typeof result.verification === "string" ? result.verification : undefined;
  const lines = [
    `Listing ${slug}: ${status}${verification === undefined ? "" : ` · verification: ${verification}`}`,
  ];
  if (action === "activate") {
    lines.push(
      `It answers searches that pass --include-unverified. Ask for review with vapi publish verify-request ${slug}.`,
    );
  }
  if (action === "request_verification") {
    lines.push(
      "vAPI reviews it; until then it stays out of the default search and is tagged [requested].",
    );
  }
  return lines.join("\n");
}

function formatMyListings(result: { listings?: readonly unknown[] }): string {
  const listings = Array.isArray(result.listings) ? result.listings : [];
  if (listings.length === 0) return "No listings yet. Create one with vapi publish <url>.";
  return [
    "SLUG\tSTATUS\tVERIFICATION\tNAME",
    ...listings.map((listing) => {
      const record = (typeof listing === "object" && listing !== null ? listing : {}) as Record<
        string,
        unknown
      >;
      return [
        typeof record.slug === "string" ? record.slug : "—",
        typeof record.status === "string" ? record.status : "—",
        typeof record.verification === "string" ? record.verification : "none",
        typeof record.name === "string" ? record.name : "",
      ].join("\t");
    }),
  ].join("\n");
}

const CLAIM_USAGE = "Usage: vapi claim <origin> [--account <name>]";

/**
 * `vapi claim <origin>`: the owner of an API vAPI indexed from a public
 * catalog takes the listings over. The registry sends an EIP-4361 message; the
 * wallet the listings already pay signs it on the same path \`vapi publish\`
 * signs its payout line, and the registry recovers the signer to match it
 * against their payTo. Nothing is paid and the payout path does not change. A
 * human act, like publishing: there is no MCP tool for it.
 */
export async function claimCommand(
  argv: string[],
  json: boolean,
  io: CliIo,
  dependencies: CliDependencies,
): Promise<void> {
  const parsed = parseArguments(argv, {
    valueOptions: new Set([WALLET_OPTION]),
    maximumPositionals: 1,
  });
  const origin = claimOrigin(requiredPositional(parsed.positionals[0], "<origin>", CLAIM_USAGE));
  const { client, baseUrl } = await listingsClient(io, dependencies, parsed);
  const wallet = await targetWallet(parsed, dependencies);
  const { account } = await unlockTarget(wallet, dependencies);
  const address = requireEvmAddress(
    account.address,
    wallet.name,
    `vapi claim ${origin} --account <name>`,
  );
  const nonce = await client.claimNonce(origin, address);
  const message = typeof nonce.message === "string" ? nonce.message : "";
  assertClaimMessage(message, { baseUrl, origin, address });
  const signature = await account.signMessage({ message });
  const result = await client.claim({ origin, message, signature });
  const claimed = (Array.isArray(result.claimed) ? result.claimed : []).filter(
    (slug): slug is string => typeof slug === "string",
  );
  await recordAudit(dependencies, "listing.claim", {
    wallet: wallet.name,
    detail: `${origin} ${claimed.join(",")}`.trim(),
  });
  outputForWallet(io, json, wallet, { origin, claimed }, formatClaimed(origin, claimed));
}

/** An https origin, and nothing more: a claim covers every listing served from it. */
function claimOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new UsageError(`${CLAIM_USAGE}. ${JSON.stringify(value)} is not a URL.`);
  }
  if (url.protocol !== "https:" || url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    throw new UsageError(
      `vapi claim takes an https origin such as https://api.example, not ${JSON.stringify(value)}.`,
    );
  }
  return url.origin;
}

function formatClaimed(origin: string, claimed: readonly string[]): string {
  if (claimed.length === 0) return `Nothing was claimed from ${origin}.`;
  return [
    `Claimed ${claimed.length} listing${claimed.length === 1 ? "" : "s"} served from ${origin}:`,
    ...claimed.map((slug) => `  ${slug}`),
    "They are still paid directly to this wallet, with no vAPI fee. vapi publish list shows them; vapi publish verify-request <slug> asks for review.",
  ].join("\n");
}
