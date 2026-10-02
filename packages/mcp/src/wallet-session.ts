import {
  DEFAULT_WALLET_NAME,
  KeystoreError,
  activeAgentMarker,
  appendAudit,
  assertWalletName,
  getVapiPaths,
  secretStore,
  spendCapsForWallet,
  staleStoredPassphraseMessage,
  type PassphraseSource,
  type SecretStore,
  type SpendCaps,
  type VapiPaymentAccount,
  type WalletName,
  type WalletStore,
} from "@vapi-network/core";
import type { Address } from "viem";

import type { WalletAddresses } from "./tools/wallet.js";

/** The account one tool call acts on. `path` is absent on a single-account home. */
export type SessionWallet = {
  name: WalletName;
  /** The legacy keystore path, when this machine has an account store. */
  path?: string;
};

/** One row of `wallet.list`, before balances are read. */
export type SessionWalletInfo = {
  name: WalletName;
  address?: string;
  solanaAddress?: string;
  label?: string;
  isDefault: boolean;
  /** Whether this is the account the session currently pays from. */
  isActive: boolean;
  spendCaps?: SpendCaps;
};

export type WalletSessionOptions = {
  /** The account opened before stdio was connected, for a store-less home. */
  account: VapiPaymentAccount;
  /** The accounts on this machine. Without it the session has exactly one. */
  store?: WalletStore | undefined;
  /** The name the session starts on, before `VAPI_WALLET` and the default. */
  wallet?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  /**
   * The passphrase for a legacy 0.5 keystore that has not been migrated yet,
   * used when neither `VAPI_KEYSTORE_PASSWORD` nor the OS secret store has one.
   * The CLI hands over what it read at startup, so MCP stdout is never prompted.
   */
  passphrase?: (() => string | Promise<string>) | undefined;
  /** The OS secret store to read `vapi unlock` entries from. */
  secretStore?: SecretStore | undefined;
  now?: (() => Date) | undefined;
};

/**
 * Which account an MCP session pays from, for the lifetime of the process.
 *
 * `wallet.use` is memory-only. The account tools may derive an account or lower
 * its caps in `wallets.json`, but this package never renames, removes, backs up
 * or exports one. Reads — addresses, balances, network accounts, funding links
 * — need no passphrase or opened vault. Only signing operations open a signer.
 */
export class WalletSession {
  #active: WalletName | undefined;
  #store: SecretStore | undefined;

  constructor(private readonly options: WalletSessionOptions) {
    this.#active = this.#initialName();
  }

  /** The account the next tool call uses when it names none. */
  get activeName(): WalletName | undefined {
    return this.#active;
  }

  get store(): WalletStore | undefined {
    return this.options.store;
  }

  /** The home the audit log lives in, honouring `VAPI_HOME`. */
  get home(): string {
    return this.options.store?.home ?? getVapiPaths().directory;
  }

  /**
   * An explicit name first, then the session's active account — which already
   * absorbed `VAPI_WALLET` and the registry default when the session started.
   */
  resolve(name?: string): SessionWallet {
    const requested = name?.trim();
    const store = this.options.store;
    if (store) {
      const selection = requested && requested.length > 0 ? requested : this.#active;
      if (selection !== undefined) {
        const accountName = assertWalletName(selection);
        if (!store.has(accountName)) {
          throw new KeystoreError(
            `No account named ${accountName}. This machine has: ${store.names().sort().join(", ")}.`,
          );
        }
      }
      const resolved = store.resolve({
        ...(selection === undefined ? {} : { name: selection }),
        env: this.#env(),
      });
      return { name: resolved.name, path: resolved.path };
    }
    const only = this.#active ?? DEFAULT_WALLET_NAME;
    if (requested !== undefined && requested.length > 0 && assertWalletName(requested) !== only) {
      throw new KeystoreError(`No account named ${requested}. This machine has: ${only}.`);
    }
    return { name: only };
  }

  /** The addresses of an account, read from the vault or a legacy keystore header. */
  async addressesFor(name?: string): Promise<{ wallet: SessionWallet } & WalletAddresses> {
    const wallet = this.resolve(name);
    const store = this.options.store;
    if (!store) {
      const account = this.options.account;
      return {
        wallet,
        address: account.address,
        ...(account.solana ? { solana: { address: account.solana.address } } : {}),
      };
    }
    const summary = (await store.list()).find((info) => info.name === wallet.name);
    if (summary?.address === undefined) {
      throw new KeystoreError(
        `Account ${wallet.name} records no address. Its legacy keystore at ${wallet.path ?? "(unknown)"} is missing or unreadable.`,
      );
    }
    return {
      wallet,
      address: summary.address as Address,
      ...(summary.solanaAddress ? { solana: { address: summary.solanaAddress } } : {}),
    };
  }

  /**
   * The signer for one payment, plus the caps of that account. Nothing
   * here is cached: the account is created for this call and dropped with it,
   * so switching accounts mid-session pays from the account that was asked for.
   */
  async payment(name?: string): Promise<{
    wallet: SessionWallet;
    account: VapiPaymentAccount;
    spendCaps?: SpendCaps;
  }> {
    const wallet = this.resolve(name);
    const store = this.options.store;
    if (!store || wallet.path === undefined) {
      return { wallet, account: this.options.account };
    }
    const account = (await store.hasVaultAccount(wallet.name))
      ? await store.unlock(wallet.name, "")
      : await this.#unlockLegacy(wallet);
    return { wallet, account, spendCaps: await spendCapsForWallet(store, wallet.name) };
  }

