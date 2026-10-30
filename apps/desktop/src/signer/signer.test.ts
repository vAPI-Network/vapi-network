import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { verifyMessage, verifyTypedData } from "viem";
import { createSiweMessage } from "viem/siwe";
import {
  EIP3009_AUTHORIZATION_TYPES,
  generateRecoveryPhrase,
  memorySecretStore,
  protectVault,
  readVaultFileUnlocked,
  WalletStore,
  type AccountLinkOutcome,
} from "@vapi-network/core";

import { signerRequestSchema } from "./messages.js";
import { createSigner, type PasswordStore, type SignerDeps } from "./signer.js";

function memoryPassword(): PasswordStore & { value?: string } {
  const store: PasswordStore & { value?: string } = {
    value: undefined,
    async get() {
      return store.value;
    },
    async set(value) {
      store.value = value;
    },
    async delete() {
      store.value = undefined;
    },
  };
  return store;
}

const API_BASE = "https://api.vapinetwork.ai";
const OWNER = "0x8617E340B3D01FA5F11F306F4090FD50E238070D" as const;

function signInMessage(address: `0x${string}`) {
  return createSiweMessage({
    domain: new URL(API_BASE).host,
    uri: API_BASE,
    address,
    version: "1",
    chainId: 8453,
    nonce: "abc12345",
    issuedAt: new Date("2026-10-28T10:00:00.000Z"),
  });
}

/** Every test signer uses memory secrets; none may reach the real Keychain. */
function signerFor(home: string, overrides: Partial<SignerDeps> = {}) {
  return createSigner({
    home,
    ledgerPath: join(home, "ledger.json"),
    password: memoryPassword(),
    secrets: memorySecretStore(),
    apiBase: API_BASE,
    hostname: "test-mac",
    ...overrides,
    backupCore: {
      readCloudBackupState: async () => ({ enabled: false }),
      uploadBackup: async () => ({ status: "skipped", reason: "no_backup_key" }),
      ...overrides.backupCore,
    },
  });
}

const usdcBase = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;

function authorization(from: `0x${string}`, value: bigint) {
  return {
    domain: { name: "USD Coin", version: "2", chainId: 8453, verifyingContract: usdcBase },
    types: EIP3009_AUTHORIZATION_TYPES,
    primaryType: "TransferWithAuthorization" as const,
    message: {
      from,
      to: "0x0000000000000000000000000000000000000002" as const,
      value,
      validAfter: 0n,
      validBefore: 1_900_000_000n,
      nonce: `0x${"22".repeat(32)}` as const,
    },
  };
}

