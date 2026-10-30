export type ShimTarget = { shimPath: string; socketPath: string; wallet: string };

export const SERVER_NAME = "vapi";

export function serverConfig(t: ShimTarget): {
  command: string;
  args: string[];
  env: Record<string, string>;
} {
  return {
    command: t.shimPath,
    args: [],
    env: {
      VAPI_DESKTOP_SOCKET: t.socketPath,
      VAPI_DESKTOP_WALLET: t.wallet,
    },
  };
}

export function cursorInstallUrl(t: ShimTarget): string {
  const json = JSON.stringify(serverConfig(t));
  const config = encodeURIComponent(Buffer.from(json, "utf8").toString("base64"));
  return `cursor://anysphere.cursor-deeplink/mcp/install?name=${SERVER_NAME}&config=${config}`;
}

export function vscodeInstallUrl(t: ShimTarget): string {
  const config = { name: SERVER_NAME, type: "stdio", ...serverConfig(t) };
  return `vscode:mcp/install?${encodeURIComponent(JSON.stringify(config))}`;
}

export const TOML_BEGIN = "# vAPI Desktop: begin (managed by vAPI Desktop; edit in the app)";
export const TOML_END = "# vAPI Desktop: end";

function tomlString(s: string): string {
  if (Array.from(s).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) {
    throw new Error("TOML strings cannot contain control characters");
  }
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function tomlBlock(t: ShimTarget): string {
  return [
    TOML_BEGIN,
    `[mcp_servers.${SERVER_NAME}]`,
    `command = ${tomlString(t.shimPath)}`,
    "args = []",
    "",
    `[mcp_servers.${SERVER_NAME}.env]`,
    `VAPI_DESKTOP_SOCKET = ${tomlString(t.socketPath)}`,
    `VAPI_DESKTOP_WALLET = ${tomlString(t.wallet)}`,
    TOML_END,
  ].join("\n");
}

export function mcpbManifest(t: { socketPath: string; wallet: string }): Record<string, unknown> {
  return {
    manifest_version: "0.3",
    name: "vapi-desktop",
    display_name: "vAPI Desktop",
    version: "0.2.0",
    description: `Lets Claude pay x402 APIs and post USDC bounties from the vAPI Desktop agent wallet ${t.wallet}. Keys stay in the app on this computer.`,
    author: { name: "Vertical Labs", url: "https://vapinetwork.ai" },
    server: {
      type: "node",
      entry_point: "dist/shim.js",
      mcp_config: {
        command: "node",
        args: ["${__dirname}/dist/shim.js"],
        env: {
          VAPI_DESKTOP_SOCKET: t.socketPath,
          VAPI_DESKTOP_WALLET: t.wallet,
        },
      },
    },
    compatibility: { platforms: ["darwin"], runtimes: { node: ">=20" } },
    keywords: ["x402", "usdc", "payments", "agent wallet", "vapi"],
    license: "Apache-2.0",
  };
}
