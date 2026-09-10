import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { getVapiPaths, migrateLegacyVapiHome } from "./config.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("vAPI config home", () => {
  it("uses VAPI_HOME and includes the local receipt and search ledgers", () => {
    vi.stubEnv("VAPI_HOME", "/tmp/vapi-home");
    expect(getVapiPaths()).toEqual({
      directory: "/tmp/vapi-home",
      config: "/tmp/vapi-home/config.json",
      keystore: "/tmp/vapi-home/keystore.json",
      receipts: "/tmp/vapi-home/receipts.jsonl",
      searches: "/tmp/vapi-home/searches.jsonl",
      ledger: "/tmp/vapi-home/spend-ledger.json",
    });
  });

  it("copies every missing stable legacy file without deleting or overwriting", async () => {
    const root = await mkdtemp(join(tmpdir(), "vapi-migrate-"));
    temporaryDirectories.push(root);
    const legacyDirectory = join(root, "legacy");
    const targetDirectory = join(root, "new");
    await mkdir(legacyDirectory);
    for (const filename of [
      "config.json",
      "keystore.json",
      "receipts.jsonl",
      "searches.jsonl",
      "spend-ledger.json",
    ]) {
      await writeFile(join(legacyDirectory, filename), `legacy ${filename}`);
    }
    await mkdir(targetDirectory);
    await writeFile(join(targetDirectory, "config.json"), "new config");
    const notice = vi.fn();

    const copied = await migrateLegacyVapiHome({ legacyDirectory, targetDirectory, notice });

    expect(copied).toEqual([
      join(targetDirectory, "keystore.json"),
      join(targetDirectory, "receipts.jsonl"),
      join(targetDirectory, "searches.jsonl"),
      join(targetDirectory, "spend-ledger.json"),
    ]);
    expect(await readFile(join(targetDirectory, "config.json"), "utf8")).toBe("new config");
    for (const filename of [
      "keystore.json",
      "receipts.jsonl",
      "searches.jsonl",
      "spend-ledger.json",
    ]) {
      expect(await readFile(join(legacyDirectory, filename), "utf8")).toBe(`legacy ${filename}`);
      expect(await readFile(join(targetDirectory, filename), "utf8")).toBe(`legacy ${filename}`);
    }
    expect(notice).toHaveBeenCalledOnce();
  });
});
