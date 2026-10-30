import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isWalletName } from "../../shared/wallet-name.js";
import { mcpbManifest } from "./install.js";

export type McpbRun = (file: string, args: string[]) => Promise<{ code: number; stderr: string }>;

const runProcess: McpbRun = (file, args) =>
  new Promise((resolve) => {
    execFile(file, args, (error, _stdout, stderr) => {
      resolve({
        code: error ? (typeof error.code === "number" ? error.code : 1) : 0,
        stderr: stderr || error?.message || "",
      });
    });
  });

/** Build a macOS Claude Desktop extension containing the Node shim for one wallet. */
export async function buildMcpb(input: {
  shimJsPath: string;
  socketPath: string;
  wallet: string;
  outDir: string;
  run?: McpbRun;
}): Promise<string> {
  if (!isWalletName(input.wallet)) {
    throw new Error("Invalid wallet name");
  }
  const out = join(input.outDir, `vapi-desktop-${input.wallet}.mcpb`);
  const temporary = out + ".tmp";
  const stage = await mkdtemp(join(tmpdir(), "vapi-mcpb-"));
  try {
    await mkdir(join(stage, "dist"));
    await writeFile(join(stage, "manifest.json"), JSON.stringify(mcpbManifest(input), null, 2));
    await copyFile(input.shimJsPath, join(stage, "dist/shim.js"));
    await mkdir(input.outDir, { recursive: true, mode: 0o700 });
    const result = await (input.run ?? runProcess)("/usr/bin/ditto", [
      "-c",
      "-k",
      "--norsrc",
      stage,
      temporary,
    ]);
    if (result.code !== 0)
      throw new Error(`Could not build the extension: ${result.stderr.trim()}`);
    await rename(temporary, out);
    return out;
  } finally {
    await rm(stage, { recursive: true, force: true });
    await rm(temporary, { force: true });
  }
}
