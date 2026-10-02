import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { getAddress, type Hex } from "viem";

import type { DeviceLinkStart } from "./agent-link.js";
import { AllocationError, parseUsdCents } from "./allocation.js";
import { readMovement } from "./movement.js";
import { createRunBudget } from "./run-budget.js";
import type { SecretStore } from "./secret-store.js";
import {
  allocateFromTreasury,
  readDelegationRecord,
  rebalanceSwarm,
  treasuryRequestMovementId,
  writeDelegationRecord,
  type DelegationRecord,
  type SwarmCapitalDeps,
} from "./swarm-capital.js";
import { setupSwarm, withSwarmLock, writeSwarm, type SwarmFile } from "./swarm.js";
import type { TransferArgs, TransferNetwork, TransferResult } from "./transfer.js";
import { WalletStore } from "./wallet-store.js";
import { BASE_MAINNET_CAIP2 } from "./x402-networks.js";

const NOW = Date.parse("2026-09-29T10:00:00.000Z");
const OWNER = "0x1111111111111111111111111111111111111111" as const;
const API_BASE = "https://api.vapinetwork.ai";
const PHRASE = "test test test test test test test test test test test junk";
const homes: string[] = [];

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

describe("treasury allocation", () => {
  it("records and sends one allocation while consuming the shared draw", async () => {
    const fixture = await allocationFixture();
    const draw = createRunBudget({ id: "run_allocate", limitAtomic: 1_000_000n });

    const result = await allocateFromTreasury(
      {
        name: "team",
        member: "team-lead-1",
        amountUsd: "0.50",
        reason: "allocate",
        draw,
      },
      fixture.deps,
    );

    expect(result).toMatchObject({
      status: "sent",
      requestedUsd: "0.50",
      sentUsd: "0.50",
      unknownUsd: "0.00",
      blocked: [],
      movement: {
        reason: "allocate",
        resumed: false,
        complete: true,
        legs: [
          {
            from: "team-treasury",
            to: "team-lead-1",
            amountUsd: "0.50",
            purpose: "send",
            status: "sent",
          },
        ],
      },
    });
    expect(await movementFiles(fixture.home)).toHaveLength(1);
    await expect(readMovement(fixture.home, result.movementId!)).resolves.toMatchObject({
      reason: "allocate",
      treasury: "team-treasury",
      legs: [
        {
          from: "team-treasury",
          to: "team-lead-1",
          purpose: "send",
          status: "sent",
        },
      ],
    });
    expect(draw.spentAtomic()).toBe(500_000n);
  });

  it("returns a finished request without sending or charging the draw twice", async () => {
    const fixture = await allocationFixture();
    const draw = createRunBudget({ id: "run_finished_retry", limitAtomic: 1_000_000n });
    const request = {
      name: "team",
      member: "team-lead-1",
      amountUsd: "0.50",
      reason: "allocate" as const,
      requestId: "run-1:tool-1",
      draw,
    };

    const first = await allocateFromTreasury(request, fixture.deps);
    const spentAfterFirst = draw.spentAtomic();
    const retried = await allocateFromTreasury(request, fixture.deps);

    expect(first).toMatchObject({ status: "sent", sentUsd: "0.50" });
    expect(retried).toMatchObject({
      status: "sent",
      movementId: first.movementId,
      sentUsd: "0.50",
      movement: { resumed: true, complete: true },
    });
    expect(fixture.transfer).toHaveBeenCalledOnce();
    expect(draw.spentAtomic()).toBe(spentAfterFirst);
    expect(draw.reservedAtomic(first.movementId!)).toBe(500_000n);
  });

  it("resumes the deterministic unfinished request with one nonce and one draw reservation", async () => {
    const fixture = await allocationFixture();
    const draw = createRunBudget({ id: "run_unfinished_retry", limitAtomic: 1_000_000n });
    const attemptedNonces: string[] = [];
    fixture.transfer
      .mockImplementationOnce(async (args) => {
        const nonce = args.nonce ?? args.resume;
        if (nonce === undefined) throw new Error("A transfer nonce is required.");
        attemptedNonces.push(nonce);
        return { ...transferResult(args), status: "unknown", txHash: null };
      })
      .mockImplementationOnce(async (args) => {
        const nonce = args.nonce ?? args.resume;
        if (nonce === undefined) throw new Error("A transfer nonce is required.");
        attemptedNonces.push(nonce);
        return await fixture.send(args);
      });
    const request = {
      name: "team",
      member: "team-lead-1",
      amountUsd: "1.00",
      reason: "allocate" as const,
      requestId: "run-2:tool-1",
      draw,
    };

    const first = await allocateFromTreasury(request, fixture.deps);
    const retried = await allocateFromTreasury(request, fixture.deps);

    expect(first).toMatchObject({ status: "incomplete", unknownUsd: "1.00" });
    expect(retried).toMatchObject({
      status: "resumed",
      movementId: first.movementId,
      sentUsd: "1.00",
    });
    expect(first.movementId).toBe(treasuryRequestMovementId("team", request.requestId));
    expect(new Set(attemptedNonces)).toHaveLength(1);
    expect(fixture.transfer).toHaveBeenCalledTimes(2);
    expect(draw.reservedAtomic(first.movementId!)).toBe(1_000_000n);
    expect(draw.spentAtomic()).toBe(1_000_000n);
  });

  it.each([
    ["amount", { member: "team-lead-1", amountUsd: "0.25", reason: "allocate" as const }],
    ["member", { member: "team-helper-1", amountUsd: "0.50", reason: "allocate" as const }],
    ["reason", { member: "team-lead-1", amountUsd: "0.50", reason: "delegate" as const }],
  ])("rejects a conflicting %s for the same request id", async (_label, conflict) => {
    const fixture = await allocationFixture();
    const draw = createRunBudget({ id: "run_conflict", limitAtomic: 1_000_000n });
    const requestId = "run-3:tool-1";
    const first = await allocateFromTreasury(
      {
        name: "team",
        member: "team-lead-1",
        amountUsd: "0.50",
        reason: "allocate",
        requestId,
        draw,
      },
      fixture.deps,
    );
    const spentAfterFirst = draw.spentAtomic();
    fixture.transfer.mockClear();

    await expect(
      allocateFromTreasury({ name: "team", requestId, draw, ...conflict }, fixture.deps),
    ).rejects.toMatchObject({
      code: "request_conflict",
      message: expect.stringContaining(first.movementId!),
    });
    expect(fixture.transfer).not.toHaveBeenCalled();
    expect(draw.spentAtomic()).toBe(spentAfterFirst);
  });

  it("refuses a treasury request whose referenced movement file is missing", async () => {
    const fixture = await allocationFixture();
    const requestId = "run-4:tool-1";
    const movementId = treasuryRequestMovementId("team", requestId);
    const draw = createRunBudget({ id: "run_recorded_retry", limitAtomic: 500_000n });
    draw.reserve(500_000n, movementId);
    await writeTreasuryRequestFixture(fixture.home, {
      v: 1,
      requestId,
      swarm: "team",
      member: "team-lead-1",
      reason: "allocate",
      amountUsd: "0.50",
      movementId,
      createdAt: new Date(NOW).toISOString(),
      blocked: [],
    });

    await expect(
      allocateFromTreasury(
        {
          name: "team",
          member: "team-lead-1",
          amountUsd: "0.50",
          reason: "allocate",
          requestId,
          draw,
        },
        fixture.deps,
      ),
    ).rejects.toMatchObject({
      code: "invalid_swarm",
      message: expect.stringContaining("vapi swarm status team"),
    });

    expect(fixture.transfer).not.toHaveBeenCalled();
    expect(await movementFiles(fixture.home)).toEqual([]);
    expect(draw.reservedAtomic(movementId)).toBe(500_000n);
  });

  it("preserves a crash-window draw reservation when its movement is missing", async () => {
    const fixture = await allocationFixture();
    const requestId = "run-4:tool-2";
    const movementId = treasuryRequestMovementId("team", requestId);
    const draw = createRunBudget({ id: "run_recorded_retry_small", limitAtomic: 400_000n });
    draw.reserve(250_000n, movementId);
    await writeTreasuryRequestFixture(fixture.home, {
      v: 1,
      requestId,
      swarm: "team",
      member: "team-lead-1",
      reason: "allocate",
      amountUsd: "0.50",
      movementId,
      createdAt: new Date(NOW).toISOString(),
      blocked: [{ to: "team-lead-1", amountUsd: "0.25", reason: "recipient_ceiling" }],
    });

    await expect(
      allocateFromTreasury(
        {
          name: "team",
          member: "team-lead-1",
          amountUsd: "0.50",
          reason: "allocate",
          requestId,
          draw,
        },
        fixture.deps,
      ),
    ).rejects.toMatchObject({
      code: "invalid_swarm",
      message: expect.stringContaining("vapi swarm fund team"),
    });
    expect(draw.reservedAtomic(movementId)).toBe(250_000n);
    expect(draw.spentAtomic()).toBe(250_000n);
    expect(await movementFiles(fixture.home)).toEqual([]);
    expect(fixture.transfer).not.toHaveBeenCalled();
  });

  it("treats different request ids as different draw intents", async () => {
    const fixture = await allocationFixture();
    const draw = createRunBudget({ id: "run_distinct", limitAtomic: 1_000_000n });
    const base = {
      name: "team",
      member: "team-lead-1",
      amountUsd: "0.50",
      reason: "allocate" as const,
      draw,
    };

    const first = await allocateFromTreasury({ ...base, requestId: "run-5:tool-1" }, fixture.deps);
    const second = await allocateFromTreasury({ ...base, requestId: "run-5:tool-2" }, fixture.deps);

    expect(first.movementId).toBe(treasuryRequestMovementId("team", "run-5:tool-1"));
    expect(second.movementId).toBe(treasuryRequestMovementId("team", "run-5:tool-2"));
    expect(first.movementId).not.toBe(second.movementId);
    expect(await movementFiles(fixture.home)).toHaveLength(2);
    expect(fixture.transfer).toHaveBeenCalledTimes(2);
    expect(draw.spentAtomic()).toBe(1_000_000n);

    const smallFixture = await allocationFixture();
    const smallDraw = createRunBudget({ id: "run_distinct_small", limitAtomic: 750_000n });
    const smallBase = { ...base, draw: smallDraw };
    await allocateFromTreasury({ ...smallBase, requestId: "run-6:tool-1" }, smallFixture.deps);
    await expect(
      allocateFromTreasury({ ...smallBase, requestId: "run-6:tool-2" }, smallFixture.deps),
    ).rejects.toMatchObject({ code: "draw_exceeded" });
    expect(await movementFiles(smallFixture.home)).toHaveLength(1);
    expect(smallFixture.transfer).toHaveBeenCalledOnce();
    expect(smallDraw.spentAtomic()).toBe(500_000n);
  });

  it("derives deterministic swarm-scoped treasury request movement ids", () => {
    expect(treasuryRequestMovementId("team", "request-1")).toBe("mv_aad023840611184a1af90600");
    expect(treasuryRequestMovementId("team", "request-1")).toBe(
      treasuryRequestMovementId("team", "request-1"),
    );
    expect(treasuryRequestMovementId("other", "request-1")).toBe("mv_a8913a8d3f1dcd44048c404b");
    expect(treasuryRequestMovementId("other", "request-1")).not.toBe(
      treasuryRequestMovementId("team", "request-1"),
    );
  });

  it.each(["", "x".repeat(513)])("rejects invalid request id %j", async (requestId) => {
    const fixture = await allocationFixture();

    await expect(
      allocateFromTreasury(
        {
          name: "team",
          member: "team-lead-1",
          amountUsd: "0.50",
          reason: "allocate",
          requestId,
        },
        fixture.deps,
      ),
    ).rejects.toMatchObject({ code: "invalid_swarm" });
    expect(fixture.transfer).not.toHaveBeenCalled();
  });

  it("refuses an unreadable treasury request record", async () => {
    const fixture = await allocationFixture();
    const requestId = "run-7:tool-1";
    const movementId = treasuryRequestMovementId("team", requestId);
    const directory = join(fixture.home, "runs", "requests");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, `${movementId}.json`), "not json\n", "utf8");

    await expect(
      allocateFromTreasury(
        {
          name: "team",
          member: "team-lead-1",
          amountUsd: "0.50",
          reason: "allocate",
          requestId,
        },
        fixture.deps,
      ),
    ).rejects.toMatchObject({ code: "invalid_swarm" });
    expect(fixture.transfer).not.toHaveBeenCalled();
  });

  it("records delegate as the movement reason", async () => {
    const fixture = await allocationFixture();

    const result = await allocateFromTreasury(
      {
        name: "team",
        member: "team-lead-1",
        amountUsd: "0.25",
        reason: "delegate",
      },
      fixture.deps,
    );

    expect(result).toMatchObject({ status: "sent", movement: { reason: "delegate" } });
    await expect(readMovement(fixture.home, result.movementId!)).resolves.toMatchObject({
      reason: "delegate",
    });
  });

  it("trims at the member ceiling and charges only the sent amount to the draw", async () => {
    const fixture = await allocationFixture();
    fixture.balances.set("team-lead-1", 9_800_000n);
    const draw = createRunBudget({ id: "run_ceiling", limitAtomic: 1_000_000n });

    const result = await allocateFromTreasury(
      {
        name: "team",
        member: "team-lead-1",
        amountUsd: "0.50",
        reason: "allocate",
        draw,
      },
      fixture.deps,
    );

    expect(result).toMatchObject({
      status: "sent",
      sentUsd: "0.20",
      unknownUsd: "0.00",
      blocked: [{ to: "team-lead-1", amountUsd: "0.30", reason: "recipient_ceiling" }],
      movement: { legs: [{ amountUsd: "0.20", status: "sent" }] },
    });
    expect(draw.spentAtomic()).toBe(200_000n);
  });

  it("returns blocked without creating a movement or consuming draw", async () => {
    const fixture = await allocationFixture();
    fixture.balances.set("team-lead-1", 10_000_000n);
    const draw = createRunBudget({ id: "run_blocked", limitAtomic: 1_000_000n });

    const result = await allocateFromTreasury(
      {
        name: "team",
        member: "team-lead-1",
        amountUsd: "0.50",
        reason: "allocate",
        draw,
      },
      fixture.deps,
    );

    expect(result).toMatchObject({
      status: "blocked",
      movementId: null,
      requestedUsd: "0.50",
      sentUsd: "0.00",
      unknownUsd: "0.00",
      blocked: [{ to: "team-lead-1", amountUsd: "0.50", reason: "recipient_ceiling" }],
    });
    expect(await movementFiles(fixture.home)).toEqual([]);
    expect(draw.spentAtomic()).toBe(0n);
    expect(fixture.transfer).not.toHaveBeenCalled();
  });

  it("rejects a draw that cannot cover the planned leg before movement creation", async () => {
    const fixture = await allocationFixture();
    const draw = createRunBudget({ id: "run_small", limitAtomic: 499_999n });

    await expect(
      allocateFromTreasury(
        {
          name: "team",
          member: "team-lead-1",
          amountUsd: "0.50",
          reason: "allocate",
          draw,
        },
        fixture.deps,
      ),
    ).rejects.toMatchObject({ code: "draw_exceeded" });
    expect(await movementFiles(fixture.home)).toEqual([]);
    expect(draw.spentAtomic()).toBe(0n);
    expect(fixture.transfer).not.toHaveBeenCalled();
  });

  it("resumes a crashed matching allocation with the same nonce and no second movement", async () => {
    const fixture = await allocationFixture();
    const draw = createRunBudget({ id: "run_crashed", limitAtomic: 1_000_000n });
    const attemptedNonces: string[] = [];
    const successfulNonces: string[] = [];
    let crash = true;
    fixture.transfer.mockImplementation(async (args) => {
      const nonce = args.nonce ?? args.resume;
      if (nonce === undefined) throw new Error("A transfer nonce is required.");
      attemptedNonces.push(nonce);
      if (crash) {
        crash = false;
        throw new Error("simulated allocation crash");
      }
      successfulNonces.push(nonce);
      return await fixture.send(args);
    });

    await expect(
      allocateFromTreasury(
        {
          name: "team",
          member: "team-lead-1",
          amountUsd: "1.00",
          reason: "allocate",
          draw,
        },
        fixture.deps,
      ),
    ).rejects.toThrow("simulated allocation crash");
    const filesAfterCrash = await movementFiles(fixture.home);
    expect(filesAfterCrash).toHaveLength(1);
    expect(draw.spentAtomic()).toBe(1_000_000n);

    const result = await allocateFromTreasury(
      {
        name: "team",
        member: "team-lead-1",
        amountUsd: "1.00",
        reason: "allocate",
        draw,
      },
      fixture.deps,
    );

    expect(result).toMatchObject({
      status: "resumed",
      sentUsd: "1.00",
      unknownUsd: "0.00",
      movement: { resumed: true, complete: true },
    });
    expect(attemptedNonces).toHaveLength(2);
    expect(new Set(attemptedNonces)).toEqual(new Set(successfulNonces));
    expect(successfulNonces).toHaveLength(1);
    expect(await movementFiles(fixture.home)).toEqual(filesAfterCrash);
    expect(fixture.balances.get("team-lead-1")).toBe(1_000_000n);
    expect(draw.spentAtomic()).toBe(1_000_000n);
  });

  it("does not resume a movement larger than the newly authorized request", async () => {
    const fixture = await allocationFixture();
    fixture.transfer.mockRejectedValueOnce(new Error("simulated allocation crash"));

    await expect(
      allocateFromTreasury(
        {
          name: "team",
          member: "team-lead-1",
          amountUsd: "1.00",
          reason: "allocate",
        },
        fixture.deps,
      ),
    ).rejects.toThrow("simulated allocation crash");
    const movement = (await movementFiles(fixture.home))[0]!;

    await expect(
      allocateFromTreasury(
        {
          name: "team",
          member: "team-lead-1",
          amountUsd: "0.01",
          reason: "allocate",
        },
        fixture.deps,
      ),
    ).rejects.toMatchObject({
      code: "movement_unfinished",
      message: expect.stringContaining(movement.slice(0, -5)),
    });
    expect(fixture.transfer).toHaveBeenCalledOnce();
  });

  it("retries an uncertain allocation with the same draw reservation", async () => {
    const fixture = await allocationFixture();
    const draw = createRunBudget({ id: "run_uncertain", limitAtomic: 1_000_000n });
    fixture.transfer
      .mockImplementationOnce(async (args) => ({
        ...transferResult(args),
        status: "unknown",
        txHash: null,
      }))
      .mockImplementationOnce(fixture.send);

    const first = await allocateFromTreasury(
      {
        name: "team",
        member: "team-lead-1",
        amountUsd: "1.00",
        reason: "allocate",
        draw,
      },
      fixture.deps,
    );
    const resumed = await allocateFromTreasury(
      {
        name: "team",
        member: "team-lead-1",
        amountUsd: "1.00",
        reason: "allocate",
        draw,
      },
      fixture.deps,
    );

    expect(first).toMatchObject({ status: "incomplete", unknownUsd: "1.00" });
    expect(resumed).toMatchObject({ status: "resumed", sentUsd: "1.00" });
    expect(fixture.transfer).toHaveBeenCalledTimes(2);
    expect(draw.spentAtomic()).toBe(1_000_000n);
  });

  it("blocks on an unrelated unfinished swarm movement", async () => {
    const fixture = await allocationFixture();
    const movementId = "mv_rebalance01";
    await writeMovementFixture(fixture.home, {
      id: movementId,
      reason: "rebalance",
      from: "team-treasury",
      treasury: "team-treasury",
      legs: [{ from: "team-treasury", to: "team-helper-1", status: "planned" }],
    });

    await expect(
      allocateFromTreasury(
        {
          name: "team",
          member: "team-lead-1",
          amountUsd: "1.00",
          reason: "allocate",
        },
        fixture.deps,
      ),
    ).rejects.toMatchObject({
      code: "movement_unfinished",
      message: expect.stringContaining(movementId),
    });
    expect(fixture.transfer).not.toHaveBeenCalled();
  });

  it("does not resume the owner's matching setup-policy allocation", async () => {
    const fixture = await allocationFixture();
    const movementId = "mv_ownerpolicy1";
    fixture.swarm.setupFunding = {
      amountUsd: "1.00",
      from: "main",
      status: "sent",
      policy: { strategy: "even", movementId, status: "planned" },
    };
    await writeSwarm(fixture.home, fixture.swarm);
    await writeMovementFixture(fixture.home, {
      id: movementId,
      reason: "allocate",
      from: "team-treasury",
      treasury: "team-treasury",
      legs: [{ from: "team-treasury", to: "team-lead-1", status: "planned" }],
    });

    await expect(
      allocateFromTreasury(
        {
          name: "team",
          member: "team-lead-1",
          amountUsd: "1.00",
          reason: "allocate",
        },
        fixture.deps,
      ),
    ).rejects.toMatchObject({
      code: "movement_unfinished",
      message: expect.stringContaining(movementId),
    });
    expect(fixture.transfer).not.toHaveBeenCalled();
  });

  it.each([
    ["treasury", "team-treasury", undefined, "member_not_found"],
    ["non-member", "main", undefined, "member_not_found"],
    ["unlinked member", "team-lead-1", "team-lead-1", "member_not_linked"],
  ])("rejects a %s recipient", async (_label, member, unlink, code) => {
    const fixture = await allocationFixture();
    if (unlink !== undefined) await fixture.store.clearLink(unlink);

    await expect(
      allocateFromTreasury(
        { name: "team", member, amountUsd: "0.50", reason: "allocate" },
        fixture.deps,
      ),
    ).rejects.toMatchObject({ code });
    expect(await movementFiles(fixture.home)).toEqual([]);
    expect(fixture.transfer).not.toHaveBeenCalled();
  });

  it.each(["0", "0.001", "-1", "abc"])(
    "rejects invalid amount %s before allocating",
    async (amountUsd) => {
      const fixture = await allocationFixture();

      const promise = allocateFromTreasury(
        { name: "team", member: "team-lead-1", amountUsd, reason: "allocate" },
        fixture.deps,
      );

      await expect(promise).rejects.toBeInstanceOf(AllocationError);
      await expect(promise).rejects.toMatchObject({ code: "invalid_amount" });
      expect(await movementFiles(fixture.home)).toEqual([]);
      expect(fixture.transfer).not.toHaveBeenCalled();
    },
  );

  it("releases the swarm lock after a return and after an error", async () => {
    const fixture = await allocationFixture();
    await allocateFromTreasury(
      {
        name: "team",
        member: "team-lead-1",
        amountUsd: "0.10",
        reason: "allocate",
      },
      fixture.deps,
    );
    let acquiredAfterReturn = false;
    await withSwarmLock(fixture.home, "team", async () => {
      acquiredAfterReturn = true;
    });

    const draw = createRunBudget({ id: "run_lock_error", limitAtomic: 0n });
    await expect(
      allocateFromTreasury(
        {
          name: "team",
          member: "team-helper-1",
          amountUsd: "0.10",
          reason: "allocate",
          draw,
        },
        fixture.deps,
      ),
    ).rejects.toMatchObject({ code: "draw_exceeded" });
    let acquiredAfterError = false;
    await withSwarmLock(fixture.home, "team", async () => {
      acquiredAfterError = true;
    });

    expect({ acquiredAfterReturn, acquiredAfterError }).toEqual({
      acquiredAfterReturn: true,
      acquiredAfterError: true,
    });
  });

  it("lets rebalance resume an unfinished delegate movement", async () => {
    const fixture = await allocationFixture();
    let crash = true;
    fixture.transfer.mockImplementation(async (args) => {
      if (crash) {
        crash = false;
        throw new Error("simulated delegate crash");
      }
      return await fixture.send(args);
    });

    await expect(
      allocateFromTreasury(
        {
          name: "team",
          member: "team-lead-1",
          amountUsd: "0.50",
          reason: "delegate",
        },
        fixture.deps,
      ),
    ).rejects.toThrow("simulated delegate crash");
    const files = await movementFiles(fixture.home);

    const result = await rebalanceSwarm({ name: "team" }, fixture.deps);

    expect(result).toMatchObject({
      status: "resumed",
      movement: { reason: "delegate", resumed: true, complete: true },
    });
    expect(await movementFiles(fixture.home)).toEqual(files);
    expect(fixture.transfer).toHaveBeenCalledTimes(2);
  });
});

