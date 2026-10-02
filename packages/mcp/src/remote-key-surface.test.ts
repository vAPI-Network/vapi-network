import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const SOURCE_ROOT = fileURLToPath(new URL(".", import.meta.url));
const THIS_FILE = resolve(fileURLToPath(import.meta.url));

// Built by concatenation so this file does not name what it forbids.
const FORBIDDEN = [
  "export" + "MemberKey",
  "create" + "MemberBundle",
  "open" + "MemberBundle",
  "read" + "MemberCredentials",
  "export" + "VaultAccountKey",
  "core" + "/secrets",
] as const;

async function typeScriptFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return await typeScriptFiles(path);
      return entry.isFile() && entry.name.endsWith(".ts") ? [path] : [];
    }),
  );
  return files.flat();
}

describe("the MCP server's remote-key surface", () => {
  it("never references a function that exports a member key or bundle", async () => {
    const files = (await typeScriptFiles(SOURCE_ROOT)).filter(
      (path) => resolve(path) !== THIS_FILE,
    );
    expect(files.length).toBeGreaterThan(0);

    const hits: string[] = [];
    for (const path of files) {
      const source = await readFile(path, "utf8");
      for (const name of FORBIDDEN) {
        if (source.includes(name)) hits.push(`${path}: ${name}`);
      }
    }
    expect(hits).toEqual([]);
  });
});
