// apps/desktop/src/renderer/link-flow.test.ts
import { describe, expect, it } from "vitest";

import {
  afterOpened,
  afterOpenFailed,
  afterPoll,
  afterStart,
  afterTick,
  declinedMessage,
  formatCountdown,
  linkPill,
  LOST_MESSAGE,
  youRow,
  type LinkFlow,
} from "./link-flow.js";

const OWNER = "0x8617E340B3D01FA5F11F306F4090FD50E238070D" as const;
const browser: LinkFlow = {
  kind: "browser",
  userCode: "ABCD-EFGH",
  url: "https://api.vapinetwork.ai/link?code=ABCD-EFGH",
  expiresAt: 10_000,
};

describe("browser opening", () => {
  it.each(["https://api-staging.vapinetwork.ai/link", undefined])(
    "stores the trusted fallback page %j and preserves it through pending polls and ticks",
    (page) => {
      const failed = afterOpenFailed(browser, page);
      expect(failed).toEqual({ ...browser, openFailedPage: page ?? null });
      expect(afterPoll(failed, { state: "pending", ...browser }, 9_999)).toBe(failed);
      expect(afterTick(failed, 9_999)).toBe(failed);
      expect(afterTick(failed, 10_000)).toEqual({ kind: "expired" });
    },
  );

  it("clears the browser error after opening successfully", () => {
    expect(afterOpened({ ...browser, openFailedPage: "https://api.vapinetwork.ai/link" })).toEqual(
      browser,
    );
    expect(afterOpened({ ...browser, openFailedPage: null })).toEqual(browser);
  });

  it("leaves every non-browser state unchanged after opening or failing", () => {
    const flows: LinkFlow[] = [
      { kind: "idle" },
      { kind: "starting" },
      { kind: "linked" },
      { kind: "declined" },
      { kind: "expired" },
      { kind: "failed", message: "offline" },
    ];
    for (const flow of flows) {
      expect(afterOpenFailed(flow)).toBe(flow);
      expect(afterOpenFailed(flow, "https://api.vapinetwork.ai/link")).toBe(flow);
      expect(afterOpened(flow)).toBe(flow);
    }
  });
});

describe("afterStart", () => {
  it("maps silent, browser and error starts", () => {
    expect(afterStart({ mode: "silent" })).toEqual({ kind: "linked" });
    expect(
      afterStart({ mode: "browser", userCode: "ABCD-EFGH", url: browser.url, expiresAt: 10_000 }),
    ).toEqual(browser);
    expect(afterStart({ mode: "error", message: "offline" })).toEqual({
      kind: "failed",
      message: "offline",
    });
  });
});

describe("afterPoll", () => {
  it("waits while pending and expires the code at its deadline", () => {
    const pending = { state: "pending", ...browser } as const;
    expect(afterPoll(browser, pending, 9_999)).toBe(browser);
    expect(afterPoll(browser, pending, 10_000)).toEqual({ kind: "expired" });
  });

  it("ends linked, declined, expired or failed", () => {
    expect(afterPoll(browser, { state: "linked", owner: OWNER }, 0)).toEqual({ kind: "linked" });
    expect(afterPoll(browser, { state: "denied", message: "no" }, 0)).toEqual({
      kind: "declined",
    });
    expect(afterPoll(browser, { state: "expired", message: "late" }, 0)).toEqual({
      kind: "expired",
    });
    expect(afterPoll(browser, { state: "failed", message: "broke" }, 0)).toEqual({
      kind: "failed",
      message: "broke",
    });
    expect(afterPoll(browser, { state: "none" }, 0)).toEqual({
      kind: "failed",
      message: LOST_MESSAGE,
    });
  });

  it("ignores polls once the flow has left the browser step", () => {
    expect(afterPoll({ kind: "linked" }, { state: "none" }, 0)).toEqual({ kind: "linked" });
  });
});

describe("afterTick", () => {
  it("waits before the deadline and expires at or after it without a poll", () => {
    expect(afterTick(browser, 9_999)).toBe(browser);
    expect(afterTick(browser, 10_000)).toEqual({ kind: "expired" });
    expect(afterTick(browser, 10_001)).toEqual({ kind: "expired" });
  });

  it("preserves every state outside browser approval", () => {
    const flows: LinkFlow[] = [
      { kind: "idle" },
      { kind: "starting" },
      { kind: "linked" },
      { kind: "declined" },
      { kind: "expired" },
      { kind: "failed", message: "offline" },
    ];
    for (const flow of flows) expect(afterTick(flow, 20_000)).toBe(flow);
  });
});

describe("formatCountdown", () => {
  it("shows minutes and seconds left and never goes negative", () => {
    expect(formatCountdown(1_200_000)).toBe("20:00");
    expect(formatCountdown(61_001)).toBe("1:02");
    expect(formatCountdown(-5)).toBe("0:00");
  });
});

describe("declinedMessage", () => {
  it("offers skip when a skip button is shown", () => {
    expect(declinedMessage(true)).toBe("The link was declined in the console. Try again or skip.");
  });

  it("only offers retry when there is no skip button", () => {
    expect(declinedMessage(false)).toBe("The link was declined in the console. Try again.");
  });
});

describe("linkPill", () => {
  it("is lime when linked and amber with an action otherwise", () => {
    expect(linkPill("linked")).toEqual({ label: "Linked", tone: "live" });
    expect(linkPill("not_linked")).toEqual({
      label: "Not linked",
      tone: "blocked",
      action: "Link",
    });
    expect(linkPill("revoked")).toEqual({
      label: "Not linked",
      tone: "blocked",
      action: "Link again",
    });
    expect(linkPill(undefined)).toBeUndefined();
  });
});

describe("youRow", () => {
  it("is not connected before any link", () => {
    expect(youRow(null, [{ link: "not_linked" }])).toEqual({
      status: "Not connected",
      connect: true,
    });
  });

  it("shows the owner and Connected while any wallet is linked", () => {
    expect(youRow(OWNER, [{ link: "revoked" }, { link: "linked" }])).toEqual({
      address: "0x8617…070D",
      status: "Connected",
      connect: false,
    });
  });

  it("keeps the owner but offers Connect when every link was revoked", () => {
    expect(youRow(OWNER, [{ link: "revoked" }])).toEqual({
      address: "0x8617…070D",
      status: "Not connected",
      connect: true,
    });
  });
});
