import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { mcpbManifest } from "./install.js";
import { buildMcpb } from "./mcpb.js";

const exec = promisify(execFile);

describe.skipIf(process.platform !== "darwin")("per-wallet MCP bundles", () => {
  let root: string;
  let input: { shimJsPath: string; socketPath: string; wallet: string; outDir: string };
  const shim = 'console.log("known Node shim");\n';

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "apps-mcpb-test-"));
    input = {
      shimJsPath: join(root, "shim.js"),
      socketPath: join(root, "mcp.sock"),
      wallet: "claude",
      outDir: join(root, "bundles"),
    };
    await writeFile(input.shimJsPath, shim);
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("packages exactly the manifest and Node shim at the wallet's bundle path", async () => {
    const path = await buildMcpb(input);
    expect(path).toBe(join(input.outDir, "vapi-desktop-claude.mcpb"));
    const listing = (await exec("/usr/bin/unzip", ["-Z1", path])).stdout;
    expect(
      listing
        .trim()
        .split("\n")
        .filter((entry) => !entry.endsWith("/"))
        .sort(),
    ).toEqual(["dist/shim.js", "manifest.json"]);
    const manifest = (await exec("/usr/bin/unzip", ["-p", path, "manifest.json"])).stdout;
    expect(JSON.parse(manifest)).toEqual(mcpbManifest(input));
    expect((await exec("/usr/bin/unzip", ["-p", path, "dist/shim.js"])).stdout).toBe(shim);
  });

  it("overwrites the same wallet's bundle on a second build", async () => {
    const path = await buildMcpb(input);
    const first = await readFile(path);
    const nextShim = 'console.log("replacement shim");\n';
    await writeFile(input.shimJsPath, nextShim);
    expect(await buildMcpb(input)).toBe(path);
    expect(await readFile(path)).not.toEqual(first);
    expect((await exec("/usr/bin/unzip", ["-p", path, "dist/shim.js"])).stdout).toBe(nextShim);
    expect(await readdir(input.outDir)).toEqual(["vapi-desktop-claude.mcpb"]);
  });

  it("cleans a failed build's staging and temporary archive while keeping the old bundle", async () => {
    const path = await buildMcpb(input);
    const original = await readFile(path);
    let stage: string | undefined;
    await expect(
      buildMcpb({
        ...input,
        run: async (_file, args) => {
          stage = args[3]!;
          await writeFile(args[4]!, "partial archive");
          return { code: 9, stderr: "archive failed" };
        },
      }),
    ).rejects.toThrow("archive failed");
    expect(stage).toBeDefined();
    await expect(stat(stage!)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(path + ".tmp")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(path)).toEqual(original);
  });

  it.each([
    "",
    "../escape",
    "/absolute",
    "UPPER",
    "-leading",
    "has space",
    "claude\n",
    "a".repeat(33),
  ])("rejects the unsafe wallet %j before touching disk", async (wallet) => {
    const run = vi.fn(async () => ({ code: 0, stderr: "" }));
    await expect(buildMcpb({ ...input, wallet, run })).rejects.toThrow(/wallet/i);
    expect(run).not.toHaveBeenCalled();
    expect(await readdir(root)).toEqual(["shim.js"]);
  });
});
