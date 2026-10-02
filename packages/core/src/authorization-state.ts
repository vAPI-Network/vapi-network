import { getAddress, type Hex } from "viem";

import type { VapiConfig } from "./config.js";
import type { LookupFn } from "./net-guard.js";
import {
  configuredNetworkFor,
  createNetworkPublicClient,
  explorerAddressUrl,
  isSolanaNetwork,
} from "./networks.js";
import type { Receipt } from "./receipts.js";

/**
 * EIP-3009's own record of whether an authorization nonce was ever used. USDC
 * implements it: `true` means a transfer with that nonce executed on-chain.
 */
export const EIP3009_AUTHORIZATION_STATE_ABI = [
  {
    type: "function",
    name: "authorizationState",
    stateMutability: "view",
    inputs: [
      { name: "authorizer", type: "address" },
      { name: "nonce", type: "bytes32" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

/**
 * What the chain says about a signed payment whose response was lost:
 *
 * - `settled`: the nonce was used. EIP-3009 also marks a cancelled
 *   authorization as used, but this client never cancels, so in practice the
 *   payment went through; paying again pays twice.
 * - `expired`: never used, and the chain is past `validBefore`, so it never can
 *   be. Paying again is safe.
 * - `pending`: never used yet, but still valid. It may still settle; wait for
 *   `validBefore` and check again.
 */
export type AuthorizationState = "settled" | "expired" | "pending";

export type ReceiptSettlementCheck = {
  network: string;
  token: string;
  authorizer: string;
  nonce: string;
  validBefore: string;
  /** The latest block's timestamp the verdict was taken at, in Unix seconds. */
  chainTime: string;
  state: AuthorizationState;
};

/**
 * Reads, from the chain itself, whether the payment a receipt signed has
 * settled. Nothing is signed and nothing is paid.
 *
 * Expiry is judged against the latest block's timestamp rather than this
 * machine's clock: a block at or past `validBefore` means no later block can
 * include the authorization, so `expired` is final even on a skewed clock.
 */
export async function checkReceiptSettlement(
  receipt: Receipt,
  config: Pick<VapiConfig, "networks" | "allowPrivateNetwork">,
  options: { fetchImpl?: typeof fetch; lookup?: LookupFn } = {},
): Promise<ReceiptSettlementCheck> {
  const network = receipt.quote?.network;
  if (network !== undefined && isSolanaNetwork(network)) {
    throw new Error(
      `Receipt ${receipt.id} paid on Solana, and checking a Solana payment's settlement is not supported yet. Look for the payer's USDC transfer on a Solana explorer before paying again.`,
    );
  }
  const token = receipt.quote?.asset;
  const authorization = receipt.authorization;
  if (network === undefined || token === undefined || authorization === undefined) {
    throw new Error(missingAuthorization(receipt));
  }
  const configured = configuredNetworkFor(config.networks, network);
  if (configured === undefined) {
    throw new Error(
      `Network ${network} is not configured, so its settlement cannot be read. Add it and its RPC URL to config.json.`,
    );
  }
  const client = createNetworkPublicClient(network, configured, {
    allowPrivateNetwork: config.allowPrivateNetwork,
    ...(options.fetchImpl ? { fetch: options.fetchImpl } : {}),
    ...(options.lookup ? { lookup: options.lookup } : {}),
  });
  // The block first: if it is already past validBefore, a later read that
  // finds the nonce unused is final.
  const block = await client.getBlock({ blockTag: "latest" });
  const used = await client.readContract({
    address: getAddress(token),
    abi: EIP3009_AUTHORIZATION_STATE_ABI,
    functionName: "authorizationState",
    args: [getAddress(authorization.from), authorization.nonce as Hex],
  });
  return {
    network,
    token: getAddress(token),
    authorizer: getAddress(authorization.from),
    nonce: authorization.nonce,
    validBefore: authorization.validBefore,
    chainTime: block.timestamp.toString(),
    state: used
      ? "settled"
      : block.timestamp >= BigInt(authorization.validBefore)
        ? "expired"
        : "pending",
  };
}

function missingAuthorization(receipt: Receipt): string {
  if (
    receipt.payer !== undefined &&
    receipt.quote !== undefined &&
    receipt.outcome !== "signed_in"
  ) {
    const payee = receipt.quote.payTo === undefined ? "" : ` to ${receipt.quote.payTo}`;
    const explorerUrl = explorerAddressUrl(receipt.quote.network, receipt.payer);
    return `Receipt ${receipt.id} does not record its payment authorization — it was written before vAPI kept the EIP-3009 nonce on receipts — so its settlement cannot be looked up. Check ${receipt.payer}'s USDC transfers${payee} ${explorerUrl ? `on ${explorerUrl}` : "on a block explorer"} before paying again.`;
  }
  return `Receipt ${receipt.id} records no signed payment authorization, so nothing from that call can settle.`;
}
