import { DEFAULT_REGISTRY_URL } from "./config.js";

/** Onramp deposits land on Base, the only network the hosted onramp settles to. */
export const ONRAMP_NETWORK = "base";

/** Printed alongside the funding page, so funding never depends on a browser. */
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
