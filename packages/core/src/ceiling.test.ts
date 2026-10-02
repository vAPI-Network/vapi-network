import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { getAddress } from "viem";

import { readAuditLog } from "./audit.js";
import {
  ceilingFloorApplies,
  effectiveCeiling,
  sweepAboveCeiling,
  sweepAllAboveCeiling,
  sweepTarget,
  type CeilingBalanceReader,
  type CeilingSiblingsFetcher,
  type CeilingTransfer,
  type SweepAboveCeilingArgs,
} from "./ceiling.js";
import { getVapiPaths } from "./config.js";
import { executeMovement } from "./movement.js";
import { appendReceipt } from "./receipts.js";
import type { SecretStore } from "./secret-store.js";
import type { Sibling } from "./siblings.js";
import { TransferError, type TransferArgs, type TransferResult } from "./transfer.js";
import { WalletStore, type AgentLink } from "./wallet-store.js";
import { BASE_MAINNET_CAIP2 } from "./x402-networks.js";

const API_BASE = "https://api.vapinetwork.ai";
const OWNER = getAddress("0x1111111111111111111111111111111111111111");
const OTHER_OWNER = getAddress("0x2222222222222222222222222222222222222222");
const ACCOUNT_ADDRESS = getAddress("0x3333333333333333333333333333333333333333");
const TREASURY = getAddress("0x4444444444444444444444444444444444444444");
const OTHER_TREASURY = getAddress("0x5555555555555555555555555555555555555555");
const TX_HASH = `0x${"44".repeat(32)}` as `0x${string}`;
const NOW = Date.parse("2026-09-29T10:00:00.000Z");

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("ceiling sweep", () => {
  it("shares the per-sender signing lock with movement execution", async () => {
    const fixture = await makeFixture();
    let releaseMovement!: () => void;
    const movementReleased = new Promise<void>((resolve) => {
      releaseMovement = resolve;
    });
    let movementStarted!: () => void;
    const movementStart = new Promise<void>((resolve) => {
      movementStarted = resolve;
    });
    const movementTransfer = vi.fn(async (args: TransferArgs) => {
      movementStarted();
      await movementReleased;
      return transferResult(args.from, ACCOUNT_ADDRESS, args.amountUsd);
    });
    const movement = executeMovement(
      {
        reason: "send",
        from: "agent",
        network: BASE_MAINNET_CAIP2,
        legs: [{ to: OWNER, amountUsd: "1.00" }],
      },
      {
        home: fixture.home,
        store: fixture.store,
        secrets: fixture.args.secrets,
        apiBase: API_BASE,
        transfer: movementTransfer,
        addressReader: fixture.args.addressReader,
        randomId: () => "mv_locktest01",
        randomNonce: () => `0x${"44".repeat(32)}`,
      },
    );
    await movementStart;
    const ceilingTransfer = successfulTransfer();
    const sweep = sweepAboveCeiling({
      ...fixture.args,
      balanceReader: balanceReader(6_000_000n),
      transfer: ceilingTransfer,
      timeoutMs: 1_000,
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(ceilingTransfer).not.toHaveBeenCalled();
    releaseMovement();
    await expect(movement).resolves.toBeDefined();
    await expect(sweep).resolves.toMatchObject({ status: "swept" });
    expect(ceilingTransfer).toHaveBeenCalledOnce();
  });

  it("does not sign a ceiling sweep while an unfinished movement authorization may settle", async () => {
    const fixture = await makeFixture();
    const movementNonce = `0x${"33".repeat(32)}` as const;
    const ceilingNonce = `0x${"44".repeat(32)}` as const;
    const movementTransfer = vi.fn<CeilingTransfer>(async (args) => ({
      ...transferResult(args.from, args.to, args.amountUsd),
      status: "unknown",
      nonce: movementNonce,
      txHash: null,
    }));
    await executeMovement(
      {
        reason: "rebalance",
        from: "agent",
        network: BASE_MAINNET_CAIP2,
        legs: [{ to: OWNER, amountUsd: "10.00", purpose: "sweep" }],
      },
      {
        home: fixture.home,
        store: fixture.store,
        secrets: fixture.args.secrets,
        apiBase: API_BASE,
        transfer: movementTransfer,
        addressReader: fixture.args.addressReader,
        randomId: () => "mv_unknownsweep",
        randomNonce: () => movementNonce,
      },
    );
    await appendTransferJournal(fixture.home, movementNonce, OWNER);
    const ceilingTransfer = vi.fn<CeilingTransfer>(async (args) => {
      if (args.resume === movementNonce) {
        return {
          ...transferResult(args.from, args.to, args.amountUsd),
          status: "unknown",
          nonce: movementNonce,
          txHash: null,
        };
      }
      return transferResult(args.from, args.to, args.amountUsd);
    });

    await expect(
      sweepAboveCeiling({
        ...fixture.args,
        balanceReader: balanceReader(20_000_000n),
        transfer: ceilingTransfer,
        randomNonce: () => ceilingNonce,
      }),
    ).resolves.toMatchObject({ status: "skipped", reason: "unfinished_movement" });

    expect(ceilingTransfer).toHaveBeenCalledWith(
      expect.objectContaining({ resume: movementNonce }),
    );
    expect(ceilingTransfer.mock.calls.some(([args]) => args.nonce === ceilingNonce)).toBe(false);
    expect(fixture.store.ceilingSweepPending("agent")).toBeUndefined();
  });

  it("does not sweep while a planned movement leg from the account will be signed on resume", async () => {
    const fixture = await makeFixture();
    const movementTransfer = vi.fn<CeilingTransfer>(async () => {
      throw new Error("process died before signing");
    });
    await executeMovement(
      {
        reason: "rebalance",
        from: "agent",
        network: BASE_MAINNET_CAIP2,
        legs: [{ to: OWNER, amountUsd: "10.00", purpose: "sweep" }],
      },
      {
        home: fixture.home,
        store: fixture.store,
        secrets: fixture.args.secrets,
        apiBase: API_BASE,
        transfer: movementTransfer,
        addressReader: fixture.args.addressReader,
        randomId: () => "mv_plannedsweep",
        randomNonce: () => `0x${"55".repeat(32)}`,
      },
    ).catch(() => undefined);
    const ceilingTransfer = successfulTransfer();

    await expect(
      sweepAboveCeiling({
        ...fixture.args,
        balanceReader: balanceReader(20_000_000n),
        transfer: ceilingTransfer,
      }),
    ).resolves.toMatchObject({ status: "skipped", reason: "unfinished_movement" });
    expect(ceilingTransfer).not.toHaveBeenCalled();
  });

  it("allows a ceiling sweep after the account's movement leg is cancelled", async () => {
    const fixture = await makeFixture();
    const directory = join(fixture.home, "movements");
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, "mv_cancelledsweep.json"),
      `${JSON.stringify({
        v: 2,
        id: "mv_cancelledsweep",
        reason: "rebalance",
        from: "agent",
        network: BASE_MAINNET_CAIP2,
        createdAt: new Date(NOW).toISOString(),
        legs: [
          {
            from: "agent",
            to: OWNER,
            amountUsd: "10.00",
            purpose: "sweep",
            nonce: `0x${"56".repeat(32)}`,
            status: "cancelled",
          },
        ],
      })}\n`,
      "utf8",
    );
    const transfer = successfulTransfer();

    await expect(
      sweepAboveCeiling({
        ...fixture.args,
        balanceReader: balanceReader(20_000_000n),
        transfer,
      }),
    ).resolves.toMatchObject({ status: "swept" });
    expect(transfer).toHaveBeenCalledOnce();
  });

  it("does not duplicate a signed failed sweep before its expired nonce is replaced", async () => {
    const fixture = await makeFixture({ ceilingAtomic: "10000000" });
    const originalNonce = `0x${"66".repeat(32)}` as const;
    const replacementNonce = `0x${"77".repeat(32)}` as const;
    const ceilingNonce = `0x${"88".repeat(32)}` as const;
    const settledNonces: string[] = [];
    let originalExpired = false;
    const authorizationState = vi.fn(async () =>
      originalExpired ? ("expired" as const) : ("pending" as const),
    );
    const transfer = vi.fn<CeilingTransfer>(async (args) => {
      if (args.nonce === originalNonce) {
        await appendTransferJournal(fixture.home, originalNonce, OWNER);
        throw new TransferError("relay_limit", "The signed authorization was rejected.");
      }
      const nonce = args.nonce ?? args.resume;
      if (nonce !== undefined) settledNonces.push(nonce);
      return transferResult(args.from, args.to, args.amountUsd);
    });

    const failed = await executeMovement(
      {
        reason: "sweep",
        from: "agent",
        network: BASE_MAINNET_CAIP2,
        legs: [{ to: OWNER, amountUsd: "10.00", purpose: "sweep" }],
      },
      {
        home: fixture.home,
        store: fixture.store,
        secrets: fixture.args.secrets,
        apiBase: API_BASE,
        transfer,
        authorizationState,
        addressReader: fixture.args.addressReader,
        randomId: () => "mv_failedsweep1",
        randomNonce: () => originalNonce,
      },
    );
    expect(failed.legs).toMatchObject([
      { status: "failed", nonce: originalNonce, reason: "relay_limit" },
    ]);

    await expect(
      sweepAboveCeiling({
        ...fixture.args,
        balanceReader: balanceReader(20_000_000n),
        transfer,
        authorizationState,
        randomNonce: () => ceilingNonce,
      }),
    ).resolves.toMatchObject({ status: "skipped", reason: "unfinished_movement" });
    expect(settledNonces).toEqual([]);

    originalExpired = true;
    const resumed = await executeMovement(
      { resume: "mv_failedsweep1" },
      {
        home: fixture.home,
        store: fixture.store,
        secrets: fixture.args.secrets,
        apiBase: API_BASE,
        transfer,
        authorizationState,
        addressReader: fixture.args.addressReader,
        randomNonce: () => replacementNonce,
      },
    );

    expect(resumed.legs).toMatchObject([{ status: "sent", nonce: replacementNonce }]);
    expect(settledNonces).toEqual([replacementNonce]);
    expect(transfer.mock.calls.some(([args]) => args.nonce === ceilingNonce)).toBe(false);
  });

  it.each([
    { perDayAtomic: "8000000", expectedAmountUsd: "12" },
    { perDayAtomic: "2000000", expectedAmountUsd: "15" },
  ])(
    "keeps the effective ceiling at max(5 USDC, $perDayAtomic atomic per day)",
    async ({ perDayAtomic, expectedAmountUsd }) => {
      const fixture = await makeFixture({ perDayAtomic });
      const transfer = successfulTransfer();

      const result = await sweepAboveCeiling({
        ...fixture.args,
        balanceReader: balanceReader(20_000_000n),
        transfer,
      });

      expect(result).toMatchObject({ status: "swept", amountUsd: expectedAmountUsd });
      expect(transfer).toHaveBeenCalledWith(
        expect.objectContaining({ amountUsd: expectedAmountUsd }),
      );
    },
  );

  it("does not send below 0.10 USDC and sends exactly 0.10 USDC", async () => {
    const below = await makeFixture();
    const belowTransfer = successfulTransfer();
    await expect(
      sweepAboveCeiling({
        ...below.args,
        balanceReader: balanceReader(5_099_999n),
        transfer: belowTransfer,
      }),
    ).resolves.toMatchObject({ status: "skipped", reason: "below_threshold" });
    expect(belowTransfer).not.toHaveBeenCalled();

    const exact = await makeFixture();
    const exactTransfer = successfulTransfer();
    await expect(
      sweepAboveCeiling({
        ...exact.args,
        balanceReader: balanceReader(5_100_000n),
        transfer: exactTransfer,
      }),
    ).resolves.toMatchObject({ status: "swept", amountUsd: "0.1" });
    expect(exactTransfer).toHaveBeenCalledWith(expect.objectContaining({ amountUsd: "0.1" }));
  });

  it("refuses a tampered stored owner, warns, and sends nothing", async () => {
    const fixture = await makeFixture({ serverOwner: OTHER_OWNER });
    const warn = vi.fn();
    const transfer = successfulTransfer();

    await expect(
      sweepAboveCeiling({
        ...fixture.args,
        balanceReader: balanceReader(20_000_000n),
        transfer,
        warn,
      }),
    ).resolves.toMatchObject({ status: "failed", reason: "owner_mismatch" });

    expect(transfer).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("stored owner differs"));
    await expect(readAuditLog(fixture.home)).resolves.toContainEqual(
      expect.objectContaining({
        event: "ceiling.sweep_failed",
        wallet: "agent",
        detail: "reason=owner_mismatch",
      }),
    );
  });

  it("allows only one serial sweep per account in ten minutes", async () => {
    let now = NOW;
    const fixture = await makeFixture({ now: () => now });
    const transfer = successfulTransfer();
    const args = {
      ...withoutAccount(fixture.args),
      balanceReader: balanceReader(20_000_000n),
      transfer,
    };

    const first = await sweepAllAboveCeiling(args);
    const second = await sweepAllAboveCeiling(args);
    expect(first).toMatchObject([{ account: "agent", status: "swept" }]);
    expect(second).toEqual([{ account: "agent", status: "skipped", reason: "throttled" }]);
    expect(transfer).toHaveBeenCalledTimes(1);

    now += 10 * 60 * 1_000;
    await expect(sweepAllAboveCeiling(args)).resolves.toMatchObject([
      { account: "agent", status: "swept" },
    ]);
    expect(transfer).toHaveBeenCalledTimes(2);
  });

  it("resumes the same sweep nonce after an unknown result instead of signing another authorization", async () => {
    let now = NOW;
    const fixture = await makeFixture({ now: () => now });
    const nonce = `0x${"66".repeat(32)}` as const;
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started!: () => void;
    const transferStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const transfer = vi.fn<CeilingTransfer>(async (args) => {
      if (args.nonce !== undefined) {
        started();
        await blocked;
      }
      return { ...transferResult(args.from, args.to, args.amountUsd), status: "unknown" };
    });
    const args = {
      ...fixture.args,
      balanceReader: balanceReader(6_000_000n),
      transfer,
      randomNonce: () => nonce,
    };

    const first = sweepAboveCeiling(args);
    await transferStarted;
    now += 10 * 60 * 1_000;
    const second = sweepAboveCeiling(args);
    release();

    await expect(first).resolves.toMatchObject({ status: "unknown" });
    await expect(second).resolves.toMatchObject({ status: "unknown" });
    expect(transfer).toHaveBeenCalledTimes(2);
    expect(transfer.mock.calls[0]?.[0]).toMatchObject({ nonce });
    expect(transfer.mock.calls[0]?.[0].resume).toBeUndefined();
    expect(transfer.mock.calls[1]?.[0]).toMatchObject({ resume: nonce });
    expect(transfer.mock.calls[1]?.[0].nonce).toBeUndefined();
  });

  it("counts a failed transfer as a sweep attempt for the ten-minute guard", async () => {
    const fixture = await makeFixture();
    const transfer = vi.fn<CeilingTransfer>(async () => {
      throw new TransferError("relay_failed", "relay failed");
    });
    const args = {
      ...fixture.args,
      balanceReader: balanceReader(20_000_000n),
      transfer,
    };

    await expect(sweepAboveCeiling(args)).resolves.toMatchObject({
      status: "failed",
      reason: "relay_failed",
    });
    await expect(sweepAboveCeiling(args)).resolves.toEqual({
      account: "agent",
      status: "skipped",
      reason: "throttled",
    });
    expect(transfer).toHaveBeenCalledTimes(1);
  });

  it("skips unlinked and revoked accounts", async () => {
    const fixture = await makeFixture({
      accounts: [
        { name: "unlinked", linked: false },
        { name: "revoked", linked: true },
      ],
      siblingStatus: "revoked",
    });
    const transfer = successfulTransfer();

    await expect(
      sweepAllAboveCeiling({
        ...withoutAccount(fixture.args),
        balanceReader: balanceReader(20_000_000n),
        transfer,
      }),
    ).resolves.toEqual([
      { account: "unlinked", status: "skipped", reason: "not_linked" },
      { account: "revoked", status: "skipped", reason: "revoked" },
    ]);
    expect(transfer).not.toHaveBeenCalled();
  });

  it("skips an account when the linked server has no known owner", async () => {
    const fixture = await makeFixture({ serverOwner: null });
    const transfer = successfulTransfer();

    await expect(
      sweepAboveCeiling({
        ...fixture.args,
        balanceReader: balanceReader(20_000_000n),
        transfer,
      }),
    ).resolves.toEqual({
      account: "agent",
      status: "skipped",
      reason: "no_known_owner",
    });
    expect(transfer).not.toHaveBeenCalled();
  });

  it("disables automatic sweeping when the ceiling is off", async () => {
    const fixture = await makeFixture({ ceilingAtomic: null });
    const readBalance = balanceReader(20_000_000n);
    const transfer = successfulTransfer();

    await expect(
      sweepAboveCeiling({ ...fixture.args, balanceReader: readBalance, transfer }),
    ).resolves.toEqual({ account: "agent", status: "skipped", reason: "ceiling_off" });
    expect(readBalance).not.toHaveBeenCalled();
    expect(transfer).not.toHaveBeenCalled();
  });

  it("uses sweepTarget for the exact owner recipient, sweep purpose, a fresh balance, and audit", async () => {
    const fixture = await makeFixture();
    const readBalance = vi
      .fn<CeilingBalanceReader>()
      .mockResolvedValueOnce(20_000_000n)
      .mockResolvedValueOnce(19_000_000n);
    const transfer = successfulTransfer();

    expect(sweepTarget({ account: "agent", owner: OWNER })).toBe(OWNER);
    const result = await sweepAboveCeiling({
      ...fixture.args,
      balanceReader: readBalance,
      transfer,
    });

    expect(readBalance).toHaveBeenCalledTimes(2);
    expect(transfer).toHaveBeenCalledWith(
      expect.objectContaining({
        from: "agent",
        to: sweepTarget({ account: "agent", owner: OWNER }),
        amountUsd: "14",
        network: "base",
        purpose: "sweep",
      }),
    );
    expect(result).toMatchObject({ status: "swept", amountUsd: "14", txHash: TX_HASH });
    await expect(readAuditLog(fixture.home)).resolves.toContainEqual(
      expect.objectContaining({ event: "ceiling.swept", wallet: "agent", owner: OWNER }),
    );
  });

  it("rechecks the effective ceiling at the signer boundary", async () => {
    const fixture = await makeFixture({ perDayAtomic: "2000000" });
    const signTypedData = vi.fn();
    const transfer = vi.fn<CeilingTransfer>(async (args) => {
      await fixture.store.setSpendCaps("agent", {
        perCallAtomic: "100000",
        perDayAtomic: "8000000",
      });
      try {
        await args.unlock!("agent");
      } catch {
        throw new TransferError("signing_failed", "policy changed before signing");
      }
      return transferResult(args.from, args.to, args.amountUsd);
    });

    await expect(
      sweepAboveCeiling({
        ...fixture.args,
        balanceReader: balanceReader(20_000_000n),
        transfer,
        unlock: async () => ({ address: ACCOUNT_ADDRESS, signTypedData }),
      }),
    ).resolves.toMatchObject({ status: "failed", reason: "signing_failed" });

    expect(signTypedData).not.toHaveBeenCalled();
    expect(transfer).toHaveBeenCalledWith(expect.objectContaining({ amountUsd: "15" }));
  });

  it("cannot reach signing after its deadline aborts during transfer discovery", async () => {
    const fixture = await makeFixture();
    const controller = new AbortController();
    const signTypedData = vi.fn();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started!: () => void;
    const transferStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const transfer = vi.fn<CeilingTransfer>(async (args) => {
      started();
      await blocked;
      await args.unlock!("agent");
      return transferResult(args.from, args.to, args.amountUsd);
    });
    const result = sweepAboveCeiling({
      ...fixture.args,
      balanceReader: balanceReader(20_000_000n),
      transfer,
      signal: controller.signal,
      unlock: async () => ({ address: ACCOUNT_ADDRESS, signTypedData }),
    });
    await transferStarted;
    controller.abort();
    release();

    await expect(result).resolves.toMatchObject({ status: "failed", reason: "aborted" });
    expect(signTypedData).not.toHaveBeenCalled();
  });

  it("returns transfer failures and audits only their reason code", async () => {
    const fixture = await makeFixture();
    const transfer = vi.fn<CeilingTransfer>(async () => {
      throw new TransferError("relay_failed", "relay secret must not reach the audit log");
    });

    await expect(
      sweepAboveCeiling({
        ...fixture.args,
        balanceReader: balanceReader(20_000_000n),
        transfer,
      }),
    ).resolves.toEqual({ account: "agent", status: "failed", reason: "relay_failed" });
    const audit = await readAuditLog(fixture.home);
    expect(audit).toContainEqual(
      expect.objectContaining({
        event: "ceiling.sweep_failed",
        wallet: "agent",
        detail: "reason=relay_failed",
      }),
    );
    expect(JSON.stringify(audit)).not.toContain("relay secret");
  });

  it("reports when the per-day cap raises the configured ceiling floor", () => {
    expect(effectiveCeiling(5_000_000n, 8_000_000n)).toBe(8_000_000n);
    expect(effectiveCeiling(5_000_000n, 2_000_000n)).toBe(5_000_000n);
    expect(effectiveCeiling(5_000_000n, null)).toBe(5_000_000n);
    expect(effectiveCeiling(null, 8_000_000n)).toBeNull();
    expect(ceilingFloorApplies(5_000_000n, 8_000_000n)).toBe(true);
    expect(ceilingFloorApplies(5_000_000n, 2_000_000n)).toBe(false);
    expect(ceilingFloorApplies(5_000_000n, null)).toBe(false);
    expect(ceilingFloorApplies(null, 8_000_000n)).toBe(false);
  });

  it("routes a new sweep to its resolved parent and persists that target", async () => {
    const fixture = await makeFixture();
    const parent = { account: "treasury" as const, address: TREASURY };
    const resolveParent = vi.fn(async () => parent);
    const transfer = vi.fn<CeilingTransfer>(async (args) => {
      expect(fixture.store.ceilingSweepPending("agent")).toMatchObject({ target: TREASURY });
      return transferResult(args.from, args.to, args.amountUsd);
    });

    expect(sweepTarget({ account: "agent", owner: OWNER, parent })).toBe(TREASURY);
    await expect(
      sweepAboveCeiling({
        ...fixture.args,
        balanceReader: balanceReader(6_000_000n),
        resolveParent,
        transfer,
      }),
    ).resolves.toMatchObject({ status: "swept", amountUsd: "1" });

    expect(resolveParent).toHaveBeenCalledWith("agent");
    expect(transfer).toHaveBeenCalledWith(
      expect.objectContaining({
        to: TREASURY,
        sweepParent: TREASURY,
        purpose: "sweep",
      }),
    );
  });

  it("resumes a journaled pending sweep to its stored target after the parent changes", async () => {
    const fixture = await makeFixture();
    const nonce = `0x${"77".repeat(32)}` as const;
    await fixture.store.updateCeilingSweepPending("agent", () => ({
      owner: OWNER,
      target: TREASURY,
      amountAtomic: "1000000",
      nonce,
      createdAt: new Date(NOW).toISOString(),
      status: "planned",
    }));
    await appendTransferJournal(fixture.home, nonce, TREASURY);
    const transfer = successfulTransfer();

    await expect(
      sweepAboveCeiling({
        ...fixture.args,
        balanceReader: balanceReader(6_000_000n),
        resolveParent: async () => ({ account: "new-treasury", address: OTHER_TREASURY }),
        transfer,
      }),
    ).resolves.toMatchObject({ status: "swept", amountUsd: "1" });

    expect(transfer).toHaveBeenCalledWith(
      expect.objectContaining({
        to: TREASURY,
        sweepParent: TREASURY,
        resume: nonce,
      }),
    );
    expect(transfer.mock.calls[0]?.[0].nonce).toBeUndefined();
  });

  it("drops an unsigned stale plan and replans it to the current parent", async () => {
    const fixture = await makeFixture();
    const staleNonce = `0x${"88".repeat(32)}` as const;
    const newNonce = `0x${"99".repeat(32)}` as const;
    await fixture.store.updateCeilingSweepPending("agent", () => ({
      owner: OWNER,
      target: TREASURY,
      amountAtomic: "1000000",
      nonce: staleNonce,
      createdAt: new Date(NOW).toISOString(),
      status: "planned",
    }));
    const transfer = vi.fn<CeilingTransfer>(async (args) => {
      expect(fixture.store.ceilingSweepPending("agent")).toMatchObject({
        target: OTHER_TREASURY,
        nonce: newNonce,
      });
      return transferResult(args.from, args.to, args.amountUsd);
    });

    await expect(
      sweepAboveCeiling({
        ...fixture.args,
        balanceReader: balanceReader(6_000_000n),
        resolveParent: async () => ({ account: "new-treasury", address: OTHER_TREASURY }),
        randomNonce: () => newNonce,
        transfer,
      }),
    ).resolves.toMatchObject({ status: "swept", amountUsd: "1" });

    expect(transfer).toHaveBeenCalledTimes(1);
    expect(transfer).toHaveBeenCalledWith(
      expect.objectContaining({
        to: OTHER_TREASURY,
        sweepParent: OTHER_TREASURY,
        nonce: newNonce,
      }),
    );
    expect(transfer.mock.calls[0]?.[0].resume).toBeUndefined();
  });

  it("parses an old pending sweep without a target and sends it to the owner", async () => {
    const fixture = await makeFixture();
    const nonce = `0x${"aa".repeat(32)}` as const;
    await fixture.store.updateCeilingSweepPending("agent", () => ({
      owner: OWNER,
      amountAtomic: "1000000",
      nonce,
      createdAt: new Date(NOW).toISOString(),
      status: "planned",
    }));
    expect(fixture.store.ceilingSweepPending("agent")).toEqual(
      expect.not.objectContaining({ target: expect.anything() }),
    );
    const transfer = successfulTransfer();

    await expect(
      sweepAboveCeiling({
        ...fixture.args,
        balanceReader: balanceReader(6_000_000n),
        transfer,
      }),
    ).resolves.toMatchObject({ status: "swept", amountUsd: "1" });

    expect(transfer).toHaveBeenCalledWith(
      expect.objectContaining({ to: OWNER, nonce, purpose: "sweep" }),
    );
    expect(transfer.mock.calls[0]?.[0].sweepParent).toBeUndefined();
  });
});

