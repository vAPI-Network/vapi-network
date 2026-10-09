import { afterEach, describe, expect, it, vi } from "vitest";

import { createTasksClient, TasksClientError } from "./client.js";
import { tasksResponseSchemas } from "./types.js";
import type {
  CreateOrderInput,
  DeliverEscrowInput,
  FundEscrowInput,
  ProposeInput,
  ProposeScopeInput,
  SendMessageInput,
} from "./types.js";

const ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ID = "22222222-2222-4222-8222-222222222222";
const KEY = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ADDRESS = "0x1111111111111111111111111111111111111111";
const OTHER_ADDRESS = "0x2222222222222222222222222222222222222222";
const HASH = `0x${"ab".repeat(32)}`;
const SIGNATURE = `0x${"cd".repeat(65)}`;
const NOW = "2026-08-17T12:00:00.000Z";
const CUID = "cmg0w1abc0000q8lc3rnl0u5t";

function scopeTerms() {
  return {
    version: "work-milestone-terms-v1" as const,
    title: "Ship the integration",
    description: "Implement and document it.",
    acceptanceCriteria: ["Tests pass"],
    workDurationSeconds: 604_800,
    acceptanceWindowSeconds: 86_400,
    budget: {
      network: "eip155:84532" as const,
      asset: `eip155:84532/erc20:${OTHER_ADDRESS}`,
      amountBaseUnits: "2500000",
    },
    escrow: { protocol: "escrow-v1" as const, contract: OTHER_ADDRESS },
    evidenceRules: { acceptedInputs: ["text" as const], exactCommitRequired: true },
  };
}

const publicOrder = {
  id: ID,
  state: "open",
  title: "Audit an API",
  description: "Review the public API and provide findings.",
  policyFamily: "software-api",
  listingDeliveryTimeSeconds: 86_400,
  publishedAt: NOW,
  createdAt: NOW,
  updatedAt: NOW,
} as const;

const milestone = {
  id: OTHER_ID,
  workOrderId: ID,
  ordinal: 1,
  state: "agreed",
  terms: scopeTerms(),
  termsHash: HASH,
  termsFrozenAt: NOW,
  network: "eip155:84532",
  asset: `eip155:84532/erc20:${OTHER_ADDRESS}`,
  amountBaseUnits: "2500000",
  escrowProtocol: "escrow-v1",
  escrowContract: OTHER_ADDRESS,
  escrowState: null,
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
} as const;

const privateOrder = {
  ...publicOrder,
  version: "work-order-view-v1",
  clientAddress: ADDRESS,
  invitedProviderAddress: null,
  acceptedProposalId: null,
  threadId: OTHER_ID,
  role: "client",
  canFinalize: false,
  proposals: [],
  milestones: [milestone],
  events: [
    {
      id: "cmg0w1abc0000q8lc3rnl0u5t",
      sequence: 1,
      type: "work-order.created",
      actor: ADDRESS,
      milestoneId: null,
      payload: { source: "tasks-client-test" },
      txHash: null,
      createdAt: NOW,
    },
  ],
  review: null,
  completedAt: null,
} as const;

const proposal = {
  id: ID,
  workOrderId: ID,
  providerAddress: ADDRESS,
  state: "pending",
  signedPayload: {
    version: "work-proposal-v1",
    workOrderId: ID,
    providerAddress: ADDRESS,
    pricingModel: "fixed",
    milestones: [scopeTerms()],
  },
  signature: SIGNATURE,
  signatureHash: HASH,
  proposedMilestones: [scopeTerms()],
  acceptedAt: null,
  createdAt: NOW,
  updatedAt: NOW,
} as const;

const operation = {
  operation: {
    id: OTHER_ID,
    kind: "escrow-funding",
    state: "prepared",
    step: "fund-with-authorization",
    expectedActor: ADDRESS,
    transactionHash: null,
    plan: {
      version: "work-transaction-plan-v2",
      operationId: OTHER_ID,
      step: "fund-with-authorization",
      chainId: 84_532,
      network: "eip155:84532",
      from: ADDRESS,
      to: OTHER_ADDRESS,
      data: "0x1234",
      value: "0",
    },
  },
  milestone: { id: ID, workOrderId: ID },
} as const;

