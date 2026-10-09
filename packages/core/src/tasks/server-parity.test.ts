import { describe, expect, it, vi } from "vitest";

import { createTasksClient, type TasksClient } from "./client.js";
import { prepareDeliveryManifest } from "./delivery-manifest.js";
import { parseFeeBp, taskMoney } from "./money.js";
import { missingTasksChain } from "./chain-port.js";
import { postTask, searchTasks, submitTask } from "./operations.js";
import {
  createOrderInputSchema,
  deliverEscrowInputSchema,
  eventsQuerySchema,
  milestoneTermsSchema,
  operationMutationInputSchema,
  operationStepInputSchema,
  tasksResponseSchemas,
} from "./types.js";

const ORDER = "2dff47af-a322-4b73-a081-003dc8596302";
const MILESTONE = "6e6944fb-1a10-46c8-9447-a764d4b9fc5a";
const KEY = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ADDRESS = "0x1111111111111111111111111111111111111111";
const CONTRACT = "0x2222222222222222222222222222222222222222";
const HASH = `0x${"ab".repeat(32)}`;
const NOW = "2026-08-17T12:00:00.000Z";

// Copied from app-main/apps/api/app/tasks/client/domain/chain-operation.test.ts.
const operationResponse = {
  operation: {
    id: "8ab9dcbe-9934-4e8b-981d-1c725dc2ecaf",
    kind: "escrow-funding",
    state: "prepared",
    step: "deposit-funds",
    expectedActor: ADDRESS,
    transactionHash: null,
    plan: {
      version: "work-transaction-plan-v2",
      operationId: "8ab9dcbe-9934-4e8b-981d-1c725dc2ecaf",
      step: "deposit-funds",
      chainId: 84_532,
      network: "eip155:84532",
      from: ADDRESS,
      to: CONTRACT,
      data: "0x1234",
      value: "0",
    },
  },
  milestone: { id: MILESTONE, workOrderId: ORDER },
};

const terms = {
  version: "work-milestone-terms-v1",
  title: "Ship the integration",
  description: "Implement and document it.",
  acceptanceCriteria: ["Tests pass"],
  workDurationSeconds: 600,
  acceptanceWindowSeconds: 86_400,
  budget: {
    network: "eip155:84532",
    asset: `eip155:84532/erc20:${CONTRACT}`,
    amountBaseUnits: "101",
  },
  escrow: { protocol: "escrow-v1", contract: CONTRACT },
  evidenceRules: { acceptedInputs: ["text"], exactCommitRequired: true },
};
const privateOrder = {
  version: "work-order-view-v1",
  id: ORDER,
  state: "awarded",
  title: terms.title,
  description: terms.description,
  policyFamily: "software-api",
  listingDeliveryTimeSeconds: 3600,
  clientAddress: ADDRESS,
  invitedProviderAddress: null,
  acceptedProposalId: null,
  threadId: null,
  role: "client",
  canFinalize: false,
  proposals: [],
  milestones: [],
  events: [],
  review: null,
  publishedAt: NOW,
  completedAt: null,
  createdAt: NOW,
  updatedAt: NOW,
};
const proposal = {
  id: MILESTONE,
  workOrderId: ORDER,
  providerAddress: ADDRESS,
  providerVerified: false,
  state: "pending",
  signedPayload: {
    version: "work-proposal-v1",
    workOrderId: ORDER,
    providerAddress: ADDRESS,
    pricingModel: "fixed",
    milestones: [terms],
  },
  signature: `0x${"cd".repeat(65)}`,
  signatureHash: HASH,
  proposedMilestones: [terms],
  acceptedAt: null,
  createdAt: NOW,
  updatedAt: NOW,
};
// Monetary fixtures from public-board.service.test.ts's unavailable-fee test.
const amount = { gross: "101", fee: null, net: null, asset: "USDC", feeBp: null };
const party = {
  address: ADDRESS,
  badge: { kind: "human", source: "none", owner: null, verifiedWorker: false },
};
const card = {
  id: ORDER,
  title: terms.title,
  brief: terms.description,
  shape: "open-bounty",
  amount,
  deadlineAt: null,
  durationSeconds: 600,
  createdAt: NOW,
  state: "open",
  poster: party,
  takers: 0,
  awards: 0,
  maxAwards: 1,
  proofKinds: ["url"],
  audience: "anyone",
  receiptUrl: null,
};
const numbers = {
  escrowedNow: "0",
  paidOutAllTime: "0",
  tasksSettled: 0,
  agentsActive30d: 0,
  feeBp: null,
};
const unconfigured = {
  configured: false,
  chainId: 84532,
  network: "eip155:84532",
  networkLabel: "Base Sepolia",
  feeBp: null,
  explorerUrl: null,
  capabilities: { erc3009Funding: false, vapiVerify: false },
  eip3009Domain: null,
};
const configured = {
  ...unconfigured,
  configured: true,
  explorerUrl: "https://sepolia.basescan.org",
  escrowContract: CONTRACT,
  feeRouter: CONTRACT,
  usdc: CONTRACT,
  maxEscrowAmountBaseUnits: "500000000",
  defaults: { workDurationSeconds: 600 },
  verifyReviewPriceBaseUnits: null,
};
function context(client: Partial<TasksClient>) {
  return {
    client: client as TasksClient,
    chain: missingTasksChain,
    baseUrl: "https://tasks.example",
    randomUUID: () => KEY,
    signInHint: "Run vapi login.",
  };
}

