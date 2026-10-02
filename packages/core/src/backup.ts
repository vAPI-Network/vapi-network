/**
 * `@vapi-network/core/backup` — the non-custodial vault backup boundary.
 *
 * Backup keys and plaintext exist only on the owner's device. A server may hold
 * only the opaque encrypted envelope produced here. This is a separate package
 * entry point, deliberately not re-exported from the main index, and repository
 * lint rules forbid `packages/mcp` from importing it.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  hkdfSync,
  randomBytes as cryptoRandomBytes,
  scrypt,
  timingSafeEqual,
} from "node:crypto";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open as openFile,
  readFile,
  readdir,
  rm,
} from "node:fs/promises";
import { dirname, join } from "node:path";

import { getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { z } from "zod";

import { agentProfileSchema, listAgentProfiles, type AgentProfileParser } from "./agent-profile.js";
import { writeJsonAtomic } from "./atomic-file.js";
import {
  DEFAULT_CEILING_ATOMIC,
  DEFAULT_SPEND_CAPS,
  getVapiPaths,
  loadConfig,
  spendCapsSchema,
  type SpendCaps,
} from "./config.js";
import { DEVICE_NAME_PATTERN, deviceName } from "./device.js";
import { deriveEvmPrivateKey, phraseToSeed, validateRecoveryPhrase } from "./hd.js";
import {
  listUnfinishedMovementSnapshots,
  markOpenLegsRestored,
  movementTransferKey as transferLegKey,
  readMovement,
  reconcileSignedLegs,
  serializeMovement,
  type Movement,
  type MovementSummary,
} from "./movement.js";
import { parseReceipt, receiptWallet, withReceiptJournalLock, type Receipt } from "./receipts.js";
import { listSwarms, swarmFileSchema, type SwarmFile } from "./swarm.js";
import {
  walletRegistrySchema,
  type RouterRefill,
  type WalletRegistry,
  type WalletStore,
} from "./wallet-store.js";
import { walletNameSchema } from "./wallet-name.js";
import { ARC_MAINNET_CAIP2, BASE_MAINNET_CAIP2 } from "./x402-networks.js";
import {
  createVault,
  exportVaultAccountKey,
  exportVaultPhrase,
  openVault,
  readVaultFileUnlocked,
  reinstateVaultAccount,
  withVaultLock,
  writeVaultFile,
  type VaultAccount,
} from "./vault.js";

export type BackupErrorCode =
  | "backup_too_large"
  | "backup_open_failed"
  | "backup_unsupported"
  | "unsupported_signature"
  | "weak_password"
  | "backup_invalid_input"
  | "backup_snapshot_busy"
  | "relay_open_failed"
  | "relay_invalid_key"
  | "vault_exists";

const ERROR_MESSAGES: Record<BackupErrorCode, string> = {
  backup_too_large: "Backup envelope exceeds 65,536 bytes.",
  backup_open_failed: "Unable to open backup.",
  backup_unsupported: "Unsupported backup envelope.",
  unsupported_signature: "Unsupported signature.",
  weak_password: "Password must contain at least 12 characters.",
  backup_invalid_input: "Invalid backup input.",
  backup_snapshot_busy:
    "Backup files changed while they were being captured. Retry the backup; no backup was created or uploaded.",
  relay_open_failed: "Unable to open relay payload.",
  relay_invalid_key: "Invalid relay key.",
  vault_exists: "A vault already exists.",
};

export class BackupError extends Error {
  readonly code: BackupErrorCode;

  constructor(code: BackupErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "BackupError";
    this.code = code;
  }
}

export type BackupAccount =
  | {
      name: string;
      kind: "derived";
      index: number;
      address: `0x${string}`;
      createdAt: string;
    }
  | {
      name: string;
      kind: "imported";
      address: `0x${string}`;
      privateKey: `0x${string}`;
      createdAt: string;
    };

export type BackupRegistryAccountV1 = {
  name: string;
  label?: string;
  spendCaps: SpendCaps;
};

export type BackupRegistryAccountV2 = BackupRegistryAccountV1 & {
  ceilingAtomic?: string | null;
  routerRefill?: RouterRefill;
};

export type BackupRegistryV1 = {
  default?: string;
  accounts: BackupRegistryAccountV1[];
  networks: string[];
};

/** The original registry name remains an alias for source compatibility. */
export type BackupRegistry = BackupRegistryV1;

export type BackupRegistryV2 = {
  default?: string;
  accounts: BackupRegistryAccountV2[];
  networks: string[];
};

export type BackupAgentProfile = {
  version: 1;
  name: string;
  wallet: string;
  model: string;
  instructions: string;
  verifiedOnly: boolean;
  approveAboveUsd: number;
  maxSteps: number;
  paused: boolean;
  createdAt: string;
  tools: string[];
  /** Present only when the profile grants something (swarm leads and members). */
  grants?: ("read" | "delegate" | "allocate")[];
};

export type BackupSwarm = SwarmFile;

export type BackupMovement =
  | Movement
  | {
      v: 1;
      id: string;
      reason: "distribute";
      from: string;
      network: "eip155:8453" | "eip155:5042";
      createdAt: string;
      legs: {
        to: string;
        amountUsd: string;
        nonce: string;
        status: "planned" | "sent" | "failed" | "unknown";
        txHash?: string;
        reason?: string;
        retryable?: boolean;
      }[];
    };

export type BackupTransferReceipt = {
  id: string;
  timestamp: string;
  kind: "transfer";
  wallet: string;
  resourceUrl: string;
  quote: {
    network: string;
    asset: string;
    amountAtomic: string;
  };
  transfer: NonNullable<Receipt["transfer"]>;
  error?: NonNullable<Receipt["error"]>;
};

export type BackupPlaintextV1 = {
  v: 1;
  phrase: string;
  nextDerivedIndex: number;
  accounts: BackupAccount[];
  registry: BackupRegistryV1;
  protected: boolean;
};

export type BackupPlaintextV2 = {
  v: 2;
  phrase: string;
  nextDerivedIndex: number;
  accounts: BackupAccount[];
  registry: BackupRegistryV2;
  protected: boolean;
  agents?: BackupAgentProfile[];
  swarms?: BackupSwarm[];
  movements?: BackupMovement[];
  transferReceipts?: BackupTransferReceipt[];
};

export type BackupPlaintext = BackupPlaintextV1 | BackupPlaintextV2;

export type BackupSourceV1 = Omit<BackupPlaintextV1, "v">;
export type BackupSourceV2 = Omit<
  BackupPlaintextV2,
  "v" | "agents" | "swarms" | "movements" | "transferReceipts"
> & {
  agents: BackupAgentProfile[];
  swarms: BackupSwarm[];
  movements: BackupMovement[];
  transferReceipts: BackupTransferReceipt[];
  skipped?: BackupExportSkipped[];
};
export type BackupSource = BackupSourceV1 | BackupSourceV2;
export type BackupOmittedSection = "agents" | "swarms" | "movements";

export type BackupExportSkipped = {
  kind: "agent";
  name: string;
  reason: "invalid_profile";
};

export type BackupRestoreBaseResult = {
  accounts: VaultAccount[];
  default?: string;
  protected: boolean;
  networks: string[];
};

export type BackupRestoreSkipped = {
  kind: "agent" | "swarm" | "movement" | "receipt";
  name: string;
  reason: string;
};

export type BackupRestoreConflict = {
  kind: BackupRestoreSkipped["kind"];
  name: string;
  path: string;
};

export type BackupRestoreV2Result = BackupRestoreBaseResult & {
  agents: string[];
  swarms: string[];
  movements: MovementSummary[];
  skipped: BackupRestoreSkipped[];
  conflicts: BackupRestoreConflict[];
};

export type BackupRestoreResult = BackupRestoreBaseResult | BackupRestoreV2Result;

export type BackupKdf =
  { name: "hkdf-sha256"; salt: string } | { name: "scrypt"; salt: string; N: 131_072; r: 8; p: 1 };

export type BackupHeader = {
  format: "vapi-vault-backup";
  v: 1;
  owner: `0x${string}`;
  device: string;
  createdAt: string;
  kdf: BackupKdf;
  cipher: { name: "aes-256-gcm"; nonce: string };
};

export type VaultBackupTypedData = {
  domain: { name: "vAPI Vault Backup"; version: "1" };
  types: {
    VaultBackupKey: readonly [
      { readonly name: "purpose"; readonly type: "string" },
      { readonly name: "site"; readonly type: "string" },
      { readonly name: "owner"; readonly type: "address" },
      { readonly name: "version"; readonly type: "uint256" },
    ];
  };
  primaryType: "VaultBackupKey";
  message: {
    purpose: string;
    site: "vapinetwork.ai";
    owner: `0x${string}`;
    version: 1;
  };
};

type RandomBytes = (length: number) => Uint8Array;
type SignatureInput = string | Uint8Array;
type ProbeSigner = (typedData: VaultBackupTypedData) => Promise<string>;
type OwnerKey = {
  kdf: "hkdf-sha256" | "scrypt";
  key: Uint8Array;
  salt: Uint8Array;
};

const BACKUP_FORMAT = "vapi-vault-backup";
const BACKUP_VERSION = 1;
const CIPHER_NAME = "aes-256-gcm";
const MAX_BACKUP_BYTES = 65_536;
const MAX_SEALED_BYTES = 131_072;
const SCRYPT_N = 131_072;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_MAXMEM = 256 * 1024 * 1024;
const RESTORE_MARKER_FILE = ".backup-restore.json";
const restoreDigestSchema = z.string().regex(/^[0-9a-f]{64}$/u);
const restoreMarkerSchema = z.strictObject({
  v: z.literal(1),
  fingerprint: restoreDigestSchema,
  vaultSha256: restoreDigestSchema,
  registrySha256: restoreDigestSchema,
  mac: restoreDigestSchema,
});
type RestoreMarker = z.infer<typeof restoreMarkerSchema>;
type RestorePublishStep = {
  kind: "marker" | "safety" | "vault" | "registry" | "agent" | "swarm" | "movement";
  name?: string;
};
const SECP256K1_ORDER = BigInt(
  "0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141",
);
const SECP256K1_HALF_ORDER = SECP256K1_ORDER / 2n;
const OWNER_PATTERN = /^0x[0-9a-f]{40}$/u;
const OWNER_INPUT_PATTERN = /^0x[0-9a-fA-F]{40}$/u;
const DEVICE_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/u;
const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/u;
const PRIVATE_KEY_PATTERN = /^0x[0-9a-fA-F]{64}$/u;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]*$/u;
const CAIP2_PATTERN = /^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}$/u;
const ISO_UTC_MILLISECONDS_PATTERN =
  /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{3}Z$/u;
const RELAY_FORMAT = "vapi-vault-relay";
const RELAY_VERSION = 1;
const RELAY_INFO = Buffer.from("vapi-vault-relay/v1", "utf8");
const RELAY_PLAINTEXT_LIMIT = 65_536;
const X25519_PRIVATE_DER_PREFIX = Buffer.from("302e020100300506032b656e04220420", "hex");
const X25519_PUBLIC_DER_PREFIX = Buffer.from("302a300506032b656e032100", "hex");
const CROCKFORD_BASE32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

const isoUtcMillisecondsSchema = z.string().refine(isIsoUtcMilliseconds);
const addressSchema = z.custom<`0x${string}`>(
  (value) => typeof value === "string" && ADDRESS_PATTERN.test(value),
);
const privateKeySchema = z.custom<`0x${string}`>(
  (value) => typeof value === "string" && PRIVATE_KEY_PATTERN.test(value),
);
const safeNonnegativeIntegerSchema = z.number().int().nonnegative().refine(Number.isSafeInteger);
const accountFields = {
  name: walletNameSchema,
  address: addressSchema,
  createdAt: isoUtcMillisecondsSchema,
};
const backupAccountSchema = z.discriminatedUnion("kind", [
  z
    .object({
      name: accountFields.name,
      kind: z.literal("derived"),
      index: safeNonnegativeIntegerSchema,
      address: accountFields.address,
      createdAt: accountFields.createdAt,
    })
    .strict(),
  z
    .object({
      name: accountFields.name,
      kind: z.literal("imported"),
      address: accountFields.address,
      privateKey: privateKeySchema,
      createdAt: accountFields.createdAt,
    })
    .strict(),
]);
const backupRegistryAccountSchema = z
  .object({
    name: walletNameSchema,
    label: z.string().optional(),
    spendCaps: spendCapsSchema.strict(),
  })
  .strict();
