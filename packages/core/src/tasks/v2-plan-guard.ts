import {
  decodeFunctionData,
  getAbiItem,
  getAddress,
  isAddressEqual,
  keccak256,
  parseAbi,
  toHex,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
  zeroAddress,
} from "viem";
import { z } from "zod";
import { canonicalJson } from "./canonical-json.js";
import { getTrustedTasksDurations } from "./trusted-deployments.js";
import { DEFAULT_ACCEPTANCE_WINDOW_SECONDS } from "./scope-terms.js";
import { freezeScopeTerms } from "./scope-terms.js";
import { taskTermsFields } from "./v2.js";
import { TaskOperationError } from "./operation-support.js";
import {
  escrowFactoryV2Abi,
  bountyPoolFactoryV1Abi,
  escrowV2Abi,
  bountyPoolV1Abi,
  disputeResolverV3Abi,
} from "./v2-abi.js";
import { getTrustedTasksV2Deployment, type TasksV2Deployment } from "./v2-trust.js";
import {
  taskV2IntentSchema,
  taskV2OperationResponseSchema,
  type TaskV2Action,
  type TaskV2Consent,
  type TaskV2Operation,
  type TaskV2Prepared,
} from "./v2-write.js";
import type { TasksChainOptions } from "./chain.js";
import type { GetOrderResponse } from "./types.js";

const address = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/u)
  .transform((v) => getAddress(v));
const hash = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/u)
  .transform((v) => v.toLowerCase() as Hex);
const uint = z
  .union([z.bigint(), z.number().int().nonnegative(), z.string().regex(/^\d+$/u)])
  .transform(BigInt);
const approvalAbi = parseAbi(["function approve(address spender, uint256 amount) returns (bool)"]);
const tokenAbi = parseAbi([
  "function name() view returns (string)",
  "function version() view returns (string)",
]);
const authorizationTypes = {
  ReceiveWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
};
const consentTypes = {
  AwardConsent: [
    { name: "worker", type: "address" },
    { name: "termsDigest", type: "bytes32" },
    { name: "nonce", type: "uint256" },
    { name: "expiry", type: "uint64" },
  ],
  SplitConsent: [
    { name: "signer", type: "address" },
    { name: "milestone", type: "uint8" },
    { name: "toWorker", type: "uint96" },
    { name: "nonce", type: "uint256" },
    { name: "expiry", type: "uint64" },
  ],
};
export const v2GuardFailure = (message: string): never => {
  throw new TaskOperationError("v2_plan_mismatch", message);
};
const same = (a: unknown, b: unknown) =>
  typeof a === "string" &&
  typeof b === "string" &&
  isAddressEqual(address.parse(a), address.parse(b));
const argumentJson = (value: unknown) =>
  canonicalJson(
    JSON.parse(
      JSON.stringify(value, (_, item: unknown) =>
        typeof item === "bigint" ? item.toString() : item,
      ),
    ),
  );
const digest = (value: unknown) => keccak256(toHex(canonicalJson(value)));
export async function v2Read(
  rpc: PublicClient,
  contract: Address,
  abi: Abi,
  functionName: string,
  args: readonly unknown[] = [],
) {
  return rpc.readContract({ address: contract, abi, functionName, args });
}
export type VerifiedV2Target = {
  chainId: number;
  pin: TasksV2Deployment;
  rpc: PublicClient;
  escrow: Address;
  factory: Address;
  pool: boolean;
  poster: Address;
  worker?: Address;
  total: bigint;
  feeBp: number;
  termsHash: Hex;
  termsDigest?: Hex;
  milestones: Array<{ amount: bigint; deadline: bigint; status: number }>;
  creationArgs?: readonly unknown[];
};

