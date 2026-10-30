// packages/core/src/link-state.ts
import { getAddress } from "viem";

import { agentSecretAccounts } from "./agent-link.js";
import type { SecretStore } from "./secret-store.js";
import { fetchSiblings, SiblingsError, type SiblingsResult } from "./siblings.js";
import type { WalletName, WalletStore } from "./wallet-store.js";

export type WalletLinkState = "linked" | "not_linked" | "revoked";

type Candidate = { name: WalletName; owner: `0x${string}`; address: `0x${string}` };

/**
 * The link state of every wallet in `store` for one vAPI server.
 *
 * Local first: a wallet is a candidate when it has link metadata for this
 * server and its tokens are in `secrets`. One siblings request through a
 * candidate then tells which of the owner's agents are still active. A
 * candidate whose own token is refused is revoked, and the next one asks. When
 * the server cannot be reached the candidates stay `linked`: being offline is
 * not a revocation.
 */
export async function linkStates(args: {
  store: WalletStore;
  secrets: SecretStore;
  apiBase: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}): Promise<Map<WalletName, WalletLinkState>> {
  const origin = new URL(args.apiBase).origin;
  await args.store.reload();
  const states = new Map<WalletName, WalletLinkState>();
  const candidates: Candidate[] = [];

  for (const name of args.store.names()) {
    const link = args.store.entry(name)?.link;
    const address = await args.store.readAddress(name);
    const hasTokens =
      args.secrets.available &&
      (await args.secrets.has(agentSecretAccounts(name).tokens).catch(() => false));
    if (
      link === undefined ||
      new URL(link.apiBase).origin !== origin ||
      address === undefined ||
      !hasTokens
    ) {
      states.set(name, "not_linked");
      continue;
    }
    states.set(name, "linked");
    candidates.push({ name, owner: getAddress(link.owner), address: getAddress(address) });
  }

  for (const source of candidates) {
    let result: SiblingsResult;
    try {
      result = await fetchSiblings({
        apiBase: args.apiBase,
        account: source.name,
        secrets: args.secrets,
        wallets: args.store,
        ...(args.fetchImpl === undefined ? {} : { fetchImpl: args.fetchImpl }),
        ...(args.now === undefined ? {} : { now: args.now }),
      });
    } catch (error) {
      if (error instanceof SiblingsError && error.code === "not_linked") {
        states.set(source.name, "revoked");
        continue;
      }
      // Offline, an older server, or a bad response: keep what is known locally.
      return states;
    }
    const owner = result.owner === null ? source.owner : getAddress(result.owner);
    for (const candidate of candidates) {
      if (candidate.owner !== owner) continue;
      const sibling = result.siblings.find(
        (entry) => getAddress(entry.address) === candidate.address,
      );
      states.set(candidate.name, sibling?.status === "active" ? "linked" : "revoked");
    }
    return states;
  }
  return states;
}
