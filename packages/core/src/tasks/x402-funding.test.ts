import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { getDefaultConfig } from "../config.js";
import { readSpendLedger, reserveSpend } from "../spend-policy.js";
import { missingTasksChain } from "./chain-port.js";
import type { TasksClient } from "./client.js";
import { taskMoney } from "./money.js";
import { type MoneySnapshot } from "./operation-support.js";
import { fundTaskWithX402 } from "./x402-funding.js";

const ID = "11111111-1111-4111-8111-111111111111";
const ESCROW = "0x2222222222222222222222222222222222222222";
const MILESTONE = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-10-08T12:00:00.000Z");
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(
  options: { amount?: string; payTo?: string; status?: number; ambiguous?: boolean } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "task-x402-"));
  roots.push(directory);
  const config = getDefaultConfig({});
  const account = privateKeyToAccount(`0x${"11".repeat(32)}`);
  const sign = vi.spyOn(account, "signTypedData");
  const offer = {
    scheme: "exact",
    network: "eip155:8453",
    amount: options.amount ?? "2500000",
    asset: config.networks["eip155:8453"]!.usdc,
    payTo: options.payTo ?? ESCROW,
    maxTimeoutSeconds: 60,
    extra: { name: "USD Coin", version: "2" },
  };
  const challenge = {
    x402Version: 2,
    resource: {
      url: `https://tasks.example/v1/tasks/${ID}/fund`,
      description: "Task escrow deposit",
      mimeType: "application/json",
    },
    accepts: [offer],
  };
  const fetchImpl = vi.fn<typeof fetch>(async () => {
    if (options.ambiguous) throw new Error("Connection lost after authorization");
    return Response.json(
      { state: "pending-chain" },
      {
        headers: {
          "payment-response": Buffer.from(
            JSON.stringify({ success: true, transaction: `0x${"ab".repeat(32)}` }),
          ).toString("base64"),
        },
      },
    );
  });
  const client = {
    fundingChallenge: vi.fn(async () =>
      options.status === 404
        ? null
        : {
            request: new Request(challenge.resource.url),
            response: Response.json(challenge, { status: 402 }),
          },
    ),
  } as unknown as TasksClient;
  const context = {
    client,
    chain: { ...missingTasksChain, available: true, validateFunding: vi.fn(async () => {}) },
    baseUrl: "https://tasks.example",
    randomUUID: () => ID,
    signInHint: "Run vapi login.",
  };
  const snapshot = {
    order: {
      workOrder: {
        version: "work-order-view-v1",
        id: ID,
        clientAddress: account.address,
        milestones: [
          {
            id: MILESTONE,
            workOrderId: ID,
            escrowState: "created",
            network: "eip155:8453",
            escrowContract: ESCROW,
            amountBaseUnits: "2500000",
          },
        ],
      },
    },
    escrowId: MILESTONE,
    money: taskMoney("2500000", 0),
    readiness: { ok: false, error: new Error("not used") },
  } as unknown as MoneySnapshot;
  const input = {
    id: ID,
    snapshot,
    policy: {
      maxPerTaskUsd: 100,
      approveAboveUsd: 100,
      autoReleaseBelowUsd: 0,
      source: "defaults" as const,
    },
    caps: { perCallAtomic: "1", perDayAtomic: "10000000" },
    wallet: "main" as const,
    ledgerPath: join(directory, "spend-ledger.json"),
    config,
    now: () => NOW,
    unlock: vi.fn(async () => account),
    fetchImpl,
    lookup: async () => ["93.184.216.34"],
  };
  return { context, input, sign, fetchImpl };
}