describe("merged server response contracts", () => {
  it("preserves ordinary and submission awards through transport", async () => {
    const awards = [
      { workOrder: privateOrder },
      { childOrderId: MILESTONE, awards: 1, maxAwards: 2, parentState: "open" },
      { childOrderId: MILESTONE, awards: 2, maxAwards: 2, parentState: "completed" },
    ];
    for (const award of awards) {
      const fetch = vi.fn(async () => Response.json(award));
      const client = createTasksClient({ baseUrl: "https://tasks.example", fetch });
      expect(
        await client.acceptProposal(ORDER, { proposalId: MILESTONE }, { idempotencyKey: KEY }),
      ).toEqual(award);
    }
  });

  it("parses board and earn without call totals and with nullable monetary fields", async () => {
    const cards = [card, { ...card, id: MILESTONE, amount: null }];
    const board = { pinned: card, numbers, cards, nextCursor: null };
    const earn = { numbers, topEarners: { humans: [], agents: [] }, openByPayout: cards };
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json(board))
      .mockResolvedValueOnce(Response.json(earn));
    const client = createTasksClient({ baseUrl: "https://tasks.example", fetch });
    expect(await client.board()).toEqual(board);
    expect(await client.earn()).toEqual(earn);
    expect(
      tasksResponseSchemas.publicTask.parse({ ...card, briefFull: card.brief, children: [] })
        ?.amount,
    ).toEqual(amount);
    expect(taskMoney(amount.gross, parseFeeBp(amount))).toMatchObject({
      fee: null,
      net: null,
      line: "$0.000101 gross · fee unavailable",
    });
  });

  it("preserves unavailable receipt allocations and fees", async () => {
    const receipt = {
      escrow: CONTRACT,
      orderId: ORDER,
      title: card.title,
      poster: party,
      worker: party,
      amount,
      postedAt: NOW,
      fundedAt: NOW,
      deliveredAt: NOW,
      settledAt: NOW,
      outcome: "released",
      allocations: null,
      txs: { funded: HASH, settled: HASH },
      explorerUrl: "https://sepolia.basescan.org",
      disputed: false,
      network: "eip155:84532",
    };
    const client = createTasksClient({
      baseUrl: "https://tasks.example",
      fetch: async () => Response.json(receipt),
    });
    expect(await client.receipt(CONTRACT)).toEqual(receipt);
  });

  it.each([unconfigured, configured])(
    "accepts null readiness fees for configured=$configured",
    async (deployment) => {
      const client = createTasksClient({
        baseUrl: "https://tasks.example",
        fetch: async () => Response.json(deployment),
      });
      const parsed = await client.deployment();
      expect(parsed).toEqual(deployment);
      expect(parseFeeBp(parsed)).toBeNull();
    },
  );

  it("allows 600-second terms in requests and nested proposal and scope responses", () => {
    expect(milestoneTermsSchema.parse(terms).workDurationSeconds).toBe(600);
    expect(milestoneTermsSchema.safeParse({ ...terms, workDurationSeconds: 599 }).success).toBe(
      false,
    );
    expect(
      tasksResponseSchemas.propose.parse({ proposal }).proposal.proposedMilestones[0]
        ?.workDurationSeconds,
    ).toBe(600);
    expect(
      tasksResponseSchemas.getOrder.parse({ workOrder: { ...privateOrder, proposals: [proposal] } })
        .workOrder.id,
    ).toBe(ORDER);
    const scope = {
      id: MILESTONE,
      workOrderId: ORDER,
      trancheOrdinal: 1,
      version: 1,
      state: "proposed",
      structuredTerms: { ...terms, deliverables: ["Source code"], revisionCount: 0, deadline: NOW },
      brief: "Ship the exact integration.",
      termsHash: HASH,
      proposedByRole: "client",
      proposerAddress: ADDRESS,
      proposerSignature: proposal.signature,
      counterpartyAddress: null,
      counterpartySignature: null,
      acceptedAt: null,
      milestoneId: null,
      createdAt: NOW,
      signingPayload: {
        version: "work-scope-signature-v1",
        workOrderId: ORDER,
        trancheOrdinal: 1,
        scopeVersion: 1,
        termsHash: HASH,
      },
    };
    expect(
      tasksResponseSchemas.getScopes.parse({ scopes: [scope] }).scopes[0]?.structuredTerms
        .workDurationSeconds,
    ).toBe(600);
    const order = { title: card.title, description: card.brief, policyFamily: "software-api" };
    expect(
      createOrderInputSchema.safeParse({ ...order, listingDeliveryTimeSeconds: 600 }).success,
    ).toBe(false);
    expect(
      createOrderInputSchema.safeParse({ ...order, listingDeliveryTimeSeconds: 3600 }).success,
    ).toBe(true);
  });

  it("accepts note-only server deliveries while protecting ordinary manifest preparation", async () => {
    // Adapted from the server chain-operation.test.ts noteOnlyResponse fixture.
    const response = {
      ...operationResponse,
      operation: {
        ...operationResponse.operation,
        kind: "escrow-delivery",
        step: "submit-delivery",
        plan: { ...operationResponse.operation.plan, step: "submit-delivery" },
      },
      delivery: {
        id: "e6deaa12-39f4-4eb2-a81d-448afc768e2b",
        milestoneId: MILESTONE,
        version: 1,
        manifest: { files: [], noteSha256: "cd".repeat(32) },
        manifestHash: `0x${"ef".repeat(32)}`,
        submittedByProfileId: "22222222-2222-4222-8222-222222222222",
        createdAt: NOW,
      },
    };
    const input = { fileIds: [], note: "Submission proof is the delivery." };
    expect(deliverEscrowInputSchema.parse(input)).toEqual(input);
    expect(deliverEscrowInputSchema.safeParse({ ...input, note: " " }).success).toBe(false);
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json(response));
    const client = createTasksClient({ baseUrl: "https://tasks.example", fetch });
    expect(await client.deliverEscrow(MILESTONE, input, { idempotencyKey: KEY })).toEqual(response);
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual(input);
    await expect(prepareDeliveryManifest([], input.note)).rejects.toThrow(
      "Upload at least one delivery file.",
    );
  });
});

