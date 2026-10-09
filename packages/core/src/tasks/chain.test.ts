import {
  createPublicClient,
  custom,
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionData,
  encodeFunctionResult,
  keccak256,
  parseTransaction,
  stringToHex,
  type Address,
  type Hex,
  type LocalAccount,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it, vi } from "vitest";

import { TasksChainError, type TaskMilestone } from "./chain-port.js";
import { canonicalJson } from "./canonical-json.js";
import { createTasksChain as createRawTasksChain } from "./chain.js";
import { TasksClientError, type TasksClient } from "./client.js";
import { prepareDeliveryManifest } from "./delivery-manifest.js";
import type { PendingTransaction, PendingTransactions } from "./pending-transactions.js";
import { TASKS_CHAIN_ABI, TASKS_READ_ABI } from "./plan-guard.js";
import { freezeScopeTerms } from "./scope-terms.js";
import type {
  CreateEscrowResponse,
  DeploymentResponse,
  GetOrderResponse,
  ReconcileOperationResponse,
} from "./types.js";

const account = privateKeyToAccount(`0x${"11".repeat(32)}`);
const buyerAccount = privateKeyToAccount(`0x${"22".repeat(32)}`);
const buyer: Address = buyerAccount.address;
const factory: Address = "0x3333333333333333333333333333333333333333";
const escrow: Address = "0x4444444444444444444444444444444444444444";
const usdc: Address = "0x5555555555555555555555555555555555555555";
const orderId = "10000000-0000-4000-8000-000000000001";
const milestoneId = "10000000-0000-4000-8000-000000000002";
const operationId = "10000000-0000-4000-8000-000000000003";
const key = "10000000-0000-4000-8000-000000000004";
const scopeBrief = "Build and deliver the agreed chain adapter.";
const milestoneTerms = {
  version: "work-milestone-terms-v1" as const,
  title: "Build adapter",
  description: "Build the complete chain adapter.",
  deliverables: ["Chain adapter"],
  acceptanceCriteria: ["All focused tests pass"],
  revisionCount: 1,
  deadline: "2030-01-01T00:00:00.000Z",
  workDurationSeconds: 3600,
  acceptanceWindowSeconds: 600,
  budget: {
    network: "eip155:84532" as const,
    asset: `eip155:84532/erc20:${usdc}`,
    amountBaseUnits: "1000000",
  },
  escrow: { protocol: "escrow-v1" as const, contract: factory },
  evidenceRules: { acceptedInputs: ["text" as const], exactCommitRequired: false },
};
const frozenScope = freezeScopeTerms(milestoneTerms, scopeBrief);
const termsHash = frozenScope.termsHash;

function createTasksChain(options: Parameters<typeof createRawTasksChain>[0]) {
  return createRawTasksChain({
    ...options,
    trustedFactories: { "84532": factory },
  });
}

const deployment = {
  configured: true,
  chainId: 84532,
  network: "eip155:84532",
  explorerUrl: "https://sepolia.basescan.org",
  escrowContract: factory,
  feeRouter: "0x7777777777777777777777777777777777777777",
  usdc,
  feeBp: 0,
  capabilities: { erc3009Funding: false, vapiVerify: false },
  eip3009Domain: null,
  maxEscrowAmountBaseUnits: "1000000000",
  defaults: { workDurationSeconds: 3600 },
  verifyReviewPriceBaseUnits: null,
} satisfies Extract<DeploymentResponse, { configured: true }>;

