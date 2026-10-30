// apps/desktop/src/renderer/nav.ts
import type { Overview } from "../shared/overview.js";
import type { WalletLinkState } from "../signer/messages.js";
import { appsForWallet } from "./apps.js";
import { formatUsd } from "./format.js";
import { youRow } from "./link-flow.js";

export type Page =
  | { kind: "home" }
  | { kind: "activity" }
  | { kind: "apps" }
  | { kind: "settings" }
  | { kind: "account" }
  | { kind: "kit" }
  | { kind: "backup" }
  | { kind: "new" }
  | { kind: "wallet"; name: string; link?: "created" | "clicked" };

export type NavItem = { id: "new" | "home" | "activity" | "apps"; label: string };

/**
 * The top of the sidebar, Claude Desktop style: actions and pages, then the
 * tree. Later pages (agent teams T5, instruction files T6) slot in here.
 */
export const NAV_ITEMS: readonly NavItem[] = [
  { id: "new", label: "New agent wallet" },
  { id: "home", label: "Home" },
  { id: "activity", label: "Activity" },
  { id: "apps", label: "Apps" },
];

export function isCurrent(page: Page, id: NavItem["id"] | "settings"): boolean {
  return page.kind === id;
}

export type WalletNode = {
  name: string;
  balance: string;
  link?: WalletLinkState;
  selected: boolean;
  apps: string[];
};

/** Agent wallets → the apps that pay from each (spec §3). */
export function walletNodes(overview: Overview | undefined, page: Page): WalletNode[] {
  return (overview?.wallets ?? []).map((wallet) => ({
    name: wallet.name,
    balance: wallet.balanceAtomic === null ? "Unavailable" : formatUsd(wallet.balanceAtomic),
    ...(wallet.link === undefined ? {} : { link: wallet.link }),
    selected: page.kind === "wallet" && page.name === wallet.name,
    apps: appsForWallet(overview?.apps ?? [], wallet.name, overview?.wallets[0]?.name),
  }));
}

export type AccountLine = { title: string; subtitle: string; initial: string; connect: boolean };

/** The footer row: you on vAPI, and this Mac's lock state (D6). The sidebar only exists unlocked. */
export function accountLine(overview: Overview | undefined): AccountLine {
  const you = youRow(overview?.owner ?? null, overview?.wallets ?? []);
  return {
    title: you.address ?? "You",
    subtitle: `${you.status} · This Mac unlocked`,
    initial: overview?.owner ? overview.owner.slice(2, 3).toUpperCase() : "Y",
    connect: you.connect,
  };
}
