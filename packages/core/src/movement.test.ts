import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import type { Hex } from "viem";

import {
  cancelMovement,
  executeMovement,
  listUnfinishedMovements,
  readMovement,
  type Movement,
  type MovementDependencies,
  type MovementTransfer,
} from "./movement.js";
import { getVapiPaths } from "./config.js";
import { __setReceiptTestHooks, appendReceipt, renameReceiptWallet } from "./receipts.js";
import type { SecretStore } from "./secret-store.js";
import { readSpendLedger, reserveSpend } from "./spend-policy.js";
import { TransferError, type TransferArgs, type TransferResult } from "./transfer.js";
import { readTransferJournal } from "./transfer-journal.js";
import type { WalletStore } from "./wallet-store.js";
import { BASE_MAINNET_CAIP2 } from "./x402-networks.js";

const NOW = Date.parse("2026-09-29T10:00:00.000Z");
const ID = "mv_test0001";
const NONCES = ["11", "22", "33"].map((byte) => `0x${byte.repeat(32)}` as Hex);
const TX_HASH = `0x${"ab".repeat(32)}` as Hex;
const TREASURY_ADDRESS = "0x4000000000000000000000000000000000000004" as const;
const OWNER_ADDRESS = "0x5000000000000000000000000000000000000005" as const;
const SENDER_ADDRESS = "0x6000000000000000000000000000000000000006" as const;
const RECIPIENT_ADDRESS = "0x7000000000000000000000000000000000000007" as const;
const REUSED_RECIPIENT_ADDRESS = "0x8000000000000000000000000000000000000008" as const;
const homes: string[] = [];

