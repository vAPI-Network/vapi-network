/**
 * `vapi check <url>`: a free, local x402 conformance doctor. It asks the URL
 * for its price the way a client would, without paying, and grades the 402
 * rule by rule, including its advertised extensions; then it looks for the
 * origin's discovery document and an OpenAPI description beside the checked
 * path, at the origin root, or through the origin's API catalog. No wallet is
 * opened, nothing is signed, and no registry is called: every request goes to
 * the origin being checked.
 *
 * Offer issue codes use the registry's snake_case `probe.conformance`
 * vocabulary, so `vapi check` and `vapi inspect` speak one language. The local
 * extensions finding does not change that registry-shaped record.
 */

import { isAddress } from "viem";

import {
  BASE_MAINNET_CAIP2,
  SOLANA_MAINNET_CAIP2,
  SOLANA_MAINNET_USDC,
  decodePaymentRequiredHeader,
  getCanonicalX402Usdc,
  isSolanaAddress,
  isSolanaNetwork,
  type ListingConformance,
} from "@vapi-network/core";

export type CheckResult = "pass" | "warn" | "fail";

export type CheckRule = {
  rule: string;
  result: CheckResult;
  detail: string;
  issues: string[];
};

export type CheckReport = {
  url: string;
  method: string;
  status: number;
  /** The same record the registry keeps per listing; null when there is no offer to grade. */
  conformance: ListingConformance | null;
  /** Known x402 extensions advertised by the declared offer, in a stable order. */
  extensions: string[];
  rules: CheckRule[];
  summary: Record<CheckResult, number>;
};

const MAX_BODY_BYTES = 1_048_576;
const REQUEST_TIMEOUT_MS = 10_000;
/** Shorter than this, an authorization can expire between signing and settling. */
const MIN_TIMEOUT_SECONDS = 10;
/** Longer than this, a signed payment stays spendable for over an hour. */
const MAX_TIMEOUT_SECONDS = 3_600;
const MAX_API_CATALOG_HREFS = 10;

const KNOWN_EXTENSIONS = [
  "bazaar",
  "builder-code",
  "payment-identifier",
  "sign-in-with-x",
  "offer-and-receipt",
  "auth-hints",
] as const;

type FieldType = "string" | "text" | "amount" | "seconds";

/** What each version requires of one accepted payment option. */
const REQUIRED_ACCEPT_FIELDS: Record<1 | 2, Record<string, FieldType>> = {
  1: {
    scheme: "string",
    network: "string",
    maxAmountRequired: "amount",
    resource: "string",
    description: "text",
    mimeType: "text",
    payTo: "string",
    maxTimeoutSeconds: "seconds",
    asset: "string",
  },
  2: {
    scheme: "string",
    network: "string",
    amount: "amount",
    asset: "string",
    payTo: "string",
    maxTimeoutSeconds: "seconds",
  },
};

/** x402 v1 names networks; v2 uses CAIP-2. */
const V1_NETWORKS: Record<string, string> = {
  base: BASE_MAINNET_CAIP2,
  solana: SOLANA_MAINNET_CAIP2,
};

type Offer = {
  header?: Record<string, unknown>;
  headerMalformed: boolean;
  body?: Record<string, unknown>;
};

type Accept = Record<string, unknown>;

export async function checkX402(
  target: URL,
  options: { method: string; fetchImpl: typeof fetch },
): Promise<CheckReport> {
  const response = await send(options.fetchImpl, target, options.method);
  const rules = [statusRule(response)];
  let conformance: ListingConformance | null = null;
  let extensions: string[] = [];
  if (response.status === 402) {
    const graded = gradeOffer(await readOffer(response));
    rules.push(...graded.rules);
    conformance = graded.conformance;
    extensions = graded.extensions;
  } else {
    void response.body?.cancel().catch(() => undefined);
  }
  rules.push(await discoveryRule(target, options.fetchImpl));
  rules.push(await openApiRule(target, options.method, options.fetchImpl));
  return {
    url: target.href,
    method: options.method,
    status: response.status,
    conformance,
    extensions,
    rules,
    summary: {
      pass: rules.filter((rule) => rule.result === "pass").length,
      warn: rules.filter((rule) => rule.result === "warn").length,
      fail: rules.filter((rule) => rule.result === "fail").length,
    },
  };
}

