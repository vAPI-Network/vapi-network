/**
 * Every payment warning code. Schemas that validate a warning derive their
 * enum from this list, so a new code cannot be accepted in one place and
 * rejected in another.
 */
export const PAYMENT_WARNING_CODES = [
  "settlement_unconfirmed",
  "credit_pending",
  "pending_purchase_unlinked",
  "audit_unavailable",
  "router_key_unavailable",
  "balance_unavailable",
  "purchase_response_unavailable",
  "receipt_unavailable",
  "payment_followup_unavailable",
] as const;

/** Payment evidence and recovery guidance, including authorizations not yet confirmed settled. */
export type PaymentWarning = {
  code: (typeof PAYMENT_WARNING_CODES)[number];
  message: string;
};
