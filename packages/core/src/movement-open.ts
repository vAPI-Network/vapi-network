export type MovementLegState = {
  status: unknown;
  retryable?: unknown;
  nonce?: unknown;
  restored?: unknown;
};

export type MovementJournalEvidence = "signed" | "unsigned";

/** Whether a movement leg can still move money or be resumed to do so. */
export function isOpenMovementLeg(
  leg: MovementLegState,
  journalEvidence: MovementJournalEvidence,
): boolean {
  if (leg.status === "sent" || leg.status === "cancelled") return false;
  if (leg.restored === true) return true;
  if (leg.status === "planned" || leg.status === "unknown") return true;
  if (leg.status !== "failed") return false;
  if (leg.retryable === true) return true;
  return journalEvidence === "signed";
}
