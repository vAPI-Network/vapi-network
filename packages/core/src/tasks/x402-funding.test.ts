import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { getDefaultConfig } from "../config.js";
import { readSpendLedger, reserveSpend } from "../spend-policy.js";
import { EIP3009_AUTHORIZATION_TYPES } from "../x402.js";
import { fundTask } from "./actions.js";
import { type VerifiedFundingCoordinates, missingTasksChain } from "./chain-port.js";
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
  const verified: VerifiedFundingCoordinates = {
    network: "eip155:8453",
    asset: config.networks["eip155:8453"]!.usdc as `0x${string}`,
    payTo: ESCROW,
    amount: "2500000",
    poster: account.address,
  };
  const client = {
    getOrder: vi.fn(async () => snapshot.order),
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
    chain: {
      ...missingTasksChain,
      available: true,
      validateFunding: vi.fn(async () => ({ ...verified })),
      fundingAuthorizationState: vi.fn(async () => false),
    },
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
            asset: `eip155:8453/erc20:${config.networks["eip155:8453"]!.usdc}`,
            escrowContract: ESCROW,
            amountBaseUnits: "2500000",
          },
        ],
      },
    },
    escrowId: MILESTONE,
    money: taskMoney("2500000", 0),
    readiness: { ok: false, error: new Error("not used") },
  } as unknown as MoneySnapshot & {
    order: {
      workOrder: Extract<MoneySnapshot["order"]["workOrder"], { version: "work-order-view-v1" }>;
    };
  };
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
  const legacyInput = {
    ...input,
    client,
    chain: context.chain,
    orderId: ID,
    escrowId: MILESTONE,
    idempotencyKey: () => ID,
  };
  return { context, input, sign, fetchImpl, verified, snapshot, account, legacyInput, offer };
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
      code: "funding_unresolved",
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
      code: "funding_unresolved",
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

