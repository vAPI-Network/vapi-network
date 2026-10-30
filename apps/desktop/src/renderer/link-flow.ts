// apps/desktop/src/renderer/link-flow.ts
import type { LinkPollState, LinkStartResult, WalletLinkState } from "../signer/messages.js";
import { shortAddress } from "./format.js";

/** Spec §4 copy for the ends of a browser link. */
export const EXPIRED_MESSAGE = "This code expired after 20 minutes.";
export const LOST_MESSAGE = "vAPI Desktop lost track of this link. Get a new code.";
export const OPEN_FAILED_MESSAGE =
  "vAPI Desktop could not open the console. Go to this page and enter the code above:";
export const OPEN_FAILED_WITHOUT_PAGE_MESSAGE =
  "vAPI Desktop could not open the console. Open the vAPI console's link page and enter the code above.";

export function declinedMessage(canSkip: boolean): string {
  return canSkip
    ? "The link was declined in the console. Try again or skip."
    : "The link was declined in the console. Try again.";
}

export type LinkFlow =
  | { kind: "idle" }
  | { kind: "starting" }
  | {
      kind: "browser";
      userCode: string;
      url: string;
      expiresAt: number;
      openFailedPage?: string | null;
    }
  | { kind: "linked" }
  | { kind: "expired" }
  | { kind: "declined" }
  | { kind: "failed"; message: string };

export function afterOpenFailed(flow: LinkFlow, page?: string): LinkFlow {
  return flow.kind === "browser" ? { ...flow, openFailedPage: page ?? null } : flow;
}

export function afterOpened(flow: LinkFlow): LinkFlow {
  if (flow.kind !== "browser") return flow;
  const { openFailedPage: _openFailedPage, ...opened } = flow;
  return opened;
}

export function afterStart(result: LinkStartResult): LinkFlow {
  switch (result.mode) {
    case "silent":
      return { kind: "linked" };
    case "browser":
      return {
        kind: "browser",
        userCode: result.userCode,
        url: result.url,
        expiresAt: result.expiresAt,
      };
    case "error":
      return { kind: "failed", message: result.message };
  }
}

export function afterPoll(flow: LinkFlow, result: LinkPollState, now: number): LinkFlow {
  if (flow.kind !== "browser") return flow;
  switch (result.state) {
    case "pending":
      return afterTick(flow, now);
    case "linked":
      return { kind: "linked" };
    case "denied":
      return { kind: "declined" };
    case "expired":
      return { kind: "expired" };
    case "failed":
      return { kind: "failed", message: result.message };
    case "none":
      return { kind: "failed", message: LOST_MESSAGE };
  }
}

/** Expire browser approval on the clock even when polling has not replied. */
export function afterTick(flow: LinkFlow, now: number): LinkFlow {
  return flow.kind === "browser" && now >= flow.expiresAt ? { kind: "expired" } : flow;
}

/** "19:58" for the time left on a device code; never negative. */
export function formatCountdown(msLeft: number): string {
  const seconds = Math.max(0, Math.ceil(msLeft / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export type LinkPill = { label: string; tone: "live" | "blocked"; action?: "Link" | "Link again" };

/** Spec §3: lime when linked; amber "Not linked" with a one-click action otherwise. */
export function linkPill(link: WalletLinkState | undefined): LinkPill | undefined {
  switch (link) {
    case "linked":
      return { label: "Linked", tone: "live" };
    case "not_linked":
      return { label: "Not linked", tone: "blocked", action: "Link" };
    case "revoked":
      return { label: "Not linked", tone: "blocked", action: "Link again" };
    default:
      return undefined;
  }
}

export type YouRow = { address?: string; status: "Connected" | "Not connected"; connect: boolean };

/** Spec §3 "You": the owner from the first link; Connected while any wallet is linked. */
export function youRow(owner: `0x${string}` | null, wallets: { link?: WalletLinkState }[]): YouRow {
  const connected = owner !== null && wallets.some((wallet) => wallet.link === "linked");
  return {
    ...(owner === null ? {} : { address: shortAddress(owner) }),
    status: connected ? "Connected" : "Not connected",
    connect: !connected,
  };
}