const milestone: TaskMilestone = {
  id: milestoneId,
  workOrderId: orderId,
  ordinal: 1,
  state: "funded",
  terms: milestoneTerms,
  termsHash,
  termsFrozenAt: "2026-01-01T00:00:00.000Z",
  network: "eip155:84532",
  asset: `eip155:84532/erc20:${usdc}`,
  amountBaseUnits: "1000000",
  escrowProtocol: "escrow-v1",
  escrowContract: escrow,
  escrowState: "locked",
  resolution: null,
  offerDeadlineAt: "2030-01-01T00:00:00.000Z",
  workDeadlineAt: null,
  acceptanceDeadlineAt: null,
  dispute: null,
  chainOperation: null,
  artifact: null,
  fundingTxHash: null,
  settlementTxHash: null,
  fundedAt: null,
  deliveredAt: null,
  settledAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const order = {
  version: "work-order-view-v1",
  id: orderId,
  role: "provider",
  clientAddress: buyer,
  invitedProviderAddress: null,
  acceptedProposalId: "10000000-0000-4000-8000-000000000005",
  proposals: [{ id: "10000000-0000-4000-8000-000000000005", providerAddress: account.address }],
  milestones: [milestone],
} as unknown as Extract<GetOrderResponse["workOrder"], { version: "work-order-view-v1" }>;

const buyerOrder = {
  ...order,
  role: "client",
  clientAddress: account.address,
  proposals: [
    { id: "10000000-0000-4000-8000-000000000005", providerAddress: buyerAccount.address },
  ],
} as Extract<GetOrderResponse["workOrder"], { version: "work-order-view-v1" }>;

async function acceptedScope(scopeMilestoneId = milestoneId, trancheOrdinal = 1) {
  const signingPayload = {
    version: "work-scope-signature-v1" as const,
    workOrderId: orderId,
    trancheOrdinal,
    scopeVersion: 1,
    termsHash,
  };
  const message = canonicalJson(signingPayload);
  return {
    id: "10000000-0000-4000-8000-000000000011",
    workOrderId: orderId,
    trancheOrdinal,
    version: 1,
    state: "accepted" as const,
    structuredTerms: milestoneTerms,
    brief: scopeBrief,
    termsHash,
    proposedByRole: "client" as const,
    proposerAddress: buyer,
    proposerSignature: await buyerAccount.signMessage({ message }),
    counterpartyAddress: account.address,
    counterpartySignature: await account.signMessage({ message }),
    acceptedAt: "2026-01-01T00:00:00.000Z",
    milestoneId: scopeMilestoneId,
    createdAt: "2026-01-01T00:00:00.000Z",
    signingPayload,
  };
}

function operation(
  state: "prepared" | "submitted" | "confirmed",
  step: "release-funds" = "release-funds",
  txHash: Hex | null = null,
) {
  return {
    id: operationId,
    kind: "escrow-release" as const,
    state,
    step,
    expectedActor: account.address,
    transactionHash: txHash,
    plan:
      state === "confirmed"
        ? null
        : {
            version: "work-transaction-plan-v2" as const,
            operationId,
            step,
            chainId: 84532,
            network: "eip155:84532" as const,
            from: account.address,
            to: escrow,
            data: encodeFunctionData({ abi: TASKS_CHAIN_ABI, functionName: "releaseFunds" }),
            value: "0" as const,
          },
  };
}

function response(op: ReturnType<typeof operation>) {
  return { operation: op, milestone: { id: milestoneId, workOrderId: orderId } };
}

type Step = CreateEscrowResponse["operation"]["step"];

function operationFor(input: {
  step: Step;
  data: Hex;
  state?: "prepared" | "submitted" | "confirmed";
  txHash?: Hex | null;
  to?: Address;
  kind?: CreateEscrowResponse["operation"]["kind"];
  id?: string;
}): CreateEscrowResponse["operation"] {
  const state = input.state ?? "submitted";
  const txHash = input.txHash ?? (state === "prepared" ? null : (`0x${"ac".repeat(32)}` as Hex));
  return {
    id: input.id ?? operationId,
    kind: input.kind ?? "escrow-release",
    state,
    step: input.step,
    expectedActor: account.address,
    transactionHash: txHash,
    plan:
      state === "confirmed"
        ? null
        : {
            version: "work-transaction-plan-v2",
            operationId: input.id ?? operationId,
            step: input.step,
            chainId: 84532,
            network: "eip155:84532",
            from: account.address,
            to: input.to ?? escrow,
            data: input.data,
            value: "0",
          },
  };
}

function anyResponse(
  op: ReturnType<typeof operationFor>,
  selected: Pick<TaskMilestone, "id" | "workOrderId"> = milestone,
): CreateEscrowResponse {
  return {
    operation: op,
    milestone: { id: selected.id, workOrderId: selected.workOrderId },
  };
}

function memoryPending(): PendingTransactions {
  const entries = new Map<string, PendingTransaction>();
  const authorizations = new Map<
    string,
    Awaited<ReturnType<PendingTransactions["fundingAuthorization"]>>
  >();
  const checkpoints = new Map<string, ReconcileOperationResponse>();
  const recoveryCursors = new Map<string, number>();
  const exposures = new Set<string>();
  const preparations = new Map<string, { idempotencyKey: string; inputs: unknown }>();
  const preparationOperations = new Map<string, string>();
  const signerLocks = new Map<string, Promise<void>>();
  return {
    get: async (id, step) => entries.get(`${id}:${step}`),
    put: async (id, step, entry) => {
      entries.set(`${id}:${step}`, entry);
    },
    remove: async (id, step) => {
      entries.delete(`${id}:${step}`);
    },
    withStepLock: async (_id, _step, fn) => fn(),
    withSignerLock: async (chainId, signer, fn) => {
      const storageKey = `${chainId}:${signer.toLowerCase()}`;
      const previous = signerLocks.get(storageKey) ?? Promise.resolve();
      let release!: () => void;
      const current = new Promise<void>((resolve) => {
        release = resolve;
      });
      signerLocks.set(storageKey, current);
      await previous;
      try {
        return await fn();
      } finally {
        release();
        if (signerLocks.get(storageKey) === current) signerLocks.delete(storageKey);
      }
    },
    withFundingLock: async (_milestoneId, fn) => fn(),
    nextNonce: async (chainId, signer) => {
      const nonces = [...entries.values()]
        .filter(
          (entry) =>
            entry.chainId === chainId && entry.signer.toLowerCase() === signer.toLowerCase(),
        )
        .map((entry) => entry.nonce);
      return nonces.length === 0 ? 0 : Math.max(...nonces) + 1;
    },
    exposure: async (id) => exposures.has(id),
    markExposure: async (id) => {
      exposures.add(id);
    },
    preparation: async (id, verb) => preparations.get(`${id}:${verb}`),
    putPreparation: async (id, verb, value) => {
      const storageKey = `${id}:${verb}`;
      const saved = preparations.get(storageKey);
      if (saved && JSON.stringify(saved) !== JSON.stringify(value))
        throw new Error(`Preparation ${storageKey} is immutable.`);
      preparations.set(storageKey, value);
    },
    completePreparation: async (id, verb) => {
      preparations.delete(`${id}:${verb}`);
      preparationOperations.delete(`${id}:${verb}`);
    },
    bindPreparationOperation: async (id, verb, operationId) => {
      const storageKey = `${id}:${verb}`;
      const existing = preparationOperations.get(storageKey);
      if (existing && existing !== operationId)
        throw new TasksChainError(
          `Preparation ${storageKey} is already bound to another operation.`,
          true,
        );
      preparationOperations.set(storageKey, operationId);
    },
    reservationId: async (_id, generate) => generate(),
    existingReservationId: async () => undefined,
    reconciled: async (id, step) => checkpoints.get(`${id}:${step}`),
    complete: async (id, step, value) => {
      checkpoints.set(`${id}:${step}`, value);
      entries.delete(`${id}:${step}`);
    },
    recoveryCursor: async (id, step) => recoveryCursors.get(`${id}:${step}`) ?? 0,
    advanceRecovery: async (id, step, cursor) => {
      const key = `${id}:${step}`;
      recoveryCursors.set(key, Math.max(recoveryCursors.get(key) ?? 0, cursor + 1));
    },
    fundingAuthorization: async (id, idem, generate) => {
      const storageKey = `${id}:${idem}`;
      const saved = authorizations.get(storageKey);
      if (saved) return saved;
      const created = await generate();
      authorizations.set(storageKey, created);
      return created;
    },
    savedFundingAuthorization: async (id, idem) => authorizations.get(`${id}:${idem}`),
  };
}

function fakeClient(overrides: Record<string, unknown> = {}): TasksClient {
  return {
    deployment: vi.fn(async () => deployment),
    getOrder: vi.fn(async () => ({ workOrder: order })),
    getScopes: vi.fn(async () => ({ scopes: [await acceptedScope()] })),
    listOrders: vi.fn(),
    recoverOperation: vi.fn(async () => ({
      ...response(operation("prepared")),
      recovered: false,
      scanComplete: true,
    })),
    recordTransaction: vi.fn(async (_id, input) =>
      response(operation("submitted", input.step, input.transactionHash)),
    ),
    reconcileOperation: vi.fn(async (_id, input) =>
      response(operation("confirmed", input.step, input.transactionHash)),
    ),
    releaseEscrow: vi.fn(async () => response(operation("prepared"))),
    fundEscrow: vi.fn(),
    disputeEscrow: vi.fn(),
    ...overrides,
  } as unknown as TasksClient;
}

function rpcHarness(
  receiptStatus: "success" | "reverted" = "success",
  calls: bigint[] = [],
  sendError?: Error | ((serialized: Hex) => Error),
  receiptExists = true,
  options: {
    clone?: Partial<{
      buyer: Address;
      seller: Address;
      token: Address;
      amount: bigint;
      termsHash: Hex;
      state: number;
      offerDeadline: bigint;
      registered: boolean;
    }>;
    transaction?: { to: Address; data: Hex; from?: Address };
  } = {},
) {
  const methods: string[] = [];
  const raw: Hex[] = [];
  const client = createPublicClient({
    transport: custom({
      async request({ method, params }) {
        methods.push(method);
        if (method === "eth_chainId") return "0x14a34";
        if (method === "eth_getTransactionCount") return "0x0";
        if (method === "eth_estimateGas") return "0x186a0";
        if (method === "eth_gasPrice") return "0x3b9aca00";
        if (method === "eth_maxPriorityFeePerGas") return "0x1";
        if (method === "eth_call") {
          const request = (params as [{ data: Hex }])[0];
          try {
            const decoded = decodeFunctionData({ abi: TASKS_READ_ABI, data: request.data });
            const results = {
              paymentToken: usdc,
              isEscrow: options.clone?.registered ?? true,
              name: "USDC",
              version: "2",
              buyer: options.clone?.buyer ?? account.address,
              seller: options.clone?.seller ?? buyer,
              token: options.clone?.token ?? usdc,
              amount: options.clone?.amount ?? 1_000_000n,
              termsHash: options.clone?.termsHash ?? termsHash,
              state: options.clone?.state ?? 3,
              offerDeadline: options.clone?.offerDeadline ?? 1_893_456_000n,
            } as const;
            const result = results[decoded.functionName as keyof typeof results];
            return encodeFunctionResult({
              abi: TASKS_READ_ABI,
              functionName: decoded.functionName,
              result,
            } as Parameters<typeof encodeFunctionResult>[0]);
          } catch {
            return encodeAbiParameters([{ type: "uint256" }], [calls.shift() ?? 0n]);
          }
        }
        if (method === "eth_getBlockByNumber")
          return {
            number: "0x10",
            hash: `0x${"88".repeat(32)}`,
            parentHash: `0x${"77".repeat(32)}`,
            nonce: "0x0000000000000000",
            sha3Uncles: `0x${"00".repeat(32)}`,
            logsBloom: `0x${"00".repeat(256)}`,
            transactionsRoot: `0x${"00".repeat(32)}`,
            stateRoot: `0x${"00".repeat(32)}`,
            receiptsRoot: `0x${"00".repeat(32)}`,
            miner: buyer,
            difficulty: "0x0",
            totalDifficulty: "0x0",
            extraData: "0x",
            size: "0x1",
            gasLimit: "0x1c9c380",
            gasUsed: "0x0",
            timestamp: "0x1",
            transactions: [],
            uncles: [],
            baseFeePerGas: "0x3b9aca00",
            mixHash: `0x${"00".repeat(32)}`,
          };
        if (method === "eth_sendRawTransaction") {
          const serialized = (params as [Hex])[0];
          raw.push(serialized);
          if (sendError) throw typeof sendError === "function" ? sendError(serialized) : sendError;
          return keccak256(serialized);
        }
        if (method === "eth_getTransactionReceipt") {
          if (!receiptExists) throw new Error("receipt not found");
          const hash = (params as [Hex])[0];
          const serialized = raw.find((candidate) => keccak256(candidate) === hash);
          const parsed = serialized ? parseTransaction(serialized) : options.transaction;
          return {
            transactionHash: hash,
            transactionIndex: "0x0",
            blockHash: `0x${"88".repeat(32)}`,
            blockNumber: "0x10",
            from: options.transaction?.from ?? account.address,
            to: parsed?.to ?? escrow,
            cumulativeGasUsed: "0x5208",
            gasUsed: "0x5208",
            effectiveGasPrice: "0x1",
            logs: [],
            logsBloom: `0x${"00".repeat(256)}`,
            status: receiptStatus === "success" ? "0x1" : "0x0",
            type: "0x2",
            contractAddress: null,
          };
        }
        if (method === "eth_getTransactionByHash") {
          const hash = (params as [Hex])[0];
          const serialized = raw.find((candidate) => keccak256(candidate) === hash);
          const parsed = serialized
            ? parseTransaction(serialized)
            : options.transaction
              ? {
                  chainId: 84532,
                  data: options.transaction.data,
                  nonce: 0,
                  to: options.transaction.to,
                  value: 0n,
                }
              : {
                  chainId: 84532,
                  data: encodeFunctionData({ abi: TASKS_CHAIN_ABI, functionName: "releaseFunds" }),
                  nonce: 0,
                  to: escrow,
                  value: 0n,
                };
          return {
            blockHash: `0x${"88".repeat(32)}`,
            blockNumber: "0x10",
            from: options.transaction?.from ?? account.address,
            gas: "0x186a0",
            gasPrice: "0x3b9aca00",
            hash,
            input: parsed.data ?? "0x",
            nonce: `0x${Number(parsed.nonce ?? 0).toString(16)}`,
            to: parsed.to,
            transactionIndex: "0x0",
            value: `0x${(parsed.value ?? 0n).toString(16)}`,
            type: "0x2",
            chainId: `0x${Number(parsed.chainId ?? 84532).toString(16)}`,
            v: "0x1",
            r: `0x${"01".repeat(32)}`,
            s: `0x${"02".repeat(32)}`,
          };
        }
        if (method === "eth_blockNumber") return "0x11";
        throw new Error(`Unexpected RPC ${method}`);
      },
    }),
  });
  return { client, methods, raw };
}

describe("createTasksChain", () => {
  it("recovers, signs, persists, broadcasts, records, waits for two confirmations, and reconciles", async () => {
    const api = fakeClient();
    const rpc = rpcHarness();
    const pending = memoryPending();
    const chain = createTasksChain({ client: api, account, rpcFor: () => rpc.client, pending });

    const result = await chain.release({ escrowId: milestoneId, orderId, idempotencyKey: key });

    expect(result.operation.state).toBe("confirmed");
    expect(api.listOrders).not.toHaveBeenCalled();
    expect(api.recoverOperation).toHaveBeenCalledOnce();
    expect(api.recordTransaction).toHaveBeenCalledOnce();
    expect(api.reconcileOperation).toHaveBeenCalledOnce();
    expect(rpc.raw).toHaveLength(1);
    expect(rpc.methods).toContain("eth_blockNumber");
  });

  it("does not broadcast when recovery finds the transaction", async () => {
    const hash = `0x${"99".repeat(32)}` as Hex;
    const api = fakeClient({
      recoverOperation: vi.fn(async () => ({
        ...response(operation("confirmed", "release-funds", hash)),
        recovered: true,
        scanComplete: true,
      })),
    });
    const rpc = rpcHarness();
    const chain = createTasksChain({
      client: api,
      account,
      rpcFor: () => rpc.client,
      pending: memoryPending(),
    });

    await expect(
      chain.release({ escrowId: milestoneId, orderId, idempotencyKey: key }),
    ).resolves.toMatchObject({ txHash: hash });
    expect(api.recordTransaction).not.toHaveBeenCalled();
    expect(rpc.raw).toHaveLength(0);
  });

  it("uses a durable reconciliation checkpoint when the server replays cached preparation", async () => {
    const api = fakeClient();
    const rpc = rpcHarness();
    const pending = memoryPending();
    const chain = createTasksChain({ client: api, account, rpcFor: () => rpc.client, pending });
    const input = { escrowId: milestoneId, orderId, idempotencyKey: key };

    const first = await chain.release(input);
    const replay = await chain.release(input);

    expect(replay.txHash).toBe(first.txHash);
    expect(api.recoverOperation).toHaveBeenCalledTimes(1);
    expect(api.recordTransaction).toHaveBeenCalledTimes(1);
    expect(api.reconcileOperation).toHaveBeenCalledTimes(1);
    expect(rpc.raw).toHaveLength(1);
  });

  it("refuses after 128 incomplete recovery pages", async () => {
    const api = fakeClient({
      recoverOperation: vi.fn(async () => ({
        ...response(operation("prepared")),
        recovered: false,
        scanComplete: false,
      })),
    });
    const chain = createTasksChain({
      client: api,
      account,
      rpcFor: () => rpcHarness().client,
      pending: memoryPending(),
    });
    await expect(
      chain.release({ escrowId: milestoneId, orderId, idempotencyKey: key }),
    ).rejects.toMatchObject({ broadcast: false });
    expect(api.recoverOperation).toHaveBeenCalledTimes(128);
    expect(api.recordTransaction).not.toHaveBeenCalled();
  });

  it("continues recovery pages until scanComplete becomes true", async () => {
    const recoverOperation = vi
      .fn()
      .mockResolvedValueOnce({
        ...response(operation("prepared")),
        recovered: false,
        scanComplete: false,
      })
      .mockResolvedValueOnce({
        ...response(operation("prepared")),
        recovered: false,
        scanComplete: true,
      });
    const api = fakeClient({ recoverOperation });
    const chain = createTasksChain({
      client: api,
      account,
      rpcFor: () => rpcHarness().client,
      pending: memoryPending(),
    });

    await chain.release({ escrowId: milestoneId, orderId, idempotencyKey: key });
    expect(recoverOperation).toHaveBeenCalledTimes(2);
    expect(recoverOperation.mock.calls[0]?.[2].idempotencyKey).not.toBe(
      recoverOperation.mock.calls[1]?.[2].idempotencyKey,
    );
  });

  it("rebroadcasts durable raw bytes without signing a second transaction", async () => {
    const data = encodeFunctionData({ abi: TASKS_CHAIN_ABI, functionName: "releaseFunds" });
    const raw = await account.signTransaction({
      chainId: 84532,
      type: "eip1559",
      to: escrow,
      data,
      value: 0n,
      nonce: 0,
      gas: 100_000n,
      maxFeePerGas: 2_000_000_000n,
      maxPriorityFeePerGas: 1n,
    });
    const pending = memoryPending();
    await pending.put(operationId, "release-funds", {
      chainId: 84532,
      txHash: keccak256(raw),
      raw,
      signer: account.address,
      nonce: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    const signTransaction = vi.fn(async () => {
      throw new Error("must not sign");
    });
    const replayAccount = { ...account, signTransaction } as LocalAccount;
    const rpc = rpcHarness();
    const chain = createTasksChain({
      client: fakeClient(),
      account: replayAccount,
      rpcFor: () => rpc.client,
      pending,
    });

    await chain.release({ escrowId: milestoneId, orderId, idempotencyKey: key });
    expect(signTransaction).not.toHaveBeenCalled();
    expect(rpc.raw).toEqual([raw]);
  });

  it("retains a signed pending transaction when broadcast fails ambiguously", async () => {
    const pending = memoryPending();
    let rejectedRaw: Hex | undefined;
    const authorizationSignature = `0x${"ab".repeat(65)}`;
    const rpc = rpcHarness("success", [], (raw) => {
      rejectedRaw = raw;
      return Object.assign(
        new Error(`RPC rejected signed bytes ${raw} authorization ${authorizationSignature}`, {
          cause: new Error(`Request body ${raw} ${authorizationSignature}`),
        }),
        { status: 503, details: `${raw} ${authorizationSignature}` },
      );
    });
    const chain = createTasksChain({
      client: fakeClient(),
      account,
      rpcFor: () => rpc.client,
      pending,
    });

    const error = await chain
      .release({ escrowId: milestoneId, orderId, idempotencyKey: key })
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ broadcast: true });
    expect(JSON.stringify(error)).not.toContain(rejectedRaw);
    expect(JSON.stringify(error)).not.toContain(authorizationSignature);
    expect((error as Error).message).not.toContain(rejectedRaw);
    expect((error as Error).message).not.toContain(authorizationSignature);
    expect((error as Error).message).toContain("503");
    expect((error as Error & { cause?: unknown }).cause).toBeUndefined();
    const saved = await pending.get(operationId, "release-funds");
    expect(saved?.raw).toMatch(/^0x/u);
    expect(saved?.txHash).toBe(saved ? keccak256(saved.raw) : undefined);
  });

  it.each(["already known", "nonce too low"])(
    "accepts %s only after finding the exact receipt",
    async (message) => {
      const api = fakeClient();
      const rpc = rpcHarness("success", [], new Error(message));
      const chain = createTasksChain({
        client: api,
        account,
        rpcFor: () => rpc.client,
        pending: memoryPending(),
      });

      await chain.release({ escrowId: milestoneId, orderId, idempotencyKey: key });
      expect(api.recordTransaction).toHaveBeenCalledOnce();
      expect(rpc.methods).toContain("eth_getTransactionReceipt");
    },
  );

  it("does not accept nonce-too-low when the exact receipt is unavailable", async () => {
    const api = fakeClient();
    const rpc = rpcHarness("success", [], new Error("nonce too low"), false);
    const chain = createTasksChain({
      client: api,
      account,
      rpcFor: () => rpc.client,
      pending: memoryPending(),
    });

    await expect(
      chain.release({ escrowId: milestoneId, orderId, idempotencyKey: key }),
    ).rejects.toMatchObject({ broadcast: true });
    expect(api.recordTransaction).not.toHaveBeenCalled();
  });

  it("uses a reconciliation checkpoint that appears while acquiring the step lock", async () => {
    const hash = `0x${"bd".repeat(32)}` as Hex;
    const checkpoint = response(operation("confirmed", "release-funds", hash));
    const base = memoryPending();
    let reads = 0;
    const pending: PendingTransactions = {
      ...base,
      reconciled: async () => (++reads === 1 ? undefined : checkpoint),
    };
    const signTransaction = vi.fn(async () => {
      throw new Error("must not sign");
    });
    const raceAccount = { ...account, signTransaction } as LocalAccount;
    const rpc = rpcHarness();
    const chain = createTasksChain({
      client: fakeClient(),
      account: raceAccount,
      rpcFor: () => rpc.client,
      pending,
    });

    await expect(
      chain.release({ escrowId: milestoneId, orderId, idempotencyKey: key }),
    ).resolves.toMatchObject({ txHash: hash });
    expect(reads).toBe(3);
    expect(signTransaction).not.toHaveBeenCalled();
    expect(rpc.raw).toHaveLength(0);
  });

  it("resumes submitted operations by waiting and reconciling only", async () => {
    const hash = `0x${"aa".repeat(32)}` as Hex;
    const submitted = operation("submitted", "release-funds", hash);
    const api = fakeClient({ releaseEscrow: vi.fn(async () => response(submitted)) });
    const rpc = rpcHarness();
    const chain = createTasksChain({
      client: api,
      account,
      rpcFor: () => rpc.client,
      pending: memoryPending(),
      confirmations: 2,
    });
    await chain.release({ escrowId: milestoneId, orderId, idempotencyKey: key });
    expect(api.recoverOperation).not.toHaveBeenCalled();
    expect(api.recordTransaction).not.toHaveBeenCalled();
    expect(api.reconcileOperation).toHaveBeenCalledOnce();
    expect(rpc.raw).toHaveLength(0);
  });

  it("prefers a fresh submitted milestone operation over a stale cached prepare", async () => {
    const hash = `0x${"af".repeat(32)}` as Hex;
    const live = operation("submitted", "release-funds", hash);
    const liveMilestone: TaskMilestone = { ...milestone, chainOperation: live };
    const liveOrder = { ...order, milestones: [liveMilestone] } as typeof order;
    const signTransaction = vi.fn(async () => {
      throw new Error("must not sign");
    });
    const resumeAccount = { ...account, signTransaction } as LocalAccount;
    const api = fakeClient({
      getOrder: vi.fn(async () => ({ workOrder: liveOrder })),
      releaseEscrow: vi.fn(async () => response(operation("prepared"))),
      reconcileOperation: vi.fn(async (_id, input) =>
        response(operation("confirmed", "release-funds", input.transactionHash)),
      ),
    });
    const rpc = rpcHarness();
    const chain = createTasksChain({
      client: api,
      account: resumeAccount,
      rpcFor: () => rpc.client,
      pending: memoryPending(),
    });

    await expect(
      chain.release({ escrowId: milestoneId, orderId, idempotencyKey: key }),
    ).resolves.toMatchObject({ txHash: hash });
    expect(api.recoverOperation).not.toHaveBeenCalled();
    expect(api.recordTransaction).not.toHaveBeenCalled();
    expect(api.reconcileOperation).toHaveBeenCalledOnce();
    expect(signTransaction).not.toHaveBeenCalled();
    expect(rpc.raw).toHaveLength(0);
  });

  it("finds a milestone through private order pages when orderId is absent", async () => {
    const api = fakeClient({
      listOrders: vi.fn(async () => ({ workOrders: [order], page: { nextCursor: null } })),
    });
    const chain = createTasksChain({
      client: api,
      account,
      rpcFor: () => rpcHarness().client,
      pending: memoryPending(),
    });

    await chain.release({ escrowId: milestoneId, idempotencyKey: key });
    expect(api.listOrders).toHaveBeenCalledWith({ scope: "private" });
    expect(api.getOrder).toHaveBeenCalledWith(orderId);
  });

  it("retries a leased reconcile with the server Retry-After value and stable key", async () => {
    const sleep = vi.fn(async () => undefined);
    const api = fakeClient();
    vi.mocked(api.reconcileOperation).mockRejectedValueOnce(
      new TasksClientError("http", "leased", 409, "conflict", "0.001"),
    );
    const chain = createTasksChain({
      client: api,
      account,
      rpcFor: () => rpcHarness().client,
      pending: memoryPending(),
      sleep,
    });
    await chain.release({ escrowId: milestoneId, orderId, idempotencyKey: key });
    expect(sleep).toHaveBeenCalledWith(1);
    const calls = vi.mocked(api.reconcileOperation).mock.calls;
    expect(calls[0]?.[2].idempotencyKey).toBe(calls[1]?.[2].idempotencyKey);
  });

  it("retries transaction recording with Retry-After and a stable key", async () => {
    const sleep = vi.fn(async () => undefined);
    const api = fakeClient();
    vi.mocked(api.recordTransaction).mockRejectedValueOnce(
      new TasksClientError("http", "leased", 409, "conflict", "0.001"),
    );
    const chain = createTasksChain({
      client: api,
      account,
      rpcFor: () => rpcHarness().client,
      pending: memoryPending(),
      sleep,
    });
    await chain.release({ escrowId: milestoneId, orderId, idempotencyKey: key });
    expect(sleep).toHaveBeenCalledWith(1);
    const calls = vi.mocked(api.recordTransaction).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0]?.[2].idempotencyKey).toBe(calls[1]?.[2].idempotencyKey);
  });

  it("does not retry a conflict without Retry-After or beyond the retry deadline", async () => {
    for (const retryAfter of [undefined, "31"] as const) {
      const sleep = vi.fn(async () => undefined);
      const api = fakeClient();
      vi.mocked(api.recordTransaction).mockRejectedValueOnce(
        new TasksClientError("http", "leased", 409, "conflict", retryAfter),
      );
      const chain = createTasksChain({
        client: api,
        account,
        rpcFor: () => rpcHarness().client,
        pending: memoryPending(),
        sleep,
        now: () => new Date("2026-01-01T00:00:00.000Z"),
      });
      await expect(
        chain.release({ escrowId: milestoneId, orderId, idempotencyKey: key }),
      ).rejects.toMatchObject({ broadcast: true });
      expect(api.recordTransaction).toHaveBeenCalledTimes(1);
      expect(sleep).not.toHaveBeenCalled();
    }
  });

  it("refuses a reconcile conflict without a usable Retry-After", async () => {
    const sleep = vi.fn(async () => undefined);
    const hash = `0x${"ae".repeat(32)}` as Hex;
    const api = fakeClient({
      releaseEscrow: vi.fn(async () => response(operation("submitted", "release-funds", hash))),
      reconcileOperation: vi.fn(async () => {
        throw new TasksClientError("http", "leased", 409, "conflict");
      }),
    });
    const chain = createTasksChain({
      client: api,
      account,
      rpcFor: () => rpcHarness().client,
      pending: memoryPending(),
      sleep,
    });
    await expect(
      chain.release({ escrowId: milestoneId, orderId, idempotencyKey: key }),
    ).rejects.toMatchObject({ broadcast: true });
    expect(api.reconcileOperation).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });

  it("marks a reverted receipt as post-broadcast", async () => {
    const api = fakeClient();
    const rpc = rpcHarness("reverted");
    const chain = createTasksChain({
      client: api,
      account,
      rpcFor: () => rpc.client,
      pending: memoryPending(),
    });
    await expect(
      chain.release({ escrowId: milestoneId, orderId, idempotencyKey: key }),
    ).rejects.toMatchObject({ broadcast: true });
    expect(api.reconcileOperation).not.toHaveBeenCalled();
  });

  it("signs scope messages locally", async () => {
    const chain = createTasksChain({
      client: fakeClient(),
      account,
      rpcFor: () => rpcHarness().client,
      pending: memoryPending(),
    });
    const signature = await chain.signScopeMessage("scope payload");
    expect(signature).toMatch(/^0x[0-9a-f]+$/u);
  });

  it("rejects a funding amount mismatch before exposing an authorization", async () => {
    const api = fakeClient({ getOrder: vi.fn(async () => ({ workOrder: buyerOrder })) });
    const chain = createTasksChain({
      client: api,
      account,
      rpcFor: () => rpcHarness().client,
      pending: memoryPending(),
    });
    await expect(
      chain.fund({ escrowId: milestoneId, orderId, grossBaseUnits: 2n, idempotencyKey: key }),
    ).rejects.toMatchObject({ broadcast: false, authorizationExposed: false });
    expect(api.fundEscrow).not.toHaveBeenCalled();
  });

  it("refuses provider funding before signing or sending an authorization", async () => {
    const authDeployment = {
      ...deployment,
      capabilities: { erc3009Funding: true, vapiVerify: false },
      eip3009Domain: {
        name: "USDC",
        version: "2",
        chainId: 84532,
        verifyingContract: usdc,
      },
    } satisfies Extract<DeploymentResponse, { configured: true }>;
    const signTypedData = vi.fn(account.signTypedData.bind(account));
    const providerAccount = { ...account, signTypedData } as LocalAccount;
    const api = fakeClient({ deployment: vi.fn(async () => authDeployment) });
    const chain = createTasksChain({
      client: api,
      account: providerAccount,
      rpcFor: () => rpcHarness().client,
      pending: memoryPending(),
    });

    await expect(
      chain.fund({
        escrowId: milestoneId,
        orderId,
        grossBaseUnits: 1_000_000n,
        idempotencyKey: key,
      }),
    ).rejects.toMatchObject({ broadcast: false, authorizationExposed: false });
    expect(signTypedData).not.toHaveBeenCalled();
    expect(api.fundEscrow).not.toHaveBeenCalled();
  });

  it("reuses one durable funding preparation and authorization across process-style retries", async () => {
    const authDeployment = {
      ...deployment,
      capabilities: { erc3009Funding: true, vapiVerify: false },
      eip3009Domain: {
        name: "USDC",
        version: "2",
        chainId: 84532,
        verifyingContract: usdc,
      },
    } satisfies Extract<DeploymentResponse, { configured: true }>;
    const signTypedData = vi.fn(account.signTypedData.bind(account));
    const signingAccount = { ...account, signTypedData } as LocalAccount;
    const api = fakeClient({
      deployment: vi.fn(async () => authDeployment),
      getOrder: vi.fn(async () => ({ workOrder: buyerOrder })),
      fundEscrow: vi.fn(async () => {
        throw new TasksClientError("http", "prepare failed", 503);
      }),
    });
    const pending = memoryPending();
    const chain = createTasksChain({
      client: api,
      account: signingAccount,
      rpcFor: () => rpcHarness("success", [], undefined, true, { clone: { state: 1 } }).client,
      pending,
      now: () => new Date("2026-01-01T00:00:00.000Z"),
      randomBytes: () => Uint8Array.from({ length: 32 }, (_, index) => index),
    });
    const input = {
      escrowId: milestoneId,
      orderId,
      grossBaseUnits: 1_000_000n,
      idempotencyKey: key,
    };

    await expect(chain.fund(input)).rejects.toMatchObject({
      broadcast: false,
      authorizationExposed: true,
    });
    const retryChain = createTasksChain({
      client: api,
      account: signingAccount,
      rpcFor: () => rpcHarness("success", [], undefined, true, { clone: { state: 1 } }).client,
      pending,
      now: () => new Date("2040-01-01T00:00:00.000Z"),
      randomBytes: () => new Uint8Array(32).fill(255),
    });
    await expect(retryChain.fund(input)).rejects.toMatchObject({ authorizationExposed: true });

    expect(signTypedData).toHaveBeenCalledTimes(1);
    const calls = vi.mocked(api.fundEscrow).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[1]?.[1]).toEqual(calls[0]?.[1]);
    await expect(pending.preparation(milestoneId, "fund")).resolves.toEqual({
      idempotencyKey: key,
      inputs: { grossBaseUnits: "1000000" },
    });
  });

  it("reports persisted exposure when a funding retry fails before order validation", async () => {
    const pending = memoryPending();
    await pending.markExposure(milestoneId);
    const api = fakeClient({
      getOrder: vi.fn(async () => {
        throw new TasksClientError("http", "order unavailable", 503);
      }),
    });
    const chain = createTasksChain({
      client: api,
      account,
      rpcFor: () => rpcHarness().client,
      pending,
    });
    await expect(
      chain.fund({
        escrowId: milestoneId,
        orderId,
        idempotencyKey: key,
        grossBaseUnits: 1_000_000n,
      }),
    ).rejects.toMatchObject({ authorizationExposed: true });
    expect(api.fundEscrow).not.toHaveBeenCalled();
  });

  it("reports exposure when persisting the pre-request marker fails after its write", async () => {
    const base = memoryPending();
    const pending: PendingTransactions = {
      ...base,
      markExposure: async (id) => {
        await base.markExposure(id);
        throw new Error("Directory fsync failed");
      },
    };
    const api = fakeClient({ getOrder: vi.fn(async () => ({ workOrder: buyerOrder })) });
    const chain = createTasksChain({
      client: api,
      account,
      rpcFor: () => rpcHarness("success", [], undefined, true, { clone: { state: 1 } }).client,
      pending,
    });
    await expect(
      chain.fund({
        escrowId: milestoneId,
        orderId,
        idempotencyKey: key,
        grossBaseUnits: 1_000_000n,
      }),
    ).rejects.toMatchObject({ authorizationExposed: true });
    expect(api.fundEscrow).not.toHaveBeenCalled();
  });

  it("signs and submits EIP-3009 funding with the exact durable authorization body", async () => {
    const authDeployment = {
      ...deployment,
      capabilities: { erc3009Funding: true, vapiVerify: false },
      eip3009Domain: {
        name: "USDC",
        version: "2",
        chainId: 84532,
        verifyingContract: usdc,
      },
    } satisfies Extract<DeploymentResponse, { configured: true }>;
    let fundingData: Hex = "0x";
    const api = fakeClient({
      deployment: vi.fn(async () => authDeployment),
      getOrder: vi.fn(async () => ({ workOrder: buyerOrder })),
      fundEscrow: vi.fn(async (_id, body) => {
        const authorization = body.authorization;
        fundingData = encodeFunctionData({
          abi: TASKS_CHAIN_ABI,
          functionName: "fundWithAuthorization",
          args: [
            BigInt(authorization.validAfter),
            BigInt(authorization.validBefore),
            authorization.nonce,
            authorization.signature,
          ],
        });
        return anyResponse(
          operationFor({
            step: "fund-with-authorization",
            data: fundingData,
            kind: "escrow-funding",
          }),
        );
      }),
      reconcileOperation: vi.fn(async (_id, input) =>
        anyResponse(
          operationFor({
            step: "fund-with-authorization",
            data: fundingData,
            kind: "escrow-funding",
            state: "confirmed",
            txHash: input.transactionHash,
          }),
        ),
      ),
    });
    const chain = createTasksChain({
      client: api,
      account,
      rpcFor: () =>
        rpcHarness("success", [], undefined, true, {
          clone: { state: 1 },
          transaction: { to: escrow, data: fundingData },
        }).client,
      pending: memoryPending(),
      now: () => new Date("2026-01-01T00:00:00.000Z"),
      randomBytes: () => new Uint8Array(32).fill(7),
    });

    await expect(
      chain.fund({
        escrowId: milestoneId,
        orderId,
        grossBaseUnits: 1_000_000n,
        idempotencyKey: key,
      }),
    ).resolves.toMatchObject({
      operation: { step: "fund-with-authorization", state: "confirmed" },
    });
    expect(api.fundEscrow).toHaveBeenCalledWith(
      milestoneId,
      {
        authorization: expect.objectContaining({
          validAfter: "0",
          nonce: `0x${"07".repeat(32)}`,
        }),
      },
      { idempotencyKey: key },
    );
  });

  it("uses the verified clone offer deadline for EIP-3009 funding", async () => {
    const authDeployment = {
      ...deployment,
      capabilities: { erc3009Funding: true, vapiVerify: false },
      eip3009Domain: {
        name: "USDC",
        version: "2",
        chainId: 84532,
        verifyingContract: usdc,
      },
    } satisfies Extract<DeploymentResponse, { configured: true }>;
    const noDeadline = { ...milestone, offerDeadlineAt: null };
    const noDeadlineOrder = { ...buyerOrder, milestones: [noDeadline] } as typeof buyerOrder;
    const api = fakeClient({
      deployment: vi.fn(async () => authDeployment),
      getOrder: vi.fn(async () => ({ workOrder: noDeadlineOrder })),
      chainState: vi.fn(async () => ({
        workOrderId: orderId,
        milestones: [
          {
            milestoneId,
            network: deployment.network,
            escrowAddress: escrow,
            explorerUrl: null,
            read: {
              status: "confirmed",
              state: "locked",
              resolution: null,
              offerDeadlineAt: "2030-01-01T00:00:00.000Z",
              workDeadlineAt: null,
              reviewDeadlineAt: null,
            },
          },
        ],
        observedAt: "2026-01-01T00:00:00.000Z",
      })),
      fundEscrow: vi.fn(async () => {
        throw new TasksClientError("http", "stop after preparation", 503);
      }),
    });
    const chain = createTasksChain({
      client: api,
      account,
      rpcFor: () => rpcHarness("success", [], undefined, true, { clone: { state: 1 } }).client,
      pending: memoryPending(),
      now: () => new Date("2026-01-01T00:00:00.000Z"),
      randomBytes: () => new Uint8Array(32).fill(9),
    });

    await expect(
      chain.fund({
        escrowId: milestoneId,
        orderId,
        grossBaseUnits: 1_000_000n,
        idempotencyKey: key,
      }),
    ).rejects.toMatchObject({ authorizationExposed: true });
    expect(api.chainState).not.toHaveBeenCalled();
    expect(api.fundEscrow).toHaveBeenCalledOnce();
  });

  it("funds through approve then deposit with distinct stable operation keys", async () => {
    const approveData = encodeFunctionData({
      abi: TASKS_CHAIN_ABI,
      functionName: "approve",
      args: [escrow, 1_000_000n],
    });
    const depositData = encodeFunctionData({ abi: TASKS_CHAIN_ABI, functionName: "depositFunds" });
    const approve = operationFor({
      step: "approve-usdc",
      data: approveData,
      to: usdc,
      kind: "escrow-funding",
    });
    const deposit = operationFor({
      step: "deposit-funds",
      data: depositData,
      kind: "escrow-funding",
      state: "prepared",
    });
    const api = fakeClient({
      getOrder: vi.fn(async () => ({ workOrder: buyerOrder })),
      fundEscrow: vi.fn(async () => anyResponse(approve)),
      recoverOperation: vi.fn(async () => ({
        ...anyResponse(deposit),
        recovered: false,
        scanComplete: true,
      })),
      recordTransaction: vi.fn(async (_id, input) =>
        anyResponse(
          operationFor({
            step: "deposit-funds",
            data: depositData,
            kind: "escrow-funding",
            state: "submitted",
            txHash: input.transactionHash,
          }),
        ),
      ),
      reconcileOperation: vi.fn(async (_id, input) =>
        input.step === "approve-usdc"
          ? anyResponse(deposit)
          : anyResponse(
              operationFor({
                step: "deposit-funds",
                data: depositData,
                kind: "escrow-funding",
                state: "confirmed",
                txHash: input.transactionHash,
              }),
            ),
      ),
    });
    const rpc = rpcHarness("success", [], undefined, true, {
      clone: { state: 1 },
      transaction: { to: usdc, data: approveData },
    });
    const chain = createTasksChain({
      client: api,
      account,
      rpcFor: () => rpc.client,
      pending: memoryPending(),
    });

    await expect(
      chain.fund({
        escrowId: milestoneId,
        orderId,
        grossBaseUnits: 1_000_000n,
        idempotencyKey: key,
      }),
    ).resolves.toMatchObject({ operation: { step: "deposit-funds", state: "confirmed" } });
    const reconcileCalls = vi.mocked(api.reconcileOperation).mock.calls;
    expect(reconcileCalls.map((call) => call[1].step)).toEqual(["approve-usdc", "deposit-funds"]);
    expect(reconcileCalls[0]?.[2].idempotencyKey).not.toBe(reconcileCalls[1]?.[2].idempotencyKey);
    expect(api.recordTransaction).toHaveBeenCalledOnce();
  });

  it("refuses a dispute before preparation when the fee allowance is too small", async () => {
    const api = fakeClient();
    const rpc = rpcHarness("success", [25_000n, 24_999n]);
    const chain = createTasksChain({
      client: api,
      account,
      rpcFor: () => rpc.client,
      pending: memoryPending(),
    });
    await expect(
      chain.dispute({
        escrowId: milestoneId,
        orderId,
        evidenceHash: `0x${"ab".repeat(32)}`,
        idempotencyKey: key,
      }),
    ).rejects.toMatchObject({ broadcast: false, authorizationExposed: false });
    expect(api.disputeEscrow).not.toHaveBeenCalled();
    expect(rpc.methods.filter((method) => method === "eth_call")).toHaveLength(13);
  });

  it("creates an escrow from the first uncreated milestone", async () => {
    const uncreated = { ...milestone, escrowState: null, escrowContract: factory };
    const createOrder = { ...order, milestones: [uncreated] } as typeof order;
    const data = encodeFunctionData({
      abi: TASKS_CHAIN_ABI,
      functionName: "createEscrow",
      args: [buyer, usdc, 1_000_000n, 3_600n, 600n, termsHash, keccak256(stringToHex(milestoneId))],
    });
    const submitted = operationFor({
      step: "create-escrow",
      data,
      to: factory,
      kind: "escrow-create",
    });
    const api = fakeClient({
      getOrder: vi.fn(async () => ({ workOrder: createOrder })),
      createEscrow: vi.fn(async () => anyResponse(submitted, uncreated)),
      reconcileOperation: vi.fn(async (_id, input) =>
        anyResponse(
          operationFor({
            step: "create-escrow",
            data,
            to: factory,
            kind: "escrow-create",
            state: "confirmed",
            txHash: input.transactionHash,
          }),
          uncreated,
        ),
      ),
    });
    const rpc = rpcHarness("success", [], undefined, true, {
      transaction: { to: factory, data },
    });
    const chain = createTasksChain({
      client: api,
      account,
      rpcFor: () => rpc.client,
      pending: memoryPending(),
    });

    await expect(chain.createEscrow({ orderId, idempotencyKey: key })).resolves.toMatchObject({
      operation: { state: "confirmed", step: "create-escrow" },
    });
    expect(api.createEscrow).toHaveBeenCalledWith(orderId, { idempotencyKey: key });
  });

  it("keeps escrow creation preparations separate for later milestones in the same order", async () => {
    const secondMilestoneId = "10000000-0000-4000-8000-000000000016";
    const secondOperationId = "10000000-0000-4000-8000-000000000017";
    const secondKey = "10000000-0000-4000-8000-000000000018";
    const selected = [
      { ...milestone, escrowState: null, escrowContract: factory },
      {
        ...milestone,
        id: secondMilestoneId,
        ordinal: 2,
        escrowState: null,
        escrowContract: factory,
      },
    ] as TaskMilestone[];
    const ids = [operationId, secondOperationId];
    const data = selected.map((item) =>
      encodeFunctionData({
        abi: TASKS_CHAIN_ABI,
        functionName: "createEscrow",
        args: [buyer, usdc, 1_000_000n, 3_600n, 600n, termsHash, keccak256(stringToHex(item.id))],
      }),
    );
    const creation = (index: number, state: "submitted" | "confirmed", txHash?: Hex) =>
      operationFor({
        id: ids[index]!,
        step: "create-escrow",
        kind: "escrow-create",
        state,
        to: factory,
        data: data[index]!,
        txHash: txHash ?? (`0x${(index === 0 ? "a1" : "a2").repeat(32)}` as Hex),
      });
    let prepares = 0;
    const api = fakeClient({
      getOrder: vi.fn(async () => ({ workOrder: { ...order, milestones: selected } })),
      getScopes: vi.fn(async () => ({
        scopes: [await acceptedScope(), await acceptedScope(secondMilestoneId, 2)],
      })),
      createEscrow: vi.fn(async () => {
        const index = prepares++;
        return anyResponse(creation(index, "submitted"), selected[index]!);
      }),
      reconcileOperation: vi.fn(async (id, input) => {
        const index = ids.indexOf(id);
        return anyResponse(creation(index, "confirmed", input.transactionHash), selected[index]!);
      }),
    });
    const pending = memoryPending();
    const chain = createTasksChain({
      client: api,
      account,
      pending,
      rpcFor: () =>
        rpcHarness("success", [], undefined, true, {
          transaction: { to: factory, data: data[Math.max(0, prepares - 1)]! },
        }).client,
    });
    await chain.createEscrow({ orderId, idempotencyKey: key });
    await chain.createEscrow({ orderId, idempotencyKey: secondKey });
    expect(vi.mocked(api.createEscrow).mock.calls.map((call) => call[1].idempotencyKey)).toEqual([
      key,
      secondKey,
    ]);
    expect((await pending.preparation(milestoneId, "createEscrow"))?.idempotencyKey).toBe(key);
    expect((await pending.preparation(secondMilestoneId, "createEscrow"))?.idempotencyKey).toBe(
      secondKey,
    );
  });

  it("resumes cached escrow creation after the clone already exists", async () => {
    const data = encodeFunctionData({
      abi: TASKS_CHAIN_ABI,
      functionName: "createEscrow",
      args: [buyer, usdc, 1_000_000n, 3_600n, 600n, termsHash, keccak256(stringToHex(milestoneId))],
    });
    const hash = `0x${"b0".repeat(32)}` as Hex;
    const cached = operationFor({
      step: "create-escrow",
      data,
      to: factory,
      kind: "escrow-create",
      state: "prepared",
    });
    const live = operationFor({
      step: "create-escrow",
      data,
      to: factory,
      kind: "escrow-create",
      state: "submitted",
      txHash: hash,
    });
    const createdMilestone: TaskMilestone = {
      ...milestone,
      escrowState: "created",
      escrowContract: escrow,
      chainOperation: live,
    };
    const createdOrder = { ...order, milestones: [createdMilestone] } as typeof order;
    const signTransaction = vi.fn(async () => {
      throw new Error("must not sign");
    });
    const resumeAccount = { ...account, signTransaction } as LocalAccount;
    const api = fakeClient({
      getOrder: vi.fn(async () => ({ workOrder: createdOrder })),
      createEscrow: vi.fn(async () => anyResponse(cached, createdMilestone)),
      reconcileOperation: vi.fn(async (_id, input) =>
        anyResponse(
          operationFor({
            step: "create-escrow",
            data,
            to: factory,
            kind: "escrow-create",
            state: "confirmed",
            txHash: input.transactionHash,
          }),
          createdMilestone,
        ),
      ),
    });
    const rpc = rpcHarness("success", [], undefined, true, {
      transaction: { to: factory, data },
    });
    const chain = createTasksChain({
      client: api,
      account: resumeAccount,
      rpcFor: () => rpc.client,
      pending: memoryPending(),
    });

    await expect(chain.createEscrow({ orderId, idempotencyKey: key })).resolves.toMatchObject({
      txHash: hash,
      operation: { state: "confirmed", step: "create-escrow" },
    });
    expect(api.recoverOperation).not.toHaveBeenCalled();
    expect(api.recordTransaction).not.toHaveBeenCalled();
    expect(api.reconcileOperation).toHaveBeenCalledOnce();
    expect(signTransaction).not.toHaveBeenCalled();
    expect(rpc.raw).toHaveLength(0);
  });

  it("delivers a locally frozen manifest and rejects a mismatched server hash", async () => {
    const note = "Delivered from the test adapter.";
    const manifest = await prepareDeliveryManifest(
      [
        {
          fileId: "10000000-0000-4000-8000-000000000006",
          fileName: "result.txt",
          sha256: "12".repeat(32),
          sizeBytes: 12,
        },
      ],
      note,
    );
    const data = encodeFunctionData({
      abi: TASKS_CHAIN_ABI,
      functionName: "submitDelivery",
      args: [manifest.manifestHash],
    });
    const submitted = operationFor({ step: "submit-delivery", data, kind: "escrow-delivery" });
    const delivery = {
      id: "10000000-0000-4000-8000-000000000009",
      milestoneId,
      version: 1,
      manifest: manifest.manifest,
      manifestHash: manifest.manifestHash,
      submittedByProfileId: "10000000-0000-4000-8000-000000000010",
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    const api = fakeClient({
      deliverEscrow: vi.fn(async () => ({ ...anyResponse(submitted), delivery })),
      reconcileOperation: vi.fn(async (_id, input) =>
        anyResponse(
          operationFor({
            step: "submit-delivery",
            data,
            kind: "escrow-delivery",
            state: "confirmed",
            txHash: input.transactionHash,
          }),
        ),
      ),
    });
    const chain = createTasksChain({
      client: api,
      account,
      rpcFor: () =>
        rpcHarness("success", [], undefined, true, {
          clone: { buyer, seller: account.address, state: 2 },
          transaction: { to: escrow, data },
        }).client,
      pending: memoryPending(),
    });

    await chain.deliver({ escrowId: milestoneId, orderId, idempotencyKey: key, manifest, note });
    expect(api.deliverEscrow).toHaveBeenCalledWith(
      milestoneId,
      { fileIds: ["10000000-0000-4000-8000-000000000006"], note },
      { idempotencyKey: key },
    );

    vi.mocked(api.deliverEscrow).mockResolvedValueOnce({
      ...anyResponse(submitted),
      delivery: { ...delivery, manifestHash: `0x${"ff".repeat(32)}` },
    });
    await expect(
      chain.deliver({
        escrowId: milestoneId,
        orderId,
        idempotencyKey: "10000000-0000-4000-8000-000000000007",
        manifest,
        note,
      }),
    ).rejects.toMatchObject({ broadcast: false });
  });

  it("rejects a locally altered delivery manifest before calling the server", async () => {
    const note = "Untampered note";
    const manifest = await prepareDeliveryManifest(
      [
        {
          fileId: "10000000-0000-4000-8000-000000000008",
          fileName: "result.txt",
          sha256: "34".repeat(32),
          sizeBytes: 8,
        },
      ],
      note,
    );
    const api = fakeClient({ deliverEscrow: vi.fn() });
    const chain = createTasksChain({
      client: api,
      account,
      rpcFor: () =>
        rpcHarness("success", [], undefined, true, {
          clone: { buyer, seller: account.address, state: 2 },
        }).client,
      pending: memoryPending(),
    });

    await expect(
      chain.deliver({
        escrowId: milestoneId,
        orderId,
        idempotencyKey: key,
        manifest: { ...manifest, manifestHash: `0x${"fe".repeat(32)}` },
        note,
      }),
    ).rejects.toMatchObject({ broadcast: false });
    expect(api.deliverEscrow).not.toHaveBeenCalled();
  });

  it("refunds with the prepared refundBuyer calldata", async () => {
    const data = encodeFunctionData({ abi: TASKS_CHAIN_ABI, functionName: "refundBuyer" });
    const submitted = operationFor({ step: "refund-buyer", data });
    const api = fakeClient({
      refundEscrow: vi.fn(async () => anyResponse(submitted)),
      reconcileOperation: vi.fn(async (_id, input) =>
        anyResponse(
          operationFor({
            step: "refund-buyer",
            data,
            state: "confirmed",
            txHash: input.transactionHash,
          }),
        ),
      ),
    });
    const chain = createTasksChain({
      client: api,
      account,
      rpcFor: () =>
        rpcHarness("success", [], undefined, true, {
          clone: { buyer, seller: account.address, state: 2 },
          transaction: { to: escrow, data },
        }).client,
      pending: memoryPending(),
    });
    await expect(
      chain.refund({ escrowId: milestoneId, orderId, idempotencyKey: key }),
    ).resolves.toMatchObject({ operation: { step: "refund-buyer", state: "confirmed" } });
  });

  it("raises a dispute after fee allowance preflight", async () => {
    const evidenceHash = `0x${"ab".repeat(32)}` as Hex;
    const data = encodeFunctionData({
      abi: TASKS_CHAIN_ABI,
      functionName: "raiseDispute",
      args: [evidenceHash],
    });
    const submitted = operationFor({ step: "raise-dispute", data, kind: "escrow-dispute" });
    const api = fakeClient({
      disputeEscrow: vi.fn(async () => anyResponse(submitted)),
      reconcileOperation: vi.fn(async (_id, input) =>
        anyResponse(
          operationFor({
            step: "raise-dispute",
            data,
            kind: "escrow-dispute",
            state: "confirmed",
            txHash: input.transactionHash,
          }),
        ),
      ),
    });
    const rpc = rpcHarness("success", [25_000n, 25_000n], undefined, true, {
      transaction: { to: escrow, data },
    });
    const chain = createTasksChain({
      client: api,
      account,
      rpcFor: () => rpc.client,
      pending: memoryPending(),
    });
    await chain.dispute({ escrowId: milestoneId, orderId, evidenceHash, idempotencyKey: key });
    expect(api.disputeEscrow).toHaveBeenCalledWith(
      milestoneId,
      { evidenceHash },
      { idempotencyKey: key },
    );
  });

  it("rejects an invalid server plan without broadcasting", async () => {
    const bad = operation("prepared");
    bad.plan!.to = factory;
    const api = fakeClient({
      releaseEscrow: vi.fn(async () => response(bad)),
      recoverOperation: vi.fn(async () => ({
        ...response(bad),
        recovered: false,
        scanComplete: true,
      })),
    });
    const rpc = rpcHarness();
    const chain = createTasksChain({
      client: api,
      account,
      rpcFor: () => rpc.client,
      pending: memoryPending(),
    });
    await expect(
      chain.release({ escrowId: milestoneId, orderId, idempotencyKey: key }),
    ).rejects.toBeInstanceOf(TasksChainError);
    expect(rpc.raw).toHaveLength(0);
  });

  it.each([
    ["unregistered clone", { registered: false }],
    ["wrong token", { token: factory }],
    ["wrong amount", { amount: 999_999n }],
    ["wrong terms hash", { termsHash: `0x${"ef".repeat(32)}` as Hex }],
    ["wrong parties", { seller: factory }],
  ])("rejects a %s before asking the server to prepare", async (_name, clone) => {
    const api = fakeClient();
    const rpc = rpcHarness("success", [], undefined, true, { clone });
    const chain = createTasksChain({
      client: api,
      account,
      rpcFor: () => rpc.client,
      pending: memoryPending(),
    });

    await expect(
      chain.release({ escrowId: milestoneId, orderId, idempotencyKey: key }),
    ).rejects.toMatchObject({ broadcast: false, authorizationExposed: false });
    expect(api.releaseEscrow).not.toHaveBeenCalled();
    expect(rpc.raw).toHaveLength(0);
  });

  it("rejects an invalid accepted-scope signature before preparing a transaction", async () => {
    const scope = await acceptedScope();
    const api = fakeClient({
      getScopes: vi.fn(async () => ({
        scopes: [{ ...scope, counterpartySignature: scope.proposerSignature }],
      })),
    });
    const rpc = rpcHarness();
    const chain = createTasksChain({
      client: api,
      account,
      rpcFor: () => rpc.client,
      pending: memoryPending(),
    });

    await expect(
      chain.release({ escrowId: milestoneId, orderId, idempotencyKey: key }),
    ).rejects.toMatchObject({ broadcast: false, authorizationExposed: false });
    expect(api.releaseEscrow).not.toHaveBeenCalled();
    expect(rpc.raw).toHaveLength(0);
  });

  it("refuses an unpinned chain before resolving RPC or signing", async () => {
    const api = fakeClient({
      deployment: vi.fn(async () => ({ ...deployment, chainId: 8453, network: "eip155:8453" })),
    });
    const rpcFor = vi.fn(() => {
      throw new Error("RPC must not resolve");
    });
    const signTransaction = vi.fn(account.signTransaction.bind(account));
    const chain = createRawTasksChain({
      client: api,
      account: { ...account, signTransaction },
      rpcFor,
      pending: memoryPending(),
    });
    await expect(
      chain.release({ escrowId: milestoneId, orderId, idempotencyKey: key }),
    ).rejects.toMatchObject({
      message:
        "No trusted Tasks escrow factory is configured for chain 8453. Set VAPI_TASKS_ESCROW_FACTORY_8453.",
      broadcast: false,
      authorizationExposed: false,
    });
    expect(rpcFor).not.toHaveBeenCalled();
    expect(signTransaction).not.toHaveBeenCalled();
  });

  it.each([
    ["payment token", { ...deployment, usdc: escrow }],
    [
      "token domain",
      {
        ...deployment,
        eip3009Domain: {
          name: "Attacker Token",
          version: "2",
          chainId: 84532,
          verifyingContract: usdc,
        },
      },
    ],
  ])("rejects a server %s that differs from the trusted onchain value", async (_label, ready) => {
    const api = fakeClient({ deployment: vi.fn(async () => ready) });
    const signTransaction = vi.fn(account.signTransaction.bind(account));
    const chain = createTasksChain({
      client: api,
      account: { ...account, signTransaction },
      rpcFor: () => rpcHarness().client,
      pending: memoryPending(),
    });
    await expect(
      chain.release({ escrowId: milestoneId, orderId, idempotencyKey: key }),
    ).rejects.toMatchObject({ broadcast: false });
    expect(signTransaction).not.toHaveBeenCalled();
    expect(api.releaseEscrow).not.toHaveBeenCalled();
  });

  it("recomputes the accepted scope hash before signing a money transaction", async () => {
    const scope = await acceptedScope();
    const api = fakeClient({
      getScopes: vi.fn(async () => ({ scopes: [{ ...scope, brief: scope.brief + " altered" }] })),
    });
    const signTransaction = vi.fn(account.signTransaction.bind(account));
    const chain = createTasksChain({
      client: api,
      account: { ...account, signTransaction },
      rpcFor: () => rpcHarness().client,
      pending: memoryPending(),
    });
    await expect(
      chain.release({ escrowId: milestoneId, orderId, idempotencyKey: key }),
    ).rejects.toMatchObject({ broadcast: false });
    expect(signTransaction).not.toHaveBeenCalled();
    expect(api.releaseEscrow).not.toHaveBeenCalled();
  });

  it("checks onchain state immediately before a new escrow transaction signature", async () => {
    const api = fakeClient();
    const signTransaction = vi.fn(account.signTransaction.bind(account));
    const chain = createTasksChain({
      client: api,
      account: { ...account, signTransaction },
      rpcFor: () => rpcHarness("success", [], undefined, true, { clone: { state: 2 } }).client,
      pending: memoryPending(),
    });
    await expect(
      chain.release({ escrowId: milestoneId, orderId, idempotencyKey: key }),
    ).rejects.toMatchObject({ broadcast: false });
    expect(signTransaction).not.toHaveBeenCalled();
  });

  it("rejects a server readiness factory that differs from the local trust pin", async () => {
    const api = fakeClient({
      deployment: vi.fn(async () => ({ ...deployment, escrowContract: escrow })),
    });
    const rpc = rpcHarness();
    const chain = createTasksChain({
      client: api,
      account,
      rpcFor: () => rpc.client,
      pending: memoryPending(),
    });

    await expect(
      chain.release({ escrowId: milestoneId, orderId, idempotencyKey: key }),
    ).rejects.toMatchObject({ broadcast: false, authorizationExposed: false });
    expect(api.getScopes).not.toHaveBeenCalled();
    expect(rpc.raw).toHaveLength(0);
  });

  it("rejects a submitted recovery whose RPC envelope targets another contract", async () => {
    const hash = `0x${"91".repeat(32)}` as Hex;
    const api = fakeClient({
      releaseEscrow: vi.fn(async () => response(operation("submitted", "release-funds", hash))),
    });
    const rpc = rpcHarness("success", [], undefined, true, {
      transaction: {
        to: factory,
        data: encodeFunctionData({ abi: TASKS_CHAIN_ABI, functionName: "releaseFunds" }),
      },
    });
    const chain = createTasksChain({
      client: api,
      account,
      rpcFor: () => rpc.client,
      pending: memoryPending(),
    });

    await expect(
      chain.release({ escrowId: milestoneId, orderId, idempotencyKey: key }),
    ).rejects.toMatchObject({ broadcast: true });
    expect(api.reconcileOperation).not.toHaveBeenCalled();
    expect(rpc.raw).toHaveLength(0);
  });

  it("reuses a persisted release preparation key when a retry supplies a different key", async () => {
    const releaseEscrow = vi.fn(async () => {
      throw new TasksClientError("http", "prepare unavailable", 503);
    });
    const api = fakeClient({ releaseEscrow });
    const pending = memoryPending();
    const chain = createTasksChain({
      client: api,
      account,
      rpcFor: () => rpcHarness().client,
      pending,
    });
    const secondKey = "10000000-0000-4000-8000-000000000012";

    await expect(
      chain.release({ escrowId: milestoneId, orderId, idempotencyKey: key }),
    ).rejects.toMatchObject({ broadcast: false });
    await expect(
      chain.release({ escrowId: milestoneId, orderId, idempotencyKey: secondKey }),
    ).rejects.toMatchObject({ broadcast: false });

    expect(vi.mocked(api.releaseEscrow).mock.calls.map((call) => call[1].idempotencyKey)).toEqual([
      key,
      key,
    ]);
    await expect(pending.preparation(milestoneId, "release")).resolves.toEqual({
      idempotencyKey: key,
      inputs: {},
    });
  });

  it("retains saved raw bytes when a fabricated confirmation has no RPC receipt", async () => {
    const data = encodeFunctionData({ abi: TASKS_CHAIN_ABI, functionName: "releaseFunds" });
    const raw = await account.signTransaction({
      chainId: 84532,
      type: "eip1559",
      to: escrow,
      data,
      value: 0n,
      nonce: 0,
      gas: 100_000n,
      maxFeePerGas: 2_000_000_000n,
      maxPriorityFeePerGas: 1n,
    });
    const hash = keccak256(raw);
    const pending = memoryPending();
    await pending.put(operationId, "release-funds", {
      chainId: 84532,
      txHash: hash,
      raw,
      signer: account.address,
      nonce: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    const api = fakeClient({
      releaseEscrow: vi.fn(async () => response(operation("confirmed", "release-funds", hash))),
    });
    const rpc = rpcHarness("success", [], undefined, false, {
      transaction: { to: escrow, data },
    });
    const chain = createTasksChain({
      client: api,
      account,
      rpcFor: () => rpc.client,
      pending,
    });

    await expect(
      chain.release({ escrowId: milestoneId, orderId, idempotencyKey: key }),
    ).rejects.toMatchObject({ broadcast: true });
    await expect(pending.get(operationId, "release-funds")).resolves.toMatchObject({
      raw,
      txHash: hash,
    });
  });

  it("allocates distinct nonces for concurrent operations signed by one wallet", async () => {
    const secondOperationId = "10000000-0000-4000-8000-000000000013";
    const secondMilestoneId = "10000000-0000-4000-8000-000000000014";
    const secondMilestone = { ...milestone, id: secondMilestoneId };
    const concurrentOrder = { ...order, milestones: [milestone, secondMilestone] } as typeof order;
    const ids = [operationId, secondOperationId];
    const milestoneFor = (id: string) => (id === operationId ? milestone : secondMilestone);
    const data = encodeFunctionData({ abi: TASKS_CHAIN_ABI, functionName: "releaseFunds" });
    let prepareCalls = 0;
    const releaseEscrow = vi.fn(async () => {
      const index = prepareCalls++;
      return anyResponse(
        operationFor({ id: ids[index]!, step: "release-funds", data, state: "prepared" }),
        index === 0 ? milestone : secondMilestone,
      );
    });
    const api = fakeClient({
      getOrder: vi.fn(async () => ({ workOrder: concurrentOrder })),
      getScopes: vi.fn(async () => ({
        scopes: [await acceptedScope(), await acceptedScope(secondMilestoneId)],
      })),
      releaseEscrow,
      recoverOperation: vi.fn(async (id) => ({
        ...anyResponse(
          operationFor({ id, step: "release-funds", data, state: "prepared" }),
          milestoneFor(id),
        ),
        recovered: false,
        scanComplete: true,
      })),
      recordTransaction: vi.fn(async (id, input) =>
        anyResponse(
          operationFor({
            id,
            step: "release-funds",
            data,
            state: "submitted",
            txHash: input.transactionHash,
          }),
          milestoneFor(id),
        ),
      ),
      reconcileOperation: vi.fn(async (id, input) =>
        anyResponse(
          operationFor({
            id,
            step: "release-funds",
            data,
            state: "confirmed",
            txHash: input.transactionHash,
          }),
          milestoneFor(id),
        ),
      ),
    });
    const rpc = rpcHarness();
    const chain = createTasksChain({
      client: api,
      account,
      rpcFor: () => rpc.client,
      pending: memoryPending(),
    });

    await Promise.all([
      chain.release({ escrowId: milestoneId, orderId, idempotencyKey: key }),
      chain.release({
        escrowId: secondMilestoneId,
        orderId,
        idempotencyKey: key,
      }),
    ]);

    expect(rpc.raw).toHaveLength(2);
    expect(rpc.raw.map((raw) => Number(parseTransaction(raw).nonce)).sort()).toEqual([0, 1]);
  });

  it("rejects a changed server operation ID without replacing saved signed bytes", async () => {
    const secondOperationId = "10000000-0000-4000-8000-000000000015";
    const data = encodeFunctionData({ abi: TASKS_CHAIN_ABI, functionName: "releaseFunds" });
    const releaseEscrow = vi
      .fn()
      .mockResolvedValueOnce(
        anyResponse(
          operationFor({ id: operationId, step: "release-funds", data, state: "prepared" }),
        ),
      )
      .mockResolvedValueOnce(
        anyResponse(
          operationFor({ id: secondOperationId, step: "release-funds", data, state: "prepared" }),
        ),
      );
    const api = fakeClient({ releaseEscrow });
    const pending = memoryPending();
    const signTransaction = vi.fn(account.signTransaction.bind(account));
    const signingAccount = { ...account, signTransaction } as LocalAccount;
    const rpc = rpcHarness("success", [], new Error("RPC 503"));
    const chain = createTasksChain({
      client: api,
      account: signingAccount,
      rpcFor: () => rpc.client,
      pending,
    });

    await expect(
      chain.release({ escrowId: milestoneId, orderId, idempotencyKey: key }),
    ).rejects.toMatchObject({ broadcast: true });
    const saved = await pending.get(operationId, "release-funds");
    await expect(
      chain.release({
        escrowId: milestoneId,
        orderId,
        idempotencyKey: "10000000-0000-4000-8000-000000000016",
      }),
    ).rejects.toMatchObject({ broadcast: true });

    expect(signTransaction).toHaveBeenCalledOnce();
    await expect(pending.get(operationId, "release-funds")).resolves.toEqual(saved);
    await expect(pending.get(secondOperationId, "release-funds")).resolves.toBeUndefined();
  });
});