const backupRegistryV1Schema = z
  .object({
    default: walletNameSchema.optional(),
    accounts: z.array(backupRegistryAccountSchema),
    networks: z.array(z.string().regex(CAIP2_PATTERN)),
  })
  .strict();
const routerRefillSchema = z.strictObject({
  belowUsd: z.number().finite().min(0),
  tierUsd: z.union([z.literal(1), z.literal(5), z.literal(20), z.literal(50)]),
});
const backupRegistryAccountV2Schema = z.strictObject({
  name: walletNameSchema,
  label: z.string().optional(),
  spendCaps: spendCapsSchema.strict(),
  ceilingAtomic: z.string().regex(/^\d+$/u).nullable().optional(),
  routerRefill: routerRefillSchema.optional(),
});
const backupRegistryV2Schema = z.strictObject({
  default: walletNameSchema.optional(),
  accounts: z.array(backupRegistryAccountV2Schema),
  networks: z.array(z.string().regex(CAIP2_PATTERN)),
});
const backupAgentProfileSchema = z.strictObject({
  version: z.literal(1),
  name: walletNameSchema,
  wallet: z.string(),
  model: z.string().min(1),
  instructions: z.string().max(20_000),
  verifiedOnly: z.boolean(),
  approveAboveUsd: z.number().min(0),
  maxSteps: z.number().int().min(1).max(50),
  paused: z.boolean(),
  createdAt: z.string(),
  tools: z.array(z.string().min(1)),
  grants: z
    .array(z.enum(["read", "delegate", "allocate"]))
    .min(1)
    .optional(),
});
const movementIdSchema = z.string().regex(/^mv_[A-Za-z0-9_-]{8,128}$/u);
const movementNonceSchema = z.string().regex(/^0x[0-9a-fA-F]{64}$/u);
const movementAmountSchema = z.string().regex(/^\d+\.\d{2}$/u);
const movementStatusSchema = z.enum(["planned", "sent", "failed", "unknown"]);
const movementV2StatusSchema = z.enum(["planned", "sent", "failed", "unknown", "cancelled"]);
const movementOptionalFields = {
  txHash: z
    .string()
    .regex(/^0x[0-9a-fA-F]+$/u)
    .optional(),
  reason: z.string().min(1).optional(),
  retryable: z.boolean().optional(),
};
const backupMovementV1Schema = z.strictObject({
  v: z.literal(1),
  id: movementIdSchema,
  reason: z.literal("distribute"),
  from: walletNameSchema,
  network: z.enum([BASE_MAINNET_CAIP2, ARC_MAINNET_CAIP2]),
  createdAt: z.iso.datetime(),
  legs: z
    .array(
      z.strictObject({
        to: z.string().trim().min(1),
        amountUsd: movementAmountSchema,
        nonce: movementNonceSchema,
        status: movementStatusSchema,
        ...movementOptionalFields,
      }),
    )
    .min(1),
});
const backupMovementV2Schema = z.strictObject({
  v: z.literal(2),
  id: movementIdSchema,
  reason: z.enum(["distribute", "allocate", "rebalance", "delegate", "sweep", "send"]),
  from: walletNameSchema,
  treasury: walletNameSchema.optional(),
  network: z.enum([BASE_MAINNET_CAIP2, ARC_MAINNET_CAIP2]),
  createdAt: z.iso.datetime(),
  legs: z
    .array(
      z.strictObject({
        from: walletNameSchema,
        to: z.string().trim().min(1),
        amountUsd: movementAmountSchema,
        purpose: z.enum(["send", "sweep"]),
        nonce: movementNonceSchema,
        status: movementV2StatusSchema,
        ...movementOptionalFields,
      }),
    )
    .min(1),
});
const backupMovementSchema = z.discriminatedUnion("v", [
  backupMovementV1Schema,
  backupMovementV2Schema,
]);
const backupTransferRequestSchema = z.strictObject({
  authorization: z.strictObject({
    from: addressSchema,
    to: addressSchema,
    value: z.string().regex(/^\d+$/u),
    validAfter: z.string().regex(/^\d+$/u),
    validBefore: z.string().regex(/^\d+$/u),
    nonce: movementNonceSchema,
  }),
  signature: z.string().regex(/^0x[0-9a-fA-F]+$/u),
});
const backupTransferSchema = z.strictObject({
  to: addressSchema,
  toName: z.string().min(1),
  toKind: z.enum(["owner", "account"]),
  amountAtomic: z.string().regex(/^\d+$/u),
  network: z.string().min(1),
  nonce: movementNonceSchema,
  status: z.enum(["sent", "unknown", "failed"]),
  txHash: z
    .string()
    .regex(/^0x[0-9a-fA-F]+$/u)
    .nullable(),
  replayed: z.boolean(),
  reservedOn: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/u)
    .optional(),
  request: backupTransferRequestSchema.optional(),
});
const backupTransferReceiptSchema = z
  .strictObject({
    id: z.string().min(1),
    timestamp: z.iso.datetime(),
    kind: z.literal("transfer"),
    wallet: walletNameSchema,
    resourceUrl: z.url(),
    quote: z.strictObject({
      network: z.string().min(1),
      asset: z.string().min(1),
      amountAtomic: z.string().regex(/^\d+$/u),
    }),
    transfer: backupTransferSchema,
    error: z.strictObject({ code: z.string(), message: z.string() }).optional(),
  })
  .superRefine((receipt, context) => {
    try {
      parseReceipt(receipt);
    } catch {
      context.addIssue({ code: "custom", message: "Invalid transfer receipt." });
    }
  });
const backupSourceV1Schema = z
  .object({
    phrase: z.string().min(1),
    nextDerivedIndex: safeNonnegativeIntegerSchema,
    accounts: z.array(backupAccountSchema),
    registry: backupRegistryV1Schema,
    protected: z.boolean(),
  })
  .strict()
  .superRefine(validateBackupSourceRelationships);
const backupSourceV2Schema = z
  .strictObject({
    phrase: z.string().min(1),
    nextDerivedIndex: safeNonnegativeIntegerSchema,
    accounts: z.array(backupAccountSchema),
    registry: backupRegistryV2Schema,
    protected: z.boolean(),
    agents: z.array(backupAgentProfileSchema),
    swarms: z.array(swarmFileSchema),
    movements: z.array(backupMovementSchema),
    transferReceipts: z.array(backupTransferReceiptSchema),
    skipped: z
      .array(
        z.strictObject({
          kind: z.literal("agent"),
          name: z.string().min(1),
          reason: z.literal("invalid_profile"),
        }),
      )
      .optional(),
  })
  .superRefine((source, context) => {
    validateBackupSourceRelationships(source, context);
    validateBackupV2Uniqueness(source, context);
  });
const backupSourceSchema = z.union([backupSourceV1Schema, backupSourceV2Schema]);
const backupPlaintextV1Schema = z.strictObject({
  v: z.literal(1),
  phrase: z.string().min(1),
  nextDerivedIndex: safeNonnegativeIntegerSchema,
  accounts: z.array(backupAccountSchema),
  registry: backupRegistryV1Schema,
  protected: z.boolean(),
});
const backupPlaintextV2Schema = z.strictObject({
  v: z.literal(2),
  phrase: z.string().min(1),
  nextDerivedIndex: safeNonnegativeIntegerSchema,
  accounts: z.array(backupAccountSchema),
  registry: backupRegistryV2Schema,
  protected: z.boolean(),
  agents: z.array(backupAgentProfileSchema).optional(),
  swarms: z.array(swarmFileSchema).optional(),
  movements: z.array(backupMovementSchema).optional(),
  transferReceipts: z.array(backupTransferReceiptSchema).optional(),
});
const backupPlaintextSchema = z
  .discriminatedUnion("v", [backupPlaintextV1Schema, backupPlaintextV2Schema])
  .superRefine((plaintext, context) => {
    validateBackupSourceRelationships(plaintext, context);
    if (plaintext.v === 2) validateBackupV2Uniqueness(plaintext, context);
  });

export function VAULT_BACKUP_TYPED_DATA(owner: string): VaultBackupTypedData {
  const checksummedOwner = checksummedAddress(owner);
  return {
    domain: { name: "vAPI Vault Backup", version: "1" },
    types: {
      VaultBackupKey: [
        { name: "purpose", type: "string" },
        { name: "site", type: "string" },
        { name: "owner", type: "address" },
        { name: "version", type: "uint256" },
      ],
    },
    primaryType: "VaultBackupKey",
    message: {
      purpose:
        "Derive the key that encrypts and decrypts my vAPI agent vault backups. Only sign this on vapinetwork.ai.",
      site: "vapinetwork.ai",
      owner: checksummedOwner,
      version: 1,
    },
  };
}

export function normalizeSignature(signature: SignatureInput): Uint8Array {
  const bytes = decodeSignature(signature);
  const recovery = bytes[64];
  if (recovery !== 0 && recovery !== 1 && recovery !== 27 && recovery !== 28) {
    bytes.fill(0);
    throw new BackupError("unsupported_signature");
  }

  let normalizedRecovery = recovery < 27 ? recovery + 27 : recovery;
  const s = BigInt(`0x${bytes.subarray(32, 64).toString("hex")}`);
  if (s === 0n || s >= SECP256K1_ORDER) {
    bytes.fill(0);
    throw new BackupError("unsupported_signature");
  }
  if (s > SECP256K1_HALF_ORDER) {
    const lowS = (SECP256K1_ORDER - s).toString(16).padStart(64, "0");
    bytes.set(Buffer.from(lowS, "hex"), 32);
    normalizedRecovery = normalizedRecovery === 27 ? 28 : 27;
  }
  bytes[64] = normalizedRecovery;
  const normalized = Uint8Array.from(bytes);
  bytes.fill(0);
  return normalized;
}

export function deriveKeyFromSignature(options: {
  signature: SignatureInput;
  salt: Uint8Array;
  owner: string;
  device: string;
}): Uint8Array {
  assertBytes(options.salt, 32);
  const owner = normalizedOwner(options.owner);
  assertDevice(options.device);

  const normalizedSignature = normalizeSignature(options.signature);
  const signature = Buffer.from(normalizedSignature);
  normalizedSignature.fill(0);
  const salt = Buffer.from(options.salt);
  const info = Buffer.from(`vapi-vault-backup/v1|${owner}|${options.device}`, "utf8");
  try {
    return hkdfSha256(signature, salt, info);
  } finally {
    signature.fill(0);
    salt.fill(0);
  }
}

export async function deriveKeyFromPassword(options: {
  password: string;
  salt: Uint8Array;
}): Promise<Uint8Array> {
  if (typeof options.password !== "string") throw new BackupError("backup_invalid_input");
  assertBytes(options.salt, 32);

  const normalized = options.password.normalize("NFKC");
  if ([...normalized].length < 12) throw new BackupError("weak_password");
  const password = Buffer.from(normalized, "utf8");
  const salt = Buffer.from(options.salt);
  try {
    return await scryptSha256(password, salt);
  } finally {
    password.fill(0);
    salt.fill(0);
  }
}

export async function probeRepeatable(
  sign: ProbeSigner,
  owner: string,
): Promise<{ path: "signature"; signature: `0x${string}` } | { path: "password" }> {
  let typedData: VaultBackupTypedData;
  try {
    if (typeof sign !== "function") throw new Error();
    typedData = VAULT_BACKUP_TYPED_DATA(owner);
  } catch {
    throw new BackupError("backup_invalid_input");
  }
  let first: Uint8Array;
  try {
    first = normalizeSignature(await sign(typedData));
  } catch (error) {
    if (error instanceof BackupError && error.code === "unsupported_signature") {
      return { path: "password" };
    }
    throw new BackupError("backup_invalid_input");
  }

  let second: Uint8Array;
  try {
    second = normalizeSignature(await sign(typedData));
  } catch (error) {
    first.fill(0);
    if (error instanceof BackupError && error.code === "unsupported_signature") {
      return { path: "password" };
    }
    throw new BackupError("backup_invalid_input");
  }

  try {
    if (!bytesEqual(first, second)) return { path: "password" };
    const encoded = Buffer.from(first);
    try {
      return { path: "signature", signature: `0x${encoded.toString("hex")}` };
    } finally {
      encoded.fill(0);
    }
  } finally {
    first.fill(0);
    second.fill(0);
  }
}

