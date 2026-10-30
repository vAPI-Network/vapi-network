import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Overview, OverviewWallet } from "../../shared/overview.js";
import { Shell } from "./Shell.js";

const wallet: OverviewWallet = {
  name: "claude",
  address: "0x1234567890123456789012345678901234567890",
  publicKey: "0x1234",
  caps: { perCallAtomic: "1000000", perDayAtomic: "5000000" },
  spentTodayAtomic: "0",
  balanceAtomic: "0",
  link: "linked",
};

function render(initial: Overview) {
  return renderToStaticMarkup(createElement(Shell, { initial, onLocked: () => {} }));
}

beforeEach(() => {
  vi.stubGlobal("window", { localStorage: { getItem: () => null } });
});
afterEach(() => vi.unstubAllGlobals());

describe("Home setup cards", () => {
  it("offers app connection and funding after the first wallet is created", () => {
    const html = render({
      owner: wallet.address,
      recovery: null,
      wallets: [wallet],
      apps: [],
      activity: [],
    });
    expect(html).toContain("Connect an app</span>");
    expect(html).toContain("Add money</span>");
    expect(html).not.toContain("Create your first agent wallet</span>");
    expect(html).not.toContain("Connect your vAPI account</span>");
  });

  it("hides completed app and funding cards", () => {
    const html = render({
      owner: wallet.address,
      recovery: null,
      wallets: [{ ...wallet, balanceAtomic: "2500000" }],
      apps: [{ id: "claude-desktop", state: "connected", wallet: wallet.name }],
      activity: [],
    });
    expect(html).not.toContain("Connect an app</span>");
    expect(html).not.toContain("Add money</span>");
  });
  it("describes the Kit as independent recovery when encrypted backup is enabled", () => {
    const html = render({
      owner: wallet.address,
      recovery: { kit: false, backup: { enabled: true, failed: false } },
      wallets: [wallet],
      apps: [],
      activity: [],
    });
    expect(html).toContain("They work even without vAPI.");
    expect(html).not.toContain("money is gone");
  });
});
