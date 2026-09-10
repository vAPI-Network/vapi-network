import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { readSpendLedger, reserveSpend, SpendCapError } from "./spend-policy.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("spend caps", () => {
  it("enforces per-call and aggregate per-day atomic caps", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vapi-mcp-ledger-"));
    temporaryDirectories.push(directory);
    const ledgerPath = join(directory, "ledger.json");
    const caps = { perCallAtomic: "10", perDayAtomic: "15" };
    const now = new Date("2026-08-05T23:59:00.000Z");

    await expect(reserveSpend(11n, caps, { ledgerPath, now })).rejects.toMatchObject({
      code: "per_call_cap_exceeded",
    } satisfies Partial<SpendCapError>);
    expect(await reserveSpend(10n, caps, { ledgerPath, now })).toEqual({
      date: "2026-08-05",
      spentAtomic: "10",
    });
    await expect(reserveSpend(6n, caps, { ledgerPath, now })).rejects.toMatchObject({
      code: "per_day_cap_exceeded",
    } satisfies Partial<SpendCapError>);
    expect(await readSpendLedger(ledgerPath, now)).toEqual({
      date: "2026-08-05",
      spentAtomic: "10",
    });
  });

  it("rolls the ledger over on the next UTC day", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vapi-mcp-ledger-"));
    temporaryDirectories.push(directory);
    const ledgerPath = join(directory, "ledger.json");
    const caps = { perCallAtomic: "10", perDayAtomic: "10" };

    await reserveSpend(10n, caps, {
      ledgerPath,
      now: new Date("2026-08-05T23:59:59.000Z"),
    });
    expect(
      await reserveSpend(6n, caps, {
        ledgerPath,
        now: new Date("2026-08-06T00:00:00.000Z"),
      }),
    ).toEqual({ date: "2026-08-06", spentAtomic: "6" });
  });
});
