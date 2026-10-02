import type { Source } from "@vapi-network/core";

/**
 * x402scan documents its crawl convention but not a stable public read API.
 * Keep this explicit stub so callers can configure it without silently assuming
 * an undocumented endpoint contract.
 */
export function x402scanSource(): Source {
  // TODO: Implement when x402scan publishes a stable, unauthenticated read API.
  return {
    id: "x402scan",
    async search() {
      return [];
    },
    async inspect() {
      return null;
    },
  };
}