  /** Every account this machine knows, with the session's own marker on one. */
  async list(): Promise<SessionWalletInfo[]> {
    const store = this.options.store;
    const active = this.#active;
    if (!store) {
      const account = this.options.account;
      const name = active ?? DEFAULT_WALLET_NAME;
      return [
        {
          name,
          address: account.address,
          ...(account.solana ? { solanaAddress: account.solana.address } : {}),
          isDefault: true,
          isActive: true,
        },
      ];
    }
    return (await store.list()).map((info) => ({
      name: info.name,
      ...(info.address === undefined ? {} : { address: info.address }),
      ...(info.solanaAddress === undefined ? {} : { solanaAddress: info.solanaAddress }),
      ...(info.label === undefined ? {} : { label: info.label }),
      isDefault: info.isDefault,
      isActive: info.name === active,
      spendCaps: { ...info.spendCaps },
    }));
  }

  /**
   * Points the session at another account. Memory only: the human's default in
   * `wallets.json` is not touched, so the next `vapi` command in their terminal
   * still uses the account they chose. The switch is audited, because the account
   * an agent pays from changed.
   */
  async use(name: string): Promise<{
    active: WalletName;
    address?: string;
    previous: WalletName | null;
  }> {
    const wallet = this.resolve(assertWalletName(name));
    const previous = this.#active ?? null;
    this.#active = wallet.name;
    let address: string | undefined;
    try {
      address = (await this.addressesFor(wallet.name)).address;
    } catch {
      // An account whose address cannot be read is still selectable; the tools
      // that need the address will say so themselves.
      address = undefined;
    }
    const marker = activeAgentMarker(this.#env());
    await appendAudit(
      this.home,
      {
        event: "wallet.use.session",
        wallet: wallet.name,
        // An MCP server speaks JSON-RPC over a pipe; there is never a terminal.
        tty: false,
        ...(marker === undefined ? {} : { agentMarker: marker }),
        detail:
          previous === null
            ? "mcp session active wallet set"
            : `mcp session active wallet was ${previous}`,
      },
      { ...(this.options.now ? { now: this.options.now } : {}) },
    );
    return { active: wallet.name, previous, ...(address === undefined ? {} : { address }) };
  }

  #initialName(): WalletName | undefined {
    const requested = this.options.wallet?.trim() || this.#env().VAPI_WALLET?.trim() || undefined;
    if (requested !== undefined) return assertWalletName(requested);
    return (
      this.options.store?.defaultName ?? (this.options.store ? undefined : DEFAULT_WALLET_NAME)
    );
  }

  #env(): NodeJS.ProcessEnv {
    return this.options.env ?? process.env;
  }

  /**
   * The passphrase for one legacy-keystore payment: `VAPI_KEYSTORE_PASSWORD`,
   * then the OS secret store entry left for this account, then whatever the CLI
   * read when it started the server. An agent is never prompted.
   */
  async #passphraseFor(
    wallet: SessionWallet,
  ): Promise<{ passphrase: string; source: PassphraseSource }> {
    const fromEnvironment = this.#env().VAPI_KEYSTORE_PASSWORD;
    if (fromEnvironment !== undefined && fromEnvironment.length > 0) {
      return { passphrase: fromEnvironment, source: "environment" };
    }
    const store = this.#secretStore();
    if (store.available) {
      try {
        const stored = await store.get(wallet.name);
        if (stored !== undefined && stored.length > 0) {
          return { passphrase: stored, source: "secret-store" };
        }
      } catch {
        // A keyring that cannot be reached is the same as an empty one here;
        // the error below says how to arrange a passphrase either way.
      }
    }
    const supplied = await this.options.passphrase?.();
    if (supplied !== undefined && supplied.length > 0) {
      return { passphrase: supplied, source: "prompt" };
    }
    throw new KeystoreError(
      [
        `No passphrase for legacy account ${wallet.name}.`,
        ...(store.available
          ? [
              `Run vapi unlock --wallet ${wallet.name} in a terminal to put it in ${store.description},`,
            ]
          : []),
        store.available ? "or set" : "Set",
        "VAPI_KEYSTORE_PASSWORD in this MCP server's environment; an agent can never be prompted for one.",
      ].join(" "),
    );
  }

  /** One legacy unlock, with the reason spelled out when a stored passphrase is stale. */
  async #unlockLegacy(wallet: SessionWallet): Promise<VapiPaymentAccount> {
    const resolved = await this.#passphraseFor(wallet);
    try {
      return await this.options.store!.unlock(wallet.name, resolved.passphrase);
    } catch (error) {
      if (resolved.source !== "secret-store" || !(error instanceof KeystoreError)) throw error;
      throw new KeystoreError(
        staleStoredPassphraseMessage(wallet.name, this.#secretStore()).replace(
          `opens wallet ${wallet.name}`,
          `opens account ${wallet.name}`,
        ),
        { cause: error },
      );
    }
  }

  #secretStore(): SecretStore {
    this.#store ??= this.options.secretStore ?? secretStore();
    return this.#store;
  }
}
