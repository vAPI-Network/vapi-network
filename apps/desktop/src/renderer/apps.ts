import { APP_LABELS, CONNECTABLE_APP_IDS, type AppId, type AppStatus } from "../shared/apps.js";

export type CardAction = "connect" | "reinstall" | "switch" | null;
export type AppCard = {
  id: AppId;
  title: string;
  blurb: string;
  group: "chat" | "developer" | "later";
  badge: "Connected" | "Not yet" | null;
  paysFrom: string | null;
  action: CardAction;
  actionLabel: string | null;
  conflict: string | null;
};

const COPY: Record<AppId, Pick<AppCard, "blurb" | "group">> = {
  "claude-desktop": {
    group: "chat",
    blurb: "Search and pay for APIs from a Claude chat.",
  },
  cursor: {
    group: "chat",
    blurb: "Cursor asks you to confirm, then its agent can search and pay for APIs.",
  },
  vscode: {
    group: "chat",
    blurb:
      "VS Code asks you to confirm. Agent mode in Copilot Chat can then search and pay for APIs.",
  },
  codex: {
    group: "developer",
    blurb:
      "Adds these lines to ~/.codex/config.toml. Your current file is copied to config.toml.vapi-backup first.",
  },
  "grok-cli": {
    group: "developer",
    blurb:
      "Adds these lines to ~/.grok/config.toml. Your current file is copied to config.toml.vapi-backup first.",
  },
  "grok-apps": {
    group: "later",
    blurb:
      "Grok connects to servers on the internet only, so it cannot reach this Mac. Add the address below in Grok's connectors to search and inspect APIs. Paying from an agent wallet comes later.",
  },
  chatgpt: {
    group: "later",
    blurb:
      "ChatGPT connects to servers on the internet only. Paying from an agent wallet comes later.",
  },
};

/** Cards for one wallet. Legacy connections pay from the first wallet. */
export function appCards(
  statuses: AppStatus[],
  wallet: string,
  firstWallet: string | undefined,
): AppCard[] {
  const ids: AppId[] = [...CONNECTABLE_APP_IDS, "grok-apps", "chatgpt"];
  return ids.map((id): AppCard => {
    const card: AppCard = {
      id,
      title: APP_LABELS[id],
      ...COPY[id],
      badge: null,
      paysFrom: null,
      action: null,
      actionLabel: null,
      conflict: null,
    };
    if (id === "grok-apps") return card;
    if (id === "chatgpt") return { ...card, badge: "Not yet" };

    const status = statuses.find((status) => status.id === id);
    if (status?.state === "conflict") {
      return {
        ...card,
        conflict: `${card.title} already has a vapi server in ${status.path}. Remove it or edit it by hand.`,
      };
    }
    if (status?.state !== "connected") {
      return { ...card, action: "connect", actionLabel: "Connect" };
    }

    const payingWallet = status.wallet ?? firstWallet;
    const paysFrom = payingWallet === undefined ? null : `Pays from ${payingWallet}`;
    if (payingWallet !== wallet) {
      return { ...card, paysFrom, action: "switch", actionLabel: "Use this wallet" };
    }
    return {
      ...card,
      badge: "Connected",
      paysFrom:
        status.wallet === null
          ? `${paysFrom}. Reinstall to choose the wallet for this app.`
          : paysFrom,
      action: "reinstall",
      actionLabel: "Reinstall",
    };
  });
}

/** App labels that pay from `wallet`; `wallet: null` statuses count for the first wallet. */
export function appsForWallet(
  statuses: AppStatus[],
  wallet: string,
  firstWallet: string | undefined,
): string[] {
  return CONNECTABLE_APP_IDS.filter((id) =>
    statuses.some(
      (status) =>
        status.id === id &&
        status.state === "connected" &&
        (status.wallet ?? firstWallet) === wallet,
    ),
  ).map((id) => APP_LABELS[id]);
}