describe("control-room funding regressions", () => {
  it.each(["network", "asset", "payTo", "amount", "poster"] as const)(
    "refuses inconsistent verified %s before any signature",
    async (field) => {
      const f = await fixture();
      const changed = {
        ...f.verified,
        [field]:
          field === "network"
            ? "eip155:84532"
            : field === "amount"
              ? "2500001"
              : "0x3333333333333333333333333333333333333333",
      };
      f.context.chain.validateFunding.mockResolvedValueOnce(changed);
      await expect(fundTaskWithX402(f.context, f.input)).rejects.toMatchObject({
        code: "funding_coordinates_mismatch",
      });
      expect(f.sign).not.toHaveBeenCalled();
      expect(f.fetchImpl).not.toHaveBeenCalled();
    },
  );
  it("refuses a snapshot and challenge that agree on an address different from the verified escrow", async () => {
    const f = await fixture({ payTo: "0x3333333333333333333333333333333333333333" });
    f.snapshot.order.workOrder.milestones[0]!.escrowContract = f.offer.payTo as `0x${string}`;
    await expect(fundTaskWithX402(f.context, f.input)).rejects.toMatchObject({
      code: "funding_coordinates_mismatch",
    });
    expect(f.sign).not.toHaveBeenCalled();
  });
  it("persists protocol, nonce, expiry, amount and verified coordinates before signing", async () => {
    const f = await fixture();
    f.sign.mockImplementationOnce(async (data) => {
      const { readdir } = await import("node:fs/promises");
      const { dirname } = await import("node:path");
      const root = join(dirname(f.input.ledgerPath), "tasks");
      const file = (await readdir(root)).find(
        (name) => name.startsWith("funding-") && name.endsWith(".json"),
      )!;
      const recorded = JSON.parse(await readFile(join(root, file), "utf8"));
      expect(recorded).toMatchObject({
        protocol: "x402",
        state: "authorization",
        amount: "2500000",
        nonce: data.message!.nonce,
        validBefore: String(data.message!.validBefore),
        coordinates: f.verified,
      });
      return privateKeyToAccount(`0x${"11".repeat(32)}`).signTypedData(data);
    });
    await fundTaskWithX402(f.context, f.input);
  });
  it("blocks timeout → missing challenge → signed-intent fallback before a second signature", async () => {
    const f = await fixture({ ambiguous: true });
    await expect(fundTaskWithX402(f.context, f.input)).rejects.toThrow();
    const probe = vi.mocked(f.context.client.fundingChallenge!);
    probe.mockResolvedValue(null);
    const fund = vi.spyOn(f.context.chain, "fund");
    await expect(fundTaskWithX402(f.context, f.input)).rejects.toMatchObject({
      code: "funding_unresolved",
    });
    expect(probe).toHaveBeenCalledOnce();
    await expect(fundTask(f.legacyInput)).rejects.toMatchObject({ code: "funding_unresolved" });
    expect(fund).not.toHaveBeenCalled();
    expect(f.sign).toHaveBeenCalledOnce();
  });
  it.each(["x402-first", "intent-first"])(
    "permits one signature across concurrent mixed protocols: %s",
    async (order) => {
      const f = await fixture();
      f.context.chain.fund = vi.fn(async (input) => {
        const nonce = `0x${"ab".repeat(32)}` as `0x${string}`;
        const validBefore = BigInt(Math.floor(NOW.getTime() / 1000) + 60);
        await input.beforeFundingSignature!({
          coordinates: f.verified,
          nonce,
          validBefore: validBefore.toString(),
        });
        await f.account.signTypedData({
          domain: {
            name: "USD Coin",
            version: "2",
            chainId: 8453,
            verifyingContract: f.verified.asset,
          },
          types: EIP3009_AUTHORIZATION_TYPES,
          primaryType: "TransferWithAuthorization",
          message: {
            from: f.account.address,
            to: ESCROW,
            value: 2500000n,
            validAfter: 0n,
            validBefore,
            nonce,
          },
        });
        return {} as never;
      });
      const x402 = () => fundTaskWithX402(f.context, f.input);
      const intent = () => fundTask(f.legacyInput);
      const result = await Promise.allSettled(
        order === "x402-first" ? [x402(), intent()] : [intent(), x402()],
      );
      expect(f.sign).toHaveBeenCalledOnce();
      expect(result.filter((item) => item.status === "fulfilled")).toHaveLength(1);
      expect(
        (result.find((item) => item.status === "rejected") as PromiseRejectedResult).reason,
      ).toMatchObject({ code: "funding_unresolved" });
    },
  );
  it("releases a task reservation and journal after the signer throws, so retry succeeds", async () => {
    const f = await fixture();
    f.sign.mockRejectedValueOnce(new Error("Signer failed before producing an authorization"));
    await expect(fundTaskWithX402(f.context, f.input)).rejects.toThrow("Signer failed");
    expect((await readSpendLedger(f.input.ledgerPath, NOW)).spentAtomic).toBe("0");
    expect(await fundTaskWithX402(f.context, f.input)).toMatchObject({ ok: true });
    expect(f.sign).toHaveBeenCalledTimes(2);
    expect(f.fetchImpl).toHaveBeenCalledOnce();
  });
  it("resolves an expired unused authorization before allowing the other protocol", async () => {
    const f = await fixture({ ambiguous: true });
    await expect(fundTaskWithX402(f.context, f.input)).rejects.toThrow();
    f.input.now = () => new Date(NOW.getTime() + 86_400_000);
    f.context.chain.fundingAuthorizationState.mockResolvedValue(false);
    vi.mocked(f.context.client.fundingChallenge!).mockResolvedValue(null);
    expect(await fundTaskWithX402(f.context, f.input)).toBeNull();
    expect(f.context.chain.fundingAuthorizationState).toHaveBeenCalledWith(
      expect.objectContaining({ ...f.verified, nonce: expect.stringMatching(/^0x/u) }),
    );
    expect((await readSpendLedger(f.input.ledgerPath, NOW)).spentAtomic).toBe("0");
  });
  it.each([true, undefined])(
    "never releases an expired authorization when nonce state is %s",
    async (used) => {
      const f = await fixture({ ambiguous: true });
      await expect(fundTaskWithX402(f.context, f.input)).rejects.toThrow();
      f.input.now = () => new Date(NOW.getTime() + 86_400_000);
      if (used === undefined)
        f.context.chain.fundingAuthorizationState.mockRejectedValue(new Error("RPC unavailable"));
      else f.context.chain.fundingAuthorizationState.mockResolvedValue(used);
      await expect(fundTaskWithX402(f.context, f.input)).rejects.toThrow();
      expect(f.sign).toHaveBeenCalledOnce();
      expect((await readSpendLedger(f.input.ledgerPath, NOW)).spentAtomic).toBe("2500000");
    },
  );
  it("retires an attempt on hosted funding confirmation without releasing accounted spend", async () => {
    const f = await fixture();
    await fundTaskWithX402(f.context, f.input);
    f.snapshot.order.workOrder.milestones[0]!.escrowState = "locked";
    await expect(fundTaskWithX402(f.context, f.input)).rejects.toMatchObject({
      code: "funding_already_funded",
    });
    expect((await readSpendLedger(f.input.ledgerPath, NOW)).spentAtomic).toBe("2500000");
    expect(f.sign).toHaveBeenCalledOnce();
  });
  it("keeps an unresolved attempt blocked when an old SDK adapter has no challenge method", async () => {
    const f = await fixture({ ambiguous: true });
    await expect(fundTaskWithX402(f.context, f.input)).rejects.toThrow();
    delete f.context.client.fundingChallenge;
    await expect(fundTaskWithX402(f.context, f.input)).rejects.toMatchObject({
      code: "funding_unresolved",
    });
  });
});

