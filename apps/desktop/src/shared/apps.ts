export type ConnectableAppId = "claude-desktop" | "cursor" | "vscode" | "codex" | "grok-cli";
export type InfoAppId = "grok-apps" | "chatgpt";
export type AppId = ConnectableAppId | InfoAppId;

export const CONNECTABLE_APP_IDS: readonly ConnectableAppId[] = [
  "claude-desktop",
  "cursor",
  "vscode",
  "codex",
  "grok-cli",
];

/** What an app has installed right now, read from that app's own config. */
export type AppStatus =
  | { id: ConnectableAppId; state: "not_connected" }
  /** `wallet: null` = installed without VAPI_DESKTOP_WALLET: the host pays from the first wallet. */
  | { id: ConnectableAppId; state: "connected"; wallet: string | null }
  /** A `vapi` server we did not write (Codex/Grok CLI only): we will not touch it. */
  | { id: ConnectableAppId; state: "conflict"; path: string };

export type ConnectResult =
  | { ok: true; kind: "opened" } // deep link / .mcpb handed to the app
  | { ok: true; kind: "written"; path: string; backup: string | null }
  | { ok: false; message: string };

export const APP_LABELS: Record<AppId, string> = {
  "claude-desktop": "Claude Desktop",
  cursor: "Cursor",
  vscode: "VS Code",
  codex: "Codex",
  "grok-cli": "Grok CLI",
  "grok-apps": "Grok",
  chatgpt: "ChatGPT",
};
export const HOSTED_MCP_URL = "https://api.vapinetwork.ai/mcp";
