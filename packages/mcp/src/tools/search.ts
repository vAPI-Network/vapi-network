import { formatListingFee } from "@vapi-network/core";
import { searchMarketplace as searchRegistry } from "@vapi-network/sources";

export {
  findMarketplaceApiByRef,
  resolveServiceEndpoint,
  resolveServiceListing,
  type MarketplaceSearchInput,
} from "@vapi-network/sources";

/** Preserve registry metadata and add the same fee display used by inspect and CLI. */
export async function searchMarketplace(...args: Parameters<typeof searchRegistry>) {
  const page = await searchRegistry(...args);
  return {
    ...page,
    items: page.items.map((item) => ({
      ...item,
      ...(item.fee === undefined ? {} : { feeDisplay: formatListingFee(item.fee) }),
    })),
  };
}
