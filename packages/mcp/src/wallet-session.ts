import {
  DEFAULT_WALLET_NAME,
  KeystoreError,
  activeAgentMarker,
  appendAudit,
  assertWalletName,
  getVapiPaths,
  spendCapsForWallet,
  unlockKeystore,
  type SpendCaps,
  type VapiPaymentAccount,
  type WalletName,
  type WalletStore,
} from "@vapi-network/core";
import type { Address } from "viem";

import type { WalletAddresses } from "./tools/wallet.js";

/** The wallet one tool call acts on. `path` is absent on a single-wallet home. */
export type SessionWallet = {
  name: WalletName;
  /** The keystore file, when this machine has a wallet store. */
  path?: string;
};

/** One row of `wallet.list`, before balances are read. */
export type SessionWalletInfo = {
  name: WalletName;
  address?: string;
  solanaAddress?: string;
  label?: string;
  isDefault: boolean;
  /** Whether this is the wallet the session currently pays from. */
  isActive: boolean;
  spendCaps?: SpendCaps;
};

export type WalletSessionOptions = {
  /** The wallet unlocked before stdio was connected, for a store-less home. */
  account: VapiPaymentAccount;
  /** The wallets on this machine. Without it the session has exactly one. */
  store?: WalletStore | undefined;
  /** The name the session starts on, before `VAPI_WALLET` and the default. */
  wallet?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  /**
   * The passphrase a payment unlocks with. The CLI hands over the one it read
   * at startup — from `VAPI_KEYSTORE_PASSWORD`, or from the person who ran
   * `vapi mcp` in a terminal — so switching wallets never needs a prompt on a
   * stdout that belongs to MCP frames. Release 3 replaces it with the OS
   * secret store.
   */
  passphrase?: (() => string | Promise<string>) | undefined;
  now?: (() => Date) | undefined;
};

/**
 * Which wallet an MCP session pays from, for the lifetime of the process.
 *
 * The session is the only mutable wallet state the server has, and it is
 * deliberately memory-only: `wallet.use` moves it, and nothing in this package
 * ever writes `wallets.json`, creates, removes, renames, backs up or exports a
 * wallet. Reads — addresses, balances, accounts, funding links — need no
 * passphrase at all, because the wallet store can read a keystore's addresses
 * without opening it. Only a payment unlocks a key, once, for that one call.
 */
export class WalletSession {
  #active: WalletName | undefined;

  constructor(private readonly options: WalletSessionOptions) {
    this.#active = this.#initialName();
  }

  /** The wallet the next tool call uses when it names none. */
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
   * An explicit name first, then the session's active wallet — which already
   * absorbed `VAPI_WALLET` and the registry default when the session started.
   */
  resolve(name?: string): SessionWallet {
    const requested = name?.trim();
    const store = this.options.store;
    if (store) {
      const selection = requested && requested.length > 0 ? requested : this.#active;
      const resolved = store.resolve({
        ...(selection === undefined ? {} : { name: selection }),
        env: this.#env(),
      });
      return { name: resolved.name, path: resolved.path };
    }
    const only = this.#active ?? DEFAULT_WALLET_NAME;
    if (requested !== undefined && requested.length > 0 && assertWalletName(requested) !== only) {
      throw new KeystoreError(`No wallet named ${requested}. This machine has: ${only}.`);
    }
    return { name: only };
  }

  /** The addresses of a wallet, read straight out of its keystore header. */
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
        `Wallet ${wallet.name} records no address. Its keystore at ${wallet.path ?? "(unknown)"} is missing or unreadable.`,
      );
    }
    return {
      wallet,
      address: summary.address as Address,
      ...(summary.solanaAddress ? { solana: { address: summary.solanaAddress } } : {}),
    };
  }

  /**
   * The unlocked key for one payment, plus the caps of that wallet. Nothing
   * here is cached: the account is created for this call and dropped with it,
   * so switching wallets mid-session pays from the wallet that was asked for.
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
    const account = await unlockKeystore(await this.#passphraseFor(wallet), wallet.path);
    return { wallet, account, spendCaps: await spendCapsForWallet(store, wallet.name) };
  }

  /** Every wallet this machine knows, with the session's own marker on one. */
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
   * Points the session at another wallet. Memory only: the human's default in
   * `wallets.json` is not touched, so the next `vapi` command in their terminal
   * still uses the wallet they chose. The switch is audited, because the wallet
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
      // A wallet whose keystore cannot be read is still selectable; the tools
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

  async #passphraseFor(wallet: SessionWallet): Promise<string> {
    const supplied = await this.options.passphrase?.();
    const passphrase = supplied ?? this.#env().VAPI_KEYSTORE_PASSWORD;
    if (passphrase === undefined || passphrase.length === 0) {
      throw new KeystoreError(
        `No passphrase for wallet ${wallet.name}. Set VAPI_KEYSTORE_PASSWORD in this MCP server's environment; an agent can never be prompted for one.`,
      );
    }
    return passphrase;
  }
}
