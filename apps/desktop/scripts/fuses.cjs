const { FuseState, FuseVersion, FuseV1Options, getCurrentFuseWire } = require("@electron/fuses");

const FUSES = {
  [FuseV1Options.RunAsNode]: false,
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
  [FuseV1Options.EnableNodeCliInspectArguments]: false,
  [FuseV1Options.OnlyLoadAppFromAsar]: true,
  [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
  [FuseV1Options.EnableCookieEncryption]: true,
};

async function verifyFuses(appPath) {
  const wire = await getCurrentFuseWire(appPath);
  const problems = [];
  if (wire.version !== FuseVersion.V1) {
    problems.push(`Fuse version: expected ${FuseVersion.V1}, got ${wire.version}`);
  }
  for (const [option, enabled] of Object.entries(FUSES)) {
    const expected = enabled ? FuseState.ENABLE : FuseState.DISABLE;
    if (wire[option] !== expected) {
      problems.push(
        `${FuseV1Options[option]}: expected ${enabled ? "enabled" : "disabled"}, got ${FuseState[wire[option]] ?? "missing"}`,
      );
    }
  }
  return problems;
}

module.exports = { FUSES, verifyFuses };
