import { getAddress, type Address } from "viem";

export const BASE_MAINNET_CAIP2 = "eip155:8453" as const;
export const ARC_TESTNET_CAIP2 = "eip155:5042002" as const;

export type CanonicalX402UsdcNetwork = typeof BASE_MAINNET_CAIP2 | typeof ARC_TESTNET_CAIP2;

export type X402TokenDomain = Readonly<{
  name: string;
  version: string;
}>;

export type CanonicalX402UsdcIdentity = Readonly<{
  usdc: Address;
  eip712Domain: X402TokenDomain;
}>;

export type X402NetworkConfig = Readonly<
  Record<
    string,
    Readonly<{
      usdc: string;
      enabled?: boolean;
      eip712Domain?: X402TokenDomain;
    }>
  >
>;

function canonicalIdentity(
  usdc: string,
  eip712Domain: { name: string; version: string },
): CanonicalX402UsdcIdentity {
  return Object.freeze({
    usdc: getAddress(usdc.toLowerCase()),
    eip712Domain: Object.freeze({ ...eip712Domain }),
  });
}

const baseMainnetUsdc = canonicalIdentity("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", {
  name: "USD Coin",
  version: "2",
});
const arcTestnetUsdc = canonicalIdentity("0x3600000000000000000000000000000000000000", {
  name: "USDC",
  version: "2",
});

/** Canonical token and signing-domain identity. This is not an enablement policy. */
export const CANONICAL_X402_USDC_NETWORKS = Object.freeze({
  [BASE_MAINNET_CAIP2]: baseMainnetUsdc,
  [ARC_TESTNET_CAIP2]: arcTestnetUsdc,
}) satisfies Readonly<Record<CanonicalX402UsdcNetwork, CanonicalX402UsdcIdentity>>;

export function getCanonicalX402Usdc(network: string): CanonicalX402UsdcIdentity | undefined {
  if (!Object.hasOwn(CANONICAL_X402_USDC_NETWORKS, network)) {
    return undefined;
  }
  return CANONICAL_X402_USDC_NETWORKS[network as CanonicalX402UsdcNetwork];
}

function browserNetwork(identity: CanonicalX402UsdcIdentity) {
  return Object.freeze({
    usdc: identity.usdc,
    enabled: true,
    eip712Domain: identity.eip712Domain,
  });
}

/** Networks the browser-wallet adapter is currently allowed to execute on. */
export const BROWSER_ENABLED_X402_NETWORK_CONFIG: X402NetworkConfig = Object.freeze({
  [BASE_MAINNET_CAIP2]: browserNetwork(baseMainnetUsdc),
  [ARC_TESTNET_CAIP2]: browserNetwork(arcTestnetUsdc),
});
