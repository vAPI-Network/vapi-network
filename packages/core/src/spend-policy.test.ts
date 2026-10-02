import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { readSpendLedger, releaseSpend, reserveSpend, SpendCapError } from "./spend-policy.js";

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

  it("release reduces the reserved amount", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vapi-release-ledger-"));
    temporaryDirectories.push(directory);
    const ledgerPath = join(directory, "ledger.json");
    const now = new Date("2026-08-05T12:00:00.000Z");
    const reservation = await reserveSpend(
      10n,
      { perCallAtomic: "100", perDayAtomic: "100" },
      { ledgerPath, now },
    );

    await expect(
      releaseSpend(4n, { ledgerPath, now, reservedOn: reservation.date }),
    ).resolves.toEqual({ date: "2026-08-05", spentAtomic: "6" });
  });

  it("release floors the wallet total at zero", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vapi-release-ledger-"));
    temporaryDirectories.push(directory);
    const ledgerPath = join(directory, "ledger.json");
    const now = new Date("2026-08-05T12:00:00.000Z");
    const reservation = await reserveSpend(
      5n,
      { perCallAtomic: "100", perDayAtomic: "100" },
      { ledgerPath, now },
    );

    await expect(
      releaseSpend(9n, { ledgerPath, now, reservedOn: reservation.date }),
    ).resolves.toEqual({ date: "2026-08-05", spentAtomic: "0" });
  });

  it("release is a no-op after the reservation's UTC day", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vapi-release-ledger-"));
    temporaryDirectories.push(directory);
    const ledgerPath = join(directory, "ledger.json");
    const reservedAt = new Date("2026-08-05T23:59:59.000Z");
    const reservation = await reserveSpend(
      5n,
      { perCallAtomic: "100", perDayAtomic: "100" },
      { ledgerPath, now: reservedAt },
    );
    const before = await readFile(ledgerPath, "utf8");

    await expect(
      releaseSpend(5n, {
        ledgerPath,
        now: new Date("2026-08-06T00:00:00.000Z"),
        reservedOn: reservation.date,
      }),
    ).resolves.toEqual({ date: "2026-08-06", spentAtomic: "0" });
    expect(await readFile(ledgerPath, "utf8")).toBe(before);
  });

  it("release leaves other wallets' rows untouched", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vapi-release-ledger-"));
    temporaryDirectories.push(directory);
    const ledgerPath = join(directory, "ledger.json");
    const now = new Date("2026-08-05T12:00:00.000Z");
    const caps = { perCallAtomic: "100", perDayAtomic: "100" };
    const reservation = await reserveSpend(10n, caps, {
      ledgerPath,
      now,
      wallet: "research",
    });
    await reserveSpend(20n, caps, { ledgerPath, now, wallet: "writer" });

    await releaseSpend(4n, {
      ledgerPath,
      now,
      wallet: "research",
      reservedOn: reservation.date,
    });

    await expect(readSpendLedger(ledgerPath, now, "research")).resolves.toMatchObject({
      spentAtomic: "6",
    });
    await expect(readSpendLedger(ledgerPath, now, "writer")).resolves.toMatchObject({
      spentAtomic: "20",
    });
  });

  it("reserve and release round-trip to the original ledger state", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vapi-release-ledger-"));
    temporaryDirectories.push(directory);
    const ledgerPath = join(directory, "ledger.json");
    const now = new Date("2026-08-05T12:00:00.000Z");
    const caps = { perCallAtomic: "100", perDayAtomic: "100" };
    await reserveSpend(3n, caps, { ledgerPath, now, wallet: "research" });
    const before = await readFile(ledgerPath, "utf8");

    const reservation = await reserveSpend(4n, caps, {
      ledgerPath,
      now,
      wallet: "research",
    });
    await releaseSpend(4n, {
      ledgerPath,
      now,
      wallet: "research",
      reservedOn: reservation.date,
    });

    expect(await readFile(ledgerPath, "utf8")).toBe(before);
  });

  it("releases a named reservation only once without erasing unrelated spend", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vapi-release-ledger-"));
    temporaryDirectories.push(directory);
    const ledgerPath = join(directory, "ledger.json");
    const now = new Date("2026-08-05T12:00:00.000Z");
    const caps = { perCallAtomic: "100", perDayAtomic: "100" };
    await reserveSpend(3n, caps, { ledgerPath, now, wallet: "research" });
    const reservation = await reserveSpend(2n, caps, {
      ledgerPath,
      now,
      wallet: "research",
      reservationId: "transfer-nonce",
    });

    await Promise.all([
      releaseSpend(2n, {
        ledgerPath,
        now,
        wallet: "research",
        reservedOn: reservation.date,
        reservationId: "transfer-nonce",
      }),
      releaseSpend(2n, {
        ledgerPath,
        now,
        wallet: "research",
        reservedOn: reservation.date,
        reservationId: "transfer-nonce",
      }),
    ]);

    await expect(readSpendLedger(ledgerPath, now, "research")).resolves.toEqual({
      date: "2026-08-05",
      spentAtomic: "3",
    });
  });
});