export function acceptedV2TermsHash(
  view: GetOrderResponse,
  pin: TasksV2Deployment,
  reviewWindow: bigint,
) {
  const order = view.workOrder;
  const terms = z.object(taskTermsFields).parse(order.terms);
  const market = z
    .object({ budget: z.object({ network: z.string(), amountBaseUnits: z.string() }) })
    .parse(order.market);
  if (terms.shape === "pool")
    return digest({
      version: "work-pool-terms-v2",
      title: order.title,
      description: order.description,
      terms,
    });
  const plan = terms.bounty
    ? [
        {
          index: 1,
          amountBaseUnits: (
            BigInt(terms.bounty.rewardPerWinnerBaseUnits) * BigInt(terms.bounty.winners)
          ).toString(),
          acceptance: order.title,
          deadlineAt: terms.bounty.deadlineAt,
        },
      ]
    : terms.milestones;
  if (!plan?.length) return v2GuardFailure("The accepted funding milestone terms are unavailable.");
  const frozen = freezeScopeTerms(
    {
      version: "work-milestone-terms-v1",
      title: order.title,
      description: order.description,
      acceptanceCriteria: plan.map((m) =>
        m.acceptance.trim().length >= 3 ? m.acceptance.slice(0, 500) : order.title,
      ),
      deliverables: [order.title],
      revisionCount: 0,
      deadline: plan.reduce(
        (latest, m) => (m.deadlineAt > latest ? m.deadlineAt : latest),
        plan[0]!.deadlineAt,
      ),
      acceptanceWindowSeconds: Number(reviewWindow),
      budget: { ...market.budget, asset: `${market.budget.network}/erc20:${pin.usdc}` },
      escrow: { protocol: "escrow-v1", contract: pin.escrowFactoryV2 },
      evidenceRules: { acceptedInputs: ["text", "private-file"], exactCommitRequired: false },
    },
    order.description,
  );
  // Matches the hosted work-scope-terms-v2 envelope without changing V1 hashing.
  return digest({
    structured: JSON.parse(
      JSON.stringify({
        ...frozen.structured,
        ...terms,
        version: "work-scope-terms-v2",
        milestones: plan,
      }),
    ),
    brief: frozen.brief,
  });
}

function verifyAcceptedCreation(
  options: TasksChainOptions,
  view: GetOrderResponse,
  pin: TasksV2Deployment,
  creationArgs: readonly unknown[],
  pool: boolean,
  chainId: number,
  requirePosterVerifier = true,
) {
  const order = view.workOrder;
  const terms = z
    .object({
      poster: address,
      termsHash: hash,
      total: uint.optional(),
      budget: uint.optional(),
      reviewWindow: uint.optional(),
      shape: z.number().optional(),
      winners: z.number().optional(),
      rewardPerWinner: uint.optional(),
      rewardPerClaim: uint.optional(),
      verifier: address.optional(),
      gate: z.number().optional(),
      deadline: uint.optional(),
    })
    .parse(creationArgs[0]);
  const declared = order.terms;
  const acceptedReviewWindow = BigInt(
    getTrustedTasksDurations(chainId, options.trustedDurations).reviewWindowSeconds ??
      DEFAULT_ACCEPTANCE_WINDOW_SECONDS,
  );
  if (!pool && terms.reviewWindow !== acceptedReviewWindow)
    return v2GuardFailure("Funding review window differs from the locally accepted default.");
  const poster = address.parse(order.clientAddress);
  if (!same(terms.poster, poster))
    return v2GuardFailure("The registered poster differs from the accepted order.");
  if (String(creationArgs.at(-1)).toLowerCase() !== keccak256(toHex(order.id)))
    return v2GuardFailure("Funding salt differs from the requested order.");
  const total = pool ? terms.budget : terms.total;
  const budget = z.object({ budget: z.object({ amountBaseUnits: uint }) }).parse(order.market)
    .budget.amountBaseUnits;
  if (
    total !== budget ||
    terms.termsHash !== acceptedV2TermsHash(view, pin, pool ? 0n : acceptedReviewWindow)
  )
    return v2GuardFailure(
      "The registered target or funding calldata differs from accepted order terms.",
    );
  if (!pool) {
    const expected = declared?.bounty
      ? [
          {
            amount: budget,
            deadline: BigInt(Math.floor(Date.parse(declared.bounty.deadlineAt) / 1000)),
          },
        ]
      : declared?.milestones?.map((m) => ({
          amount: BigInt(m.amountBaseUnits),
          deadline: BigInt(Math.floor(Date.parse(m.deadlineAt) / 1000)),
        }));
    if (
      argumentJson(creationArgs[1]) !== argumentJson(expected) ||
      terms.shape !== (declared?.shape === "bounty" ? 1 : 0) ||
      terms.winners !== (declared?.bounty?.winners ?? 0) ||
      terms.rewardPerWinner !== BigInt(declared?.bounty?.rewardPerWinnerBaseUnits ?? 0)
    )
      return v2GuardFailure("Funding milestone or bounty allocations differ from accepted terms.");
  } else if (
    !declared?.pool ||
    terms.rewardPerClaim !== BigInt(declared.pool.rewardPerClaimBaseUnits) ||
    terms.gate !== (declared.pool.gate === "proven" ? 0 : 1) ||
    terms.deadline !==
      BigInt(
        Math.floor(
          Date.parse(z.object({ deadlineAt: z.string() }).parse(order.market).deadlineAt) / 1000,
        ),
      ) ||
    (requirePosterVerifier && declared.pool.verifier !== "poster") ||
    (declared.pool.verifier === "poster" && !same(terms.verifier, poster))
  )
    return v2GuardFailure(
      "Pool funding requires the accepted reward, gate and locally accepted poster verifier.",
    );
}

