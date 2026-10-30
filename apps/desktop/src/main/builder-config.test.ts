import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { builderConfig } = require("../../scripts/builder-config.cjs");

describe("desktop release configuration", () => {
  it("keeps unsigned builds ad-hoc signed and skips notarization", () => {
    expect(builderConfig({}).mac).toMatchObject({ identity: null, notarize: false });
  });

  it("lets electron-builder select the supplied signing identity", () => {
    const config = builderConfig({ CSC_LINK: "certificate.p12" });
    expect(config.mac.identity).toBeUndefined();
    expect(config.mac.notarize).toBe(false);
  });

  const credentials = {
    CSC_LINK: "certificate.p12",
    CSC_KEY_PASSWORD: "test-password",
    APPLE_ID: "tester@example.com",
    APPLE_APP_SPECIFIC_PASSWORD: "test-app-password",
    APPLE_TEAM_ID: "TESTTEAM",
  };

  it("notarizes only with signing and all Apple credentials", () => {
    expect(builderConfig(credentials).mac.notarize).toBe(true);
    for (const key of ["CSC_LINK", "APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD", "APPLE_TEAM_ID"]) {
      expect(builderConfig({ ...credentials, [key]: "" }).mac.notarize).toBe(false);
    }
  });

  it("preserves the app identity, resources, and macOS hardening", () => {
    expect(builderConfig({})).toMatchObject({
      appId: "ai.vapinetwork.desktop",
      productName: "vAPI Desktop",
      artifactName: "vAPI-Desktop-${version}-${arch}.${ext}",
      directories: { output: "release" },
      files: ["out/**"],
      extraResources: [
        { from: "native/out/vapi-mcp-shim", to: "vapi-mcp-shim" },
        { from: "resources/mcp-shim/shim.js", to: "mcp-shim/shim.js" },
        { from: "native/out/vapi-keychain", to: "vapi-keychain" },
      ],
      mac: {
        icon: "resources/icon.icns",
        category: "public.app-category.finance",
        hardenedRuntime: true,
        entitlements: "native/entitlements.plist",
        entitlementsInherit: "native/entitlements.plist",
        target: [
          { target: "dmg", arch: ["arm64"] },
          { target: "zip", arch: ["arm64"] },
        ],
      },
      publish: [
        { provider: "github", owner: "vAPI-Network", repo: "vapi-network", releaseType: "draft" },
      ],
      afterPack: "scripts/after-pack.cjs",
    });
  });

  it("gives electron-builder only the config object", () => {
    const config = require("../../electron-builder.config.cjs");
    expect(Object.keys(config)).not.toContain("builderConfig");
    expect(config.appId).toBe("ai.vapinetwork.desktop");
  });
});