describe("delegation records", () => {
  it("round-trips a private record and returns undefined when missing", async () => {
    const home = await mkdtemp(join(tmpdir(), "vapi-delegation-record-"));
    homes.push(home);
    const movementId = "mv_delegation-record-1";
    const record: DelegationRecord = {
      v: 1,
      movementId,
      requestId: "run-8:tool-1",
      swarm: "team",
      member: "team-helper-1",
      budgetUsd: "0.50",
      childRunId: "run_child-1",
      startedAt: new Date(NOW).toISOString(),
      result: {
        runId: "run_child-1",
        answer: "done",
        stoppedBecause: { reason: "finished" },
        spentUsd: 0.25,
        budgetUsd: 0.5,
      },
    };

    await expect(readDelegationRecord(home, "mv_missing-record")).resolves.toBeUndefined();
    await writeDelegationRecord(home, record);

    await expect(readDelegationRecord(home, movementId)).resolves.toEqual(record);
    const metadata = await stat(join(home, "runs", "delegations", `${movementId}.json`));
    expect(metadata.mode & 0o777).toBe(0o600);
  });

  it("refuses invalid delegation movement ids before building a path", async () => {
    const home = await mkdtemp(join(tmpdir(), "vapi-delegation-record-"));
    homes.push(home);

    await expect(readDelegationRecord(home, "../outside")).rejects.toMatchObject({
      code: "invalid_swarm",
    });
    await expect(
      writeDelegationRecord(home, {
        v: 1,
        movementId: "../outside",
        requestId: "run-9:tool-1",
        swarm: "team",
        member: "team-helper-1",
        budgetUsd: "0.50",
        childRunId: "run_child-1",
        startedAt: new Date(NOW).toISOString(),
      }),
    ).rejects.toMatchObject({ code: "invalid_swarm" });
  });
});