describe("signed-intent attempt retirement", () => {
  it("blocks the other protocol, then retires both its spend reservation and cached authorization after expiry plus unused nonce", async () => {
    const { dirname } = await import("node:path");
    const { createPendingTransactions } = await import("./pending-transactions.js");
    const { TasksChainError } = await import("./chain-port.js");
    const f = await fixture();
    const pending = createPendingTransactions(dirname(f.input.ledgerPath));
    const nonce = `0x${"ab".repeat(32)}` as `0x${string}`;
    const validBefore = String(Math.floor(NOW.getTime() / 1000) + 60);
    f.context.chain.fund = vi.fn(async (input) => {
      await input.beforeFundingSignature!({ coordinates: f.verified, nonce, validBefore });
      await pending.fundingAuthorization(MILESTONE, ID, async () => ({
        validAfter: "0",
        validBefore,
        nonce,
        signature: `0x${"cd".repeat(65)}`,
      }));
      await pending.markExposure(MILESTONE);
      throw new TasksChainError("Recorded loss after signed intent", true);
    });
    await expect(fundTask({ ...f.legacyInput, pending })).rejects.toThrow("Recorded loss");
    await expect(fundTaskWithX402({ ...f.context, pending }, f.input)).rejects.toMatchObject({
      code: "funding_unresolved",
    });
    expect(f.context.client.fundingChallenge).not.toHaveBeenCalled();
    f.input.now = () => new Date(NOW.getTime() + 120_000);
    expect(await fundTaskWithX402({ ...f.context, pending }, f.input)).toMatchObject({ ok: true });
    expect(await pending.savedFundingAuthorization(MILESTONE, ID)).toBeUndefined();
    expect(await pending.exposure(MILESTONE)).toBe(false);
    expect((await readSpendLedger(f.input.ledgerPath, NOW)).spentAtomic).toBe("2500000");
    expect(f.sign).toHaveBeenCalledOnce();
  });
});