type FixtureOptions = {
  perDayAtomic?: string;
  ceilingAtomic?: string | null;
  serverOwner?: `0x${string}` | null;
  siblingStatus?: "active" | "revoked";
  now?: () => number;
  accounts?: Array<{ name: string; linked: boolean }>;
};

async function makeFixture(options: FixtureOptions = {}) {
  const home = await mkdtemp(join(tmpdir(), "vapi-ceiling-"));
  temporaryDirectories.push(home);
  const link: AgentLink = {
    apiBase: API_BASE,
    clientId: "agent_client",
    owner: OWNER,
    label: "agent",
    scopes: ["mcp:call"],
    linkedAt: "2026-09-29T09:00:00.000Z",
  };
  const accounts = options.accounts ?? [{ name: "agent", linked: true }];
  await writeFile(
    join(home, "wallets.json"),
    `${JSON.stringify(
      {
        version: 1,
        default: accounts[0]?.name,
        wallets: Object.fromEntries(
          accounts.map(({ name, linked }) => [
            name,
            {
              createdAt: "2026-09-29T09:00:00.000Z",
              spendCaps: {
                perCallAtomic: "100000",
                perDayAtomic: options.perDayAtomic ?? "2000000",
              },
              ceilingAtomic:
                options.ceilingAtomic === undefined ? "5000000" : options.ceilingAtomic,
              ...(linked ? { link } : {}),
            },
          ]),
        ),
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  const secrets = memorySecretStore();
  const store = await WalletStore.open(home, { secrets });
  const serverOwner = options.serverOwner === undefined ? OWNER : options.serverOwner;
  const fetchSiblingsImpl = vi.fn<CeilingSiblingsFetcher>(async ({ account }) => ({
    owner: serverOwner,
    siblings: [sibling(account, options.siblingStatus ?? "active")],
    source: { account },
  }));
  const now = options.now ?? (() => NOW);
  const args: SweepAboveCeilingArgs = {
    store,
    secrets,
    apiBase: API_BASE,
    account: (accounts[0]?.name ?? "agent") as SweepAboveCeilingArgs["account"],
    addressReader: async () => ACCOUNT_ADDRESS,
    fetchSiblingsImpl,
    now,
    auditHome: home,
  };
  return { home, store, args, fetchSiblingsImpl };
}

function sibling(name: string, status: "active" | "revoked"): Sibling {
  return {
    name,
    address: ACCOUNT_ADDRESS,
    device: "test-device",
    status,
    allowance: { routerPerDayUsd: null, perCallUsd: null, perDayUsd: null },
    self: true,
  };
}

function balanceReader(balance: bigint) {
  return vi.fn<CeilingBalanceReader>(async () => balance);
}

function successfulTransfer() {
  return vi.fn<CeilingTransfer>(async (args) => transferResult(args.from, args.to, args.amountUsd));
}

function transferResult(from: string, to: string, amountUsd: string | number): TransferResult {
  return {
    status: "sent",
    from: from as TransferResult["from"],
    to: getAddress(to),
    toName: "owner",
    toKind: "owner",
    amountUsd: String(amountUsd),
    amountAtomic: "0",
    network: "eip155:8453",
    txHash: TX_HASH,
    nonce: `0x${"55".repeat(32)}`,
    replayed: false,
  };
}

async function appendTransferJournal(
  home: string,
  nonce: `0x${string}`,
  target: `0x${string}`,
): Promise<void> {
  await appendReceipt(
    {
      id: "journaled-ceiling-sweep",
      timestamp: new Date(NOW).toISOString(),
      kind: "transfer",
      wallet: "agent",
      resourceUrl: `${API_BASE}/api/agents/relay-transfer`,
      method: "POST",
      quote: { network: "eip155:8453", amountAtomic: "1000000", payTo: target },
      payer: ACCOUNT_ADDRESS,
      transfer: {
        to: target,
        toName: "treasury",
        toKind: "account",
        amountAtomic: "1000000",
        network: "eip155:8453",
        nonce,
        status: "unknown",
        txHash: null,
        replayed: false,
        request: {
          authorization: {
            from: ACCOUNT_ADDRESS,
            to: target,
            value: "1000000",
            validAfter: "0",
            validBefore: "9999999999",
            nonce,
          },
          signature: "0x12",
        },
      },
      settlement: { outcome: "unknown" },
    },
    getVapiPaths(home).receipts,
    { wallet: "agent" },
  );
}

function withoutAccount(args: SweepAboveCeilingArgs): Omit<SweepAboveCeilingArgs, "account"> {
  const rest: Partial<SweepAboveCeilingArgs> = { ...args };
  delete rest.account;
  return rest as Omit<SweepAboveCeilingArgs, "account">;
}

function memorySecretStore(): SecretStore {
  return {
    available: true,
    platform: "darwin",
    description: "test",
    async get() {
      return undefined;
    },
    async has() {
      return false;
    },
    async set() {},
    async remove() {
      return false;
    },
  };
}