export async function createBackup(options: {
  vault: BackupSource;
  ownerKey: OwnerKey;
  owner: string;
  device: string;
  now?: () => Date;
  randomBytes?: RandomBytes;
}): Promise<{
  envelope: string;
  bytes: number;
  omitted?: BackupOmittedSection[];
}> {
  const parsed = backupSourceSchema.safeParse(options.vault);
  if (!parsed.success) throw new BackupError("backup_invalid_input");
  const owner = normalizedOwner(options.owner);
  assertDevice(options.device);
  assertOwnerKey(options.ownerKey);

  const createdAt = readCreatedAt(options.now ?? (() => new Date()));
  const randomBytes = options.randomBytes ?? cryptoRandomBytes;
  const nonce = readRandomBytes(randomBytes, 12);
  const salt = encodeBase64Url(options.ownerKey.salt);
  const kdf: BackupKdf =
    options.ownerKey.kdf === "hkdf-sha256"
      ? { name: "hkdf-sha256", salt }
      : { name: "scrypt", salt, N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P };
  const cipher = { name: CIPHER_NAME, nonce: encodeBase64Url(nonce) } as const;
  const header: BackupHeader = {
    format: BACKUP_FORMAT,
    v: BACKUP_VERSION,
    owner,
    device: options.device,
    createdAt,
    kdf,
    cipher,
  };
  const key = Buffer.from(options.ownerKey.key);
  try {
    const candidates = backupCandidates(parsed.data);
    for (const candidate of candidates) {
      const plaintext = Buffer.from(JSON.stringify(candidate.plaintext), "utf8");
      let encrypted: Buffer | undefined;
      try {
        encrypted = encryptAesGcm(
          key,
          nonce,
          plaintext,
          Buffer.from(buildBackupAad(header), "utf8"),
        );
        const envelope = JSON.stringify({
          format: header.format,
          v: header.v,
          owner: header.owner,
          device: header.device,
          createdAt: header.createdAt,
          kdf: header.kdf,
          cipher: header.cipher,
          ciphertext: encodeBase64Url(encrypted),
        });
        const bytes = Buffer.byteLength(envelope, "utf8");
        const relayPayload = buildRelayRestorePayload({
          owner,
          device: "d".repeat(32),
          kdf,
          key: Buffer.alloc(32),
          vault: candidate.plaintext,
        });
        const relayBytes = Buffer.byteLength(relayPayload, "utf8");
        if (bytes <= MAX_BACKUP_BYTES && relayBytes <= RELAY_PLAINTEXT_LIMIT) {
          return {
            envelope,
            bytes,
            ...(candidate.omitted.length === 0 ? {} : { omitted: candidate.omitted }),
          };
        }
      } finally {
        plaintext.fill(0);
        encrypted?.fill(0);
      }
    }
    throw new BackupError("backup_too_large");
  } finally {
    key.fill(0);
    nonce.fill(0);
  }
}

export async function openBackup(options: {
  envelope: string;
  key: Uint8Array;
}): Promise<BackupPlaintext> {
  const parsed = parseEnvelope(options.envelope);
  if (!(options.key instanceof Uint8Array) || options.key.byteLength !== 32) {
    throw new BackupError("backup_open_failed");
  }

  const encrypted = decodeBase64Url(parsed.ciphertext);
  if (!encrypted || encrypted.byteLength < 16) throw new BackupError("backup_open_failed");
  const nonce = decodeBase64Url(parsed.header.cipher.nonce);
  if (!nonce) throw new BackupError("backup_open_failed");
  const key = Buffer.from(options.key);
  let plaintext: Buffer | undefined;
  try {
    plaintext = decryptAesGcm(
      key,
      nonce,
      encrypted,
      Buffer.from(buildBackupAad(parsed.header), "utf8"),
    );
    const json = new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
    const value: unknown = JSON.parse(json);
    const validated = backupPlaintextSchema.safeParse(value);
    if (!validated.success) throw new BackupError("backup_open_failed");
    return validated.data.v === 1
      ? buildPlaintextV1(validated.data)
      : buildPlaintextV2(validated.data);
  } catch {
    throw new BackupError("backup_open_failed");
  } finally {
    key.fill(0);
    nonce.fill(0);
    encrypted.fill(0);
    plaintext?.fill(0);
  }
}

export function readBackupHeader(envelope: string): BackupHeader {
  const { header } = parseEnvelope(envelope);
  return {
    format: header.format,
    v: header.v,
    owner: header.owner,
    device: header.device,
    createdAt: header.createdAt,
    kdf: { ...header.kdf },
    cipher: { ...header.cipher },
  };
}

export function createRelayKeyPair(options: { randomBytes?: RandomBytes } = {}): {
  publicKey: Uint8Array;
  privateKey: Uint8Array;
} {
  const privateKey = readRelayRandomBytes(options.randomBytes ?? cryptoRandomBytes, 32);
  try {
    const publicKey = x25519PublicFromPrivate(privateKey);
    try {
      return {
        publicKey: Uint8Array.from(publicKey),
        privateKey: Uint8Array.from(privateKey),
      };
    } finally {
      publicKey.fill(0);
    }
  } catch {
    throw new BackupError("relay_invalid_key");
  } finally {
    privateKey.fill(0);
  }
}

export function relayCode(publicKey: Uint8Array): string {
  assertRelayKey(publicKey);
  const digest = createHash("sha256").update(publicKey).digest();
  try {
    let bits = BigInt(`0x${digest.subarray(0, 8).toString("hex")}`) >> 4n;
    const characters = Array.from({ length: 12 }, () => "0");
    for (let index = characters.length - 1; index >= 0; index -= 1) {
      characters[index] = CROCKFORD_BASE32[Number(bits & 31n)]!;
      bits >>= 5n;
    }
    const code = characters.join("");
    return `${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8)}`;
  } finally {
    digest.fill(0);
  }
}

export function sealTo(options: {
  recipientPublicKey: Uint8Array;
  plaintext: Uint8Array | string;
  randomBytes?: RandomBytes;
}): string {
  const plaintext = relayPlaintext(options.plaintext);
  const randomBytes = options.randomBytes ?? cryptoRandomBytes;
  let recipientPublicKey: Buffer | undefined;
  let ephemeralPrivateKey: Buffer | undefined;
  let ephemeralPublicKey: Buffer | undefined;
  let nonce: Buffer | undefined;
  let shared: Buffer | undefined;
  let key: Uint8Array | undefined;
  let encrypted: Buffer | undefined;
  try {
    if (plaintext.byteLength > RELAY_PLAINTEXT_LIMIT) {
      throw new BackupError("backup_too_large");
    }
    assertRelayKey(options.recipientPublicKey);
    recipientPublicKey = Buffer.from(options.recipientPublicKey);
    ephemeralPrivateKey = readRelayRandomBytes(randomBytes, 32);
    try {
      ephemeralPublicKey = x25519PublicFromPrivate(ephemeralPrivateKey);
      shared = x25519SharedSecret(ephemeralPrivateKey, recipientPublicKey);
      assertNonzeroSharedSecret(shared);
    } catch {
      throw new BackupError("relay_invalid_key");
    }
    nonce = readRelayRandomBytes(randomBytes, 12);
    const encodedPublicKey = encodeBase64Url(ephemeralPublicKey);
    const encodedNonce = encodeBase64Url(nonce);
    const salt = Buffer.concat([ephemeralPublicKey, recipientPublicKey]);
    try {
      key = hkdfSha256(shared, salt, RELAY_INFO);
    } finally {
      salt.fill(0);
    }
    encrypted = encryptAesGcm(
      key,
      nonce,
      plaintext,
      Buffer.from(buildRelayAad(encodedPublicKey, encodedNonce), "utf8"),
    );
    return JSON.stringify({
      format: RELAY_FORMAT,
      v: RELAY_VERSION,
      epk: encodedPublicKey,
      nonce: encodedNonce,
      ciphertext: encodeBase64Url(encrypted),
    });
  } finally {
    plaintext.fill(0);
    recipientPublicKey?.fill(0);
    ephemeralPrivateKey?.fill(0);
    ephemeralPublicKey?.fill(0);
    nonce?.fill(0);
    shared?.fill(0);
    key?.fill(0);
    encrypted?.fill(0);
  }
}

export function openSealed(options: {
  recipientPrivateKey: Uint8Array;
  sealed: string;
}): Uint8Array {
  let recipientPrivateKey: Buffer | undefined;
  let ephemeralPublicKey: Buffer | undefined;
  let nonce: Buffer | undefined;
  let encrypted: Buffer | undefined;
  let shared: Buffer | undefined;
  let key: Uint8Array | undefined;
  let plaintext: Buffer | undefined;
  try {
    if (
      typeof options.sealed !== "string" ||
      Buffer.byteLength(options.sealed, "utf8") > MAX_SEALED_BYTES ||
      !(options.recipientPrivateKey instanceof Uint8Array) ||
      options.recipientPrivateKey.byteLength !== 32
    ) {
      throw new Error();
    }
    const parsed = parseSealed(options.sealed);
    recipientPrivateKey = Buffer.from(options.recipientPrivateKey);
    ephemeralPublicKey = decodeBase64Url(parsed.epk);
    nonce = decodeBase64Url(parsed.nonce);
    encrypted = decodeBase64Url(parsed.ciphertext);
    if (
      ephemeralPublicKey?.byteLength !== 32 ||
      nonce?.byteLength !== 12 ||
      encrypted === undefined ||
      encrypted.byteLength < 16
    ) {
      throw new Error();
    }
    shared = x25519SharedSecret(recipientPrivateKey, ephemeralPublicKey);
    assertNonzeroSharedSecret(shared);
    const recipientPublicKey = x25519PublicFromPrivate(recipientPrivateKey);
    const salt = Buffer.concat([ephemeralPublicKey, recipientPublicKey]);
    try {
      key = hkdfSha256(shared, salt, RELAY_INFO);
    } finally {
      recipientPublicKey.fill(0);
      salt.fill(0);
    }
    plaintext = decryptAesGcm(
      key,
      nonce,
      encrypted,
      Buffer.from(buildRelayAad(parsed.epk, parsed.nonce), "utf8"),
    );
    if (plaintext.byteLength > RELAY_PLAINTEXT_LIMIT) throw new Error();
    return Uint8Array.from(plaintext);
  } catch {
    throw new BackupError("relay_open_failed");
  } finally {
    recipientPrivateKey?.fill(0);
    ephemeralPublicKey?.fill(0);
    nonce?.fill(0);
    encrypted?.fill(0);
    shared?.fill(0);
    key?.fill(0);
    plaintext?.fill(0);
  }
}

export function buildRelayRestorePayload(options: {
  owner: string;
  device: string;
  kdf: BackupKdf;
  key: Uint8Array;
  vault: BackupPlaintext;
}): string {
  try {
    const owner = normalizedOwner(options.owner);
    assertDevice(options.device);
    assertBytes(options.key, 32);
    if (!isRecord(options.kdf)) throw new Error();
    const kdf = parseKdf(options.kdf);
    const parsed = backupPlaintextSchema.safeParse(options.vault);
    if (!parsed.success) throw new Error();
    const vault =
      parsed.data.v === 1 ? buildPlaintextV1(parsed.data) : buildPlaintextV2(parsed.data);
    return JSON.stringify({
      format: "vapi-vault-relay-payload",
      v: 1,
      purpose: "restore",
      owner,
      device: options.device,
      kdf,
      key: encodeBase64Url(options.key),
      vault,
    });
  } catch {
    throw new BackupError("backup_invalid_input");
  }
}