/** Prediction inputs only: participant transaction calldata always comes from the API. */
function acceptedCreationArgs(
  options: TasksChainOptions,
  view: GetOrderResponse,
  pin: TasksV2Deployment,
  chainId: number,
): readonly unknown[] {
  const order = view.workOrder;
  const terms = z.object(taskTermsFields).parse(order.terms);
  const poster = address.parse(order.clientAddress);
  const total = z.object({ budget: z.object({ amountBaseUnits: uint }) }).parse(order.market)
    .budget.amountBaseUnits;
  const salt = keccak256(toHex(order.id));
  const reviewWindow = BigInt(
    getTrustedTasksDurations(chainId, options.trustedDurations).reviewWindowSeconds ??
      DEFAULT_ACCEPTANCE_WINDOW_SECONDS,
  );
  if (terms.shape === "pool") {
    if (!terms.pool || terms.pool.verifier !== "poster")
      return v2GuardFailure("Pool funding requires a locally accepted poster verifier.");
    return [
      {
        poster,
        rewardPerClaim: BigInt(terms.pool.rewardPerClaimBaseUnits),
        budget: total,
        deadline: BigInt(
          Math.floor(
            Date.parse(z.object({ deadlineAt: z.string() }).parse(order.market).deadlineAt) / 1000,
          ),
        ),
        termsHash: acceptedV2TermsHash(view, pin, 0n),
        gate: terms.pool.gate === "proven" ? 0 : 1,
        verifier: poster,
      },
      salt,
    ];
  }
  const milestones = terms.bounty
    ? [{ amount: total, deadline: BigInt(Math.floor(Date.parse(terms.bounty.deadlineAt) / 1000)) }]
    : terms.milestones?.map((m) => ({
        amount: BigInt(m.amountBaseUnits),
        deadline: BigInt(Math.floor(Date.parse(m.deadlineAt) / 1000)),
      }));
  if (!milestones?.length) return v2GuardFailure("Accepted V2 milestones are unavailable.");
  return [
    {
      shape: terms.shape === "bounty" ? 1 : 0,
      poster,
      termsHash: acceptedV2TermsHash(view, pin, reviewWindow),
      total,
      offerTtl: BigInt(pin.offerTtlSeconds ?? 604800),
      reviewWindow,
      choiceWindow: BigInt(pin.choiceWindowSeconds ?? 604800),
      winners: terms.bounty?.winners ?? 0,
      rewardPerWinner: BigInt(terms.bounty?.rewardPerWinnerBaseUnits ?? 0),
    },
    milestones,
    salt,
  ];
}

