// Decodes every guard read and hosted plan against the copied current-contract artifact
// (v2-abi.generated.ts, refreshed by scripts/sync-tasks-v2-abi.mjs). A getter the contracts no
// longer expose, or a prediction tuple that no longer encodes, fails here instead of at signing.
import { describe, expect, it } from "vitest";
import {
  encodeFunctionData,
  getAddress,
  keccak256,
  parseAbi,
  toHex,
  zeroAddress,
  zeroHash,
  type Abi,
  type Hex,
  type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import type { TasksChainOptions } from "./chain.js";
import type { TasksClient } from "./client.js";
import { createArtifactRpc, predictedAddress, usdcTokenAbi } from "./fixtures/tasks-v2-chain.js";
import { V2_WRITE_OPERATION, V2_WRITE_ORDER } from "./fixtures/tasks-v2-writes.js";
import type { GetOrderResponse } from "./types.js";
import {
  bountyEscrowV2Abi,
  bountyPoolFactoryV1Abi,
  bountyPoolV1Abi,
  disputeResolverV3Abi,
  escrowFactoryV2Abi,
  escrowV2Abi,
} from "./v2-abi.generated.js";
import {
  acceptedV2TermsHash,
  verifyV2Plan,
  verifyV2Target,
  verifyV2TypedData,
} from "./v2-plan-guard.js";
import {
  taskV2IntentSchema,
  taskV2OperationResponseSchema,
  type TaskV2Action,
  type TaskV2Consent,
} from "./v2-write.js";

const account = privateKeyToAccount(`0x${"77".repeat(32)}`);
const WORKER = getAddress(`0x${"88".repeat(20)}`);
const USDC = getAddress(`0x${"44".repeat(20)}`);
const FACTORY = getAddress(`0x${"55".repeat(20)}`);
const POOL_FACTORY = getAddress(`0x${"66".repeat(20)}`);
const IMPLEMENTATION = getAddress(`0x${"67".repeat(20)}`);
const RESOLVER = getAddress(`0x${"99".repeat(20)}`);
const NOW = BigInt(Date.parse("2026-10-26T12:00:00Z") / 1000);
const DEADLINE = "2026-10-28T12:00:00.000Z";
const SALT = keccak256(toHex(V2_WRITE_ORDER));
const PIN = {
  escrowFactoryV2: FACTORY,
  disputeResolverV3: RESOLVER,
  bountyPoolFactoryV1: POOL_FACTORY,
  usdc: USDC,
  usdcName: "USD Coin",
  usdcVersion: "2",
  offerTtlSeconds: 86400,
};
const approvalAbi = parseAbi(["function approve(address spender, uint256 amount) returns (bool)"]);

function orderView(terms: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return {
    workOrder: {
      id: V2_WRITE_ORDER,
      clientAddress: account.address,
      title: "Deliver useful proof",
      description: "Deliver the requested proof for this task.",
      market: {
        budget: { network: "eip155:84532", amountBaseUnits: "100000000" },
        deadlineAt: DEADLINE,
      },
      terms,
      ...extra,
    },
  } as unknown as GetOrderResponse;
}
const taskTerms = {
  shape: "task",
  milestones: [
    { index: 1, amountBaseUnits: "100000000", acceptance: "A useful proof", deadlineAt: DEADLINE },
  ],
};
function operation(step: string, to: string, data: Hex) {
  return taskV2OperationResponseSchema.parse({
    orderId: V2_WRITE_ORDER,
    operation: {
      id: V2_WRITE_OPERATION,
      kind: "tasks-v2-write",
      state: "prepared",
      step,
      expectedActor: account.address,
      transactionHash: null,
      plan: {
        version: "work-transaction-plan-v2",
        operationId: V2_WRITE_OPERATION,
        step,
        chainId: 84532,
        network: "eip155:84532",
        from: account.address,
        to,
        data,
        value: "0",
      },
    },
  });
}

/** The vapi-app v2TermsFromOrder terms for the fixture order, as EscrowFactoryV2 takes them. */
function escrowCreation(view: GetOrderResponse, bounty = false) {
  return [
    {
      shape: bounty ? 1 : 0,
      poster: account.address,
      worker: zeroAddress,
      termsHash: acceptedV2TermsHash(view, PIN, 604800n),
      offerTtl: 86400n,
      reviewWindow: 604800n,
      choiceWindow: bounty ? 604800n : 0n,
      bountyDeadline: bounty ? BigInt(Date.parse(DEADLINE) / 1000) : 0n,
      objectionWindow: 604800n,
      workerBondBp: 0,
      feeBp: 500,
      winners: bounty ? 1 : 0,
      rewardPerWinner: bounty ? 100000000n : 0n,
    },
    bounty
      ? []
      : [
          {
            amount: 100000000n,
            deadline: BigInt(Date.parse(DEADLINE) / 1000),
            status: 0,
            deliveryHash: zeroHash,
          },
        ],
    SALT,
  ] as const;
}

function chain(input: {
  view: GetOrderResponse;
  registered: boolean;
  shape: "task" | "bounty" | "pool";
}) {
  const bounty = input.shape === "bounty";
  const pool = input.shape === "pool";
  const creation = pool
    ? ([
        account.address,
        20000000n,
        100000000n,
        BigInt(Date.parse(DEADLINE) / 1000),
        acceptedV2TermsHash(input.view, PIN, 0n),
        0,
        account.address,
        500,
        SALT,
      ] as const)
    : escrowCreation(input.view, bounty);
  const predictName = pool ? "predictPool" : bounty ? "predictBountyEscrow" : "predictEscrow";
  const factoryAbi: Abi = pool ? bountyPoolFactoryV1Abi : escrowFactoryV2Abi;
  const escrow = predictedAddress(factoryAbi, predictName, creation);
  const state = { registered: input.registered };
  // The hosted money view names a registered clone; a fresh one is only predicted.
  if (input.registered)
    Object.assign(input.view.workOrder, { v2State: { escrow: escrow.toLowerCase() } });
  const [terms, milestones] = creation as ReturnType<typeof escrowCreation>;
  const cloneValues = pool
    ? {
        FACTORY: POOL_FACTORY,
        USDC,
        poster: account.address,
        rewardPerClaim: 20000000n,
        budget: 100000000n,
        deadline: BigInt(Date.parse(DEADLINE) / 1000),
        termsHash: acceptedV2TermsHash(input.view, PIN, 0n),
        gate: 0,
        verifier: account.address,
        feeBp: 500,
      }
    : {
        FACTORY,
        USDC,
        DISPUTE_RESOLVER: RESOLVER,
        terms: { ...terms, worker: bounty ? zeroAddress : WORKER },
        totalPrincipal: 100000000n,
        milestoneCount: milestones.length,
        milestone: ([i]: readonly unknown[]) => milestones[Number(i)],
        consentNonces: 3n,
        submissionCommitment: () => [`0x${"5e".repeat(32)}`, NOW - 10n, true],
      };
  const rpc = createArtifactRpc({
    chainId: 84532,
    now: NOW,
    contracts: {
      [FACTORY]: {
        abi: escrowFactoryV2Abi,
        values: {
          paymentToken: USDC,
          implementation: IMPLEMENTATION,
          feeBp: 500,
          isEscrow: ([clone]: readonly unknown[]) =>
            state.registered && String(clone).toLowerCase() === escrow.toLowerCase(),
          predictEscrow: (args: readonly unknown[]) =>
            predictedAddress(escrowFactoryV2Abi, "predictEscrow", args),
          predictBountyEscrow: (args: readonly unknown[]) =>
            predictedAddress(escrowFactoryV2Abi, "predictBountyEscrow", args),
        },
      },
      [POOL_FACTORY]: {
        abi: bountyPoolFactoryV1Abi,
        values: {
          feeBp: 500,
          isPool: ([clone]: readonly unknown[]) =>
            state.registered && String(clone).toLowerCase() === escrow.toLowerCase(),
          predictPool: (args: readonly unknown[]) =>
            predictedAddress(bountyPoolFactoryV1Abi, "predictPool", args),
        },
      },
      [IMPLEMENTATION]: { abi: escrowV2Abi, values: { MIN_OBJECTION_WINDOW: 86400n } },
      [escrow]: {
        abi: pool ? bountyPoolV1Abi : bounty ? bountyEscrowV2Abi : escrowV2Abi,
        values: cloneValues,
      },
      [USDC]: { abi: usdcTokenAbi, values: { name: "USD Coin", version: "2" } },
      [RESOLVER]: { abi: disputeResolverV3Abi, values: {} },
    },
  });
  const options = {
    client: {} as TasksClient,
    account,
    pending: {} as TasksChainOptions["pending"],
    rpcFor: () => rpc as unknown as PublicClient,
    env: {},
    trustedV2Deployments: { 84532: PIN },
    onV2UntrustedOverride: () => {},
  } satisfies TasksChainOptions;
  // Tests read the escrow tuple only for task and bounty shapes.
  return { rpc, options, escrow, creation: creation as ReturnType<typeof escrowCreation>, state };
}

async function verify(
  c: ReturnType<typeof chain>,
  view: GetOrderResponse,
  action: TaskV2Action,
  step: string,
  to: string,
  data: Hex,
  pays = 0n,
) {
  const op = operation(step, to, data);
  const target = await verifyV2Target(c.options, op, view, action);
  await verifyV2Plan(target, op.operation, action, pays);
  return target;
}

describe("Tasks V2 guard against the current contract artifact", () => {
  it("verifies a registered task clone from terms(), totalPrincipal() and paymentToken()", async () => {
    const view = orderView(taskTerms);
    const c = chain({ view, registered: true, shape: "task" });
    const target = await verify(
      c,
      view,
      { action: "approve", i: 0 },
      "v2-approve",
      c.escrow,
      encodeFunctionData({ abi: escrowV2Abi, functionName: "approveMilestone", args: [0] }),
    );
    expect(target).toMatchObject({
      escrow: c.escrow,
      poster: account.address,
      worker: WORKER,
      total: 100000000n,
      feeBp: 500,
      bounty: false,
      milestones: [{ amount: 100000000n, status: 0 }],
    });
    expect(c.rpc.reads.map((r) => r.functionName)).toEqual(
      expect.arrayContaining(["paymentToken", "terms", "totalPrincipal", "predictEscrow"]),
    );
  });

  it("binds award and split calldata to the current two- and three-argument shapes", async () => {
    const view = orderView(taskTerms);
    const c = chain({ view, registered: true, shape: "task" });
    const consentBytes = `0x${"ab".repeat(96)}` as Hex;
    await verify(
      c,
      view,
      { action: "split", i: 0, toWorker: "40000000" },
      "v2-split",
      c.escrow,
      encodeFunctionData({
        abi: escrowV2Abi,
        functionName: "resolveWithSplit",
        args: [0, 40000000n, consentBytes],
      }),
    );
    await expect(
      verify(
        c,
        view,
        { action: "split", i: 0, toWorker: "40000000" },
        "v2-split",
        c.escrow,
        encodeFunctionData({
          abi: escrowV2Abi,
          functionName: "resolveWithSplit",
          args: [0, 50000000n, consentBytes],
        }),
      ),
    ).rejects.toMatchObject({ code: "v2_plan_mismatch" });
  });

  it("verifies fresh funding: createEscrow, the clone approval and fund()", async () => {
    const view = orderView(taskTerms);
    const c = chain({ view, registered: false, shape: "task" });
    const fund = { action: "fund" } as const;
    await verify(
      c,
      view,
      fund,
      "v2-create-escrow",
      FACTORY,
      encodeFunctionData({
        abi: escrowFactoryV2Abi,
        functionName: "createEscrow",
        args: c.creation,
      }),
    );
    await verify(
      c,
      view,
      fund,
      "v2-approve-usdc",
      USDC,
      encodeFunctionData({
        abi: approvalAbi,
        functionName: "approve",
        args: [c.escrow, 100000000n],
      }),
      100000000n,
    );
    c.state.registered = true;
    Object.assign(view.workOrder, { v2State: { escrow: c.escrow } });
    await verify(
      c,
      view,
      fund,
      "v2-fund",
      c.escrow,
      encodeFunctionData({ abi: escrowV2Abi, functionName: "fund" }),
    );
  });

  it("refuses fresh creation terms that differ from the accepted order", async () => {
    const view = orderView(taskTerms);
    const c = chain({ view, registered: false, shape: "task" });
    const [terms, milestones, salt] = c.creation;
    await expect(
      verify(
        c,
        view,
        { action: "fund" },
        "v2-create-escrow",
        FACTORY,
        encodeFunctionData({
          abi: escrowFactoryV2Abi,
          functionName: "createEscrow",
          args: [{ ...terms, workerBondBp: 2000 }, milestones, salt],
        }),
      ),
    ).rejects.toMatchObject({ code: "v2_plan_mismatch" });
  });

  it("verifies a bounty clone and binds awardBounty to the on-chain submission hashes", async () => {
    const view = orderView({
      shape: "bounty",
      bounty: { winners: 1, rewardPerWinnerBaseUnits: "100000000", deadlineAt: DEADLINE },
    });
    const c = chain({ view, registered: true, shape: "bounty" });
    const target = await verify(
      c,
      view,
      { action: "award-bounty", winners: [WORKER] },
      "v2-award-bounty",
      c.escrow,
      encodeFunctionData({
        abi: bountyEscrowV2Abi,
        functionName: "awardBounty",
        args: [[WORKER], [`0x${"5e".repeat(32)}`]],
      }),
    );
    expect(target).toMatchObject({ bounty: true, terms: { rewardPerWinner: 100000000n } });
  });

  it("verifies a pool clone from its getters and predictPool's flat inputs", async () => {
    const view = orderView({
      shape: "pool",
      pool: {
        rewardPerClaimBaseUnits: "20000000",
        budgetBaseUnits: "100000000",
        gate: "proven",
        verifier: "poster",
      },
    });
    const c = chain({ view, registered: true, shape: "pool" });
    await verify(
      c,
      view,
      { action: "pay-claim", claimant: WORKER },
      "v2-pay-claim",
      c.escrow,
      encodeFunctionData({
        abi: bountyPoolV1Abi,
        functionName: "payClaim",
        args: [WORKER, `0x${"12".repeat(32)}`],
      }),
    );
  });

  it("binds a jury step to the clone's DISPUTE_RESOLVER()", async () => {
    const view = orderView(taskTerms);
    const c = chain({ view, registered: true, shape: "task" });
    await verify(
      c,
      view,
      { action: "open-jury", i: 0 },
      "v2-open-jury",
      RESOLVER,
      encodeFunctionData({
        abi: disputeResolverV3Abi,
        functionName: "openJury",
        args: [c.escrow, 0],
      }),
    );
  });

  it("checks award consent against the vAPI Tasks Escrow v2 domain and consentNonces()", async () => {
    const view = orderView(taskTerms);
    const c = chain({ view, registered: true, shape: "task" });
    const consent: TaskV2Consent = { action: "award-consent" };
    const intent = taskV2IntentSchema.parse({
      kind: "eip712",
      operationId: "sig_1",
      signer: account.address,
      typedData: {
        domain: {
          name: "vAPI Tasks Escrow",
          version: "2",
          chainId: 84532,
          verifyingContract: c.escrow,
        },
        types: {
          AwardConsent: [
            { name: "escrow", type: "address" },
            { name: "worker", type: "address" },
            { name: "termsHash", type: "bytes32" },
            { name: "nonce", type: "uint256" },
            { name: "expiry", type: "uint64" },
          ],
        },
        primaryType: "AwardConsent",
        message: {
          escrow: c.escrow,
          worker: account.address,
          termsHash: c.creation[0].termsHash,
          nonce: "3",
          expiry: (NOW + 600n).toString(),
        },
      },
    });
    const verified = await verifyV2Target(
      c.options,
      operation(
        "v2-approve",
        c.escrow,
        encodeFunctionData({ abi: escrowV2Abi, functionName: "approveMilestone", args: [0] }),
      ),
      view,
      { action: "approve", i: 0 },
    );
    await expect(
      verifyV2TypedData(verified, intent, consent, account.address, 0n),
    ).resolves.toBeUndefined();
    await expect(
      verifyV2TypedData(
        verified,
        {
          ...intent,
          typedData: {
            ...intent.typedData,
            domain: { ...intent.typedData.domain, name: "vAPI EscrowV2", version: "1" },
          },
        },
        consent,
        account.address,
        0n,
      ),
    ).rejects.toMatchObject({ code: "v2_plan_mismatch" });
  });
});
