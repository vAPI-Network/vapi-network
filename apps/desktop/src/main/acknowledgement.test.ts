import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CUSTODY_TERMS } from "../shared/custody.js";
import { readAcknowledgement, recordAcknowledgement } from "./acknowledgement.js";

describe("custody acknowledgement", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ack-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("stores main's own copy of the accepted sentences, owner-only", async () => {
    const path = join(dir, "custody.json");
    await recordAcknowledgement(path, CUSTODY_TERMS.version, new Date("2026-10-26T14:00:00Z"));
    const stored = JSON.parse(await readFile(path, "utf8"));
    expect(stored).toEqual({
      version: CUSTODY_TERMS.version,
      statements: [...CUSTODY_TERMS.statements],
      acceptedAt: "2026-10-26T14:00:00.000Z",
    });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await readAcknowledgement(path)).toMatchObject({ version: CUSTODY_TERMS.version });
  });

  it("refuses a version the app does not show and reads a missing file as not accepted", async () => {
    const path = join(dir, "custody.json");
    await expect(recordAcknowledgement(path, "custody-1999")).rejects.toThrow("out of date");
    expect(await readAcknowledgement(path)).toBeUndefined();
  });
});