function verifyActor(
  action: TaskV2Action | TaskV2Consent,
  signer: Address,
  poster: Address,
  worker?: Address,
  verifier?: Address,
) {
  const isPoster = same(signer, poster);
  const isWorker = worker !== undefined && same(signer, worker);
  let permitted = true;
  switch (action.action) {
    case "fund":
    case "award":
    case "award-bounty":
    case "approve":
    case "reject":
    case "cancel-remainder":
      permitted = isPoster;
      break;
    case "submit":
    case "refund":
      permitted = isWorker;
      break;
    case "raise-dispute":
    case "counter-evidence":
    case "split":
    case "split-consent":
      permitted = isPoster || isWorker;
      break;
    case "pay-claim":
      permitted = verifier !== undefined && same(signer, verifier);
      break;
    case "award-consent":
      // Award consent is signed by the prospective worker before assignment.
      permitted = !isPoster && (worker === zeroAddress || isWorker);
      break;
  }
  if (!permitted)
    v2GuardFailure(
      "The acting wallet does not have the on-chain role required for this V2 action.",
    );
}

/** The API supplies candidates; only local pins and trusted RPC reads establish trust. */
export async function verifyV2Target(
  options: TasksChainOptions,
  current: TaskV2Prepared,
  view: GetOrderResponse,
  action: TaskV2Action | TaskV2Consent,
  knownTarget?: Address,
): Promise<VerifiedV2Target> {
  const operation = taskV2OperationResponseSchema.safeParse(current);
  const intent = taskV2IntentSchema.safeParse(current);
  const chainId = operation.success
    ? operation.data.operation.plan.chainId
    : intent.data!.typedData.domain.chainId;
  const pin = getTrustedTasksV2Deployment(chainId, {
    overrides: options.trustedV2Deployments,
    env: options.env,
    notice: options.onV2UntrustedOverride,
  });
  const rpc = options.rpcFor(chainId);
  if ((await rpc.getChainId()) !== chainId)
    return v2GuardFailure("The RPC chain differs from the locally pinned V2 chain.");
  const order = view.workOrder;
  const pool = order.terms?.shape === "pool";
  const factory = pool ? pin.bountyPoolFactoryV1 : pin.escrowFactoryV2;
  if (!same(await v2Read(rpc, pin.escrowFactoryV2, escrowFactoryV2Abi, "usdc"), pin.usdc))
    return v2GuardFailure("The pinned factory payment token differs from pinned USDC.");
  let candidate =
    knownTarget ??
    z.object({ escrow: address }).safeParse(order.v2State).data?.escrow ??
    (intent.success
      ? z.object({ escrow: address }).safeParse(intent.data).data?.escrow
      : undefined);
  let creationArgs: readonly unknown[] | undefined;
  if (
    action.action === "fund" &&
    operation.success &&
    same(operation.data.operation.plan.to, factory)
  ) {
    const decoded = decodeFunctionData({
      abi: pool ? bountyPoolFactoryV1Abi : escrowFactoryV2Abi,
      data: operation.data.operation.plan.data,
    });
    const names = pool
      ? ["createPool", "createAndFundPoolWithAuthorization"]
      : ["createAndFund", "createAndFundWithAuthorization"];
    if (!names.includes(decoded.functionName))
      return v2GuardFailure("Unexpected V2 factory funding selector.");
    creationArgs = decoded.args!.slice(0, pool ? 2 : 3);
    verifyAcceptedCreation(options, view, pin, creationArgs, pool, chainId);
    candidate = address.parse(
      await v2Read(
        rpc,
        factory,
        pool ? bountyPoolFactoryV1Abi : escrowFactoryV2Abi,
        pool ? "predictPool" : "predictEscrow",
        creationArgs,
      ),
    );
  }
  if (
    action.action === "fund" &&
    operation.success &&
    operation.data.operation.plan.step === "v2-approve-usdc"
  ) {
    creationArgs = acceptedCreationArgs(options, view, pin, chainId);
    verifyAcceptedCreation(options, view, pin, creationArgs, pool, chainId);
    const predicted = address.parse(
      await v2Read(
        rpc,
        factory,
        pool ? bountyPoolFactoryV1Abi : escrowFactoryV2Abi,
        pool ? "predictPool" : "predictEscrow",
        creationArgs,
      ),
    );
    if (candidate && !same(candidate, predicted))
      return v2GuardFailure(
        "The funding target differs from the prediction for accepted creation terms.",
      );
    candidate = predicted;
  }
  if (!candidate)
    return v2GuardFailure(
      "The V2 target cannot be independently verified from this response. A registered target or verifiable funding creation terms are required.",
    );
  const registered = await v2Read(
    rpc,
    factory,
    pool ? bountyPoolFactoryV1Abi : escrowFactoryV2Abi,
    pool ? "isPool" : "isEscrow",
    [candidate],
  );
  if (registered !== true) {
    // The hosted signature intent has no frozen creation arguments: never sign
    // a redeemable authorization to its unverified predicted address.
    if (action.action !== "fund" || !operation.success || !creationArgs)
      return v2GuardFailure("The V2 target is not registered by the locally pinned factory.");
    const expectedCreation = acceptedCreationArgs(options, view, pin, chainId);
    if (argumentJson(creationArgs) !== argumentJson(expectedCreation))
      return v2GuardFailure("Fresh funding inputs differ from locally accepted creation terms.");
    verifyActor(action, options.account.address, address.parse(order.clientAddress));
    const t = z
      .object({ poster: address, total: uint.optional(), budget: uint.optional(), termsHash: hash })
      .parse(creationArgs[0]);
    return {
      chainId,
      pin,
      rpc,
      escrow: candidate,
      factory,
      pool,
      poster: t.poster,
      total: t.total ?? t.budget!,
      feeBp: Number(await v2Read(rpc, factory, escrowFactoryV2Abi, "feeBp")),
      termsHash: t.termsHash,
      milestones: [],
      creationArgs,
    };
  }
  const abi = pool ? bountyPoolV1Abi : escrowV2Abi;
  const poster = address.parse(await v2Read(rpc, candidate, abi, "poster"));
  if (
    !same(poster, order.clientAddress) ||
    (action.action === "fund" && !same(poster, options.account.address))
  )
    return v2GuardFailure("The registered V2 poster differs from the task or acting wallet.");
  const total = uint.parse(await v2Read(rpc, candidate, abi, pool ? "budget" : "total"));
  const feeBp = z
    .number()
    .int()
    .min(0)
    .max(2000)
    .parse(Number(await v2Read(rpc, candidate, abi, "feeBp")));
  const termsHash = hash.parse(await v2Read(rpc, candidate, abi, "termsHash"));
  const milestones: VerifiedV2Target["milestones"] = [];
  if (!pool) {
    const count = z
      .number()
      .int()
      .min(1)
      .max(5)
      .parse(Number(await v2Read(rpc, candidate, abi, "milestoneCount")));
    for (let i = 0; i < count; i++)
      milestones.push(
        z
          .object({ amount: uint, deadline: uint, status: z.number().int().min(0).max(5) })
          .parse(await v2Read(rpc, candidate, abi, "milestone", [i])),
      );
  }
  {
    const suppliedCreation = creationArgs;
    const read = (name: string) => v2Read(rpc, candidate!, abi, name);
    if (pool) {
      const verifier = address.parse(await read("verifier"));
      if (
        action.action === "fund" &&
        (order.terms?.pool?.verifier !== "poster" || !same(verifier, poster))
      )
        return v2GuardFailure("Pool funding requires a locally accepted poster verifier.");
      creationArgs = [
        {
          poster,
          rewardPerClaim: uint.parse(await read("rewardPerClaim")),
          budget: total,
          deadline: uint.parse(await read("deadline")),
          termsHash,
          gate: Number(await read("gate")),
          verifier,
        },
        keccak256(toHex(order.id)),
      ];
    } else {
      creationArgs = [
        {
          shape: Number(await read("shape")),
          poster,
          termsHash,
          total,
          offerTtl: uint.parse(await read("offerTtl")),
          reviewWindow: uint.parse(await read("reviewWindow")),
          choiceWindow: uint.parse(await read("choiceWindow")),
          winners: Number(await read("winners")),
          rewardPerWinner: uint.parse(await read("rewardPerWinner")),
        },
        milestones.map(({ amount, deadline }) => ({ amount, deadline })),
        keccak256(toHex(order.id)),
      ];
    }
    verifyAcceptedCreation(
      options,
      view,
      pin,
      creationArgs,
      pool,
      chainId,
      action.action === "fund",
    );
    if (suppliedCreation && argumentJson(suppliedCreation) !== argumentJson(creationArgs))
      return v2GuardFailure("Funding inputs differ from the registered escrow's frozen terms.");
    const predicted = await v2Read(
      rpc,
      factory,
      pool ? bountyPoolFactoryV1Abi : escrowFactoryV2Abi,
      pool ? "predictPool" : "predictEscrow",
      creationArgs,
    );
    if (!same(predicted, candidate))
      return v2GuardFailure(
        "The V2 target differs from the pinned factory's prediction for the requested order.",
      );
  }
  const worker = !pool ? address.parse(await v2Read(rpc, candidate, abi, "worker")) : undefined;
  const verifier = pool ? address.parse(await v2Read(rpc, candidate, abi, "verifier")) : undefined;
  verifyActor(action, options.account.address, poster, worker, verifier);
  return {
    chainId,
    pin,
    rpc,
    escrow: candidate,
    factory,
    pool,
    poster,
    total,
    feeBp,
    termsHash,
    milestones,
    creationArgs,
    ...(!pool
      ? {
          worker,
          termsDigest: hash.parse(await v2Read(rpc, candidate, abi, "termsDigest")),
        }
      : {}),
  };
}