afterEach(async () => {
  __setReceiptTestHooks(undefined);
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

describe("executeMovement", () => {
  it("keeps another account's signed receipt when a journal rename races its append", async () => {
    const home = await temporaryHome();
    const receiptsPath = getVapiPaths(home).receipts;
    await appendReceipt(
      {
        id: "alice-existing",
        timestamp: new Date(NOW).toISOString(),
        wallet: "alice",
        resourceUrl: "https://api.example/alice",
      },
      receiptsPath,
    );
    await writeMovementFixture(home, [
      {
        from: "sender",
        to: "one",
        amountUsd: "1.00",
        purpose: "send",
        nonce: NONCES[0]!,
        status: "planned",
      },
    ]);

    let renameRead!: () => void;
    const renameReadBarrier = new Promise<void>((resolve) => {
      renameRead = resolve;
    });
    let releaseRename!: () => void;
    const renameGate = new Promise<void>((resolve) => {
      releaseRename = resolve;
    });
    __setReceiptTestHooks({
      async beforeRenameReplace() {
        renameRead();
        await renameGate;
      },
    });

    const renaming = renameReceiptWallet("alice", "renamed-alice", receiptsPath);
    await renameReadBarrier;
    const appending = appendUnknownTransferReceipt(home, NONCES[0]!);
    await Promise.race([appending, new Promise<void>((resolve) => setTimeout(resolve, 100))]);
    releaseRename();
    await Promise.all([renaming, appending]);
    __setReceiptTestHooks(undefined);

    await expect(readTransferJournal(home, "sender", NONCES[0]!)).resolves.toMatchObject({
      signed: true,
    });

    const transfer = vi.fn(async (args: TransferArgs): Promise<TransferResult> =>
      unknownResult(args),
    );
    const randomNonce = vi.fn(() => NONCES[1]!);
    const authorizationState = vi.fn(async () => "pending" as const);
    const deps = {
      ...dependencies(home, transfer, randomNonce),
      authorizationState,
    };
    const cancellationRefused = await cancelMovement(ID, deps).then(
      () => false,
      () => true,
    );
    const freshMovementRefused = await executeMovement(plan(), deps).then(
      () => false,
      () => true,
    );

    expect(cancellationRefused).toBe(true);
    expect(freshMovementRefused).toBe(true);
    expect(authorizationState).toHaveBeenCalledOnce();
    expect(transfer).not.toHaveBeenCalled();
    expect(randomNonce).not.toHaveBeenCalled();
    await expect(readMovement(home, ID)).resolves.toMatchObject({
      legs: [{ status: "planned", nonce: NONCES[0] }],
    });
  });

  it("journals before signing, preserves a crash, blocks a rerun, and resumes only planned legs", async () => {
    const home = await temporaryHome();
    let resumePhase = false;
    let signatures = 0;
    let inspectedBeforeFirstSignature = false;
    const attempted: Array<{ to: string; nonce?: Hex; resume?: Hex }> = [];
    const transfer: MovementTransfer = async (args) => {
      attempted.push({
        to: args.to,
        ...(args.nonce === undefined ? {} : { nonce: args.nonce }),
        ...(args.resume === undefined ? {} : { resume: args.resume }),
      });
      if (attempted.length === 1) {
        const journaled = await readMovement(home, ID);
        expect(journaled.legs.map((leg) => leg.status)).toEqual(["planned", "planned", "planned"]);
        expect(journaled.legs.map((leg) => leg.nonce)).toEqual(NONCES);
        inspectedBeforeFirstSignature = true;
      }
      if (args.to === "two" && !resumePhase) throw new Error("simulated process crash");
      signatures += 1;
      return sentResult(args);
    };
    const deps = dependencies(home, transfer, nonceSequence());

    await expect(executeMovement(plan(), deps)).rejects.toThrow("simulated process crash");
    expect(inspectedBeforeFirstSignature).toBe(true);
    await expect(readMovement(home, ID)).resolves.toMatchObject({
      legs: [{ status: "sent" }, { status: "planned" }, { status: "planned" }],
    });

    await expect(executeMovement(plan(), deps)).rejects.toMatchObject({
      code: "unfinished_movement",
      movementId: ID,
      message: expect.stringContaining(`vapi accounts distribute --resume ${ID}`),
    });

    resumePhase = true;
    const resumed = await executeMovement({ resume: ID }, deps);
    expect(resumed.legs.map((leg) => leg.status)).toEqual(["sent", "sent", "sent"]);
    expect(signatures).toBe(3);
    expect(attempted.slice(-2)).toEqual([
      { to: "two", nonce: NONCES[1] },
      { to: "three", nonce: NONCES[2] },
    ]);
    expect(await listUnfinishedMovements({ home, from: "sender" })).toEqual([]);
  });

  it("resolves an unknown leg through relay idempotency without a second signature", async () => {
    const home = await temporaryHome();
    let signatures = 0;
    const transfer = vi.fn(async (args: TransferArgs): Promise<TransferResult> => {
      if (args.resume === undefined) signatures += 1;
      return args.resume === undefined ? unknownResult(args) : sentResult(args);
    });
    const deps = dependencies(home, transfer, nonceSequence());

    const first = await executeMovement(
      {
        reason: "distribute",
        from: "sender",
        network: BASE_MAINNET_CAIP2,
        legs: [{ to: "one", amountUsd: "1.00" }],
      },
      deps,
    );
    expect(first.legs[0]).toMatchObject({ status: "unknown", nonce: NONCES[0] });

    const resumed = await executeMovement({ resume: ID }, deps);
    expect(resumed.legs[0]).toMatchObject({ status: "sent", nonce: NONCES[0] });
    expect(signatures).toBe(1);
    expect(transfer.mock.calls[1]?.[0]).toMatchObject({ resume: NONCES[0] });
  });

  it("does not allocate a second nonce while an unknown authorization may still settle", async () => {
    const home = await temporaryHome();
    const randomNonce = nonceSequence();
    const transfer = vi.fn(async (args: TransferArgs): Promise<TransferResult> =>
      unknownResult(args),
    );
    const authorizationState = vi.fn(async () => "pending" as const);
    const deps = { ...dependencies(home, transfer, randomNonce), authorizationState };

    await executeMovement(
      {
        reason: "distribute",
        from: "sender",
        network: BASE_MAINNET_CAIP2,
        legs: [{ to: "one", amountUsd: "1.00" }],
      },
      deps,
    );
    const resumed = await executeMovement({ resume: ID }, deps);

    expect(resumed.legs[0]).toMatchObject({ status: "unknown", nonce: NONCES[0] });
    expect(randomNonce).toHaveBeenCalledTimes(1);
    expect(authorizationState).toHaveBeenCalledOnce();
    expect(transfer.mock.calls[1]?.[0]).toMatchObject({ resume: NONCES[0] });
  });

  it("refuses generic resume when a planned recipient name resolves to another address", async () => {
    const home = await temporaryHome();
    let recipientAddress: string = RECIPIENT_ADDRESS;
    const addressReader = vi.fn(async (account: string) =>
      account === "sender" ? SENDER_ADDRESS : recipientAddress,
    );
    const transfer = vi
      .fn<(args: TransferArgs) => Promise<TransferResult>>()
      .mockImplementationOnce(async (args) => unknownResult(args))
      .mockImplementationOnce(async (args) => sentResult(args));
    const deps = {
      ...dependencies(home, transfer, nonceSequence()),
      addressReader,
    };

    const planned = await executeMovement(
      {
        reason: "distribute",
        from: "sender",
        network: BASE_MAINNET_CAIP2,
        legs: [{ to: "recipient", amountUsd: "1.00" }],
      },
      deps,
    );
    expect(planned.legs[0]).toMatchObject({
      fromAddress: SENDER_ADDRESS,
      toAddress: RECIPIENT_ADDRESS,
      status: "unknown",
    });

    recipientAddress = REUSED_RECIPIENT_ADDRESS;
    await expect(executeMovement({ resume: ID }, deps)).rejects.toMatchObject({
      code: "account_address_mismatch",
      movementId: ID,
      message: expect.stringContaining("recipient"),
    });
    expect(transfer).toHaveBeenCalledOnce();
  });

  it("resumes a journaled authorization even when its movement leg still says planned", async () => {
    const home = await temporaryHome();
    let crashed = true;
    const transfer = vi.fn(async (args: TransferArgs): Promise<TransferResult> => {
      if (crashed) throw new Error("simulated process exit before movement rewrite");
      return sentResult(args);
    });
    const deps = dependencies(home, transfer, nonceSequence());

    await expect(executeMovement({ ...plan(), legs: [plan().legs[0]!] }, deps)).rejects.toThrow(
      "simulated process exit",
    );
    await appendUnknownTransferReceipt(home, NONCES[0]!);
    expect((await readMovement(home, ID)).legs[0]?.status).toBe("planned");

    crashed = false;
    const resumed = await executeMovement({ resume: ID }, deps);

    expect(resumed.legs[0]).toMatchObject({ status: "sent", nonce: NONCES[0] });
    expect(transfer.mock.calls[1]?.[0]).toMatchObject({ resume: NONCES[0] });
    expect(transfer.mock.calls[1]?.[0].nonce).toBeUndefined();
  });

  it("rechecks the receipt journal before retrying a failed leg", async () => {
    const home = await temporaryHome();
    const transfer = vi
      .fn<(args: TransferArgs) => Promise<TransferResult>>()
      .mockRejectedValueOnce(
        new TransferError("relay_failed", "The first relay attempt failed.", {
          reservationReleased: true,
        }),
      )
      .mockImplementationOnce(async (args) => unknownResult(args));
    const authorizationState = vi.fn(async () => "settled" as const);
    const randomNonce = nonceSequence();
    const deps = {
      ...dependencies(home, transfer, randomNonce),
      authorizationState,
    };

    const failed = await executeMovement({ ...plan(), legs: [plan().legs[0]!] }, deps);
    expect(failed.legs[0]).toMatchObject({
      status: "failed",
      nonce: NONCES[0],
      retryable: true,
    });
    await appendUnknownTransferReceipt(home, NONCES[0]!);

    const resumed = await executeMovement({ resume: ID }, deps);

    expect(resumed.legs[0]).toMatchObject({ status: "sent", nonce: NONCES[0] });
    expect(transfer).toHaveBeenCalledTimes(2);
    expect(transfer.mock.calls[1]?.[0]).toMatchObject({ resume: NONCES[0] });
    expect(transfer.mock.calls[1]?.[0].nonce).toBeUndefined();
    expect(authorizationState).toHaveBeenCalledOnce();
    expect(randomNonce).toHaveBeenCalledOnce();
  });

  it("keeps an unknown leg blocking when its relay retry fails and the nonce is pending", async () => {
    const home = await temporaryHome();
    const transfer = vi
      .fn<(args: TransferArgs) => Promise<TransferResult>>()
      .mockResolvedValueOnce(
        unknownResult({
          from: "sender",
          to: "one",
          amountUsd: "1.00",
          nonce: NONCES[0],
        } as TransferArgs),
      )
      .mockRejectedValueOnce(
        new TransferError("network_error", "siblings temporarily unavailable"),
      );
    const authorizationState = vi.fn(async () => "pending" as const);
    const deps = { ...dependencies(home, transfer, nonceSequence()), authorizationState };

    await executeMovement({ ...plan(), legs: [plan().legs[0]!] }, deps);
    const resumed = await executeMovement({ resume: ID }, deps);

    expect(resumed.legs[0]).toMatchObject({ status: "unknown", nonce: NONCES[0] });
    expect(await listUnfinishedMovements({ home, from: "sender" })).toMatchObject([
      { id: ID, unknownLegs: 1 },
    ]);
    expect(authorizationState).toHaveBeenCalledOnce();
  });

  it("does not evict a live sender lock merely because its timestamp is old", async () => {
    const home = await temporaryHome();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started!: () => void;
    const transferStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const transfer = vi.fn(async (args: TransferArgs): Promise<TransferResult> => {
      started();
      await blocked;
      return sentResult(args);
    });
    const deps = dependencies(home, transfer, nonceSequence());
    const running = executeMovement({ ...plan(), legs: [plan().legs[0]!] }, deps);
    await transferStarted;
    const lockPath = join(home, "movements", ".sender.lock");
    const old = new Date(Date.now() - 121_000);
    await utimes(lockPath, old, old);

    await expect(
      executeMovement({ resume: ID }, { ...deps, lockTimeoutMs: 20 }),
    ).rejects.toMatchObject({ code: "movement_locked" });

    release();
    await expect(running).resolves.toMatchObject({ legs: [{ status: "sent" }] });
  });

  it("resumes multi-sender send and sweep legs from their own journals without signing twice", async () => {
    const home = await temporaryHome();
    const calls: TransferArgs[] = [];
    const transfer = vi.fn(async (args: TransferArgs): Promise<TransferResult> => {
      calls.push(args);
      await appendSentTransferReceipt(home, args.from, args.to, args.nonce!);
      throw new Error(`simulated crash after signing ${args.to}`);
    });
    const addressReader = vi.fn(async (account: string) =>
      account === "treasury" ? TREASURY_ADDRESS : testAddress(account),
    );
    const deps = {
      ...dependencies(home, transfer, nonceSequence()),
      addressReader,
    };
    const movement = {
      reason: "allocate" as const,
      from: "alpha",
      treasury: "treasury",
      network: BASE_MAINNET_CAIP2,
      legs: [
        { from: "alpha", to: "recipient", amountUsd: "1.00", purpose: "send" as const },
        { from: "bravo", to: "treasury", amountUsd: "2.00", purpose: "sweep" as const },
      ],
    };

    await expect(executeMovement(movement, deps)).rejects.toThrow(
      "simulated crash after signing recipient",
    );
    await expect(executeMovement({ resume: ID }, deps)).rejects.toThrow(
      "simulated crash after signing treasury",
    );
    const resumed = await executeMovement({ resume: ID }, deps);

    expect(resumed).toMatchObject({
      v: 2,
      reason: "allocate",
      legs: [
        { from: "alpha", purpose: "send", nonce: NONCES[0], status: "sent" },
        { from: "bravo", purpose: "sweep", nonce: NONCES[1], status: "sent" },
      ],
    });
    expect(calls).toHaveLength(2);
    expect(calls.map(({ from, nonce }) => ({ from, nonce }))).toEqual([
      { from: "alpha", nonce: NONCES[0] },
      { from: "bravo", nonce: NONCES[1] },
    ]);
    expect(calls[0]).toMatchObject({ from: "alpha", purpose: "send" });
    expect(calls[0]).not.toHaveProperty("sweepParent");
    expect(calls[1]).toMatchObject({
      from: "bravo",
      purpose: "sweep",
      sweepParent: TREASURY_ADDRESS,
    });
    expect(addressReader).toHaveBeenCalledWith("treasury");
  });

  it("requires terminal review before binding an unsigned legacy failed leg", async () => {
    const home = await temporaryHome();
    const directory = join(home, "movements");
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, `${ID}.json`),
      `${JSON.stringify(
        {
          v: 1,
          id: ID,
          reason: "distribute",
          from: "sender",
          network: BASE_MAINNET_CAIP2,
          createdAt: new Date(NOW).toISOString(),
          legs: [
            {
              to: "one",
              amountUsd: "1.00",
              nonce: NONCES[0],
              status: "failed",
              reason: "signing_failed",
              retryable: true,
            },
          ],
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    const transfer = vi.fn(async (args: TransferArgs): Promise<TransferResult> => sentResult(args));
    const deps = dependencies(home, transfer, nonceSequence());

    await expect(readMovement(home, ID)).resolves.toMatchObject({
      v: 2,
      legs: [{ from: "sender", purpose: "send", status: "failed", retryable: true }],
    });
    await expect(executeMovement({ resume: ID }, deps)).rejects.toMatchObject({
      code: "movement_address_unbound",
      movementId: ID,
      message: expect.stringMatching(
        new RegExp(`${SENDER_ADDRESS}.*${testAddress("one")}.*--bind-legacy-addresses`, "u"),
      ),
    });
    expect(transfer).not.toHaveBeenCalled();

    const resumed = await executeMovement({ resume: ID }, { ...deps, bindLegacyAddresses: true });

    expect(resumed.legs).toMatchObject([
      {
        status: "sent",
        nonce: NONCES[0],
        fromAddress: expect.any(String),
        toAddress: expect.any(String),
      },
    ]);
    expect(transfer).toHaveBeenCalledOnce();
    expect(transfer.mock.calls[0]?.[0]).toMatchObject({ nonce: NONCES[0] });
  });

  it("binds an unbound legacy leg from immutable signed journal addresses", async () => {
    const home = await temporaryHome();
    const directory = join(home, "movements");
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, `${ID}.json`),
      `${JSON.stringify({
        v: 1,
        id: ID,
        reason: "distribute",
        from: "sender",
        network: BASE_MAINNET_CAIP2,
        createdAt: new Date(NOW).toISOString(),
        legs: [
          {
            to: "one",
            amountUsd: "1.00",
            nonce: NONCES[0],
            status: "planned",
          },
        ],
      })}\n`,
      "utf8",
    );
    await appendUnknownTransferReceipt(home, NONCES[0]!);
    const transfer = vi.fn(async (args: TransferArgs): Promise<TransferResult> => sentResult(args));
    const deps = dependencies(home, transfer, nonceSequence());

    const resumed = await executeMovement({ resume: ID }, deps);

    expect(resumed.legs).toMatchObject([
      {
        status: "sent",
        fromAddress: SENDER_ADDRESS,
        toAddress: testAddress("one"),
      },
    ]);
    expect(transfer).toHaveBeenCalledWith(expect.objectContaining({ resume: NONCES[0] }));
  });

  it("refuses a legacy signed leg when its recipient name now resolves differently", async () => {
    const home = await temporaryHome();
    const directory = join(home, "movements");
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, `${ID}.json`),
      `${JSON.stringify({
        v: 1,
        id: ID,
        reason: "distribute",
        from: "sender",
        network: BASE_MAINNET_CAIP2,
        createdAt: new Date(NOW).toISOString(),
        legs: [
          {
            to: "one",
            amountUsd: "1.00",
            nonce: NONCES[0],
            status: "planned",
          },
        ],
      })}\n`,
      "utf8",
    );
    await appendUnknownTransferReceipt(home, NONCES[0]!);
    const transfer = vi.fn(async (args: TransferArgs): Promise<TransferResult> => sentResult(args));
    const deps = {
      ...dependencies(home, transfer, nonceSequence()),
      addressReader: async (account: string) =>
        account === "sender" ? SENDER_ADDRESS : REUSED_RECIPIENT_ADDRESS,
    };

    await expect(executeMovement({ resume: ID }, deps)).rejects.toMatchObject({
      code: "account_address_mismatch",
      movementId: ID,
      message: expect.stringContaining("recipient one"),
    });
    expect(transfer).not.toHaveBeenCalled();
    await expect(readMovement(home, ID)).resolves.toMatchObject({
      legs: [
        {
          fromAddress: SENDER_ADDRESS,
          toAddress: testAddress("one"),
          addressBindingSource: "journal",
        },
      ],
    });
  });

  it("cancels a legacy name-reuse blocker only after its signed nonce is terminal", async () => {
    const home = await temporaryHome();
    const directory = join(home, "movements");
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, `${ID}.json`),
      `${JSON.stringify({
        v: 1,
        id: ID,
        reason: "distribute",
        from: "sender",
        network: BASE_MAINNET_CAIP2,
        createdAt: new Date(NOW).toISOString(),
        legs: [
          {
            to: "one",
            amountUsd: "1.00",
            nonce: NONCES[0],
            status: "failed",
            reason: "relay_failed",
            retryable: false,
          },
        ],
      })}\n`,
      "utf8",
    );
    await appendUnknownTransferReceipt(home, NONCES[0]!);
    let state: "pending" | "expired" = "pending";
    const transfer = vi.fn(async (args: TransferArgs): Promise<TransferResult> => sentResult(args));
    const randomNonce = fixedNonceSequence([NONCES[1]!]);
    const deps = {
      ...dependencies(home, transfer, randomNonce),
      authorizationState: vi.fn(async () => state),
      addressReader: async (account: string) =>
        account === "sender" ? SENDER_ADDRESS : REUSED_RECIPIENT_ADDRESS,
    };

    await expect(cancelMovement(ID, deps)).rejects.toMatchObject({
      code: "movement_not_cancellable",
      movementId: ID,
      message: expect.stringMatching(/wait.*expiry.*--cancel/iu),
    });
    await expect(readMovement(home, ID)).resolves.toMatchObject({
      legs: [{ status: "failed", nonce: NONCES[0] }],
    });
    expect(transfer).not.toHaveBeenCalled();
    expect(randomNonce).not.toHaveBeenCalled();

    state = "expired";
    await expect(executeMovement({ resume: ID }, deps)).rejects.toMatchObject({
      code: "account_address_mismatch",
      movementId: ID,
    });
    await expect(readMovement(home, ID)).resolves.toMatchObject({
      legs: [{ status: "planned", nonce: NONCES[1] }],
    });

    const cancelled = await cancelMovement(ID, deps);
    expect(cancelled.legs).toMatchObject([{ status: "cancelled", nonce: NONCES[1] }]);
    expect(transfer).not.toHaveBeenCalled();
    expect(randomNonce).toHaveBeenCalledOnce();
    await expect(listUnfinishedMovements({ home, from: "sender" })).resolves.toEqual([]);

    const next = await executeMovement(
      {
        reason: "distribute",
        from: "sender",
        network: BASE_MAINNET_CAIP2,
        legs: [{ to: "one", amountUsd: "1.00" }],
      },
      {
        ...deps,
        randomId: () => "mv_aftercancel",
        randomNonce: fixedNonceSequence([NONCES[2]!]),
      },
    );
    expect(next.legs).toMatchObject([{ status: "sent", nonce: NONCES[2] }]);
    expect(transfer).toHaveBeenCalledOnce();
  });

  it("refuses cancellation atomically until every signed leg is terminal, then releases its reservation", async () => {
    const home = await temporaryHome();
    const settledNonce = `0x${"44".repeat(32)}` as Hex;
    const directory = join(home, "movements");
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, `${ID}.json`),
      `${JSON.stringify({
        v: 2,
        id: ID,
        reason: "distribute",
        from: "sender",
        network: BASE_MAINNET_CAIP2,
        createdAt: new Date(NOW).toISOString(),
        legs: [
          {
            from: "sender",
            to: "one",
            amountUsd: "1.00",
            purpose: "send",
            nonce: NONCES[0],
            status: "planned",
          },
          {
            from: "sender",
            to: "one",
            amountUsd: "1.00",
            purpose: "send",
            nonce: NONCES[1],
            status: "failed",
            reason: "relay_failed",
          },
          {
            from: "sender",
            to: "one",
            amountUsd: "1.00",
            purpose: "send",
            nonce: NONCES[2],
            status: "planned",
          },
          {
            from: "sender",
            to: "one",
            amountUsd: "1.00",
            purpose: "send",
            nonce: settledNonce,
            status: "failed",
            reason: "relay_failed",
          },
        ],
      })}\n`,
      "utf8",
    );
    await appendUnknownTransferReceipt(home, NONCES[1]!);
    await appendSentTransferReceipt(home, "sender", "one", NONCES[2]!);
    await appendUnknownTransferReceipt(home, settledNonce);
    const ledgerPath = getVapiPaths(home).ledger;
    await reserveSpend(
      1_000_000n,
      { perCallAtomic: "1000000", perDayAtomic: "1000000" },
      {
        ledgerPath,
        now: new Date(NOW),
        wallet: "sender",
        reservationId: NONCES[1]!.toLowerCase(),
      },
    );
    let state: "pending" | "expired" = "pending";
    const transfer = vi.fn(async (args: TransferArgs): Promise<TransferResult> => sentResult(args));
    const randomNonce = nonceSequence();
    const deps = {
      ...dependencies(home, transfer, randomNonce),
      ledgerPath,
      authorizationState: vi.fn(async ({ leg }: { leg: { nonce: string } }) =>
        leg.nonce === settledNonce ? ("settled" as const) : state,
      ),
    };

    await expect(cancelMovement(ID, deps)).rejects.toMatchObject({
      code: "movement_not_cancellable",
      movementId: ID,
    });
    await expect(readMovement(home, ID)).resolves.toMatchObject({
      legs: [
        { status: "planned" },
        { status: "failed" },
        { status: "planned" },
        { status: "failed" },
      ],
    });
    await expect(readSpendLedger(ledgerPath, new Date(NOW), "sender")).resolves.toMatchObject({
      spentAtomic: "1000000",
    });

    state = "expired";
    const cancelled = await cancelMovement(ID, deps);
    expect(cancelled.legs).toMatchObject([
      { status: "cancelled", nonce: NONCES[0] },
      { status: "cancelled", nonce: NONCES[1] },
      { status: "sent", nonce: NONCES[2] },
      { status: "sent", nonce: settledNonce },
    ]);
    await expect(readSpendLedger(ledgerPath, new Date(NOW), "sender")).resolves.toMatchObject({
      spentAtomic: "0",
    });
    expect(transfer).not.toHaveBeenCalled();
    expect(randomNonce).not.toHaveBeenCalled();
  });

  it("refuses to cancel an unknown leg without terminal signed evidence and signs nothing", async () => {
    const home = await temporaryHome();
    const directory = join(home, "movements");
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, `${ID}.json`),
      `${JSON.stringify({
        v: 2,
        id: ID,
        reason: "distribute",
        from: "sender",
        network: BASE_MAINNET_CAIP2,
        createdAt: new Date(NOW).toISOString(),
        legs: [
          {
            from: "sender",
            to: "one",
            amountUsd: "1.00",
            purpose: "send",
            nonce: NONCES[0],
            status: "unknown",
          },
        ],
      })}\n`,
      "utf8",
    );
    const transfer = vi.fn(async (args: TransferArgs): Promise<TransferResult> => sentResult(args));
    const randomNonce = nonceSequence();
    const authorizationState = vi.fn(async () => "expired" as const);
    const deps = {
      ...dependencies(home, transfer, randomNonce),
      authorizationState,
    };

    await expect(cancelMovement(ID, deps)).rejects.toMatchObject({
      code: "movement_not_cancellable",
      movementId: ID,
      message: expect.stringContaining("unknown"),
    });
    await expect(
      cancelMovement(ID, { ...deps, replaceExpiredRestored: true }),
    ).rejects.toMatchObject({
      code: "movement_not_cancellable",
      movementId: ID,
      message: expect.stringContaining("unknown"),
    });
    await expect(readMovement(home, ID)).resolves.toMatchObject({
      legs: [{ status: "unknown", nonce: NONCES[0] }],
    });
    expect(authorizationState).not.toHaveBeenCalled();
    expect(transfer).not.toHaveBeenCalled();
    expect(randomNonce).not.toHaveBeenCalled();
  });

  it("refuses to cancel a restored unknown leg without its journal even with the restored override", async () => {
    const home = await temporaryHome();
    const directory = join(home, "movements");
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, `${ID}.json`),
      `${JSON.stringify({
        v: 2,
        id: ID,
        reason: "distribute",
        from: "sender",
        network: BASE_MAINNET_CAIP2,
        createdAt: new Date(NOW).toISOString(),
        legs: [
          {
            from: "sender",
            to: "one",
            amountUsd: "1.00",
            purpose: "send",
            nonce: NONCES[0],
            status: "unknown",
            restored: true,
          },
        ],
      })}\n`,
      "utf8",
    );
    const transfer = vi.fn(async (args: TransferArgs): Promise<TransferResult> => sentResult(args));
    const randomNonce = nonceSequence();
    const authorizationState = vi.fn(async () => "expired" as const);
    const deps = {
      ...dependencies(home, transfer, randomNonce),
      authorizationState,
    };

    await expect(cancelMovement(ID, deps)).rejects.toMatchObject({
      code: "movement_not_cancellable",
      movementId: ID,
      message: expect.stringContaining("unknown"),
    });
    await expect(
      cancelMovement(ID, { ...deps, replaceExpiredRestored: true }),
    ).rejects.toMatchObject({
      code: "movement_not_cancellable",
      movementId: ID,
      message: expect.stringContaining("unknown"),
    });
    await expect(readMovement(home, ID)).resolves.toMatchObject({
      legs: [{ status: "unknown", nonce: NONCES[0], restored: true }],
    });
    expect(authorizationState).not.toHaveBeenCalled();
    expect(transfer).not.toHaveBeenCalled();
    expect(randomNonce).not.toHaveBeenCalled();
  });

  it("refuses to cancel a restored signed leg even when its saved nonce expired", async () => {
    const home = await temporaryHome();
    await writeMovementFixture(home, [
      {
        from: "sender",
        to: "one",
        amountUsd: "1.00",
        purpose: "send",
        nonce: NONCES[0]!,
        status: "unknown",
        restored: true,
      },
    ]);
    await appendUnknownTransferReceipt(home, NONCES[0]!);
    const ledgerPath = getVapiPaths(home).ledger;
    await reserveSpend(
      1_000_000n,
      { perCallAtomic: "1000000", perDayAtomic: "1000000" },
      {
        ledgerPath,
        now: new Date(NOW),
        wallet: "sender",
        reservationId: NONCES[0]!.toLowerCase(),
      },
    );
    const transfer = vi.fn(async (args: TransferArgs): Promise<TransferResult> => sentResult(args));
    const authorizationState = vi.fn(async () => "expired" as const);

    await expect(
      cancelMovement(ID, {
        ...dependencies(home, transfer, nonceSequence()),
        ledgerPath,
        authorizationState,
      }),
    ).rejects.toMatchObject({
      code: "movement_not_cancellable",
      movementId: ID,
      message: expect.stringContaining(`--resume ${ID} --replace-expired-restored`),
    });
    expect(authorizationState).toHaveBeenCalledOnce();
    expect(transfer).not.toHaveBeenCalled();
    await expect(readMovement(home, ID)).resolves.toMatchObject({
      legs: [{ status: "unknown", nonce: NONCES[0], restored: true }],
    });
    await expect(readSpendLedger(ledgerPath, new Date(NOW), "sender")).resolves.toMatchObject({
      spentAtomic: "1000000",
    });

    const cancelled = await cancelMovement(ID, {
      ...dependencies(home, transfer, nonceSequence()),
      ledgerPath,
      authorizationState,
      replaceExpiredRestored: true,
    });
    expect(cancelled.legs).toMatchObject([
      { status: "cancelled", nonce: NONCES[0], restored: true },
    ]);
    await expect(readSpendLedger(ledgerPath, new Date(NOW), "sender")).resolves.toMatchObject({
      spentAtomic: "0",
    });
    expect(transfer).not.toHaveBeenCalled();
  });

  it("requires the restored override to cancel an unjournaled failed leg, then unblocks its sender", async () => {
    const home = await temporaryHome();
    await writeMovementFixture(home, [
      {
        from: "sender",
        to: "one",
        amountUsd: "1.00",
        purpose: "send",
        nonce: NONCES[0]!,
        status: "failed",
        reason: "relay_failed",
        retryable: false,
        restored: true,
      },
    ]);
    const movementPath = join(home, "movements", `${ID}.json`);
    const before = await readFile(movementPath, "utf8");
    const transfer = vi.fn(async (args: TransferArgs): Promise<TransferResult> => sentResult(args));
    const deps = dependencies(home, transfer, nonceSequence());

    await expect(cancelMovement(ID, deps)).rejects.toMatchObject({
      code: "movement_not_cancellable",
      movementId: ID,
      message: expect.stringContaining(
        `vapi accounts distribute --cancel ${ID} --replace-expired-restored`,
      ),
    });
    await expect(readFile(movementPath, "utf8")).resolves.toBe(before);

    const cancelled = await cancelMovement(ID, { ...deps, replaceExpiredRestored: true });
    expect(cancelled.legs).toMatchObject([
      { status: "cancelled", nonce: NONCES[0], restored: true },
    ]);
    expect(transfer).not.toHaveBeenCalled();
    await expect(listUnfinishedMovements({ home, from: "sender" })).resolves.toEqual([]);

    const next = await executeMovement(
      {
        reason: "distribute",
        from: "sender",
        network: BASE_MAINNET_CAIP2,
        legs: [{ to: "one", amountUsd: "1.00" }],
      },
      {
        ...deps,
        randomId: () => "mv_afterrestorecancel",
        randomNonce: fixedNonceSequence([NONCES[1]!]),
      },
    );
    expect(next.legs).toMatchObject([{ status: "sent", nonce: NONCES[1] }]);
    expect(transfer).toHaveBeenCalledOnce();
  });

  it("keeps override cancellation atomic when a restored signed leg is still pending", async () => {
    const home = await temporaryHome();
    await writeMovementFixture(home, [
      {
        from: "sender",
        to: "one",
        amountUsd: "1.00",
        purpose: "send",
        nonce: NONCES[0]!,
        status: "failed",
        reason: "relay_failed",
        retryable: false,
        restored: true,
      },
      {
        from: "sender",
        to: "two",
        amountUsd: "1.00",
        purpose: "send",
        nonce: NONCES[1]!,
        status: "failed",
        reason: "relay_failed",
        retryable: false,
        restored: true,
      },
    ]);
    await appendUnknownTransferReceipt(home, NONCES[1]!);
    const ledgerPath = getVapiPaths(home).ledger;
    await reserveSpend(
      1_000_000n,
      { perCallAtomic: "1000000", perDayAtomic: "1000000" },
      {
        ledgerPath,
        now: new Date(NOW),
        wallet: "sender",
        reservationId: NONCES[1]!.toLowerCase(),
      },
    );
    const movementPath = join(home, "movements", `${ID}.json`);
    const before = await readFile(movementPath, "utf8");
    const transfer = vi.fn(async (args: TransferArgs): Promise<TransferResult> => sentResult(args));
    const authorizationState = vi.fn(async () => "pending" as const);

    await expect(
      cancelMovement(ID, {
        ...dependencies(home, transfer, nonceSequence()),
        ledgerPath,
        authorizationState,
        replaceExpiredRestored: true,
      }),
    ).rejects.toMatchObject({ code: "movement_not_cancellable", movementId: ID });

    expect(authorizationState).toHaveBeenCalledOnce();
    expect(transfer).not.toHaveBeenCalled();
    await expect(readFile(movementPath, "utf8")).resolves.toBe(before);
    await expect(readSpendLedger(ledgerPath, new Date(NOW), "sender")).resolves.toMatchObject({
      spentAtomic: "1000000",
    });
  });

  it("refuses the restored override when its signed nonce cannot be checked", async () => {
    const home = await temporaryHome();
    await writeMovementFixture(home, [
      {
        from: "sender",
        to: "one",
        amountUsd: "1.00",
        purpose: "send",
        nonce: NONCES[0]!,
        status: "failed",
        reason: "relay_failed",
        retryable: false,
        restored: true,
      },
    ]);
    await appendUnknownTransferReceipt(home, NONCES[0]!);
    const movementPath = join(home, "movements", `${ID}.json`);
    const before = await readFile(movementPath, "utf8");
    const transfer = vi.fn(async (args: TransferArgs): Promise<TransferResult> => sentResult(args));

    await expect(
      cancelMovement(ID, {
        ...dependencies(home, transfer, nonceSequence()),
        authorizationState: async () => {
          throw new Error("RPC unavailable");
        },
        replaceExpiredRestored: true,
      }),
    ).rejects.toMatchObject({
      code: "movement_not_cancellable",
      movementId: ID,
      message: expect.stringContaining("RPC unavailable"),
    });

    expect(transfer).not.toHaveBeenCalled();
    await expect(readFile(movementPath, "utf8")).resolves.toBe(before);
  });

  it("marks a settled restored nonce sent before cancelling ordinary unsigned legs", async () => {
    const home = await temporaryHome();
    await writeMovementFixture(home, [
      {
        from: "sender",
        to: "one",
        amountUsd: "1.00",
        purpose: "send",
        nonce: NONCES[0]!,
        status: "unknown",
        restored: true,
      },
      {
        from: "sender",
        to: "two",
        amountUsd: "1.00",
        purpose: "send",
        nonce: NONCES[1]!,
        status: "planned",
      },
    ]);
    await appendUnknownTransferReceipt(home, NONCES[0]!);
    const transfer = vi.fn(async (args: TransferArgs): Promise<TransferResult> => sentResult(args));
    const authorizationState = vi.fn(async () => "settled" as const);

    const cancelled = await cancelMovement(ID, {
      ...dependencies(home, transfer, nonceSequence()),
      authorizationState,
    });

    expect(cancelled.legs).toMatchObject([
      { status: "sent", nonce: NONCES[0], restored: true },
      { status: "cancelled", nonce: NONCES[1] },
    ]);
    expect(authorizationState).toHaveBeenCalledOnce();
    expect(transfer).not.toHaveBeenCalled();
    await expect(listUnfinishedMovements({ home, from: "sender" })).resolves.toEqual([]);
  });

  it("refuses mixed cancellation atomically when one unsigned leg was restored", async () => {
    const home = await temporaryHome();
    await writeMovementFixture(home, [
      {
        from: "sender",
        to: "one",
        amountUsd: "1.00",
        purpose: "send",
        nonce: NONCES[0]!,
        status: "planned",
      },
      {
        from: "sender",
        to: "two",
        amountUsd: "1.00",
        purpose: "send",
        nonce: NONCES[1]!,
        status: "planned",
        restored: true,
      },
    ]);
    const movementPath = join(home, "movements", `${ID}.json`);
    const before = await readFile(movementPath, "utf8");
    const transfer = vi.fn(async (args: TransferArgs): Promise<TransferResult> => sentResult(args));
    const authorizationState = vi.fn(async () => "settled" as const);

    await expect(
      cancelMovement(ID, {
        ...dependencies(home, transfer, nonceSequence()),
        authorizationState,
      }),
    ).rejects.toMatchObject({ code: "movement_not_cancellable", movementId: ID });

    await expect(readFile(movementPath, "utf8")).resolves.toBe(before);
    await expect(readMovement(home, ID)).resolves.toMatchObject({
      legs: [
        { status: "planned", nonce: NONCES[0] },
        { status: "planned", nonce: NONCES[1], restored: true },
      ],
    });
    expect(authorizationState).not.toHaveBeenCalled();
    expect(transfer).not.toHaveBeenCalled();
  });

  it("blocks a movement when its second sender already has an unfinished movement", async () => {
    const home = await temporaryHome();
    const openId = "mv_openbravo";
    const transfer = vi.fn(async (args: TransferArgs): Promise<TransferResult> =>
      unknownResult(args),
    );
    await executeMovement(
      {
        reason: "send",
        from: "bravo",
        network: BASE_MAINNET_CAIP2,
        legs: [{ to: "recipient", amountUsd: "1.00" }],
      },
      {
        ...dependencies(home, transfer, fixedNonceSequence([NONCES[0]!])),
        randomId: () => openId,
      },
    );
    const unusedTransfer = vi.fn(async (args: TransferArgs): Promise<TransferResult> =>
      sentResult(args),
    );

    await expect(
      executeMovement(
        {
          reason: "allocate",
          from: "alpha",
          network: BASE_MAINNET_CAIP2,
          legs: [
            { from: "alpha", to: "one", amountUsd: "1.00" },
            { from: "bravo", to: "two", amountUsd: "1.00" },
          ],
        },
        {
          ...dependencies(home, unusedTransfer, fixedNonceSequence(NONCES)),
          randomId: () => "mv_newalpha1",
        },
      ),
    ).rejects.toMatchObject({
      code: "unfinished_movement",
      movementId: openId,
      message: expect.stringContaining(
        `Account bravo has unfinished movement ${openId}. Resume it with vapi accounts distribute --resume ${openId}.`,
      ),
    });
    expect(unusedTransfer).not.toHaveBeenCalled();
  });

  it("settles concurrent movements with swapped sender order without a lock timeout", async () => {
    const home = await temporaryHome();
    const firstTransfer = vi.fn(async (args: TransferArgs): Promise<TransferResult> =>
      sentResult(args),
    );
    const secondTransfer = vi.fn(async (args: TransferArgs): Promise<TransferResult> =>
      sentResult(args),
    );

    const settled = await Promise.allSettled([
      executeMovement(
        {
          reason: "allocate",
          from: "alpha",
          network: BASE_MAINNET_CAIP2,
          legs: [
            { from: "alpha", to: "one", amountUsd: "1.00" },
            { from: "bravo", to: "two", amountUsd: "1.00" },
          ],
        },
        {
          ...dependencies(home, firstTransfer, fixedNonceSequence([NONCES[0]!, NONCES[1]!])),
          randomId: () => "mv_concur01",
          lockTimeoutMs: 1_000,
        },
      ),
      executeMovement(
        {
          reason: "rebalance",
          from: "bravo",
          network: BASE_MAINNET_CAIP2,
          legs: [
            { from: "bravo", to: "three", amountUsd: "1.00" },
            { from: "alpha", to: "four", amountUsd: "1.00" },
          ],
        },
        {
          ...dependencies(home, secondTransfer, fixedNonceSequence([NONCES[1]!, NONCES[2]!])),
          randomId: () => "mv_concur02",
          lockTimeoutMs: 1_000,
        },
      ),
    ]);

    expect(settled).toMatchObject([{ status: "fulfilled" }, { status: "fulfilled" }]);
    expect(firstTransfer).toHaveBeenCalledTimes(2);
    expect(secondTransfer).toHaveBeenCalledTimes(2);
  });

  it("fails an unresolved sweep parent before invoking transfer", async () => {
    const home = await temporaryHome();
    const transfer = vi.fn(async (args: TransferArgs): Promise<TransferResult> => sentResult(args));
    const result = await executeMovement(
      {
        reason: "sweep",
        from: "sender",
        treasury: "treasury",
        network: BASE_MAINNET_CAIP2,
        legs: [{ to: "treasury", amountUsd: "1.00", purpose: "sweep" }],
      },
      {
        ...dependencies(home, transfer, nonceSequence()),
        addressReader: (() => {
          let treasuryReads = 0;
          return async (account: string) => {
            if (account !== "treasury") return testAddress(account);
            treasuryReads += 1;
            return treasuryReads <= 2 ? TREASURY_ADDRESS : undefined;
          };
        })(),
      },
    );

    expect(result.legs).toMatchObject([
      { status: "failed", reason: "sweep_parent_unknown", retryable: false },
    ]);
    expect(transfer).not.toHaveBeenCalled();
  });

  it.each([undefined, "treasury"])(
    "refuses a sweep leg to a sibling that is not the plan's treasury (treasury %s)",
    async (treasury) => {
      const home = await temporaryHome();
      const transfer = vi.fn(async (args: TransferArgs): Promise<TransferResult> =>
        sentResult(args),
      );

      await expect(
        executeMovement(
          {
            reason: "rebalance",
            from: "sender",
            ...(treasury === undefined ? {} : { treasury }),
            network: BASE_MAINNET_CAIP2,
            legs: [{ to: "sibling", amountUsd: "1.00", purpose: "sweep" }],
          },
          dependencies(home, transfer, nonceSequence()),
        ),
      ).rejects.toMatchObject({ code: "invalid_movement" });
      expect(transfer).not.toHaveBeenCalled();
      await expect(listUnfinishedMovements({ home })).resolves.toEqual([]);
    },
  );

  it.each(["owner", OWNER_ADDRESS])(
    "executes a treasury-to-owner sweep addressed as %s",
    async (to) => {
      const home = await temporaryHome();
      const transfer = vi.fn(async (args: TransferArgs): Promise<TransferResult> =>
        sentResult(args),
      );
      const addressReader = vi.fn(async (account: string) => testAddress(account));

      const result = await executeMovement(
        {
          reason: "sweep",
          from: "treasury",
          network: BASE_MAINNET_CAIP2,
          legs: [{ to, amountUsd: "1.00", purpose: "sweep" }],
        },
        {
          ...dependencies(home, transfer, nonceSequence()),
          addressReader,
        },
      );

      expect(result.legs).toMatchObject([{ status: "sent" }]);
      expect(transfer).toHaveBeenCalledOnce();
      expect(transfer).toHaveBeenCalledWith(
        expect.objectContaining({ from: "treasury", to, purpose: "sweep" }),
      );
      expect(addressReader).toHaveBeenCalledWith("treasury");
    },
  );
});

function plan() {
  return {
    reason: "distribute" as const,
    from: "sender" as const,
    network: BASE_MAINNET_CAIP2,
    legs: [
      { to: "one", amountUsd: "1.00" },
      { to: "two", amountUsd: "1.00" },
      { to: "three", amountUsd: "1.00" },
    ],
  };
}

function dependencies(
  home: string,
  transfer: MovementTransfer,
  randomNonce: ReturnType<typeof nonceSequence>,
): MovementDependencies {
  return {
    home,
    store: {
      home,
      entry: () => ({ link: { owner: OWNER_ADDRESS } }),
    } as unknown as WalletStore,
    secrets: {} as SecretStore,
    apiBase: "https://api.vapinetwork.ai",
    transfer,
    addressReader: async (account) => testAddress(account),
    now: () => NOW,
    randomId: () => ID,
    randomNonce,
  };
}

function testAddress(account: string): `0x${string}` {
  if (account === "treasury") return TREASURY_ADDRESS;
  if (account === "sender") return SENDER_ADDRESS;
  const hex = [...account].reduce((total, character) => total + character.charCodeAt(0), 1);
  return `0x${hex.toString(16).padStart(40, "0").slice(-40)}`;
}

function nonceSequence() {
  let index = 0;
  return vi.fn(() => NONCES[index++]!);
}

function fixedNonceSequence(nonces: readonly Hex[]) {
  let index = 0;
  return vi.fn(() => nonces[index++]!);
}

function sentResult(args: TransferArgs): TransferResult {
  return transferResult(args, "sent");
}

function unknownResult(args: TransferArgs): TransferResult {
  return transferResult(args, "unknown");
}

function transferResult(args: TransferArgs, status: "sent" | "unknown"): TransferResult {
  const nonce = args.resume ?? args.nonce ?? NONCES[0]!;
  return {
    status,
    from: args.from,
    to: "0x1111111111111111111111111111111111111111",
    toName: args.to,
    toKind: "account",
    amountUsd: String(args.amountUsd),
    amountAtomic: (BigInt(String(args.amountUsd).replace(".", "")) * 10_000n).toString(),
    network: BASE_MAINNET_CAIP2,
    txHash: status === "sent" ? TX_HASH : null,
    nonce,
    replayed: args.resume !== undefined,
  };
}

async function temporaryHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "vapi-movement-"));
  homes.push(home);
  return home;
}

async function writeMovementFixture(home: string, legs: Movement["legs"]): Promise<void> {
  const directory = join(home, "movements");
  await mkdir(directory, { recursive: true });
  const movement: Movement = {
    v: 2,
    id: ID,
    reason: "distribute",
    from: "sender",
    network: BASE_MAINNET_CAIP2,
    createdAt: new Date(NOW).toISOString(),
    legs,
  };
  await writeFile(join(directory, `${ID}.json`), `${JSON.stringify(movement, null, 2)}\n`, "utf8");
}

async function appendUnknownTransferReceipt(home: string, nonce: Hex): Promise<void> {
  await appendReceipt(
    {
      id: "transfer-journaled-before-crash",
      timestamp: new Date(NOW).toISOString(),
      kind: "transfer",
      wallet: "sender",
      resourceUrl: "https://api.vapinetwork.ai/api/agents/relay-transfer",
      method: "POST",
      quote: {
        network: BASE_MAINNET_CAIP2,
        asset: "0x2222222222222222222222222222222222222222",
        amountAtomic: "1000000",
        payTo: testAddress("one"),
      },
      payer: SENDER_ADDRESS,
      transfer: {
        to: testAddress("one"),
        toName: "one",
        toKind: "account",
        amountAtomic: "1000000",
        network: BASE_MAINNET_CAIP2,
        nonce,
        status: "unknown",
        txHash: null,
        replayed: false,
        reservedOn: "2026-09-29",
        request: {
          authorization: {
            from: SENDER_ADDRESS,
            to: testAddress("one"),
            value: "1000000",
            validAfter: "0",
            validBefore: "1790676600",
            nonce,
          },
          signature: `0x${"44".repeat(65)}`,
        },
      },
      settlement: { outcome: "unknown" },
    },
    getVapiPaths(home).receipts,
    { wallet: "sender" },
  );
}

async function appendSentTransferReceipt(
  home: string,
  from: string,
  to: string,
  nonce: Hex,
): Promise<void> {
  await appendReceipt(
    {
      id: `sent-${from}-${nonce.slice(2, 10)}`,
      timestamp: new Date(NOW).toISOString(),
      kind: "transfer",
      wallet: from,
      resourceUrl: "https://api.vapinetwork.ai/api/agents/relay-transfer",
      method: "POST",
      quote: {
        network: BASE_MAINNET_CAIP2,
        asset: "0x2222222222222222222222222222222222222222",
        amountAtomic: "1000000",
        payTo: "0x1111111111111111111111111111111111111111",
      },
      payer: "0x3333333333333333333333333333333333333333",
      transfer: {
        to: "0x1111111111111111111111111111111111111111",
        toName: to,
        toKind: "account",
        amountAtomic: "1000000",
        network: BASE_MAINNET_CAIP2,
        nonce,
        status: "sent",
        txHash: TX_HASH,
        replayed: false,
      },
      settlement: { outcome: "succeeded", transaction: TX_HASH },
    },
    getVapiPaths(home).receipts,
    { wallet: from },
  );
}
