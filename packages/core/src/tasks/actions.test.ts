import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { readSpendLedger, reserveSpend } from "../spend-policy.js";
import {
  autoReleaseDecision,
  deliverTask,
  disputeTask,
  fundTask,
  prepareDelivery,
  refundTask,
  releaseTask,
  signScope,
} from "./actions.js";
import { canonicalJson } from "./canonical-json.js";
import {
  missingTasksChain,
  TasksChainError,
  type TasksChain,
  type TasksChainResult,
} from "./chain-port.js";
import { createTasksClient } from "./client.js";
import { prepareDeliveryManifest } from "./delivery-manifest.js";
import { tasksResponseSchemas } from "./types.js";

const ORDER = "11111111-1111-4111-8111-111111111111";
const ESCROW = "22222222-2222-4222-8222-222222222222";
const FILE = "33333333-3333-4333-8333-333333333333";
const KEY = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CREATE_KEY = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ADDRESS = "0x1111111111111111111111111111111111111111";
const HASH = `0x${"ab".repeat(32)}` as const;
const SIGNATURE = `0x${"cd".repeat(65)}` as const;
const NOW = "2026-10-08T12:00:00.000Z";
const directories: string[] = [];

const terms = {
  version: "work-milestone-terms-v1",
  title: "Prepare a report",
  description: "Write a useful report.",
  acceptanceCriteria: ["Report complete"],
  acceptanceWindowSeconds: 3600,
  budget: {
    network: "eip155:84532",
    asset: `eip155:84532/erc20:${ADDRESS}`,
    amountBaseUnits: "100000000",
  },
  escrow: { protocol: "escrow-v1", contract: ADDRESS },
  evidenceRules: { acceptedInputs: ["text"], exactCommitRequired: false },
};

function orderResponse(
  amountBaseUnits = "100000000",
  role = "client",
  escrowState: "created" | null = "created",
) {
  return tasksResponseSchemas.getOrder.parse({
    workOrder: {
      version: "work-order-view-v1",
      id: ORDER,
      state: "awarded",
      title: "Prepare a report",
      description: "Write a useful report.",
      policyFamily: "research-data",
      listingDeliveryTimeSeconds: null,
      clientAddress: ADDRESS,
      invitedProviderAddress: null,
      acceptedProposalId: FILE,
      threadId: FILE,
      role,
      canFinalize: false,
      proposals: [],
      events: [],
      review: null,
      publishedAt: NOW,
      completedAt: null,
      createdAt: NOW,
      updatedAt: NOW,
      milestones: [
        {
          id: ESCROW,
          workOrderId: ORDER,
          ordinal: 1,
          state: "agreed",
          terms,
          termsHash: HASH,
          termsFrozenAt: NOW,
          network: "eip155:84532",
          asset: `eip155:84532/erc20:${ADDRESS}`,
          amountBaseUnits,
          escrowProtocol: "escrow-v1",
          escrowContract: ADDRESS,
          escrowState,
          resolution: null,
          offerDeadlineAt: null,
          workDeadlineAt: null,
          acceptanceDeadlineAt: null,
          dispute: null,
          chainOperation: null,
          artifact: null,
          delivery: null,
          fundingTxHash: null,
          settlementTxHash: null,
          fundedAt: null,
          deliveredAt: null,
          settledAt: null,
          createdAt: NOW,
          updatedAt: NOW,
        },
      ],
    },
  });
}

function scope(proposedByRole: "client" | "provider" = "client", version = 1) {
  return tasksResponseSchemas.getScopes.parse({
    scopes: [
      {
        id: FILE,
        workOrderId: ORDER,
        trancheOrdinal: 1,
        version,
        state: "proposed",
        structuredTerms: { ...terms, deliverables: ["A report"], revisionCount: 0, deadline: NOW },
        brief: "Report",
        termsHash: HASH,
        proposedByRole,
        proposerAddress: ADDRESS,
        proposerSignature: SIGNATURE,
        counterpartyAddress: null,
        counterpartySignature: null,
        acceptedAt: null,
        milestoneId: null,
        createdAt: NOW,
        signingPayload: {
          version: "work-scope-signature-v1",
          workOrderId: ORDER,
          trancheOrdinal: 1,
          scopeVersion: version,
          termsHash: HASH,
        },
      },
    ],
  }).scopes[0]!;
}