export async function verifyV2TypedData(
  target: VerifiedV2Target,
  intent: z.infer<typeof taskV2IntentSchema>,
  action: TaskV2Action | TaskV2Consent,
  signer: Address,
  pays: bigint,
) {
  const { typedData: typed } = intent;
  if (!same(intent.signer, signer) || typed.domain.chainId !== target.chainId)
    return v2GuardFailure("Hosted typed data names another signer or chain.");
  const block = await target.rpc.getBlock();
  if (action.action === "fund") {
    const message = z
      .strictObject({
        from: address,
        to: address,
        value: uint,
        validAfter: uint,
        validBefore: uint,
        nonce: hash,
      })
      .parse(typed.message);
    if (
      typed.primaryType !== "ReceiveWithAuthorization" ||
      canonicalJson(typed.types) !== canonicalJson(authorizationTypes) ||
      typed.domain.name !== target.pin.usdcName ||
      typed.domain.version !== target.pin.usdcVersion ||
      !same(typed.domain.verifyingContract, target.pin.usdc) ||
      !same(message.from, signer) ||
      !same(message.to, target.escrow) ||
      !same(intent.escrow, target.escrow) ||
      message.value !== pays ||
      message.validAfter >= block.timestamp ||
      message.validBefore <= block.timestamp ||
      message.validBefore - message.validAfter > 3600n ||
      message.validAfter < block.timestamp - 3600n
    )
      return v2GuardFailure(
        "Funding authorization differs from the pinned USDC schema, verified target, amount or bounded time window.",
      );
    if (
      (await v2Read(target.rpc, target.pin.usdc, tokenAbi, "name")) !== target.pin.usdcName ||
      (await v2Read(target.rpc, target.pin.usdc, tokenAbi, "version")) !== target.pin.usdcVersion
    )
      return v2GuardFailure("The pinned USDC domain differs from its on-chain name or version.");
  } else {
    const primary =
      action.action === "award-consent"
        ? "AwardConsent"
        : action.action === "split-consent"
          ? "SplitConsent"
          : undefined;
    if (
      !primary ||
      typed.primaryType !== primary ||
      canonicalJson(typed.types) !== canonicalJson({ [primary]: consentTypes[primary] }) ||
      typed.domain.name !== "vAPI EscrowV2" ||
      typed.domain.version !== "1" ||
      !same(typed.domain.verifyingContract, target.escrow)
    )
      return v2GuardFailure("Consent domain or schema differs from the verified escrow.");
    const m = typed.message;
    if (
      !same(m.worker ?? m.signer, signer) ||
      uint.parse(m.expiry) <= block.timestamp ||
      uint.parse(m.expiry) > block.timestamp + 3600n ||
      uint.parse(m.nonce) !==
        uint.parse(await v2Read(target.rpc, target.escrow, escrowV2Abi, "nonces", [signer]))
    )
      return v2GuardFailure("Consent signer, nonce or expiry mismatch.");
    if (action.action === "award-consent" && m.termsDigest !== target.termsDigest)
      return v2GuardFailure("Award consent differs from the escrow terms digest.");
    if (
      action.action === "split-consent" &&
      (String(m.milestone) !== String(action.i) || String(m.toWorker) !== action.toWorker)
    )
      return v2GuardFailure("Split consent differs from the requested index or amount.");
  }
}