export async function exportBackupSource(options: {
  store: WalletStore;
  vaultKey: Uint8Array;
  networks?: readonly string[];
  agentProfileSchema?: AgentProfileParser;
}): Promise<BackupSourceV2> {
  try {
    assertBytes(options.vaultKey, 32);
    if (
      !isRecord(options.store) ||
      typeof options.store.home !== "string" ||
      typeof options.store.snapshot !== "function" ||
      typeof options.store.reload !== "function"
    ) {
      throw new BackupError("backup_invalid_input");
    }
    const networks = normalizeNetworks(options.networks ?? []);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await exportBackupSourceAttempt(options, networks);
      } catch (error) {
        if (!(error instanceof BackupSnapshotChangedError)) throw error;
      }
    }
    throw new BackupError("backup_snapshot_busy");
  } catch (error) {
    if (error instanceof BackupError && error.code === "backup_snapshot_busy") throw error;
    throw new BackupError("backup_invalid_input");
  }
}

class BackupSnapshotChangedError extends Error {}

async function exportBackupSourceAttempt(
  options: {
    store: WalletStore;
    vaultKey: Uint8Array;
    agentProfileSchema?: AgentProfileParser;
  },
  networks: string[],
): Promise<BackupSourceV2> {
  const path = join(options.store.home, "vault.json");
  const { phrase, file, accounts } = await withVaultLock(path, async () => {
    const [phrase, vault, file] = await Promise.all([
      exportVaultPhrase({ path, key: options.vaultKey }),
      openVault({ path, key: options.vaultKey }),
      readVaultFileUnlocked(path),
    ]);
    const accounts: BackupAccount[] = [];
    for (const account of vault.accounts()) {
      if (account.kind === "derived") {
        accounts.push({ ...account });
      } else {
        const privateKey = await exportVaultAccountKey({
          path,
          key: options.vaultKey,
          name: account.name,
        });
        accounts.push({ ...account, privateKey });
      }
    }
    return { phrase, file, accounts };
  });
  const snapshot = await options.store.reload();
  const names = new Set(accounts.map((account) => account.name));
  const home = options.store.home;
  const skipped: BackupExportSkipped[] = [];
  const [agents, swarms, movementSnapshots] = await Promise.all([
    listAgentProfiles(home, {
      schema: options.agentProfileSchema ?? agentProfileSchema,
      warn: () => undefined,
      onInvalid: (profileFile) => {
        skipped.push({
          kind: "agent",
          name: profileFile.endsWith(".json") ? profileFile.slice(0, -5) : profileFile,
          reason: "invalid_profile",
        });
      },
    }),
    listSwarms(home),
    listUnfinishedMovementSnapshots({ home }),
  ]);
  const localMovements = await Promise.all(
    movementSnapshots.map(async ({ summary }) => await readMovement(home, summary.id)),
  );
  localMovements.sort(compareMovements);
  const expectedSignedFailedLegs = movementSnapshots.flatMap(
    ({ signedFailedLegKeys }) => signedFailedLegKeys,
  );
  const receipts = await readReceiptJournal(getVapiPaths(home).receipts);
  const receiptLegs = new Set(
    receipts.flatMap((receipt) =>
      receipt.kind === "transfer" && receipt.transfer !== undefined
        ? [transferLegKey(receiptWallet(receipt), receipt.transfer.nonce)]
        : [],
    ),
  );
  const requiredReceiptLegs = new Set([
    ...expectedSignedFailedLegs,
    ...localMovements.flatMap((movement) =>
      movement.legs
        .filter((leg) => leg.status === "unknown")
        .map((leg) => transferLegKey(leg.from, leg.nonce)),
    ),
  ]);
  const verifiedFile = await readVaultFileUnlocked(path);
  const verifiedSnapshot = await options.store.reload();
  if (
    [...requiredReceiptLegs].some((leg) => !receiptLegs.has(leg)) ||
    JSON.stringify(file) !== JSON.stringify(verifiedFile) ||
    JSON.stringify(snapshot) !== JSON.stringify(verifiedSnapshot)
  ) {
    throw new BackupSnapshotChangedError();
  }

  const movements = localMovements.map(toBackupMovement);
  const includedLegs = new Set(
    localMovements.flatMap((movement) =>
      movement.legs.map((leg) => transferLegKey(leg.from, leg.nonce)),
    ),
  );
  const transferReceipts = receipts
    .filter(
      (
        receipt,
      ): receipt is Receipt & { kind: "transfer"; transfer: NonNullable<Receipt["transfer"]> } =>
        receipt.kind === "transfer" &&
        receipt.transfer !== undefined &&
        includedLegs.has(transferLegKey(receiptWallet(receipt), receipt.transfer.nonce)),
    )
    .map(toBackupTransferReceipt);
  const source: BackupSourceV2 = {
    phrase,
    nextDerivedIndex:
      file.nextDerivedIndex ??
      accounts.reduce(
        (next, account) => (account.kind === "derived" ? Math.max(next, account.index + 1) : next),
        0,
      ),
    accounts,
    registry: {
      ...(snapshot.default !== undefined && names.has(snapshot.default)
        ? { default: snapshot.default }
        : {}),
      accounts: accounts.map((account) => {
        const entry = snapshot.wallets[account.name];
        const ceilingAtomic =
          entry?.ceilingAtomic === null
            ? null
            : (entry?.ceilingAtomic ?? DEFAULT_CEILING_ATOMIC.toString());
        return {
          name: account.name,
          ...(entry?.label === undefined ? {} : { label: entry.label }),
          spendCaps: {
            perCallAtomic: entry?.spendCaps.perCallAtomic ?? DEFAULT_SPEND_CAPS.perCallAtomic,
            perDayAtomic: entry?.spendCaps.perDayAtomic ?? DEFAULT_SPEND_CAPS.perDayAtomic,
          },
          ...(ceilingAtomic === DEFAULT_CEILING_ATOMIC.toString() ? {} : { ceilingAtomic }),
          ...(entry?.routerRefill === undefined
            ? {}
            : {
                routerRefill: {
                  belowUsd: entry.routerRefill.belowUsd,
                  tierUsd: entry.routerRefill.tierUsd,
                },
              }),
        };
      }),
      networks,
    },
    protected: file.protected,
    agents: agents
      .map(({ grants, ...profile }) =>
        backupAgentProfileSchema.parse(
          grants === undefined || grants.length === 0 ? profile : { ...profile, grants },
        ),
      )
      .sort(compareNamedValues),
    swarms: [...swarms].sort(compareNamedValues),
    movements,
    transferReceipts,
    ...(skipped.length === 0 ? {} : { skipped: skipped.sort(compareNamedValues) }),
  };
  if (!backupSourceSchema.safeParse(source).success) {
    throw new BackupError("backup_invalid_input");
  }
  return source;
}

type RestoreFromBackupOptions<T extends BackupPlaintext = BackupPlaintext> = {
  plaintext: T;
  home: string;
  vaultKey: Uint8Array;
  now?: () => Date;
  device?: string;
};

type RestoreBackupPlaintextOptions<T extends BackupPlaintext = BackupPlaintext> =
  RestoreFromBackupOptions<T> & {
    beforePublish?: (paths: { vault: string; registry: string }) => Promise<void>;
    afterPublish?: (step: RestorePublishStep) => Promise<void>;
  };

export function restoreFromBackup(
  options: RestoreFromBackupOptions<BackupPlaintextV1>,
): Promise<BackupRestoreBaseResult>;
export function restoreFromBackup(
  options: RestoreFromBackupOptions<BackupPlaintextV2>,
): Promise<BackupRestoreV2Result>;
export function restoreFromBackup(options: RestoreFromBackupOptions): Promise<BackupRestoreResult>;
export async function restoreFromBackup(
  options: RestoreFromBackupOptions,
): Promise<BackupRestoreResult> {
  return await restoreBackupPlaintext(options);
}

export function parseBackupPlaintext(value: unknown): BackupPlaintext {
  return validateRestorePlaintext(value);
}

