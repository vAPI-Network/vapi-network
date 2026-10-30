// apps/desktop/src/renderer/nav.test.ts
import { describe, expect, it } from "vitest";

import type { Overview, OverviewWallet } from "../shared/overview.js";
import { accountLine, isCurrent, walletNodes } from "./nav.js";

const OWNER = "0x8617E340B3D01FA5F11F306F4090FD50E238070D" as const;

function wallet(name: string, overrides: Partial<OverviewWallet> = {}): OverviewWallet {
  return {
    name,
    address: "0x9467C22197110Cb2cBEE9b62C5d8424B130035f5",
    publicKey: "0x",
    caps: { perCallAtomic: "1000000", perDayAtomic: "5000000" },
    spentTodayAtomic: "0",
    balanceAtomic: "2000000",
    ...overrides,
  };
}

function overview(overrides: Partial<Overview> = {}): Overview {
  return {
    owner: null,
    recovery: null,
    wallets: [wallet("claude", { link: "linked" }), wallet("research", { link: "not_linked" })],
    activity: [],
    apps: [{ id: "claude-desktop", state: "connected", wallet: "research" }],
    ...overrides,
  };
}

describe("walletNodes", () => {
  it("hangs Claude Desktop under research when connected with that wallet", () => {
    const nodes = walletNodes(overview(), { kind: "wallet", name: "research" });
    expect(nodes).toEqual([
      {
        name: "claude",
        balance: "$2.00",
        link: "linked",
        selected: false,
        apps: [],
      },
      {
        name: "research",
        balance: "$2.00",
        link: "not_linked",
        selected: true,
        apps: ["Claude Desktop"],
      },
    ]);
  });

  it("shows no app when Claude Desktop is not installed, and an unreadable balance as such", () => {
    const nodes = walletNodes(
      overview({
        apps: [{ id: "claude-desktop", state: "not_connected" }],
        wallets: [wallet("claude", { balanceAtomic: null })],
      }),
      { kind: "home" },
    );
    expect(nodes).toEqual([{ name: "claude", balance: "Unavailable", selected: false, apps: [] }]);
  });

  it("is empty before the overview loads", () => {
    expect(walletNodes(undefined, { kind: "home" })).toEqual([]);
  });
});

describe("accountLine", () => {
  it("is You, not connected, before any link", () => {
    expect(accountLine(overview({ wallets: [wallet("claude", { link: "not_linked" })] }))).toEqual({
      title: "You",
      subtitle: "Not connected · This Mac unlocked",
      initial: "Y",
      connect: true,
    });
  });

  it("shows the owner and Connected while a wallet is linked", () => {
    expect(accountLine(overview({ owner: OWNER }))).toEqual({
      title: "0x8617…070D",
      subtitle: "Connected · This Mac unlocked",
      initial: "8",
      connect: false,
    });
  });
});

describe("isCurrent", () => {
  it("matches the page kind", () => {
    expect(isCurrent({ kind: "activity" }, "activity")).toBe(true);
    expect(isCurrent({ kind: "wallet", name: "claude" }, "home")).toBe(false);
    expect(isCurrent({ kind: "settings" }, "settings")).toBe(true);
  });
});
