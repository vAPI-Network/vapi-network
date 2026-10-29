import type { ListingFee } from "./marketplace-contracts.js";

/** Display the fee disclosed by the registry; zero always means no network fee. */
export function formatListingFee(fee: ListingFee): string {
  return fee.bps === 0 ? "No network fee" : `${fee.label} (${fee.bps / 100}%)`;
}