export function restoreBackupPlaintext(
  options: RestoreBackupPlaintextOptions<BackupPlaintextV1>,
): Promise<BackupRestoreBaseResult>;
export function restoreBackupPlaintext(
  options: RestoreBackupPlaintextOptions<BackupPlaintextV2>,
): Promise<BackupRestoreV2Result>;
export function restoreBackupPlaintext(
  options: RestoreBackupPlaintextOptions,
): Promise<BackupRestoreResult>;
export async function restoreBackupPlaintext(
  options: RestoreBackupPlaintextOptions,
): Promise<BackupRestoreResult> {
  const plaintext = parseBackupPlaintext(options.plaintext);
  if (typeof options.home !== "string" || options.home.length === 0) {
    throw new BackupError("backup_invalid_input");
  }
  if (options.device !== undefined && !DEVICE_NAME_PATTERN.test(options.device)) {
    throw new BackupError("backup_invalid_input");
  }
  try {
    assertBytes(options.vaultKey, 32);
  } catch {
    throw new BackupError("backup_invalid_input");
  }
  const vaultPath = join(options.home, "vault.json");
  const registryPath = join(options.home, "wallets.json");
  let stagingHome: string | undefined;
  let beforePublishError: unknown;
  let afterPublishError: unknown;
  try {
    await mkdir(options.home, { recursive: true, mode: 0o700 });
    stagingHome = await mkdtemp(join(options.home, ".backup-restore-"));
    const stagedVaultPath = join(stagingHome, "vault.json");
    const stagedRegistryPath = join(stagingHome, "wallets.json");
    await createVault({
      path: stagedVaultPath,
      key: options.vaultKey,
      phrase: plaintext.phrase,
      ...(options.now === undefined ? {} : { now: options.now }),
    });

    for (const account of plaintext.accounts) {
      if (account.kind === "derived") {
        await reinstateVaultAccount({ path: stagedVaultPath, key: options.vaultKey, account });
      } else {
        const vault = await openVault({
          path: stagedVaultPath,
          key: options.vaultKey,
          now: () => new Date(account.createdAt),
        });
        await vault.importAccount(account.name, account.privateKey);
      }
    }
    await withVaultLock(stagedVaultPath, async () => {
      const file = await readVaultFileUnlocked(stagedVaultPath);
      const backedUpAccounts = new Map(
        plaintext.accounts.map((account) => [account.name, account]),
      );
      await writeVaultFile(stagedVaultPath, {
        ...file,
        accounts: file.accounts.map((account) => {
          const backedUp = backedUpAccounts.get(account.name);
          if (backedUp === undefined) throw new BackupError("backup_invalid_input");
          return {
            ...account,
            address: backedUp.address,
            createdAt: backedUp.createdAt,
          };
        }),
        nextDerivedIndex: plaintext.nextDerivedIndex,
      });
    });

    const registry = buildRestoredRegistry(plaintext);
    const handle = await openFile(stagedRegistryPath, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(registry, null, 2)}\n`, "utf8");
    } finally {
      await handle.close();
    }
    const stagedV2 =
      plaintext.v === 2
        ? await stageV2Restore({
            plaintext,
            stagingHome,
            home: options.home,
            ...(options.device === undefined ? {} : { device: options.device }),
          })
        : undefined;
    const accounts = (await openVault({ path: stagedVaultPath, key: options.vaultKey })).accounts();
    const baseResult: BackupRestoreBaseResult = {
      accounts,
      ...(plaintext.registry.default === undefined ? {} : { default: plaintext.registry.default }),
      protected: plaintext.protected,
      networks: [...plaintext.registry.networks],
    };
    const markerPath = join(options.home, RESTORE_MARKER_FILE);
    const fingerprint = restoreFingerprint(
      plaintext,
      stagedV2?.restoreDevice ?? options.device,
      options.vaultKey,
    );

    await withVaultLock(vaultPath, async () => {
      const existingVault = await pathExists(vaultPath);
      const existingRegistry = await pathExists(registryPath);
      let marker: RestoreMarker;
      if (existingVault || existingRegistry) {
        if (!existingVault) throw new BackupError("vault_exists");
        marker = await readRestoreMarker(markerPath, fingerprint, options.vaultKey);
        if ((await sha256File(vaultPath)) !== marker.vaultSha256) {
          throw new BackupError("vault_exists");
        }
        if (existingRegistry) {
          if ((await sha256File(registryPath)) !== marker.registrySha256) {
            throw new BackupError("vault_exists");
          }
        } else if ((await sha256File(stagedRegistryPath)) !== marker.registrySha256) {
          throw new BackupError("vault_exists");
        }
      } else {
        marker = await createRestoreMarker(
          stagedVaultPath,
          stagedRegistryPath,
          fingerprint,
          options.vaultKey,
        );
        await writeJsonAtomic(markerPath, marker, { mode: 0o600 });
        await notifyRestorePublish(options.afterPublish, { kind: "marker" }, (error) => {
          afterPublishError = error;
        });
      }
      if (stagedV2 !== undefined) {
        await publishV2RestoreSafety(stagedV2, options.home);
        await notifyRestorePublish(options.afterPublish, { kind: "safety" }, (error) => {
          afterPublishError = error;
        });
      }
      try {
        await options.beforePublish?.({ vault: stagedVaultPath, registry: stagedRegistryPath });
      } catch (error) {
        beforePublishError = error;
        throw error;
      }
      if (!existingVault && !existingRegistry) {
        const refreshedMarker = await createRestoreMarker(
          stagedVaultPath,
          stagedRegistryPath,
          fingerprint,
          options.vaultKey,
        );
        if (
          refreshedMarker.vaultSha256 !== marker.vaultSha256 ||
          refreshedMarker.registrySha256 !== marker.registrySha256
        ) {
          marker = refreshedMarker;
          await writeJsonAtomic(markerPath, marker, { mode: 0o600 });
        }
      }
      let publishedVault = false;
      if (!existingVault) {
        try {
          await link(stagedVaultPath, vaultPath);
          publishedVault = true;
        } catch (error) {
          await rm(markerPath, { force: true }).catch(() => undefined);
          throw error;
        }
        await notifyRestorePublish(options.afterPublish, { kind: "vault" }, (error) => {
          afterPublishError = error;
        });
      }
      if (!existingRegistry) {
        try {
          await link(stagedRegistryPath, registryPath);
        } catch (error) {
          if (publishedVault) await rm(vaultPath, { force: true }).catch(() => undefined);
          await rm(markerPath, { force: true }).catch(() => undefined);
          throw error;
        }
        await notifyRestorePublish(options.afterPublish, { kind: "registry" }, (error) => {
          afterPublishError = error;
        });
      }
      if (stagedV2 !== undefined) {
        await publishV2Restore(stagedV2, options.home, async (step) => {
          await notifyRestorePublish(options.afterPublish, step, (error) => {
            afterPublishError = error;
          });
        });
      }
      await rm(markerPath, { force: true });
    });
    if (stagedV2 === undefined) return baseResult;
    return {
      ...baseResult,
      agents: stagedV2.restoredAgents,
      swarms: stagedV2.restoredSwarms,
      movements: stagedV2.restoredMovements,
      skipped: stagedV2.skipped,
      conflicts: stagedV2.conflicts,
    };
  } catch (error) {
    if (error === beforePublishError) throw error;
    if (error === afterPublishError) throw error;
    if (error instanceof BackupError && error.code === "vault_exists") throw error;
    if (
      isExistingFile(error) ||
      (await pathExists(vaultPath).catch(() => false)) ||
      (await pathExists(registryPath).catch(() => false))
    ) {
      throw new BackupError("vault_exists");
    }
    throw new BackupError("backup_invalid_input");
  } finally {
    if (stagingHome !== undefined) {
      await rm(stagingHome, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

type RestoreFileKind = "agent" | "swarm" | "movement";
type StagedRestoreFile = {
  kind: RestoreFileKind;
  name: string;
  stagedPath: string;
  targetPath: string;
};
type StagedRestoreReceipt = {
  name: string;
  line: string;
  legKey: string;
};
type StagedRestoreMovement = StagedRestoreFile & {
  movement: Movement;
};
type StagedV2Restore = {
  agents: StagedRestoreFile[];
  swarms: StagedRestoreFile[];
  movements: StagedRestoreMovement[];
  backupMovementIds: string[];
  receipts: StagedRestoreReceipt[];
  signedReceiptKeys: Set<string>;
  receiptsPath?: string;
  restoredAgents: string[];
  restoredSwarms: string[];
  restoredMovements: MovementSummary[];
  skipped: BackupRestoreSkipped[];
  conflicts: BackupRestoreConflict[];
  restoreDevice?: string;
};

async function stageV2Restore(options: {
  plaintext: BackupPlaintextV2;
  stagingHome: string;
  home: string;
  device?: string;
}): Promise<StagedV2Restore> {
  const skipped: BackupRestoreSkipped[] = [];
  const conflicts: BackupRestoreConflict[] = [];
  const accounts = new Map(options.plaintext.accounts.map((account) => [account.name, account]));
  const validAgents = (options.plaintext.agents ?? []).filter((profile) => {
    if (accounts.has(profile.wallet)) return true;
    skipped.push({ kind: "agent", name: profile.name, reason: "missing_account" });
    return false;
  });

  const validSwarms = (options.plaintext.swarms ?? []).filter((swarm) => {
    const treasury = accounts.get(swarm.treasury.account);
    if (treasury === undefined) {
      if (swarm.treasury.steps.created || swarm.treasury.steps.creating) {
        skipped.push({ kind: "swarm", name: swarm.name, reason: "missing_account" });
        return false;
      }
    } else if (
      swarm.treasury.address !== undefined &&
      swarm.treasury.address.toLowerCase() !== treasury.address.toLowerCase()
    ) {
      skipped.push({ kind: "swarm", name: swarm.name, reason: "address_mismatch" });
      return false;
    }
    for (const member of swarm.members) {
      const account = accounts.get(member.account);
      if (account === undefined) {
        if (member.steps.created || member.steps.creating) {
          skipped.push({ kind: "swarm", name: swarm.name, reason: "missing_account" });
          return false;
        }
        continue;
      }
      if (
        member.address !== undefined &&
        member.address.toLowerCase() !== account.address.toLowerCase()
      ) {
        skipped.push({ kind: "swarm", name: swarm.name, reason: "address_mismatch" });
        return false;
      }
    }
    return true;
  });

  const allMovementLegs = new Set<string>();
  const backupMovementIds: string[] = [];
  const validMovements: Movement[] = [];
  for (const backupMovement of options.plaintext.movements ?? []) {
    const movement = currentMovement(backupMovement);
    backupMovementIds.push(movement.id);
    const legKeys = movement.legs.map((leg) => transferLegKey(leg.from, leg.nonce));
    for (const key of legKeys) allMovementLegs.add(key);
    const senders = new Set([
      movement.from,
      ...(movement.treasury === undefined ? [] : [movement.treasury]),
      ...movement.legs.map((leg) => leg.from),
    ]);
    if ([...senders].some((sender) => !accounts.has(sender))) {
      skipped.push({ kind: "movement", name: movement.id, reason: "missing_account" });
      continue;
    }
    validMovements.push(movement);
  }

  const validReceipts: StagedRestoreReceipt[] = [];
  for (const receipt of options.plaintext.transferReceipts ?? []) {
    const key = transferLegKey(receipt.wallet, receipt.transfer.nonce);
    if (!accounts.has(receipt.wallet)) {
      skipped.push({ kind: "receipt", name: receipt.id, reason: "missing_account" });
    } else if (!allMovementLegs.has(key)) {
      skipped.push({ kind: "receipt", name: receipt.id, reason: "missing_movement" });
    } else {
      validReceipts.push({
        name: receipt.id,
        line: JSON.stringify(parseReceipt(receipt)),
        legKey: key,
      });
    }
  }

  let receiptsPath: string | undefined;
  let stagedReceipts = validReceipts;
  if (validReceipts.length > 0) {
    receiptsPath = getVapiPaths(options.stagingHome).receipts;
    const staged = await stageRestoreBytes(
      receiptsPath,
      `${validReceipts.map((receipt) => receipt.line).join("\n")}\n`,
    );
    if (!staged) {
      for (const receipt of validReceipts) {
        skipped.push({ kind: "receipt", name: receipt.name, reason: "write_failed" });
      }
      stagedReceipts = [];
      receiptsPath = undefined;
    }
  }

  // A backed-up receipt proves that this nonce was already signed even when
  // publishing the receipt later fails. Keep the movement out of the signing
  // path in that case; a resume can fail safely, but it must never sign again.
  const assumedReceiptKeys = new Set(validReceipts.map((receipt) => receipt.legKey));
  try {
    const existingJournal = await readRestoreReceiptJournal(getVapiPaths(options.home).receipts);
    for (const key of existingJournal.signedKeys) assumedReceiptKeys.add(key);
  } catch {
    // An unreadable journal cannot prove another signed nonce during staging.
  }
  const agents: StagedRestoreFile[] = [];
  for (const profile of validAgents) {
    const stagedPath = join(options.stagingHome, "agents", `${profile.name}.json`);
    if (await stageRestoreBytes(stagedPath, prettyJson(profile))) {
      agents.push({
        kind: "agent",
        name: profile.name,
        stagedPath,
        targetPath: join(options.home, "agents", `${profile.name}.json`),
      });
    } else {
      skipped.push({ kind: "agent", name: profile.name, reason: "write_failed" });
    }
  }

  let restoreDevice = options.device;
  if (validSwarms.length > 0 && restoreDevice === undefined) {
    try {
      restoreDevice = deviceName({ config: await loadConfig(getVapiPaths(options.home).config) });
    } catch {
      for (const swarm of validSwarms) {
        skipped.push({ kind: "swarm", name: swarm.name, reason: "write_failed" });
      }
    }
  }
  const swarms: StagedRestoreFile[] = [];
  if (restoreDevice !== undefined) {
    for (const value of validSwarms) {
      const swarm = swarmFileSchema.parse({ ...value, device: restoreDevice });
      const stagedPath = join(options.stagingHome, "swarms", `${swarm.name}.json`);
      if (await stageRestoreBytes(stagedPath, prettyJson(swarm))) {
        swarms.push({
          kind: "swarm",
          name: swarm.name,
          stagedPath,
          targetPath: join(options.home, "swarms", `${swarm.name}.json`),
        });
      } else {
        skipped.push({ kind: "swarm", name: swarm.name, reason: "write_failed" });
      }
    }
  }

  const movements: StagedRestoreMovement[] = [];
  for (const movement of validMovements) {
    const restored = reconcileRestoredMovement(movement, assumedReceiptKeys);
    const stagedPath = join(options.stagingHome, "movements", `${restored.id}.json`);
    if (await stageRestoreBytes(stagedPath, serializeMovement(restored))) {
      movements.push({
        kind: "movement",
        name: restored.id,
        stagedPath,
        targetPath: join(options.home, "movements", `${restored.id}.json`),
        movement: restored,
      });
    } else {
      skipped.push({ kind: "movement", name: restored.id, reason: "write_failed" });
    }
  }

  return {
    agents,
    swarms,
    movements,
    backupMovementIds,
    receipts: stagedReceipts,
    signedReceiptKeys: assumedReceiptKeys,
    ...(receiptsPath === undefined ? {} : { receiptsPath }),
    restoredAgents: [],
    restoredSwarms: [],
    restoredMovements: [],
    skipped,
    conflicts,
    ...(restoreDevice === undefined ? {} : { restoreDevice }),
  };
}

async function publishV2Restore(
  staged: StagedV2Restore,
  home: string,
  afterPublish?: (step: RestorePublishStep) => Promise<void>,
): Promise<void> {
  for (const file of staged.agents) {
    const outcome = await publishRestoreFile(file, staged);
    if (outcome === "restored") staged.restoredAgents.push(file.name);
    if (outcome === "restored") await afterPublish?.({ kind: "agent", name: file.name });
  }
  for (const file of staged.swarms) {
    const outcome = await publishRestoreFile(file, staged);
    if (outcome === "restored") staged.restoredSwarms.push(file.name);
    if (outcome === "restored") await afterPublish?.({ kind: "swarm", name: file.name });
  }

  const restoredMovementIds: string[] = [];
  for (const file of staged.movements) {
    const outcome = await publishRestoreFile(file, staged);
    if (outcome === "restored") restoredMovementIds.push(file.movement.id);
    if (outcome === "restored") await afterPublish?.({ kind: "movement", name: file.name });
  }
  await reconcilePublishedMovements(staged, home);
  for (const id of restoredMovementIds) {
    try {
      staged.restoredMovements.push(movementSummary(await readMovement(home, id)));
    } catch {
      staged.skipped.push({ kind: "movement", name: id, reason: "write_failed" });
    }
  }
}

async function publishV2RestoreSafety(staged: StagedV2Restore, home: string): Promise<void> {
  for (const id of staged.backupMovementIds) {
    await markOpenLegsRestored(home, id);
  }
  await publishRestoreReceipts(staged, getVapiPaths(home).receipts);
  await reconcilePublishedMovements(staged, home, true);
}

async function publishRestoreFile(
  file: StagedRestoreFile,
  staged: StagedV2Restore,
): Promise<"restored" | "conflict" | "failed"> {
  try {
    const directory = dirname(file.targetPath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    try {
      await link(file.stagedPath, file.targetPath);
      await chmod(file.targetPath, 0o600);
      return "restored";
    } catch (error) {
      if (!isExistingFile(error)) throw error;
    }
    let identical = false;
    try {
      const [source, target] = await Promise.all([
        readFile(file.stagedPath),
        readFile(file.targetPath),
      ]);
      identical = source.equals(target);
    } catch {
      // An existing non-file or unreadable target is still a no-clobber conflict.
    }
    if (identical) {
      await chmod(file.targetPath, 0o600);
      return "restored";
    }
    staged.conflicts.push({
      kind: file.kind,
      name: file.name,
      path: file.targetPath,
    });
    return "conflict";
  } catch {
    staged.skipped.push({ kind: file.kind, name: file.name, reason: "write_failed" });
    return "failed";
  }
}

async function publishRestoreReceipts(
  staged: StagedV2Restore,
  targetPath: string,
): Promise<Set<string>> {
  return await withReceiptJournalLock(targetPath, async () =>
    publishRestoreReceiptsLocked(staged, targetPath),
  );
}

async function publishRestoreReceiptsLocked(
  staged: StagedV2Restore,
  targetPath: string,
): Promise<Set<string>> {
  const restored = new Set<string>();
  if (staged.receipts.length === 0 || staged.receiptsPath === undefined) return restored;
  let existing = "";
  let existingLines = new Set<string>();
  try {
    await readFile(staged.receiptsPath, "utf8");
    await mkdir(dirname(targetPath), { recursive: true, mode: 0o700 });
    try {
      const journal = await readRestoreReceiptJournal(targetPath);
      existing = journal.raw;
      existingLines = journal.lines;
      await chmod(targetPath, 0o600);
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }
  } catch {
    for (const receipt of staged.receipts) {
      staged.skipped.push({ kind: "receipt", name: receipt.name, reason: "write_failed" });
    }
    return restored;
  }

  let needsLeadingNewline = existing.length > 0 && !existing.endsWith("\n");
  for (const receipt of staged.receipts) {
    if (existingLines.has(receipt.line)) {
      restored.add(receipt.legKey);
      continue;
    }
    let handle: Awaited<ReturnType<typeof openFile>> | undefined;
    try {
      handle = await openFile(targetPath, "a", 0o600);
      await handle.chmod(0o600);
      await handle.writeFile(`${needsLeadingNewline ? "\n" : ""}${receipt.line}\n`, "utf8");
      await handle.close();
      handle = undefined;
      needsLeadingNewline = false;
      existingLines.add(receipt.line);
      restored.add(receipt.legKey);
    } catch {
      await handle?.close().catch(() => undefined);
      staged.skipped.push({ kind: "receipt", name: receipt.name, reason: "write_failed" });
    }
  }
  return restored;
}

async function reconcilePublishedMovements(
  staged: StagedV2Restore,
  home: string,
  requireDurableSafety = false,
): Promise<void> {
  const signedKeys = new Set(staged.signedReceiptKeys);
  const journaledKeys = new Set<string>();
  try {
    const journal = await readRestoreReceiptJournal(getVapiPaths(home).receipts);
    for (const key of journal.signedKeys) {
      signedKeys.add(key);
      journaledKeys.add(key);
    }
  } catch {
    // Backed-up receipt keys still protect their legs when the journal is unreadable.
  }
  if (signedKeys.size === 0) return;
  const unjournaledKeys = new Set([...signedKeys].filter((key) => !journaledKeys.has(key)));

  let files: string[];
  try {
    files = await readdir(join(home, "movements"));
  } catch (error) {
    if (isMissingFile(error)) return;
    if (requireDurableSafety && unjournaledKeys.size > 0) throw error;
    return;
  }
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const id = file.slice(0, -5);
    let movement: Movement;
    try {
      movement = await readMovement(home, id);
    } catch (error) {
      if (requireDurableSafety && unjournaledKeys.size > 0) throw error;
      continue;
    }
    if (
      !movement.legs.some(
        (leg) =>
          leg.status !== "sent" &&
          leg.status !== "cancelled" &&
          signedKeys.has(transferLegKey(leg.from, leg.nonce)),
      )
    ) {
      continue;
    }
    try {
      await reconcileSignedLegs(home, id, signedKeys);
    } catch (error) {
      staged.skipped.push({ kind: "movement", name: id, reason: "write_failed" });
      if (
        requireDurableSafety &&
        movement.legs.some(
          (leg) =>
            leg.status !== "sent" &&
            leg.status !== "cancelled" &&
            unjournaledKeys.has(transferLegKey(leg.from, leg.nonce)),
        )
      ) {
        throw error;
      }
    }
  }
}

async function stageRestoreBytes(path: string, bytes: string): Promise<boolean> {
  let handle: Awaited<ReturnType<typeof openFile>> | undefined;
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    handle = await openFile(path, "wx", 0o600);
    await handle.writeFile(bytes, "utf8");
    await handle.close();
    return true;
  } catch {
    await handle?.close().catch(() => undefined);
    return false;
  }
}

function currentMovement(movement: BackupMovement): Movement {
  if (movement.v === 2) return movement;
  return {
    ...movement,
    v: 2,
    legs: movement.legs.map((leg) => ({
      ...leg,
      from: movement.from,
      purpose: "send" as const,
    })),
  };
}

function reconcileRestoredMovement(movement: Movement, receiptKeys: ReadonlySet<string>): Movement {
  return {
    ...movement,
    legs: movement.legs.map((leg) => {
      if (leg.status === "cancelled") return leg;
      return leg.status !== "sent" && receiptKeys.has(transferLegKey(leg.from, leg.nonce))
        ? {
            from: leg.from,
            to: leg.to,
            amountUsd: leg.amountUsd,
            purpose: leg.purpose,
            nonce: leg.nonce,
            status: "unknown" as const,
            restored: true as const,
          }
        : { ...leg, restored: true as const };
    }),
  };
}

function movementSummary(movement: Movement): MovementSummary {
  return {
    id: movement.id,
    from: movement.from,
    network: movement.network,
    createdAt: movement.createdAt,
    pendingLegs: movement.legs.filter((leg) => leg.status === "planned").length,
    unknownLegs: movement.legs.filter((leg) => leg.status === "unknown").length,
  };
}

function prettyJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function parseSealed(sealed: string): {
  epk: string;
  nonce: string;
  ciphertext: string;
} {
  const value: unknown = JSON.parse(sealed);
  if (
    !isRecord(value) ||
    !hasExactKeys(value, RELAY_KEYS) ||
    value.format !== RELAY_FORMAT ||
    value.v !== RELAY_VERSION ||
    typeof value.epk !== "string" ||
    typeof value.nonce !== "string" ||
    typeof value.ciphertext !== "string" ||
    decodeBase64Url(value.epk)?.byteLength !== 32 ||
    decodeBase64Url(value.nonce)?.byteLength !== 12 ||
    (decodeBase64Url(value.ciphertext)?.byteLength ?? 0) < 16
  ) {
    throw new Error();
  }
  return { epk: value.epk, nonce: value.nonce, ciphertext: value.ciphertext };
}

function relayPlaintext(value: Uint8Array | string): Buffer {
  if (typeof value === "string") return Buffer.from(value, "utf8");
  if (value instanceof Uint8Array) return Buffer.from(value);
  throw new BackupError("backup_invalid_input");
}

function assertRelayKey(value: Uint8Array): void {
  if (!(value instanceof Uint8Array) || value.byteLength !== 32) {
    throw new BackupError("relay_invalid_key");
  }
}

function readRelayRandomBytes(randomBytes: RandomBytes, length: number): Buffer {
  try {
    const value = randomBytes(length);
    if (!(value instanceof Uint8Array) || value.byteLength !== length) throw new Error();
    return Buffer.from(value);
  } catch {
    throw new BackupError("relay_invalid_key");
  }
}

function x25519PublicFromPrivate(privateKey: Uint8Array): Buffer {
  const der = Buffer.concat([X25519_PRIVATE_DER_PREFIX, privateKey]);
  let exported: Buffer | undefined;
  try {
    const key = createPrivateKey({ key: der, format: "der", type: "pkcs8" });
    exported = Buffer.from(createPublicKey(key).export({ format: "der", type: "spki" }));
    if (
      exported.byteLength !== X25519_PUBLIC_DER_PREFIX.byteLength + 32 ||
      !exported.subarray(0, X25519_PUBLIC_DER_PREFIX.byteLength).equals(X25519_PUBLIC_DER_PREFIX)
    ) {
      throw new Error();
    }
    return Buffer.from(exported.subarray(X25519_PUBLIC_DER_PREFIX.byteLength));
  } finally {
    der.fill(0);
    exported?.fill(0);
  }
}

function x25519SharedSecret(privateKey: Uint8Array, publicKey: Uint8Array): Buffer {
  const privateDer = Buffer.concat([X25519_PRIVATE_DER_PREFIX, privateKey]);
  const publicDer = Buffer.concat([X25519_PUBLIC_DER_PREFIX, publicKey]);
  try {
    return diffieHellman({
      privateKey: createPrivateKey({ key: privateDer, format: "der", type: "pkcs8" }),
      publicKey: createPublicKey({ key: publicDer, format: "der", type: "spki" }),
    });
  } finally {
    privateDer.fill(0);
    publicDer.fill(0);
  }
}

function assertNonzeroSharedSecret(shared: Buffer): void {
  const zero = Buffer.alloc(shared.byteLength);
  try {
    if (shared.byteLength !== 32 || timingSafeEqual(shared, zero)) throw new Error();
  } finally {
    zero.fill(0);
  }
}

function buildRelayAad(ephemeralPublicKey: string, nonce: string): string {
  return [RELAY_FORMAT, String(RELAY_VERSION), ephemeralPublicKey, nonce].join("|");
}

function normalizeNetworks(networks: readonly string[]): string[] {
  if (
    !Array.isArray(networks) ||
    networks.some((network) => typeof network !== "string" || !CAIP2_PATTERN.test(network))
  ) {
    throw new BackupError("backup_invalid_input");
  }
  return [...new Set(networks)].sort();
}

function validateRestorePlaintext(value: unknown): BackupPlaintext {
  try {
    const parsed = backupPlaintextSchema.safeParse(value);
    if (!parsed.success) throw new Error();
    const plaintext =
      parsed.data.v === 1 ? buildPlaintextV1(parsed.data) : buildPlaintextV2(parsed.data);
    const phrase = validateRecoveryPhrase(plaintext.phrase);
    let seed: Uint8Array | undefined;
    try {
      seed = phraseToSeed(phrase);
      for (const account of plaintext.accounts) {
        const address =
          account.kind === "derived"
            ? privateKeyToAccount(deriveEvmPrivateKey(seed, `m/44'/60'/0'/0/${account.index}`))
                .address
            : privateKeyToAccount(account.privateKey).address;
        if (address.toLowerCase() !== account.address.toLowerCase()) throw new Error();
      }
    } finally {
      seed?.fill(0);
    }
    buildRestoredRegistry(plaintext);
    return plaintext;
  } catch {
    throw new BackupError("backup_invalid_input");
  }
}

