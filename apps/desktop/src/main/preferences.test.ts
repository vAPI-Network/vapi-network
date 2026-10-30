import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readPreferences, writePreferences } from "./preferences.js";

describe("desktop preferences", () => {
  let dir: string;
  let path: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "desktop-prefs-"));
    path = join(dir, "preferences.json");
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("keeps crash reports off when preferences are missing", async () => {
    expect(await readPreferences(path)).toEqual({ crashReports: false });
  });

  it.each(["garbage", "null", "{}", '{"crashReports":"true"}'])(
    "keeps crash reports off for invalid preferences: %s",
    async (contents) => {
      await writeFile(path, contents);
      expect(await readPreferences(path)).toEqual({ crashReports: false });
    },
  );

  it("persists the user's choice in an owner-only file, including replacements", async () => {
    await writeFile(path, "{}", { mode: 0o644 });
    await writePreferences(path, { crashReports: true });
    expect(await readPreferences(path)).toEqual({ crashReports: true });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    await writePreferences(path, { crashReports: false });
    expect(await readPreferences(path)).toEqual({ crashReports: false });
  });

  it("rejects invalid writes without replacing the saved choice", async () => {
    await writePreferences(path, { crashReports: true });
    // Renderer input remains untrusted at runtime.
    // @ts-expect-error Exercise validation beyond the TypeScript boundary.
    await expect(writePreferences(path, { crashReports: "yes" })).rejects.toThrow();
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ crashReports: true });
  });
});
