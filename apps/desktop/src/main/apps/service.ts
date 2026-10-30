import { constants } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname } from "node:path";

import {
  APP_LABELS,
  type AppStatus,
  type ConnectableAppId,
  type ConnectResult,
} from "../../shared/apps.js";
import { detectApps, type AppPaths } from "./detect.js";
import { cursorInstallUrl, tomlBlock, vscodeInstallUrl } from "./install.js";
import { buildMcpb, type McpbRun } from "./mcpb.js";
import { readTomlEntry, writeTomlEntry } from "./toml-block.js";

export type AppsDeps = {
  paths: AppPaths;
  shimPath: string;
  shimJsPath: string;
  socketPath: string;
  mcpbDir: string;
  open: (target: string) => Promise<string>;
  run?: McpbRun;
};

export function appStatuses(deps: AppsDeps): Promise<AppStatus[]> {
  return detectApps(deps.paths);
}

/** The exact TOML block shown before connecting an app that needs a config write. */
export function appSnippet(deps: AppsDeps, id: ConnectableAppId, wallet: string): string | null {
  return id === "codex" || id === "grok-cli"
    ? tomlBlock({ shimPath: deps.shimPath, socketPath: deps.socketPath, wallet })
    : null;
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

async function writeConfig(path: string, block: string): Promise<ConnectResult> {
  // Dotfile managers symlink these files; write the target so the link survives the rename.
  const link = await lstat(path).catch(() => undefined);
  const file = link?.isSymbolicLink() ? await realpath(path) : path;
  let original = "";
  let exists = false;
  let mode = 0o600;
  try {
    original = await readFile(file, "utf8");
    mode = (await stat(file)).mode & 0o777;
    exists = true;
  } catch (error) {
    if (!hasCode(error, "ENOENT")) throw error;
  }
  const entry = readTomlEntry(original);
  if (entry.state === "conflict") {
    return {
      ok: false,
      message: `A vapi server is already set up in ${path}. Remove it or edit it by hand.`,
    };
  }
  const text = writeTomlEntry(original, block);
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const backupPath = file + ".vapi-backup";
  if (exists && entry.state !== "ours") {
    try {
      await copyFile(file, backupPath, constants.COPYFILE_EXCL);
    } catch (error) {
      if (!hasCode(error, "EEXIST")) throw error;
    }
  }
  let backup: string | null = null;
  try {
    await stat(backupPath);
    backup = backupPath;
  } catch (error) {
    if (!hasCode(error, "ENOENT")) throw error;
  }
  const temporary = file + ".tmp";
  try {
    await writeFile(temporary, text, { mode });
    await chmod(temporary, mode);
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
  return { ok: true, kind: "written", path, backup };
}

export async function connectApp(
  deps: AppsDeps,
  id: ConnectableAppId,
  wallet: string,
): Promise<ConnectResult> {
  try {
    const target = { shimPath: deps.shimPath, socketPath: deps.socketPath, wallet };
    switch (id) {
      case "claude-desktop": {
        const path = await buildMcpb({
          shimJsPath: deps.shimJsPath,
          socketPath: deps.socketPath,
          wallet,
          outDir: deps.mcpbDir,
          run: deps.run,
        });
        const error = await deps.open(path);
        return error
          ? { ok: false, message: `Claude Desktop did not open the extension: ${error}` }
          : { ok: true, kind: "opened" };
      }
      case "cursor":
      case "vscode": {
        const error = await deps.open(
          id === "cursor" ? cursorInstallUrl(target) : vscodeInstallUrl(target),
        );
        return error
          ? { ok: false, message: `${APP_LABELS[id]} did not open. Is it installed?` }
          : { ok: true, kind: "opened" };
      }
      case "codex":
      case "grok-cli":
        return await writeConfig(
          id === "codex" ? deps.paths.codex : deps.paths.grokCli,
          tomlBlock(target),
        );
    }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}