function buildRestoredRegistry(plaintext: BackupPlaintext): WalletRegistry {
  const wallets: WalletRegistry["wallets"] = {};
  for (let index = 0; index < plaintext.accounts.length; index += 1) {
    const account = plaintext.accounts[index]!;
    const metadata = plaintext.registry.accounts[index]!;
    const metadataV2 = plaintext.v === 2 ? plaintext.registry.accounts[index]! : undefined;
    wallets[account.name] = {
      createdAt: account.createdAt,
      ...(metadata.label === undefined ? {} : { label: metadata.label }),
      spendCaps: {
        perCallAtomic: metadata.spendCaps.perCallAtomic,
        perDayAtomic: metadata.spendCaps.perDayAtomic,
      },
      ...(metadataV2 === undefined
        ? {}
        : {
            ceilingAtomic:
              metadataV2.ceilingAtomic === undefined
                ? DEFAULT_CEILING_ATOMIC.toString()
                : metadataV2.ceilingAtomic,
            ...(metadataV2.routerRefill === undefined
              ? {}
              : {
                  routerRefill: {
                    belowUsd: metadataV2.routerRefill.belowUsd,
                    tierUsd: metadataV2.routerRefill.tierUsd,
                  },
                }),
          }),
    };
  }
  return walletRegistrySchema.parse({
    version: 1,
    ...(plaintext.registry.default === undefined ? {} : { default: plaintext.registry.default }),
    wallets,
  });
}

