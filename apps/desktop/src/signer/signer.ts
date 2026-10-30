import { access } from "node:fs/promises";
import { join } from "node:path";
import {
  createVault,
  SpendCapError,
  WalletStore,
  VaultError,
  lockVault,
  readSpendLedger,
  readVaultFileUnlocked,
  reserveSpend,
  unlockProtectedVault,
  type SecretStore,
  type SpendCaps,
} from "@vapi-network/core";
import { getAddress, isAddress } from "viem";

import { DEFAULT_CAPS } from "../shared/limits.js";
import { createBackupService, type BackupCore } from "./backup.js";
import { createEmergencyKit } from "./emergency-kit.js";
import { LEGACY_SEED_NAME, retireLegacySeed } from "./legacy-seed.js";
import { createLinkService, type LinkCore } from "./link.js";
import { RestoreError, restoreFromPhrase } from "./restore.js";
import { siweRefusal } from "./siwe-policy.js";
import {
  MCP_REQUEST_TYPES,
  signerRequestSchema,
  type RequestOrigin,
  type SignerRequest,
  type SignerResponse,
  type WalletSummary,
} from "./messages.js";

export type PasswordStore = {
  get(): Promise<string | undefined>;
  set(value: string): Promise<void>;
  delete(): Promise<void>;
};

export type SignerDeps = {
  home: string;
  ledgerPath: string;
  password: PasswordStore;
  /** Vault and link secrets: `desktopSecretStore` in the app, memory in tests. */
  secrets: SecretStore;
  /** The vAPI server agent wallets link to (`VAPI_DESKTOP_API_BASE`). */
  apiBase: string;
  /** This Mac's host name; the console shows the device as "vAPI Desktop on <host>". */
  hostname: string;
  /** Tests replace core's network calls. */
  linkCore?: Partial<LinkCore>;
  backupCore?: Partial<BackupCore>;
  /** USDC on Base; used for restore and retiring an empty spike `owner-seed` account. */
  readBalance?: (address: `0x${string}`) => Promise<bigint>;
  now?: () => Date;
  /** Reported in `status`; the keychain helper sets it on macOS. */
  touchId?: boolean;
};

/** USDC contracts whose TransferWithAuthorization the signer will sign, by chain id. */
const USDC_BY_CHAIN: Record<number, `0x${string}`> = {
  8453: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  5042: "0x3600000000000000000000000000000000000000",
};

type Unlocked = { store: WalletStore };

