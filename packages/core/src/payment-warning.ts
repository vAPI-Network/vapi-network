/** Payment evidence and recovery guidance, including authorizations not yet confirmed settled. */
export type PaymentWarning = {
  code:
    | "settlement_unconfirmed"
    | "credit_pending"
    | "pending_purchase_unlinked"
    | "audit_unavailable"
    | "router_key_unavailable"
    | "balance_unavailable"
    | "purchase_response_unavailable"
    | "receipt_unavailable"
    | "payment_followup_unavailable";
  message: string;
};