/** Decode every step, bind selector/arguments/destination to the requested action. */
export async function verifyV2Plan(
  target: VerifiedV2Target,
  op: TaskV2Operation,
  action: TaskV2Action | TaskV2Consent,
  pays: bigint,
  fundingAuthorization?: { message: Record<string, unknown>; signature: Hex },
) {
  const plan = op.plan;
  if (plan.value !== "0" || plan.chainId !== target.chainId)
    return v2GuardFailure("V2 plan value or chain mismatch.");
  if (plan.step === "v2-approve-usdc") {
    if (
      !["fund", "raise-dispute", "counter-evidence"].includes(action.action) ||
      !same(plan.to, target.pin.usdc)
    )
      return v2GuardFailure("Unexpected USDC approval step or destination.");
    const decoded = decodeFunctionData({ abi: approvalAbi, data: plan.data });
    // C0 task funding approves the pinned factory; pools and dispute fees approve the verified clone.
    const spender = action.action === "fund" && !target.pool ? target.factory : target.escrow;
    if (!same(decoded.args[0], spender) || decoded.args[1] !== pays)
      return v2GuardFailure("USDC approval spender or amount mismatch.");
    return;
  }
  if (action.action === "fund" && same(plan.to, target.factory)) {
    const decoded = decodeFunctionData({
      abi: target.pool ? bountyPoolFactoryV1Abi : escrowFactoryV2Abi,
      data: plan.data,
    });
    const allowed = target.pool
      ? plan.step === "v2-create-pool"
        ? "createPool"
        : "createAndFundPoolWithAuthorization"
      : fundingAuthorization
        ? "createAndFundWithAuthorization"
        : "createAndFund";
    const n = target.pool ? 2 : 3;
    if (
      !["v2-create-pool", "v2-fund"].includes(plan.step) ||
      decoded.functionName !== allowed ||
      !target.creationArgs ||
      argumentJson(decoded.args!.slice(0, n)) !== argumentJson(target.creationArgs)
    )
      return v2GuardFailure("Factory funding calldata differs from verified creation terms.");
    if (fundingAuthorization) {
      const m = fundingAuthorization.message;
      const tail = decoded.args!.slice(n);
      if (
        !same(tail[0], m.from) ||
        String(tail[1]) !== String(m.validAfter) ||
        String(tail[2]) !== String(m.validBefore) ||
        tail[3] !== m.nonce ||
        tail[4] !== fundingAuthorization.signature
      )
        return v2GuardFailure(
          "Factory funding authorization differs from the locally signed payload.",
        );
    } else if (decoded.args!.length !== n)
      return v2GuardFailure("Unexpected factory funding authorization.");
    return;
  }
  if (!same(plan.to, target.escrow) || plan.step !== `v2-${action.action}`)
    return v2GuardFailure("V2 step or destination differs from the requested verified target.");
  const decoded = decodeFunctionData({
    abi: target.pool ? bountyPoolV1Abi : escrowV2Abi,
    data: plan.data,
  });
  const args = decoded.args ?? [];
  let name: string, expected: readonly unknown[];
  switch (action.action) {
    case "fund":
      if (!target.pool) return v2GuardFailure("Task funding must use the verified factory.");
      name = "fund";
      expected = [];
      break;
    case "submit":
      name = "submitMilestone";
      expected = [action.i, digest(action.proof)];
      break;
    case "approve":
      name = "approveMilestone";
      expected = [action.i];
      break;
    case "reject":
      name = "rejectMilestone";
      expected = [action.i, digest(action.reason)];
      break;
    case "finalize":
      name = "finalizeMilestone";
      expected = [action.i];
      break;
    case "cancel-offer":
      name = "cancelOffer";
      expected = [];
      break;
    case "cancel-remainder":
      name = "cancelRemainder";
      expected = [];
      break;
    case "expire":
      name = "expireBounty";
      expected = [];
      break;
    case "refund":
      name = "refundRemainder";
      expected = [];
      break;
    case "raise-dispute":
      name = "raiseDispute";
      expected = [action.i, digest(action.evidence)];
      break;
    case "counter-evidence":
      name = "submitCounterEvidence";
      expected = [action.i, digest(action.evidence)];
      break;
    case "resolve-unmatched":
      name = "resolveUnmatched";
      expected = [action.i];
      break;
    case "award-bounty":
      name = "awardBounty";
      expected = [action.winners.map((v) => getAddress(v))];
      break;
    case "award":
      name = "award";
      expected = [getAddress(action.worker), args[1], args[2]];
      break;
    case "split":
      name = "resolveWithSplit";
      expected = [action.i, BigInt(action.toWorker), args[2], args[3]];
      break;
    case "pay-claim":
      name = "payClaim";
      expected = [getAddress(action.claimant), hash.parse(args[1])];
      break;
    default:
      return v2GuardFailure("Unknown participant action or selector.");
  }
  // Normalize addresses only; never encode or modify the prepared calldata.
  const normalize = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(normalize)
      : typeof v === "string" && /^0x[0-9a-fA-F]{40}$/u.test(v)
        ? getAddress(v)
        : v;
  if (
    decoded.functionName !== name ||
    argumentJson(normalize(args)) !== argumentJson(normalize(expected))
  )
    return v2GuardFailure("V2 calldata selector or arguments differ from the user's action.");
}