export function createSigner(deps: SignerDeps) {
  const secrets = deps.secrets;
  const links = createLinkService({
    secrets,
    apiBase: deps.apiBase,
    hostname: deps.hostname,
    ...(deps.linkCore === undefined ? {} : { core: deps.linkCore }),
    ...(deps.now === undefined ? {} : { now: () => deps.now!().getTime() }),
  });
  const kit = createEmergencyKit({
    home: deps.home,
    secrets,
    ...(deps.now === undefined ? {} : { now: deps.now }),
  });
  const backup = createBackupService({
    home: deps.home,
    secrets,
    apiBase: deps.apiBase,
    hostname: deps.hostname,
    store: async () => unlocked?.store ?? (await openStore()),
    ...(deps.backupCore === undefined ? {} : { core: deps.backupCore }),
    ...(deps.now === undefined ? {} : { now: deps.now }),
  });

  async function ownerAddress(): Promise<`0x${string}` | undefined> {
    try {
      const store = unlocked?.store ?? (await openStore());
      await store.reload();
      return links.owner(store);
    } catch {
      return undefined;
    }
  }

  const vaultPath = join(deps.home, "vault.json");
  let unlocked: Unlocked | undefined;
  const env = { ...process.env };
  delete env.VAPI_VAULT_PASSWORD;
  delete env.VAPI_KEYSTORE_PASSWORD;

  async function openStore(): Promise<WalletStore> {
    return await WalletStore.open(deps.home, {
      secrets,
      env,
      ...(deps.now === undefined ? {} : { now: deps.now }),
    });
  }

  async function vaultState(): Promise<"none" | "locked" | "unlocked"> {
    try {
      await readVaultFileUnlocked(vaultPath);
    } catch (error) {
      if (error instanceof VaultError && error.code === "not_found") return "none";
      throw error;
    }
    return unlocked === undefined ? "locked" : "unlocked";
  }

  async function restoreInProgress(): Promise<boolean> {
    return await access(join(deps.home, ".backup-restore.json")).then(
      () => true,
      () => false,
    );
  }

  async function spentToday(name: string): Promise<string> {
    const now = deps.now?.() ?? new Date();
    return (await readSpendLedger(deps.ledgerPath, now, name)).spentAtomic;
  }

  async function summarize(store: WalletStore, name: string): Promise<WalletSummary> {
    const account = await store.unlock(name, "");
    const caps = store.entry(name)?.spendCaps ?? DEFAULT_CAPS;
    return {
      name,
      address: account.address,
      publicKey: account.publicKey,
      caps,
      spentTodayAtomic: await spentToday(name),
    };
  }

  async function passwordMatches(password: string): Promise<boolean> {
    try {
      const key = await unlockProtectedVault({ path: vaultPath, secrets, password, env });
      key.fill(0);
      return true;
    } catch {
      return false;
    }
  }

  function requireUnlocked(): Unlocked | SignerResponse {
    if (unlocked === undefined) {
      return { ok: false, code: "locked", message: "vAPI Desktop is locked." };
    }
    return unlocked;
  }

  async function enforceTypedData(
    store: WalletStore,
    wallet: string,
    typedData: unknown,
  ): Promise<SignerResponse | { value: bigint }> {
    const data = typedData as {
      domain?: { chainId?: number; verifyingContract?: string };
      primaryType?: string;
      message?: { from?: string; value?: bigint | string };
    };
    const chainId = data.domain?.chainId;
    const contract = data.domain?.verifyingContract;
    const expectedContract = chainId === undefined ? undefined : USDC_BY_CHAIN[chainId];
    if (
      data.primaryType !== "TransferWithAuthorization" ||
      expectedContract === undefined ||
      contract === undefined ||
      !isAddress(contract) ||
      getAddress(contract) !== getAddress(expectedContract)
    ) {
      return { ok: false, code: "not_permitted", message: "Only USDC payments can be signed." };
    }
    const address = await store.readAddress(wallet);
    const from = data.message?.from;
    if (
      address === undefined ||
      from === undefined ||
      !isAddress(from) ||
      getAddress(from) !== getAddress(address)
    ) {
      return { ok: false, code: "not_permitted", message: "The payment is not from this wallet." };
    }
    const raw = data.message?.value;
    const value = typeof raw === "bigint" ? raw : BigInt(String(raw ?? "0"));
    // The CLI and the app edit the same wallets.json; never sign against limits cached at unlock.
    await store.reload();
    const caps: SpendCaps = store.entry(wallet)?.spendCaps ?? DEFAULT_CAPS;
    try {
      await reserveSpend(value, caps, {
        ledgerPath: deps.ledgerPath,
        wallet,
        ...(deps.now === undefined ? {} : { now: deps.now() }),
      });
    } catch (error) {
      if (error instanceof SpendCapError) {
        return { ok: false, code: "cap_exceeded", message: error.message };
      }
      throw error;
    }
    return { value };
  }

  async function handle(raw: SignerRequest, origin: RequestOrigin = "ui"): Promise<SignerResponse> {
    const parsed = signerRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return { ok: false, code: "bad_request", message: parsed.error.message };
    }
    const message = parsed.data;
    if (origin !== "ui" && !MCP_REQUEST_TYPES.includes(message.type)) {
      return { ok: false, code: "not_permitted", message: "Not allowed from an app connection." };
    }
    try {
      switch (message.type) {
        case "status": {
          const vault = await vaultState();
          const owner = vault === "none" ? undefined : await ownerAddress();
          return {
            ok: true,
            type: "status",
            vault,
            touchId: deps.touchId ?? false,
            ...(owner === undefined ? {} : { owner }),
          };
        }

        case "createVault": {
          if ((await vaultState()) !== "none") {
            return {
              ok: false,
              code: "error",
              message: "A vault already exists on this computer.",
            };
          }
          // An empty vault: wallets are created by name, so the tree equals wallets.json.
          await createVault(deps.home, {
            secrets,
            password: message.password,
            ...(deps.now === undefined ? {} : { now: deps.now }),
          });
          // Protection removes the device key; establish the desktop's in-memory session.
          const key = await unlockProtectedVault({
            path: vaultPath,
            secrets,
            password: message.password,
            env,
            ...(deps.now === undefined ? {} : { now: deps.now }),
          });
          key.fill(0);
          await deps.password.set(message.password);
          unlocked = { store: await openStore() };
          return { ok: true, type: "createVault" };
        }

        case "restorePhrase": {
          if ((await vaultState()) !== "none") {
            return {
              ok: false,
              code: "error",
              message: "vAPI Desktop is already set up on this Mac.",
            };
          }
          const readBalance = deps.readBalance;
          if (readBalance === undefined) {
            return { ok: false, code: "error", message: "Balance check is not available." };
          }
          try {
            const restored = await restoreFromPhrase({
              home: deps.home,
              secrets,
              phrase: message.phrase,
              password: message.password,
              probe: async (address) => (await readBalance(address)) > 0n,
              ...(deps.now === undefined ? {} : { now: deps.now }),
            });
            const key = await unlockProtectedVault({
              path: vaultPath,
              secrets,
              password: message.password,
              env,
              ...(deps.now === undefined ? {} : { now: deps.now }),
            });
            key.fill(0);
            await deps.password.set(message.password);
            const store = await openStore();
            // Core rebuilds with CLI limits; restored agent wallets use Desktop's defaults.
            for (const name of restored.wallets) await store.setSpendCaps(name, DEFAULT_CAPS);
            unlocked = { store };
            backup.schedule();
            return { ok: true, type: "restorePhrase", wallets: restored.wallets };
          } catch (error) {
            if (error instanceof RestoreError) {
              return {
                ok: false,
                code: error.code === "bad_phrase" ? "bad_request" : "error",
                message: error.message,
              };
            }
            throw error;
          }
        }

        case "unlock": {
          if ((await vaultState()) === "none") {
            return {
              ok: false,
              code: "no_vault",
              message: "No vAPI Desktop setup on this computer yet.",
            };
          }
          const password = message.password ?? (await deps.password.get());
          if (password === undefined) {
            return { ok: false, code: "locked", message: "Password required." };
          }
          let key: Uint8Array;
          try {
            key = await unlockProtectedVault({
              path: vaultPath,
              secrets,
              password,
              env,
              ...(deps.now === undefined ? {} : { now: deps.now }),
            });
          } catch (error) {
            if (error instanceof VaultError && error.code === "bad_key") {
              return {
                ok: false,
                code: "password_required",
                message: "That password is not right.",
              };
            }
            throw error;
          }
          key.fill(0);
          unlocked = { store: await openStore() };
          if (deps.readBalance !== undefined) {
            await retireLegacySeed(unlocked.store, deps.readBalance);
          }
          if (message.password !== undefined) await deps.password.set(message.password);
          backup.schedule();
          return { ok: true, type: "unlock" };
        }

        case "lock": {
          links.cancelAll();
          backup.cancelAll();
          await lockVault({ secrets });
          unlocked = undefined;
          return { ok: true, type: "lock" };
        }

        case "revealPhrase": {
          const state = requireUnlocked();
          if ("ok" in state) return state;
          const result = await kit.reveal(message.password);
          if (!result.ok) return result;
          return { ok: true, type: "revealPhrase", words: result.words };
        }

        case "confirmKit": {
          const state = requireUnlocked();
          if ("ok" in state) return state;
          if (!(await kit.confirm())) {
            return { ok: false, code: "not_permitted", message: "Show the Emergency Kit first." };
          }
          return { ok: true, type: "confirmKit" };
        }

        case "recoveryStatus":
          return {
            ok: true,
            type: "recoveryStatus",
            recovery: { kit: await kit.done(), backup: await backup.status() },
          };

        case "backupStart": {
          if (message.purpose === "restore") {
            if ((await vaultState()) !== "none") {
              return {
                ok: false,
                code: "error",
                message: "vAPI Desktop is already set up on this Mac.",
              };
            }
            return { ok: true, type: "backupStart", result: await backup.start("restore") };
          }
          const state = requireUnlocked();
          if ("ok" in state) return state;
          await state.store.reload();
          return {
            ok: true,
            type: "backupStart",
            result: await backup.start("enroll", links.owner(state.store)),
          };
        }

        case "backupPoll":
          return { ok: true, type: "backupPoll", result: backup.poll() };

        case "restoreBackup": {
          if ((await vaultState()) !== "none" && !(await restoreInProgress())) {
            return {
              ok: false,
              code: "error",
              message: "vAPI Desktop is already set up on this Mac.",
            };
          }
          const restored = await backup.restore(message.password);
          const key = await unlockProtectedVault({
            path: vaultPath,
            secrets,
            password: message.password,
            env,
            ...(deps.now === undefined ? {} : { now: deps.now }),
          });
          key.fill(0);
          await deps.password.set(message.password);
          unlocked = { store: await openStore() };
          return { ok: true, type: "restoreBackup", wallets: restored.wallets };
        }

        case "listWallets": {
          const store = unlocked?.store ?? (await openStore());
          await store.reload();
          const names = store.names().filter((name) => name !== LEGACY_SEED_NAME);
          const wallets: WalletSummary[] = [];
          for (const name of names) {
            const address = await store.readAddress(name);
            if (address === undefined) continue;
            wallets.push({
              name,
              address: getAddress(address),
              publicKey: "0x",
              caps: store.entry(name)?.spendCaps ?? DEFAULT_CAPS,
              spentTodayAtomic: await spentToday(name),
            });
          }
          if (unlocked !== undefined) {
            for (const [index, wallet] of wallets.entries()) {
              wallets[index] = await summarize(unlocked.store, wallet.name);
            }
          }
          // Only the UI asks: the MCP host lists wallets per connection and must not wait on vAPI.
          if (message.includeLinks === true) {
            try {
              const states = await links.states(store);
              for (const wallet of wallets) wallet.link = states.get(wallet.name) ?? "not_linked";
            } catch {
              // Invalid saved link metadata must not prevent the wallet list from loading.
            }
          }
          return { ok: true, type: "listWallets", wallets };
        }

        case "createWallet": {
          const state = requireUnlocked();
          if ("ok" in state) return state;
          await state.store.create(message.name, "", { spendCaps: message.caps ?? DEFAULT_CAPS });
          links.invalidate();
          backup.schedule();
          return {
            ok: true,
            type: "createWallet",
            wallet: await summarize(state.store, message.name),
          };
        }

        case "setCaps": {
          const state = requireUnlocked();
          if ("ok" in state) return state;
          await state.store.reload();
          const current = state.store.entry(message.wallet)?.spendCaps;
          if (current === undefined) {
            return {
              ok: false,
              code: "bad_request",
              message: `No wallet named ${message.wallet}.`,
            };
          }
          const raises =
            BigInt(message.caps.perCallAtomic) > BigInt(current.perCallAtomic) ||
            BigInt(message.caps.perDayAtomic) > BigInt(current.perDayAtomic);
          // Lowering is always safe; raising is a person's decision, so it costs the password.
          if (
            raises &&
            !(message.password !== undefined && (await passwordMatches(message.password)))
          ) {
            return {
              ok: false,
              code: "password_required",
              message:
                message.password === undefined
                  ? "Enter your password to raise a limit."
                  : "That password is not right.",
            };
          }
          await state.store.setSpendCaps(message.wallet, message.caps);
          backup.schedule();
          return {
            ok: true,
            type: "setCaps",
            wallet: await summarize(state.store, message.wallet),
          };
        }

        case "sign": {
          const state = requireUnlocked();
          if ("ok" in state) return state;
          if (!state.store.has(message.wallet)) {
            return {
              ok: false,
              code: "bad_request",
              message: `No wallet named ${message.wallet}.`,
            };
          }
          const account = await state.store.unlock(message.wallet, "");
          if (message.request.kind === "message") {
            const refusal = siweRefusal(message.request.message, deps.apiBase, account.address);
            if (refusal) return { ok: false, code: "not_permitted", message: refusal };
            return {
              ok: true,
              type: "sign",
              signature: await account.signMessage({ message: message.request.message }),
            };
          }
          const policy = await enforceTypedData(
            state.store,
            message.wallet,
            message.request.typedData,
          );
          if ("ok" in policy) return policy;
          const typed = message.request.typedData as Parameters<typeof account.signTypedData>[0];
          return { ok: true, type: "sign", signature: await account.signTypedData(typed) };
        }

        case "linkStart": {
          const state = requireUnlocked();
          if ("ok" in state) return state;
          await state.store.reload();
          if (message.wallet === LEGACY_SEED_NAME || !state.store.has(message.wallet)) {
            return {
              ok: false,
              code: "bad_request",
              message: `No wallet named ${message.wallet}.`,
            };
          }
          const result = await links.start(state.store, message.wallet);
          if (result.mode === "silent") backup.schedule();
          return { ok: true, type: "linkStart", result };
        }

        case "linkPoll": {
          const result = links.poll(message.wallet);
          if (result.state === "linked") backup.schedule();
          return { ok: true, type: "linkPoll", result };
        }
      }
    } catch (error) {
      return {
        ok: false,
        code: "error",
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  return { handle };
}
