import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  hkdfSync,
  scryptSync,
} from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { ESLint } from "eslint";
import { encodeFunctionResult, recoverTypedDataAddress } from "viem";
import { mnemonicToAccount, privateKeyToAccount } from "viem/accounts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { readAgentProfile, writeAgentProfile } from "./agent-profile.js";
import * as backup from "./backup.js";
import {
  BackupError,
  createBackup,
  createRelayKeyPair,
  deriveKeyFromPassword,
  deriveKeyFromSignature,
  exportBackupSource,
  normalizeSignature,
  openBackup,
  openSealed,
  probeRepeatable,
  readBackupHeader,
  relayCode,
  restoreFromBackup,
  sealTo,
  VAULT_BACKUP_TYPED_DATA,
  type BackupPlaintext,
  type BackupPlaintextV1,
  type BackupPlaintextV2,
  type BackupSource,
  type BackupSourceV2,
  type BackupTransferReceipt,
} from "./backup.js";
import * as index from "./index.js";
import {
  cancelMovement,
  executeMovement,
  listUnfinishedMovements,
  readMovement,
  serializeMovement,
  type Movement,
} from "./movement.js";
import { appendReceipt, renameReceiptWallet, type Receipt } from "./receipts.js";
import type { SecretStore } from "./secret-store.js";
import { readSpendLedger, reserveSpend } from "./spend-policy.js";
import { writeSwarm, type SwarmFile } from "./swarm.js";
import { TransferError, type TransferArgs, type TransferResult } from "./transfer.js";
import { exportVaultAccountKey, exportVaultPhrase, readVaultFileUnlocked } from "./vault.js";
import { WalletStore } from "./wallet-store.js";

const movementReadHook = vi.hoisted(() => ({
  afterRead: undefined as undefined | (() => Promise<void>),
}));

vi.mock("./movement.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./movement.js")>();
  return {
    ...actual,
    async readMovement(...args: Parameters<typeof actual.readMovement>) {
      const movement = await actual.readMovement(...args);
      await movementReadHook.afterRead?.();
      return movement;
    },
  };
});

const vectors = JSON.parse(
  readFileSync(new URL("./backup-vectors.json", import.meta.url), "utf8"),
) as BackupVectors;

const TEST_PHRASE = "test test test test test test test test test test test junk";
const IMPORTED_PRIVATE_KEY = `0x${"11".repeat(32)}` as const;
const HARDHAT_PRIVATE_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;
const OWNER = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
const CREATED_AT = "2026-09-29T10:11:12.345Z";
const PASSWORD = "correct horse battery staple";
const SALT = Uint8Array.from({ length: 32 }, (_, index) => index);
const KEY = Uint8Array.from({ length: 32 }, (_, index) => index + 100);
const NONCE = Uint8Array.from({ length: 12 }, (_, index) => index + 32);
const BACKUP_EXPORTS = [
  "BackupError",
  "VAULT_BACKUP_TYPED_DATA",
  "normalizeSignature",
  "deriveKeyFromSignature",
  "deriveKeyFromPassword",
  "probeRepeatable",
  "createBackup",
  "openBackup",
  "readBackupHeader",
  "createRelayKeyPair",
  "relayCode",
  "sealTo",
  "openSealed",
  "buildRelayRestorePayload",
  "exportBackupSource",
  "restoreFromBackup",
] as const;
const TEMPORARY_DIRECTORIES: string[] = [];