const scope = {
  id: ID,
  workOrderId: ID,
  trancheOrdinal: 1,
  version: 1,
  state: "proposed",
  structuredTerms: {
    version: "work-milestone-terms-v1",
    title: "Ship the integration",
    description: "Implement and document it.",
    deliverables: ["Source code"],
    acceptanceCriteria: ["Tests pass"],
    revisionCount: 1,
    deadline: "2026-09-01T12:00:00.000Z",
    workDurationSeconds: 604_800,
    acceptanceWindowSeconds: 86_400,
    budget: {
      network: "eip155:84532",
      asset: `eip155:84532/erc20:${OTHER_ADDRESS}`,
      amountBaseUnits: "2500000",
    },
    escrow: { protocol: "escrow-v1", contract: OTHER_ADDRESS },
    evidenceRules: { acceptedInputs: ["text"], exactCommitRequired: true },
  },
  brief: "Ship the exact agreed integration.",
  termsHash: HASH,
  proposedByRole: "client",
  proposerAddress: ADDRESS,
  proposerSignature: SIGNATURE,
  counterpartyAddress: null,
  counterpartySignature: null,
  acceptedAt: null,
  milestoneId: null,
  createdAt: NOW,
  signingPayload: {
    version: "work-scope-signature-v1",
    workOrderId: ID,
    trancheOrdinal: 1,
    scopeVersion: 1,
    termsHash: HASH,
  },
} as const;

const message = {
  id: ID,
  threadId: OTHER_ID,
  senderProfileId: OTHER_ID,
  workOrderId: ID,
  orderId: OTHER_ID,
  seq: 7,
  senderRole: "client",
  kind: "text",
  body: "Here are the final details.",
  refType: null,
  refId: null,
  createdAt: NOW,
  attachments: [],
} as const;

const file = {
  id: ID,
  purpose: "delivery",
  fileName: "result.json",
  mimeType: "application/json",
  sizeBytes: 2,
  sha256: "ab".repeat(32),
  state: "ready",
  createdAt: NOW,
} as const;

const deployment = {
  configured: true,
  chainId: 84_532,
  network: "eip155:84532",
  explorerUrl: "https://sepolia.basescan.org",
  escrowContract: ADDRESS,
  feeRouter: OTHER_ADDRESS,
  usdc: "0x3333333333333333333333333333333333333333",
  capabilities: { erc3009Funding: true, vapiVerify: true },
  eip3009Domain: {
    name: "USDC",
    version: "2",
    chainId: 84_532,
    verifyingContract: "0x3333333333333333333333333333333333333333",
  },
  maxEscrowAmountBaseUnits: "500000000",
  defaults: { workDurationSeconds: 604_800 },
  verifyReviewPriceBaseUnits: null,
} as const;

function json(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

function recordedFetch(...responses: Response[]) {
  const requests: Request[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push(
      input instanceof Request && init === undefined ? input : new Request(input, init),
    );
    const response = responses.shift();
    if (!response) throw new Error("No canned response");
    return response;
  });
  return { fetch, requests };
}