type AllocationFixture = {
  home: string;
  store: WalletStore;
  swarm: SwarmFile;
  balances: Map<string, bigint>;
  transfer: ReturnType<typeof vi.fn<(args: TransferArgs) => Promise<TransferResult>>>;
  send: (args: TransferArgs) => Promise<TransferResult>;
  deps: SwarmCapitalDeps;
};

async function allocationFixture(): Promise<AllocationFixture> {
  const home = await mkdtemp(join(tmpdir(), "vapi-swarm-allocate-"));
  homes.push(home);
  const values = new Map<string, string>();
  const secrets: SecretStore = {
    available: true,
    platform: "darwin",
    description: "test store",
    get: async (name) => values.get(name),
    has: async (name) => values.has(name),
    set: async (name, value) => {
      values.set(name, value);
    },
    remove: async (name) => values.delete(name),
  };
  const store = await WalletStore.open(home, { secrets, env: {}, now: () => new Date(NOW) });
  await store.create("main", "", { phrase: PHRASE });
  const setup = await setupSwarm({
    home,
    store,
    secrets,
    apiBase: API_BASE,
    name: "team",
    roles: ["lead", "helper"],
    strategy: "targets",
    surface: "cli",
    env: {},
    hostname: "Test Host",
    now: () => new Date(NOW),
    startDeviceLink: async (args) => linkStart(args.label),
    pollDeviceLink: async () => ({
      owner: OWNER,
      tokens: {
        accessToken: "private-access-token",
        refreshToken: "private-refresh-token",
        expiresAt: NOW + 3_600_000,
        scopes: ["mcp:call", "router.use"],
      },
    }),
  });
  const balances = new Map<string, bigint>([
    ["main", 0n],
    [setup.swarm.treasury.account, 20_000_000n],
    ...setup.swarm.members.map((member) => [member.account, 0n] as const),
  ]);
  const send = async (args: TransferArgs): Promise<TransferResult> => {
    const amountAtomic = parseUsdCents(args.amountUsd) * 10_000n;
    balances.set(args.from, (balances.get(args.from) ?? 0n) - amountAtomic);
    balances.set(args.to, (balances.get(args.to) ?? 0n) + amountAtomic);
    return transferResult(args);
  };
  const transfer = vi.fn<(args: TransferArgs) => Promise<TransferResult>>(send);
  let id = 0;
  let nonce = 0;
  const deps: SwarmCapitalDeps = {
    home,
    store,
    secrets,
    apiBase: API_BASE,
    balanceReader: async ({ account }) => balances.get(account) ?? 0n,
    transfer,
    now: () => NOW,
    randomId: () => `mv_allocate${String((id += 1)).padStart(2, "0")}`,
    randomNonce: () => `0x${(nonce += 1).toString(16).padStart(64, "0")}` as Hex,
  };
  return { home, store, swarm: setup.swarm, balances, transfer, send, deps };
}