function chainResult(): TasksChainResult {
  return {
    txHash: HASH,
    operation: tasksResponseSchemas.fundEscrow.parse({
      operation: {
        id: FILE,
        kind: "escrow-funding",
        state: "confirmed",
        step: "fund-with-authorization",
        expectedActor: ADDRESS,
        transactionHash: HASH,
        plan: null,
      },
      milestone: { id: ESCROW, workOrderId: ORDER },
    }).operation,
    milestone: {
      id: ESCROW,
      workOrderId: ORDER,
      state: "funded",
      escrowState: "locked",
      resolution: null,
    },
  };
}

function dependencies(amount = "100000000") {
  const client = {
    ...createTasksClient({
      baseUrl: "https://tasks.example",
      fetch: vi.fn().mockRejectedValue(new Error("Unexpected transport")),
    }),
    getOrder: vi.fn().mockResolvedValue(orderResponse(amount)),
    deployment: vi.fn().mockResolvedValue({ configured: false, feeBp: 500 }),
    uploadFile: vi.fn().mockResolvedValue({
      file: {
        id: FILE,
        purpose: "delivery",
        fileName: "stored.md",
        mimeType: "text/markdown",
        sizeBytes: 19,
        sha256: "AB".repeat(32),
        state: "ready",
        createdAt: NOW,
      },
    }),
    getScopes: vi.fn().mockResolvedValue({ scopes: [scope()] }),
    signScope: vi.fn().mockResolvedValue({
      scope: { ...scope(), state: "accepted", milestoneId: ESCROW },
      milestone: {
        id: ESCROW,
        workOrderId: ORDER,
        ordinal: 1,
        termsHash: HASH,
        termsFrozenAt: NOW,
      },
    }),
  };
  const chain = {
    available: true,
    createEscrow: vi.fn().mockResolvedValue(chainResult()),
    fund: vi.fn().mockResolvedValue(chainResult()),
    deliver: vi.fn().mockResolvedValue(chainResult()),
    release: vi.fn().mockResolvedValue(chainResult()),
    refund: vi.fn().mockResolvedValue(chainResult()),
    dispute: vi.fn().mockResolvedValue(chainResult()),
    signScopeMessage: vi.fn().mockResolvedValue(SIGNATURE),
  } satisfies TasksChain;
  return { client, chain, orderId: ORDER, idempotencyKey: () => KEY };
}