export async function verifyUnmatchedSettlement(
  target: VerifiedV2Target,
  i: number,
  dispute: unknown,
) {
  const data = z
    .object({ stage: z.literal("Raised"), matched: z.literal(false), raisedBy: address })
    .parse(dispute);
  const milestone = target.milestones[i];
  if (
    !milestone ||
    milestone.status !== 4 ||
    (!same(data.raisedBy, target.poster) && !same(data.raisedBy, target.worker))
  )
    return v2GuardFailure("Verified unmatched dispute settlement state is unavailable.");
  const resolver = address.parse(
    await v2Read(target.rpc, target.pin.escrowFactoryV2, escrowFactoryV2Abi, "disputeResolver"),
  );
  const stage = Number(
    await v2Read(target.rpc, resolver, disputeResolverV3Abi, "stage", [target.escrow, i]),
  );
  const windows = z
    .array(uint)
    .parse(
      await v2Read(target.rpc, resolver, disputeResolverV3Abi, "deadlines", [target.escrow, i]),
    );
  if (
    stage !== 1 ||
    windows[0] === undefined ||
    (await target.rpc.getBlock()).timestamp <= windows[0]
  )
    return v2GuardFailure("The on-chain unmatched evidence window has not closed.");
  const logs = await target.rpc.getLogs({
    address: resolver,
    event: getAbiItem({ abi: disputeResolverV3Abi, name: "DisputeOpened" }),
    args: { escrow: target.escrow, i },
    fromBlock: 0n,
    toBlock: "latest",
  });
  if (!same(logs.at(-1)?.args.raisedBy, data.raisedBy))
    return v2GuardFailure("The unmatched dispute opener differs from its verified chain event.");
  return { gross: milestone.amount, toWorker: same(data.raisedBy, target.worker) };
}
