import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { appendAudit, auditLogPath, readAuditLog } from "./audit.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryHome(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return join(directory, "home");
}

describe("appendAudit", () => {
  it("writes one JSON line per event, oldest first", async () => {
    const home = await temporaryHome("vapi-audit-lines-");
    const clock = () => new Date("2026-09-19T10:11:12.000Z");

    await appendAudit(home, { event: "wallet.create", wallet: "main", tty: true }, { now: clock });
    await appendAudit(
      home,
      { event: "secret.export.phrase", wallet: "main", tty: false, agentMarker: "CI" },
      { now: clock },
    );

    expect(await readAuditLog(home)).toEqual([
      { time: "2026-09-19T10:11:12.000Z", event: "wallet.create", wallet: "main", tty: true },
      {
        time: "2026-09-19T10:11:12.000Z",
        event: "secret.export.phrase",
        wallet: "main",
        tty: false,
        agentMarker: "CI",
      },
    ]);
    const raw = await readFile(auditLogPath(home), "utf8");
    expect(raw.split("\n").filter(Boolean)).toHaveLength(2);
    expect(raw.endsWith("\n")).toBe(true);
  });

  it("creates the home 0700 and the log 0600", async () => {
    const home = await temporaryHome("vapi-audit-modes-");

    await appendAudit(home, { event: "wallet.default", wallet: "agent", tty: true });

    expect((await stat(home)).mode & 0o777).toBe(0o700);
    expect((await stat(auditLogPath(home))).mode & 0o777).toBe(0o600);
  });

  it("omits the fields that were not supplied", async () => {
    const home = await temporaryHome("vapi-audit-optional-");

    const entry = await appendAudit(home, { event: "passphrase.change", tty: true });

    expect(Object.keys(entry).sort()).toEqual(["event", "time", "tty"]);
  });

  it("reads an absent log as empty", async () => {
    expect(await readAuditLog(await temporaryHome("vapi-audit-absent-"))).toEqual([]);
  });

  it("keeps a detail note but never any key material", async () => {
    const home = await temporaryHome("vapi-audit-detail-");

    await appendAudit(home, {
      event: "secret.export.key",
      wallet: "main",
      tty: false,
      agentMarker: "CLAUDECODE",
      detail: "refused: CLAUDECODE is set.",
    });

    const raw = await readFile(auditLogPath(home), "utf8");
    expect(raw).toContain("refused: CLAUDECODE is set.");
    expect(raw).not.toMatch(/0x[0-9a-f]{64}/u);
  });
});
