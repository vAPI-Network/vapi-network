import { createHash } from "node:crypto";

// Fee rule from vapi-app/apps/api/app/tasks/client/domain/dispute-fee.ts.
export function disputeFeeBaseUnits(amount: bigint): bigint {
  if (amount < 0n) throw new Error("Dispute amount must be nonnegative.");
  const fee = (amount * 1_000n) / 10_000n;
  return fee < 20_000_000n ? 20_000_000n : fee > 500_000_000n ? 500_000_000n : fee;
}

/** Separate durable reservation identities for funding and the two fee actions. */
export function taskFeeReservationKey(milestoneId: string, action: string): string {
  const bytes = createHash("sha256")
    .update(JSON.stringify([milestoneId, action]))
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
