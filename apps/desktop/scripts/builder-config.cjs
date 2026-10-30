// Signing and notarization switch on only when their env vars are present (RELEASE.md).
function builderConfig(env = process.env) {
  const signed = Boolean(env.CSC_LINK);
  return {
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
      identity: signed ? undefined : null,
      notarize: Boolean(
        signed && env.APPLE_ID && env.APPLE_APP_SPECIFIC_PASSWORD && env.APPLE_TEAM_ID,
      ),
    },
    publish: [
      { provider: "github", owner: "vAPI-Network", repo: "vapi-network", releaseType: "draft" },
    ],
    afterPack: "scripts/after-pack.cjs",
  };
}

module.exports = { builderConfig };
