import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FuseV1Options } from "@electron/fuses";
import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { FUSES, verifyFuses } = require("../../scripts/fuses.cjs") as {
  FUSES: Record<number, boolean>;
  verifyFuses(appPath: string): Promise<string[]>;
};

describe("packaged Electron fuses", () => {
  let dir: string | undefined;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  async function appWithFuses(wire: string) {
    dir = await mkdtemp(join(tmpdir(), "desktop-fuses-"));
    const appPath = join(dir, "vAPI Desktop.app");
    const framework = join(appPath, "Contents/Frameworks/Electron Framework.framework");
    await mkdir(framework, { recursive: true });
    await writeFile(
      join(framework, "Electron Framework"),
      Buffer.concat([
        Buffer.from("dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX"),
        Buffer.from([1, wire.length]),
        Buffer.from(wire),
      ]),
    );
    return appPath;
  }

  it("sets exactly the six required security fuses", () => {
    expect(FUSES).toEqual({
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.EnableCookieEncryption]: true,
    });
  });

  it("accepts an app whose fuse wire matches the policy", async () => {
    expect(await verifyFuses(await appWithFuses("010011"))).toEqual([]);
  });

  it("reports every mismatched fuse by name", async () => {
    const problems = await verifyFuses(await appWithFuses("101100"));
    expect(problems).toHaveLength(6);
    for (const name of [
      "RunAsNode",
      "EnableCookieEncryption",
      "EnableNodeOptionsEnvironmentVariable",
      "EnableNodeCliInspectArguments",
      "EnableEmbeddedAsarIntegrityValidation",
      "OnlyLoadAppFromAsar",
    ]) {
      expect(problems.some((problem) => problem.includes(name))).toBe(true);
    }
  });

  it("refuses removed or missing required fuses", async () => {
    const problems = await verifyFuses(await appWithFuses("r1001"));
    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain("RunAsNode");
    expect(problems[1]).toContain("OnlyLoadAppFromAsar");
  });
});
