import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { english } from "viem/accounts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createCrashLog, scrub } from "./crash-log.js";

const home = "/Users/zep";

describe("crash report scrubbing", () => {
  it("shortens the home path and removes other absolute paths", () => {
    expect(scrub("at /Users/zep/project/file.ts:12:3", home)).toBe("at ~/project/file.ts:12:3");
    expect(scrub("open /private/var/folders/report and /Applications/app/main.js", home)).toBe(
      "open <path> and <path>",
    );
  });

  it("removes file URLs and quoted paths with spaces from stack traces", () => {
    expect(scrub("at file:///Applications/Other.app/main.js:10:2", home)).toBe("at <path>:10:2");
    expect(scrub('open "/private/var/a private folder/report.json"', home)).toBe('open "<path>"');
  });

  it("removes addresses and long hex strings", () => {
    expect(scrub(`wallet 0x${"ab".repeat(20)}`, home)).toBe("wallet <address>");
    expect(scrub(`key 0x${"cd".repeat(32)} signature 0x${"ef".repeat(65)}`, home)).toBe(
      "key <hex> signature <hex>",
    );
    expect(scrub("wallet 11111111111111111111111111111111", home)).toBe("wallet <address>");
    expect(scrub("wallet 9xQeWvG816bUx9EPjHmaT23yvVMkD8bXU2uZpQfM7zKo", home)).toBe(
      "wallet <address>",
    );
  });

  it("removes bearer tokens, JWTs and vAPI tokens", () => {
    expect(scrub("Authorization: Bearer xyz", home)).toBe("Authorization: <token>");
    expect(scrub("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.signature", home)).toBe("<token>");
    expect(scrub("link vapi_abc123XYZ", home)).toBe("link <token>");
  });

  it("removes consecutive English recovery words, including mixed case and line breaks", () => {
    const words = english.slice(0, 5).join(" ");
    expect(scrub(`phrase: ${words}`, home)).toBe("phrase: <words>");
    expect(scrub("ABANDON ability\nable about", home)).toBe("<words>");
    expect(scrub("words abandon, ability, able, about xyz", home)).toBe("words <words> xyz");
    expect(scrub("abandon ability able", home)).toBe("abandon ability able");
  });

  it("leaves ordinary diagnostic sentences unchanged", () => {
    expect(scrub("Signer not started.", home)).toBe("Signer not started.");
  });
});

describe("local crash reports", () => {
  let root: string;
  let dir: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "desktop-crashes-"));
    dir = join(root, "crash-reports");
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function log(enabled: () => boolean, maxEntries?: number) {
    return createCrashLog({
      dir,
      home,
      version: "0.1.0",
      enabled,
      maxEntries,
      now: () => new Date("2026-10-28T12:00:00Z"),
    });
  }

  async function reports() {
    return (await readFile(join(dir, "crash-reports.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
  }

  it("writes nothing until enabled and stops when disabled", async () => {
    let enabled = false;
    const crashLog = log(() => enabled);
    await crashLog.record("main-exception", new Error("disabled"));
    expect(await readdir(root)).toEqual([]);
    enabled = true;
    await crashLog.record("main-rejection", "Signer not started.");
    enabled = false;
    await crashLog.record("main-rejection", "disabled again");
    expect(await reports()).toEqual([
      {
        at: "2026-10-28T12:00:00.000Z",
        kind: "main-rejection",
        version: "0.1.0",
        detail: "Signer not started.",
      },
    ]);
  });

  it("does not queue reports made while disabled for a later opt-in", async () => {
    let enabled = false;
    const crashLog = log(() => enabled);
    const recorded = crashLog.record("main-rejection", "before consent");
    enabled = true;
    await recorded;
    expect(await readdir(root)).toEqual([]);
  });

  it("scrubs Error name, message and stack and drops attached request bodies", async () => {
    const error = Object.assign(new Error("wallet 0x" + "ab".repeat(20)), {
      name: "vapi_secret123",
      stack: "at /private/var/app.js:1:2 with Bearer xyz",
      request: { body: "never save this request" },
    });
    await log(() => true).record("main-exception", error);
    expect(await reports()).toEqual([
      {
        at: "2026-10-28T12:00:00.000Z",
        kind: "main-exception",
        version: "0.1.0",
        detail: {
          name: "<token>",
          message: "wallet <address>",
          stack: "at <path>:1:2 with <token>",
        },
      },
    ]);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    expect((await stat(join(dir, "crash-reports.jsonl"))).mode & 0o777).toBe(0o600);
  });

  it("keeps only exit codes and scrubbed reasons from process-gone details", async () => {
    await log(() => true).record("child-gone", {
      exitCode: 7,
      reason: "failed at /Applications/app/main.js",
      name: "private process name",
      request: "never save this request",
    });
    expect((await reports())[0].detail).toEqual({ exitCode: 7, reason: "failed at <path>" });
  });

  it("does not serialize arbitrary rejection objects", async () => {
    await log(() => true).record("main-rejection", { request: "private body" });
    expect(JSON.stringify(await reports())).not.toContain("private body");
  });

  it("keeps the newest entries when writes overlap and after restarting", async () => {
    const crashLog = log(() => true, 2);
    await Promise.all([1, 2, 3].map((exitCode) => crashLog.record("signer-exit", { exitCode })));
    expect((await reports()).map((entry) => entry.detail.exitCode)).toEqual([2, 3]);
    await log(() => true, 2).record("mcp-host-exit", { exitCode: 4 });
    expect((await reports()).map((entry) => entry.detail.exitCode)).toEqual([3, 4]);
  });

  it("defaults to keeping the newest 200 entries", async () => {
    const crashLog = log(() => true);
    await Promise.all(
      Array.from({ length: 202 }, (_, exitCode) => crashLog.record("signer-exit", { exitCode })),
    );
    const entries = await reports();
    expect(entries).toHaveLength(200);
    expect(entries[0].detail.exitCode).toBe(2);
    expect(entries[199].detail.exitCode).toBe(201);
  });

  it("survives an unwritable reports directory", async () => {
    await writeFile(dir, "not a directory");
    await expect(
      log(() => true).record("main-exception", new Error("failed")),
    ).resolves.toBeUndefined();
  });
});
