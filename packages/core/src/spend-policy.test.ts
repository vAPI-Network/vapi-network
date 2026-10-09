import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  escrowFundingDayRemainingAtomic,
  readSpendLedger,
  releaseSpend,
  reserveSpend,
  SpendCapError,
} from "./spend-policy.js";

const temporaryDirectories: string[] = [];

describe("read-only escrow funding headroom", () => {
  it("preserves ledger bytes and does not take the lock", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vapi-task-headroom-"));
    temporaryDirectories.push(directory);
    const ledgerPath = join(directory, "spend-ledger.json");
    const raw = JSON.stringify({
      version: 1,
      rows: [
        { date: "2026-10-08", wallet: "worker", spentAtomic: "8" },
        { date: "2026-10-08", wallet: "main", spentAtomic: "99" },
      ],
    });
    await writeFile(ledgerPath, raw);
    await writeFile(`${ledgerPath}.lock`, "held");
    const input = {
      caps: { perCallAtomic: "1", perDayAtomic: "10" },
      ledgerPath,
      now: new Date("2026-10-08T12:00:00Z"),
      wallet: "worker",
    };
    expect(await escrowFundingDayRemainingAtomic(input)).toBe(2n);
    expect(await escrowFundingDayRemainingAtomic({ ...input, wallet: "main" })).toBe(0n);
    expect(
      await escrowFundingDayRemainingAtomic({ ...input, now: new Date("2026-10-09T12:00:00Z") }),
    ).toBe(10n);
    expect(await readFile(ledgerPath, "utf8")).toBe(raw);
    expect(await readFile(`${ledgerPath}.lock`, "utf8")).toBe("held");
  });

  it("does not create an absent ledger or directory", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vapi-task-headroom-"));
    temporaryDirectories.push(directory);
    const ledgerPath = join(directory, "absent", "spend-ledger.json");
    expect(
      await escrowFundingDayRemainingAtomic({
        caps: { perCallAtomic: "1", perDayAtomic: "10" },
        ledgerPath,
        now: new Date("2026-10-08T12:00:00Z"),
        wallet: "main",
      }),
    ).toBe(10n);
    await expect(stat(dirname(ledgerPath))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

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

describe("escrow funding spend caps", () => {
  const now = new Date("2026-08-05T12:00:00.000Z");
  const caps = { perCallAtomic: "10", perDayAtomic: "100" };

  async function ledgerPath(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "vapi-escrow-ledger-"));
    temporaryDirectories.push(directory);
    return join(directory, "home", "spend-ledger.json");
  }

  it.each([false, true])(
    "refuses over-task funding without changing ledger (existing: %s)",
    async (existing) => {
      const path = await ledgerPath();
      if (existing) await reserveSpend(5n, caps, { ledgerPath: path, now });
      const before = existing ? await readFile(path, "utf8") : undefined;

      await expect(
        reserveSpend(51n, caps, {
          ledgerPath: path,
          now,
          kind: "escrow-funding",
          maxPerTaskAtomic: 50n,
          reservationId: "refused",
        }),
      ).rejects.toMatchObject({
        name: "SpendCapError",
        code: "per_task_cap_exceeded",
        message: "Escrow funding 51 atomic USDC exceeds the per-task cap 50. Refusing to sign.",
      });
      if (existing) expect(await readFile(path, "utf8")).toBe(before);
      else {
        await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
        await expect(readFile(`${path}.lock`)).rejects.toMatchObject({ code: "ENOENT" });
        await expect(stat(dirname(path))).rejects.toMatchObject({ code: "ENOENT" });
      }
    },
  );

  it("accepts the exact task cap above the per-call cap", async () => {
    const path = await ledgerPath();
    await expect(
      reserveSpend(50n, caps, {
        ledgerPath: path,
        now,
        kind: "escrow-funding",
        maxPerTaskAtomic: 50n,
      }),
    ).resolves.toEqual({ date: "2026-08-05", spentAtomic: "50" });
  });

  it("resumes only an exposed, valid prior-day escrow reservation", async () => {
    const path = await ledgerPath();
    await reserveSpend(100n, caps, {
      ledgerPath: path,
      now,
      kind: "escrow-funding",
      maxPerTaskAtomic: 100n,
    });
    const proof = {
      id: "prior",
      wallet: "main" as const,
      amountAtomic: "20",
      date: "2026-08-04",
    };
    const options = {
      ledgerPath: path,
      now,
      kind: "escrow-funding" as const,
      maxPerTaskAtomic: 20n,
      reservationId: "prior",
    };
    await expect(
      reserveSpend(20n, caps, { ...options, resumeEscrowReservation: proof }),
    ).rejects.toThrow("does not match");
    await expect(
      reserveSpend(20n, caps, {
        ...options,
        resumeEscrowReservation: { ...proof, exposed: true, invalidated: true },
      }),
    ).rejects.toThrow("does not match");
    await expect(
      reserveSpend(20n, caps, {
        ...options,
        resumeEscrowReservation: { ...proof, exposed: true },
      }),
    ).resolves.toMatchObject({ reservationReused: true, date: "2026-08-04" });
  });

  it("refuses escrow over the remaining daily budget without rewriting payment spend", async () => {
    const path = await ledgerPath();
    await reserveSpend(10n, caps, { ledgerPath: path, now, reservationId: "payment" });
    const before = await readFile(path, "utf8");
    await expect(
      reserveSpend(91n, caps, {
        ledgerPath: path,
        now,
        kind: "escrow-funding",
        maxPerTaskAtomic: 100n,
        reservationId: "refused",
      }),
    ).rejects.toMatchObject({
      code: "per_day_cap_exceeded",
      message:
        "Escrow funding 91 atomic USDC would raise today's spend to 101 for wallet main, above the per-day cap 100. Refusing to sign.",
    });
    expect(await readFile(path, "utf8")).toBe(before);
  });

  it("shares the daily total with payments and keeps other wallets isolated", async () => {
    const path = await ledgerPath();
    await reserveSpend(90n, caps, {
      ledgerPath: path,
      now,
      kind: "escrow-funding",
      maxPerTaskAtomic: 100n,
    });
    await reserveSpend(10n, caps, { ledgerPath: path, now, kind: "payment" });
    const before = await readFile(path, "utf8");
    await expect(reserveSpend(1n, caps, { ledgerPath: path, now })).rejects.toMatchObject({
      code: "per_day_cap_exceeded",
      message:
        "Payment quote 1 atomic USDC would raise today's spend to 101 for wallet main, above the per-day cap 100. Refusing to sign.",
    });
    expect(await readFile(path, "utf8")).toBe(before);
    await reserveSpend(100n, caps, {
      ledgerPath: path,
      now,
      wallet: "research",
      kind: "escrow-funding",
      maxPerTaskAtomic: 100n,
    });
    await expect(readSpendLedger(path, now)).resolves.toMatchObject({ spentAtomic: "100" });
    await expect(readSpendLedger(path, now, "research")).resolves.toMatchObject({
      spentAtomic: "100",
    });
  });

  it.each([undefined, -1n])(
    "rejects invalid task cap %s before touching the home",
    async (maxPerTaskAtomic) => {
      const path = await ledgerPath();
      await expect(
        reserveSpend(1n, caps, {
          ledgerPath: path,
          now,
          kind: "escrow-funding",
          maxPerTaskAtomic,
        }),
      ).rejects.toSatisfy(
        (error: unknown) => error instanceof Error && !(error instanceof SpendCapError),
      );
      await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(stat(dirname(path))).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("stores escrow kind, preserves it on unrelated writes, and releases once by id and amount", async () => {
    const path = await ledgerPath();
    for (const id of ["escrow-one", "escrow-two"]) {
      await reserveSpend(20n, caps, {
        ledgerPath: path,
        now,
        kind: "escrow-funding",
        maxPerTaskAtomic: 20n,
        reservationId: id,
      });
    }
    await reserveSpend(5n, caps, { ledgerPath: path, now, reservationId: "payment" });
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      date: "2026-08-05",
      spentAtomic: "45",
      reservations: [
        { id: "escrow-one", amountAtomic: "20", kind: "escrow-funding" },
        { id: "escrow-two", amountAtomic: "20", kind: "escrow-funding" },
        { id: "payment", amountAtomic: "5" },
      ],
    });
    await releaseSpend(5n, {
      ledgerPath: path,
      now,
      reservedOn: "2026-08-05",
      reservationId: "payment",
    });
    const releaseOptions = {
      ledgerPath: path,
      now,
      reservedOn: "2026-08-05",
      reservationId: "escrow-one",
    };
    await expect(releaseSpend(20n, releaseOptions)).resolves.toMatchObject({ spentAtomic: "20" });
    const before = await readFile(path, "utf8");
    expect(JSON.parse(before).reservations).toEqual([
      { id: "escrow-two", amountAtomic: "20", kind: "escrow-funding" },
    ]);
    await releaseSpend(20n, releaseOptions);
    expect(await readFile(path, "utf8")).toBe(before);
  });

  it.each([undefined, "payment"] as const)(
    "preserves payment defaults and legacy reservations (kind: %s)",
    async (kind) => {
      const path = await ledgerPath();
      await expect(reserveSpend(11n, caps, { ledgerPath: path, now, kind })).rejects.toMatchObject({
        code: "per_call_cap_exceeded",
        message: "Payment quote 11 atomic USDC exceeds the per-call cap 10. Refusing to sign.",
      });
      await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
      await reserveSpend(10n, caps, { ledgerPath: path, now, kind, reservationId: "payment" });
      expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
        date: "2026-08-05",
        spentAtomic: "10",
        reservations: [{ id: "payment", amountAtomic: "10" }],
      });
    },
  );

  it("does not rewrite escrow reservations on duplicate id or mismatched release refusal", async () => {
    const path = await ledgerPath();
    const options = {
      ledgerPath: path,
      now,
      kind: "escrow-funding" as const,
      maxPerTaskAtomic: 50n,
      reservationId: "escrow",
    };
    await reserveSpend(20n, caps, options);
    const before = await readFile(path, "utf8");
    await expect(reserveSpend(20n, caps, options)).rejects.toThrow("already exists");
    expect(await readFile(path, "utf8")).toBe(before);
    await expect(releaseSpend(19n, { ...options, reservedOn: "2026-08-05" })).rejects.toThrow(
      "different amount",
    );
    expect(await readFile(path, "utf8")).toBe(before);
  });

  it("serializes concurrent escrow reservations against the same daily cap", async () => {
    const path = await ledgerPath();
    const results = await Promise.allSettled(
      ["one", "two"].map((reservationId) =>
        reserveSpend(60n, caps, {
          ledgerPath: path,
          now,
          kind: "escrow-funding",
          maxPerTaskAtomic: 60n,
          reservationId,
        }),
      ),
    );
    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(results.find(({ status }) => status === "rejected")).toMatchObject({
      reason: { code: "per_day_cap_exceeded" },
    });
    await expect(readSpendLedger(path, now)).resolves.toMatchObject({ spentAtomic: "60" });
    expect(JSON.parse(await readFile(path, "utf8")).reservations).toHaveLength(1);
  });
});