function restoreFingerprint(
  plaintext: BackupPlaintext,
  device: string | undefined,
  vaultKey: Uint8Array,
): string {
  return createHmac("sha256", vaultKey)
    .update("vapi-backup-restore/v1\n", "utf8")
    .update(JSON.stringify({ device: device ?? null, plaintext }), "utf8")
    .digest("hex");
}

async function createRestoreMarker(
  vaultPath: string,
  registryPath: string,
  fingerprint: string,
  vaultKey: Uint8Array,
): Promise<RestoreMarker> {
  const marker = {
    v: 1 as const,
    fingerprint,
    vaultSha256: await sha256File(vaultPath),
    registrySha256: await sha256File(registryPath),
  };
  return { ...marker, mac: restoreMarkerMac(marker, vaultKey) };
}

async function readRestoreMarker(
  path: string,
  fingerprint: string,
  vaultKey: Uint8Array,
): Promise<RestoreMarker> {
  try {
    const marker = restoreMarkerSchema.parse(JSON.parse(await readFile(path, "utf8")));
    const expectedMac = restoreMarkerMac(marker, vaultKey);
    if (
      marker.fingerprint !== fingerprint ||
      !timingSafeEqual(Buffer.from(marker.mac, "hex"), Buffer.from(expectedMac, "hex"))
    ) {
      throw new Error();
    }
    return marker;
  } catch {
    throw new BackupError("vault_exists");
  }
}

function restoreMarkerMac(
  marker: Omit<RestoreMarker, "mac"> | RestoreMarker,
  vaultKey: Uint8Array,
): string {
  return createHmac("sha256", vaultKey)
    .update(
      `vapi-backup-restore-marker/v1|${marker.fingerprint}|${marker.vaultSha256}|${marker.registrySha256}`,
      "utf8",
    )
    .digest("hex");
}

async function sha256File(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

async function notifyRestorePublish(
  hook: RestoreBackupPlaintextOptions["afterPublish"],
  step: RestorePublishStep,
  rememberError: (error: unknown) => void,
): Promise<void> {
  try {
    await hook?.(step);
  } catch (error) {
    rememberError(error);
    throw error;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isMissingFile(error)) return false;
    throw error;
  }
}

function isMissingFile(error: unknown): boolean {
  return isErrorCode(error, "ENOENT");
}

function isExistingFile(error: unknown): boolean {
  return isErrorCode(error, "EEXIST");
}

function isErrorCode(error: unknown, code: string): boolean {
  return isRecord(error) && Reflect.get(error, "code") === code;
}

function validateBackupSourceRelationships(
  source: BackupSource | BackupPlaintext,
  context: z.RefinementCtx,
): void {
  const names = new Set<string>();
  const derivedIndexes = new Set<number>();
  let highestDerivedIndex = -1;
  for (const account of source.accounts) {
    if (names.has(account.name))
      context.addIssue({ code: "custom", message: "Duplicate account." });
    names.add(account.name);
    if (account.kind === "derived") {
      if (derivedIndexes.has(account.index)) {
        context.addIssue({ code: "custom", message: "Duplicate derived index." });
      }
      derivedIndexes.add(account.index);
      highestDerivedIndex = Math.max(highestDerivedIndex, account.index);
    }
  }
  if (source.nextDerivedIndex <= highestDerivedIndex) {
    context.addIssue({ code: "custom", message: "Invalid next derived index." });
  }
  if (
    source.registry.accounts.length !== source.accounts.length ||
    source.registry.accounts.some((account, index) => account.name !== source.accounts[index]?.name)
  ) {
    context.addIssue({ code: "custom", message: "Registry order does not match accounts." });
  }
  if (source.registry.default !== undefined && !names.has(source.registry.default)) {
    context.addIssue({ code: "custom", message: "Unknown default account." });
  }
  for (let index = 1; index < source.registry.networks.length; index += 1) {
    if (source.registry.networks[index - 1]! >= source.registry.networks[index]!) {
      context.addIssue({ code: "custom", message: "Networks are not sorted and unique." });
      break;
    }
  }
}

function validateBackupV2Uniqueness(
  source: Pick<BackupPlaintextV2, "agents" | "swarms" | "movements">,
  context: z.RefinementCtx,
): void {
  validateUniqueValues(source.agents, (agent) => agent.name, "agent name", context);
  validateUniqueValues(source.swarms, (swarm) => swarm.name, "swarm name", context);
  validateUniqueValues(source.movements, (movement) => movement.id, "movement id", context);
}

function validateUniqueValues<T>(
  values: readonly T[] | undefined,
  key: (value: T) => string,
  label: string,
  context: z.RefinementCtx,
): void {
  if (values === undefined) return;
  const seen = new Set<string>();
  for (const value of values) {
    const current = key(value);
    if (seen.has(current)) {
      context.addIssue({ code: "custom", message: `Duplicate ${label}.` });
    }
    seen.add(current);
  }
}

function buildPlaintextV1(source: BackupSourceV1 | BackupPlaintextV1): BackupPlaintextV1 {
  const accounts: BackupAccount[] = source.accounts.map((account) =>
    account.kind === "derived"
      ? {
          name: account.name,
          kind: "derived",
          index: account.index,
          address: account.address as `0x${string}`,
          createdAt: account.createdAt,
        }
      : {
          name: account.name,
          kind: "imported",
          address: account.address as `0x${string}`,
          privateKey: account.privateKey as `0x${string}`,
          createdAt: account.createdAt,
        },
  );
  const registryAccounts = source.registry.accounts.map((account) => ({
    name: account.name,
    ...(account.label === undefined ? {} : { label: account.label }),
    spendCaps: {
      perCallAtomic: account.spendCaps.perCallAtomic,
      perDayAtomic: account.spendCaps.perDayAtomic,
    },
  }));
  const registry: BackupRegistry = {
    ...(source.registry.default === undefined ? {} : { default: source.registry.default }),
    accounts: registryAccounts,
    networks: [...source.registry.networks],
  };
  return {
    v: 1,
    phrase: source.phrase,
    nextDerivedIndex: source.nextDerivedIndex,
    accounts,
    registry,
    protected: source.protected,
  };
}

function buildPlaintextV2(
  source: BackupSourceV2 | BackupPlaintextV2,
  included: {
    agents?: boolean;
    swarms?: boolean;
    movements?: boolean;
  } = { agents: true, swarms: true, movements: true },
): BackupPlaintextV2 {
  const accounts = buildPlaintextV1({
    phrase: source.phrase,
    nextDerivedIndex: source.nextDerivedIndex,
    accounts: source.accounts,
    registry: {
      ...(source.registry.default === undefined ? {} : { default: source.registry.default }),
      accounts: source.registry.accounts,
      networks: source.registry.networks,
    },
    protected: source.protected,
  }).accounts;
  const registry: BackupRegistryV2 = {
    ...(source.registry.default === undefined ? {} : { default: source.registry.default }),
    accounts: source.registry.accounts.map((account) => ({
      name: account.name,
      ...(account.label === undefined ? {} : { label: account.label }),
      spendCaps: {
        perCallAtomic: account.spendCaps.perCallAtomic,
        perDayAtomic: account.spendCaps.perDayAtomic,
      },
      ...(account.ceilingAtomic === undefined ||
      account.ceilingAtomic === DEFAULT_CEILING_ATOMIC.toString()
        ? {}
        : { ceilingAtomic: account.ceilingAtomic }),
      ...(account.routerRefill === undefined
        ? {}
        : {
            routerRefill: {
              belowUsd: account.routerRefill.belowUsd,
              tierUsd: account.routerRefill.tierUsd,
            },
          }),
    })),
    networks: [...source.registry.networks],
  };
  const agents = source.agents;
  const swarms = source.swarms;
  const movements = source.movements;
  const transferReceipts = source.transferReceipts;
  return {
    v: 2,
    phrase: source.phrase,
    nextDerivedIndex: source.nextDerivedIndex,
    accounts,
    registry,
    protected: source.protected,
    ...(included.agents !== false && agents !== undefined && agents.length > 0
      ? { agents: [...agents].sort(compareNamedValues).map(copyAgentProfile) }
      : {}),
    ...(included.swarms !== false && swarms !== undefined && swarms.length > 0
      ? { swarms: [...swarms].sort(compareNamedValues).map(copySwarm) }
      : {}),
    ...(included.movements !== false && movements !== undefined && movements.length > 0
      ? { movements: [...movements].sort(compareMovements).map(copyMovement) }
      : {}),
    ...(included.movements !== false &&
    transferReceipts !== undefined &&
    transferReceipts.length > 0
      ? { transferReceipts: transferReceipts.map(copyTransferReceipt) }
      : {}),
  };
}

function backupCandidates(source: BackupSource): {
  plaintext: BackupPlaintext;
  omitted: BackupOmittedSection[];
}[] {
  if (!isBackupSourceV2(source)) {
    return [{ plaintext: buildPlaintextV1(source), omitted: [] }];
  }
  const candidates: {
    plaintext: BackupPlaintext;
    omitted: BackupOmittedSection[];
  }[] = [];
  const included = { agents: true, swarms: true, movements: true };
  const omitted: BackupOmittedSection[] = [];
  const addCandidate = () => {
    candidates.push({
      plaintext: hasV2OnlyData(source, included)
        ? buildPlaintextV2(source, included)
        : buildPlaintextV1(source),
      omitted: [...omitted],
    });
  };
  addCandidate();
  if (source.agents.length > 0) {
    included.agents = false;
    omitted.push("agents");
    addCandidate();
  }
  if (source.swarms.length > 0) {
    included.swarms = false;
    omitted.push("swarms");
    addCandidate();
  }
  if (source.movements.length > 0 || source.transferReceipts.length > 0) {
    included.movements = false;
    omitted.push("movements");
    addCandidate();
  }
  return candidates;
}

function hasV2OnlyData(
  source: BackupSourceV2,
  included: { agents?: boolean; swarms?: boolean; movements?: boolean },
): boolean {
  return (
    source.registry.accounts.some(
      (account) =>
        (account.ceilingAtomic !== undefined &&
          account.ceilingAtomic !== DEFAULT_CEILING_ATOMIC.toString()) ||
        account.routerRefill !== undefined,
    ) ||
    (included.agents !== false && source.agents.length > 0) ||
    (included.swarms !== false && source.swarms.length > 0) ||
    (included.movements !== false &&
      (source.movements.length > 0 || source.transferReceipts.length > 0))
  );
}

function isBackupSourceV2(source: BackupSource): source is BackupSourceV2 {
  return "agents" in source;
}

function copyAgentProfile(profile: BackupAgentProfile): BackupAgentProfile {
  return {
    version: profile.version,
    name: profile.name,
    wallet: profile.wallet,
    model: profile.model,
    instructions: profile.instructions,
    verifiedOnly: profile.verifiedOnly,
    approveAboveUsd: profile.approveAboveUsd,
    maxSteps: profile.maxSteps,
    paused: profile.paused,
    createdAt: profile.createdAt,
    tools: [...profile.tools],
    ...(profile.grants === undefined ? {} : { grants: [...profile.grants] }),
  };
}

function copySwarm(swarm: BackupSwarm): BackupSwarm {
  return swarmFileSchema.parse(swarm);
}

