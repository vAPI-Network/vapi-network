const { flipFuses, FuseVersion } = require("@electron/fuses");
const path = require("node:path");
const { FUSES, verifyFuses } = require("./fuses.cjs");

module.exports = async function afterPack(context) {
  const executable =
    context.electronPlatformName === "darwin"
      ? path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
      : path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.exe`);
  await flipFuses(executable, {
    version: FuseVersion.V1,
    ...FUSES,
    resetAdHocDarwinSignature: context.electronPlatformName === "darwin",
  });
  const problems = await verifyFuses(executable);
  if (problems.length)
    throw new Error(`Electron fuse verification failed:\n${problems.join("\n")}`);
};
