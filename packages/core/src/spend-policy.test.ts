import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  escrowFundingDayRemainingAtomic,
  readSpendLedger,
  releaseSpend,
  reserveSpend,
  SpendCapError,
  taskReservedAtomic,
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

describe("read-only task reservation totals", () => {
  it("sums every stored day by wallet and task without writing or taking the lock", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vapi-task-total-"));
    temporaryDirectories.push(directory);
    const ledgerPath = join(directory, "spend-ledger.json");
    const raw = JSON.stringify({
      version: 1,
      rows: [
        {
          date: "2026-10-07",
          wallet: "main",
          spentAtomic: "11",
          reservations: [
            { id: "old-T", amountAtomic: "7", kind: "escrow-funding", taskKey: "task:T" },
            { id: "old-U", amountAtomic: "4", kind: "escrow-funding", taskKey: "task:U" },
          ],
        },
        {
          date: "2026-10-08",
          wallet: "main",
          spentAtomic: "5",
          reservations: [
            { id: "today-T", amountAtomic: "5", kind: "dispute-fee", taskKey: "task:T" },
          ],
        },
        {
          date: "2026-10-06",
          wallet: "worker",
          spentAtomic: "13",
          reservations: [
            { id: "worker-T", amountAtomic: "13", kind: "escrow-funding", taskKey: "task:T" },
          ],
        },
        {
          date: "2026-10-05",
          wallet: "main",
          spentAtomic: "3",
          reservations: [{ id: "legacy", amountAtomic: "3", kind: "escrow-funding" }],
        },
      ],
    });
    await writeFile(ledgerPath, raw);
    await writeFile(`${ledgerPath}.lock`, "held");
    const input = {
      ledgerPath,
      wallet: "main" as const,
      taskKey: "task:T",
      now: new Date("2026-10-08T12:00:00Z"),
    };

    await expect(taskReservedAtomic(input)).resolves.toBe(12n);
    await expect(taskReservedAtomic({ ...input, excludeReservationId: "old-T" })).resolves.toBe(5n);
    await expect(taskReservedAtomic({ ...input, wallet: "worker" })).resolves.toBe(13n);
    await expect(taskReservedAtomic({ ...input, taskKey: "task:missing" })).resolves.toBe(0n);
    expect(await readFile(ledgerPath, "utf8")).toBe(raw);
    expect(await readFile(`${ledgerPath}.lock`, "utf8")).toBe("held");
  });

  it("returns zero without creating an absent ledger or directory", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vapi-task-total-"));
    temporaryDirectories.push(directory);
    const ledgerPath = join(directory, "absent", "spend-ledger.json");
    await expect(
      taskReservedAtomic({
        ledgerPath,
        wallet: "main",
        taskKey: "task:T",
        now: new Date("2026-10-08T12:00:00Z"),
      }),
    ).resolves.toBe(0n);
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

  it("caps one task cumulatively across funding and dispute fees without rewriting the ledger", async () => {
    const path = await ledgerPath();
    const taskOptions = { taskKey: "work-order:T" };
    await reserveSpend(
      100_000_000n,
      { perCallAtomic: "1", perDayAtomic: "500000000" },
      {
        ledgerPath: path,
        now,
        kind: "escrow-funding",
        maxPerTaskAtomic: 100_000_000n,
        reservationId: "fund-T",
        ...taskOptions,
      },
    );
    const before = await readFile(path, "utf8");

    await expect(
      reserveSpend(
        20_000_000n,
        { perCallAtomic: "1", perDayAtomic: "500000000" },
        {
          ledgerPath: path,
          now,
          kind: "dispute-fee",
          maxPerTaskAtomic: 100_000_000n,
          reservationId: "dispute-T",
          ...taskOptions,
        },
      ),
    ).rejects.toMatchObject({
      code: "per_task_cap_exceeded",
      message:
        "New spend 20000000 atomic USDC would raise the running total for task work-order:T and wallet main to 120000000, above the per-task cap 100000000. Refusing to sign.",
    });
    expect(await readFile(path, "utf8")).toBe(before);

    await expect(
      reserveSpend(
        20_000_000n,
        { perCallAtomic: "1", perDayAtomic: "500000000" },
        {
          ledgerPath: path,
          now,
          kind: "dispute-fee",
          maxPerTaskAtomic: 100_000_000n,
          reservationId: "dispute-U",
          taskKey: "work-order:U",
        },
      ),
    ).resolves.toMatchObject({ spentAtomic: "120000000" });
  });

  it("counts task reservations across UTC days, while isolating wallets and legacy rows", async () => {
    const path = await ledgerPath();
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        rows: [
          {
            date: "2026-08-04",
            wallet: "main",
            spentAtomic: "90000000",
            reservations: [
              {
                id: "prior-T",
                amountAtomic: "90000000",
                kind: "escrow-funding",
                taskKey: "work-order:T",
              },
            ],
          },
          {
            date: "2026-08-04",
            wallet: "research",
            spentAtomic: "100000000",
            reservations: [
              {
                id: "other-wallet-T",
                amountAtomic: "100000000",
                kind: "escrow-funding",
                taskKey: "work-order:T",
              },
            ],
          },
          {
            date: "2026-08-03",
            wallet: "main",
            spentAtomic: "7",
            reservations: [{ id: "legacy", amountAtomic: "7", kind: "escrow-funding" }],
          },
        ],
      }),
    );
    const before = await readFile(path, "utf8");
    await expect(
      reserveSpend(
        20_000_000n,
        { perCallAtomic: "1", perDayAtomic: "500000000" },
        {
          ledgerPath: path,
          now,
          wallet: "main",
          kind: "dispute-fee",
          maxPerTaskAtomic: 100_000_000n,
          reservationId: "today-T",
          taskKey: "work-order:T",
        },
      ),
    ).rejects.toMatchObject({ code: "per_task_cap_exceeded" });
    expect(await readFile(path, "utf8")).toBe(before);

    await expect(
      reserveSpend(
        20_000_000n,
        { perCallAtomic: "1", perDayAtomic: "500000000" },
        {
          ledgerPath: path,
          now,
          wallet: "writer",
          kind: "dispute-fee",
          maxPerTaskAtomic: 100_000_000n,
          reservationId: "writer-T",
          taskKey: "work-order:T",
        },
      ),
    ).resolves.toMatchObject({ spentAtomic: "20000000" });
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
      rows: expect.arrayContaining([
        expect.objectContaining({
          date: "2026-08-04",
          wallet: "main",
          reservations: [expect.objectContaining({ id: "prior-T", taskKey: "work-order:T" })],
        }),
      ]),
    });
  });

  it("reuses an exposed prior-day reservation without counting its task amount twice", async () => {
    const path = await ledgerPath();
    await mkdir(dirname(path), { recursive: true });
    const raw = JSON.stringify({
      date: "2026-08-04",
      spentAtomic: "100000000",
      reservations: [
        {
          id: "prior-T",
          amountAtomic: "100000000",
          kind: "escrow-funding",
          taskKey: "work-order:T",
        },
      ],
    });
    await writeFile(path, raw);
    await expect(
      reserveSpend(
        100_000_000n,
        { perCallAtomic: "1", perDayAtomic: "500000000" },
        {
          ledgerPath: path,
          now,
          kind: "escrow-funding",
          maxPerTaskAtomic: 100_000_000n,
          reservationId: "prior-T",
          taskKey: "work-order:T",
          resumeEscrowReservation: {
            id: "prior-T",
            wallet: "main",
            amountAtomic: "100000000",
            date: "2026-08-04",
            exposed: true,
          },
        },
      ),
    ).resolves.toMatchObject({ reservationReused: true, date: "2026-08-04" });
    expect(await readFile(path, "utf8")).toBe(raw);
  });

  it.each([
    { label: "same-day reuse", priorDate: "2026-08-05", resume: false },
    { label: "exposed prior-day resume", priorDate: "2026-08-04", resume: true },
  ])("binds a legacy reservation to its supplied task on $label", async ({ priorDate, resume }) => {
    const path = await ledgerPath();
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
      path,
      JSON.stringify({
        date: priorDate,
        spentAtomic: "100",
        reservations: [{ id: "legacy-fund", amountAtomic: "100", kind: "escrow-funding" }],
      }),
    );
    const reuseOptions = {
      ledgerPath: path,
      now,
      kind: "escrow-funding" as const,
      maxPerTaskAtomic: 100n,
      reservationId: "legacy-fund",
      taskKey: "work-order:T",
      ...(resume
        ? {
            resumeEscrowReservation: {
              id: "legacy-fund",
              wallet: "main" as const,
              amountAtomic: "100",
              date: priorDate,
              exposed: true,
            },
          }
        : { reuseExistingEscrowReservation: true }),
    };

    await expect(
      reserveSpend(100n, { perCallAtomic: "1", perDayAtomic: "500" }, reuseOptions),
    ).resolves.toMatchObject({ reservationReused: true });
    await expect(
      taskReservedAtomic({
        ledgerPath: path,
        wallet: "main",
        taskKey: "work-order:T",
        now,
      }),
    ).resolves.toBe(100n);
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
      reservations: [expect.objectContaining({ id: "legacy-fund", taskKey: "work-order:T" })],
    });

    const beforeRefusal = await readFile(path, "utf8");
    await expect(
      reserveSpend(
        20n,
        { perCallAtomic: "1", perDayAtomic: "500" },
        {
          ledgerPath: path,
          now,
          kind: "dispute-fee",
          maxPerTaskAtomic: 100n,
          reservationId: "dispute-T",
          taskKey: "work-order:T",
        },
      ),
    ).rejects.toMatchObject({ code: "per_task_cap_exceeded" });
    expect(await readFile(path, "utf8")).toBe(beforeRefusal);
  });

  it("persists task accounting for an exposed prior-day proof with no stored row", async () => {
    const path = await ledgerPath();
    await reserveSpend(
      10n,
      { perCallAtomic: "10", perDayAtomic: "500" },
      {
        ledgerPath: path,
        now,
        reservationId: "today-payment",
      },
    );

    await expect(
      reserveSpend(
        100n,
        { perCallAtomic: "1", perDayAtomic: "500" },
        {
          ledgerPath: path,
          now,
          kind: "escrow-funding",
          maxPerTaskAtomic: 100n,
          reservationId: "proof-only-fund",
          taskKey: "work-order:T",
          resumeEscrowReservation: {
            id: "proof-only-fund",
            wallet: "main",
            amountAtomic: "100",
            date: "2026-08-04",
            exposed: true,
          },
        },
      ),
    ).resolves.toMatchObject({
      reservationReused: true,
      date: "2026-08-04",
      spentAtomic: "10",
    });
    await expect(readSpendLedger(path, now)).resolves.toEqual({
      date: "2026-08-05",
      spentAtomic: "10",
    });
    await expect(
      taskReservedAtomic({
        ledgerPath: path,
        wallet: "main",
        taskKey: "work-order:T",
        now,
      }),
    ).resolves.toBe(100n);

    const beforeRefusal = await readFile(path, "utf8");
    await expect(
      reserveSpend(
        20n,
        { perCallAtomic: "1", perDayAtomic: "500" },
        {
          ledgerPath: path,
          now,
          kind: "dispute-fee",
          maxPerTaskAtomic: 100n,
          reservationId: "dispute-T",
          taskKey: "work-order:T",
        },
      ),
    ).rejects.toMatchObject({ code: "per_task_cap_exceeded" });
    expect(await readFile(path, "utf8")).toBe(beforeRefusal);
  });

  it("refuses to reuse a reservation for a different task without rewriting the ledger", async () => {
    const path = await ledgerPath();
    const caps = { perCallAtomic: "1", perDayAtomic: "500000000" };
    await reserveSpend(20n, caps, {
      ledgerPath: path,
      now,
      kind: "escrow-funding",
      maxPerTaskAtomic: 100n,
      reservationId: "fund-T",
      taskKey: "work-order:T",
    });
    const before = await readFile(path, "utf8");

    await expect(
      reserveSpend(20n, caps, {
        ledgerPath: path,
        now,
        kind: "escrow-funding",
        maxPerTaskAtomic: 100n,
        reservationId: "fund-T",
        taskKey: "work-order:U",
        reuseExistingEscrowReservation: true,
      }),
    ).rejects.toThrow("does not match");
    expect(await readFile(path, "utf8")).toBe(before);
  });

  it("refuses a prior-day resume whose stored reservation belongs to another task", async () => {
    const path = await ledgerPath();
    await mkdir(dirname(path), { recursive: true });
    const raw = JSON.stringify({
      date: "2026-08-04",
      spentAtomic: "20",
      reservations: [
        {
          id: "prior-T",
          amountAtomic: "20",
          kind: "escrow-funding",
          taskKey: "work-order:T",
        },
      ],
    });
    await writeFile(path, raw);
    await expect(
      reserveSpend(
        20n,
        { perCallAtomic: "1", perDayAtomic: "500000000" },
        {
          ledgerPath: path,
          now,
          kind: "escrow-funding",
          maxPerTaskAtomic: 100n,
          reservationId: "prior-T",
          taskKey: "work-order:U",
          resumeEscrowReservation: {
            id: "prior-T",
            wallet: "main",
            amountAtomic: "20",
            date: "2026-08-04",
            exposed: true,
          },
        },
      ),
    ).rejects.toThrow("does not match");
    expect(await readFile(path, "utf8")).toBe(raw);
  });

  it("does not double count a reused task reservation and stops counting it after release", async () => {
    const path = await ledgerPath();
    const options = {
      ledgerPath: path,
      now,
      kind: "escrow-funding" as const,
      maxPerTaskAtomic: 100_000_000n,
      reservationId: "fund-T",
      taskKey: "work-order:T",
    };
    await reserveSpend(100_000_000n, { perCallAtomic: "1", perDayAtomic: "500000000" }, options);
    await expect(
      reserveSpend(
        100_000_000n,
        { perCallAtomic: "1", perDayAtomic: "500000000" },
        {
          ...options,
          reuseExistingEscrowReservation: true,
        },
      ),
    ).resolves.toMatchObject({ reservationReused: true, spentAtomic: "100000000" });

    await releaseSpend(100_000_000n, {
      ledgerPath: path,
      now,
      reservedOn: "2026-08-05",
      reservationId: "fund-T",
    });
    await expect(
      reserveSpend(
        20_000_000n,
        { perCallAtomic: "1", perDayAtomic: "500000000" },
        {
          ledgerPath: path,
          now,
          kind: "dispute-fee",
          maxPerTaskAtomic: 100_000_000n,
          reservationId: "dispute-T",
          taskKey: "work-order:T",
        },
      ),
    ).resolves.toMatchObject({ spentAtomic: "20000000" });
  });

  it("serializes simultaneous reservations against the same task cap", async () => {
    const path = await ledgerPath();
    const results = await Promise.allSettled(
      ["one", "two"].map((reservationId) =>
        reserveSpend(
          60_000_000n,
          { perCallAtomic: "1", perDayAtomic: "500000000" },
          {
            ledgerPath: path,
            now,
            kind: "escrow-funding",
            maxPerTaskAtomic: 100_000_000n,
            reservationId,
            taskKey: "work-order:T",
          },
        ),
      ),
    );
    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(results.find(({ status }) => status === "rejected")).toMatchObject({
      reason: { code: "per_task_cap_exceeded" },
    });
  });

  it("accounts for sequential task reservations without optional reservation ids", async () => {
    const path = await ledgerPath();
    const options = {
      ledgerPath: path,
      now,
      kind: "escrow-funding" as const,
      maxPerTaskAtomic: 100n,
      taskKey: "work-order:T",
    };
    const reservation = await reserveSpend(
      60n,
      { perCallAtomic: "1", perDayAtomic: "500" },
      options,
    );
    expect(reservation).toMatchObject({
      date: "2026-08-05",
      spentAtomic: "60",
      reservationId: expect.any(String),
    });
    await expect(
      taskReservedAtomic({
        ledgerPath: path,
        wallet: "main",
        taskKey: "work-order:T",
        now,
      }),
    ).resolves.toBe(60n);
    const beforeRefusal = await readFile(path, "utf8");

    await expect(
      reserveSpend(60n, { perCallAtomic: "1", perDayAtomic: "500" }, options),
    ).rejects.toMatchObject({ code: "per_task_cap_exceeded" });
    expect(await readFile(path, "utf8")).toBe(beforeRefusal);

    const reservationId = "reservationId" in reservation ? reservation.reservationId : undefined;
    if (typeof reservationId !== "string") throw new Error("Expected a generated reservation id.");
    await releaseSpend(60n, {
      ledgerPath: path,
      now,
      reservedOn: reservation.date,
      reservationId,
    });
    await expect(
      taskReservedAtomic({
        ledgerPath: path,
        wallet: "main",
        taskKey: "work-order:T",
        now,
      }),
    ).resolves.toBe(0n);
  });

  it("serializes task reservations without optional reservation ids", async () => {
    const path = await ledgerPath();
    const results = await Promise.allSettled(
      Array.from({ length: 2 }, () =>
        reserveSpend(
          60n,
          { perCallAtomic: "1", perDayAtomic: "500" },
          {
            ledgerPath: path,
            now,
            kind: "escrow-funding",
            maxPerTaskAtomic: 100n,
            taskKey: "work-order:T",
          },
        ),
      ),
    );
    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(results.find(({ status }) => status === "rejected")).toMatchObject({
      reason: { code: "per_task_cap_exceeded" },
    });
    await expect(
      taskReservedAtomic({
        ledgerPath: path,
        wallet: "main",
        taskKey: "work-order:T",
        now,
      }),
    ).resolves.toBe(60n);
  });

  it("releases a matching historical task reservation once and preserves every other row", async () => {
    const path = await ledgerPath();
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        rows: [
          {
            date: "2026-08-04",
            wallet: "main",
            spentAtomic: "100",
            reservations: [
              {
                id: "failed-fund-T",
                amountAtomic: "60",
                kind: "escrow-funding",
                taskKey: "work-order:T",
              },
              {
                id: "unrelated-T",
                amountAtomic: "40",
                kind: "escrow-funding",
                taskKey: "work-order:T",
              },
            ],
          },
          {
            date: "2026-08-04",
            wallet: "research",
            spentAtomic: "70",
            reservations: [
              {
                id: "other-wallet",
                amountAtomic: "70",
                kind: "escrow-funding",
                taskKey: "work-order:T",
              },
            ],
          },
          {
            date: "2026-08-05",
            wallet: "main",
            spentAtomic: "10",
            reservations: [{ id: "today", amountAtomic: "10" }],
          },
        ],
      }),
    );
    const releaseOptions = {
      ledgerPath: path,
      now,
      wallet: "main" as const,
      reservedOn: "2026-08-04",
      reservationId: "failed-fund-T",
    };

    await expect(releaseSpend(60n, releaseOptions)).resolves.toEqual({
      date: "2026-08-05",
      spentAtomic: "10",
    });
    await expect(
      taskReservedAtomic({
        ledgerPath: path,
        wallet: "main",
        taskKey: "work-order:T",
        now,
      }),
    ).resolves.toBe(40n);
    const afterRelease = await readFile(path, "utf8");
    expect(JSON.parse(afterRelease)).toEqual({
      version: 1,
      rows: [
        {
          date: "2026-08-04",
          wallet: "main",
          spentAtomic: "40",
          reservations: [
            {
              id: "unrelated-T",
              amountAtomic: "40",
              kind: "escrow-funding",
              taskKey: "work-order:T",
            },
          ],
        },
        {
          date: "2026-08-05",
          spentAtomic: "10",
          wallet: "main",
          reservations: [{ id: "today", amountAtomic: "10" }],
        },
        {
          date: "2026-08-04",
          spentAtomic: "70",
          wallet: "research",
          reservations: [
            {
              id: "other-wallet",
              amountAtomic: "70",
              kind: "escrow-funding",
              taskKey: "work-order:T",
            },
          ],
        },
      ],
    });

    await releaseSpend(60n, releaseOptions);
    expect(await readFile(path, "utf8")).toBe(afterRelease);

    await expect(
      reserveSpend(
        60n,
        { perCallAtomic: "1", perDayAtomic: "500" },
        {
          ledgerPath: path,
          now,
          kind: "escrow-funding",
          maxPerTaskAtomic: 100n,
          reservationId: "next-milestone-T",
          taskKey: "work-order:T",
        },
      ),
    ).resolves.toMatchObject({ date: "2026-08-05", spentAtomic: "70" });
    await expect(
      taskReservedAtomic({
        ledgerPath: path,
        wallet: "main",
        taskKey: "work-order:T",
        now,
      }),
    ).resolves.toBe(100n);
  });

  it("refuses a mismatched historical release without rewriting the ledger", async () => {
    const path = await ledgerPath();
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
      path,
      JSON.stringify({
        date: "2026-08-04",
        spentAtomic: "60",
        reservations: [
          {
            id: "failed-fund-T",
            amountAtomic: "60",
            kind: "escrow-funding",
            taskKey: "work-order:T",
          },
        ],
      }),
    );
    const before = await readFile(path, "utf8");

    await expect(
      releaseSpend(59n, {
        ledgerPath: path,
        now,
        reservedOn: "2026-08-04",
        reservationId: "failed-fund-T",
      }),
    ).rejects.toThrow("different amount");
    expect(await readFile(path, "utf8")).toBe(before);
  });

  it("preserves prior-day task reservations when releasing today's different task", async () => {
    const path = await ledgerPath();
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        rows: [
          {
            date: "2026-08-04",
            wallet: "main",
            spentAtomic: "40",
            reservations: [
              {
                id: "prior-T",
                amountAtomic: "40",
                kind: "escrow-funding",
                taskKey: "work-order:T",
              },
            ],
          },
          {
            date: "2026-08-05",
            wallet: "main",
            spentAtomic: "20",
            reservations: [
              {
                id: "today-U",
                amountAtomic: "20",
                kind: "dispute-fee",
                taskKey: "work-order:U",
              },
            ],
          },
        ],
      }),
    );

    await releaseSpend(20n, {
      ledgerPath: path,
      now,
      wallet: "main",
      reservedOn: "2026-08-05",
      reservationId: "today-U",
    });

    await expect(
      taskReservedAtomic({
        ledgerPath: path,
        wallet: "main",
        taskKey: "work-order:T",
        now,
      }),
    ).resolves.toBe(40n);
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
      rows: expect.arrayContaining([
        expect.objectContaining({
          date: "2026-08-04",
          reservations: [expect.objectContaining({ id: "prior-T", taskKey: "work-order:T" })],
        }),
      ]),
    });
  });
});