async function funding(amount = "100000000") {
  const directory = await mkdtemp(join(tmpdir(), "vapi-task-actions-"));
  directories.push(directory);
  return {
    ...dependencies(amount),
    ledgerPath: join(directory, "spend-ledger.json"),
    wallet: "main",
    now: () => new Date(NOW),
    caps: { perCallAtomic: "1", perDayAtomic: "200000000" },
    policy: { maxPerTaskUsd: 100, approveAboveUsd: 50 },
  };
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("task funding", () => {
  it("refuses the per-task cap without creating a ledger or lock", async () => {
    const args = await funding("100000001");
    expect(await fundTask(args)).toMatchObject({ outcome: "refused", reason: "policy.perTask" });
    expect(args.chain.fund).not.toHaveBeenCalled();
    await expect(stat(args.ledgerPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(`${args.ledgerPath}.lock`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses the per-day cap without changing bytes or acquiring a held lock", async () => {
    const args = await funding();
    const raw = JSON.stringify({ date: "2026-10-08", spentAtomic: "100000001" });
    await writeFile(args.ledgerPath, raw);
    await writeFile(`${args.ledgerPath}.lock`, "held");
    expect(await fundTask(args)).toMatchObject({ outcome: "refused", reason: "policy.perDay" });
    expect(await readFile(args.ledgerPath, "utf8")).toBe(raw);
    expect(await readFile(`${args.ledgerPath}.lock`, "utf8")).toBe("held");
    expect(args.chain.fund).not.toHaveBeenCalled();
  });

  it("reports approval needed without spending or taking a lock", async () => {
    const args = await funding();
    await writeFile(`${args.ledgerPath}.lock`, "held");
    expect(await fundTask({ ...args, approval: { granted: false } })).toMatchObject({
      outcome: "approval_needed",
    });
    expect(args.chain.fund).not.toHaveBeenCalled();
    await expect(stat(args.ledgerPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reserves escrow funding immediately before the chain call with the same key", async () => {
    const args = await funding();
    args.chain.fund.mockImplementationOnce(async () => {
      expect(JSON.parse(await readFile(args.ledgerPath, "utf8"))).toMatchObject({
        spentAtomic: "100000000",
        reservations: [{ id: KEY, amountAtomic: "100000000", kind: "escrow-funding" }],
      });
      return chainResult();
    });
    expect(await fundTask({ ...args, approval: { granted: true } })).toMatchObject({
      outcome: "done",
    });
    expect(args.chain.fund).toHaveBeenCalledExactlyOnceWith({
      escrowId: ESCROW,
      grossBaseUnits: 100000000n,
      idempotencyKey: KEY,
    });
  });

  it("never reserves against an unavailable chain", async () => {
    const args = await funding();
    await expect(
      fundTask({ ...args, chain: missingTasksChain, approval: { granted: true } }),
    ).rejects.toThrow("chain operations need C2");
    await expect(stat(args.ledgerPath)).rejects.toMatchObject({ code: "ENOENT" });
    const raw = JSON.stringify({ date: "2026-10-08", spentAtomic: "1000" });
    await writeFile(args.ledgerPath, raw);
    await expect(
      fundTask({ ...args, chain: missingTasksChain, approval: { granted: true } }),
    ).rejects.toThrow("chain operations need C2");
    expect(await readFile(args.ledgerPath, "utf8")).toBe(raw);
  });

  it("rolls back only a failure that proves no authorization was exposed or transaction broadcast", async () => {
    const args = await funding();
    args.chain.fund.mockRejectedValueOnce(
      new TasksChainError("Signing refused", false, { authorizationExposed: false }),
    );
    await expect(fundTask({ ...args, approval: { granted: true } })).rejects.toThrow(
      "Signing refused",
    );
    expect(await readSpendLedger(args.ledgerPath, new Date(NOW))).toMatchObject({
      spentAtomic: "0",
    });
    expect(JSON.parse(await readFile(args.ledgerPath, "utf8")).reservations).toBeUndefined();
  });

  it.each([
    new Error("Preparation response lost after authorization submission"),
    new TasksChainError("Preparation rejected after authorization submission", false),
    new TasksChainError("Authorization may have reached the server", false, {
      authorizationExposed: true,
    }),
    new TasksChainError("Transaction submitted", true, { authorizationExposed: false }),
  ])("retains funding headroom on an unsafe or unknown failure: %s", async (error) => {
    const args = await funding();
    args.chain.fund.mockRejectedValueOnce(error);
    await expect(fundTask({ ...args, approval: { granted: true } })).rejects.toBe(error);
    expect(JSON.parse(await readFile(args.ledgerPath, "utf8"))).toMatchObject({
      spentAtomic: "100000000",
      reservations: [{ id: KEY, amountAtomic: "100000000", kind: "escrow-funding" }],
    });
    expect(
      await fundTask({
        ...args,
        caps: { ...args.caps, perDayAtomic: "199999999" },
        approval: { granted: true },
        idempotencyKey: () => CREATE_KEY,
      }),
    ).toMatchObject({ outcome: "refused", reason: "policy.perDay" });
    expect(args.chain.fund).toHaveBeenCalledTimes(1);
  });

  it("retains a reservation on a possibly broadcast failure", async () => {
    const args = await funding();
    args.chain.fund.mockRejectedValueOnce(new TasksChainError("Submission uncertain", true));
    await expect(fundTask({ ...args, approval: { granted: true } })).rejects.toThrow(
      "Submission uncertain",
    );
    expect(await readSpendLedger(args.ledgerPath, new Date(NOW))).toMatchObject({
      spentAtomic: "100000000",
    });
  });

  it("declines or propagates failed approval without a reservation", async () => {
    const args = await funding();
    const ask = vi.fn().mockResolvedValue(false);
    expect(await fundTask({ ...args, approval: { ask } })).toMatchObject({ outcome: "declined" });
    expect(ask).toHaveBeenCalledWith(
      expect.objectContaining({
        dayRemainingUsd: 200,
        money: expect.objectContaining({ feeBp: 500 }),
      }),
    );
    ask.mockRejectedValueOnce(new Error("Prompt failed"));
    await expect(fundTask({ ...args, approval: { ask } })).rejects.toThrow("Prompt failed");
    await expect(stat(args.ledgerPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("uses no fee when readiness omits it or fails", async () => {
    const args = await funding();
    args.client.deployment.mockResolvedValueOnce({ configured: false, feeBp: null });
    expect(await fundTask(args)).toMatchObject({
      money: {
        feeBp: null,
        fee: null,
        net: null,
        line: "$100.00 gross · fee unavailable",
      },
    });
    args.client.deployment.mockResolvedValueOnce({ configured: false });
    expect(await fundTask(args)).toMatchObject({
      money: { feeBp: null, line: "$100.00 gross · fee unavailable" },
    });
    args.client.deployment.mockRejectedValueOnce(new Error("Readiness unavailable"));
    expect(await fundTask(args)).toMatchObject({ money: { feeBp: null, fee: null, net: null } });
  });

  it("requires an explicit milestone on an order with multiple tranches", async () => {
    const args = await funding();
    const response = orderResponse();
    if (response.workOrder.version !== "work-order-view-v1") throw new Error("Fixture is private");
    response.workOrder.milestones.push({
      ...response.workOrder.milestones[0]!,
      id: FILE,
      ordinal: 2,
    });
    args.client.getOrder.mockResolvedValue(response);
    await expect(fundTask(args)).rejects.toThrow("milestone");
    expect(await fundTask({ ...args, escrowId: ESCROW })).toMatchObject({
      outcome: "approval_needed",
    });
    expect(args.chain.fund).not.toHaveBeenCalled();
  });

  it("rejects a foreign milestone or returned order before spending", async () => {
    const args = await funding();
    await expect(fundTask({ ...args, escrowId: FILE })).rejects.toThrow();
    const response = orderResponse();
    response.workOrder.id = FILE;
    args.client.getOrder.mockResolvedValueOnce(response);
    await expect(fundTask(args)).rejects.toThrow();
    await expect(stat(args.ledgerPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rechecks the daily cap atomically after approval and isolates wallets", async () => {
    const args = await funding();
    const ask = async () => {
      await reserveSpend(100000001n, args.caps, {
        ledgerPath: args.ledgerPath,
        now: new Date(NOW),
        kind: "escrow-funding",
        maxPerTaskAtomic: 200000000n,
      });
      return true;
    };
    await expect(fundTask({ ...args, approval: { ask } })).rejects.toMatchObject({
      code: "per_day_cap_exceeded",
    });
    expect(args.chain.fund).not.toHaveBeenCalled();
    expect(
      await fundTask({ ...args, wallet: "worker", approval: { granted: true } }),
    ).toMatchObject({ outcome: "done" });
  });

  it("floors fractional policy caps and rejects unsafe operation keys before reserving", async () => {
    const args = await funding("1");
    expect(
      await fundTask({ ...args, policy: { maxPerTaskUsd: 9e-7, approveAboveUsd: 0 } }),
    ).toMatchObject({ outcome: "refused", reason: "policy.perTask" });
    await expect(
      fundTask({ ...args, approval: { granted: true }, idempotencyKey: () => "bad-key" }),
    ).rejects.toThrow();
    await expect(stat(args.ledgerPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(args.chain.fund).not.toHaveBeenCalled();
  });

  it("refuses duplicate reservations without broadcasting a retry", async () => {
    const args = await funding();
    await fundTask({ ...args, approval: { granted: true } });
    const bytes = await readFile(args.ledgerPath, "utf8");
    await expect(fundTask({ ...args, approval: { granted: true } })).rejects.toThrow(
      "already exists",
    );
    expect(args.chain.fund).toHaveBeenCalledTimes(1);
    expect(await readFile(args.ledgerPath, "utf8")).toBe(bytes);
  });
});

describe("task delivery", () => {
  const files = [
    { path: "/out/local.md", bytes: new Uint8Array([1, 2]), contentType: "text/markdown" as const },
  ];

  it("builds the manifest from finalized upload metadata and passes it to the chain", async () => {
    const args = dependencies();
    const manifest = await prepareDeliveryManifest(
      [{ fileId: FILE, fileName: "stored.md", sha256: "AB".repeat(32), sizeBytes: 19 }],
      "Exact note ",
    );
    const result = await deliverTask({ ...args, files, note: "Exact note " });
    expect(result.manifestHash).toBe(manifest.manifestHash);
    expect(args.client.uploadFile).toHaveBeenCalledExactlyOnceWith({
      fileName: "local.md",
      bytes: files[0]!.bytes,
      contentType: "text/markdown",
      purpose: "delivery",
    });
    expect(args.chain.deliver).toHaveBeenCalledExactlyOnceWith({
      escrowId: ESCROW,
      manifest,
      note: "Exact note ",
      idempotencyKey: KEY,
    });
  });

  it("exposes the computed hash even when the chain is unavailable", async () => {
    const args = dependencies();
    const prepared = await prepareDelivery({ ...args, files, note: "Report" });
    await expect(
      deliverTask({ ...args, chain: missingTasksChain, files, note: "Report" }),
    ).rejects.toMatchObject({
      code: "chain_unavailable",
      manifestHash: prepared.manifest.manifestHash,
    });
  });

  it("does not call the chain after an upload failure or invalid note", async () => {
    const args = dependencies();
    await expect(deliverTask({ ...args, files, note: " " })).rejects.toThrow();
    expect(args.client.uploadFile).not.toHaveBeenCalled();
    args.client.uploadFile.mockRejectedValueOnce(new Error("Upload failed"));
    await expect(deliverTask({ ...args, files, note: "Report" })).rejects.toThrow("Upload failed");
    expect(args.chain.deliver).not.toHaveBeenCalled();
  });
});

describe("explicit settlement and dispute", () => {
  it("computes money then releases or refunds without a policy gate", async () => {
    const args = dependencies();
    expect(await releaseTask(args)).toMatchObject({
      money: { gross: { baseUnits: "100000000" } },
      result: { txHash: HASH },
    });
    expect(await refundTask(args)).toMatchObject({ money: { feeBp: 500 } });
    expect(args.chain.release).toHaveBeenCalledExactlyOnceWith({
      escrowId: ESCROW,
      idempotencyKey: KEY,
    });
    expect(args.chain.refund).toHaveBeenCalledExactlyOnceWith({
      escrowId: ESCROW,
      idempotencyKey: KEY,
    });
  });

  it("reports an unknown contract dispute fee and validates evidence", async () => {
    const args = dependencies();
    expect(await disputeTask({ ...args, evidenceHash: HASH })).toMatchObject({
      disputeFee: null,
      disputeFeeNote: "The contract charges a dispute fee; the amount is unavailable.",
    });
    expect(args.chain.dispute).toHaveBeenCalledExactlyOnceWith({
      escrowId: ESCROW,
      evidenceHash: HASH,
      idempotencyKey: KEY,
    });
    await expect(disputeTask({ ...args, evidenceHash: "0x1234" })).rejects.toThrow();
    expect(args.chain.dispute).toHaveBeenCalledTimes(1);
  });

  it("requires approval at the automatic release threshold", () => {
    expect(autoReleaseDecision({ amountUsd: 24.999999, autoReleaseBelowUsd: 25 })).toEqual({
      auto: true,
    });
    expect(autoReleaseDecision({ amountUsd: 25, autoReleaseBelowUsd: 25 })).toEqual({
      approval: true,
    });
  });
});

describe("scope acceptance", () => {
  it("accepts a poster scope with a local message signer and no chain adapter", async () => {
    const args = dependencies();
    args.client.getScopes.mockResolvedValueOnce({ scopes: [scope("provider")] });
    const signMessage = vi.fn().mockResolvedValue(SIGNATURE);
    expect(
      await signScope({ ...args, chain: missingTasksChain, role: "poster", signMessage }),
    ).toMatchObject({ escrowCreation: null });
    expect(signMessage).toHaveBeenCalledExactlyOnceWith(canonicalJson(scope().signingPayload));
    expect(args.client.signScope).toHaveBeenCalledExactlyOnceWith(
      FILE,
      { signedPayload: scope("provider").signingPayload, signature: SIGNATURE },
      { idempotencyKey: KEY },
    );
    expect(args.chain.signScopeMessage).not.toHaveBeenCalled();
  });

  it("preserves worker acceptance when local signing succeeds but escrow creation needs C2", async () => {
    const args = dependencies();
    args.client.getOrder.mockResolvedValue(orderResponse("100000000", "provider", null));
    const signMessage = vi.fn().mockResolvedValue(SIGNATURE);
    await expect(
      signScope({ ...args, chain: missingTasksChain, role: "worker", signMessage }),
    ).rejects.toMatchObject({
      acceptance: { scope: { state: "accepted" } },
      cause: { code: "chain_unavailable", message: "chain operations need C2" },
    });
    expect(args.client.signScope).toHaveBeenCalledTimes(1);
  });

  it("does not invoke a local signer for a scope belonging to another task", async () => {
    const args = dependencies();
    args.client.getScopes.mockResolvedValueOnce({
      scopes: [{ ...scope("provider"), workOrderId: FILE }],
    });
    const signMessage = vi.fn().mockResolvedValue(SIGNATURE);
    await expect(signScope({ ...args, role: "poster", signMessage })).rejects.toThrow(
      "different task",
    );
    expect(signMessage).not.toHaveBeenCalled();
    expect(args.client.signScope).not.toHaveBeenCalled();
  });

  it("does not accept a scope when local signing fails", async () => {
    const args = dependencies();
    args.client.getScopes.mockResolvedValueOnce({ scopes: [scope("provider")] });
    const signMessage = vi.fn().mockRejectedValue(new Error("Vault signing refused"));
    await expect(signScope({ ...args, role: "poster", signMessage })).rejects.toThrow(
      "Vault signing refused",
    );
    expect(args.client.signScope).not.toHaveBeenCalled();
    expect(args.chain.createEscrow).not.toHaveBeenCalled();
  });

  it("signs canonical payload bytes and reports worker escrow creation separately", async () => {
    const args = dependencies();
    args.client.getOrder.mockResolvedValue(orderResponse("100000000", "provider", null));
    const keys = vi.fn().mockReturnValueOnce(KEY).mockReturnValueOnce(CREATE_KEY);
    const result = await signScope({ ...args, role: "worker", idempotencyKey: keys });
    expect(args.chain.signScopeMessage).toHaveBeenCalledExactlyOnceWith(
      canonicalJson(scope().signingPayload),
    );
    expect(args.client.signScope).toHaveBeenCalledExactlyOnceWith(
      FILE,
      { signedPayload: scope().signingPayload, signature: SIGNATURE },
      { idempotencyKey: KEY },
    );
    expect(args.chain.createEscrow).toHaveBeenCalledExactlyOnceWith({
      orderId: ORDER,
      idempotencyKey: CREATE_KEY,
    });
    expect(result.escrowCreation).toEqual(chainResult());
  });

  it("does not create an escrow for a poster or one already created", async () => {
    const args = dependencies();
    args.client.getScopes.mockResolvedValueOnce({ scopes: [scope("provider")] });
    expect(await signScope({ ...args, role: "poster" })).toMatchObject({ escrowCreation: null });
    args.client.getOrder.mockResolvedValue(orderResponse("100000000", "provider"));
    expect(await signScope({ ...args, role: "worker" })).toMatchObject({ escrowCreation: null });
    expect(args.chain.createEscrow).not.toHaveBeenCalled();
  });

  it("rejects role, scope membership, and signing payload mismatches before signing", async () => {
    const args = dependencies();
    await expect(signScope({ ...args, role: "worker" })).rejects.toThrow();
    args.client.getScopes.mockResolvedValueOnce({
      scopes: [{ ...scope("provider"), workOrderId: FILE }],
    });
    await expect(signScope({ ...args, role: "poster" })).rejects.toThrow();
    args.client.getScopes.mockResolvedValueOnce({
      scopes: [
        {
          ...scope("provider"),
          signingPayload: { ...scope("provider").signingPayload, scopeVersion: 2 },
        },
      ],
    });
    await expect(signScope({ ...args, role: "poster" })).rejects.toThrow();
    expect(args.chain.signScopeMessage).not.toHaveBeenCalled();
  });

  it("preserves successful acceptance if later escrow creation fails", async () => {
    const args = dependencies();
    args.client.getOrder.mockResolvedValue(orderResponse("100000000", "provider", null));
    args.chain.createEscrow.mockRejectedValueOnce(new TasksChainError("Creation failed", true));
    await expect(signScope({ ...args, role: "worker" })).rejects.toMatchObject({
      acceptance: { scope: { state: "accepted" } },
      cause: new TasksChainError("Creation failed", true),
      broadcast: true,
    });
    expect(args.client.signScope).toHaveBeenCalledTimes(1);
  });

  it("chooses the current scope and rejects simultaneous proposed tranches", async () => {
    const args = dependencies();
    const latest = scope("provider", 2);
    args.client.getScopes.mockResolvedValueOnce({ scopes: [scope("provider"), latest] });
    args.client.signScope.mockResolvedValueOnce({
      scope: { ...latest, state: "accepted", milestoneId: ESCROW },
      milestone: {
        id: ESCROW,
        workOrderId: ORDER,
        ordinal: 1,
        termsHash: HASH,
        termsFrozenAt: NOW,
      },
    });
    await signScope({ ...args, role: "poster" });
    expect(args.chain.signScopeMessage).toHaveBeenCalledExactlyOnceWith(
      canonicalJson(latest.signingPayload),
    );
    args.client.getScopes.mockResolvedValueOnce({
      scopes: [latest, { ...scope("provider"), id: ESCROW, trancheOrdinal: 2 }],
    });
    await expect(signScope({ ...args, role: "poster" })).rejects.toThrow("one current");
    expect(args.chain.signScopeMessage).toHaveBeenCalledTimes(1);
  });

  it("rejects a foreign acceptance before creating an escrow", async () => {
    const args = dependencies();
    args.client.getOrder.mockResolvedValue(orderResponse("100000000", "provider", null));
    args.client.signScope.mockResolvedValueOnce({
      scope: { ...scope(), state: "accepted", milestoneId: ESCROW },
      milestone: { id: ESCROW, workOrderId: FILE, ordinal: 1, termsHash: HASH, termsFrozenAt: NOW },
    });
    await expect(signScope({ ...args, role: "worker" })).rejects.toThrow("accepted scope");
    expect(args.chain.createEscrow).not.toHaveBeenCalled();
  });

  it("preserves acceptance if the refreshed order fails and avoids creating an older tranche", async () => {
    const args = dependencies();
    args.client.getOrder
      .mockResolvedValueOnce(orderResponse("100000000", "provider", null))
      .mockRejectedValueOnce(new Error("Refresh failed"));
    await expect(signScope({ ...args, role: "worker" })).rejects.toMatchObject({
      acceptance: { scope: { state: "accepted" } },
      cause: new Error("Refresh failed"),
    });
    const response = orderResponse("100000000", "provider", null);
    if (response.workOrder.version !== "work-order-view-v1") throw new Error("Fixture is private");
    response.workOrder.milestones[0]!.ordinal = 2;
    response.workOrder.milestones.push({
      ...response.workOrder.milestones[0]!,
      id: FILE,
      ordinal: 1,
    });
    const next = {
      ...scope(),
      trancheOrdinal: 2,
      signingPayload: { ...scope().signingPayload, trancheOrdinal: 2 },
    };
    args.client.getScopes.mockResolvedValueOnce({ scopes: [next] });
    args.client.signScope.mockResolvedValueOnce({
      scope: { ...next, state: "accepted", milestoneId: ESCROW },
      milestone: {
        id: ESCROW,
        workOrderId: ORDER,
        ordinal: 2,
        termsHash: HASH,
        termsFrozenAt: NOW,
      },
    });
    args.client.getOrder.mockResolvedValue(response);
    await expect(signScope({ ...args, role: "worker" })).rejects.toMatchObject({
      acceptance: { scope: { state: "accepted" } },
      cause: new Error("An earlier task milestone still needs escrow creation."),
    });
    expect(args.chain.createEscrow).not.toHaveBeenCalled();
  });
});