describe("standard x402 task funding (recorded T26 contract)", () => {
  it("signs using Call's payment client after policy reservation and local scope verification", async () => {
    const f = await fixture();
    f.sign.mockImplementationOnce(async (args) => {
      expect((await readSpendLedger(f.input.ledgerPath, NOW)).spentAtomic).toBe("2500000");
      expect(f.context.chain.validateFunding).toHaveBeenCalledOnce();
      return await privateKeyToAccount(`0x${"11".repeat(32)}`).signTypedData(args);
    });
    const result = await fundTaskWithX402(f.context, f.input);
    expect(result).toMatchObject({ ok: true, method: "x402", milestoneId: MILESTONE });
    expect(f.fetchImpl).toHaveBeenCalledOnce();
    const request = f.fetchImpl.mock.calls[0]![0] as Request;
    expect(request.redirect).toBe("manual");
    expect(request.headers.has("payment-signature")).toBe(true);
    const ledger = JSON.parse(await readFile(f.input.ledgerPath, "utf8")) as {
      reservations: unknown[];
    };
    expect(ledger.reservations).toEqual([
      expect.objectContaining({ kind: "escrow-funding", taskKey: ID, amountAtomic: "2500000" }),
    ]);
    // A payment acknowledgement alone is not a hosted Funded observation.
    expect(result).not.toHaveProperty("funded", true);
    await expect(fundTaskWithX402(f.context, f.input)).rejects.toMatchObject({
      code: "funding_reserved",
    });
    expect(f.sign).toHaveBeenCalledOnce();
  });
  it("falls back without unlocking when the route does not offer a challenge", async () => {
    const f = await fixture({ status: 404 });
    expect(await fundTaskWithX402(f.context, f.input)).toBeNull();
    expect(f.input.unlock).not.toHaveBeenCalled();
  });
  it.each([2, 0.0000009])(
    "refuses above maxPerTaskUsd %s without changing spend or signing",
    async (limit) => {
      const f = await fixture();
      f.input.policy.maxPerTaskUsd = limit;
      expect(await fundTaskWithX402(f.context, f.input)).toMatchObject({
        ok: false,
        reason: "policy.perTask",
      });
      expect(f.input.unlock).not.toHaveBeenCalled();
      expect(f.sign).not.toHaveBeenCalled();
      expect(await readFile(f.input.ledgerPath, "utf8").catch(() => null)).toBeNull();
    },
  );
  it("applies the daily cap and approval threshold before unlocking", async () => {
    const f = await fixture();
    f.input.caps.perDayAtomic = "1";
    expect(await fundTaskWithX402(f.context, f.input)).toMatchObject({ reason: "policy.perDay" });
    f.input.caps.perDayAtomic = "10000000";
    f.input.policy.approveAboveUsd = 1;
    expect(await fundTaskWithX402(f.context, f.input)).toMatchObject({ approval: true });
    expect(f.input.unlock).not.toHaveBeenCalled();
  });
  it.each([{ amount: "2500001" }, { payTo: "0x3333333333333333333333333333333333333333" }])(
    "rejects a changed escrow quote before signing %#",
    async (options) => {
      const f = await fixture(options);
      await expect(fundTaskWithX402(f.context, f.input)).rejects.toThrow();
      expect(f.sign).not.toHaveBeenCalled();
      expect(f.fetchImpl).not.toHaveBeenCalled();
    },
  );
  it("keeps spend reserved after an ambiguous paid request and never falls back to another payment", async () => {
    const f = await fixture({ ambiguous: true });
    await expect(fundTaskWithX402(f.context, f.input)).rejects.toThrow();
    expect((await readSpendLedger(f.input.ledgerPath, NOW)).spentAtomic).toBe("2500000");
    await expect(fundTaskWithX402(f.context, f.input)).rejects.toMatchObject({
      code: "funding_reserved",
    });
    expect(f.sign).toHaveBeenCalledOnce();
  });
  it("atomically prevents two concurrent funding authorizations for one task", async () => {
    const f = await fixture();
    const results = await Promise.allSettled([
      fundTaskWithX402(f.context, f.input),
      fundTaskWithX402(f.context, f.input),
    ]);
    expect(results.filter((item) => item.status === "fulfilled" && item.value?.ok)).toHaveLength(1);
    expect(f.sign).toHaveBeenCalledOnce();
  });
  it("combines Call payments with task funding in the same daily ledger", async () => {
    const f = await fixture();
    await reserveSpend(
      9_000_000n,
      { perCallAtomic: "10000000", perDayAtomic: "10000000" },
      { ledgerPath: f.input.ledgerPath, wallet: "main", now: NOW },
    );
    expect(await fundTaskWithX402(f.context, f.input)).toMatchObject({ reason: "policy.perDay" });
  });
});