/** One line per rule, then the tally. */
export function formatCheckReport(report: CheckReport): string {
  const width = Math.max(...report.rules.map((rule) => rule.rule.length));
  return [
    `Check: ${report.method} ${report.url} — HTTP ${report.status}`,
    ...report.rules.map((rule) => {
      const issues = rule.issues.length === 0 ? "" : ` [${rule.issues.join(", ")}]`;
      return `  ${rule.result}  ${rule.rule.padEnd(width)}  ${rule.detail}${issues}`;
    }),
    `${report.summary.pass} passed, ${report.summary.warn} warning${
      report.summary.warn === 1 ? "" : "s"
    }, ${report.summary.fail} failed.`,
  ].join("\n");
}

function rule(name: string, result: CheckResult, detail: string, issues: string[] = []) {
  return { rule: name, result, detail, issues };
}

async function send(
  fetchImpl: typeof fetch,
  url: URL,
  method: string,
  accept = "application/json",
): Promise<Response> {
  return await fetchImpl(url, {
    method,
    headers: { accept },
    redirect: "manual",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

function statusRule(response: Response): CheckRule {
  if (response.status === 402) return rule("status", "pass", "HTTP 402 Payment Required.");
  const location = response.headers.get("location");
  const detail =
    response.status >= 300 && response.status < 400 && location !== null
      ? `HTTP ${response.status}, a redirect to ${location}. A client asks the final URL for its price; check that one.`
      : response.status === 405
        ? "HTTP 405, not 402: this method is not allowed here. Try --method POST."
        : `HTTP ${response.status}, not 402: a client sees no price here.`;
  return rule("status", "fail", detail, ["not_402"]);
}

/** Reads the offer from the PAYMENT-REQUIRED header and from the JSON body, each if present. */
async function readOffer(response: Response): Promise<Offer> {
  const raw = response.headers.get("payment-required");
  let header: Record<string, unknown> | undefined;
  let headerMalformed = false;
  if (raw !== null) {
    try {
      const decoded = decodePaymentRequiredHeader(raw);
      if (isRecord(decoded)) header = decoded;
      else headerMalformed = true;
    } catch {
      headerMalformed = true;
    }
  }
  let body: Record<string, unknown> | undefined;
  try {
    const parsed = JSON.parse((await readBoundedText(response)) ?? "") as unknown;
    if (isRecord(parsed) && ("accepts" in parsed || "x402Version" in parsed)) body = parsed;
  } catch {
    // A body that is not JSON carries no offer; the transport rule says so.
  }
  return { ...(header ? { header } : {}), headerMalformed, ...(body ? { body } : {}) };
}

function gradeOffer(offer: Offer): {
  rules: CheckRule[];
  conformance: ListingConformance | null;
  extensions: string[];
} {
  const transport = transportRule(offer);
  const declared = offer.header ?? offer.body;
  if (declared === undefined || transport.offerTransport === undefined) {
    return { rules: [transport.rule], conformance: null, extensions: [] };
  }
  const version =
    declared.x402Version === 1 || declared.x402Version === 2 ? declared.x402Version : null;
  const accepts = (Array.isArray(declared.accepts) ? declared.accepts : []).filter(isRecord);
  const exact = accepts.filter((accept) => accept.scheme === "exact");
  const fields = version === null ? undefined : fieldsRule(declared, version);
  const offerRules = [
    transport.rule,
    versionRule(declared, version),
    ...(fields ? [fields] : []),
    schemeRule(accepts, exact),
    ...(exact.length === 0
      ? []
      : [assetRule(exact, version), payToRule(exact, version), timeoutRule(exact)]),
  ];
  const extensions = advertisedExtensions(declared);
  return {
    rules: [...offerRules, extensionsRule(extensions)],
    conformance: {
      declaredVersion: version,
      versionConformant: fields?.result === "pass",
      offerTransport: transport.offerTransport,
      issues: [...new Set(offerRules.flatMap((graded) => graded.issues))],
    },
    extensions,
  };
}

function advertisedExtensions(declared: Record<string, unknown>): string[] {
  const extensions = declared.extensions;
  if (!isRecord(extensions)) return [];
  return KNOWN_EXTENSIONS.filter((name) => Object.prototype.hasOwnProperty.call(extensions, name));
}

function extensionsRule(advertised: readonly string[]): CheckRule {
  const detail =
    advertised.length === 0
      ? "Advertises none of the known extensions."
      : `Advertises ${advertised.join(", ")}.`;
  return advertised.includes("bazaar")
    ? rule("extensions", "pass", detail)
    : rule(
        "extensions",
        "warn",
        `${detail} Adding Bazaar metadata makes the API discoverable in Coinbase's Bazaar and by Coinbase for Agents.`,
        ["bazaar_metadata_missing"],
      );
}

function transportRule(offer: Offer): {
  rule: CheckRule;
  offerTransport?: ListingConformance["offerTransport"];
} {
  const { header, body } = offer;
  if (header && body) {
    return header.x402Version === body.x402Version
      ? {
          offerTransport: "both",
          rule: rule(
            "transport",
            "pass",
            "The offer is in the PAYMENT-REQUIRED header and the body.",
          ),
        }
      : {
          offerTransport: "both",
          rule: rule(
            "transport",
            "warn",
            `The header declares x402 version ${String(header.x402Version)} and the body ${String(body.x402Version)}; clients will disagree on which to pay.`,
            ["offer_version_mismatch"],
          ),
        };
  }
  if (header) {
    return {
      offerTransport: "header",
      rule: rule(
        "transport",
        "warn",
        "The offer is only in the PAYMENT-REQUIRED header; x402 v1 clients and several indexers read the JSON body.",
        ["offer_header_only"],
      ),
    };
  }
  if (!body) {
    return {
      rule: rule(
        "transport",
        "fail",
        "The 402 carries no offer: no readable PAYMENT-REQUIRED header and no JSON body with accepts.",
        offer.headerMalformed ? ["v2_header_malformed", "offer_missing"] : ["offer_missing"],
      ),
    };
  }
  if (offer.headerMalformed) {
    return {
      offerTransport: "body",
      rule: rule(
        "transport",
        "fail",
        "The PAYMENT-REQUIRED header is not base64 JSON; a client that reads the header first fails before it reaches the body.",
        ["v2_header_malformed"],
      ),
    };
  }
  if (body.x402Version === 2) {
    return {
      offerTransport: "body",
      rule: rule(
        "transport",
        "warn",
        "x402 v2 carries the offer in the PAYMENT-REQUIRED header, and this 402 sends none.",
        ["v2_header_missing"],
      ),
    };
  }
  return {
    offerTransport: "body",
    rule: rule("transport", "pass", "The offer is in the JSON body, where x402 v1 carries it."),
  };
}

function versionRule(declared: Record<string, unknown>, version: 1 | 2 | null): CheckRule {
  if (version === 2) return rule("version", "pass", "Declares x402 version 2.");
  if (version === 1) {
    return rule(
      "version",
      "warn",
      "Declares x402 version 1, which v2 superseded; vapi pay and other v2-only clients cannot pay it.",
      ["v1_legacy"],
    );
  }
  return declared.x402Version === undefined
    ? rule("version", "fail", "Declares no x402Version.", ["version_missing"])
    : rule(
        "version",
        "fail",
        `Declares x402Version ${JSON.stringify(declared.x402Version)}, which is not an x402 version.`,
        ["version_unsupported"],
      );
}

/** Every field the declared version requires, present and well-typed. */
function fieldsRule(declared: Record<string, unknown>, version: 1 | 2): CheckRule {
  const prefix = `v${version}`;
  const issues: string[] = [];
  if (version === 2) {
    const resource = declared.resource;
    if (resource === undefined) issues.push("v2_missing_resource");
    else if (!isRecord(resource) || !nonEmptyString(resource.url)) {
      issues.push("v2_invalid_resource");
    }
  }
  const accepts = declared.accepts;
  if (!Array.isArray(accepts) || accepts.length === 0) issues.push(`${prefix}_missing_accepts`);
  for (const accept of Array.isArray(accepts) ? accepts : []) {
    if (!isRecord(accept)) {
      issues.push(`${prefix}_invalid_accepts`);
      continue;
    }
    for (const [field, type] of Object.entries(REQUIRED_ACCEPT_FIELDS[version])) {
      const value = accept[field];
      if (value === undefined) issues.push(`${prefix}_missing_${snakeCase(field)}`);
      else if (!hasType(value, type)) issues.push(`${prefix}_invalid_${snakeCase(field)}`);
    }
  }
  const unique = [...new Set(issues)];
  return unique.length === 0
    ? rule("fields", "pass", `Every field x402 v${version} requires is present and well-typed.`)
    : rule(
        "fields",
        "fail",
        `The offer lacks or mistypes fields x402 v${version} requires.`,
        unique,
      );
}

function schemeRule(accepts: readonly Accept[], exact: readonly Accept[]): CheckRule {
  if (exact.length > 0) {
    return rule(
      "scheme",
      "pass",
      `${exact.length} of ${accepts.length} accepted option${accepts.length === 1 ? "" : "s"} use${exact.length === 1 ? "s" : ""} the exact scheme.`,
    );
  }
  const offered = [...new Set(accepts.map((accept) => String(accept.scheme ?? "?")))].join(", ");
  return rule(
    "scheme",
    "fail",
    `No accepted option uses the exact scheme${offered ? ` (offered: ${offered})` : ""}; vapi pay pays exact only.`,
    ["scheme_unsupported"],
  );
}

/** At least one exact option pays canonical USDC on a network vAPI knows. */
function assetRule(exact: readonly Accept[], version: 1 | 2 | null): CheckRule {
  const issues: string[] = [];
  for (const accept of exact) {
    const network = caip2(accept.network, version);
    const issue = usdcIssue(accept, network);
    if (issue === undefined) return rule("asset", "pass", `Pays canonical USDC on ${network}.`);
    issues.push(issue);
  }
  return rule(
    "asset",
    "fail",
    "No exact option pays canonical USDC on a network vAPI knows: Base, Arc testnet or Solana.",
    [...new Set(issues)],
  );
}

function usdcIssue(accept: Accept, network: string | undefined): string | undefined {
  if (network !== undefined && isSolanaNetwork(network)) {
    return accept.asset === SOLANA_MAINNET_USDC ? undefined : "asset_not_usdc";
  }
  const canonical = network === undefined ? undefined : getCanonicalX402Usdc(network);
  if (canonical === undefined) return "network_unknown";
  if (
    typeof accept.asset !== "string" ||
    accept.asset.toLowerCase() !== canonical.usdc.toLowerCase()
  ) {
    return "asset_not_usdc";
  }
  // EIP-3009 signatures are made over USDC's own EIP-712 domain; any other
  // name or version produces a signature the token rejects.
  const extra = isRecord(accept.extra) ? accept.extra : {};
  return extra.name === canonical.eip712Domain.name &&
    extra.version === canonical.eip712Domain.version
    ? undefined
    : "usdc_domain_mismatch";
}

function payToRule(exact: readonly Accept[], version: 1 | 2 | null): CheckRule {
  const malformed = exact.filter(
    (accept) => !wellFormedPayTo(accept.payTo, caip2(accept.network, version)),
  );
  return malformed.length === 0
    ? rule("pay_to", "pass", "Every exact option names a well-formed payTo address.")
    : rule(
        "pay_to",
        "fail",
        `${malformed.length} exact option${malformed.length === 1 ? " names" : "s name"} a payTo that is not a valid, non-zero address for its network.`,
        ["pay_to_invalid"],
      );
}

function wellFormedPayTo(payTo: unknown, network: string | undefined): boolean {
  if (typeof payTo !== "string") return false;
  if (network?.startsWith("solana")) return isSolanaAddress(payTo);
  // Strict: a mixed-case address must carry a valid EIP-55 checksum.
  return isAddress(payTo) && !/^0x0{40}$/i.test(payTo);
}

function timeoutRule(exact: readonly Accept[]): CheckRule {
  const seconds = exact.map((accept) => positiveInteger(accept.maxTimeoutSeconds));
  if (seconds.some((value) => value === undefined)) {
    return rule(
      "timeout",
      "fail",
      "maxTimeoutSeconds must be a positive whole number of seconds on every exact option.",
      ["max_timeout_invalid"],
    );
  }
  const values = seconds as number[];
  const shortest = Math.min(...values);
  const longest = Math.max(...values);
  const range = shortest === longest ? `${shortest}` : `${shortest}–${longest}`;
  const issues = [
    ...(shortest < MIN_TIMEOUT_SECONDS ? ["max_timeout_short"] : []),
    ...(longest > MAX_TIMEOUT_SECONDS ? ["max_timeout_long"] : []),
  ];
  return issues.length === 0
    ? rule("timeout", "pass", `maxTimeoutSeconds ${range}.`)
    : rule(
        "timeout",
        "warn",
        `maxTimeoutSeconds ${range}; between ${MIN_TIMEOUT_SECONDS} and ${MAX_TIMEOUT_SECONDS} leaves time to settle without leaving a signed payment spendable for hours.`,
        issues,
      );
}

async function discoveryRule(target: URL, fetchImpl: typeof fetch): Promise<CheckRule> {
  const url = new URL("/.well-known/x402", target.origin);
  const document = await fetchJson(fetchImpl, url);
  if (typeof document === "string") {
    return rule("discovery", "warn", `No discovery document at ${url.href}: ${document}`, [
      "discovery_missing",
    ]);
  }
  if (!isRecord(document)) {
    return rule("discovery", "warn", `${url.href} is not a JSON object.`, ["discovery_malformed"]);
  }
  const resources = Array.isArray(document.resources) ? document.resources.length : undefined;
  return rule(
    "discovery",
    "pass",
    `Discovery document at ${url.href}${
      resources === undefined ? "" : ` lists ${resources} resource${resources === 1 ? "" : "s"}`
    }.`,
  );
}

async function openApiRule(
  target: URL,
  method: string,
  fetchImpl: typeof fetch,
): Promise<CheckRule> {
  const pathCandidates = pathAdjacentOpenApiUrls(target);
  const adjacent = await findOpenApiOperation(fetchImpl, pathCandidates, target.pathname, method);
  let firstDocument = adjacent.firstDocument;
  let found = adjacent.found;
  const catalogUrl = new URL("/.well-known/api-catalog", target.origin);
  if (found === undefined) {
    const catalog = await fetchJson(
      fetchImpl,
      catalogUrl,
      "application/linkset+json, application/json",
    );
    const seen = new Set(pathCandidates.map((candidate) => candidate.href));
    const catalogCandidates = apiCatalogOpenApiUrls(catalog, catalogUrl, target.origin, seen);
    const catalogResult = await findOpenApiOperation(
      fetchImpl,
      catalogCandidates,
      target.pathname,
      method,
      true,
    );
    firstDocument ??= catalogResult.firstDocument;
    found = catalogResult.found;
  }
  if (found === undefined && firstDocument === undefined) {
    const nearest = pathCandidates[0]!;
    const root = pathCandidates[pathCandidates.length - 1]!;
    const pathDetail =
      pathCandidates.length === 1
        ? `at ${nearest.href}`
        : `from ${nearest.href} through ${root.href}`;
    return rule(
      "openapi",
      "warn",
      `No OpenAPI document with paths ${pathDetail}, or in same-origin service-desc links from ${catalogUrl.href}.`,
      ["openapi_missing"],
    );
  }
  const label = `${method} ${target.pathname}`;
  if (found === undefined) {
    const source = openApiSource(firstDocument!, catalogUrl);
    return rule("openapi", "warn", `${source} describes no ${label}.`, [
      "openapi_operation_missing",
    ]);
  }
  const source = openApiSource(found.document, catalogUrl);
  return found.operation.operation["x-payment-info"] !== undefined ||
    found.operation.item["x-payment-info"] !== undefined
    ? rule("openapi", "pass", `${source} declares x-payment-info for ${label}.`)
    : rule("openapi", "warn", `${source} describes ${label} without x-payment-info.`, [
        "openapi_payment_info_missing",
      ]);
}

function pathAdjacentOpenApiUrls(target: URL): URL[] {
  const candidates: URL[] = [];
  const seen = new Set<string>();
  let candidate = new URL("openapi.json", target);
  while (true) {
    if (!seen.has(candidate.href)) {
      candidates.push(candidate);
      seen.add(candidate.href);
    }
    if (candidate.pathname === "/openapi.json") return candidates;
    candidate = new URL("../openapi.json", candidate);
  }
}

/** Same-origin RFC 9727 service descriptions, in linkset order and without duplicates. */
function apiCatalogOpenApiUrls(
  document: unknown,
  catalogUrl: URL,
  origin: string,
  seen: Set<string>,
): URL[] {
  if (!isRecord(document) || !Array.isArray(document.linkset)) return [];
  const candidates: URL[] = [];
  for (const link of document.linkset) {
    if (!isRecord(link) || !Array.isArray(link["service-desc"])) continue;
    for (const description of link["service-desc"]) {
      if (!isRecord(description) || typeof description.href !== "string") continue;
      let candidate: URL;
      try {
        candidate = new URL(description.href, catalogUrl);
      } catch {
        continue;
      }
      if (candidate.origin !== origin || seen.has(candidate.href)) continue;
      seen.add(candidate.href);
      candidates.push(candidate);
      if (candidates.length === MAX_API_CATALOG_HREFS) return candidates;
    }
  }
  return candidates;
}

type OpenApiDocument = {
  url: URL;
  paths: Record<string, unknown>;
  viaCatalog?: true;
};

async function findOpenApiOperation(
  fetchImpl: typeof fetch,
  candidates: readonly URL[],
  pathname: string,
  method: string,
  viaCatalog = false,
): Promise<{
  firstDocument?: OpenApiDocument;
  found?: {
    document: OpenApiDocument;
    operation: { item: Record<string, unknown>; operation: Record<string, unknown> };
  };
}> {
  let firstDocument: OpenApiDocument | undefined;
  for (const url of candidates) {
    const document = await fetchJson(fetchImpl, url);
    if (isRecord(document) && isRecord(document.paths)) {
      const located: OpenApiDocument = {
        url,
        paths: document.paths,
        ...(viaCatalog ? { viaCatalog: true } : {}),
      };
      firstDocument ??= located;
      const operation = findOperation(document.paths, pathname, method);
      if (operation !== undefined) {
        return { firstDocument, found: { document: located, operation } };
      }
    }
  }
  return firstDocument === undefined ? {} : { firstDocument };
}

function openApiSource(document: OpenApiDocument, catalogUrl: URL): string {
  return document.viaCatalog
    ? `${document.url.href} (via the API catalog at ${catalogUrl.href})`
    : document.url.href;
}

/** The operation a path template and method describe; a servers prefix may precede the template. */
function findOperation(
  paths: Record<string, unknown>,
  pathname: string,
  method: string,
): { item: Record<string, unknown>; operation: Record<string, unknown> } | undefined {
  const path = trimSlash(pathname);
  for (const [template, item] of Object.entries(paths)) {
    if (!isRecord(item)) continue;
    const operation = item[method.toLowerCase()];
    if (!isRecord(operation)) continue;
    const pattern = trimSlash(template)
      .split(/(\{[^/}]+\})/)
      .map((part) => (part.startsWith("{") ? "[^/]+" : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
      .join("");
    if (new RegExp(`${pattern}$`).test(path)) return { item, operation };
  }
  return undefined;
}

/** The parsed JSON of a 200, or the reason there is none. */
async function fetchJson(
  fetchImpl: typeof fetch,
  url: URL,
  accept = "application/json",
): Promise<unknown> {
  let response: Response;
  try {
    response = await send(fetchImpl, url, "GET", accept);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  if (response.status !== 200) {
    void response.body?.cancel().catch(() => undefined);
    return `HTTP ${response.status}.`;
  }
  try {
    return JSON.parse((await readBoundedText(response)) ?? "") as unknown;
  } catch {
    return null;
  }
}

async function readBoundedText(response: Response): Promise<string | undefined> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    total += next.value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(next.value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

function caip2(network: unknown, version: 1 | 2 | null): string | undefined {
  if (typeof network !== "string" || network.length === 0) return undefined;
  return version === 1 ? (V1_NETWORKS[network] ?? network) : network;
}

function hasType(value: unknown, type: FieldType): boolean {
  switch (type) {
    case "string":
      return nonEmptyString(value);
    case "text":
      return typeof value === "string";
    case "amount":
      return typeof value === "string" && /^\d+$/.test(value);
    case "seconds":
      return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
  }
}

function positiveInteger(value: unknown): number | undefined {
  const parsed = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  return typeof parsed === "number" && Number.isSafeInteger(parsed) && parsed > 0
    ? parsed
    : undefined;
}

function snakeCase(field: string): string {
  return field.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

function trimSlash(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
