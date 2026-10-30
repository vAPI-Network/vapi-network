import { z } from "zod";

import { walletNameSchema } from "../shared/wallet-name.js";
export const spendCapsSchema = z.object({
  perCallAtomic: z.string().regex(/^\d+$/),
  perDayAtomic: z.string().regex(/^\d+$/),
});

export const signerRequestSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("status") }),
  z.object({ type: z.literal("createVault"), password: z.string().min(8) }),
  z.object({
    type: z.literal("restorePhrase"),
    phrase: z.string().min(1).max(1000),
    password: z.string().min(8),
  }),
  z.object({ type: z.literal("unlock"), password: z.string().optional() }),
  z.object({ type: z.literal("lock") }),
  z.object({ type: z.literal("revealPhrase"), password: z.string().min(1).max(1024) }),
  z.object({ type: z.literal("confirmKit") }),
  z.object({ type: z.literal("recoveryStatus") }),
  z.object({ type: z.literal("backupStart"), purpose: z.enum(["enroll", "restore"]) }),
  z.object({ type: z.literal("backupPoll") }),
  z.object({ type: z.literal("restoreBackup"), password: z.string().min(8) }),
  z.object({ type: z.literal("listWallets"), includeLinks: z.boolean().optional() }),
  z.object({ type: z.literal("linkStart"), wallet: walletNameSchema }),
  z.object({ type: z.literal("linkPoll"), wallet: walletNameSchema }),
  z.object({
    type: z.literal("createWallet"),
    name: walletNameSchema,
    caps: spendCapsSchema.optional(),
  }),
  z.object({
    type: z.literal("setCaps"),
    wallet: walletNameSchema,
    caps: spendCapsSchema,
    /** Required only when a limit goes up. */
    password: z.string().optional(),
  }),
  z.object({
    type: z.literal("sign"),
    wallet: walletNameSchema,
    request: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("typedData"), typedData: z.unknown() }),
      z.object({ kind: z.literal("message"), message: z.string() }),
    ]),
  }),
]);
export type SignerRequest = z.infer<typeof signerRequestSchema>;

export type RequestOrigin = "ui" | "mcp";

export const MCP_REQUEST_TYPES: readonly SignerRequest["type"][] = [
  "status",
  "listWallets",
  "sign",
];

export type WalletSummary = {
  name: string;
  address: `0x${string}`;
  publicKey: `0x${string}`;
  caps: z.infer<typeof spendCapsSchema>;
  /** Signed today (UTC) according to the signer's own ledger. */
  spentTodayAtomic: string;
  /** Present when `listWallets` was asked with `includeLinks`. */
  link?: WalletLinkState;
};

/** Whether a wallet is linked to the owner's vAPI account (spec §3). */
export type WalletLinkState = "linked" | "not_linked" | "revoked";

/** What starting a link gave: done silently (D3), a code to approve (D4), or an error. */
export type LinkStartResult =
  | { mode: "silent" }
  | { mode: "browser"; userCode: string; url: string; expiresAt: number }
  | { mode: "error"; message: string };

/** One look at a browser link; `none` when no link is running for that wallet. */
export type LinkPollState =
  | { state: "none" }
  | { state: "pending"; userCode: string; url: string; expiresAt: number }
  | { state: "linked"; owner: `0x${string}` }
  | { state: "denied" | "expired" | "failed"; message: string };

export type BackupState = { enabled: boolean; lastUploadAt?: string; failed: boolean };
export type RecoveryState = { kit: boolean; backup: BackupState };
export type BackupPurpose = "enroll" | "restore";
export type BackupStartResult =
  | { mode: "browser"; code: string; url: string; expiresAt: number }
  | { mode: "error"; message: string };
export type BackupPollState =
  | { state: "none" }
  | { state: "pending"; purpose: BackupPurpose; code: string; url: string; expiresAt: number }
  | { state: "enrolled" }
  | { state: "approved"; owner: `0x${string}` }
  | { state: "failed"; message: string };

export type SignerResponse =
  | {
      ok: true;
      type: "status";
      vault: "none" | "locked" | "unlocked";
      touchId: boolean;
      /** The vAPI account this Mac's wallets are linked to (spec §3 "You"). */
      owner?: `0x${string}`;
    }
  | { ok: true; type: "linkStart"; result: LinkStartResult }
  | { ok: true; type: "linkPoll"; result: LinkPollState }
  | { ok: true; type: "createVault" }
  | { ok: true; type: "restorePhrase"; wallets: string[] }
  | { ok: true; type: "unlock" }
  | { ok: true; type: "lock" }
  | { ok: true; type: "revealPhrase"; words: string[] }
  | { ok: true; type: "confirmKit" }
  | { ok: true; type: "recoveryStatus"; recovery: RecoveryState }
  | { ok: true; type: "backupStart"; result: BackupStartResult }
  | { ok: true; type: "backupPoll"; result: BackupPollState }
  | { ok: true; type: "restoreBackup"; wallets: string[] }
  | { ok: true; type: "listWallets"; wallets: WalletSummary[] }
  | { ok: true; type: "createWallet"; wallet: WalletSummary }
  | { ok: true; type: "setCaps"; wallet: WalletSummary }
  | { ok: true; type: "sign"; signature: `0x${string}` }
  | {
      ok: false;
      code:
        | "locked"
        | "no_vault"
        | "cap_exceeded"
        | "bad_request"
        | "not_permitted"
        | "password_required"
        | "error";
      message: string;
    };
