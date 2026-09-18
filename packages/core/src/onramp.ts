import { DEFAULT_REGISTRY_URL } from "./config.js";
import { createPublicFetch, type LookupFn } from "./net-guard.js";
import { discardBody } from "./x402.js";

/** Onramp deposits land on Base, the only network the hosted onramp settles to. */
export const ONRAMP_NETWORK = "base";
export const ONRAMP_ASSET = "USDC";

/** Printed whenever the hosted onramp cannot be used; funding stays possible. */
export const ONRAMP_FALLBACK_INSTRUCTIONS =
  "Send USDC on Base (eip155:8453) to this address; add a little ETH for gas if you plan to sweep.";

/** One 20-byte EVM address; the funding page routes on it. */
const EVM_ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

export type FundingPageOptions = {
  /** Fiat amount in USD to prefill on the page. Omitted when the caller has no preference. */
  amount?: number;
};

/** The registry this install talks to: the env override first, then the shipped default. */
export function resolveRegistryUrl(env: NodeJS.ProcessEnv = process.env): string {
  return env.VAPI_REGISTRY_URL?.trim() || DEFAULT_REGISTRY_URL;
}

/**
 * Build the URL of the hosted funding page for one local address.
 *
 * The page is public — no sign-in — and mints the card-payment session at click
 * time, so the link never goes stale in a terminal scrollback or an agent
 * transcript. It also offers a wallet transfer and a bridge, which is why this
 * is the only funding link the client hands out. Pure: no network, no clock.
 */
export function fundingPageUrl(
  registryUrl: string,
  address: string,
  options: FundingPageOptions = {},
): string {
  const trimmed = address.trim();
  if (!EVM_ADDRESS_PATTERN.test(trimmed)) {
    throw new Error("A 0x-prefixed EVM address is required to open the funding page.");
  }
  if (options.amount !== undefined && !(options.amount > 0)) {
    throw new Error("The funding amount must be greater than zero.");
  }
  const url = registryUrlWithPath(registryUrl, `/fund/${trimmed}`);
  if (options.amount !== undefined) url.searchParams.set("amount", String(options.amount));
  return url.toString();
}

export type CreateOnrampSessionOptions = {
  address: string;
  /** Requested fiat amount in USD. Omitted when the caller has no preference. */
  fiatAmount?: number;
  registryUrl?: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  allowPrivateNetwork?: boolean;
  lookup?: LookupFn;
};

export type OnrampSession =
  | { status: "ready"; address: string; url: string }
  | { status: "unavailable"; address: string; reason: string; instructions: string };

/**
 * Ask the registry for a hosted onramp session for one local address.
 *
 * vAPI never holds funds: the session is created by the registry with the
 * onramp provider, and the user pays the provider directly. Every failure mode
 * degrades to direct-transfer instructions instead of throwing, so funding
 * advice is always available.
 *
 * @deprecated The session token is single-use and expires minutes after it is
 * minted, so a link printed in a terminal is usually dead by the time a human
 * has logged in. Use {@link fundingPageUrl} instead: the hosted page mints the
 * session at click time. Kept exported for backwards compatibility.
 */
export async function createOnrampSession(
  options: CreateOnrampSessionOptions,
): Promise<OnrampSession> {
  const address = options.address.trim();
  if (!address) throw new Error("An address is required to open a funding session.");
  if (options.fiatAmount !== undefined && !(options.fiatAmount > 0)) {
    throw new Error("The onramp amount must be greater than zero.");
  }

  const env = options.env ?? process.env;
  const registryUrl = options.registryUrl?.trim() || resolveRegistryUrl(env);
  const fetchImpl =
    options.fetchImpl ??
    createPublicFetch({
      allowPrivateNetwork: options.allowPrivateNetwork ?? false,
      ...(options.lookup === undefined ? {} : { lookup: options.lookup }),
    });

  let response: Response;
  try {
    response = await fetchImpl(onrampEndpoint(registryUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        address,
        network: ONRAMP_NETWORK,
        asset: ONRAMP_ASSET,
        ...(options.fiatAmount === undefined ? {} : { fiatAmount: options.fiatAmount }),
      }),
    });
  } catch (error) {
    return unavailable(address, error instanceof Error ? error.message : String(error));
  }

  if (!response.ok) {
    return unavailable(address, await readFailureReason(response));
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return unavailable(address, "The registry returned an unreadable onramp session.");
  }
  const url = readUrl(payload);
  if (url === undefined) {
    return unavailable(address, "The registry returned no onramp URL.");
  }
  return { status: "ready", address, url };
}

function unavailable(address: string, reason: string): OnrampSession {
  return {
    status: "unavailable",
    address,
    reason,
    instructions: ONRAMP_FALLBACK_INSTRUCTIONS,
  };
}

function readUrl(payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const value = (payload as { url?: unknown }).url;
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? value : undefined;
  } catch {
    return undefined;
  }
}

async function readFailureReason(response: Response): Promise<string> {
  let body = "";
  try {
    body = (await response.text()).slice(0, 2_000);
  } catch {
    discardBody(response);
  }
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed === "object" && parsed !== null) {
      for (const key of ["error", "code", "reason", "message"] as const) {
        const value = (parsed as Record<string, unknown>)[key];
        if (typeof value === "string" && value.trim()) return value.trim();
      }
    }
  } catch {
    // A non-JSON body carries no machine-readable reason; fall through.
  }
  return `HTTP ${response.status}`;
}

function onrampEndpoint(registryUrl: string): URL {
  return registryUrlWithPath(registryUrl, "/api/wallet/onramp-session");
}

/**
 * Append one absolute path to a registry URL, keeping any mount prefix and
 * dropping the query and fragment a hand-edited config may carry.
 */
function registryUrlWithPath(registryUrl: string, path: string): URL {
  const url = new URL(registryUrl);
  url.search = "";
  url.hash = "";
  const prefix = url.pathname === "/" ? "" : url.pathname.replace(/\/+$/, "");
  url.pathname = `${prefix}${path}`;
  return url;
}
