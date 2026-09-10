import {
  EIP3009_AUTHORIZATION_TYPES,
  X402Error,
  assertMaxPrice,
  buildEip3009TypedData,
  buildX402Payment as buildSharedX402Payment,
  classifySettlement,
  parse402Challenge as parseShared402Challenge,
  parse402Response as parseShared402Response,
  parseSettlementResponse,
  usdToAtomic,
  type Eip3009Authorization,
  type X402NetworkConfig,
  type X402PaymentHeaders as SharedX402PaymentHeaders,
  type X402PaymentPayload,
  type X402PaymentRequirements,
  type X402Quote,
  type X402Resource,
  type X402Signer,
  type VapiConfig,
} from "@vapi-network/core";
import type { Hex } from "viem";

export {
  EIP3009_AUTHORIZATION_TYPES,
  X402Error,
  assertMaxPrice,
  buildEip3009TypedData,
  classifySettlement,
  parseSettlementResponse,
  usdToAtomic,
};
export type {
  Eip3009Authorization,
  X402PaymentPayload,
  X402PaymentRequirements,
  X402Quote,
  X402Resource,
};

export type X402PaymentHeaders = SharedX402PaymentHeaders & {
  "X-PAYMENT": string;
};

// vAPI treats an entry with a blank RPC as disabled. Keep that local
// safety policy while delegating all protocol parsing to the browser-neutral
// shared package.
function toSharedNetworks(networks: VapiConfig["networks"]): X402NetworkConfig {
  return Object.fromEntries(
    Object.entries(networks).map(([network, configured]) => [
      network,
      {
        usdc: configured.usdc,
        rpcUrl: configured.rpcUrl,
        enabled: Boolean(configured.rpcUrl.trim()),
        ...(configured.eip712Domain ? { eip712Domain: configured.eip712Domain } : {}),
      },
    ]),
  );
}

export function parse402Challenge(
  challenge: unknown,
  configuredNetworks: VapiConfig["networks"],
  fallbackResourceUrl = "",
  requiredNetwork?: string,
  expectedPayTo?: string,
): X402Quote {
  return parseShared402Challenge(
    challenge,
    toSharedNetworks(configuredNetworks),
    fallbackResourceUrl,
    requiredNetwork,
    expectedPayTo,
  );
}

export async function parse402Response(
  response: Response,
  configuredNetworks: VapiConfig["networks"],
  requiredNetwork?: string,
  expectedPayTo?: string,
): Promise<X402Quote> {
  return await parseShared402Response(
    response,
    toSharedNetworks(configuredNetworks),
    requiredNetwork,
    expectedPayTo,
  );
}

// Preserve the stable @vapi-network/mcp ./x402 argument name while the shared core
// uses the browser-neutral `signer` vocabulary.
export async function buildX402Payment(args: {
  account: X402Signer;
  quote: X402Quote;
  nowSeconds?: number;
  nonce?: Hex;
  fetchImpl?: typeof fetch;
}): Promise<{ payload: X402PaymentPayload; headers: X402PaymentHeaders }> {
  const payment = await buildSharedX402Payment({
    signer: args.account,
    quote: args.quote,
    ...(args.nowSeconds === undefined ? {} : { nowSeconds: args.nowSeconds }),
    ...(args.nonce === undefined ? {} : { nonce: args.nonce }),
    ...(args.fetchImpl === undefined ? {} : { fetchImpl: args.fetchImpl }),
  });
  return {
    payload: payment.payload,
    headers: {
      ...payment.headers,
      "X-PAYMENT": JSON.stringify({
        x402Version: 2,
        scheme: args.quote.accepted.scheme,
        network: args.quote.accepted.network,
        payload: payment.payload.payload,
      }),
    },
  };
}
