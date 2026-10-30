import { execFileSync } from "node:child_process";
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyFuses } from "./fuses.cjs";

const appPath = process.argv[2]
  ? resolve(process.argv[2])
  : resolve(dirname(fileURLToPath(import.meta.url)), "../release/mac-arm64/vAPI Desktop.app");
const problems = [];

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

try {
  problems.push(...(await verifyFuses(appPath)));
} catch (error) {
  problems.push(`Electron fuses: ${errorText(error)}`);
}

try {
  execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", appPath], { stdio: "pipe" });
} catch (error) {
  problems.push(`Code signature: ${errorText(error)}`);
}

for (const helper of ["vapi-mcp-shim", "vapi-keychain", "mcp-shim/shim.js"]) {
  const path = join(appPath, "Contents/Resources", helper);
  try {
    if (!(await stat(path)).isFile()) throw new Error("not a file");
    await access(path, helper.endsWith(".js") ? constants.F_OK : constants.X_OK);
  } catch (error) {
    problems.push(`${helper}: ${errorText(error)}`);
  }
}

// Electron runs on macOS 13; a helper built for the build Mac's newer macOS would not start on testers' Macs.
const MIN_MACOS = 13;
for (const binary of ["MacOS/vAPI Desktop", "Resources/vapi-mcp-shim", "Resources/vapi-keychain"]) {
  try {
    const loadCommands = execFileSync("/usr/bin/otool", ["-l", join(appPath, "Contents", binary)], {
      encoding: "utf8",
      stdio: "pipe",
    });
    const minos = Number(loadCommands.match(/minos (\d+)/)?.[1]);
    if (!(minos <= MIN_MACOS)) {
      problems.push(`${binary}: needs macOS ${minos || "unknown"}, expected ${MIN_MACOS} or older`);
    }
  } catch (error) {
    problems.push(`${binary}: ${errorText(error)}`);
  }
}

try {
  const identifier = execFileSync(
    "/usr/bin/plutil",
    ["-extract", "CFBundleIdentifier", "raw", join(appPath, "Contents/Info.plist")],
    { encoding: "utf8", stdio: "pipe" },
  ).trim();
  if (identifier !== "ai.vapinetwork.desktop") {
    problems.push(`CFBundleIdentifier: expected ai.vapinetwork.desktop, got ${identifier}`);
  }
} catch (error) {
  problems.push(`CFBundleIdentifier: ${errorText(error)}`);
}

if (problems.length) {
  for (const problem of problems) console.error(problem);
  process.exitCode = 1;
} else {
  console.log("packaged app OK");
}