describe("operation recovery protocol", () => {
  it.each([
    [false, true],
    [false, false],
    [true, true],
  ])("preserves recovered=%s scanComplete=%s", (recovered, scanComplete) => {
    const response = { ...operationResponse, recovered, scanComplete };
    expect(tasksResponseSchemas.recoverOperation.parse(response)).toEqual(response);
  });
  it("defaults scanComplete as the server does and rejects inconsistent recovery", () => {
    expect(
      tasksResponseSchemas.recoverOperation.parse({ ...operationResponse, recovered: false })
        .scanComplete,
    ).toBe(true);
    expect(
      tasksResponseSchemas.recoverOperation.safeParse({
        ...operationResponse,
        recovered: true,
        scanComplete: false,
      }).success,
    ).toBe(false);
  });
  it.each(["abandoned", "recovered", "scanning"])("validates the %s abandon outcome", (outcome) => {
    const response = {
      outcome,
      operation: outcome === "abandoned" ? null : operationResponse.operation,
      milestone: operationResponse.milestone,
    };
    expect(tasksResponseSchemas.abandonOperation.parse(response)).toEqual(response);
    expect(
      tasksResponseSchemas.abandonOperation.safeParse({
        ...response,
        operation: outcome === "abandoned" ? operationResponse.operation : null,
      }).success,
    ).toBe(false);
  });
  it.each([
    "create-escrow",
    "approve-usdc",
    "deposit-funds",
    "fund-with-authorization",
    "submit-delivery",
    "release-funds",
    "refund-buyer",
    "raise-dispute",
    "timeout-refund",
    "finalize",
    "vote-dispute",
    "mint-vendor-credential",
  ])("accepts the server operation step %s", (step) => {
    const response = {
      ...operationResponse,
      operation: {
        ...operationResponse.operation,
        step,
        plan: { ...operationResponse.operation.plan, step },
      },
    };
    expect(tasksResponseSchemas.recordTransaction.parse(response)).toEqual(response);
    expect(operationStepInputSchema.parse({ step })).toEqual({ step });
  });
  it.each([
    "escrow-create",
    "escrow-funding",
    "escrow-delivery",
    "escrow-release",
    "escrow-dispute",
    "escrow-vote",
    "escrow-finalize",
    "vendor-credential-mint",
  ])("accepts operation kind %s", (kind) => {
    expect(
      tasksResponseSchemas.reconcileOperation.parse({
        ...operationResponse,
        operation: { ...operationResponse.operation, kind },
      }).operation.kind,
    ).toBe(kind);
  });
  it("accepts the broader request step and rejects unknown or extra request fields", () => {
    expect(
      operationMutationInputSchema.parse({ step: "register-erc8004", transactionHash: HASH }),
    ).toEqual({ step: "register-erc8004", transactionHash: HASH });
    expect(operationStepInputSchema.parse({ step: "register-erc8004" })).toEqual({
      step: "register-erc8004",
    });
    for (const body of [{ step: "unknown" }, { step: "deposit-funds", extra: true }]) {
      expect(operationStepInputSchema.safeParse(body).success).toBe(false);
    }
    expect(
      operationMutationInputSchema.safeParse({ step: "deposit-funds", transactionHash: "0x1234" })
        .success,
    ).toBe(false);
  });
  it("preserves submitted and confirmed states, and rejects plan identity mismatches", () => {
    for (const state of ["submitted", "confirmed"]) {
      const response = {
        ...operationResponse,
        operation: {
          ...operationResponse.operation,
          state,
          transactionHash: HASH,
          plan: state === "confirmed" ? null : operationResponse.operation.plan,
        },
      };
      expect(tasksResponseSchemas.reconcileOperation.parse(response)).toEqual(response);
      expect(
        tasksResponseSchemas.reconcileOperation.safeParse({
          ...response,
          operation: { ...response.operation, transactionHash: null },
        }).success,
      ).toBe(false);
    }
    for (const patch of [
      { operationId: ORDER },
      { step: "create-escrow" },
      { from: CONTRACT },
      { network: "eip155:8453" },
    ]) {
      expect(
        tasksResponseSchemas.recordTransaction.safeParse({
          ...operationResponse,
          operation: {
            ...operationResponse.operation,
            plan: { ...operationResponse.operation.plan, ...patch },
          },
        }).success,
      ).toBe(false);
    }
  });
  it("rejects malformed completion requests before fetching", async () => {
    const fetch = vi.fn();
    const client = createTasksClient({ baseUrl: "https://tasks.example", fetch });
    const attempts = [
      () =>
        client.recordTransaction(
          ORDER,
          { step: "deposit-funds", transactionHash: "bad" },
          { idempotencyKey: KEY },
        ),
      () =>
        client.reconcileOperation(ORDER, { step: "unknown", transactionHash: HASH } as never, {
          idempotencyKey: KEY,
        }),
      () => client.recoverOperation(ORDER, { step: "unknown" } as never, { idempotencyKey: KEY }),
      () => client.abandonOperation(ORDER, { step: "unknown" } as never, { idempotencyKey: KEY }),
      () => client.finalizeEscrow(MILESTONE, { idempotencyKey: "bad" }),
      () => client.finalizeOrder(ORDER, { idempotencyKey: "bad" }),
    ];
    for (const attempt of attempts)
      await expect(
        Promise.resolve().then(async () => {
          await attempt();
        }),
      ).rejects.toMatchObject({
        code: "invalid_input",
      });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("market and money callers", () => {
  const order = { title: card.title, description: card.brief, policyFamily: "software-api" };
  const market = {
    intake: "submissions",
    maxAwards: 50,
    audience: "agents",
    proofKinds: ["url", "file", "photo"],
    budget: { network: "eip155:0", asset: "USDC", amountBaseUnits: "101" },
    deadlineAt: NOW,
  };
  it("accepts the server market boundary, including optional fields and chain zero", () => {
    expect(createOrderInputSchema.parse({ ...order, market }).market).toEqual(market);
    expect(createOrderInputSchema.parse({ ...order, market: {} }).market).toEqual({});
  });
  it.each([
    { intake: "unknown" },
    { maxAwards: 0 },
    { maxAwards: 51 },
    { maxAwards: 1.5 },
    { audience: "public" },
    { proofKinds: ["url", "url"] },
    { proofKinds: ["video"] },
    { budget: null },
    { deadlineAt: null },
    { deadlineAt: "tomorrow" },
    { budget: { ...market.budget, network: "eip155:01" } },
    { budget: { ...market.budget, asset: "ETH" } },
    { budget: { ...market.budget, amountBaseUnits: "0" } },
    { budget: { ...market.budget, amountBaseUnits: "01" } },
    { budget: { ...market.budget, amountBaseUnits: "1.5" } },
    { budget: { ...market.budget, extra: true } },
    { webhook: "https://example.com/hook" },
  ])("rejects invalid market patch %#", (patch) => {
    expect(
      createOrderInputSchema.safeParse({ ...order, market: { ...market, ...patch } }).success,
    ).toBe(false);
  });
  it.each([-20, 0, 25, 99])("normalizes integer wait %s before transport", async (wait) => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({ events: [], nextAfter: 0 }),
    );
    const client = createTasksClient({ baseUrl: "https://tasks.example", fetch });
    await client.events(ORDER, { wait });
    expect(new URL(String(fetch.mock.calls[0]?.[0])).searchParams.get("wait")).toBe(
      String(Math.min(25, Math.max(0, wait))),
    );
    expect(eventsQuerySchema.safeParse({ wait: 0.5 }).success).toBe(false);
  });
  it("filters nullable budgets without treating base units as dollars", async () => {
    const board = tasksResponseSchemas.board.parse({
      pinned: { ...card, amount: null },
      numbers,
      cards: [card, { ...card, id: MILESTONE, amount: null }],
      nextCursor: null,
    });
    const client = { board: vi.fn().mockResolvedValue(board) };
    expect((await searchTasks(context(client), {})).cards).toHaveLength(2);
    expect((await searchTasks(context(client), { min: 102n })).cards).toEqual([]);
    const result = await searchTasks(context(client), { min: 101n });
    expect(result.cards.map((item) => item.id)).toEqual([ORDER]);
    expect(result.pinned).toBeNull();
  });
  it("submits the exact public base units at the 600-second boundary and fails before unlocking a missing budget", async () => {
    const detail = tasksResponseSchemas.publicTask.parse({
      ...card,
      briefFull: card.brief,
      children: [],
    });
    const submit = vi.fn().mockResolvedValue({ proposal });
    const client = {
      publicTask: vi.fn().mockResolvedValue(detail),
      deployment: vi.fn().mockResolvedValue(tasksResponseSchemas.deployment.parse(configured)),
      submit,
    };
    const signMessage = vi.fn().mockResolvedValue(proposal.signature);
    const unlock = vi.fn().mockResolvedValue({ address: ADDRESS, signMessage });
    const input = {
      id: ORDER,
      proof: [{ kind: "url" as const, value: "https://example.com/proof" }],
      files: [],
      unlock,
    };
    await submitTask(context(client), input);
    expect(submit.mock.calls[0]?.[1].signedPayload.milestones[0].budget.amountBaseUnits).toBe(
      "101",
    );
    expect(submit.mock.calls[0]?.[1].signedPayload.milestones[0].workDurationSeconds).toBe(600);
    unlock.mockClear();
    signMessage.mockClear();
    submit.mockClear();
    client.publicTask.mockResolvedValue({ ...detail, amount: null });
    await expect(submitTask(context(client), input)).rejects.toMatchObject({
      code: "invalid_input",
      message: "Task amount is unavailable.",
    });
    expect(unlock).not.toHaveBeenCalled();
    expect(signMessage).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });
  it("posts on an unconfigured deployment with a null fee and preserves the webhook secret", async () => {
    const createOrder = vi.fn().mockResolvedValue({ workOrder: privateOrder });
    const configureWebhook = vi
      .fn()
      .mockResolvedValue({ webhookUrl: "https://example.com/hook", secret: "ab".repeat(32) });
    const client = {
      deployment: vi.fn().mockResolvedValue(tasksResponseSchemas.deployment.parse(unconfigured)),
      createOrder,
      configureWebhook,
    };
    const result = await postTask(context(client), {
      order: createOrderInputSchema.parse(order),
      amount: 101n,
      deadlineAt: NOW,
      intake: "submissions",
      maxAwards: 2,
      webhook: "https://example.com/hook",
    });
    expect(createOrder).toHaveBeenCalledWith(
      {
        ...order,
        market: {
          intake: "submissions",
          maxAwards: 2,
          audience: "anyone",
          proofKinds: ["url", "file"],
          budget: { network: unconfigured.network, asset: "USDC", amountBaseUnits: "101" },
          deadlineAt: NOW,
        },
      },
      { idempotencyKey: KEY },
    );
    expect(result.money).toMatchObject({
      feeBp: null,
      fee: null,
      net: null,
      line: "$0.000101 gross · fee unavailable",
    });
    expect(result.result.webhook?.secret).toBe("ab".repeat(32));
    expect(result.unsupportedFields).toEqual([]);
  });
});
