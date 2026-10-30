import { describe, expect, it } from "vitest";

import type { AppStatus } from "../shared/apps.js";
import { appCards, appsForWallet } from "./apps.js";

describe("appsForWallet", () => {
  it("lists apps only for the wallet that pays", () => {
    const statuses: AppStatus[] = [
      { id: "claude-desktop", state: "connected", wallet: "research" },
    ];
    expect(appsForWallet(statuses, "research", "claude")).toEqual(["Claude Desktop"]);
    expect(appsForWallet(statuses, "claude", "claude")).toEqual([]);
  });

  it("assigns legacy connections to the first wallet", () => {
    const statuses: AppStatus[] = [{ id: "claude-desktop", state: "connected", wallet: null }];
    expect(appsForWallet(statuses, "claude", "claude")).toEqual(["Claude Desktop"]);
    expect(appsForWallet(statuses, "research", "claude")).toEqual([]);
    expect(appsForWallet(statuses, "claude", undefined)).toEqual([]);
  });

  it("assigns disconnected and conflicting apps to nobody", () => {
    const statuses: AppStatus[] = [
      { id: "claude-desktop", state: "not_connected" },
      { id: "codex", state: "conflict", path: "/config/codex.toml" },
    ];
    expect(appsForWallet(statuses, "claude", "claude")).toEqual([]);
    expect(appsForWallet(statuses, "research", "claude")).toEqual([]);
  });

  it("uses CONNECTABLE_APP_IDS order rather than detection order", () => {
    const statuses: AppStatus[] = [
      { id: "grok-cli", state: "connected", wallet: "research" },
      { id: "codex", state: "connected", wallet: "research" },
      { id: "vscode", state: "connected", wallet: "research" },
      { id: "cursor", state: "connected", wallet: "research" },
      { id: "claude-desktop", state: "connected", wallet: "research" },
    ];
    expect(appsForWallet(statuses, "research", "claude")).toEqual([
      "Claude Desktop",
      "Cursor",
      "VS Code",
      "Codex",
      "Grok CLI",
    ]);
  });
});

describe("appCards", () => {
  it("offers to connect an app that is not connected", () => {
    const statuses: AppStatus[] = [{ id: "claude-desktop", state: "not_connected" }];
    expect(appCards(statuses, "research", "claude")[0]).toMatchObject({
      action: "connect",
      actionLabel: "Connect",
      paysFrom: null,
      badge: null,
    });
    expect(appCards([], "research", "claude")[0]).toMatchObject({
      action: "connect",
      actionLabel: "Connect",
      paysFrom: null,
    });
  });

  it("offers to reinstall an app connected to this wallet", () => {
    expect(
      appCards(
        [{ id: "claude-desktop", state: "connected", wallet: "research" }],
        "research",
        "claude",
      )[0],
    ).toMatchObject({
      badge: "Connected",
      paysFrom: "Pays from research",
      action: "reinstall",
      actionLabel: "Reinstall",
    });
  });

  it("offers to reinstall a legacy connection from the first wallet", () => {
    expect(
      appCards([{ id: "claude-desktop", state: "connected", wallet: null }], "claude", "claude")[0],
    ).toMatchObject({
      badge: "Connected",
      action: "reinstall",
      actionLabel: "Reinstall",
      paysFrom: "Pays from claude. Reinstall to choose the wallet for this app.",
    });
  });

  it("offers to switch a legacy connection viewed from another wallet", () => {
    expect(
      appCards(
        [{ id: "claude-desktop", state: "connected", wallet: null }],
        "research",
        "claude",
      )[0],
    ).toMatchObject({
      badge: null,
      paysFrom: "Pays from claude",
      action: "switch",
      actionLabel: "Use this wallet",
    });
  });

  it("offers to switch an app connected to another wallet", () => {
    expect(
      appCards(
        [{ id: "claude-desktop", state: "connected", wallet: "other" }],
        "research",
        "claude",
      )[0],
    ).toMatchObject({
      badge: null,
      paysFrom: "Pays from other",
      action: "switch",
      actionLabel: "Use this wallet",
    });
  });

  it("explains conflicts using the app label and path without offering an action", () => {
    const cards = appCards(
      [
        { id: "codex", state: "conflict", path: "~/.codex/config.toml" },
        { id: "grok-cli", state: "conflict", path: "~/.grok/config.toml" },
      ],
      "research",
      "claude",
    );
    expect(cards.find((card) => card.id === "codex")).toMatchObject({
      action: null,
      actionLabel: null,
      badge: null,
      paysFrom: null,
      conflict:
        "Codex already has a vapi server in ~/.codex/config.toml. Remove it or edit it by hand.",
    });
    expect(cards.find((card) => card.id === "grok-cli")).toMatchObject({
      action: null,
      conflict:
        "Grok CLI already has a vapi server in ~/.grok/config.toml. Remove it or edit it by hand.",
    });
  });

  it("lists Grok as coming later without a connection action or badge", () => {
    expect(
      appCards([], "research", "claude").find((card) => card.id === "grok-apps"),
    ).toMatchObject({ group: "later", action: null, badge: null });
  });

  it("lists ChatGPT as coming later with a Not yet badge and no action", () => {
    expect(appCards([], "research", "claude").find((card) => card.id === "chatgpt")).toMatchObject({
      group: "later",
      action: null,
      badge: "Not yet",
    });
  });

  it("keeps the catalogue order and chat, developer and later groups", () => {
    expect(appCards([], "research", "claude").map(({ id, group }) => ({ id, group }))).toEqual([
      { id: "claude-desktop", group: "chat" },
      { id: "cursor", group: "chat" },
      { id: "vscode", group: "chat" },
      { id: "codex", group: "developer" },
      { id: "grok-cli", group: "developer" },
      { id: "grok-apps", group: "later" },
      { id: "chatgpt", group: "later" },
    ]);
  });
});