function copyMovement(movement: BackupMovement): BackupMovement {
  return toBackupMovement(movement);
}

function toBackupMovement(movement: BackupMovement): BackupMovement {
  if (movement.v === 1) return backupMovementSchema.parse(movement);
  return backupMovementSchema.parse({
    ...movement,
    legs: movement.legs.map(
      ({
        restored: _restored,
        fromAddress: _fromAddress,
        toAddress: _toAddress,
        addressBindingSource: _addressBindingSource,
        ...leg
      }) => leg,
    ),
  });
}

function toBackupTransferReceipt(
  receipt: Receipt & { kind: "transfer"; transfer: NonNullable<Receipt["transfer"]> },
): BackupTransferReceipt {
  if (receipt.quote?.asset === undefined) throw new BackupError("backup_invalid_input");
  return copyTransferReceipt({
    id: receipt.id,
    timestamp: receipt.timestamp,
    kind: "transfer",
    wallet: receiptWallet(receipt),
    resourceUrl: receipt.resourceUrl,
    quote: {
      network: receipt.quote.network,
      asset: receipt.quote.asset,
      amountAtomic: receipt.quote.amountAtomic,
    },
    transfer: receipt.transfer,
    ...(receipt.error === undefined ? {} : { error: receipt.error }),
  });
}

function copyTransferReceipt(receipt: BackupTransferReceipt): BackupTransferReceipt {
  const transfer = receipt.transfer;
  const request = transfer.request;
  // The signed authorization is retained only to replay an already-signed leg,
  // never to sign a new one. The plaintext already contains the recovery phrase,
  // so retaining this request grants no additional signing capability.
  return backupTransferReceiptSchema.parse({
    id: receipt.id,
    timestamp: receipt.timestamp,
    kind: "transfer",
    wallet: receipt.wallet,
    resourceUrl: receipt.resourceUrl,
    quote: {
      network: receipt.quote.network,
      asset: receipt.quote.asset,
      amountAtomic: receipt.quote.amountAtomic,
    },
    transfer: {
      to: transfer.to,
      toName: transfer.toName,
      toKind: transfer.toKind,
      amountAtomic: transfer.amountAtomic,
      network: transfer.network,
      nonce: transfer.nonce,
      status: transfer.status,
      txHash: transfer.txHash,
      replayed: transfer.replayed,
      ...(transfer.reservedOn === undefined ? {} : { reservedOn: transfer.reservedOn }),
      ...(request === undefined
        ? {}
        : {
            request: {
              authorization: {
                from: request.authorization.from,
                to: request.authorization.to,
                value: request.authorization.value,
                validAfter: request.authorization.validAfter,
                validBefore: request.authorization.validBefore,
                nonce: request.authorization.nonce,
              },
              signature: request.signature,
            },
          }),
    },
    ...(receipt.error === undefined
      ? {}
      : { error: { code: receipt.error.code, message: receipt.error.message } }),
  });
}

async function readReceiptJournal(path: string): Promise<Receipt[]> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isMissingFile(error)) return [];
    throw error;
  }
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => parseReceipt(JSON.parse(line)));
}

async function readRestoreReceiptJournal(path: string): Promise<{
  raw: string;
  lines: Set<string>;
  signedKeys: Set<string>;
}> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isMissingFile(error)) return { raw: "", lines: new Set(), signedKeys: new Set() };
    throw error;
  }
  const lines = new Set(raw.split("\n"));
  const signedKeys = new Set<string>();
  for (const line of lines) {
    if (line.trim().length === 0) continue;
    try {
      const receipt = parseReceipt(JSON.parse(line));
      if (receipt.transfer !== undefined) {
        signedKeys.add(transferLegKey(receiptWallet(receipt), receipt.transfer.nonce));
      }
    } catch {
      // Malformed historical rows neither prove a signature nor block appends.
    }
  }
  return { raw, lines, signedKeys };
}

function compareNamedValues(left: { name: string }, right: { name: string }): number {
  return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
}

function compareMovements(left: BackupMovement, right: BackupMovement): number {
  return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
}

function parseEnvelope(envelope: string): { header: BackupHeader; ciphertext: string } {
  if (typeof envelope !== "string") throw new BackupError("backup_unsupported");
  if (Buffer.byteLength(envelope, "utf8") > MAX_BACKUP_BYTES) {
    throw new BackupError("backup_too_large");
  }

  let value: unknown;
  try {
    value = JSON.parse(envelope);
  } catch {
    throw new BackupError("backup_unsupported");
  }
  if (!isRecord(value) || !hasExactKeys(value, ENVELOPE_KEYS)) {
    throw new BackupError("backup_unsupported");
  }
  if (
    value.format !== BACKUP_FORMAT ||
    value.v !== BACKUP_VERSION ||
    typeof value.owner !== "string" ||
    !OWNER_PATTERN.test(value.owner) ||
    typeof value.device !== "string" ||
    !DEVICE_PATTERN.test(value.device) ||
    typeof value.createdAt !== "string" ||
    !isIsoUtcMilliseconds(value.createdAt) ||
    !isRecord(value.kdf) ||
    !isRecord(value.cipher) ||
    typeof value.ciphertext !== "string"
  ) {
    throw new BackupError("backup_unsupported");
  }

  const kdf = parseKdf(value.kdf);
  if (
    !hasExactKeys(value.cipher, CIPHER_KEYS) ||
    value.cipher.name !== CIPHER_NAME ||
    typeof value.cipher.nonce !== "string" ||
    decodeBase64Url(value.cipher.nonce)?.byteLength !== 12 ||
    decodeBase64Url(value.ciphertext) === undefined
  ) {
    throw new BackupError("backup_unsupported");
  }

  return {
    header: {
      format: BACKUP_FORMAT,
      v: BACKUP_VERSION,
      owner: value.owner as `0x${string}`,
      device: value.device,
      createdAt: value.createdAt,
      kdf,
      cipher: { name: CIPHER_NAME, nonce: value.cipher.nonce },
    },
    ciphertext: value.ciphertext,
  };
}

const ENVELOPE_KEYS = [
  "format",
  "v",
  "owner",
  "device",
  "createdAt",
  "kdf",
  "cipher",
  "ciphertext",
] as const;
const RELAY_KEYS = ["format", "v", "epk", "nonce", "ciphertext"] as const;
const CIPHER_KEYS = ["name", "nonce"] as const;
const HKDF_KEYS = ["name", "salt"] as const;
const SCRYPT_KEYS = ["name", "salt", "N", "r", "p"] as const;

function parseKdf(value: Record<string, unknown>): BackupKdf {
  if (value.name === "hkdf-sha256" && hasExactKeys(value, HKDF_KEYS)) {
    if (typeof value.salt !== "string" || decodeBase64Url(value.salt)?.byteLength !== 32) {
      throw new BackupError("backup_unsupported");
    }
    return { name: "hkdf-sha256", salt: value.salt };
  }
  if (value.name === "scrypt" && hasExactKeys(value, SCRYPT_KEYS)) {
    if (
      typeof value.salt !== "string" ||
      decodeBase64Url(value.salt)?.byteLength !== 32 ||
      value.N !== SCRYPT_N ||
      value.r !== SCRYPT_R ||
      value.p !== SCRYPT_P
    ) {
      throw new BackupError("backup_unsupported");
    }
    return { name: "scrypt", salt: value.salt, N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P };
  }
  throw new BackupError("backup_unsupported");
}

function buildBackupAad(header: BackupHeader): string {
  const parameters =
    header.kdf.name === "scrypt"
      ? [String(header.kdf.N), String(header.kdf.r), String(header.kdf.p)]
      : ["", "", ""];
  return [
    header.format,
    String(header.v),
    header.owner,
    header.device,
    header.createdAt,
    header.kdf.name,
    header.kdf.salt,
    ...parameters,
    header.cipher.nonce,
  ].join("|");
}

function encryptAesGcm(
  key: Uint8Array,
  nonce: Uint8Array,
  plaintext: Uint8Array,
  aad: Uint8Array,
): Buffer {
  const cipher = createCipheriv(CIPHER_NAME, key, nonce, { authTagLength: 16 });
  cipher.setAAD(aad);
  return Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
}

function decryptAesGcm(
  key: Uint8Array,
  nonce: Uint8Array,
  encrypted: Buffer,
  aad: Uint8Array,
): Buffer {
  const ciphertext = encrypted.subarray(0, -16);
  const tag = encrypted.subarray(-16);
  const decipher = createDecipheriv(CIPHER_NAME, key, nonce, { authTagLength: 16 });
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  const plaintextChunks: Buffer[] = [];
  try {
    plaintextChunks.push(decipher.update(ciphertext));
    plaintextChunks.push(decipher.final());
    return Buffer.concat(plaintextChunks);
  } finally {
    for (const chunk of plaintextChunks) chunk.fill(0);
  }
}

function hkdfSha256(ikm: Uint8Array, salt: Uint8Array, info: Uint8Array): Uint8Array {
  const output = Buffer.from(hkdfSync("sha256", ikm, salt, info, 32));
  try {
    return Uint8Array.from(output);
  } finally {
    output.fill(0);
  }
}

function scryptSha256(password: Buffer, salt: Buffer): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    scrypt(
      password,
      salt,
      32,
      { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: SCRYPT_MAXMEM },
      (error, key) => {
        if (error) {
          reject(error);
          return;
        }
        try {
          resolve(Uint8Array.from(key));
        } finally {
          key.fill(0);
        }
      },
    );
  });
}

function encodeBase64Url(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

function decodeBase64Url(value: string): Buffer | undefined {
  if (!BASE64URL_PATTERN.test(value) || value.length % 4 === 1) return undefined;
  const decoded = Buffer.from(value, "base64url");
  return decoded.toString("base64url") === value ? decoded : undefined;
}

function decodeSignature(signature: SignatureInput): Buffer {
  if (signature instanceof Uint8Array) {
    if (signature.byteLength !== 65) throw new BackupError("unsupported_signature");
    return Buffer.from(signature);
  }
  if (typeof signature !== "string" || !/^0x[0-9a-fA-F]{130}$/u.test(signature)) {
    throw new BackupError("unsupported_signature");
  }
  return Buffer.from(signature.slice(2), "hex");
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) {
    difference |= left[index]! ^ right[index]!;
  }
  return difference === 0;
}

function checksummedAddress(owner: string): `0x${string}` {
  if (typeof owner !== "string" || !OWNER_INPUT_PATTERN.test(owner)) {
    throw new BackupError("backup_invalid_input");
  }
  return getAddress(owner.toLowerCase());
}

function normalizedOwner(owner: string): `0x${string}` {
  return checksummedAddress(owner).toLowerCase() as `0x${string}`;
}

function assertDevice(device: string): void {
  if (typeof device !== "string" || !DEVICE_PATTERN.test(device)) {
    throw new BackupError("backup_invalid_input");
  }
}

function assertBytes(value: Uint8Array, length: number): void {
  if (!(value instanceof Uint8Array) || value.byteLength !== length) {
    throw new BackupError("backup_invalid_input");
  }
}

function assertOwnerKey(ownerKey: OwnerKey): void {
  if (!isRecord(ownerKey) || (ownerKey.kdf !== "hkdf-sha256" && ownerKey.kdf !== "scrypt")) {
    throw new BackupError("backup_invalid_input");
  }
  assertBytes(ownerKey.key, 32);
  assertBytes(ownerKey.salt, 32);
}

function readRandomBytes(randomBytes: RandomBytes, length: number): Buffer {
  const value = randomBytes(length);
  if (!(value instanceof Uint8Array) || value.byteLength !== length) {
    throw new BackupError("backup_invalid_input");
  }
  return Buffer.from(value);
}

function readCreatedAt(now: () => Date): string {
  const value = now();
  if (!(value instanceof Date) || Number.isNaN(value.valueOf())) {
    throw new BackupError("backup_invalid_input");
  }
  const createdAt = value.toISOString();
  if (!isIsoUtcMilliseconds(createdAt)) throw new BackupError("backup_invalid_input");
  return createdAt;
}

function isIsoUtcMilliseconds(value: string): boolean {
  if (!ISO_UTC_MILLISECONDS_PATTERN.test(value)) return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}