afterEach(async () => {
  movementReadHook.afterRead = undefined;
  await Promise.all(
    TEMPORARY_DIRECTORIES.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

const SOURCE: BackupSource = {
  phrase: TEST_PHRASE,
  nextDerivedIndex: 3,
  accounts: [
    {
      name: "main",
      kind: "derived",
      index: 0,
      address: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
      createdAt: CREATED_AT,
    },
    {
      name: "imported",
      kind: "imported",
      address: "0x1111111111111111111111111111111111111111",
      privateKey: IMPORTED_PRIVATE_KEY,
      createdAt: CREATED_AT,
    },
  ],
  registry: {
    default: "main",
    accounts: [
      {
        name: "main",
        label: "Primary",
        spendCaps: { perCallAtomic: "100000", perDayAtomic: "1000000" },
      },
      {
        name: "imported",
        spendCaps: { perCallAtomic: "25", perDayAtomic: "250" },
      },
    ],
    networks: ["eip155:1", "eip155:8453"],
  },
  protected: true,
};

describe("backup envelope", () => {
  it("round-trips derived and imported accounts, registry metadata, and protection for both KDF paths", async () => {
    const signatureKey = deriveKeyFromSignature({
      signature: vectors.hkdfEnvelope.signature,
      salt: SALT,
      owner: OWNER,
      device: "test-device",
    });
    const passwordKey = await deriveKeyFromPassword({ password: PASSWORD, salt: SALT });

    for (const ownerKey of [
      { kdf: "hkdf-sha256" as const, key: signatureKey, salt: SALT },
      { kdf: "scrypt" as const, key: passwordKey, salt: SALT },
    ]) {
      const created = await createBackup({
        vault: SOURCE,
        ownerKey,
        owner: OWNER.toUpperCase().replace("0X", "0x"),
        device: "test-device",
        now: () => new Date(CREATED_AT),
        randomBytes: (length) => NONCE.subarray(0, length),
      });

      expect(created.bytes).toBe(Buffer.byteLength(created.envelope));
      expect(await openBackup({ envelope: created.envelope, key: ownerKey.key })).toEqual({
        v: 1,
        ...SOURCE,
      });
      expect(readBackupHeader(created.envelope)).toMatchObject({
        owner: OWNER,
        device: "test-device",
        createdAt: CREATED_AT,
        kdf: { name: ownerKey.kdf },
      });
    }
  });

  it("returns backup_open_failed for every authenticated-header and ciphertext tamper", async () => {
    const { envelope } = await fixedBackup();
    const original = JSON.parse(envelope) as EnvelopeValue;
    const encrypted = Buffer.from(original.ciphertext, "base64url");
    const ciphertextTamper = Buffer.from(encrypted);
    ciphertextTamper[0] = ciphertextTamper[0]! ^ 1;
    const tagTamper = Buffer.from(encrypted);
    tagTamper[tagTamper.length - 1] = tagTamper[tagTamper.length - 1]! ^ 1;

    const mutations: EnvelopeValue[] = [
      { ...original, ciphertext: ciphertextTamper.toString("base64url") },
      { ...original, ciphertext: tagTamper.toString("base64url") },
      {
        ...original,
        cipher: { ...original.cipher, nonce: flipBase64Byte(original.cipher.nonce) },
      },
      { ...original, kdf: { ...original.kdf, salt: flipBase64Byte(original.kdf.salt) } },
      { ...original, owner: "0x0000000000000000000000000000000000000001" },
      { ...original, device: "another-device" },
      { ...original, createdAt: "2026-09-29T10:11:12.346Z" },
      {
        ...original,
        kdf: { name: "scrypt", salt: original.kdf.salt, N: 131072, r: 8, p: 1 },
      },
    ];

    for (const value of mutations) {
      await expectBackupError(openBackup({ envelope: JSON.stringify(value), key: KEY }), {
        code: "backup_open_failed",
        message: "Unable to open backup.",
      });
    }
  });

  it("separates unsupported structures from post-structure open failures", async () => {
    const { envelope } = await fixedBackup();
    const original = JSON.parse(envelope) as EnvelopeValue;
    const unsupported = [
      "not json",
      JSON.stringify({ ...original, extra: true }),
      JSON.stringify({ ...original, owner: original.owner.toUpperCase() }),
      JSON.stringify({
        ...original,
        cipher: { ...original.cipher, nonce: `${original.cipher.nonce}=` },
      }),
      JSON.stringify({ ...original, kdf: { ...original.kdf, extra: true } }),
      JSON.stringify({ ...original, ciphertext: "A" }),
    ];
    for (const value of unsupported) {
      expect(() => readBackupHeader(value)).toThrowError(
        expect.objectContaining({ code: "backup_unsupported" }),
      );
      await expectBackupError(openBackup({ envelope: value, key: KEY }), {
        code: "backup_unsupported",
      });
    }

    const truncated = JSON.stringify({
      ...original,
      ciphertext: Buffer.alloc(15, 1).toString("base64url"),
    });
    await expectBackupError(openBackup({ envelope: truncated, key: KEY }), {
      code: "backup_open_failed",
    });
    await expectBackupError(openBackup({ envelope, key: KEY.subarray(0, 31) }), {
      code: "backup_open_failed",
    });
  });

  it("rejects another signer and owner or device changes in HKDF info", async () => {
    const ownerAccount = privateKeyToAccount(HARDHAT_PRIVATE_KEY);
    const typedData = VAULT_BACKUP_TYPED_DATA(OWNER);
    const signature = await ownerAccount.signTypedData(asViemTypedData(typedData));
    const rightKey = deriveKeyFromSignature({
      signature,
      salt: SALT,
      owner: OWNER,
      device: "test-device",
    });
    const { envelope } = await createBackup({
      vault: SOURCE,
      ownerKey: { kdf: "hkdf-sha256", key: rightKey, salt: SALT },
      owner: OWNER,
      device: "test-device",
      now: () => new Date(CREATED_AT),
      randomBytes: () => NONCE,
    });

    const otherAccount = privateKeyToAccount(`0x${"00".repeat(31)}01`);
    const otherSignature = await otherAccount.signTypedData(asViemTypedData(typedData));
    const wrongKeys = [
      deriveKeyFromSignature({
        signature: otherSignature,
        salt: SALT,
        owner: OWNER,
        device: "test-device",
      }),
      deriveKeyFromSignature({
        signature,
        salt: SALT,
        owner: "0x0000000000000000000000000000000000000001",
        device: "test-device",
      }),
      deriveKeyFromSignature({
        signature,
        salt: SALT,
        owner: OWNER,
        device: "other-device",
      }),
    ];

    for (const key of wrongKeys) {
      await expectBackupError(openBackup({ envelope, key }), { code: "backup_open_failed" });
    }
  });

  it("selects the repeatable signature path and falls back for variable or long signatures", async () => {
    const normalized = vectors.signatureNormalization.v0.normalized;
    const withV0 = vectors.signatureNormalization.v0.input;
    let calls = 0;
    const signedOwners: string[] = [];
    await expect(
      probeRepeatable(async (typedData) => {
        signedOwners.push(typedData.message.owner);
        return calls++ === 0 ? withV0 : normalized;
      }, OWNER),
    ).resolves.toEqual({ path: "signature", signature: normalized });
    expect(signedOwners).toEqual([
      "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
      "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
    ]);

    const changed = Buffer.from(normalized.slice(2), "hex");
    changed[0] = changed[0]! ^ 1;
    calls = 0;
    await expect(
      probeRepeatable(
        async () => (calls++ === 0 ? normalized : `0x${changed.toString("hex")}`),
        OWNER,
      ),
    ).resolves.toEqual({ path: "password" });
    await expect(probeRepeatable(async () => `0x${"11".repeat(130)}`, OWNER)).resolves.toEqual({
      path: "password",
    });

    const rejection = new Error(`wallet rejected ${IMPORTED_PRIVATE_KEY}`);
    await expect(
      probeRepeatable(async () => {
        throw rejection;
      }, OWNER),
    ).rejects.toMatchObject({ code: "backup_invalid_input", message: "Invalid backup input." });
  });

  it("matches every checked-in vector with the implementation and independent node:crypto computations", async () => {
    const hardhat = privateKeyToAccount(vectors.hkdfEnvelope.privateKey as `0x${string}`);
    const typedData = VAULT_BACKUP_TYPED_DATA(vectors.hkdfEnvelope.owner);
    const signature = await hardhat.signTypedData(asViemTypedData(typedData));
    expect(signature).toBe(vectors.hkdfEnvelope.signature);
    await expect(
      recoverTypedDataAddress({
        ...asViemTypedData(typedData),
        signature: vectors.hkdfEnvelope.signature as `0x${string}`,
      }),
    ).resolves.toBe(hardhat.address);

    const hkdfSalt = fromHex(vectors.hkdfEnvelope.salt);
    const hkdfNonce = fromHex(vectors.hkdfEnvelope.nonce);
    const directHkdfKey = Buffer.from(
      hkdfSync(
        "sha256",
        directNormalizeSignature(vectors.hkdfEnvelope.signature),
        hkdfSalt,
        Buffer.from(
          `vapi-vault-backup/v1|${vectors.hkdfEnvelope.owner}|${vectors.hkdfEnvelope.device}`,
        ),
        32,
      ),
    );
    expect(toHex(directHkdfKey)).toBe(vectors.hkdfEnvelope.derivedKey);
    expect(
      directEnvelope({
        vector: vectors.hkdfEnvelope,
        key: directHkdfKey,
        nonce: hkdfNonce,
        kdf: { name: "hkdf-sha256", salt: toBase64Url(hkdfSalt) },
      }),
    ).toBe(vectors.hkdfEnvelope.envelope);
    expect(directOpen(vectors.hkdfEnvelope.envelope, directHkdfKey)).toBe(
      vectors.hkdfEnvelope.plaintext,
    );

    const implementationHkdfKey = deriveKeyFromSignature({
      signature: vectors.hkdfEnvelope.signature,
      salt: hkdfSalt,
      owner: vectors.hkdfEnvelope.owner,
      device: vectors.hkdfEnvelope.device,
    });
    expect(toHex(implementationHkdfKey)).toBe(vectors.hkdfEnvelope.derivedKey);
    await expectImplementationEnvelope(vectors.hkdfEnvelope, implementationHkdfKey, hkdfSalt);

    const scryptSalt = fromHex(vectors.scryptEnvelope.salt);
    const scryptNonce = fromHex(vectors.scryptEnvelope.nonce);
    const directScryptKey = scryptSync(
      Buffer.from(vectors.scryptEnvelope.password.normalize("NFKC")),
      scryptSalt,
      32,
      { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 },
    );
    expect(toHex(directScryptKey)).toBe(vectors.scryptEnvelope.derivedKey);
    expect(
      directEnvelope({
        vector: vectors.scryptEnvelope,
        key: directScryptKey,
        nonce: scryptNonce,
        kdf: {
          name: "scrypt",
          salt: toBase64Url(scryptSalt),
          N: 131072,
          r: 8,
          p: 1,
        },
      }),
    ).toBe(vectors.scryptEnvelope.envelope);
    expect(directOpen(vectors.scryptEnvelope.envelope, directScryptKey)).toBe(
      vectors.scryptEnvelope.plaintext,
    );

    const implementationScryptKey = await deriveKeyFromPassword({
      password: vectors.scryptEnvelope.password,
      salt: scryptSalt,
    });
    expect(toHex(implementationScryptKey)).toBe(vectors.scryptEnvelope.derivedKey);
    await expectImplementationEnvelope(vectors.scryptEnvelope, implementationScryptKey, scryptSalt);

    for (const signatureVector of Object.values(vectors.signatureNormalization)) {
      expect(toHex(directNormalizeSignature(signatureVector.input))).toBe(
        signatureVector.normalized,
      );
      expect(toHex(normalizeSignature(signatureVector.input))).toBe(signatureVector.normalized);
    }

    const relayVector = vectors.sealedBox;
    const recipientPrivateKey = fromHex(relayVector.recipientPrivateKey);
    const recipientPublicKey = directX25519Public(recipientPrivateKey);
    const ephemeralPrivateKey = fromHex(relayVector.ephemeralPrivateKey);
    const ephemeralPublicKey = directX25519Public(ephemeralPrivateKey);
    expect(toHex(recipientPublicKey)).toBe(relayVector.recipientPublicKey);
    expect(toHex(ephemeralPublicKey)).toBe(relayVector.ephemeralPublicKey);
    const shared = directX25519Shared(ephemeralPrivateKey, recipientPublicKey);
    const directRelayKey = Buffer.from(
      hkdfSync(
        "sha256",
        shared,
        Buffer.concat([ephemeralPublicKey, recipientPublicKey]),
        Buffer.from("vapi-vault-relay/v1"),
        32,
      ),
    );
    expect(toHex(directRelayKey)).toBe(relayVector.derivedKey);
    expect(directRelayCode(recipientPublicKey)).toBe(relayVector.relayCode);
    expect(
      directSealed({
        recipientPublicKey,
        ephemeralPrivateKey,
        nonce: fromHex(relayVector.nonce),
        plaintext: relayVector.plaintext,
      }),
    ).toBe(relayVector.sealed);
    expect((JSON.parse(relayVector.sealed) as RelayValue).epk).toBe(
      toBase64Url(ephemeralPublicKey),
    );
    expect(
      `vapi-vault-relay|1|${toBase64Url(ephemeralPublicKey)}|${toBase64Url(
        fromHex(relayVector.nonce),
      )}`,
    ).toBe(relayVector.aad);

    const implementationRecipient = createRelayKeyPair({
      randomBytes: () => recipientPrivateKey,
    });
    expect(toHex(implementationRecipient.publicKey)).toBe(relayVector.recipientPublicKey);
    expect(relayCode(implementationRecipient.publicKey)).toBe(relayVector.relayCode);
    let relayDraw = 0;
    const implementationSealed = sealTo({
      recipientPublicKey: implementationRecipient.publicKey,
      plaintext: relayVector.plaintext,
      randomBytes: (length) => {
        relayDraw += 1;
        return length === 32 ? ephemeralPrivateKey : fromHex(relayVector.nonce);
      },
    });
    expect(relayDraw).toBe(2);
    expect(implementationSealed).toBe(relayVector.sealed);
    expect(
      Buffer.from(openSealed({ recipientPrivateKey, sealed: implementationSealed })).toString(),
    ).toBe(relayVector.plaintext);
  });

  it("accepts 65,536 bytes and rejects 65,537 bytes before returning or parsing", async () => {
    const baseSource = sourceWithLabel("");
    const base = await createBackup({
      vault: baseSource,
      ownerKey: { kdf: "hkdf-sha256", key: KEY, salt: SALT },
      owner: OWNER,
      device: "d",
      now: () => new Date(CREATED_AT),
      randomBytes: () => NONCE,
    });
    const baseValue = JSON.parse(base.envelope) as EnvelopeValue;
    const baseCiphertextBytes = Buffer.from(baseValue.ciphertext, "base64url").byteLength;
    const fixedBytes = base.bytes - baseValue.ciphertext.length;
    const boundary = findBoundaryLabel(fixedBytes, baseCiphertextBytes);
    const acceptedDevice = "d".repeat(boundary.deviceLength);
    const accepted = await createBackup({
      vault: sourceWithLabel("x".repeat(boundary.labelLength)),
      ownerKey: { kdf: "hkdf-sha256", key: KEY, salt: SALT },
      owner: OWNER,
      device: acceptedDevice,
      now: () => new Date(CREATED_AT),
      randomBytes: () => NONCE,
    });
    expect(accepted.bytes).toBe(65_536);
    expect(readBackupHeader(accepted.envelope).device).toBe(acceptedDevice);

    const oversizedDevice = `${acceptedDevice}d`;
    expect(oversizedDevice.length).toBeLessThanOrEqual(32);
    await expectBackupError(
      createBackup({
        vault: sourceWithLabel("x".repeat(boundary.labelLength)),
        ownerKey: { kdf: "hkdf-sha256", key: KEY, salt: SALT },
        owner: OWNER,
        device: oversizedDevice,
        now: () => new Date(CREATED_AT),
        randomBytes: () => NONCE,
      }),
      { code: "backup_too_large" },
    );

    const oversizedInput = `${accepted.envelope} `;
    expect(Buffer.byteLength(oversizedInput)).toBe(65_537);
    expect(() => readBackupHeader(oversizedInput)).toThrowError(
      expect.objectContaining({ code: "backup_too_large" }),
    );
    await expectBackupError(openBackup({ envelope: oversizedInput, key: KEY }), {
      code: "backup_too_large",
    });
  });

  it("never exposes a phrase, private key, password, signature, or derived key in thrown errors", async () => {
    const derivedKey = await deriveKeyFromPassword({ password: PASSWORD, salt: SALT });
    const signature = vectors.hkdfEnvelope.signature;
    const missingHome = join(await temporaryHome(), "missing");
    const invalidRestoreHome = join(await temporaryHome(), "invalid-restore");
    const errors: unknown[] = [];
    const collect = async (operation: () => unknown | Promise<unknown>): Promise<void> => {
      try {
        await operation();
      } catch (error) {
        errors.push(error);
      }
    };

    await collect(() => deriveKeyFromPassword({ password: "short-pass", salt: SALT }));
    await collect(() => deriveKeyFromPassword({ password: PASSWORD, salt: SALT.subarray(0, 31) }));
    await collect(() => normalizeSignature(`${signature}00`));
    await collect(() =>
      probeRepeatable(async () => {
        throw new Error(IMPORTED_PRIVATE_KEY);
      }, OWNER),
    );
    let signerCalls = 0;
    await collect(() =>
      probeRepeatable(async () => {
        signerCalls += 1;
        if (signerCalls === 1) return signature;
        throw Object.assign(new Error("wallet rejected request"), { signature });
      }, OWNER),
    );
    await collect(() =>
      createBackup({
        vault: { ...SOURCE, token: TEST_PHRASE } as BackupSource,
        ownerKey: { kdf: "hkdf-sha256", key: derivedKey, salt: SALT },
        owner: OWNER,
        device: "test-device",
      }),
    );
    const { envelope } = await fixedBackup();
    await collect(() =>
      openBackup({ envelope, key: Uint8Array.from(derivedKey, (byte) => byte ^ 1) }),
    );
    await collect(() => readBackupHeader("not json"));
    await collect(() =>
      createBackup({
        vault: {
          ...SOURCE,
          registry: {
            ...SOURCE.registry,
            accounts: SOURCE.registry.accounts.map((account) => ({
              ...account,
              label: "x".repeat(60_000),
            })),
          },
        },
        ownerKey: { kdf: "hkdf-sha256", key: derivedKey, salt: SALT },
        owner: OWNER,
        device: "test-device",
        now: () => new Date(CREATED_AT),
        randomBytes: () => NONCE,
      }),
    );
    await collect(() => sealTo({ recipientPublicKey: Buffer.alloc(32), plaintext: TEST_PHRASE }));
    await collect(() => openSealed({ recipientPrivateKey: derivedKey, sealed: "not json" }));
    await collect(() =>
      exportBackupSource({
        store: {
          home: missingHome,
          snapshot: () => ({ version: 1, wallets: {} }),
        } as WalletStore,
        vaultKey: derivedKey,
      }),
    );
    await collect(() =>
      restoreFromBackup({
        plaintext: { v: 1, ...SOURCE },
        home: invalidRestoreHome,
        vaultKey: derivedKey,
      }),
    );

    expect(errors).toHaveLength(13);
    const forbidden = [
      TEST_PHRASE,
      IMPORTED_PRIVATE_KEY,
      PASSWORD,
      signature,
      toHex(derivedKey),
      toBase64Url(derivedKey),
    ];
    for (const error of errors) {
      expect(error).toBeInstanceOf(BackupError);
      for (const secret of forbidden) {
        expect((error as Error).message).not.toContain(secret);
        expect(JSON.stringify(error)).not.toContain(secret);
        expect(String((error as Error).stack)).not.toContain(secret);
      }
    }
  });

  it("exports only allow-listed vault and registry fields, excluding every token and device secret", async () => {
    const home = await temporaryHome();
    const secrets = memoryStore();
    secrets.entries.set("vault-key", Buffer.from(KEY).toString("base64"));
    const store = await WalletStore.open(home, {
      secrets,
      now: () => new Date(CREATED_AT),
      audit: async () => undefined,
    });
    await store.create("main", "", { phrase: TEST_PHRASE, label: "Primary" });
    const accessToken = "access-token-that-must-not-leave";
    const refreshToken = "refresh-token-that-must-not-leave";
    const clientId = "client-id-that-must-not-leave";
    secrets.entries.set(
      "vapi.agent.main.tokens",
      JSON.stringify({ accessToken, refreshToken, expiresAt: 4_102_444_800_000, scopes: ["call"] }),
    );
    await store.setLink("main", {
      apiBase: "https://api.vapinetwork.ai",
      clientId,
      owner: OWNER,
      label: "Owner",
      scopes: ["call"],
      linkedAt: CREATED_AT,
    });
    await store.setRouterRefill("main", { belowUsd: 2.5, tierUsd: 5 });
    const concurrentStore = await WalletStore.open(home, {
      secrets,
      now: () => new Date(CREATED_AT),
      audit: async () => undefined,
    });
    await concurrentStore.setSpendCaps("main", {
      perCallAtomic: "1",
      perDayAtomic: "2",
    });

    const source = await exportBackupSource({
      store,
      vaultKey: KEY,
      networks: ["eip155:8453", "eip155:1", "eip155:8453"],
    });
    expect(source.registry).toEqual({
      default: "main",
      accounts: [
        {
          name: "main",
          label: "Primary",
          spendCaps: { perCallAtomic: "1", perDayAtomic: "2" },
          routerRefill: { belowUsd: 2.5, tierUsd: 5 },
        },
      ],
      networks: ["eip155:1", "eip155:8453"],
    });
    const { envelope } = await createBackup({
      vault: source,
      ownerKey: { kdf: "hkdf-sha256", key: KEY, salt: SALT },
      owner: OWNER,
      device: "test-device",
      now: () => new Date(CREATED_AT),
      randomBytes: () => NONCE,
    });
    const plaintext = await openBackup({ envelope, key: KEY });
    for (const serialized of [JSON.stringify(source), JSON.stringify(plaintext)]) {
      for (const excluded of [
        accessToken,
        refreshToken,
        clientId,
        "link",
        toHex(KEY),
        toBase64Url(KEY),
      ]) {
        expect(serialized).not.toContain(excluded);
      }
    }
  });

  it("round-trips sealed boxes and rejects wrong, tampered, oversized, and all-zero keys", () => {
    const recipient = createRelayKeyPair({ randomBytes: () => fromHex("0x" + "31".repeat(32)) });
    const wrongRecipient = createRelayKeyPair({
      randomBytes: () => fromHex("0x" + "41".repeat(32)),
    });
    let draws = 0;
    const sealed = sealTo({
      recipientPublicKey: recipient.publicKey,
      plaintext: "sealed round trip",
      randomBytes: (length) => {
        draws += 1;
        return Buffer.alloc(length, length === 32 ? 0x51 : 0x61);
      },
    });
    expect(draws).toBe(2);
    expect(
      Buffer.from(openSealed({ recipientPrivateKey: recipient.privateKey, sealed })).toString(),
    ).toBe("sealed round trip");
    expect(() =>
      openSealed({ recipientPrivateKey: wrongRecipient.privateKey, sealed }),
    ).toThrowError(
      expect.objectContaining({
        code: "relay_open_failed",
        message: "Unable to open relay payload.",
      }),
    );

    const original = JSON.parse(sealed) as RelayValue;
    for (const tampered of [
      { ...original, epk: flipBase64Byte(original.epk) },
      { ...original, nonce: flipBase64Byte(original.nonce) },
      { ...original, ciphertext: flipBase64Byte(original.ciphertext) },
    ]) {
      expect(() =>
        openSealed({ recipientPrivateKey: recipient.privateKey, sealed: JSON.stringify(tampered) }),
      ).toThrowError(expect.objectContaining({ code: "relay_open_failed" }));
    }
    expect(() =>
      sealTo({ recipientPublicKey: Buffer.alloc(32), plaintext: "all zero" }),
    ).toThrowError(expect.objectContaining({ code: "relay_invalid_key" }));
    expect(() =>
      sealTo({ recipientPublicKey: recipient.publicKey, plaintext: "x".repeat(65_537) }),
    ).toThrowError(expect.objectContaining({ code: "backup_too_large" }));
    expect(() =>
      openSealed({ recipientPrivateKey: recipient.privateKey, sealed: "x".repeat(131_073) }),
    ).toThrowError(expect.objectContaining({ code: "relay_open_failed" }));
    expect(relayCode(recipient.publicKey)).toBe(relayCode(recipient.publicKey));
    expect(relayCode(wrongRecipient.publicKey)).not.toBe(relayCode(recipient.publicKey));
  });

  it("restores exact derived and imported accounts with caps and refuses any existing vault", async () => {
    const home = await temporaryHome();
    const importedPrivateKey = `0x${"11".repeat(32)}` as const;
    const importedAddress = privateKeyToAccount(importedPrivateKey).address;
    const plaintext: BackupPlaintext = {
      v: 1,
      phrase: TEST_PHRASE,
      nextDerivedIndex: 7,
      accounts: [
        {
          name: "main",
          kind: "derived",
          index: 0,
          address: privateKeyToAccount(HARDHAT_PRIVATE_KEY).address,
          createdAt: CREATED_AT,
        },
        {
          name: "cold",
          kind: "imported",
          address: importedAddress,
          privateKey: importedPrivateKey,
          createdAt: "2026-09-29T10:11:13.345Z",
        },
      ],
      registry: {
        default: "cold",
        accounts: [
          {
            name: "main",
            label: "Primary",
            spendCaps: { perCallAtomic: "50", perDayAtomic: "500" },
          },
          {
            name: "cold",
            spendCaps: { perCallAtomic: "5", perDayAtomic: "50" },
          },
        ],
        networks: ["eip155:1", "eip155:8453"],
      },
      protected: true,
    };

    const restored = await restoreFromBackup({ plaintext, home, vaultKey: KEY });
    expect(restored).toEqual({
      accounts: plaintext.accounts.map((account) =>
        account.kind === "derived"
          ? { ...account }
          : {
              name: account.name,
              kind: account.kind,
              address: account.address,
              createdAt: account.createdAt,
            },
      ),
      default: "cold",
      protected: true,
      networks: ["eip155:1", "eip155:8453"],
    });
    const vaultFile = await readVaultFileUnlocked(join(home, "vault.json"));
    expect(vaultFile).toMatchObject({
      version: 2,
      kdf: "device-key",
      cipher: "aes-256-gcm",
      nextDerivedIndex: 7,
      protected: false,
    });
    expect(
      vaultFile.accounts.map(({ name, kind, address, createdAt }) => ({
        name,
        kind,
        address,
        createdAt,
      })),
    ).toEqual(
      restored.accounts.map(({ name, kind, address, createdAt }) => ({
        name,
        kind,
        address,
        createdAt,
      })),
    );
    await expect(exportVaultPhrase({ path: join(home, "vault.json"), key: KEY })).resolves.toBe(
      TEST_PHRASE,
    );
    await expect(
      exportVaultAccountKey({ path: join(home, "vault.json"), key: KEY, name: "cold" }),
    ).resolves.toBe(importedPrivateKey);
    expect(JSON.parse(await readFile(join(home, "wallets.json"), "utf8"))).toEqual({
      version: 1,
      default: "cold",
      wallets: {
        main: {
          createdAt: CREATED_AT,
          label: "Primary",
          spendCaps: { perCallAtomic: "50", perDayAtomic: "500" },
        },
        cold: {
          createdAt: "2026-09-29T10:11:13.345Z",
          spendCaps: { perCallAtomic: "5", perDayAtomic: "50" },
        },
      },
    });
    await expectBackupError(restoreFromBackup({ plaintext, home, vaultKey: KEY }), {
      code: "vault_exists",
    });

    const invalidHome = await temporaryHome();
    await expectBackupError(
      restoreFromBackup({
        plaintext: {
          ...plaintext,
          accounts: [
            { ...plaintext.accounts[0]!, address: "0x0000000000000000000000000000000000000001" },
            plaintext.accounts[1]!,
          ],
        },
        home: invalidHome,
        vaultKey: KEY,
      }),
      { code: "backup_invalid_input" },
    );
    await expect(readFile(join(invalidHome, "vault.json"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("publishes a complete restore without deleting a concurrently imported account", async () => {
    const home = await temporaryHome();
    const secrets = memoryStore();
    secrets.entries.set("vault-key", Buffer.from(KEY).toString("base64"));
    const store = await WalletStore.open(home, {
      secrets,
      now: () => new Date(CREATED_AT),
      audit: async () => undefined,
    });
    const accounts = Array.from({ length: 8 }, (_, index) => {
      const privateKey = `0x${(index + 1).toString(16).padStart(64, "0")}` as const;
      return {
        name: `restored-${index}`,
        kind: "imported" as const,
        address: privateKeyToAccount(privateKey).address,
        privateKey,
        createdAt: CREATED_AT,
      };
    });
    const plaintext: BackupPlaintext = {
      v: 1,
      phrase: TEST_PHRASE,
      nextDerivedIndex: 0,
      accounts,
      registry: {
        default: accounts[0]!.name,
        accounts: accounts.map((account) => ({
          name: account.name,
          spendCaps: { perCallAtomic: "10", perDayAtomic: "100" },
        })),
        networks: [],
      },
      protected: false,
    };

    const restore = restoreFromBackup({ plaintext, home, vaultKey: KEY });
    await waitForFile(join(home, "vault.json"));
    const racingPrivateKey = `0x${"55".repeat(32)}`;
    await store.importKey("racer", "", racingPrivateKey, {
      spendCaps: { perCallAtomic: "3", perDayAtomic: "30" },
    });
    await expect(restore).resolves.toMatchObject({ protected: false });

    const vault = await readVaultFileUnlocked(join(home, "vault.json"));
    expect(vault.accounts.map((account) => account.name)).toContain("racer");
    const registry = JSON.parse(await readFile(join(home, "wallets.json"), "utf8")) as {
      wallets: Record<string, unknown>;
    };
    expect(registry.wallets).toHaveProperty("racer");
  });

  it("lint-forbids package and relative backup imports from packages/mcp", async () => {
    const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
    const eslint = new ESLint({ cwd: repositoryRoot });
    const fixturePath = join(repositoryRoot, "packages/mcp/src/__lint_fixture__.ts");
    for (const source of [
      "import { createBackup } from '@vapi-network/core/backup';\nexport const x = createBackup;\n",
      "import { createBackup } from '../../core/src/backup.js';\nexport const x = createBackup;\n",
    ]) {
      const [result] = await eslint.lintText(source, { filePath: fixturePath });
      expect(result?.messages).toEqual(
        expect.arrayContaining([expect.objectContaining({ ruleId: "no-restricted-imports" })]),
      );
    }
  }, 15_000);

  it("is a separate package entry point and leaves every backup export off the main index", async () => {
    const manifest = JSON.parse(
      await readFile(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
    ) as {
      exports: Record<string, { types: string; import: string }>;
      scripts: { build: string };
    };

    expect(manifest.exports["./backup"]).toEqual({
      types: "./dist/backup.d.ts",
      import: "./dist/backup.js",
    });
    expect(manifest.scripts.build).toContain("backup=src/backup.ts");
    for (const name of BACKUP_EXPORTS) {
      expect(Reflect.has(backup, name)).toBe(true);
      expect(Reflect.has(index, name)).toBe(false);
    }
  });
});

describe("backup plaintext v1 and v2 compatibility", () => {
  it("keeps a v1 source and checked-in v1 envelope byte-identical", async () => {
    const vector = vectors.hkdfEnvelope;
    const salt = fromHex(vector.salt);
    const key = deriveKeyFromSignature({
      signature: vector.signature,
      salt,
      owner: vector.owner,
      device: vector.device,
    });
    await expectImplementationEnvelope(vector, key, salt);
    await expect(openBackup({ envelope: vector.envelope, key })).resolves.toEqual(
      JSON.parse(vector.plaintext),
    );
  });

  it("pins the deterministic v2 envelope with implementation and independent node:crypto", async () => {
    const vector = vectors.hkdfEnvelopeV2;
    const account = privateKeyToAccount(vector.privateKey as `0x${string}`);
    const signature = await account.signTypedData(
      asViemTypedData(VAULT_BACKUP_TYPED_DATA(vector.owner)),
    );
    expect(signature).toBe(vector.signature);
    const salt = fromHex(vector.salt);
    const nonce = fromHex(vector.nonce);
    const key = Buffer.from(
      hkdfSync(
        "sha256",
        directNormalizeSignature(vector.signature),
        salt,
        Buffer.from(`vapi-vault-backup/v1|${vector.owner}|${vector.device}`),
        32,
      ),
    );
    expect(toHex(key)).toBe(vector.derivedKey);
    expect(
      directEnvelope({
        vector,
        key,
        nonce,
        kdf: { name: "hkdf-sha256", salt: toBase64Url(salt) },
      }),
    ).toBe(vector.envelope);
    expect(directOpen(vector.envelope, key)).toBe(vector.plaintext);

    const plaintext = JSON.parse(vector.plaintext) as backup.BackupPlaintextV2;
    const source = { ...plaintext } as unknown as BackupSourceV2;
    Reflect.deleteProperty(source, "v");
    const created = await createBackup({
      vault: source as BackupSourceV2,
      ownerKey: { kdf: "hkdf-sha256", key, salt },
      owner: vector.owner,
      device: vector.device,
      now: () => new Date(vector.createdAt),
      randomBytes: () => nonce,
    });
    expect(created.envelope).toBe(vector.envelope);
    await expect(openBackup({ envelope: created.envelope, key })).resolves.toEqual(plaintext);
  });

  it("rejects a v2 source with only some required section arrays", async () => {
    await expect(
      createBackup({
        vault: { ...SOURCE, agents: [] },
        ownerKey: { kdf: "hkdf-sha256", key: KEY, salt: SALT },
        owner: OWNER,
        device: "test-device",
        now: () => new Date(CREATED_AT),
        randomBytes: () => NONCE,
      }),
    ).rejects.toMatchObject({ code: "backup_invalid_input" });
  });

  it("emits a vault-only v2 source as the byte-identical v1 envelope", async () => {
    const v1 = await createBackup({
      vault: SOURCE,
      ownerKey: { kdf: "hkdf-sha256", key: KEY, salt: SALT },
      owner: OWNER,
      device: "test-device",
      now: () => new Date(CREATED_AT),
      randomBytes: () => NONCE,
    });
    const v2 = await createBackup({
      vault: v2VaultOnlySource(),
      ownerKey: { kdf: "hkdf-sha256", key: KEY, salt: SALT },
      owner: OWNER,
      device: "test-device",
      now: () => new Date(CREATED_AT),
      randomBytes: () => NONCE,
    });

    expect(v2.envelope).toBe(v1.envelope);
    await expect(openBackup({ envelope: v2.envelope, key: KEY })).resolves.toEqual({
      v: 1,
      ...SOURCE,
    });
  });

  it("emits v2 for a non-default ceiling and keeps only that ceiling", async () => {
    const source = v2VaultOnlySource();
    source.registry.accounts[0]!.ceilingAtomic = "7000000";

    const created = await createBackup({
      vault: source,
      ownerKey: { kdf: "hkdf-sha256", key: KEY, salt: SALT },
      owner: OWNER,
      device: "test-device",
      now: () => new Date(CREATED_AT),
      randomBytes: () => NONCE,
    });
    const plaintext = await openBackup({ envelope: created.envelope, key: KEY });

    expect(plaintext.v).toBe(2);
    expect(plaintext.registry.accounts[0]).toMatchObject({ ceilingAtomic: "7000000" });
    expect(plaintext.registry.accounts[1]).not.toHaveProperty("ceilingAtomic");
  });

  it("emits v2 for Router refill while omitting default ceilings", async () => {
    const source = v2VaultOnlySource();
    source.registry.accounts[0]!.routerRefill = { belowUsd: 2.5, tierUsd: 5 };

    const created = await createBackup({
      vault: source,
      ownerKey: { kdf: "hkdf-sha256", key: KEY, salt: SALT },
      owner: OWNER,
      device: "test-device",
      now: () => new Date(CREATED_AT),
      randomBytes: () => NONCE,
    });
    const plaintext = await openBackup({ envelope: created.envelope, key: KEY });

    expect(plaintext.v).toBe(2);
    expect(plaintext.registry.accounts[0]).toMatchObject({
      routerRefill: { belowUsd: 2.5, tierUsd: 5 },
    });
    expect(plaintext.registry.accounts[0]).not.toHaveProperty("ceilingAtomic");
  });

  it("restores the default ceiling when v2 omits it", async () => {
    const base = restoreV1Plaintext();
    const source = {
      phrase: base.phrase,
      nextDerivedIndex: base.nextDerivedIndex,
      accounts: base.accounts,
      registry: base.registry,
      protected: base.protected,
      agents: [agentFixture("default-ceiling")],
      swarms: [],
      movements: [],
      transferReceipts: [],
    } as BackupSourceV2;
    const created = await createBackup({
      vault: source,
      ownerKey: { kdf: "hkdf-sha256", key: KEY, salt: SALT },
      owner: OWNER,
      device: "test-device",
      now: () => new Date(CREATED_AT),
      randomBytes: () => NONCE,
    });
    const plaintext = await openBackup({ envelope: created.envelope, key: KEY });
    expect(plaintext).toMatchObject({ v: 2, agents: [{ name: "default-ceiling" }] });
    expect(plaintext.registry.accounts[0]).not.toHaveProperty("ceilingAtomic");

    const home = await temporaryHome();
    await restoreFromBackup({ plaintext: plaintext as BackupPlaintextV2, home, vaultKey: KEY });
    expect(JSON.parse(await readFile(join(home, "wallets.json"), "utf8"))).toMatchObject({
      wallets: { main: { ceilingAtomic: "5000000" } },
    });
  });
});

describe("backup v2 export allow-list", () => {
  it("backs up and restores explicit task policy fields from agent profiles", async () => {
    const home = await temporaryHome();
    const secrets = memoryStore();
    secrets.entries.set("vault-key", Buffer.from(KEY).toString("base64"));
    const store = await WalletStore.open(home, {
      secrets,
      now: () => new Date(CREATED_AT),
      audit: async () => undefined,
    });
    await store.create("main", "", { phrase: TEST_PHRASE });
    const taskPolicy = { maxPerTaskUsd: 75, autoReleaseBelowUsd: 12.5 };
    await writeAgentProfile(home, { ...agentFixture("task-poster"), ...taskPolicy });

    const source = await exportBackupSource({ store, vaultKey: KEY });
    expect(source.agents).toEqual([expect.objectContaining(taskPolicy)]);
    const created = await createBackup({
      vault: source,
      ownerKey: { kdf: "hkdf-sha256", key: KEY, salt: SALT },
      owner: OWNER,
      device: "test-device",
      now: () => new Date(CREATED_AT),
      randomBytes: () => NONCE,
    });
    const plaintext = await openBackup({ envelope: created.envelope, key: KEY });
    expect(plaintext).toMatchObject({ agents: [taskPolicy] });
    const restoredHome = await temporaryHome();
    await restoreFromBackup({ plaintext, home: restoredHome, vaultKey: KEY });
    await expect(readAgentProfile(restoredHome, "task-poster")).resolves.toMatchObject(taskPolicy);
  });

  it("restores older backup profiles without task policy fields using read defaults", async () => {
    const home = await temporaryHome();
    const agent = agentFixture("old-task-poster");
    expect(agent).not.toHaveProperty("maxPerTaskUsd");
    expect(agent).not.toHaveProperty("autoReleaseBelowUsd");
    await restoreFromBackup({
      plaintext: restoreV2Plaintext({ agents: [agent] }),
      home,
      vaultKey: KEY,
    });
    await expect(readAgentProfile(home, agent.name)).resolves.toMatchObject({
      maxPerTaskUsd: 100,
      autoReleaseBelowUsd: 25,
    });
  });

  it("applies normal profile defaults and reports profiles that loader rejects", async () => {
    const home = await temporaryHome();
    const secrets = memoryStore();
    secrets.entries.set("vault-key", Buffer.from(KEY).toString("base64"));
    const store = await WalletStore.open(home, {
      secrets,
      now: () => new Date(CREATED_AT),
      audit: async () => undefined,
    });
    await store.create("main", "", { phrase: TEST_PHRASE });
    await mkdir(join(home, "agents"), { recursive: true });
    await writeFile(
      join(home, "agents", "defaulted.json"),
      JSON.stringify({
        version: 1,
        name: "defaulted",
        wallet: "main",
        model: "openai/gpt-5-mini",
        instructions: "Use the normal loader defaults.",
        createdAt: CREATED_AT,
      }),
    );
    await writeFile(
      join(home, "agents", "broken.json"),
      JSON.stringify({
        version: 1,
        name: "broken",
        wallet: "main",
        model: "",
        instructions: "Invalid model.",
        createdAt: CREATED_AT,
      }),
    );

    const source = await exportBackupSource({ store, vaultKey: KEY });

    expect(source.agents).toEqual([
      {
        version: 1,
        name: "defaulted",
        wallet: "main",
        model: "openai/gpt-5-mini",
        instructions: "Use the normal loader defaults.",
        verifiedOnly: true,
        approveAboveUsd: 0.5,
        maxPerTaskUsd: 100,
        autoReleaseBelowUsd: 25,
        maxSteps: 12,
        paused: false,
        createdAt: CREATED_AT,
        tools: ["call.search", "call.inspect", "call.pay"],
      },
    ]);
    expect(source.skipped).toEqual([{ kind: "agent", name: "broken", reason: "invalid_profile" }]);
  });

  it("keeps a swarm profile's grants through export, envelope and open", async () => {
    const home = await temporaryHome();
    const secrets = memoryStore();
    secrets.entries.set("vault-key", Buffer.from(KEY).toString("base64"));
    const store = await WalletStore.open(home, {
      secrets,
      now: () => new Date(CREATED_AT),
      audit: async () => undefined,
    });
    await store.create("main", "", { phrase: TEST_PHRASE });
    await writeAgentProfile(home, {
      ...agentFixture("lead"),
      grants: ["read", "delegate", "allocate"],
    });
    await writeAgentProfile(home, agentFixture("plain"));

    const source = await exportBackupSource({ store, vaultKey: KEY });
    expect(source.agents?.map((agent) => [agent.name, agent.grants])).toEqual([
      ["lead", ["read", "delegate", "allocate"]],
      ["plain", undefined],
    ]);

    const created = await createBackup({
      vault: source,
      ownerKey: { kdf: "hkdf-sha256", key: KEY, salt: SALT },
      owner: OWNER,
      device: "test-device",
      now: () => new Date(CREATED_AT),
      randomBytes: () => NONCE,
    });
    const opened = await openBackup({ envelope: created.envelope, key: KEY });
    expect(opened.v).toBe(2);
    expect(
      (opened as { agents?: { name: string; grants?: string[] }[] }).agents?.find(
        (agent) => agent.name === "lead",
      )?.grants,
    ).toEqual(["read", "delegate", "allocate"]);
  });

  it("exports profiles, swarms, unfinished movements, and only their minimal transfer receipts", async () => {
    const home = await temporaryHome();
    const secrets = memoryStore();
    secrets.entries.set("vault-key", Buffer.from(KEY).toString("base64"));
    const store = await WalletStore.open(home, {
      secrets,
      now: () => new Date(CREATED_AT),
      audit: async () => undefined,
    });
    await store.create("main", "", { phrase: TEST_PHRASE, label: "Primary" });
    await store.setCeiling("main", 7_000_000n);
    await store.setRouterRefill("main", { belowUsd: 2.5, tierUsd: 5 });
    await store.setLink("main", {
      apiBase: "https://api.vapinetwork.ai",
      clientId: "link-client-secret",
      owner: OWNER,
      label: "Owner",
      scopes: ["call"],
      linkedAt: CREATED_AT,
    });
    await store.claimCeilingSweepAttempt("main", new Date(CREATED_AT), 0);
    await store.updateCeilingSweepPending("main", () => ({
      owner: OWNER,
      target: "0x2222222222222222222222222222222222222222",
      amountAtomic: "1",
      nonce: nonceFor(90),
      createdAt: CREATED_AT,
      status: "unknown",
    }));
    secrets.entries.set(
      "vapi.agent.main.tokens",
      JSON.stringify({ accessToken: "access-token-secret", refreshToken: "refresh-token-secret" }),
    );

    await writeAgentProfile(home, agentFixture("zeta-agent"));
    await writeAgentProfile(home, agentFixture("alpha-agent"));
    await writeSwarm(home, swarmFixture("zeta-swarm"));
    await writeSwarm(home, swarmFixture("alpha-swarm"));

    const openLater = movementFixture("mv_open0002", "2026-09-29T11:00:00.000Z", [
      { status: "sent", nonce: nonceFor(2) },
      { status: "planned", nonce: nonceFor(3) },
    ]);
    const openEarlier = movementFixture("mv_open0001", "2026-09-29T10:00:00.000Z", [
      { status: "unknown", nonce: nonceFor(1) },
    ]);
    openEarlier.legs[0]!.restored = true;
    openEarlier.legs[0]!.fromAddress = privateKeyToAccount(HARDHAT_PRIVATE_KEY).address;
    openEarlier.legs[0]!.toAddress = "0x2222222222222222222222222222222222222222";
    const finished = movementFixture("mv_finished1", "2026-09-29T09:00:00.000Z", [
      { status: "sent", nonce: nonceFor(4) },
    ]);
    await writeMovementFixture(home, openLater);
    await writeMovementFixture(home, finished);
    await writeMovementFixture(home, openEarlier);

    const receiptsPath = join(home, "receipts.jsonl");
    await appendReceipt(
      transferReceiptFixture("receipt-open-1", nonceFor(1), "unknown"),
      receiptsPath,
    );
    await appendReceipt(
      transferReceiptFixture("receipt-open-1", nonceFor(1), "failed"),
      receiptsPath,
    );
    await appendReceipt(
      transferReceiptFixture("receipt-open-1b", nonceFor(1), "unknown"),
      receiptsPath,
    );
    await appendReceipt(
      transferReceiptFixture("receipt-sent-leg", nonceFor(2), "sent"),
      receiptsPath,
    );
    await appendReceipt(
      transferReceiptFixture("receipt-unrelated", nonceFor(80), "unknown"),
      receiptsPath,
    );
    await appendReceipt(
      transferReceiptFixture("receipt-finished", nonceFor(4), "sent"),
      receiptsPath,
    );
    await appendReceipt(
      {
        id: "ordinary-receipt",
        timestamp: CREATED_AT,
        resourceUrl: "https://example.com/not-a-transfer",
      },
      receiptsPath,
    );

    const source = await exportBackupSource({
      store,
      vaultKey: KEY,
      networks: ["eip155:8453", "eip155:1"],
    });
    expect(source.registry.accounts[0]).toMatchObject({
      ceilingAtomic: "7000000",
      routerRefill: { belowUsd: 2.5, tierUsd: 5 },
    });
    expect(source.agents.map((agent) => agent.name)).toEqual(["alpha-agent", "zeta-agent"]);
    expect(source.swarms.map((swarm) => swarm.name)).toEqual(["alpha-swarm", "zeta-swarm"]);
    expect(source.movements.map((movement) => movement.id)).toEqual(["mv_open0001", "mv_open0002"]);
    expect(source.movements[0]?.legs[0]).not.toHaveProperty("restored");
    expect(source.movements[0]?.legs[0]).not.toHaveProperty("fromAddress");
    expect(source.movements[0]?.legs[0]).not.toHaveProperty("toAddress");
    expect(source.movements[1]?.legs).toHaveLength(2);
    expect(source.transferReceipts.map((receipt) => receipt.id)).toEqual([
      "receipt-open-1",
      "receipt-open-1",
      "receipt-open-1b",
      "receipt-sent-leg",
    ]);
    for (const receipt of source.transferReceipts) {
      expect(Object.keys(receipt)).toEqual(
        receipt.error === undefined
          ? ["id", "timestamp", "kind", "wallet", "resourceUrl", "quote", "transfer"]
          : ["id", "timestamp", "kind", "wallet", "resourceUrl", "quote", "transfer", "error"],
      );
    }
    expect(source.transferReceipts[0]?.transfer.request?.signature).toBe(`0x${"ab".repeat(65)}`);
    expect(source.transferReceipts[0]?.quote).toEqual({
      network: "eip155:8453",
      asset: "0x3333333333333333333333333333333333333333",
      amountAtomic: "1000000",
    });
    expect(source.transferReceipts[1]?.transfer).toMatchObject({ status: "failed" });
    expect(source.transferReceipts[1]?.transfer).not.toHaveProperty("request");

    const serialized = JSON.stringify(source);
    for (const excluded of [
      "link-client-secret",
      "access-token-secret",
      "refresh-token-secret",
      "ceilingSweepPending",
      "ceilingSweepAttemptedAt",
      "ordinary-receipt",
      "receipt-unrelated",
      "receipt-finished",
      "mv_finished1",
      '"settlement"',
      '"payer"',
    ]) {
      expect(serialized).not.toContain(excluded);
    }
  });

  it("captures the receipt for a leg that becomes unknown during the backup snapshot", async () => {
    const home = await temporaryHome();
    const secrets = memoryStore();
    secrets.entries.set("vault-key", Buffer.from(KEY).toString("base64"));
    const store = await WalletStore.open(home, {
      secrets,
      now: () => new Date(CREATED_AT),
      audit: async () => undefined,
    });
    await store.create("main", "", { phrase: TEST_PHRASE });
    await writeAgentProfile(home, agentFixture("snapshot-barrier"));

    const nonce = nonceFor(91);
    const planned = movementFixture("mv_backuprace", CREATED_AT, [{ status: "planned", nonce }]);
    await writeMovementFixture(home, planned);
    const signedReceipt = transferReceiptFixture("receipt-backup-race", nonce, "unknown");
    let signed = false;
    const source = await exportBackupSource({
      store,
      vaultKey: KEY,
      agentProfileSchema: {
        parse() {
          if (!signed) {
            signed = true;
            writeFileSync(join(home, "receipts.jsonl"), `${JSON.stringify(signedReceipt)}\n`, {
              mode: 0o600,
            });
            writeFileSync(
              join(home, "movements", `${planned.id}.json`),
              serializeMovement({
                ...planned,
                legs: [{ ...planned.legs[0]!, status: "unknown" }],
              }),
              { mode: 0o600 },
            );
          }
          return {
            ...agentFixture("snapshot-barrier"),
            maxPerTaskUsd: 100,
            autoReleaseBelowUsd: 25,
            grants: [],
          };
        },
      },
    });

    expect(source.movements).toMatchObject([
      { id: planned.id, legs: [{ nonce, status: "unknown" }] },
    ]);
    expect(source.transferReceipts).toMatchObject([
      { id: signedReceipt.id, transfer: { nonce, status: "unknown" } },
    ]);

    const restoredHome = await temporaryHome();
    await restoreFromBackup({
      plaintext: { ...source, v: 2 },
      home: restoredHome,
      vaultKey: KEY,
      device: "restored-device",
    });
    const restoredSecrets = memoryStore();
    restoredSecrets.entries.set("vault-key", Buffer.from(KEY).toString("base64"));
    const restoredStore = await WalletStore.open(restoredHome, {
      secrets: restoredSecrets,
      now: () => new Date(CREATED_AT),
      audit: async () => undefined,
    });
    const transfer = vi.fn(async (args: TransferArgs): Promise<TransferResult> => {
      const journal = await readFile(join(restoredHome, "receipts.jsonl"), "utf8");
      expect(journal).toContain(nonce);
      return transferResultFixture(args, "sent");
    });
    await expect(
      executeMovement(
        { resume: planned.id },
        {
          home: restoredHome,
          store: restoredStore,
          secrets: restoredSecrets,
          apiBase: "https://api.vapinetwork.ai",
          transfer,
          authorizationState: async () => "settled",
          addressReader: async () => OWNER,
        },
      ),
    ).resolves.toMatchObject({ legs: [{ status: "sent", nonce }] });
    expect(transfer).toHaveBeenCalledOnce();
    expect(transfer.mock.calls[0]?.[0]).toMatchObject({ resume: nonce });
  });

  it.each(["unknown", "failed"] as const)(
    "never exports a %s movement leg without its expected receipt when rename races the snapshot",
    async (status) => {
      const home = await temporaryHome();
      const secrets = memoryStore();
      secrets.entries.set("vault-key", Buffer.from(KEY).toString("base64"));
      const store = await WalletStore.open(home, {
        secrets,
        now: () => new Date(CREATED_AT),
        audit: async () => undefined,
      });
      await store.create("main", "", { phrase: TEST_PHRASE });

      const nonce = nonceFor(92);
      const movement = movementFixture("mv_renamerace", CREATED_AT, [{ status, nonce }]);
      await writeMovementFixture(home, movement);
      await appendReceipt(
        transferReceiptFixture("receipt-rename-race", nonce, "unknown"),
        join(home, "receipts.jsonl"),
      );

      let renamed = false;
      movementReadHook.afterRead = async () => {
        if (renamed) return;
        renamed = true;
        await writeMovementFixture(home, {
          ...movement,
          legs: [{ ...movement.legs[0]!, status: "sent", txHash: "0x1234" }],
        });
        await renameReceiptWallet("main", "renamed", join(home, "receipts.jsonl"));
      };

      const source = await exportBackupSource({ store, vaultKey: KEY });
      movementReadHook.afterRead = undefined;

      expect(source.movements).toEqual([]);
      const receiptKeys = new Set(
        source.transferReceipts.map(
          (receipt) => `${receipt.wallet}\0${receipt.transfer.nonce.toLowerCase()}`,
        ),
      );
      for (const capturedMovement of source.movements) {
        for (const leg of capturedMovement.legs) {
          if (leg.status === "unknown" && "from" in leg) {
            expect(receiptKeys.has(`${leg.from}\0${leg.nonce.toLowerCase()}`)).toBe(true);
          }
        }
      }
    },
  );

  it("fails an incoherent backup after three bounded snapshot retries", async () => {
    const home = await temporaryHome();
    const secrets = memoryStore();
    secrets.entries.set("vault-key", Buffer.from(KEY).toString("base64"));
    const store = await WalletStore.open(home, {
      secrets,
      now: () => new Date(CREATED_AT),
      audit: async () => undefined,
    });
    await store.create("main", "", { phrase: TEST_PHRASE });

    const nonce = nonceFor(93);
    const movement = movementFixture("mv_retryrace", CREATED_AT, [{ status: "unknown", nonce }]);
    await writeMovementFixture(home, movement);
    await appendReceipt(
      transferReceiptFixture("receipt-retry-race", nonce, "unknown"),
      join(home, "receipts.jsonl"),
    );

    let reads = 0;
    movementReadHook.afterRead = async () => {
      reads += 1;
      if (reads === 1) {
        await renameReceiptWallet("main", "renamed", join(home, "receipts.jsonl"));
      }
    };

    await expect(exportBackupSource({ store, vaultKey: KEY })).rejects.toMatchObject({
      code: "backup_snapshot_busy",
      message:
        "Backup files changed while they were being captured. Retry the backup; no backup was created or uploaded.",
    });
    expect(reads).toBe(3);
  });
});

describe("backup v2 size fallback", () => {
  it("builds and seals the selected plaintext within the owner relay limit", async () => {
    const buildRelayRestorePayload = Reflect.get(backup, "buildRelayRestorePayload") as unknown;
    expect(buildRelayRestorePayload).toBeTypeOf("function");
    const created = await createBackup({
      vault: v2SourceFixture({
        agents: [{ ...agentFixture("relay-edge"), instructions: "x".repeat(19_000) }],
      }),
      ownerKey: { kdf: "hkdf-sha256", key: KEY, salt: SALT },
      owner: OWNER,
      device: "d",
      now: () => new Date(CREATED_AT),
      randomBytes: () => NONCE,
    });
    const plaintext = await openBackup({ envelope: created.envelope, key: KEY });
    const relayPayload = (
      buildRelayRestorePayload as (options: {
        owner: string;
        device: string;
        kdf: backup.BackupKdf;
        key: Uint8Array;
        vault: BackupPlaintext;
      }) => string
    )({
      owner: OWNER,
      device: "d".repeat(32),
      kdf: readBackupHeader(created.envelope).kdf,
      key: KEY,
      vault: plaintext,
    });

    expect(Buffer.byteLength(relayPayload, "utf8")).toBeLessThanOrEqual(65_536);
    expect(Object.keys(JSON.parse(relayPayload) as object)).toEqual([
      "format",
      "v",
      "purpose",
      "owner",
      "device",
      "kdf",
      "key",
      "vault",
    ]);
    const recipient = createRelayKeyPair({ randomBytes: () => Buffer.alloc(32, 0x31) });
    let sealed: string | undefined;
    expect(() => {
      sealed = sealTo({
        recipientPublicKey: recipient.publicKey,
        plaintext: relayPayload,
        randomBytes: (length) => Buffer.alloc(length, length === 32 ? 0x41 : 0x51),
      });
    }).not.toThrow();
    expect(
      Buffer.from(
        openSealed({ recipientPrivateKey: recipient.privateKey, sealed: sealed! }),
      ).toString("utf8"),
    ).toBe(relayPayload);
  });

  it("pins the relay restore builder at the 65,536-byte boundary", () => {
    const plaintext = restoreV1Plaintext();
    plaintext.registry.accounts[0]!.label = "";
    const relayOptions = {
      owner: OWNER,
      device: "d".repeat(32),
      kdf: { name: "hkdf-sha256" as const, salt: toBase64Url(SALT) },
      key: KEY,
      vault: plaintext,
    };
    const base = backup.buildRelayRestorePayload(relayOptions);
    const remaining = 65_536 - Buffer.byteLength(base, "utf8");
    plaintext.registry.accounts[0]!.label = "x".repeat(remaining);
    const accepted = backup.buildRelayRestorePayload(relayOptions);
    expect(Buffer.byteLength(accepted, "utf8")).toBe(65_536);

    const recipient = createRelayKeyPair({ randomBytes: () => Buffer.alloc(32, 0x31) });
    expect(() =>
      sealTo({
        recipientPublicKey: recipient.publicKey,
        plaintext: accepted,
        randomBytes: (length) => Buffer.alloc(length, length === 32 ? 0x41 : 0x51),
      }),
    ).not.toThrow();

    plaintext.registry.accounts[0]!.label = "x".repeat(remaining + 1);
    const rejected = backup.buildRelayRestorePayload(relayOptions);
    expect(Buffer.byteLength(rejected, "utf8")).toBe(65_537);
    expect(() => sealTo({ recipientPublicKey: recipient.publicKey, plaintext: rejected })).toThrow(
      expect.objectContaining({ code: "backup_too_large" }),
    );
  });

  it("drops oversized agents first while retaining movements", async () => {
    const source = v2SourceFixture({
      agents: Array.from({ length: 4 }, (_, index) => ({
        ...agentFixture(`large-${index}`),
        instructions: `${index}`.repeat(19_000),
      })),
      movements: [
        movementFixture("mv_sizeopen1", CREATED_AT, [{ status: "planned", nonce: nonceFor(41) }]),
      ],
    });
    const created = await createBackup({
      vault: source,
      ownerKey: { kdf: "hkdf-sha256", key: KEY, salt: SALT },
      owner: OWNER,
      device: "test-device",
      now: () => new Date(CREATED_AT),
      randomBytes: () => NONCE,
    });
    expect(created.omitted).toEqual(["agents"]);
    const plaintext = await openBackup({ envelope: created.envelope, key: KEY });
    expect(plaintext).toMatchObject({ v: 2, movements: [{ id: "mv_sizeopen1" }] });
    expect("agents" in plaintext).toBe(false);
  });

  it("keeps a boundary-sized default-policy v2 source byte-identical to v1", async () => {
    const baseSource = sourceWithLabel("");
    const base = await createBackup({
      vault: baseSource,
      ownerKey: { kdf: "hkdf-sha256", key: KEY, salt: SALT },
      owner: OWNER,
      device: "d",
      now: () => new Date(CREATED_AT),
      randomBytes: () => NONCE,
    });
    const baseValue = JSON.parse(base.envelope) as EnvelopeValue;
    const boundary = findBoundaryLabel(
      base.bytes - baseValue.ciphertext.length,
      Buffer.from(baseValue.ciphertext, "base64url").byteLength,
    );
    const v1Source = sourceWithLabel("x".repeat(boundary.labelLength));
    const device = "d".repeat(boundary.deviceLength);
    const accepted = await createBackup({
      vault: v1Source,
      ownerKey: { kdf: "hkdf-sha256", key: KEY, salt: SALT },
      owner: OWNER,
      device,
      now: () => new Date(CREATED_AT),
      randomBytes: () => NONCE,
    });
    expect(accepted).not.toHaveProperty("omitted");
    expect(accepted.bytes).toBe(65_536);

    const v1Registry = v1Source.registry as backup.BackupRegistryV1;
    const v2Source: BackupSourceV2 = {
      ...v1Source,
      registry: {
        ...v1Registry,
        accounts: v1Registry.accounts.map((account) => ({
          ...account,
          ceilingAtomic: "5000000",
        })),
      },
      agents: [],
      swarms: [],
      movements: [],
      transferReceipts: [],
    };
    const acceptedV2 = await createBackup({
      vault: v2Source,
      ownerKey: { kdf: "hkdf-sha256", key: KEY, salt: SALT },
      owner: OWNER,
      device,
      now: () => new Date(CREATED_AT),
      randomBytes: () => NONCE,
    });
    expect(acceptedV2).toEqual(accepted);
  });
});

describe("backup v2 canonical ordering", () => {
  it("sorts agents and swarms by name and movements by createdAt then id", async () => {
    const source = v2SourceFixture({
      agents: [agentFixture("zeta"), agentFixture("alpha")],
      swarms: [swarmFixture("zeta"), swarmFixture("alpha")],
      movements: [
        movementFixture("mv_order0002", CREATED_AT, [{ status: "planned", nonce: nonceFor(51) }]),
        movementFixture("mv_order0001", CREATED_AT, [{ status: "unknown", nonce: nonceFor(52) }]),
        movementFixture("mv_order0003", "2026-09-28T00:00:00.000Z", [
          { status: "planned", nonce: nonceFor(53) },
        ]),
      ],
    });
    const created = await createBackup({
      vault: source,
      ownerKey: { kdf: "hkdf-sha256", key: KEY, salt: SALT },
      owner: OWNER,
      device: "test-device",
      now: () => new Date(CREATED_AT),
      randomBytes: () => NONCE,
    });
    const plaintext = (await openBackup({
      envelope: created.envelope,
      key: KEY,
    })) as backup.BackupPlaintextV2;
    expect(plaintext.agents?.map((agent) => agent.name)).toEqual(["alpha", "zeta"]);
    expect(plaintext.swarms?.map((swarm) => swarm.name)).toEqual(["alpha", "zeta"]);
    expect(plaintext.movements?.map((movement) => movement.id)).toEqual([
      "mv_order0003",
      "mv_order0001",
      "mv_order0002",
    ]);
  });
});

describe("backup v2 restore", () => {
  it("round-trips a cancelled leg as terminal without restore review", async () => {
    const base = movementFixture("mv_cancelled1", CREATED_AT, [
      { status: "planned", nonce: nonceFor(60) },
    ]);
    const movement = {
      ...base,
      legs: [{ ...base.legs[0]!, status: "cancelled" }],
    } as unknown as Movement;
    const source = restoreV2Plaintext({ movements: [movement] });
    delete (source as Partial<BackupPlaintextV2>).v;
    const created = await createBackup({
      vault: source as BackupSourceV2,
      ownerKey: { kdf: "hkdf-sha256", key: KEY, salt: SALT },
      owner: OWNER,
      device: "test-device",
      now: () => new Date(CREATED_AT),
      randomBytes: () => NONCE,
    });
    const plaintext = (await openBackup({
      envelope: created.envelope,
      key: KEY,
    })) as BackupPlaintextV2;
    expect(plaintext.movements).toMatchObject([
      { id: movement.id, legs: [{ status: "cancelled" }] },
    ]);

    const home = await temporaryHome();
    await restoreFromBackup({
      plaintext,
      home,
      vaultKey: KEY,
      device: "new-device",
    });

    const restored = await readMovement(home, movement.id);
    expect(restored.legs).toMatchObject([{ status: "cancelled" }]);
    expect(restored.legs[0]).not.toHaveProperty("restored");
    await expect(listUnfinishedMovements({ home, from: "main" })).resolves.toEqual([]);
  });

  it("rebuilds profiles, swarms, open movements, and receipts with private modes", async () => {
    const home = await temporaryHome();
    await writeFile(join(home, "receipts.jsonl"), "", { mode: 0o644 });
    expect((await stat(join(home, "receipts.jsonl"))).mode & 0o777).toBe(0o644);
    const agent = agentFixture("restored-agent");
    const swarm = restorableSwarm("restored");
    const nonce = nonceFor(61);
    const movement = movementFixture("mv_restore001", CREATED_AT, [{ status: "planned", nonce }]);
    const receipt = backupTransferReceiptFixture("restore-receipt", nonce);
    const plaintext = restoreV2Plaintext({
      agents: [agent],
      swarms: [swarm],
      movements: [movement],
      transferReceipts: [receipt],
    });

    const restored = await restoreFromBackup({
      plaintext,
      home,
      vaultKey: KEY,
      device: "new-device",
    });

    expect(restored).toMatchObject({
      default: "main",
      protected: false,
      networks: ["eip155:8453"],
      agents: ["restored-agent"],
      swarms: ["restored"],
      movements: [
        {
          id: "mv_restore001",
          from: "main",
          network: "eip155:8453",
          createdAt: CREATED_AT,
          pendingLegs: 0,
          unknownLegs: 1,
        },
      ],
      skipped: [],
      conflicts: [],
    });
    expect(JSON.parse(await readFile(join(home, "agents", "restored-agent.json"), "utf8"))).toEqual(
      agent,
    );
    expect(JSON.parse(await readFile(join(home, "swarms", "restored.json"), "utf8"))).toEqual({
      ...swarm,
      device: "new-device",
    });
    await expect(readMovement(home, movement.id)).resolves.toMatchObject({
      legs: [{ status: "unknown", nonce, restored: true }],
    });

    expect(
      (await readFile(join(home, "receipts.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    ).toEqual([receipt]);
    expect(JSON.parse(await readFile(join(home, "wallets.json"), "utf8"))).toMatchObject({
      wallets: {
        main: {
          ceilingAtomic: "5000000",
          routerRefill: { belowUsd: 2.5, tierUsd: 5 },
        },
      },
    });
    for (const directory of ["agents", "swarms", "movements"]) {
      expect((await stat(join(home, directory))).mode & 0o777).toBe(0o700);
    }
    for (const path of [
      join(home, "agents", "restored-agent.json"),
      join(home, "swarms", "restored.json"),
      join(home, "movements", `${movement.id}.json`),
      join(home, "receipts.jsonl"),
    ]) {
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    }
  });

  it("keeps an unsigned planned leg and its original nonce", async () => {
    const home = await temporaryHome();
    const nonce = nonceFor(62);
    const movement = movementFixture("mv_restore002", CREATED_AT, [{ status: "planned", nonce }]);

    const restored = await restoreFromBackup({
      plaintext: restoreV2Plaintext({ movements: [movement] }),
      home,
      vaultKey: KEY,
      device: "new-device",
    });

    await expect(readMovement(home, movement.id)).resolves.toMatchObject({
      legs: [{ status: "planned", nonce, restored: true }],
    });
    expect(restored.movements).toEqual([
      {
        id: movement.id,
        from: "main",
        network: "eip155:8453",
        createdAt: CREATED_AT,
        pendingLegs: 1,
        unknownLegs: 0,
      },
    ]);
  });

  it("preserves an explicit off ceiling while restoring v2 policy", async () => {
    const home = await temporaryHome();
    const plaintext = restoreV2Plaintext();
    plaintext.registry.accounts[0]!.ceilingAtomic = null;

    await restoreFromBackup({
      plaintext,
      home,
      vaultKey: KEY,
      device: "new-device",
    });

    expect(JSON.parse(await readFile(join(home, "wallets.json"), "utf8"))).toMatchObject({
      wallets: { main: { ceilingAtomic: null } },
    });
  });

  it("restores a signed retryable failed leg as unknown and never signs its nonce again", async () => {
    const home = await temporaryHome();
    const nonce = nonceFor(69);
    const base = movementFixture("mv_failed001", CREATED_AT, [{ status: "failed", nonce }]);
    const movement: Movement = {
      ...base,
      legs: [{ ...base.legs[0]!, reason: "relay_failed", retryable: true }],
    };

    await restoreFromBackup({
      plaintext: restoreV2Plaintext({
        movements: [movement],
        transferReceipts: [backupTransferReceiptFixture("failed-signed", nonce)],
      }),
      home,
      vaultKey: KEY,
      device: "new-device",
    });

    await expect(readMovement(home, movement.id)).resolves.toMatchObject({
      legs: [
        {
          from: "main",
          to: "0x2222222222222222222222222222222222222222",
          amountUsd: "1.00",
          purpose: "send",
          nonce,
          status: "unknown",
        },
      ],
    });
    const restoredLeg = (await readMovement(home, movement.id)).legs[0]!;
    expect(restoredLeg).not.toHaveProperty("reason");
    expect(restoredLeg).not.toHaveProperty("retryable");

    const transfer = vi.fn(async (args: TransferArgs): Promise<TransferResult> =>
      transferResultFixture(args, "unknown"),
    );
    const authorizationState = vi.fn(async () => "settled" as const);
    const randomNonce = vi.fn(() => nonceFor(99));
    const resumed = await executeMovement(
      { resume: movement.id },
      {
        home,
        store: { home } as unknown as WalletStore,
        secrets: {} as SecretStore,
        apiBase: "https://api.vapinetwork.ai",
        transfer,
        authorizationState,
        randomNonce,
      },
    );

    expect(resumed.legs).toMatchObject([{ status: "sent", nonce }]);
    expect(transfer).toHaveBeenCalledOnce();
    expect(transfer.mock.calls[0]?.[0]).toMatchObject({ resume: nonce });
    expect(transfer.mock.calls[0]?.[0].nonce).toBeUndefined();
    expect(authorizationState).toHaveBeenCalledOnce();
    expect(randomNonce).not.toHaveBeenCalled();
  });

  it("refuses to replace an expired restored nonce after a successor may have settled", async () => {
    const home = await temporaryHome();
    const nonce = nonceFor(82);
    const replacementNonce = nonceFor(83);
    const movement = movementFixture("mv_stalenonce", CREATED_AT, [{ status: "unknown", nonce }]);

    await restoreFromBackup({
      plaintext: restoreV2Plaintext({
        movements: [movement],
        transferReceipts: [backupTransferReceiptFixture("stale-signed", nonce)],
      }),
      home,
      vaultKey: KEY,
      device: "new-device",
    });

    const transfer = vi.fn(async (args: TransferArgs): Promise<TransferResult> =>
      args.resume === undefined
        ? transferResultFixture(args, "sent")
        : transferResultFixture(args, "unknown"),
    );
    const randomNonce = vi.fn(() => replacementNonce);
    await expect(
      executeMovement(
        { resume: movement.id },
        {
          home,
          store: { home } as unknown as WalletStore,
          secrets: {} as SecretStore,
          apiBase: "https://api.vapinetwork.ai",
          transfer,
          authorizationState: async () => "expired",
          addressReader: async () => OWNER,
          randomNonce,
        },
      ),
    ).rejects.toMatchObject({
      code: "restored_leg_review",
      message: expect.stringContaining(`vapi accounts distribute --resume ${movement.id}`),
    });

    expect(transfer).toHaveBeenCalledOnce();
    expect(transfer.mock.calls[0]?.[0]).toMatchObject({ resume: nonce });
    expect(randomNonce).not.toHaveBeenCalled();
    await expect(readMovement(home, movement.id)).resolves.toMatchObject({
      legs: [
        {
          status: "unknown",
          nonce,
          restored: true,
          reason: "restored_nonce_expired",
        },
      ],
    });

    transfer.mockClear();
    const replaced = await executeMovement(
      { resume: movement.id },
      {
        home,
        store: { home } as unknown as WalletStore,
        secrets: {} as SecretStore,
        apiBase: "https://api.vapinetwork.ai",
        transfer,
        authorizationState: async () => "expired",
        addressReader: async () => OWNER,
        randomNonce,
        replaceExpiredRestored: true,
      },
    );
    expect(replaced.legs).toMatchObject([{ status: "sent", nonce: replacementNonce }]);
    expect(replaced.legs[0]).not.toHaveProperty("restored");
    expect(transfer).toHaveBeenCalledOnce();
    expect(transfer.mock.calls[0]?.[0]).toMatchObject({ nonce: replacementNonce });
  });

  it("keeps a restored failed leg open when the movement outlives its receipt snapshot", async () => {
    const home = await temporaryHome();
    const sender = mnemonicToAccount(TEST_PHRASE, { addressIndex: 1 });
    const recipient = mnemonicToAccount(TEST_PHRASE, { addressIndex: 2 });
    const nonce = nonceFor(70);
    const base = movementFixture("mv_receiptgap", CREATED_AT, [{ status: "failed", nonce }]);
    const movement: Movement = {
      ...base,
      from: "sender",
      legs: [
        {
          ...base.legs[0]!,
          from: "sender",
          to: "recipient",
          status: "failed",
          reason: "relay_failed",
          retryable: false,
        },
      ],
    };
    const plaintext = restoreV2Plaintext({ movements: [movement], transferReceipts: [] });
    plaintext.nextDerivedIndex = 3;
    plaintext.accounts.push(
      {
        name: "sender",
        kind: "derived",
        index: 1,
        address: sender.address,
        createdAt: CREATED_AT,
      },
      {
        name: "recipient",
        kind: "derived",
        index: 2,
        address: recipient.address,
        createdAt: CREATED_AT,
      },
    );
    plaintext.registry.accounts.push(
      {
        name: "sender",
        spendCaps: { perCallAtomic: "1000000", perDayAtomic: "1000000" },
        ceilingAtomic: "5000000",
      },
      {
        name: "recipient",
        spendCaps: { perCallAtomic: "1000000", perDayAtomic: "1000000" },
        ceilingAtomic: "5000000",
      },
    );

    await restoreFromBackup({
      plaintext,
      home,
      vaultKey: KEY,
      device: "new-device",
    });

    await expect(readMovement(home, movement.id)).resolves.toMatchObject({
      legs: [{ status: "failed", retryable: false, restored: true }],
    });
    await expect(listUnfinishedMovements({ home, from: "sender" })).resolves.toMatchObject([
      { id: movement.id },
    ]);

    const secrets = memoryStore();
    secrets.entries.set("vault-key", Buffer.from(KEY).toString("base64"));
    const store = await WalletStore.open(home, {
      secrets,
      now: () => new Date(CREATED_AT),
      audit: async () => undefined,
    });
    const transfer = vi.fn(async (args: TransferArgs): Promise<TransferResult> =>
      transferResultFixture(args, "sent"),
    );
    await expect(
      executeMovement(
        {
          reason: "distribute",
          from: "sender",
          network: "eip155:8453",
          legs: [{ to: "recipient", amountUsd: "1.00" }],
        },
        {
          home,
          store,
          secrets,
          apiBase: "https://api.vapinetwork.ai",
          transfer,
          randomId: () => "mv_aftergap01",
          randomNonce: () => nonceFor(71),
        },
      ),
    ).rejects.toMatchObject({ code: "unfinished_movement", movementId: movement.id });
    expect(transfer).not.toHaveBeenCalled();

    for (const change of [
      () => store.remove("sender", { force: true }),
      () => store.rename("sender", "renamed-sender"),
      () => store.remove("recipient", { force: true }),
      () => store.rename("recipient", "renamed-recipient"),
    ]) {
      await expect(change()).rejects.toThrow(/unfinished movement mv_receiptgap/i);
    }
  });

  it("does not sign a restored planned leg without the terminal-only flag", async () => {
    const home = await temporaryHome();
    const nonce = nonceFor(85);
    const movement = movementFixture("mv_restplan", CREATED_AT, [{ status: "planned", nonce }]);

    await restoreFromBackup({
      plaintext: restoreV2Plaintext({ movements: [movement] }),
      home,
      vaultKey: KEY,
      device: "new-device",
    });

    const transfer = vi.fn(async (args: TransferArgs): Promise<TransferResult> =>
      transferResultFixture(args, "sent"),
    );
    const deps = {
      home,
      store: { home } as unknown as WalletStore,
      secrets: {} as SecretStore,
      apiBase: "https://api.vapinetwork.ai",
      transfer,
      authorizationState: async () => "expired" as const,
      addressReader: async () => OWNER,
    };
    await expect(executeMovement({ resume: movement.id }, deps)).rejects.toMatchObject({
      code: "restored_leg_review",
      message: expect.stringContaining("--replace-expired-restored"),
    });
    expect(transfer).not.toHaveBeenCalled();
    await expect(readMovement(home, movement.id)).resolves.toMatchObject({
      legs: [{ status: "planned", nonce, restored: true }],
    });

    const resumed = await executeMovement(
      { resume: movement.id },
      { ...deps, replaceExpiredRestored: true },
    );
    expect(resumed.legs).toMatchObject([{ status: "sent", nonce }]);
    expect(transfer).toHaveBeenCalledOnce();
  });

  it("keeps a restored planned leg open when its post-backup authorization is absent", async () => {
    const home = await temporaryHome();
    const nonce = nonceFor(86);
    const movement = movementFixture("mv_restorecan", CREATED_AT, [{ status: "planned", nonce }]);

    // The backup was taken before the original device signed and relayed this
    // leg. Its later receipt is deliberately absent from the restored home.
    await restoreFromBackup({
      plaintext: restoreV2Plaintext({ movements: [movement] }),
      home,
      vaultKey: KEY,
      device: "new-device",
    });
    const ledgerPath = join(home, "spend-ledger.json");
    await reserveSpend(
      1_000_000n,
      { perCallAtomic: "1000000", perDayAtomic: "1000000" },
      {
        ledgerPath,
        now: new Date(CREATED_AT),
        wallet: "main",
        reservationId: nonce.toLowerCase(),
      },
    );
    const transfer = vi.fn(async (args: TransferArgs): Promise<TransferResult> =>
      transferResultFixture(args, "sent"),
    );
    const deps = {
      home,
      store: { home } as unknown as WalletStore,
      secrets: {} as SecretStore,
      apiBase: "https://api.vapinetwork.ai",
      transfer,
      addressReader: async () => OWNER,
      authorizationState: vi.fn(async () => "expired" as const),
    };

    await expect(cancelMovement(movement.id, deps)).rejects.toMatchObject({
      code: "movement_not_cancellable",
      movementId: movement.id,
      message: expect.stringContaining(`--resume ${movement.id} --replace-expired-restored`),
    });
    expect(transfer).not.toHaveBeenCalled();
    await expect(readSpendLedger(ledgerPath, new Date(CREATED_AT), "main")).resolves.toMatchObject({
      spentAtomic: "1000000",
    });
    await expect(readMovement(home, movement.id)).resolves.toMatchObject({
      legs: [{ status: "planned", nonce, restored: true }],
    });
    await expect(listUnfinishedMovements({ home, from: "main" })).resolves.toMatchObject([
      { id: movement.id },
    ]);

    await expect(
      executeMovement(
        {
          reason: "send",
          from: "main",
          network: "eip155:8453",
          legs: [{ to: "owner", amountUsd: "1.00" }],
        },
        { ...deps, randomId: () => "mv_afterresto", randomNonce: () => nonceFor(87) },
      ),
    ).rejects.toMatchObject({
      code: "unfinished_movement",
      movementId: movement.id,
    });
    expect(transfer).not.toHaveBeenCalled();
  });

  it.each(["vault", "registry", "agent", "swarm", "movement"] as const)(
    "finishes the same restore after interruption following %s publication",
    async (interruptedStep) => {
      const home = await temporaryHome();
      const agent = agentFixture("resume-agent");
      const swarm = restorableSwarm("resume-swarm");
      const movement = movementFixture("mv_resumepub", CREATED_AT, [
        { status: "planned", nonce: nonceFor(84) },
      ]);
      const plaintext = restoreV2Plaintext({
        agents: [agent],
        swarms: [swarm],
        movements: [movement],
      });

      await expect(
        backup.restoreBackupPlaintext({
          plaintext,
          home,
          vaultKey: KEY,
          device: "new-device",
          afterPublish: async (step: { kind: string }) => {
            if (step.kind === interruptedStep) throw new Error(`interrupted after ${step.kind}`);
          },
        }),
      ).rejects.toThrow(`interrupted after ${interruptedStep}`);

      await expect(
        restoreFromBackup({ plaintext, home, vaultKey: KEY, device: "new-device" }),
      ).resolves.toMatchObject({
        agents: [agent.name],
        swarms: [swarm.name],
        movements: [{ id: movement.id }],
        skipped: [],
        conflicts: [],
      });
      await expect(readFile(join(home, ".backup-restore.json"), "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );

  it("refuses a different backup after an interrupted vault publication", async () => {
    const home = await temporaryHome();
    const original = restoreV2Plaintext({ agents: [agentFixture("original-agent")] });
    const different = restoreV2Plaintext({ agents: [agentFixture("different-agent")] });

    await expect(
      backup.restoreBackupPlaintext({
        plaintext: original,
        home,
        vaultKey: KEY,
        device: "new-device",
        afterPublish: async (step) => {
          if (step.kind === "vault") throw new Error("interrupted after vault");
        },
      }),
    ).rejects.toThrow("interrupted after vault");
    const publishedVault = await readFile(join(home, "vault.json"));
    if (process.platform !== "win32") {
      expect((await stat(join(home, ".backup-restore.json"))).mode & 0o777).toBe(0o600);
    }

    await expectBackupError(
      restoreFromBackup({
        plaintext: different,
        home,
        vaultKey: KEY,
        device: "new-device",
      }),
      { code: "vault_exists" },
    );
    await expect(readFile(join(home, "vault.json"))).resolves.toEqual(publishedVault);
    await expect(readFile(join(home, "wallets.json"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      readFile(join(home, "agents", "different-agent.json"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("uses every already-journaled transfer receipt to normalize non-sent legs", async () => {
    const home = await temporaryHome();
    const nonces = [nonceFor(70), nonceFor(71), nonceFor(72)] as const;
    for (const [index, nonce] of nonces.entries()) {
      await appendReceipt(
        transferReceiptFixture(`existing-signed-${index}`, nonce, "unknown"),
        join(home, "receipts.jsonl"),
      );
    }
    const base = movementFixture("mv_existing01", CREATED_AT, [
      { status: "planned", nonce: nonces[0] },
      { status: "failed", nonce: nonces[1] },
      { status: "unknown", nonce: nonces[2] },
    ]);
    const movement: Movement = {
      ...base,
      legs: [
        base.legs[0]!,
        { ...base.legs[1]!, reason: "relay_failed", retryable: true },
        { ...base.legs[2]!, reason: "stale_failure", retryable: true },
      ],
    };

    await restoreFromBackup({
      plaintext: restoreV2Plaintext({ movements: [movement] }),
      home,
      vaultKey: KEY,
      device: "new-device",
    });

    const restored = await readMovement(home, movement.id);
    expect(restored.legs).toEqual(
      movement.legs.map((leg) => ({
        from: leg.from,
        to: leg.to,
        amountUsd: leg.amountUsd,
        purpose: leg.purpose,
        nonce: leg.nonce,
        status: "unknown",
        restored: true,
      })),
    );
  });

  it("keeps a signed leg unknown when its receipt cannot be published", async () => {
    const home = await temporaryHome();
    const nonce = nonceFor(68);
    const movement = movementFixture("mv_receipt01", CREATED_AT, [{ status: "planned", nonce }]);
    await mkdir(join(home, "receipts.jsonl"));

    const restored = await restoreFromBackup({
      plaintext: restoreV2Plaintext({
        movements: [movement],
        transferReceipts: [backupTransferReceiptFixture("blocked-receipt", nonce)],
      }),
      home,
      vaultKey: KEY,
      device: "new-device",
    });

    expect(restored.skipped).toContainEqual({
      kind: "receipt",
      name: "blocked-receipt",
      reason: "write_failed",
    });
    await expect(readMovement(home, movement.id)).resolves.toMatchObject({
      legs: [{ status: "unknown", nonce }],
    });

    const transfer = vi.fn(async (_args: TransferArgs): Promise<TransferResult> => {
      throw new TransferError("resume_not_found", "The signed transfer receipt is unavailable.");
    });
    const randomNonce = vi.fn(() => nonceFor(99));
    await expect(
      executeMovement(
        { resume: movement.id },
        {
          home,
          store: { home } as unknown as WalletStore,
          secrets: {} as SecretStore,
          apiBase: "https://api.vapinetwork.ai",
          transfer,
          randomNonce,
        },
      ),
    ).rejects.toThrow();
    expect(transfer).toHaveBeenCalledOnce();
    expect(transfer.mock.calls[0]?.[0]).toMatchObject({ resume: nonce });
    expect(randomNonce).not.toHaveBeenCalled();
    await expect(readMovement(home, movement.id)).resolves.toMatchObject({
      legs: [{ status: "unknown", nonce }],
    });
  });

  it("uses the restored receipt journal to settle a signed nonce without signing it again", async () => {
    const home = await temporaryHome();
    const signedNonce = nonceFor(63);
    const unsignedNonce = nonceFor(64);
    const movement = movementFixture("mv_restore003", CREATED_AT, [
      { status: "planned", nonce: signedNonce },
      { status: "planned", nonce: unsignedNonce },
    ]);
    const signedReceipt = backupTransferReceiptFixture("resume-receipt", signedNonce);
    const failedReceipt: BackupTransferReceipt = {
      ...signedReceipt,
      transfer: {
        ...signedReceipt.transfer,
        status: "failed",
        request: undefined,
      },
      error: { code: "relay_failed", message: "The relay rejected the transfer." },
    };
    await restoreFromBackup({
      plaintext: restoreV2Plaintext({
        movements: [movement],
        transferReceipts: [signedReceipt, failedReceipt],
      }),
      home,
      vaultKey: KEY,
      device: "new-device",
    });

    const transfer = vi.fn(async (args: TransferArgs): Promise<TransferResult> => {
      if (args.resume !== undefined) {
        throw new TransferError("relay_failed", "The relay rejected the replay.");
      }
      return {
        status: "sent",
        from: args.from,
        to: OWNER,
        toName: args.to,
        toKind: "owner",
        amountUsd: String(args.amountUsd),
        amountAtomic: "1000000",
        network: "eip155:8453",
        txHash: "0x1234",
        nonce: args.nonce!,
        replayed: false,
      };
    });
    const rpcMethods: string[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as { id: number; method: string };
      rpcMethods.push(request.method);
      const result =
        request.method === "eth_getBlockByNumber"
          ? {
              number: "0x10",
              hash: `0x${"cd".repeat(32)}`,
              parentHash: `0x${"00".repeat(32)}`,
              timestamp: "0x6abb44c0",
              transactions: [],
            }
          : encodeFunctionResult({
              abi: [
                {
                  type: "function",
                  name: "authorizationState",
                  stateMutability: "view",
                  inputs: [
                    { name: "authorizer", type: "address" },
                    { name: "nonce", type: "bytes32" },
                  ],
                  outputs: [{ name: "", type: "bool" }],
                },
              ] as const,
              functionName: "authorizationState",
              result: true,
            });
      return Response.json({ jsonrpc: "2.0", id: request.id, result });
    });
    const randomNonce = vi.fn(() => nonceFor(99));

    const deps = {
      home,
      store: { home } as unknown as WalletStore,
      secrets: {} as SecretStore,
      apiBase: "https://api.vapinetwork.ai",
      transfer,
      fetchImpl,
      randomNonce,
      addressReader: async () => OWNER,
    };
    await expect(executeMovement({ resume: movement.id }, deps)).rejects.toMatchObject({
      code: "restored_leg_review",
    });
    await expect(readMovement(home, movement.id)).resolves.toMatchObject({
      legs: [
        { status: "sent", nonce: signedNonce },
        { status: "planned", nonce: unsignedNonce, restored: true },
      ],
    });
    expect(
      transfer.mock.calls.map(([args]) => ({ nonce: args.nonce, resume: args.resume })),
    ).toEqual([{ nonce: undefined, resume: signedNonce }]);

    const resumed = await executeMovement(
      { resume: movement.id },
      { ...deps, replaceExpiredRestored: true },
    );

    expect(resumed.legs).toMatchObject([
      { status: "sent", nonce: signedNonce },
      { status: "sent", nonce: unsignedNonce },
    ]);
    expect(
      transfer.mock.calls.map(([args]) => ({ nonce: args.nonce, resume: args.resume })),
    ).toEqual([
      { nonce: undefined, resume: signedNonce },
      { nonce: unsignedNonce, resume: undefined },
    ]);
    expect(rpcMethods).toEqual(["eth_getBlockByNumber", "eth_call"]);
    expect(randomNonce).not.toHaveBeenCalled();
    expect((await readFile(join(home, "receipts.jsonl"), "utf8")).trim().split("\n")).toHaveLength(
      2,
    );
  });

  it("skips broken relationships while restoring an independent lead profile", async () => {
    const home = await temporaryHome();
    const nonce = nonceFor(65);
    const swarm: SwarmFile = {
      ...restorableSwarm("broken"),
      members: [
        {
          account: "missing-member",
          address: "0x2222222222222222222222222222222222222222",
          role: "lead",
          weight: 1,
          targetAtomic: "1000000",
          ceilingAtomic: "5000000",
          steps: {
            creating: false,
            created: true,
            capped: true,
            linked: true,
            profiled: true,
          },
        },
      ],
    };
    const movement: Movement = {
      ...movementFixture("mv_missing01", CREATED_AT, [{ status: "planned", nonce }]),
      from: "missing-sender",
      legs: [
        {
          from: "missing-sender",
          to: OWNER,
          amountUsd: "1.00",
          purpose: "send",
          nonce,
          status: "planned",
        },
      ],
    };
    const receipt = {
      ...backupTransferReceiptFixture("missing-receipt", nonce),
      wallet: "missing-sender",
    };

    const restored = await restoreFromBackup({
      plaintext: restoreV2Plaintext({
        agents: [agentFixture("team-lead")],
        swarms: [swarm],
        movements: [movement],
        transferReceipts: [receipt],
      }),
      home,
      vaultKey: KEY,
      device: "new-device",
    });

    expect(restored.agents).toEqual(["team-lead"]);
    expect(restored.swarms).toEqual([]);
    expect(restored.movements).toEqual([]);
    expect(restored.skipped).toEqual([
      { kind: "swarm", name: "broken", reason: "missing_account" },
      { kind: "movement", name: movement.id, reason: "missing_account" },
      { kind: "receipt", name: receipt.id, reason: "missing_account" },
    ]);
    await expect(readFile(join(home, "agents", "team-lead.json"), "utf8")).resolves.toContain(
      '"wallet": "main"',
    );
    await expect(readFile(join(home, "swarms", "broken.json"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(readMovement(home, movement.id)).rejects.toMatchObject({
      code: "movement_not_found",
    });
  });

  it("requires restored accounts for active swarm setup steps but allows unstarted accounts", async () => {
    const home = await temporaryHome();
    const activeMember: SwarmFile = {
      ...restorableSwarm("active-member"),
      members: [
        {
          account: "pending-member",
          role: "lead",
          weight: 1,
          targetAtomic: "1000000",
          ceilingAtomic: "5000000",
          steps: {
            creating: true,
            created: false,
            capped: false,
            linked: false,
            profiled: false,
          },
        },
      ],
    };
    const activeTreasury: SwarmFile = {
      ...restorableSwarm("active-treasury"),
      treasury: {
        account: "pending-treasury",
        steps: { creating: true, created: false, capped: false, linked: false },
      },
    };
    const unstarted: SwarmFile = {
      ...restorableSwarm("unstarted"),
      treasury: {
        account: "future-treasury",
        steps: { creating: false, created: false, capped: false, linked: false },
      },
      members: [
        {
          account: "future-member",
          role: "lead",
          weight: 1,
          targetAtomic: "1000000",
          ceilingAtomic: "5000000",
          steps: {
            creating: false,
            created: false,
            capped: false,
            linked: false,
            profiled: false,
          },
        },
      ],
    };

    const restored = await restoreFromBackup({
      plaintext: restoreV2Plaintext({ swarms: [activeMember, activeTreasury, unstarted] }),
      home,
      vaultKey: KEY,
      device: "new-device",
    });

    expect(restored.swarms).toEqual(["unstarted"]);
    expect(restored.skipped).toEqual([
      { kind: "swarm", name: "active-member", reason: "missing_account" },
      { kind: "swarm", name: "active-treasury", reason: "missing_account" },
    ]);
    await expect(readFile(join(home, "swarms", "unstarted.json"), "utf8")).resolves.toContain(
      '"device": "new-device"',
    );
  });

  it("restores an interrupted member setup before its address was recorded", async () => {
    const home = await temporaryHome();
    const plaintext = restoreV2Plaintext();
    plaintext.accounts.push({
      name: "member",
      kind: "imported",
      address: privateKeyToAccount(IMPORTED_PRIVATE_KEY).address,
      privateKey: IMPORTED_PRIVATE_KEY,
      createdAt: CREATED_AT,
    });
    plaintext.registry.accounts.push({
      name: "member",
      spendCaps: { perCallAtomic: "100000", perDayAtomic: "1000000" },
      ceilingAtomic: "5000000",
    });
    const swarm: SwarmFile = {
      ...restorableSwarm("address-pending"),
      members: [
        {
          account: "member",
          role: "lead",
          weight: 1,
          targetAtomic: "1000000",
          ceilingAtomic: "5000000",
          steps: {
            creating: true,
            created: false,
            capped: false,
            linked: false,
            profiled: false,
          },
        },
      ],
    };

    const restored = await restoreFromBackup({
      plaintext: { ...plaintext, swarms: [swarm] },
      home,
      vaultKey: KEY,
      device: "new-device",
    });

    expect(restored.swarms).toEqual([swarm.name]);
    expect(restored.skipped).toEqual([]);
    await expect(readFile(join(home, "swarms", `${swarm.name}.json`), "utf8")).resolves.toContain(
      '"device": "new-device"',
    );
  });

  it("appends a backed-up receipt when an existing receipt has the same id", async () => {
    const home = await temporaryHome();
    const nonce = nonceFor(73);
    const movement = movementFixture("mv_sameid001", CREATED_AT, [{ status: "planned", nonce }]);
    const restoredReceipt = backupTransferReceiptFixture("shared-receipt-id", nonce);
    const existingReceipt = {
      ...restoredReceipt,
      resourceUrl: "https://different.example.test/transfer",
    };
    await writeFile(join(home, "receipts.jsonl"), `${JSON.stringify(existingReceipt)}\n`);

    const restored = await restoreFromBackup({
      plaintext: restoreV2Plaintext({
        movements: [movement],
        transferReceipts: [restoredReceipt],
      }),
      home,
      vaultKey: KEY,
      device: "new-device",
    });

    const lines = (await readFile(join(home, "receipts.jsonl"), "utf8")).trim().split("\n");
    expect(lines.map((line) => JSON.parse(line))).toEqual([existingReceipt, restoredReceipt]);
    expect(restored.conflicts).not.toContainEqual({
      kind: "receipt",
      name: restoredReceipt.id,
      path: join(home, "receipts.jsonl"),
    });
  });

  it("appends backed-up receipts after malformed existing journal rows", async () => {
    const home = await temporaryHome();
    const nonce = nonceFor(74);
    const movement = movementFixture("mv_malformed1", CREATED_AT, [{ status: "planned", nonce }]);
    const receipt = backupTransferReceiptFixture("after-malformed", nonce);
    await writeFile(join(home, "receipts.jsonl"), "not-json\n");

    const restored = await restoreFromBackup({
      plaintext: restoreV2Plaintext({ movements: [movement], transferReceipts: [receipt] }),
      home,
      vaultKey: KEY,
      device: "new-device",
    });

    const lines = (await readFile(join(home, "receipts.jsonl"), "utf8")).trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe("not-json");
    expect(JSON.parse(lines[1]!)).toEqual(receipt);
    expect(restored.skipped).not.toContainEqual({
      kind: "receipt",
      name: receipt.id,
      reason: "write_failed",
    });
  });

  it("separates appended receipts from an unterminated existing journal row", async () => {
    const home = await temporaryHome();
    const existing = backupTransferReceiptFixture("existing-no-newline", nonceFor(75));
    const nonce = nonceFor(76);
    const restoredReceipt = backupTransferReceiptFixture("appended-with-newline", nonce);
    const movement = movementFixture("mv_newline001", CREATED_AT, [{ status: "planned", nonce }]);
    await writeFile(join(home, "receipts.jsonl"), JSON.stringify(existing));

    await restoreFromBackup({
      plaintext: restoreV2Plaintext({
        movements: [movement],
        transferReceipts: [restoredReceipt],
      }),
      home,
      vaultKey: KEY,
      device: "new-device",
    });

    const lines = (await readFile(join(home, "receipts.jsonl"), "utf8"))
      .split("\n")
      .filter(Boolean);
    expect(lines.map((line) => JSON.parse(line))).toEqual([existing, restoredReceipt]);
  });

  it("reconciles a conflicting existing movement without replacing its contents or re-signing", async () => {
    const home = await temporaryHome();
    const nonce = nonceFor(77);
    const existing = movementFixture("mv_conflict02", CREATED_AT, [{ status: "planned", nonce }]);
    const backedUp: Movement = {
      ...existing,
      legs: [{ ...existing.legs[0]!, amountUsd: "2.00" }],
    };
    const receipt = backupTransferReceiptFixture("conflicting-signed", nonce);
    await writeMovementFixture(home, existing);

    const restored = await restoreFromBackup({
      plaintext: restoreV2Plaintext({
        movements: [backedUp],
        transferReceipts: [receipt],
      }),
      home,
      vaultKey: KEY,
      device: "new-device",
    });

    expect(restored.conflicts).toContainEqual({
      kind: "movement",
      name: existing.id,
      path: join(home, "movements", `${existing.id}.json`),
    });
    const reconciled = await readMovement(home, existing.id);
    expect(reconciled.legs).toEqual([
      {
        ...existing.legs[0]!,
        status: "unknown",
        restored: true,
      },
    ]);
    expect(reconciled.legs[0]?.amountUsd).toBe("1.00");
    expect(
      (await readFile(join(home, "receipts.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    ).toEqual([receipt]);
    if (process.platform !== "win32") {
      expect((await stat(join(home, "movements", `${existing.id}.json`))).mode & 0o777).toBe(0o600);
    }

    const transfer = vi.fn(async (args: TransferArgs): Promise<TransferResult> =>
      transferResultFixture(args, "unknown"),
    );
    const authorizationState = vi.fn(async () => "settled" as const);
    const randomNonce = vi.fn(() => nonceFor(99));
    await executeMovement(
      { resume: existing.id },
      {
        home,
        store: { home } as unknown as WalletStore,
        secrets: {} as SecretStore,
        apiBase: "https://api.vapinetwork.ai",
        transfer,
        authorizationState,
        randomNonce,
      },
    );

    expect(transfer).toHaveBeenCalledOnce();
    expect(transfer.mock.calls[0]?.[0]).toMatchObject({ resume: nonce });
    expect(transfer.mock.calls[0]?.[0].nonce).toBeUndefined();
    expect(randomNonce).not.toHaveBeenCalled();
  });

  it("makes signed conflicting movements safe before publishing the vault", async () => {
    const home = await temporaryHome();
    const nonce = nonceFor(81);
    const existing = movementFixture("mv_crashsafe1", CREATED_AT, [{ status: "planned", nonce }]);
    const backedUp: Movement = {
      ...existing,
      legs: [{ ...existing.legs[0]!, amountUsd: "2.00" }],
    };
    const receipt = backupTransferReceiptFixture("crash-safe-signed", nonce);
    await writeMovementFixture(home, existing);

    let receiptWasPublished = false;
    let movementWasReconciled = false;
    await expect(
      backup.restoreBackupPlaintext({
        plaintext: restoreV2Plaintext({
          movements: [backedUp],
          transferReceipts: [receipt],
        }),
        home,
        vaultKey: KEY,
        device: "new-device",
        beforePublish: async () => {
          receiptWasPublished = await readFile(join(home, "receipts.jsonl"), "utf8").then(
            (journal) => journal.split("\n").includes(JSON.stringify(receipt)),
            () => false,
          );
          movementWasReconciled = await readMovement(home, existing.id).then(
            (movement) => movement.legs[0]?.status === "unknown",
            () => false,
          );
          throw new Error("simulated crash before vault publication");
        },
      }),
    ).rejects.toThrow("simulated crash before vault publication");

    expect(receiptWasPublished).toBe(true);
    expect(movementWasReconciled).toBe(true);
    await expect(readFile(join(home, "vault.json"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(readFile(join(home, "wallets.json"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });

    await expect(
      restoreFromBackup({
        plaintext: restoreV2Plaintext({
          movements: [backedUp],
          transferReceipts: [receipt],
        }),
        home,
        vaultKey: KEY,
        device: "new-device",
      }),
    ).resolves.toMatchObject({
      conflicts: [
        {
          kind: "movement",
          name: existing.id,
          path: join(home, "movements", `${existing.id}.json`),
        },
      ],
    });

    const transfer = vi.fn(async (args: TransferArgs): Promise<TransferResult> =>
      transferResultFixture(args, "unknown"),
    );
    const authorizationState = vi.fn(async () => "settled" as const);
    const randomNonce = vi.fn(() => nonceFor(99));
    await executeMovement(
      { resume: existing.id },
      {
        home,
        store: { home } as unknown as WalletStore,
        secrets: {} as SecretStore,
        apiBase: "https://api.vapinetwork.ai",
        transfer,
        authorizationState,
        randomNonce,
      },
    );

    expect(transfer).toHaveBeenCalledOnce();
    expect(transfer.mock.calls[0]?.[0]).toMatchObject({ resume: nonce });
    expect(transfer.mock.calls[0]?.[0].nonce).toBeUndefined();
    expect(randomNonce).not.toHaveBeenCalled();
  });

  it("requires review when a conflicting existing movement authorization expires", async () => {
    const home = await temporaryHome();
    const nonce = nonceFor(82);
    const existing = movementFixture("mv_conflictexp", CREATED_AT, [{ status: "unknown", nonce }]);
    const backedUp: Movement = {
      ...existing,
      legs: [{ ...existing.legs[0]!, amountUsd: "2.00" }],
    };
    const receipt = backupTransferReceiptFixture("conflicting-expired", nonce);
    await writeMovementFixture(home, existing);

    let restoredBeforeVaultPublication = false;
    await backup.restoreBackupPlaintext({
      plaintext: restoreV2Plaintext({
        movements: [backedUp],
        transferReceipts: [receipt],
      }),
      home,
      vaultKey: KEY,
      device: "new-device",
      beforePublish: async () => {
        restoredBeforeVaultPublication =
          (await readMovement(home, existing.id)).legs[0]?.restored === true;
      },
    });

    expect(restoredBeforeVaultPublication).toBe(true);
    const transfer = vi.fn(async (args: TransferArgs): Promise<TransferResult> =>
      transferResultFixture(args, "unknown"),
    );
    const randomNonce = vi.fn(() => nonceFor(99));
    await expect(
      executeMovement(
        { resume: existing.id },
        {
          home,
          store: { home } as unknown as WalletStore,
          secrets: {} as SecretStore,
          apiBase: "https://api.vapinetwork.ai",
          transfer,
          authorizationState: async () => "expired",
          addressReader: async () => OWNER,
          randomNonce,
        },
      ),
    ).rejects.toMatchObject({ code: "restored_leg_review" });

    expect(transfer).toHaveBeenCalledOnce();
    expect(transfer.mock.calls[0]?.[0]).toMatchObject({ resume: nonce });
    expect(randomNonce).not.toHaveBeenCalled();
    await expect(readMovement(home, existing.id)).resolves.toMatchObject({
      legs: [
        {
          status: "unknown",
          nonce,
          restored: true,
          reason: "restored_nonce_expired",
        },
      ],
    });
  });

  it("requires restored-leg review for a signed leg in a skipped movement", async () => {
    const home = await temporaryHome();
    const signedNonce = nonceFor(79);
    const missingNonce = nonceFor(80);
    const existing = movementFixture("mv_skipped001", CREATED_AT, [
      { status: "planned", nonce: signedNonce },
      { status: "sent", nonce: missingNonce },
    ]);
    const backedUp: Movement = {
      ...existing,
      legs: [
        existing.legs[0]!,
        {
          ...existing.legs[1]!,
          from: "missing-sender",
        },
      ],
    };
    const receipt = backupTransferReceiptFixture("skipped-movement-signed", signedNonce);
    await writeMovementFixture(home, { ...existing, legs: backedUp.legs });

    let restoredBeforeVaultPublication = false;
    const restored = await backup.restoreBackupPlaintext({
      plaintext: restoreV2Plaintext({
        movements: [backedUp],
        transferReceipts: [receipt],
      }),
      home,
      vaultKey: KEY,
      device: "new-device",
      beforePublish: async () => {
        restoredBeforeVaultPublication =
          (await readMovement(home, existing.id)).legs[0]?.restored === true;
      },
    });

    expect(restored.skipped).toContainEqual({
      kind: "movement",
      name: backedUp.id,
      reason: "missing_account",
    });
    expect(restored.skipped).not.toContainEqual({
      kind: "receipt",
      name: receipt.id,
      reason: "movement_skipped",
    });
    expect(
      (await readFile(join(home, "receipts.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    ).toEqual([receipt]);

    const transfer = vi.fn(async (args: TransferArgs): Promise<TransferResult> =>
      transferResultFixture(args, "unknown"),
    );
    const randomNonce = vi.fn(() => nonceFor(81));
    await expect(
      executeMovement(
        { resume: existing.id },
        {
          home,
          store: { home } as unknown as WalletStore,
          secrets: {} as SecretStore,
          apiBase: "https://api.vapinetwork.ai",
          transfer,
          authorizationState: async () => "expired",
          addressReader: async () => OWNER,
          randomNonce,
        },
      ),
    ).rejects.toMatchObject({ code: "restored_leg_review" });

    expect(restoredBeforeVaultPublication).toBe(true);
    expect(transfer).toHaveBeenCalledOnce();
    expect(transfer.mock.calls[0]?.[0]).toMatchObject({ resume: signedNonce });
    expect(transfer.mock.calls[0]?.[0].nonce).toBeUndefined();
    expect(randomNonce).not.toHaveBeenCalled();
    await expect(readMovement(home, existing.id)).resolves.toMatchObject({
      legs: [
        {
          status: "unknown",
          nonce: signedNonce,
          restored: true,
          reason: "restored_nonce_expired",
        },
        { from: "missing-sender", status: "sent", nonce: missingNonce },
      ],
    });
  });

  it("repairs private modes for byte-identical restored files and their directories", async () => {
    const home = await temporaryHome();
    const agent = agentFixture("mode-agent");
    const swarm = restorableSwarm("mode-swarm");
    const movement = movementFixture("mv_modes0001", CREATED_AT, [
      { status: "planned", nonce: nonceFor(78) },
    ]);
    const files = [
      [
        join(home, "agents"),
        join(home, "agents", "mode-agent.json"),
        `${JSON.stringify(agent, null, 2)}\n`,
      ],
      [
        join(home, "swarms"),
        join(home, "swarms", "mode-swarm.json"),
        `${JSON.stringify({ ...swarm, device: "new-device" }, null, 2)}\n`,
      ],
      [
        join(home, "movements"),
        join(home, "movements", `${movement.id}.json`),
        serializeMovement({
          ...movement,
          legs: movement.legs.map((leg) => ({ ...leg, restored: true })),
        }),
      ],
    ] as const;
    for (const [directory, path, bytes] of files) {
      await mkdir(directory, { recursive: true, mode: 0o755 });
      await writeFile(path, bytes, { mode: 0o644 });
      await chmod(directory, 0o755);
      await chmod(path, 0o644);
    }

    await restoreFromBackup({
      plaintext: restoreV2Plaintext({ agents: [agent], swarms: [swarm], movements: [movement] }),
      home,
      vaultKey: KEY,
      device: "new-device",
    });

    if (process.platform !== "win32") {
      for (const [directory, path] of files) {
        expect((await stat(directory)).mode & 0o777).toBe(0o700);
        expect((await stat(path)).mode & 0o777).toBe(0o600);
      }
    }
  });

  it("reports different extras as conflicts and accepts byte-identical extras", async () => {
    const home = await temporaryHome();
    const conflictAgent = agentFixture("conflict-agent");
    const identicalAgent = agentFixture("same-agent");
    const conflictSwarm = restorableSwarm("conflict");
    const identicalSwarm = restorableSwarm("same");
    const conflictMovement = movementFixture("mv_conflict01", CREATED_AT, [
      { status: "planned", nonce: nonceFor(66) },
    ]);
    const identicalMovement = movementFixture("mv_identical1", CREATED_AT, [
      { status: "planned", nonce: nonceFor(67) },
    ]);
    const identicalReceipt = backupTransferReceiptFixture("same-receipt", nonceFor(67));
    const conflictReceipt = backupTransferReceiptFixture("conflict-receipt", nonceFor(67));
    const conflictingReceiptLine = JSON.stringify({
      ...conflictReceipt,
      resourceUrl: "https://different.example.test/transfer",
    });

    await mkdir(join(home, "agents"), { recursive: true, mode: 0o700 });
    await mkdir(join(home, "swarms"), { recursive: true, mode: 0o700 });
    await mkdir(join(home, "movements"), { recursive: true, mode: 0o700 });
    const conflictBytes = "different bytes\n";
    await writeFile(join(home, "agents", "conflict-agent.json"), conflictBytes);
    await writeFile(join(home, "swarms", "conflict.json"), conflictBytes);
    await writeFile(join(home, "movements", "mv_conflict01.json"), conflictBytes);
    const identicalAgentBytes = `${JSON.stringify(identicalAgent, null, 2)}\n`;
    const identicalSwarmBytes = `${JSON.stringify(
      { ...identicalSwarm, device: "new-device" },
      null,
      2,
    )}\n`;
    const restoredIdenticalMovement: Movement = {
      ...identicalMovement,
      legs: [{ ...identicalMovement.legs[0]!, status: "unknown", restored: true }],
    };
    const identicalMovementBytes = serializeMovement(restoredIdenticalMovement);
    await writeFile(join(home, "agents", "same-agent.json"), identicalAgentBytes);
    await writeFile(join(home, "swarms", "same.json"), identicalSwarmBytes);
    await writeFile(join(home, "movements", "mv_identical1.json"), identicalMovementBytes);
    const originalReceipts = `${JSON.stringify(identicalReceipt)}\n${conflictingReceiptLine}\n`;
    await writeFile(join(home, "receipts.jsonl"), originalReceipts);

    const restored = await restoreFromBackup({
      plaintext: restoreV2Plaintext({
        agents: [conflictAgent, identicalAgent],
        swarms: [conflictSwarm, identicalSwarm],
        movements: [conflictMovement, identicalMovement],
        transferReceipts: [identicalReceipt, conflictReceipt],
      }),
      home,
      vaultKey: KEY,
      device: "new-device",
    });

    expect(restored.conflicts).toEqual(
      expect.arrayContaining([
        {
          kind: "agent",
          name: "conflict-agent",
          path: join(home, "agents", "conflict-agent.json"),
        },
        {
          kind: "swarm",
          name: "conflict",
          path: join(home, "swarms", "conflict.json"),
        },
        {
          kind: "movement",
          name: "mv_conflict01",
          path: join(home, "movements", "mv_conflict01.json"),
        },
      ]),
    );
    expect(restored.conflicts).toHaveLength(3);
    expect(restored.agents).toEqual(["same-agent"]);
    expect(restored.swarms).toEqual(["same"]);
    expect(restored.movements.map((movement) => movement.id)).toEqual(["mv_identical1"]);
    expect(restored.skipped).toEqual([]);
    await expect(readFile(join(home, "agents", "conflict-agent.json"), "utf8")).resolves.toBe(
      conflictBytes,
    );
    await expect(readFile(join(home, "swarms", "conflict.json"), "utf8")).resolves.toBe(
      conflictBytes,
    );
    await expect(readFile(join(home, "movements", "mv_conflict01.json"), "utf8")).resolves.toBe(
      conflictBytes,
    );
    await expect(readFile(join(home, "agents", "same-agent.json"), "utf8")).resolves.toBe(
      identicalAgentBytes,
    );
    await expect(readFile(join(home, "swarms", "same.json"), "utf8")).resolves.toBe(
      identicalSwarmBytes,
    );
    await expect(readFile(join(home, "movements", "mv_identical1.json"), "utf8")).resolves.toBe(
      identicalMovementBytes,
    );
    await expect(readFile(join(home, "receipts.jsonl"), "utf8")).resolves.toBe(
      `${originalReceipts}${JSON.stringify(conflictReceipt)}\n`,
    );
  });
});

describe("backup v1 restore result compatibility", () => {
  it("returns exactly the original v1 result shape", async () => {
    const home = await temporaryHome();
    const plaintext = restoreV1Plaintext();
    const restored = await restoreFromBackup({ plaintext, home, vaultKey: KEY });

    expect(restored).toEqual({
      accounts: [
        {
          name: "main",
          kind: "derived",
          index: 0,
          address: privateKeyToAccount(HARDHAT_PRIVATE_KEY).address,
          createdAt: CREATED_AT,
        },
      ],
      default: "main",
      protected: false,
      networks: ["eip155:8453"],
    });
    expect(restored).not.toHaveProperty("agents");
    expect(restored).not.toHaveProperty("skipped");
    expect(restored).not.toHaveProperty("conflicts");
  });
});

function restoreV1Plaintext(): BackupPlaintextV1 {
  return {
    v: 1,
    phrase: TEST_PHRASE,
    nextDerivedIndex: 1,
    accounts: [
      {
        name: "main",
        kind: "derived",
        index: 0,
        address: privateKeyToAccount(HARDHAT_PRIVATE_KEY).address,
        createdAt: CREATED_AT,
      },
    ],
    registry: {
      default: "main",
      accounts: [
        {
          name: "main",
          label: "Primary",
          spendCaps: { perCallAtomic: "100000", perDayAtomic: "1000000" },
        },
      ],
      networks: ["eip155:8453"],
    },
    protected: false,
  };
}

function restoreV2Plaintext(
  overrides: Partial<
    Pick<BackupPlaintextV2, "agents" | "swarms" | "movements" | "transferReceipts">
  > = {},
): BackupPlaintextV2 {
  const base = restoreV1Plaintext();
  return {
    ...base,
    v: 2,
    registry: {
      ...base.registry,
      accounts: base.registry.accounts.map((account) => ({
        ...account,
        ceilingAtomic: "5000000",
        routerRefill: { belowUsd: 2.5, tierUsd: 5 },
      })),
    },
    agents: overrides.agents ?? [],
    swarms: overrides.swarms ?? [],
    movements: overrides.movements ?? [],
    transferReceipts: overrides.transferReceipts ?? [],
  };
}

function restorableSwarm(name: string): SwarmFile {
  return {
    v: 1,
    name,
    device: "old-device",
    network: "eip155:8453",
    createdAt: CREATED_AT,
    treasury: {
      account: "main",
      address: privateKeyToAccount(HARDHAT_PRIVATE_KEY).address,
      steps: { creating: false, created: true, capped: true, linked: true },
    },
    members: [],
    policy: {
      strategy: "targets",
      treasuryCaps: { perCallAtomic: "5000000", perDayAtomic: "20000000" },
    },
  };
}

function backupTransferReceiptFixture(id: string, nonce: `0x${string}`): BackupTransferReceipt {
  const receipt = transferReceiptFixture(id, nonce, "unknown");
  return {
    id: receipt.id,
    timestamp: receipt.timestamp,
    kind: "transfer",
    wallet: "main",
    resourceUrl: receipt.resourceUrl,
    quote: {
      network: receipt.quote!.network,
      asset: receipt.quote!.asset!,
      amountAtomic: receipt.quote!.amountAtomic,
    },
    transfer: receipt.transfer!,
  };
}

function agentFixture(name: string): backup.BackupAgentProfile {
  return {
    version: 1,
    name,
    wallet: "main",
    model: "openai/gpt-5-mini",
    instructions: `Instructions for ${name}.`,
    verifiedOnly: true,
    approveAboveUsd: 0.5,
    maxSteps: 12,
    paused: false,
    createdAt: CREATED_AT,
    tools: ["call.search", "call.inspect", "call.pay"],
  };
}

function swarmFixture(name: string): SwarmFile {
  return {
    v: 1,
    name,
    device: "device-one",
    network: "eip155:8453",
    createdAt: CREATED_AT,
    treasury: {
      account: `${name}-treasury`,
      steps: { creating: false, created: false, capped: false, linked: false },
    },
    members: [
      {
        account: `${name}-member`,
        role: "lead",
        weight: 1,
        targetAtomic: "1000000",
        ceilingAtomic: "5000000",
        steps: {
          creating: false,
          created: false,
          capped: false,
          linked: false,
          profiled: false,
        },
      },
    ],
    policy: {
      strategy: "targets",
      treasuryCaps: { perCallAtomic: "5000000", perDayAtomic: "20000000" },
    },
  };
}

function movementFixture(
  id: string,
  createdAt: string,
  legs: readonly { status: Movement["legs"][number]["status"]; nonce: `0x${string}` }[],
): Movement {
  return {
    v: 2,
    id,
    reason: "send",
    from: "main",
    network: "eip155:8453",
    createdAt,
    legs: legs.map((leg, index) => ({
      from: "main",
      to: "0x2222222222222222222222222222222222222222",
      amountUsd: "1.00",
      purpose: "send",
      nonce: leg.nonce,
      status: leg.status,
      ...(leg.status === "sent" ? { txHash: `0x${(index + 1).toString(16)}` } : {}),
    })),
  };
}

function transferReceiptFixture(
  id: string,
  nonce: `0x${string}`,
  status: "sent" | "unknown" | "failed",
): Receipt {
  return {
    id,
    timestamp: CREATED_AT,
    kind: "transfer",
    wallet: "main",
    resourceUrl: "https://router.example.test/transfer",
    method: "POST",
    quote: {
      network: "eip155:8453",
      asset: "0x3333333333333333333333333333333333333333",
      amountAtomic: "1000000",
      payTo: "0x2222222222222222222222222222222222222222",
    },
    payer: OWNER,
    transfer: {
      to: "0x2222222222222222222222222222222222222222",
      toName: "owner",
      toKind: "owner",
      amountAtomic: "1000000",
      network: "eip155:8453",
      nonce,
      status,
      txHash: status === "sent" ? "0x1234" : null,
      replayed: false,
      ...(status === "unknown"
        ? {
            reservedOn: "2026-09-29",
            request: {
              authorization: {
                from: OWNER,
                to: "0x2222222222222222222222222222222222222222",
                value: "1000000",
                validAfter: "0",
                validBefore: "1790676672",
                nonce,
              },
              signature: `0x${"ab".repeat(65)}`,
            },
          }
        : {}),
    },
    settlement: { outcome: status === "sent" ? "succeeded" : "unknown" },
  };
}

function transferResultFixture(args: TransferArgs, status: "sent" | "unknown"): TransferResult {
  return {
    status,
    from: args.from,
    to: OWNER,
    toName: args.to,
    toKind: "owner",
    amountUsd: String(args.amountUsd),
    amountAtomic: "1000000",
    network: "eip155:8453",
    txHash: status === "sent" ? "0x1234" : null,
    nonce: args.resume ?? args.nonce!,
    replayed: args.resume !== undefined,
  };
}

function nonceFor(byte: number): `0x${string}` {
  return `0x${byte.toString(16).padStart(2, "0").repeat(32)}`;
}

async function writeMovementFixture(home: string, movement: Movement): Promise<void> {
  const directory = join(home, "movements");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `${movement.id}.json`), `${JSON.stringify(movement, null, 2)}\n`);
}

function v2SourceFixture(
  overrides: Partial<
    Pick<BackupSourceV2, "agents" | "swarms" | "movements" | "transferReceipts">
  > = {},
): BackupSourceV2 {
  const registry = SOURCE.registry as backup.BackupRegistryV1;
  return {
    phrase: SOURCE.phrase,
    nextDerivedIndex: SOURCE.nextDerivedIndex,
    accounts: SOURCE.accounts,
    registry: {
      ...registry,
      accounts: registry.accounts.map((account, index) => ({
        ...account,
        ceilingAtomic: index === 0 ? "5000000" : null,
      })),
    },
    protected: SOURCE.protected,
    agents: overrides.agents ?? [],
    swarms: overrides.swarms ?? [],
    movements: overrides.movements ?? [],
    transferReceipts: overrides.transferReceipts ?? [],
  };
}

function v2VaultOnlySource(): BackupSourceV2 {
  const registry = SOURCE.registry as backup.BackupRegistryV1;
  return {
    phrase: SOURCE.phrase,
    nextDerivedIndex: SOURCE.nextDerivedIndex,
    accounts: SOURCE.accounts,
    registry: {
      ...registry,
      accounts: registry.accounts.map((account) => ({
        ...account,
        ceilingAtomic: "5000000",
      })),
    },
    protected: SOURCE.protected,
    agents: [],
    swarms: [],
    movements: [],
    transferReceipts: [],
  };
}

async function fixedBackup(): Promise<{ envelope: string; bytes: number }> {
  return createBackup({
    vault: SOURCE,
    ownerKey: { kdf: "hkdf-sha256", key: KEY, salt: SALT },
    owner: OWNER,
    device: "test-device",
    now: () => new Date(CREATED_AT),
    randomBytes: () => NONCE,
  });
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      await readFile(path);
      return;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`Timed out waiting for ${path}.`);
}

async function expectBackupError(
  promise: Promise<unknown>,
  expected: { code: string; message?: string },
): Promise<void> {
  await expect(promise).rejects.toBeInstanceOf(BackupError);
  await expect(promise).rejects.toMatchObject(expected);
}

function flipBase64Byte(value: string): string {
  const bytes = Buffer.from(value, "base64url");
  bytes[0] = bytes[0]! ^ 1;
  return bytes.toString("base64url");
}

function fromHex(value: string): Buffer {
  return Buffer.from(value.slice(2), "hex");
}

function toHex(value: Uint8Array): `0x${string}` {
  return `0x${Buffer.from(value).toString("hex")}`;
}

function toBase64Url(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

function asViemTypedData(typedData: ReturnType<typeof VAULT_BACKUP_TYPED_DATA>) {
  return {
    ...typedData,
    message: { ...typedData.message, version: 1n },
  };
}

function directNormalizeSignature(signature: string): Buffer {
  const bytes = Buffer.from(signature.slice(2), "hex");
  let recovery = bytes[64]! < 27 ? bytes[64]! + 27 : bytes[64]!;
  const order = BigInt("0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141");
  const halfOrder = order / 2n;
  const s = BigInt(`0x${bytes.subarray(32, 64).toString("hex")}`);
  if (s > halfOrder) {
    bytes.set(Buffer.from((order - s).toString(16).padStart(64, "0"), "hex"), 32);
    recovery = recovery === 27 ? 28 : 27;
  }
  bytes[64] = recovery;
  return bytes;
}

function directEnvelope(options: {
  vector: EnvelopeVector;
  key: Uint8Array;
  nonce: Uint8Array;
  kdf:
    { name: "hkdf-sha256"; salt: string } | { name: "scrypt"; salt: string; N: 131072; r: 8; p: 1 };
}): string {
  const cipher = createCipheriv("aes-256-gcm", options.key, options.nonce, {
    authTagLength: 16,
  });
  cipher.setAAD(Buffer.from(options.vector.aad));
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(options.vector.plaintext)),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  return JSON.stringify({
    format: "vapi-vault-backup",
    v: 1,
    owner: options.vector.owner,
    device: options.vector.device,
    createdAt: options.vector.createdAt,
    kdf: options.kdf,
    cipher: { name: "aes-256-gcm", nonce: toBase64Url(options.nonce) },
    ciphertext: toBase64Url(ciphertext),
  });
}

function directOpen(envelope: string, key: Uint8Array): string {
  const value = JSON.parse(envelope) as EnvelopeValue;
  const encrypted = Buffer.from(value.ciphertext, "base64url");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(value.cipher.nonce, "base64url"),
    { authTagLength: 16 },
  );
  const parameters =
    value.kdf.name === "scrypt"
      ? [String(value.kdf.N), String(value.kdf.r), String(value.kdf.p)]
      : ["", "", ""];
  decipher.setAAD(
    Buffer.from(
      [
        value.format,
        String(value.v),
        value.owner,
        value.device,
        value.createdAt,
        value.kdf.name,
        value.kdf.salt,
        ...parameters,
        value.cipher.nonce,
      ].join("|"),
    ),
  );
  decipher.setAuthTag(encrypted.subarray(-16));
  return Buffer.concat([decipher.update(encrypted.subarray(0, -16)), decipher.final()]).toString(
    "utf8",
  );
}

function directX25519Public(privateKey: Uint8Array): Buffer {
  const privateDer = Buffer.concat([
    Buffer.from("302e020100300506032b656e04220420", "hex"),
    privateKey,
  ]);
  const publicDer = Buffer.from(
    createPublicKey(createPrivateKey({ key: privateDer, format: "der", type: "pkcs8" })).export({
      format: "der",
      type: "spki",
    }),
  );
  expect(publicDer.subarray(0, 12).toString("hex")).toBe("302a300506032b656e032100");
  return Buffer.from(publicDer.subarray(12));
}

function directX25519Shared(privateKey: Uint8Array, publicKey: Uint8Array): Buffer {
  return diffieHellman({
    privateKey: createPrivateKey({
      key: Buffer.concat([Buffer.from("302e020100300506032b656e04220420", "hex"), privateKey]),
      format: "der",
      type: "pkcs8",
    }),
    publicKey: createPublicKey({
      key: Buffer.concat([Buffer.from("302a300506032b656e032100", "hex"), publicKey]),
      format: "der",
      type: "spki",
    }),
  });
}

function directRelayCode(publicKey: Uint8Array): string {
  const digest = createHash("sha256").update(publicKey).digest();
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let bits = BigInt(`0x${digest.subarray(0, 8).toString("hex")}`) >> 4n;
  const output = Array.from({ length: 12 }, () => "0");
  for (let index = output.length - 1; index >= 0; index -= 1) {
    output[index] = alphabet[Number(bits & 31n)]!;
    bits >>= 5n;
  }
  const value = output.join("");
  return `${value.slice(0, 4)}-${value.slice(4, 8)}-${value.slice(8)}`;
}

function directSealed(options: {
  recipientPublicKey: Uint8Array;
  ephemeralPrivateKey: Uint8Array;
  nonce: Uint8Array;
  plaintext: string;
}): string {
  const ephemeralPublicKey = directX25519Public(options.ephemeralPrivateKey);
  const shared = directX25519Shared(options.ephemeralPrivateKey, options.recipientPublicKey);
  const key = Buffer.from(
    hkdfSync(
      "sha256",
      shared,
      Buffer.concat([ephemeralPublicKey, options.recipientPublicKey]),
      Buffer.from("vapi-vault-relay/v1"),
      32,
    ),
  );
  const epk = toBase64Url(ephemeralPublicKey);
  const nonce = toBase64Url(options.nonce);
  const cipher = createCipheriv("aes-256-gcm", key, options.nonce, { authTagLength: 16 });
  cipher.setAAD(Buffer.from(`vapi-vault-relay|1|${epk}|${nonce}`));
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(options.plaintext)),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  return JSON.stringify({
    format: "vapi-vault-relay",
    v: 1,
    epk,
    nonce,
    ciphertext: toBase64Url(ciphertext),
  });
}

async function expectImplementationEnvelope(
  vector: EnvelopeVector,
  key: Uint8Array,
  salt: Uint8Array,
): Promise<void> {
  const plaintext = JSON.parse(vector.plaintext) as BackupPlaintext;
  const source: BackupSource = {
    phrase: plaintext.phrase,
    nextDerivedIndex: plaintext.nextDerivedIndex,
    accounts: plaintext.accounts,
    registry: plaintext.registry,
    protected: plaintext.protected,
  };
  const created = await createBackup({
    vault: source,
    ownerKey: {
      kdf: "password" in vector ? "scrypt" : "hkdf-sha256",
      key,
      salt,
    },
    owner: vector.owner,
    device: vector.device,
    now: () => new Date(vector.createdAt),
    randomBytes: () => fromHex(vector.nonce),
  });
  expect(created.envelope).toBe(vector.envelope);
  expect(await openBackup({ envelope: created.envelope, key })).toEqual(
    JSON.parse(vector.plaintext),
  );
}

function sourceWithLabel(label: string): BackupSource {
  return {
    phrase: "word",
    nextDerivedIndex: 1,
    accounts: [
      {
        name: "main",
        kind: "derived",
        index: 0,
        address: "0x0000000000000000000000000000000000000001",
        createdAt: CREATED_AT,
      },
    ],
    registry: {
      accounts: [
        {
          name: "main",
          label,
          spendCaps: { perCallAtomic: "1", perDayAtomic: "2" },
        },
      ],
      networks: [],
    },
    protected: false,
  };
}

function findBoundaryLabel(
  fixedBytes: number,
  baseCiphertextBytes: number,
): { deviceLength: number; labelLength: number } {
  for (let deviceLength = 1; deviceLength < 32; deviceLength += 1) {
    for (let labelLength = 48_000; labelLength < 50_000; labelLength += 1) {
      const ciphertextLength = base64UrlLength(baseCiphertextBytes + labelLength);
      if (fixedBytes + deviceLength - 1 + ciphertextLength === 65_536) {
        return { deviceLength, labelLength };
      }
    }
  }
  throw new Error("Unable to construct the size-boundary fixture.");
}

function base64UrlLength(bytes: number): number {
  return Math.floor((bytes * 4 + 2) / 3);
}

function memoryStore(): SecretStore & { entries: Map<string, string> } {
  const entries = new Map<string, string>();
  return {
    entries,
    available: true,
    platform: "darwin",
    description: "a test store",
    async get(name) {
      return entries.get(name);
    },
    async has(name) {
      return entries.has(name);
    },
    async set(name, value) {
      entries.set(name, value);
    },
    async remove(name) {
      return entries.delete(name);
    },
  };
}

async function temporaryHome(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "vapi-backup-"));
  TEMPORARY_DIRECTORIES.push(directory);
  return directory;
}

type EnvelopeKdf =
  | { name: "hkdf-sha256"; salt: string }
  | { name: "scrypt"; salt: string; N: number; r: number; p: number };

type EnvelopeValue = {
  format: string;
  v: number;
  owner: string;
  device: string;
  createdAt: string;
  kdf: EnvelopeKdf;
  cipher: { name: string; nonce: string };
  ciphertext: string;
};

type EnvelopeVector = {
  owner: string;
  device: string;
  createdAt: string;
  salt: string;
  nonce: string;
  plaintext: string;
  aad: string;
  derivedKey: string;
  envelope: string;
};

type RelayValue = {
  format: string;
  v: number;
  epk: string;
  nonce: string;
  ciphertext: string;
};

type SealedBoxVector = {
  recipientPrivateKey: string;
  recipientPublicKey: string;
  ephemeralPrivateKey: string;
  ephemeralPublicKey: string;
  nonce: string;
  plaintext: string;
  aad: string;
  derivedKey: string;
  sealed: string;
  relayCode: string;
};

type BackupVectors = {
  hkdfEnvelope: EnvelopeVector & { privateKey: string; signature: string };
  hkdfEnvelopeV2: EnvelopeVector & { privateKey: string; signature: string };
  scryptEnvelope: EnvelopeVector & { password: string };
  sealedBox: SealedBoxVector;
  signatureNormalization: {
    v0: { input: string; normalized: string };
    highS: { input: string; normalized: string };
  };
};
