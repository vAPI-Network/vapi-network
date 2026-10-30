/**
 * What the user accepts before creating wallets. The renderer shows these exact sentences and
 * main stores them with the time of acceptance; bump `version` whenever a sentence changes.
 */
export const CUSTODY_TERMS = {
  version: "custody-2026-10-27",
  statements: [
    "I understand that vAPI cannot access, freeze, recover, or reverse anything in my agent wallets. Only this app on this Mac can sign with them.",
    "I understand that if I forget my password or lose this Mac, only my Emergency Kit or my encrypted backup can bring these wallets back. Without either, the money is lost.",
  ],
} as const;