function linkStart(label: string): DeviceLinkStart {
  return {
    clientId: `agent_${label}`,
    deviceCode: "private-device-code",
    userCode: "BCDF-GHJK",
    verificationUri: `${API_BASE}/link`,
    verificationUriComplete: `${API_BASE}/link?code=BCDF-GHJK`,
    expiresIn: 600,
    interval: 5,
    autoApproved: true,
  };
}

function transferResult(args: TransferArgs): TransferResult {
  const nonce = args.resume ?? args.nonce;
  if (nonce === undefined) throw new Error("A test transfer requires a nonce.");
  return {
    status: "sent",
    from: args.from,
    to: getAddress("0x2222222222222222222222222222222222222222"),
    toName: args.to,
    toKind: "account",
    amountUsd: String(args.amountUsd),
    amountAtomic: (parseUsdCents(args.amountUsd) * 10_000n).toString(),
    network: args.network as TransferNetwork,
    txHash: `0x${"ab".repeat(32)}`,
    nonce,
    replayed: args.resume !== undefined,
  };
}

async function movementFiles(home: string): Promise<string[]> {
  try {
    return (await readdir(join(home, "movements"))).filter((file) => file.endsWith(".json")).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function writeTreasuryRequestFixture(home: string, record: unknown): Promise<void> {
  const directory = join(home, "runs", "requests");
  await mkdir(directory, { recursive: true });
  const movementId = (record as { movementId: string }).movementId;
  await writeFile(join(directory, `${movementId}.json`), `${JSON.stringify(record, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

async function writeMovementFixture(
  home: string,
  input: {
    id: string;
    reason: "allocate" | "rebalance";
    from: string;
    treasury: string;
    legs: Array<{
      from: string;
      to: string;
      status: "planned";
    }>;
  },
): Promise<void> {
  const directory = join(home, "movements");
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, `${input.id}.json`),
    `${JSON.stringify(
      {
        v: 2,
        id: input.id,
        reason: input.reason,
        from: input.from,
        treasury: input.treasury,
        network: BASE_MAINNET_CAIP2,
        createdAt: new Date(NOW).toISOString(),
        legs: input.legs.map((leg, index) => ({
          ...leg,
          amountUsd: "1.00",
          purpose: "send",
          nonce: `0x${(index + 1).toString(16).padStart(64, "0")}`,
        })),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}
