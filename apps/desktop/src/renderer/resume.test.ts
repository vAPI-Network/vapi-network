// apps/desktop/src/renderer/resume.test.ts
import { describe, expect, it } from "vitest";

import { homeCards, resumeScreen } from "./resume.js";

const OWNER = "0x8617E340B3D01FA5F11F306F4090FD50E238070D" as const;

describe("resumeScreen", () => {
  it.each([
    ["none", false, "welcome"],
    ["none", true, "protect"],
    ["locked", false, "unlock"],
    ["locked", true, "unlock"],
    ["unlocked", false, "custody"],
    ["unlocked", true, "home"],
  ] as const)("vault %s, custody accepted %s → %s", (vault, custodyAccepted, expected) => {
    expect(resumeScreen({ vault, custodyAccepted })).toBe(expected);
  });
});

// apps/desktop/src/renderer/resume.test.ts — homeCards block
describe("homeCards", () => {
  const linked = { link: "linked", balanceAtomic: "0" } as const;
  const connectedApp = { state: "connected" } as const;
  const funded = { link: "linked", balanceAtomic: "2500000" } as const;

  it("asks for a first agent wallet before anything else", () => {
    expect(homeCards({ recovery: null, owner: null, wallets: [], apps: [] })).toEqual([
      "firstWallet",
    ]);
    expect(homeCards({ recovery: null, owner: OWNER, wallets: [], apps: [] })).toEqual([
      "firstWallet",
    ]);
  });

  it("keeps the Connect your vAPI account card until a wallet is linked", () => {
    expect(
      homeCards({
        recovery: null,
        owner: null,
        wallets: [{ link: "not_linked", balanceAtomic: "2500000" }],
        apps: [connectedApp],
      }),
    ).toEqual(["connectAccount"]);
    expect(
      homeCards({
        recovery: null,
        owner: OWNER,
        wallets: [{ link: "revoked", balanceAtomic: "2500000" }],
        apps: [connectedApp],
      }),
    ).toEqual(["connectAccount"]);
    expect(
      homeCards({
        recovery: null,
        owner: OWNER,
        wallets: [funded, { link: "not_linked", balanceAtomic: "1" }],
        apps: [connectedApp],
      }),
    ).toEqual([]);
  });

  it("keeps the Connect an app card until one app is connected", () => {
    expect(homeCards({ recovery: null, owner: OWNER, wallets: [funded], apps: [] })).toEqual([
      "connectApp",
    ]);
    expect(
      homeCards({
        recovery: null,
        owner: OWNER,
        wallets: [funded],
        apps: [{ state: "not_connected" }],
      }),
    ).toEqual(["connectApp"]);
    expect(
      homeCards({ recovery: null, owner: OWNER, wallets: [funded], apps: [{ state: "conflict" }] }),
    ).toEqual(["connectApp"]);
  });

  it("shows Add money only while every balance is known and zero", () => {
    expect(
      homeCards({ recovery: null, owner: OWNER, wallets: [linked], apps: [connectedApp] }),
    ).toEqual(["addMoney"]);
    expect(
      homeCards({ recovery: null, owner: OWNER, wallets: [linked, funded], apps: [connectedApp] }),
    ).toEqual([]);
    expect(
      homeCards({
        recovery: null,
        owner: OWNER,
        wallets: [{ link: "linked", balanceAtomic: null }],
        apps: [connectedApp],
      }),
    ).toEqual([]);
  });

  it("orders the cards account, app, money", () => {
    expect(
      homeCards({
        recovery: null,
        owner: null,
        wallets: [{ link: "not_linked", balanceAtomic: "0" }],
        apps: [],
      }),
    ).toEqual(["connectAccount", "connectApp", "addMoney"]);
  });
});

describe("homeCards recovery", () => {
  const off = { enabled: false, failed: false };
  const linkedWallet = { link: "linked", balanceAtomic: "2500000" } as const;
  const app = { state: "connected" } as const;

  it("asks for the Emergency Kit until it is done, right after the first wallet", () => {
    expect(
      homeCards({ owner: null, wallets: [], apps: [], recovery: { kit: false, backup: off } }),
    ).toEqual(["firstWallet", "emergencyKit"]);
    expect(
      homeCards({
        owner: OWNER,
        wallets: [linkedWallet],
        apps: [app],
        recovery: { kit: true, backup: { enabled: true, failed: false } },
      }),
    ).toEqual([]);
  });

  it("offers backup once the account is connected, and flags a failure", () => {
    expect(
      homeCards({
        owner: null,
        wallets: [{ link: "not_linked", balanceAtomic: "1" }],
        apps: [app],
        recovery: { kit: true, backup: off },
      }),
    ).toEqual(["connectAccount"]);
    expect(
      homeCards({
        owner: OWNER,
        wallets: [linkedWallet],
        apps: [app],
        recovery: { kit: true, backup: off },
      }),
    ).toEqual(["backup"]);
    expect(
      homeCards({
        owner: OWNER,
        wallets: [linkedWallet],
        apps: [app],
        recovery: { kit: true, backup: { enabled: true, failed: true } },
      }),
    ).toEqual(["backupFailed"]);
  });

  it("orders the Kit, account, app and money cards", () => {
    expect(
      homeCards({
        owner: null,
        wallets: [{ link: "not_linked", balanceAtomic: "0" }],
        apps: [],
        recovery: { kit: false, backup: off },
      }),
    ).toEqual(["emergencyKit", "connectAccount", "connectApp", "addMoney"]);
  });

  it("orders backup cards before app connection and funding", () => {
    for (const backup of [off, { enabled: true, failed: true }]) {
      expect(
        homeCards({
          owner: OWNER,
          wallets: [{ link: "linked", balanceAtomic: "0" }],
          apps: [],
          recovery: { kit: false, backup },
        }),
      ).toEqual([
        "emergencyKit",
        backup.enabled ? "backupFailed" : "backup",
        "connectApp",
        "addMoney",
      ]);
    }
  });
});
