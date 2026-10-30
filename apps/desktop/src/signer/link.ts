// apps/desktop/src/signer/link.ts
import {
  linkStates,
  startAccountLink,
  type AccountLinkOutcome,
  type SecretStore,
  type WalletStore,
} from "@vapi-network/core";

import { desktopDeviceName } from "./device-name.js";
import type { LinkPollState, LinkStartResult, WalletLinkState } from "./messages.js";

export type LinkCore = {
  startAccountLink: typeof startAccountLink;
  linkStates: typeof linkStates;
};

export type LinkServiceDeps = {
  secrets: SecretStore;
  apiBase: string;
  hostname: string;
  core?: Partial<LinkCore>;
  /** Milliseconds; the clock for code expiry and the link-state cache. */
  now?: () => number;
  /** How long a server answer about link states is reused. */
  cacheMs?: number;
};

type Pending = {
  controller: AbortController;
  userCode: string;
  url: string;
  expiresAt: number;
  outcome?: AccountLinkOutcome;
};

const STATE_CACHE_MS = 60_000;

/**
 * The signer side of "Connect your vAPI account" (spec D3, D4, D7). The signer
 * starts and polls the device link because it holds the wallet key that signs
 * the link request and the store the tokens land in. The UI only ever sees the
 * user code, the console URL and the outcome.
 */
export function createLinkService(deps: LinkServiceDeps) {
  const core: LinkCore = { startAccountLink, linkStates, ...deps.core };
  const now = deps.now ?? Date.now;
  const device = desktopDeviceName(deps.hostname);
  const origin = new URL(deps.apiBase).origin;
  const starting = new Map<string, AbortController>();
  const pending = new Map<string, Pending>();
  let cached: { at: number; states: Map<string, WalletLinkState> } | undefined;
  let cacheGeneration = 0;
  let statesInFlight: Promise<Map<string, WalletLinkState>> | undefined;

  async function start(store: WalletStore, wallet: string): Promise<LinkStartResult> {
    starting.get(wallet)?.abort();
    pending.get(wallet)?.controller.abort();
    pending.delete(wallet);
    const controller = new AbortController();
    starting.set(wallet, controller);
    // Core tries the trusted-device bearer of a linked sibling first (D3); the
    // server either approves at once or hands out a code for the browser (D4).
    let result: Awaited<ReturnType<LinkCore["startAccountLink"]>>;
    try {
      result = await core.startAccountLink({
        store,
        secrets: deps.secrets,
        account: wallet,
        apiBase: deps.apiBase,
        label: wallet,
        env: { VAPI_DEVICE: device },
        signal: controller.signal,
        now,
      });
      if (controller.signal.aborted || starting.get(wallet) !== controller) {
        return { mode: "error", message: "The link was cancelled." };
      }
    } finally {
      if (starting.get(wallet) === controller) starting.delete(wallet);
    }
    if (result.linked) {
      invalidate();
      return { mode: "silent" };
    }
    if (result.link === undefined || result.completion === undefined) {
      return { mode: "error", message: result.linkError ?? "The link could not be started." };
    }
    const entry: Pending = {
      controller,
      userCode: result.link.userCode,
      url: result.link.verificationUriComplete,
      expiresAt: now() + result.link.expiresInSeconds * 1_000,
    };
    pending.set(wallet, entry);
    void result.completion.then((outcome) => {
      entry.outcome = outcome;
      if (outcome.linked) invalidate();
    });
    return {
      mode: "browser",
      userCode: entry.userCode,
      url: entry.url,
      expiresAt: entry.expiresAt,
    };
  }

  function poll(wallet: string): LinkPollState {
    const entry = pending.get(wallet);
    if (entry === undefined) return { state: "none" };
    const outcome = entry.outcome;
    if (outcome === undefined) {
      return {
        state: "pending",
        userCode: entry.userCode,
        url: entry.url,
        expiresAt: entry.expiresAt,
      };
    }
    pending.delete(wallet);
    if (outcome.linked) return { state: "linked", owner: outcome.owner as `0x${string}` };
    return { state: outcome.reason, message: outcome.message };
  }

  function states(store: WalletStore): Promise<Map<string, WalletLinkState>> {
    if (cached !== undefined && now() - cached.at < (deps.cacheMs ?? STATE_CACHE_MS)) {
      return Promise.resolve(cached.states);
    }
    if (statesInFlight !== undefined) return statesInFlight;
    const generation = cacheGeneration;
    const flight = core
      .linkStates({ store, secrets: deps.secrets, apiBase: deps.apiBase })
      .then((fresh) => {
        if (generation === cacheGeneration) cached = { at: now(), states: fresh };
        return fresh;
      })
      .finally(() => {
        if (statesInFlight === flight) statesInFlight = undefined;
      });
    statesInFlight = flight;
    return flight;
  }

  function invalidate(): void {
    cacheGeneration += 1;
    cached = undefined;
    statesInFlight = undefined;
  }

  /** "You" (spec §3): the owner from the first link to this server, read from wallets.json. */
  function owner(store: WalletStore): `0x${string}` | undefined {
    for (const name of store.names()) {
      const link = store.entry(name)?.link;
      if (link !== undefined && new URL(link.apiBase).origin === origin) return link.owner;
    }
    return undefined;
  }

  function cancelAll(): void {
    for (const controller of starting.values()) controller.abort();
    starting.clear();
    for (const entry of pending.values()) entry.controller.abort();
    pending.clear();
    invalidate();
  }

  return {
    start,
    poll,
    states,
    owner,
    invalidate,
    cancelAll,
  };
}