async function requestBody(request: Request): Promise<unknown> {
  return request.clone().json();
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("tasks client recorded HTTP contract", () => {
  it("accepts CUID message ids from list and send responses", async () => {
    const cuidMessage = { ...message, id: CUID };
    const recorder = recordedFetch(
      json({ messages: [cuidMessage], page: { nextBeforeSeq: null } }),
      json({ message: cuidMessage }),
    );
    const client = createTasksClient({ baseUrl: "https://tasks.example", fetch: recorder.fetch });

    await expect(client.listMessages(ID)).resolves.toMatchObject({ messages: [{ id: CUID }] });
    await expect(
      client.sendMessage(
        ID,
        { body: "Here are the final details.", fileIds: [] },
        { idempotencyKey: KEY },
      ),
    ).resolves.toMatchObject({ message: { id: CUID } });
  });

  it("accepts a CUID dispute id in an order response", async () => {
    const disputedOrder = {
      ...privateOrder,
      milestones: [
        {
          ...milestone,
          dispute: {
            id: CUID,
            state: "open",
            network: "eip155:84532",
            escrowAddress: OTHER_ADDRESS,
            raisedByRole: "client",
            raisedByAddress: ADDRESS,
            evidenceHash: HASH,
            evidenceDeadlineAt: NOW,
            reviewers: [],
            outcome: null,
            executedTxHash: null,
            resolvedAt: null,
          },
        },
      ],
    };
    const recorder = recordedFetch(json({ workOrder: disputedOrder }));

    await expect(
      createTasksClient({ baseUrl: "https://tasks.example", fetch: recorder.fetch }).getOrder(ID),
    ).resolves.toMatchObject({ workOrder: { milestones: [{ dispute: { id: CUID } }] } });
  });

  it("records every JSON method's URL, verb, body, and headers", async () => {
    const orderPage = { workOrders: [publicOrder], page: { nextCursor: OTHER_ID } };
    const orderResponse = { workOrder: publicOrder };
    const privateOrderResponse = { workOrder: privateOrder };
    const proposalResponse = { proposal };
    const scopePage = { scopes: [scope] };
    const scopeResponse = { scope };
    const signedScopeResponse = {
      scope: {
        ...scope,
        state: "accepted",
        counterpartyAddress: OTHER_ADDRESS,
        counterpartySignature: SIGNATURE,
        acceptedAt: NOW,
        milestoneId: OTHER_ID,
      },
      milestone: {
        id: OTHER_ID,
        workOrderId: scope.workOrderId,
        ordinal: 1,
        termsHash: HASH,
        termsFrozenAt: NOW,
      },
    };
    const messagePage = { messages: [message], page: { nextBeforeSeq: 6 } };
    const messageResponse = { message };
    const deliveryOperation = {
      ...operation,
      operation: {
        ...operation.operation,
        kind: "escrow-delivery",
        step: "submit-delivery",
        plan: { ...operation.operation.plan, step: "submit-delivery" },
      },
      delivery: {
        id: OTHER_ID,
        milestoneId: ID,
        version: 1,
        manifest: {
          files: [{ fileId: ID, fileName: "result.json", sha256: "ab".repeat(32), sizeBytes: 2 }],
          noteSha256: "cd".repeat(32),
        },
        manifestHash: HASH,
        submittedByProfileId: OTHER_ID,
        createdAt: NOW,
      },
    };
    const chainState = {
      workOrderId: ID,
      milestones: [
        {
          milestoneId: OTHER_ID,
          network: "eip155:84532",
          escrowAddress: ADDRESS,
          explorerUrl: "https://sepolia.basescan.org",
          read: {
            status: "confirmed",
            state: "locked",
            resolution: null,
            offerDeadlineAt: NOW,
            workDeadlineAt: NOW,
            reviewDeadlineAt: null,
            amountBaseUnits: "2500000",
            token: "0x3333333333333333333333333333333333333333",
            buyer: ADDRESS,
            seller: OTHER_ADDRESS,
            termsHash: HASH,
            deliveryHash: HASH,
          },
        },
      ],
      observedAt: NOW,
    };
    const upload = {
      file: { ...file, state: "pending", sha256: null },
      uploadUrl: "https://storage.example/upload",
    };
    const recorder = recordedFetch(
      json(orderPage),
      json(orderResponse),
      json(privateOrderResponse),
      json(proposalResponse),
      json(privateOrderResponse),
      json(scopePage),
      json(scopeResponse),
      json(signedScopeResponse),
      json(messagePage),
      json(messageResponse),
      json(operation),
      json(operation),
      json(deliveryOperation),
      json(operation),
      json(operation),
      json(operation),
      json(chainState),
      json(upload),
      json({ file }),
      json(operation),
      json(operation),
      json({ ...operation, recovered: false, scanComplete: true }),
      json({ outcome: "abandoned", operation: null, milestone: operation.milestone }),
      json(operation),
      json({ workOrder: { id: ID, state: "completed", completedAt: NOW } }),
      json({ webhookUrl: "https://example.com/hook", secret: "secret" }),
      json(deployment),
    );
    const client = createTasksClient({
      baseUrl: "https://tasks.example///",
      token: "token-123",
      fetch: recorder.fetch,
    });
    const createInput = {
      title: "Audit an API",
      description: "Review the public API.",
      policyFamily: "software-api",
    } satisfies CreateOrderInput;
    const proposalInput = {
      signedPayload: {
        version: "work-proposal-v1",
        workOrderId: ID,
        providerAddress: ADDRESS,
        pricingModel: "fixed",
        milestones: [scopeTerms()],
      },
      signature: SIGNATURE,
    } satisfies ProposeInput;
    const scopeInput = {
      structuredTerms: {
        ...scope.structuredTerms,
        acceptanceCriteria: [...scope.structuredTerms.acceptanceCriteria],
        deliverables: [...scope.structuredTerms.deliverables],
        evidenceRules: {
          ...scope.structuredTerms.evidenceRules,
          acceptedInputs: [...scope.structuredTerms.evidenceRules.acceptedInputs],
        },
      },
      brief: scope.brief,
      signedPayload: {
        version: "work-scope-signature-v1",
        workOrderId: ID,
        trancheOrdinal: 1,
        scopeVersion: 1,
        termsHash: HASH,
      },
      signature: SIGNATURE,
    } satisfies ProposeScopeInput;
    const sendInput = {
      body: "Here are the final details.",
      fileIds: [ID],
    } satisfies SendMessageInput;
    const authorization = {
      validAfter: "0",
      validBefore: "18446744073709551615",
      nonce: HASH,
      signature: SIGNATURE,
    };
    const fundingInput = { authorization } satisfies FundEscrowInput;
    const deliveryInput = { fileIds: [ID], note: "Delivered." } satisfies DeliverEscrowInput;

    await client.listOrders({ scope: "public", cursor: OTHER_ID });
    await client.getOrder("an/id");
    await client.createOrder(createInput, { idempotencyKey: KEY });
    await client.propose(ID, proposalInput, { idempotencyKey: KEY });
    await client.acceptProposal(ID, { proposalId: OTHER_ID }, { idempotencyKey: KEY });
    await client.getScopes(ID);
    await client.proposeScope(ID, scopeInput, { idempotencyKey: KEY });
    await client.signScope(
      "scope/id",
      { signedPayload: scope.signingPayload, signature: SIGNATURE },
      { idempotencyKey: KEY },
    );
    await client.listMessages(ID, { beforeSeq: 7 });
    await client.sendMessage(ID, sendInput, { idempotencyKey: KEY });
    await client.createEscrow(ID, { idempotencyKey: KEY });
    await client.fundEscrow(ID, fundingInput, { idempotencyKey: KEY });
    await client.deliverEscrow(ID, deliveryInput, { idempotencyKey: KEY });
    await client.releaseEscrow(ID, { idempotencyKey: KEY });
    await client.refundEscrow(ID, { idempotencyKey: KEY });
    await client.disputeEscrow(ID, { evidenceHash: HASH }, { idempotencyKey: KEY });
    await client.chainState(ID);
    await client.createUpload({
      purpose: "delivery",
      fileName: "result.json",
      mimeType: "application/json",
      sizeBytes: 2,
    });
    await client.finalizeUpload(ID);
    await client.recordTransaction(
      ID,
      { step: "create-escrow", transactionHash: HASH },
      { idempotencyKey: KEY },
    );
    await client.reconcileOperation(
      ID,
      { step: "create-escrow", transactionHash: HASH },
      { idempotencyKey: KEY },
    );
    await client.recoverOperation(ID, { step: "create-escrow" }, { idempotencyKey: KEY });
    await client.abandonOperation(ID, { step: "create-escrow" }, { idempotencyKey: KEY });
    await client.finalizeEscrow(ID, { idempotencyKey: KEY });
    await client.finalizeOrder(ID, { idempotencyKey: KEY });
    await client.configureWebhook(ID, { url: "https://example.com/hook" });
    await client.deployment();

    const expected = [
      [
        "GET",
        `https://tasks.example/v1/work-orders?scope=public&cursor=${OTHER_ID}`,
        undefined,
        false,
      ],
      ["GET", "https://tasks.example/v1/work-orders/an%2Fid", undefined, false],
      ["POST", "https://tasks.example/v1/work-orders", createInput, true],
      ["POST", `https://tasks.example/v1/work-orders/${ID}/proposals`, proposalInput, true],
      ["POST", `https://tasks.example/v1/work-orders/${ID}/accept`, { proposalId: OTHER_ID }, true],
      ["GET", `https://tasks.example/v1/work-orders/${ID}/scopes`, undefined, false],
      ["POST", `https://tasks.example/v1/work-orders/${ID}/scopes`, scopeInput, true],
      [
        "POST",
        "https://tasks.example/v1/scopes/scope%2Fid",
        { action: "accept", signedPayload: scope.signingPayload, signature: SIGNATURE },
        true,
      ],
      ["GET", `https://tasks.example/v1/work-orders/${ID}/messages?beforeSeq=7`, undefined, false],
      ["POST", `https://tasks.example/v1/work-orders/${ID}/messages`, sendInput, true],
      ["POST", `https://tasks.example/v1/work-orders/${ID}/escrow`, {}, true],
      ["POST", `https://tasks.example/v1/escrows/${ID}/fund`, { authorization }, true],
      ["POST", `https://tasks.example/v1/escrows/${ID}/deliver`, deliveryInput, true],
      ["POST", `https://tasks.example/v1/escrows/${ID}/release`, {}, true],
      ["POST", `https://tasks.example/v1/escrows/${ID}/refund`, {}, true],
      ["POST", `https://tasks.example/v1/escrows/${ID}/dispute`, { evidenceHash: HASH }, true],
      ["GET", `https://tasks.example/v1/work-orders/${ID}/chain-state`, undefined, false],
      [
        "POST",
        "https://tasks.example/v1/files",
        {
          purpose: "delivery",
          fileName: "result.json",
          mimeType: "application/json",
          sizeBytes: 2,
        },
        false,
      ],
      ["POST", `https://tasks.example/v1/files/${ID}/finalize`, undefined, false],
      [
        "POST",
        `https://tasks.example/v1/work-operations/${ID}/transactions`,
        { step: "create-escrow", transactionHash: HASH },
        true,
      ],
      [
        "POST",
        `https://tasks.example/v1/work-operations/${ID}/reconcile`,
        { step: "create-escrow", transactionHash: HASH },
        true,
      ],
      [
        "POST",
        `https://tasks.example/v1/work-operations/${ID}/recover`,
        { step: "create-escrow" },
        true,
      ],
      [
        "POST",
        `https://tasks.example/v1/work-operations/${ID}/abandon`,
        { step: "create-escrow" },
        true,
      ],
      ["POST", `https://tasks.example/v1/escrows/${ID}/finalize`, {}, true],
      ["POST", `https://tasks.example/v1/work-orders/${ID}/finalize`, {}, true],
      [
        "POST",
        `https://tasks.example/v1/work-orders/${ID}/webhook`,
        { url: "https://example.com/hook" },
        false,
      ],
      ["GET", "https://tasks.example/api/tasks/readiness", undefined, false],
    ] as const;
    expect(recorder.requests).toHaveLength(expected.length);
    for (const [index, [method, url, body, idempotent]] of expected.entries()) {
      const request = recorder.requests[index]!;
      expect([request.method, request.url]).toEqual([method, url]);
      expect(request.redirect).toBe("manual");
      expect(request.headers.get("accept")).toBe("application/json");
      expect(request.headers.get("authorization")).toBe("Bearer token-123");
      expect(request.headers.get("idempotency-key")).toBe(idempotent ? KEY : null);
      if (body === undefined) {
        expect(request.headers.get("content-type")).toBeNull();
        expect(await request.clone().text()).toBe("");
      } else {
        expect(request.headers.get("content-type")).toBe("application/json");
        expect(await requestBody(request)).toEqual(body);
      }
    }
  });

  it("omits authorization when no token is configured", async () => {
    const recorder = recordedFetch(json({ workOrders: [], page: { nextCursor: null } }));
    await createTasksClient({
      baseUrl: "https://tasks.example",
      fetch: recorder.fetch,
    }).listOrders({ scope: "public" });
    expect(recorder.requests[0]!.headers.has("authorization")).toBe(false);
  });

  it("tolerates unknown response fields and reports the missing field path", async () => {
    const extras = recordedFetch(json({ ...deployment, ignored: "server drift" }));
    await expect(
      createTasksClient({ baseUrl: "https://tasks.example", fetch: extras.fetch }).deployment(),
    ).resolves.toMatchObject(deployment);
    const invalid = recordedFetch(json({ ...deployment, capabilities: { vapiVerify: true } }));
    const error = await createTasksClient({
      baseUrl: "https://tasks.example",
      fetch: invalid.fetch,
    })
      .deployment()
      .catch((value: unknown) => value);
    expect(error).toMatchObject({ name: "TasksClientError", code: "invalid_response" });
    expect(String((error as Error).message)).toContain("capabilities.erc3009Funding");
  });

  it.each([
    [
      "private client address",
      { ...privateOrder, clientAddress: "not-an-address" },
      "clientAddress",
    ],
    [
      "nested proposal address",
      { ...privateOrder, proposals: [{ ...proposal, providerAddress: "not-an-address" }] },
      "providerAddress",
    ],
    [
      "nondecimal signed amount",
      {
        ...privateOrder,
        milestones: [
          {
            ...milestone,
            terms: {
              ...scopeTerms(),
              budget: { ...scopeTerms().budget, amountBaseUnits: "not-a-number" },
            },
          },
        ],
      },
      "amountBaseUnits",
    ],
    [
      "nested milestone amount",
      {
        ...privateOrder,
        milestones: [{ ...milestone, amountBaseUnits: "-1" }],
      },
      "amountBaseUnits",
    ],
    [
      "nested milestone hash",
      {
        ...privateOrder,
        milestones: [{ ...milestone, termsHash: "0x12" }],
      },
      "termsHash",
    ],
    [
      "nested milestone asset",
      { ...privateOrder, milestones: [{ ...milestone, asset: "not-an-asset" }] },
      "asset",
    ],
  ])(
    "rejects %s without downgrading a private order to public",
    async (_label, workOrder, path) => {
      const recorder = recordedFetch(json({ workOrder }));
      const error = await createTasksClient({
        baseUrl: "https://tasks.example",
        fetch: recorder.fetch,
      })
        .getOrder(ID)
        .catch((value: unknown) => value);
      expect(error).toMatchObject({ code: "invalid_response" });
      expect((error as Error).message).toContain(path);
    },
  );

  it.each([
    [{ ...milestone, network: "eip155:1" }, "workOrder.milestones.0.asset"],
    [
      {
        ...milestone,
        terms: {
          ...scopeTerms(),
          budget: { ...scopeTerms().budget, network: "eip155:1" },
        },
      },
      "workOrder.milestones.0.terms.budget.asset",
    ],
  ])("rejects mismatched asset networks", async (invalidMilestone, path) => {
    const recorder = recordedFetch(
      json({ workOrder: { ...privateOrder, milestones: [invalidMilestone] } }),
    );
    const error = await createTasksClient({
      baseUrl: "https://tasks.example",
      fetch: recorder.fetch,
    })
      .getOrder(ID)
      .catch((value: unknown) => value);
    expect(error).toMatchObject({ code: "invalid_response" });
    expect((error as Error).message).toContain(path);
  });

  it.each([
    ["prepared operation without plan", { ...operation.operation, plan: null }, "operation.plan"],
    [
      "plan network and chain mismatch",
      { ...operation.operation, plan: { ...operation.operation.plan, network: "eip155:1" } },
      "operation.plan.network",
    ],
  ])("rejects %s", async (_label, invalidOperation, path) => {
    const recorder = recordedFetch(json({ ...operation, operation: invalidOperation }));
    const error = await createTasksClient({
      baseUrl: "https://tasks.example",
      fetch: recorder.fetch,
    })
      .createEscrow(ID, { idempotencyKey: KEY })
      .catch((value: unknown) => value);
    expect(error).toMatchObject({ code: "invalid_response" });
    expect((error as Error).message).toContain(path);
  });

  it("exports one response schema for every primitive client method", () => {
    expect(Object.keys(tasksResponseSchemas).sort()).toEqual([
      "abandonOperation",
      "acceptProposal",
      "board",
      "chainState",
      "configureWebhook",
      "createEscrow",
      "createOrder",
      "createUpload",
      "deliverEscrow",
      "deployment",
      "disputeEscrow",
      "earn",
      "events",
      "feed",
      "finalizeEscrow",
      "finalizeOrder",
      "finalizeUpload",
      "fundEscrow",
      "getOrder",
      "getScopes",
      "listMessages",
      "listOrders",
      "propose",
      "proposeScope",
      "publicTask",
      "receipt",
      "reconcileOperation",
      "recordTransaction",
      "recoverOperation",
      "refundEscrow",
      "releaseEscrow",
      "sendMessage",
      "signScope",
      "submit",
    ]);
  });

  it("enforces abandon outcomes and accepts cancelled finalization", () => {
    expect(
      tasksResponseSchemas.abandonOperation.safeParse({
        outcome: "abandoned",
        operation,
        milestone: operation.milestone,
      }).success,
    ).toBe(false);
    expect(
      tasksResponseSchemas.abandonOperation.safeParse({
        outcome: "recovered",
        operation: null,
        milestone: operation.milestone,
      }).success,
    ).toBe(false);
    expect(
      tasksResponseSchemas.finalizeOrder.parse({
        workOrder: { id: ID, state: "cancelled", completedAt: null },
      }),
    ).toMatchObject({ workOrder: { state: "cancelled", completedAt: null } });
  });
});

describe("tasks client errors and transport safety", () => {
  it.each([undefined, "unexpected"])(
    "reports an invalid response discriminator",
    async (configured) => {
      const recorder = recordedFetch(json({ ...deployment, configured }));
      const error = await createTasksClient({
        baseUrl: "https://tasks.example",
        fetch: recorder.fetch,
      })
        .deployment()
        .catch((value: unknown) => value);
      expect(error).toMatchObject({ code: "invalid_response" });
      expect((error as Error).message).toContain("configured");
    },
  );

  it.each([
    [
      422,
      { error: { code: "scope.closed", message: "Scope is closed" } },
      "scope.closed",
      "Scope is closed",
    ],
    [404, { error: "No longer available", code: "gone" }, "gone", "No longer available"],
    [503, {}, undefined, "Service Unavailable"],
    [400, { error: { code: 7, message: "malformed" } }, undefined, "malformed"],
  ])("normalizes HTTP status %i errors", async (status, body, serverCode, message) => {
    const recorder = recordedFetch(json(body, { status, statusText: "Service Unavailable" }));
    const error = await createTasksClient({
      baseUrl: "https://tasks.example",
      fetch: recorder.fetch,
    })
      .deployment()
      .catch((value: unknown) => value);
    expect(error).toBeInstanceOf(TasksClientError);
    expect(error).toMatchObject({
      code: "http",
      status,
      ...(serverCode ? { serverCode } : {}),
    });
    expect((error as Error).message).toContain(message);
  });

  it("does not follow redirects", async () => {
    const recorder = recordedFetch(
      new Response(null, { status: 302, headers: { location: "https://evil.example" } }),
    );
    await expect(
      createTasksClient({ baseUrl: "https://tasks.example", fetch: recorder.fetch }).deployment(),
    ).rejects.toMatchObject({ code: "http", status: 302 });
    expect(recorder.requests[0]!.redirect).toBe("manual");
  });

  it.each([
    "not a url",
    "ftp://tasks.example",
    "https://user:secret@tasks.example",
    "https://tasks.example?tenant=one",
    "https://tasks.example#fragment",
  ])("rejects invalid base URL %s before fetch", (baseUrl) => {
    const globalFetch = vi.spyOn(globalThis, "fetch");
    expect(() => createTasksClient({ baseUrl })).toThrow(TasksClientError);
    expect(globalFetch).not.toHaveBeenCalled();
  });

  it.each(["https://127.0.0.1", "https://10.2.3.4", "https://[::1]"])(
    "the default transport blocks private base URL %s",
    async (baseUrl) => {
      const globalFetch = vi.spyOn(globalThis, "fetch");
      await expect(createTasksClient({ baseUrl }).deployment()).rejects.toMatchObject({
        code: "network",
      });
      expect(globalFetch).not.toHaveBeenCalled();
    },
  );

  it("classifies transport failures", async () => {
    const fetch = vi.fn().mockRejectedValue(new TypeError("socket closed"));
    await expect(
      createTasksClient({ baseUrl: "https://tasks.example", fetch }).deployment(),
    ).rejects.toMatchObject({ code: "network" });
  });

  it("reports malformed successful JSON at the response root", async () => {
    const recorder = recordedFetch(
      new Response("{not-json", {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    await expect(
      createTasksClient({ baseUrl: "https://tasks.example", fetch: recorder.fetch }).deployment(),
    ).rejects.toMatchObject({ code: "invalid_response", status: 200 });
    await expect(
      createTasksClient({
        baseUrl: "https://tasks.example",
        fetch: recordedFetch(new Response("{not-json", { status: 200 })).fetch,
      }).deployment(),
    ).rejects.toThrow("<root>");
  });

  it("does not fetch when the caller signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetch = vi.fn();
    await expect(
      createTasksClient({ baseUrl: "https://tasks.example", fetch }).deployment({
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: "network" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("uses a 30 second default timeout", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) =>
          init?.signal?.addEventListener(
            "abort",
            () => reject(init.signal?.reason ?? new DOMException("Aborted", "AbortError")),
            { once: true },
          ),
        ),
    );
    const pending = createTasksClient({ baseUrl: "https://tasks.example", fetch }).deployment();
    const expectation = expect(pending).rejects.toMatchObject({ code: "timeout" });
    await vi.advanceTimersByTimeAsync(29_999);
    expect(fetch).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    await expectation;
  });

  it("distinguishes its timeout from a caller abort", async () => {
    vi.useFakeTimers();
    const hangingFetch = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) =>
          init?.signal?.addEventListener(
            "abort",
            () => reject(init.signal?.reason ?? new DOMException("Aborted", "AbortError")),
            { once: true },
          ),
        ),
    );
    const timed = createTasksClient({
      baseUrl: "https://tasks.example",
      fetch: hangingFetch,
      timeoutMs: 25,
    }).deployment();
    const timedExpectation = expect(timed).rejects.toMatchObject({ code: "timeout" });
    await vi.advanceTimersByTimeAsync(25);
    await timedExpectation;
    const controller = new AbortController();
    const aborted = createTasksClient({
      baseUrl: "https://tasks.example",
      fetch: hangingFetch,
      timeoutMs: 1_000,
    }).deployment({ signal: controller.signal });
    controller.abort();
    await expect(aborted).rejects.toMatchObject({ code: "network" });
  });
});

describe("tasks storage upload", () => {
  it.each([
    [{ ...file, sha256: null }, "file.sha256"],
    [{ ...file, state: "pending" }, "file.state"],
  ])("requires a finalized file with its digest", async (invalidFile, path) => {
    const recorder = recordedFetch(json({ file: invalidFile }));
    const error = await createTasksClient({
      baseUrl: "https://tasks.example",
      fetch: recorder.fetch,
    })
      .finalizeUpload(ID)
      .catch((value: unknown) => value);
    expect(error).toMatchObject({ code: "invalid_response" });
    expect((error as Error).message).toContain(path);
  });

  it("supports a destructured uploadFile and snapshots bytes before async upload creation", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const requests: Request[] = [];
    let call = 0;
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request =
        input instanceof Request && init === undefined ? input : new Request(input, init);
      requests.push(request);
      call += 1;
      if (call === 1) {
        bytes.fill(9);
        return json({
          file: { ...file, state: "pending", sha256: null, sizeBytes: 3 },
          uploadUrl: "https://storage.example/object",
        });
      }
      if (call === 2) return new Response(null, { status: 200 });
      return json({ file: { ...file, sizeBytes: 3 } });
    });
    const { uploadFile } = createTasksClient({ baseUrl: "https://tasks.example", fetch });

    await expect(uploadFile({ fileName: "a.txt", bytes })).resolves.toBeDefined();
    expect(new Uint8Array(await requests[1]!.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("uploads bytes without credentials, then finalizes with the same injected fetch", async () => {
    const pending = { ...file, state: "pending", sha256: null };
    const recorder = recordedFetch(
      json({ file: pending, uploadUrl: "https://storage.example/object" }),
      new Response(null, { status: 200 }),
      json({ file }),
    );
    const result = await createTasksClient({
      baseUrl: "https://tasks.example",
      token: "secret",
      fetch: recorder.fetch,
    }).uploadFile({
      fileName: "result.json",
      bytes: new TextEncoder().encode("{}"),
      contentType: "application/json",
    });
    expect(result).toEqual({ file });
    expect(await requestBody(recorder.requests[0]!)).toEqual({
      purpose: "delivery",
      fileName: "result.json",
      mimeType: "application/json",
      sizeBytes: 2,
    });
    const put = recorder.requests[1]!;
    expect([put.method, put.url]).toEqual(["PUT", "https://storage.example/object"]);
    expect(put.headers.get("content-type")).toBe("application/json");
    expect(put.headers.get("x-upsert")).toBe("false");
    expect(put.headers.has("authorization")).toBe(false);
    expect(new Uint8Array(await put.arrayBuffer())).toEqual(new TextEncoder().encode("{}"));
    expect([recorder.requests[2]!.method, recorder.requests[2]!.url]).toEqual([
      "POST",
      `https://tasks.example/v1/files/${ID}/finalize`,
    ]);
  });

  it.each([500, 302])("does not finalize after upload status %i", async (status) => {
    const recorder = recordedFetch(
      json({
        file: { ...file, state: "pending", sha256: null },
        uploadUrl: "https://tasks.example/storage",
      }),
      new Response(null, { status }),
    );
    await expect(
      createTasksClient({
        baseUrl: "https://tasks.example",
        token: "secret",
        fetch: recorder.fetch,
      }).uploadFile({ fileName: "a.txt", bytes: new Uint8Array([1]), contentType: "text/plain" }),
    ).rejects.toMatchObject({ code: "http", status });
    expect(recorder.requests).toHaveLength(2);
    expect(recorder.requests[1]!.headers.has("authorization")).toBe(false);
    expect(recorder.requests[1]!.redirect).toBe("manual");
  });
});
