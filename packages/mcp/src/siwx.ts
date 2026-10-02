import {
  buildSIWxProof as buildSharedSIWxProof,
  parseSIWxResponse as parseSharedSIWxResponse,
  type SIWxChallenge,
  type SIWxSigner,
  type VapiConfig,
  type X402NetworkConfig,
} from "@vapi-network/core";

/** Keep the CLI/MCP convention that a blank RPC disables a configured chain. */
function toSIWxNetworks(networks: VapiConfig["networks"]): X402NetworkConfig {
  return Object.fromEntries(
    Object.entries(networks).map(([network, configured]) => [
      network,
      { usdc: configured.usdc, enabled: Boolean(configured.rpcUrl.trim()) },
    ]),
  );
}

export async function parseSIWxResponse(
  response: Response,
  configuredNetworks: VapiConfig["networks"],
  responseUrl: string,
  requiredNetwork?: string,
): Promise<SIWxChallenge | null> {
  return await parseSharedSIWxResponse(
    response,
    toSIWxNetworks(configuredNetworks),
    responseUrl,
    requiredNetwork,
  );
}

export async function buildSIWxProof(args: {
  signer: SIWxSigner;
  challenge: SIWxChallenge;
  responseUrl: string;
}) {
  return await buildSharedSIWxProof(args);
}