describe("createSigner", () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "signer-"));
  });
  afterEach(async () => {
    vi.useRealTimers();
    await rm(home, { recursive: true, force: true });
  });

  it("distinguishes missing setup from corrupt or unreadable setup", async () => {
    const signer = signerFor(home);
    expect(await signer.handle({ type: "status" })).toMatchObject({ ok: true, vault: "none" });
    await writeFile(join(home, "vault.json"), "not json");
    expect(await signer.handle({ type: "status" })).toMatchObject({ ok: false, code: "error" });
    await rm(join(home, "vault.json"));
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(home, "vault.json"));
    expect(await signer.handle({ type: "status" })).toMatchObject({ ok: false, code: "error" });
  });

  it("identifies a wrong unlock password without hiding secret-store failures", async () => {
    const secrets = memorySecretStore();
    const signer = signerFor(home, { secrets });
    await signer.handle({ type: "createVault", password: "correct horse" });
    await signer.handle({ type: "lock" });
    expect(await signer.handle({ type: "unlock", password: "wrong password" })).toEqual({
      ok: false,
      code: "password_required",
      message: "That password is not right.",
    });
    const set = vi.spyOn(secrets, "set").mockRejectedValue(new Error("Secret store unavailable."));
    expect(await signer.handle({ type: "unlock", password: "correct horse" })).toMatchObject({
      ok: false,
      code: "error",
      message: "Unable to unlock the protected vault.",
    });
    set.mockRestore();
  });

  it.each(["a".repeat(33), "-wallet", "Wallet", "two words", "../wallet"])(
    "rejects invalid wallet names at the signer boundary: %s",
    async (name) => {
      expect(await signerFor(home).handle({ type: "createWallet", name })).toMatchObject({
        ok: false,
        code: "bad_request",
      });
    },
  );

  it("preserves password-store errors during unlock", async () => {
    const password = memoryPassword();
    const signer = signerFor(home, { password });
    await signer.handle({ type: "createVault", password: "correct horse" });
    await signer.handle({ type: "lock" });
    vi.spyOn(password, "set").mockRejectedValue(new Error("Password store unavailable."));
    expect(await signer.handle({ type: "unlock", password: "correct horse" })).toEqual({
      ok: false,
      code: "error",
      message: "Password store unavailable.",
    });
  });

  describe("request origin", () => {
    it("refuses everything but status, listWallets and sign from the MCP port", async () => {
      const signer = signerFor(home);
      await signer.handle({ type: "createVault", password: "correct horse" });
      const refused = await signer.handle({ type: "lock" }, "mcp");
      expect(refused).toMatchObject({ ok: false, code: "not_permitted" });
      expect(await signer.handle({ type: "status" }, "mcp")).toMatchObject({ ok: true });
      expect(await signer.handle({ type: "listWallets" }, "mcp")).toMatchObject({ ok: true });
      expect(await signer.handle({ type: "lock" }, "ui")).toMatchObject({
        ok: true,
        type: "lock",
      });
    });
  });

  describe("encrypted backup", () => {
    it("reports recovery status before and after confirming the Emergency Kit", async () => {
      const signer = signerFor(home);
      const before = {
        ok: true,
        type: "recoveryStatus",
        recovery: { kit: false, backup: { enabled: false, failed: false } },
      };
      expect(await signer.handle({ type: "recoveryStatus" })).toEqual(before);
      await signer.handle({ type: "createVault", password: "correct horse" });
      expect(await signer.handle({ type: "recoveryStatus" })).toEqual(before);
      await signer.handle({ type: "revealPhrase", password: "correct horse" });
      await signer.handle({ type: "confirmKit" });
      expect(await signer.handle({ type: "recoveryStatus" })).toEqual({
        ...before,
        recovery: { kit: true, backup: { enabled: false, failed: false } },
      });
    });

    it("requires an unlocked setup and a linked owner to enroll", async () => {
      const startRelay = vi.fn();
      const signer = signerFor(home, { backupCore: { startRelay } });
      expect(await signer.handle({ type: "backupStart", purpose: "enroll" })).toMatchObject({
        ok: false,
        code: "locked",
      });
      await signer.handle({ type: "createVault", password: "correct horse" });
      expect(await signer.handle({ type: "backupStart", purpose: "enroll" })).toMatchObject({
        ok: true,
        type: "backupStart",
        result: { mode: "error" },
      });
      expect(startRelay).not.toHaveBeenCalled();
    });

    it("keeps all backup messages off the MCP port", async () => {
      const signer = signerFor(home);
      for (const request of [
        { type: "recoveryStatus" },
        { type: "backupStart", purpose: "restore" },
        { type: "backupPoll" },
        { type: "restoreBackup", password: "correct horse" },
      ] as const) {
        expect(await signer.handle(request, "mcp")).toMatchObject({
          ok: false,
          code: "not_permitted",
        });
      }
    });

    it("restores with the backup's limits and the new password, then stays unlocked", async () => {
      const secrets = memorySecretStore();
      const password = memoryPassword();
      const caps = { perCallAtomic: "2300000", perDayAtomic: "9700000" };
      const signer = signerFor(home, {
        secrets,
        password,
        backupCore: {
          startRelay: async () => ({
            code: "123456",
            expiresAt: "2099-01-01T00:00:00.000Z",
            keyPair: { publicKey: new Uint8Array(32), privateKey: new Uint8Array(32) },
          }),
          awaitRelay: async () => ({
            format: "vapi-vault-relay-payload",
            v: 1,
            purpose: "restore",
            owner: OWNER,
            device: "vapi-desktop-test-mac",
            kdf: { name: "hkdf-sha256", salt: "s".repeat(43) },
            key: new Uint8Array(32),
          }),
          restoreFromOwner: async (args) => {
            const store = await WalletStore.open(args.home, { secrets: args.secrets });
            await store.create("claude", "", { spendCaps: caps });
            await protectVault({
              path: join(args.home, "vault.json"),
              secrets: args.secrets,
              password: args.password,
            });
            return {
              accounts: (await readVaultFileUnlocked(join(args.home, "vault.json"))).accounts,
              protected: true,
              networks: [],
            };
          },
        },
      });
      expect(
        await signer.handle({ type: "restoreBackup", password: "new password" }),
      ).toMatchObject({
        ok: false,
      });
      expect(await signer.handle({ type: "backupStart", purpose: "restore" })).toMatchObject({
        ok: true,
        result: { mode: "browser" },
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(await signer.handle({ type: "backupPoll" })).toMatchObject({
        ok: true,
        result: { state: "approved", owner: OWNER },
      });
      expect(await signer.handle({ type: "restoreBackup", password: "new password" })).toEqual({
        ok: true,
        type: "restoreBackup",
        wallets: ["claude"],
      });
      expect(password.value).toBe("new password");
      expect(await signer.handle({ type: "status" })).toMatchObject({ vault: "unlocked" });
      expect(await signer.handle({ type: "listWallets" })).toMatchObject({
        wallets: [{ name: "claude", caps }],
      });
      expect(await signer.handle({ type: "backupPoll" })).toMatchObject({
        result: { state: "none" },
      });
      await signer.handle({ type: "lock" });
      expect(await signer.handle({ type: "unlock", password: "wrong password" })).toMatchObject({
        ok: false,
      });
      expect(await signer.handle({ type: "unlock", password: "new password" })).toMatchObject({
        ok: true,
      });
    });

    it("refuses to overwrite an existing setup", async () => {
      const signer = signerFor(home);
      await signer.handle({ type: "createVault", password: "correct horse" });
      expect(await signer.handle({ type: "backupStart", purpose: "restore" })).toMatchObject({
        ok: false,
        message: "vAPI Desktop is already set up on this Mac.",
      });
      expect(
        await signer.handle({ type: "restoreBackup", password: "new password" }),
      ).toMatchObject({
        ok: false,
        message: "vAPI Desktop is already set up on this Mac.",
      });
    });

    it("backs up after a link that the console approves silently", async () => {
      const uploadBackup = vi.fn(
        async () => ({ status: "skipped", reason: "no_backup_key" }) as const,
      );
      const { signer } = await readySigner({
        backupCore: { readCloudBackupState: async () => ({ enabled: true }), uploadBackup },
        linkCore: {
          startAccountLink: async () => ({ linked: true, autoApproved: true }),
        },
      });
      await signer.handle({ type: "lock" });
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      await signer.handle({ type: "unlock", password: "correct horse battery" });
      await vi.advanceTimersByTimeAsync(3_000);
      uploadBackup.mockClear();
      await signer.handle({ type: "linkStart", wallet: "claude" });
      await vi.advanceTimersByTimeAsync(3_000);
      expect(uploadBackup).toHaveBeenCalledTimes(1);
      await signer.handle({ type: "lock" });
    });
  });

  describe("restorePhrase", () => {
    it("restores the Kit on a new Mac with default limits and no links, and stays unlocked", async () => {
      const original = signerFor(home);
      await original.handle({ type: "createVault", password: "original password" });
      const created = await original.handle({
        type: "createWallet",
        name: "claude",
        caps: { perCallAtomic: "2000000", perDayAtomic: "10000000" },
      });
      if (!created.ok || created.type !== "createWallet") throw new Error("create failed");
      const kit = await original.handle({ type: "revealPhrase", password: "original password" });
      if (!kit.ok || kit.type !== "revealPhrase") throw new Error("reveal failed");

      const restoredHome = await mkdtemp(join(tmpdir(), "signer-restore-"));
      try {
        const password = memoryPassword();
        const restored = signerFor(restoredHome, {
          password,
          readBalance: async (address) => (address === created.wallet.address ? 1n : 0n),
        });
        expect(
          await restored.handle({
            type: "restorePhrase",
            phrase: kit.words.join(" "),
            password: "new password",
          }),
        ).toEqual({ ok: true, type: "restorePhrase", wallets: ["account-1"] });
        expect(password.value).toBe("new password");
        expect(await restored.handle({ type: "status" })).toMatchObject({ vault: "unlocked" });
        const listed = await restored.handle({ type: "listWallets", includeLinks: true });
        expect(listed).toMatchObject({ ok: true, type: "listWallets" });
        if (!listed.ok || listed.type !== "listWallets") throw new Error("list failed");
        expect(listed.wallets).toHaveLength(1);
        expect(listed.wallets[0]).toMatchObject({
          name: "account-1",
          address: created.wallet.address,
          caps: { perCallAtomic: "1000000", perDayAtomic: "5000000" },
          link: "not_linked",
        });
        await restored.handle({ type: "lock" });
        expect(await restored.handle({ type: "unlock" })).toEqual({ ok: true, type: "unlock" });
      } finally {
        await rm(restoredHome, { recursive: true, force: true });
      }
    });

    it("refuses restore from the MCP port", async () => {
      const signer = signerFor(home, { readBalance: async () => 0n });
      expect(
        await signer.handle(
          { type: "restorePhrase", phrase: generateRecoveryPhrase(), password: "new password" },
          "mcp",
        ),
      ).toMatchObject({ ok: false, code: "not_permitted" });
      expect(await signer.handle({ type: "status" })).toMatchObject({ vault: "none" });
    });

    it("requires a phrase of at most 1000 characters and a password of at least 8", () => {
      const request = {
        type: "restorePhrase",
        phrase: "a".repeat(1000),
        password: "12345678",
      };
      expect(signerRequestSchema.safeParse(request).success).toBe(true);
      for (const invalid of [
        { ...request, phrase: "" },
        { ...request, phrase: "a".repeat(1001) },
        { ...request, password: "1234567" },
      ]) {
        expect(signerRequestSchema.safeParse(invalid).success).toBe(false);
      }
    });

    it("refuses to replace an existing setup", async () => {
      const signer = signerFor(home, { readBalance: async () => 0n });
      await signer.handle({ type: "createVault", password: "original password" });
      const before = await readFile(join(home, "vault.json"), "utf8");
      expect(
        await signer.handle({
          type: "restorePhrase",
          phrase: generateRecoveryPhrase(),
          password: "new password",
        }),
      ).toMatchObject({
        ok: false,
        code: "error",
        message: "vAPI Desktop is already set up on this Mac.",
      });
      expect(await readFile(join(home, "vault.json"), "utf8")).toBe(before);
    });

    it("refuses restore when the balance reader is unavailable", async () => {
      const signer = signerFor(home);
      expect(
        await signer.handle({
          type: "restorePhrase",
          phrase: generateRecoveryPhrase(),
          password: "new password",
        }),
      ).toEqual({ ok: false, code: "error", message: "Balance check is not available." });
      expect(await signer.handle({ type: "status" })).toMatchObject({ vault: "none" });
    });
  });

  it("reveals and confirms the Emergency Kit only while unlocked and never to the MCP port", async () => {
    const signer = signerFor(home);
    await signer.handle({ type: "createVault", password: "correct horse" });
    expect(await signer.handle({ type: "confirmKit" })).toMatchObject({
      ok: false,
      code: "not_permitted",
    });
    expect(
      await signer.handle({ type: "revealPhrase", password: "correct horse" }, "mcp"),
    ).toMatchObject({ ok: false, code: "not_permitted" });
    expect(await signer.handle({ type: "confirmKit" }, "mcp")).toMatchObject({
      ok: false,
      code: "not_permitted",
    });
    expect(
      await signer.handle({ type: "revealPhrase", password: "not the password" }),
    ).toMatchObject({ ok: false, code: "password_required" });
    const shown = await signer.handle({ type: "revealPhrase", password: "correct horse" });
    expect(shown).toMatchObject({ ok: true, type: "revealPhrase" });
    if (shown.ok && shown.type === "revealPhrase") expect(shown.words).toHaveLength(12);
    expect(await signer.handle({ type: "confirmKit" })).toEqual({ ok: true, type: "confirmKit" });
    await signer.handle({ type: "lock" });
    expect(await signer.handle({ type: "confirmKit" })).toMatchObject({
      ok: false,
      code: "locked",
    });
    expect(await signer.handle({ type: "revealPhrase", password: "correct horse" })).toMatchObject({
      ok: false,
      code: "locked",
    });
  });

  it("creates a protected vault, a wallet, and signs within caps", async () => {
    const password = memoryPassword();
    const signer = signerFor(home, { password });

    expect(await signer.handle({ type: "status" })).toMatchObject({ vault: "none" });
    expect(await signer.handle({ type: "createVault", password: "correct horse battery" })).toEqual(
      {
        ok: true,
        type: "createVault",
      },
    );
    expect(password.value).toBe("correct horse battery");
    expect(await signer.handle({ type: "status" })).toMatchObject({ vault: "unlocked" });

    const created = await signer.handle({ type: "createWallet", name: "claude" });
    if (!created.ok || created.type !== "createWallet") throw new Error("create failed");
    expect(created.wallet.caps).toEqual({ perCallAtomic: "1000000", perDayAtomic: "5000000" });

    const typedData = authorization(created.wallet.address, 500_000n);
    const signed = await signer.handle({
      type: "sign",
      wallet: "claude",
      request: { kind: "typedData", typedData },
    });
    if (!signed.ok || signed.type !== "sign") throw new Error("sign failed");
    expect(
      await verifyTypedData({
        ...typedData,
        address: created.wallet.address,
        signature: signed.signature,
      }),
    ).toBe(true);
  });

  it("refuses a payment over the per-call cap and over the daily cap", async () => {
    const signer = signerFor(home);
    await signer.handle({ type: "createVault", password: "correct horse battery" });
    const created = await signer.handle({
      type: "createWallet",
      name: "claude",
      caps: { perCallAtomic: "1000000", perDayAtomic: "1500000" },
    });
    if (!created.ok || created.type !== "createWallet") throw new Error("create failed");
    const address = created.wallet.address;

    const tooBig = await signer.handle({
      type: "sign",
      wallet: "claude",
      request: { kind: "typedData", typedData: authorization(address, 1_000_001n) },
    });
    expect(tooBig).toMatchObject({ ok: false, code: "cap_exceeded" });

    const first = await signer.handle({
      type: "sign",
      wallet: "claude",
      request: { kind: "typedData", typedData: authorization(address, 1_000_000n) },
    });
    expect(first.ok).toBe(true);
    const second = await signer.handle({
      type: "sign",
      wallet: "claude",
      request: { kind: "typedData", typedData: authorization(address, 1_000_000n) },
    });
    expect(second).toMatchObject({ ok: false, code: "cap_exceeded" });
  });

  it("refuses typed data that is not a USDC transfer from the wallet", async () => {
    const signer = signerFor(home);
    await signer.handle({ type: "createVault", password: "correct horse battery" });
    await signer.handle({ type: "createWallet", name: "claude" });
    const other = authorization("0x0000000000000000000000000000000000000009", 1n);
    const result = await signer.handle({
      type: "sign",
      wallet: "claude",
      request: { kind: "typedData", typedData: other },
    });
    expect(result).toMatchObject({ ok: false, code: "not_permitted" });
  });

  it("locks, then unlocks from the password store and keeps signing", async () => {
    const password = memoryPassword();
    const signer = signerFor(home, { password });
    await signer.handle({ type: "createVault", password: "correct horse battery" });
    const created = await signer.handle({ type: "createWallet", name: "claude" });
    if (!created.ok || created.type !== "createWallet") throw new Error("create failed");
    const message = signInMessage(created.wallet.address);
    expect(await signer.handle({ type: "lock" })).toEqual({ ok: true, type: "lock" });
    expect(await signer.handle({ type: "status" })).toMatchObject({ vault: "locked" });
    expect(await signer.handle({ type: "listWallets" })).toMatchObject({ ok: true });
    const refused = await signer.handle({
      type: "sign",
      wallet: "claude",
      request: { kind: "message", message },
    });
    expect(refused).toMatchObject({ ok: false, code: "locked" });
    expect(await signer.handle({ type: "unlock" })).toEqual({ ok: true, type: "unlock" });
    const signed = await signer.handle({
      type: "sign",
      wallet: "claude",
      request: { kind: "message", message },
    });
    expect(signed.ok).toBe(true);
  });

  async function readySigner(overrides: Partial<SignerDeps> = {}) {
    const signer = signerFor(home, overrides);
    await signer.handle({ type: "createVault", password: "correct horse battery" });
    const created = await signer.handle({ type: "createWallet", name: "claude" });
    if (!created.ok || created.type !== "createWallet") throw new Error("create failed");
    return { signer, address: created.wallet.address };
  }

  it("refuses plain message signing", async () => {
    const { signer } = await readySigner();
    expect(
      await signer.handle({
        type: "sign",
        wallet: "claude",
        request: { kind: "message", message: "hello" },
      }),
    ).toMatchObject({ ok: false, code: "not_permitted" });
  });

  it("signs a vAPI sign-in message for the wallet", async () => {
    const { signer, address } = await readySigner();
    const message = signInMessage(address);
    const signed = await signer.handle({
      type: "sign",
      wallet: "claude",
      request: { kind: "message", message },
    });
    if (!signed.ok || signed.type !== "sign") throw new Error("sign failed");
    expect(await verifyMessage({ address, message, signature: signed.signature })).toBe(true);
  });

  it("reports today's signed spend per wallet", async () => {
    const { signer, address } = await readySigner();
    await signer.handle({
      type: "sign",
      wallet: "claude",
      request: { kind: "typedData", typedData: authorization(address, 250_000n) },
    });
    const listed = await signer.handle({ type: "listWallets" });
    if (!listed.ok || listed.type !== "listWallets") throw new Error("list failed");
    expect(listed.wallets[0]).toMatchObject({ name: "claude", spentTodayAtomic: "250000" });
  });

  it("lowers a limit without a password and needs the password to raise one", async () => {
    const { signer } = await readySigner();
    expect(
      await signer.handle({
        type: "setCaps",
        wallet: "claude",
        caps: { perCallAtomic: "500000", perDayAtomic: "2000000" },
      }),
    ).toMatchObject({ ok: true, type: "setCaps", wallet: { caps: { perCallAtomic: "500000" } } });

    const raise = { perCallAtomic: "5000000", perDayAtomic: "25000000" };
    expect(await signer.handle({ type: "setCaps", wallet: "claude", caps: raise })).toMatchObject({
      ok: false,
      code: "password_required",
    });
    expect(
      await signer.handle({
        type: "setCaps",
        wallet: "claude",
        caps: raise,
        password: "wrong one!",
      }),
    ).toMatchObject({ ok: false, code: "password_required" });
    expect(
      await signer.handle({
        type: "setCaps",
        wallet: "claude",
        caps: raise,
        password: "correct horse battery",
      }),
    ).toMatchObject({ ok: true, wallet: { caps: raise } });
  });

  it("enforces limits another program wrote to wallets.json after unlock", async () => {
    const { signer, address } = await readySigner();
    // The CLI edits the same registry: `vapi accounts caps claude --per-call 0.001`.
    const path = join(home, "wallets.json");
    const registry = JSON.parse(await readFile(path, "utf8"));
    registry.wallets.claude.spendCaps = { perCallAtomic: "1000", perDayAtomic: "5000000" };
    await writeFile(path, JSON.stringify(registry));
    expect(
      await signer.handle({
        type: "sign",
        wallet: "claude",
        request: { kind: "typedData", typedData: authorization(address, 2_000n) },
      }),
    ).toMatchObject({ ok: false, code: "cap_exceeded" });
  });

  it("creates an empty vault: no hidden account and no wallets", async () => {
    const signer = signerFor(home);
    await signer.handle({ type: "createVault", password: "correct horse battery" });
    expect(await signer.handle({ type: "listWallets" })).toEqual({
      ok: true,
      type: "listWallets",
      wallets: [],
    });
    const file = await readVaultFileUnlocked(join(home, "vault.json"));
    expect(file.protected).toBe(true);
    expect(file.accounts).toEqual([]);
  });

  it("retires the spike's empty owner-seed account on unlock", async () => {
    // A spike vault: made through a hidden first account, then protected.
    const secrets = memorySecretStore();
    const store = await WalletStore.open(home, { secrets });
    await store.create("owner-seed", "");
    await store.create("claude", "");
    await protectVault({
      path: join(home, "vault.json"),
      secrets,
      password: "correct horse battery",
    });
    const signer = signerFor(home, { secrets, readBalance: async () => 0n });
    expect(await signer.handle({ type: "unlock", password: "correct horse battery" })).toEqual({
      ok: true,
      type: "unlock",
    });
    const registry = JSON.parse(await readFile(join(home, "wallets.json"), "utf8"));
    expect(Object.keys(registry.wallets)).toEqual(["claude"]);
    expect(registry.default).toBe("claude");
  });

  it("links a wallet through core and reports the owner and the link state", async () => {
    const { signer } = await readySigner({
      linkCore: {
        startAccountLink: async (args) => {
          await args.store.setLink(args.account, {
            apiBase: API_BASE,
            clientId: "agent_claude",
            owner: OWNER,
            label: args.account,
            scopes: ["mcp:call"],
            linkedAt: "2026-10-26T10:00:00.000Z",
          });
          return { linked: true, autoApproved: true };
        },
        linkStates: async () => new Map([["claude", "linked" as const]]),
      },
    });
    expect(await signer.handle({ type: "linkStart", wallet: "claude" })).toEqual({
      ok: true,
      type: "linkStart",
      result: { mode: "silent" },
    });
    expect(await signer.handle({ type: "status" })).toMatchObject({ owner: OWNER });
    expect(await signer.handle({ type: "listWallets", includeLinks: true })).toMatchObject({
      wallets: [{ name: "claude", link: "linked" }],
    });
    const plain = await signer.handle({ type: "listWallets" });
    if (!plain.ok || plain.type !== "listWallets") throw new Error("list failed");
    expect(plain.wallets[0]?.link).toBeUndefined();
    expect(await signer.handle({ type: "lock" })).toEqual({ ok: true, type: "lock" });
    expect(await signer.handle({ type: "status" })).toEqual({
      ok: true,
      type: "status",
      vault: "locked",
      touchId: false,
      owner: OWNER,
    });
  });

  it("lists wallets without link states when a saved link has a malformed API base", async () => {
    const { signer, address } = await readySigner();
    const path = join(home, "wallets.json");
    const registry = JSON.parse(await readFile(path, "utf8"));
    registry.wallets.claude.link = {
      apiBase: "not a url",
      clientId: "agent_claude",
      owner: OWNER,
      label: "claude",
      scopes: ["mcp:call"],
      linkedAt: "2026-10-26T10:00:00.000Z",
    };
    await writeFile(path, JSON.stringify(registry));

    const listed = await signer.handle({ type: "listWallets", includeLinks: true });
    expect(listed).toMatchObject({
      ok: true,
      type: "listWallets",
      wallets: [{ name: "claude", address }],
    });
    if (!listed.ok || listed.type !== "listWallets") throw new Error("list failed");
    expect(listed.wallets).toHaveLength(1);
    expect(listed.wallets[0]?.link).toBeUndefined();
  });

  it.each(["unlocked", "locked"] as const)(
    "keeps status available while %s when a saved link has a malformed API base",
    async (vault) => {
      const { signer } = await readySigner();
      const path = join(home, "wallets.json");
      const registry = JSON.parse(await readFile(path, "utf8"));
      registry.wallets.claude.link = {
        apiBase: "not a url",
        clientId: "agent_claude",
        owner: OWNER,
        label: "claude",
        scopes: ["mcp:call"],
        linkedAt: "2026-10-26T10:00:00.000Z",
      };
      await writeFile(path, JSON.stringify(registry));
      if (vault === "locked") {
        expect(await signer.handle({ type: "lock" })).toEqual({ ok: true, type: "lock" });
      }
      expect(await signer.handle({ type: "status" })).toEqual({
        ok: true,
        type: "status",
        vault,
        touchId: false,
      });
    },
  );

  it("refuses to start a link while locked, and for an unknown wallet", async () => {
    const { signer } = await readySigner();
    expect(await signer.handle({ type: "linkStart", wallet: "nobody" })).toMatchObject({
      ok: false,
      code: "bad_request",
    });
    await signer.handle({ type: "lock" });
    expect(await signer.handle({ type: "linkStart", wallet: "claude" })).toMatchObject({
      ok: false,
      code: "locked",
    });
  });

  it("treats the hidden owner-seed wallet as unknown when starting a link", async () => {
    const secrets = memorySecretStore();
    const store = await WalletStore.open(home, { secrets });
    await store.create("owner-seed", "");
    await store.create("claude", "");
    await protectVault({
      path: join(home, "vault.json"),
      secrets,
      password: "correct horse battery",
    });
    const signer = signerFor(home, {
      secrets,
      linkCore: {
        startAccountLink: async () => ({ linked: true, autoApproved: true }),
      },
    });
    expect(await signer.handle({ type: "unlock", password: "correct horse battery" })).toEqual({
      ok: true,
      type: "unlock",
    });
    expect(await signer.handle({ type: "linkStart", wallet: "owner-seed" })).toEqual({
      ok: false,
      code: "bad_request",
      message: "No wallet named owner-seed.",
    });
  });

  it("cancels a pending browser link when locked", async () => {
    const { signer } = await readySigner({
      linkCore: {
        startAccountLink: async () => ({
          linked: false,
          autoApproved: false,
          link: {
            userCode: "ABCD-EFGH",
            verificationUri: `${API_BASE}/link`,
            verificationUriComplete: `${API_BASE}/link?code=ABCD-EFGH`,
            expiresInSeconds: 1200,
          },
          completion: new Promise<AccountLinkOutcome>(() => undefined),
        }),
      },
    });
    expect(await signer.handle({ type: "linkStart", wallet: "claude" })).toMatchObject({
      ok: true,
      type: "linkStart",
      result: { mode: "browser" },
    });
    expect(await signer.handle({ type: "linkPoll", wallet: "claude" })).toMatchObject({
      ok: true,
      type: "linkPoll",
      result: { state: "pending" },
    });
    expect(await signer.handle({ type: "lock" })).toEqual({ ok: true, type: "lock" });
    expect(await signer.handle({ type: "linkPoll", wallet: "claude" })).toEqual({
      ok: true,
      type: "linkPoll",
      result: { state: "none" },
    });
  });

  it("reports no running link for a wallet that never started one", async () => {
    const { signer } = await readySigner();
    expect(await signer.handle({ type: "linkPoll", wallet: "claude" })).toEqual({
      ok: true,
      type: "linkPoll",
      result: { state: "none" },
    });
  });
});
