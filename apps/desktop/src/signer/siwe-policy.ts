import { getAddress } from "viem";
import { createSiweMessage, parseSiweMessage, type SiweMessage } from "viem/siwe";

/**
 * Plain messages are signed only as SIWE sign-ins for the configured vAPI server. The exact
 * round trip refuses messages that parse but carry extra lines. Third-party SIWX and Tasks
 * payloads are refused on purpose until they get typed signer requests.
 */
export function siweRefusal(
  message: string,
  apiBase: string,
  address: `0x${string}`,
): string | null {
  let host = apiBase;
  try {
    const api = new URL(apiBase);
    host = api.host;
    const parsed = parseSiweMessage(message);
    if (
      parsed.domain === host &&
      parsed.uri !== undefined &&
      new URL(parsed.uri).origin === api.origin &&
      parsed.version === "1" &&
      parsed.nonce &&
      parsed.address &&
      getAddress(parsed.address) === getAddress(address) &&
      createSiweMessage(parsed as SiweMessage) === message
    ) {
      return null;
    }
  } catch {
    // Parsing and canonicalization failures must refuse signing too.
  }
  return `vAPI Desktop signs only vAPI sign-in messages for ${host}.`;
}
