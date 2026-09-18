import { DEFAULT_REGISTRY_URL } from "./config.js";
import { createPublicFetch, type LookupFn } from "./net-guard.js";
import { discardBody } from "./x402.js";

/** Onramp deposits land on Base, the only network the hosted onramp settles to. */
export const ONRAMP_NETWORK = "base";
export const ONRAMP_ASSET = "USDC";

/** Printed whenever the hosted onramp cannot be used; funding stays possible. */
export const ONRAMP_FALLBACK_INSTRUCTIONS =
  "Send USDC on Base (eip155:8453) to this address; add a little ETH for gas if you plan to sweep.";

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
  const registryUrl =
    options.registryUrl?.trim() || env.VAPI_REGISTRY_URL?.trim() || DEFAULT_REGISTRY_URL;
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
  const endpoint = new URL(registryUrl);
  endpoint.search = "";
  endpoint.hash = "";
  const prefix = endpoint.pathname === "/" ? "" : endpoint.pathname.replace(/\/+$/, "");
  endpoint.pathname = `${prefix}/api/wallet/onramp-session`;
  return endpoint;
}
