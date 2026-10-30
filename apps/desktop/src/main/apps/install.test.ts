import { describe, expect, it } from "vitest";

import {
  SERVER_NAME,
  TOML_BEGIN,
  TOML_END,
  cursorInstallUrl,
  mcpbManifest,
  serverConfig,
  tomlBlock,
  vscodeInstallUrl,
} from "./install.js";

const target = {
  shimPath: "/Applications/vAPI Desktop.app/Contents/Resources/vapi-mcp-shim",
  socketPath: "/Users/me/Library/Application Support/vAPI Desktop/mcp.sock",
  wallet: "claude",
};

describe("serverConfig", () => {
  it("configures the native shim with the socket and paying wallet", () => {
    expect(SERVER_NAME).toBe("vapi");
    expect(serverConfig(target)).toEqual({
      command: "/Applications/vAPI Desktop.app/Contents/Resources/vapi-mcp-shim",
      args: [],
      env: {
        VAPI_DESKTOP_SOCKET: "/Users/me/Library/Application Support/vAPI Desktop/mcp.sock",
        VAPI_DESKTOP_WALLET: "claude",
      },
    });
  });
});

describe("cursorInstallUrl", () => {
  it("encodes the bare server config in the install link", () => {
    const url = cursorInstallUrl(target);
    expect(url).toMatch(/^cursor:\/\/anysphere\.cursor-deeplink\/mcp\/install\?name=vapi&config=/);
    const config = new URL(url).searchParams.get("config");
    expect(config).not.toBeNull();
    expect(Buffer.from(config!, "base64").toString("utf8")).toBe(
      JSON.stringify(serverConfig(target)),
    );
  });

  it("percent-encodes base64 punctuation so query parsing preserves it", () => {
    const punctuationTarget = {
      ...target,
      shimPath: "/Applications/vAPI Desktop.app/Contents/Resources/vapi-mcp-shim🦊",
    };
    const json = JSON.stringify(serverConfig(punctuationTarget));
    const base64 = Buffer.from(json, "utf8").toString("base64");
    expect(base64).toContain("+");
    expect(base64).toContain("=");

    const url = cursorInstallUrl(punctuationTarget);
    expect(url.split("config=")[1]).not.toMatch(/[+/=]/);
    const config = new URL(url).searchParams.get("config");
    expect(config).toBe(base64);
    expect(Buffer.from(config!, "base64").toString("utf8")).toBe(json);
  });
});

describe("vscodeInstallUrl", () => {
  it("uses VS Code's literal encoded stdio install format", () => {
    const url = vscodeInstallUrl(target);
    expect(url).toBe(
      "vscode:mcp/install?" +
        encodeURIComponent(
          JSON.stringify({ name: "vapi", type: "stdio", ...serverConfig(target) }),
        ),
    );
    expect(url).toBe(
      "vscode:mcp/install?%7B%22name%22%3A%22vapi%22%2C%22type%22%3A%22stdio%22%2C%22command%22%3A%22%2FApplications%2FvAPI%20Desktop.app%2FContents%2FResources%2Fvapi-mcp-shim%22%2C%22args%22%3A%5B%5D%2C%22env%22%3A%7B%22VAPI_DESKTOP_SOCKET%22%3A%22%2FUsers%2Fme%2FLibrary%2FApplication%20Support%2FvAPI%20Desktop%2Fmcp.sock%22%2C%22VAPI_DESKTOP_WALLET%22%3A%22claude%22%7D%7D",
    );
    expect(JSON.parse(decodeURIComponent(url.slice("vscode:mcp/install?".length)))).toEqual({
      name: "vapi",
      type: "stdio",
      command: "/Applications/vAPI Desktop.app/Contents/Resources/vapi-mcp-shim",
      args: [],
      env: {
        VAPI_DESKTOP_SOCKET: "/Users/me/Library/Application Support/vAPI Desktop/mcp.sock",
        VAPI_DESKTOP_WALLET: "claude",
      },
    });
  });
});

describe("tomlBlock", () => {
  it("produces the exact nine-line managed block without a trailing newline", () => {
    expect(TOML_BEGIN).toBe("# vAPI Desktop: begin (managed by vAPI Desktop; edit in the app)");
    expect(TOML_END).toBe("# vAPI Desktop: end");
    expect(tomlBlock(target)).toBe(`# vAPI Desktop: begin (managed by vAPI Desktop; edit in the app)
[mcp_servers.vapi]
command = "/Applications/vAPI Desktop.app/Contents/Resources/vapi-mcp-shim"
args = []

[mcp_servers.vapi.env]
VAPI_DESKTOP_SOCKET = "/Users/me/Library/Application Support/vAPI Desktop/mcp.sock"
VAPI_DESKTOP_WALLET = "claude"
# vAPI Desktop: end`);
  });

  it("escapes quotes and backslashes in TOML strings", () => {
    expect(
      tomlBlock({
        shimPath: String.raw`/Applications/vAPI "Desktop"\shim`,
        socketPath: String.raw`/Users/me/"Desktop"\mcp.sock`,
        wallet: String.raw`old"wallet\name`,
      }),
    ).toBe(String.raw`# vAPI Desktop: begin (managed by vAPI Desktop; edit in the app)
[mcp_servers.vapi]
command = "/Applications/vAPI \"Desktop\"\\shim"
args = []

[mcp_servers.vapi.env]
VAPI_DESKTOP_SOCKET = "/Users/me/\"Desktop\"\\mcp.sock"
VAPI_DESKTOP_WALLET = "old\"wallet\\name"
# vAPI Desktop: end`);
  });

  it.each(["shimPath", "socketPath", "wallet"] as const)(
    "rejects every ASCII control character in %s",
    (field) => {
      for (const code of [...Array.from({ length: 32 }, (_, index) => index), 127]) {
        expect(() =>
          tomlBlock({ ...target, [field]: `before${String.fromCharCode(code)}after` }),
        ).toThrow();
      }
    },
  );
});

describe("mcpbManifest", () => {
  it("builds the per-wallet Node bundle manifest Claude Desktop accepts", () => {
    expect(mcpbManifest(target)).toEqual({
      manifest_version: "0.3",
      name: "vapi-desktop",
      display_name: "vAPI Desktop",
      version: "0.2.0",
      description:
        "Lets Claude pay x402 APIs and post USDC bounties from the vAPI Desktop agent wallet claude. Keys stay in the app on this computer.",
      author: { name: "Vertical Labs", url: "https://vapinetwork.ai" },
      server: {
        type: "node",
        entry_point: "dist/shim.js",
        mcp_config: {
          command: "node",
          args: ["${__dirname}/dist/shim.js"],
          env: {
            VAPI_DESKTOP_SOCKET: "/Users/me/Library/Application Support/vAPI Desktop/mcp.sock",
            VAPI_DESKTOP_WALLET: "claude",
          },
        },
      },
      compatibility: { platforms: ["darwin"], runtimes: { node: ">=20" } },
      keywords: ["x402", "usdc", "payments", "agent wallet", "vapi"],
      license: "Apache-2.0",
    });
  });

  it("names the selected wallet in its description and environment", () => {
    expect(mcpbManifest({ socketPath: "/tmp/desktop.sock", wallet: "research" })).toMatchObject({
      description:
        "Lets Claude pay x402 APIs and post USDC bounties from the vAPI Desktop agent wallet research. Keys stay in the app on this computer.",
      server: {
        mcp_config: {
          env: { VAPI_DESKTOP_SOCKET: "/tmp/desktop.sock", VAPI_DESKTOP_WALLET: "research" },
        },
      },
    });
  });
});
