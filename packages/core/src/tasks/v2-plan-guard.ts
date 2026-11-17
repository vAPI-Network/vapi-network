import {
  decodeFunctionData,
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
  zeroHash,
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
  escrowV2Abi,
  bountyEscrowV2Abi,
  bountyPoolFactoryV1Abi,
  bountyPoolV1Abi,
  disputeResolverV3Abi,
  TASK_V2_CASE_STATE,
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
const small = (max: number) =>
  z.union([z.number(), z.bigint()]).transform(Number).pipe(z.number().int().min(0).max(max));
const feeBpSchema = small(2000);
/** IEscrowV2.Terms as EscrowV2Base.terms() returns it and the factory takes it. */
const escrowTermsSchema = z.object({
  shape: small(1),
  poster: address,
  worker: address,
  termsHash: hash,
  offerTtl: uint,
  reviewWindow: uint,
  choiceWindow: uint,
  bountyDeadline: uint,
  objectionWindow: uint,
  workerBondBp: small(2000),
  feeBp: feeBpSchema,
  winners: small(255),
  rewardPerWinner: uint,
});
export type V2EscrowTerms = z.output<typeof escrowTermsSchema>;
const milestoneSchema = z.object({
  amount: uint,
  deadline: uint,
  status: small(5),
  deliveryHash: hash,
});
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
/** EscrowV2 consent typehashes (vapi-app abi/tasks-v2.ts awardConsentTypes, splitConsentTypes). */
const consentTypes = {
  AwardConsent: [
    { name: "escrow", type: "address" },
    { name: "worker", type: "address" },
    { name: "termsHash", type: "bytes32" },
    { name: "nonce", type: "uint256" },
    { name: "expiry", type: "uint64" },
  ],
  SplitConsent: [
    { name: "escrow", type: "address" },
    { name: "milestone", type: "uint8" },
    { name: "toWorker", type: "uint96" },
    { name: "termsHash", type: "bytes32" },
    { name: "signer", type: "address" },
    { name: "nonce", type: "uint256" },
    { name: "expiry", type: "uint64" },
  ],
};
/** EscrowV2Base EIP-712 domain: name "vAPI Tasks Escrow", version "2", the clone as verifier. */
const CONSENT_DOMAIN = { name: "vAPI Tasks Escrow", version: "2" } as const;
export const v2GuardFailure = (message: string): never => {
  throw new TaskOperationError("v2_plan_mismatch", message);
};
const same = (a: unknown, b: unknown) =>
  typeof a === "string" &&
  typeof b === "string" &&
  isAddressEqual(address.parse(a), address.parse(b));
/** Canonical comparison form: checksummed addresses, lowercase words, decimal integers. */
const normalized = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(normalized)
    : value !== null && typeof value === "object"
      ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalized(item)]))
      : typeof value === "bigint" || typeof value === "number"
        ? String(value)
        : typeof value === "string" && /^0x[0-9a-fA-F]{40}$/u.test(value)
          ? getAddress(value)
          : typeof value === "string" && /^0x[0-9a-fA-F]{64}$/u.test(value)
            ? value.toLowerCase()
            : value;
const canon = (value: unknown) => canonicalJson(normalized(value) as never);
const digest = (value: unknown) => keccak256(toHex(canonicalJson(value)));
const seconds = (iso: string) => BigInt(Math.floor(Date.parse(iso) / 1000));
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
  /** A BountyEscrowV2 clone (task shape 1). */
  bounty: boolean;
  /** The clone ABI every participant step on this target decodes against. */
  abi: Abi;
  poster: Address;
  worker?: Address;
  total: bigint;
  feeBp: number;
  termsHash: Hex;
  /** Verified escrow terms: the registered clone's terms(), or accepted creation terms. */
  terms?: V2EscrowTerms;
  milestones: Array<{ amount: bigint; deadline: bigint; status: number }>;
  /** Exact factory prediction inputs (predictEscrow / predictBountyEscrow / predictPool). */
  creationArgs?: readonly unknown[];
};
/** Inputs a fresh clone freezes from the pinned factory, never from the hosted response. */
type CreationPolicy = { feeBp: number; minObjectionWindow: bigint };

function acceptedV2Total(view: GetOrderResponse): bigint {
  const terms = view.workOrder.terms;
  if (terms?.pool) return BigInt(terms.pool.budgetBaseUnits);
  const bounty = terms?.bounty;
  return bounty
    ? BigInt(bounty.winners) * BigInt(bounty.rewardPerWinnerBaseUnits)
    : z.object({ budget: z.object({ amountBaseUnits: uint }) }).parse(view.workOrder.market).budget
        .amountBaseUnits;
}

function acceptedV2Windows(
  options: TasksChainOptions,
  view: GetOrderResponse,
  pin: TasksV2Deployment,
  chainId: number,
) {
  // The declared wire terms expose the bounty choice window. The other windows
  // are unset in that contract, so only those use locally trusted defaults.
  const bounty = view.workOrder.terms?.bounty;
  return {
    offerTtl: BigInt(pin.offerTtlSeconds ?? 604800),
    reviewWindow: BigInt(
      getTrustedTasksDurations(chainId, options.trustedDurations).reviewWindowSeconds ??
        DEFAULT_ACCEPTANCE_WINDOW_SECONDS,
    ),
    // EscrowFactoryV2 task terms carry no choice window; only bounties judge a choice.
    choiceWindow: bounty
      ? BigInt(bounty.choiceWindowSeconds ?? pin.choiceWindowSeconds ?? 604800)
      : 0n,
  };
}

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
      budget: {
        ...market.budget,
        amountBaseUnits: acceptedV2Total(view).toString(),
        asset: `${market.budget.network}/erc20:${pin.usdc}`,
      },
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

/** The worker bond the accepted order declares (EscrowV2 accepts it only on a one-milestone task). */
function acceptedWorkerBondBp(view: GetOrderResponse) {
  const terms = z.object(taskTermsFields).parse(view.workOrder.terms);
  return terms.bounty ? 0 : (terms.workerBondBp ?? 0);
}

/**
 * The exact factory prediction inputs for the accepted order (vapi-app escrow-v2-terms.server.ts
 * v2TermsFromOrder / v2PoolInputFromOrder). Prediction inputs only: participant calldata always
 * comes from the API.
 */
function acceptedCreationArgs(
  options: TasksChainOptions,
  view: GetOrderResponse,
  pin: TasksV2Deployment,
  chainId: number,
  policy: CreationPolicy,
  onchainVerifier?: Address,
): readonly unknown[] {
  const order = view.workOrder;
  const terms = z.object(taskTermsFields).parse(order.terms);
  const poster = address.parse(order.clientAddress);
  const total = acceptedV2Total(view);
  const salt = keccak256(toHex(order.id));
  if (terms.shape === "pool") {
    const verifier = terms.pool?.verifier === "poster" ? poster : onchainVerifier;
    if (!terms.pool || !verifier)
      return v2GuardFailure("Pool funding requires a locally accepted poster verifier.");
    return [
      poster,
      BigInt(terms.pool.rewardPerClaimBaseUnits),
      total,
      seconds(z.object({ deadlineAt: z.string() }).parse(order.market).deadlineAt),
      acceptedV2TermsHash(view, pin, 0n),
      terms.pool.gate === "proven" ? 0 : 1,
      verifier,
      policy.feeBp,
      salt,
    ];
  }
  const windows = acceptedV2Windows(options, view, pin, chainId);
  const bounty = terms.bounty;
  const milestones = bounty
    ? []
    : terms.milestones?.map((m) => ({
        amount: BigInt(m.amountBaseUnits),
        deadline: seconds(m.deadlineAt),
        status: 0,
        deliveryHash: zeroHash,
      }));
  if (!milestones || (!bounty && !milestones.length))
    return v2GuardFailure("Accepted V2 milestones are unavailable.");
  return [
    {
      shape: bounty ? 1 : 0,
      poster,
      worker: zeroAddress,
      termsHash: acceptedV2TermsHash(view, pin, windows.reviewWindow),
      ...windows,
      bountyDeadline: bounty ? seconds(bounty.deadlineAt) : 0n,
      objectionWindow:
        windows.reviewWindow > policy.minObjectionWindow
          ? windows.reviewWindow
          : policy.minObjectionWindow,
      workerBondBp: acceptedWorkerBondBp(view),
      feeBp: policy.feeBp,
      winners: bounty?.winners ?? 0,
      rewardPerWinner: BigInt(bounty?.rewardPerWinnerBaseUnits ?? 0),
    },
    milestones,
    salt,
  ];
}

function verifyAcceptedCreation(
  options: TasksChainOptions,
  view: GetOrderResponse,
  pin: TasksV2Deployment,
  creationArgs: readonly unknown[],
  pool: boolean,
  chainId: number,
  policy: CreationPolicy,
  requirePosterVerifier = true,
) {
  const order = view.workOrder;
  const poster = address.parse(order.clientAddress);
  if (String(creationArgs.at(-1)).toLowerCase() !== keccak256(toHex(order.id)))
    return v2GuardFailure("Funding salt differs from the requested order.");
  if (pool) {
    const declared = order.terms?.pool;
    const verifier = z.string().parse(creationArgs[6]);
    if (
      !same(creationArgs[0], poster) ||
      !declared ||
      (requirePosterVerifier && declared.verifier !== "poster") ||
      (declared.verifier === "poster" && !same(verifier, poster)) ||
      canon(creationArgs) !==
        canon(acceptedCreationArgs(options, view, pin, chainId, policy, address.parse(verifier)))
    )
      return v2GuardFailure(
        "Pool funding requires the accepted reward, gate and locally accepted poster verifier.",
      );
    return;
  }
  const terms = escrowTermsSchema.parse(creationArgs[0]);
  if (!same(terms.poster, poster))
    return v2GuardFailure("The registered poster differs from the accepted order.");
  const expected = acceptedCreationArgs(options, view, pin, chainId, policy);
  const accepted = escrowTermsSchema.parse(expected[0]);
  if (
    terms.offerTtl !== accepted.offerTtl ||
    terms.reviewWindow !== accepted.reviewWindow ||
    terms.choiceWindow !== accepted.choiceWindow ||
    terms.objectionWindow !== accepted.objectionWindow
  )
    return v2GuardFailure(
      "V2 creation windows differ from accepted terms or their locally trusted defaults.",
    );
  if (terms.termsHash !== accepted.termsHash || terms.shape !== accepted.shape)
    return v2GuardFailure(
      "The registered target or funding calldata differs from accepted order terms.",
    );
  if (terms.workerBondBp !== accepted.workerBondBp)
    return v2GuardFailure("The escrow's worker bond differs from the accepted order terms.");
  if (canon(creationArgs) !== canon(expected))
    return v2GuardFailure("Funding milestone or bounty allocations differ from accepted terms.");
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
    case "approve-bond":
      // The awarded or intended worker approves its own bond; never the poster.
      permitted = !isPoster && (worker === undefined || worker === zeroAddress || isWorker);
      break;
    case "open-jury":
    case "draw-jury":
    case "rearm-draw":
    case "resolve":
    case "commit-vote":
    case "reveal-vote":
    case "claim-owed":
      // Permissionless on-chain: the resolver checks seats and the escrow pays only the caller's credit.
      permitted = true;
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

/** The factory's current creation fee and the task implementation's objection-window floor. */
async function creationPolicy(rpc: PublicClient, pin: TasksV2Deployment, pool: boolean) {
  const feeBp = feeBpSchema.parse(
    await v2Read(
      rpc,
      pool ? pin.bountyPoolFactoryV1 : pin.escrowFactoryV2,
      pool ? bountyPoolFactoryV1Abi : escrowFactoryV2Abi,
      "feeBp",
    ),
  );
  return { feeBp, minObjectionWindow: pool ? 0n : await minObjectionWindow(rpc, pin) };
}
async function minObjectionWindow(rpc: PublicClient, pin: TasksV2Deployment) {
  const implementation = address.parse(
    await v2Read(rpc, pin.escrowFactoryV2, escrowFactoryV2Abi, "implementation"),
  );
  return uint.parse(await v2Read(rpc, implementation, escrowV2Abi, "MIN_OBJECTION_WINDOW"));
}

/** The API supplies candidates; only local pins and trusted RPC reads establish trust. */
export async function verifyV2Target(
  options: TasksChainOptions,
  /** A hosted response, or only the hosted chain ID before any plan exists (ballot sealing). */
  current: TaskV2Prepared | { chainId: number },
  view: GetOrderResponse,
  action: TaskV2Action | TaskV2Consent,
  knownTarget?: Address,
): Promise<VerifiedV2Target> {
  const operation = taskV2OperationResponseSchema.safeParse(current);
  const intent = taskV2IntentSchema.safeParse(current);
  const chainId = operation.success
    ? operation.data.operation.plan.chainId
    : intent.success
      ? intent.data.typedData.domain.chainId
      : z.object({ chainId: z.number().int().positive() }).parse(current).chainId;
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
  const bounty = order.terms?.shape === "bounty";
  const factory = pool ? pin.bountyPoolFactoryV1 : pin.escrowFactoryV2;
  const factoryAbi = pool ? bountyPoolFactoryV1Abi : escrowFactoryV2Abi;
  const cloneAbi: Abi = pool ? bountyPoolV1Abi : bounty ? bountyEscrowV2Abi : escrowV2Abi;
  const predictName = pool ? "predictPool" : bounty ? "predictBountyEscrow" : "predictEscrow";
  const predict = async (args: readonly unknown[]) =>
    address.parse(await v2Read(rpc, factory, factoryAbi, predictName, args));
  const isRegistered = async (clone: Address) =>
    (await v2Read(rpc, factory, factoryAbi, pool ? "isPool" : "isEscrow", [clone])) === true;
  if (!same(await v2Read(rpc, pin.escrowFactoryV2, escrowFactoryV2Abi, "paymentToken"), pin.usdc))
    return v2GuardFailure("The pinned factory payment token differs from pinned USDC.");
  let candidate =
    knownTarget ??
    z.object({ escrow: address }).safeParse(order.v2State).data?.escrow ??
    (intent.success
      ? z.object({ escrow: address }).safeParse(intent.data).data?.escrow
      : undefined);
  let creationArgs: readonly unknown[] | undefined;
  let fresh: CreationPolicy | undefined;
  if (
    action.action === "fund" &&
    operation.success &&
    same(operation.data.operation.plan.to, factory)
  ) {
    const decoded = decodeFunctionData({
      abi: factoryAbi,
      data: operation.data.operation.plan.data,
    });
    const names = pool ? ["createPool"] : ["createEscrow", "createAndFundWithAuthorization"];
    if (!names.includes(decoded.functionName))
      return v2GuardFailure("Unexpected V2 factory funding selector.");
    fresh = await creationPolicy(rpc, pin, pool);
    const args = decoded.args ?? [];
    // createPool omits the fee snapshot that predictPool binds before the salt.
    creationArgs = pool ? [...args.slice(0, 7), fresh.feeBp, args[7]] : args.slice(0, 3);
    verifyAcceptedCreation(options, view, pin, creationArgs, pool, chainId, fresh);
    candidate = await predict(creationArgs);
  }
  if (
    action.action === "fund" &&
    operation.success &&
    operation.data.operation.plan.step === "v2-approve-usdc" &&
    (!candidate || !(await isRegistered(candidate)))
  ) {
    fresh = await creationPolicy(rpc, pin, pool);
    creationArgs = acceptedCreationArgs(options, view, pin, chainId, fresh);
    verifyAcceptedCreation(options, view, pin, creationArgs, pool, chainId, fresh);
    const predicted = await predict(creationArgs);
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
  if (!(await isRegistered(candidate))) {
    // The hosted signature intent has no frozen creation arguments: never sign
    // a redeemable authorization to its unverified predicted address.
    if (action.action !== "fund" || !operation.success || !creationArgs || !fresh)
      return v2GuardFailure("The V2 target is not registered by the locally pinned factory.");
    const expectedCreation = acceptedCreationArgs(options, view, pin, chainId, fresh);
    if (canon(creationArgs) !== canon(expectedCreation))
      return v2GuardFailure("Fresh funding inputs differ from locally accepted creation terms.");
    verifyActor(action, options.account.address, address.parse(order.clientAddress));
    const terms = pool ? undefined : escrowTermsSchema.parse(creationArgs[0]);
    return {
      chainId,
      pin,
      rpc,
      escrow: candidate,
      factory,
      pool,
      bounty,
      abi: cloneAbi,
      poster: address.parse(order.clientAddress),
      total: acceptedV2Total(view),
      feeBp: fresh.feeBp,
      termsHash: terms?.termsHash ?? hash.parse(creationArgs[4]),
      ...(terms ? { terms } : {}),
      milestones: [],
      creationArgs,
    };
  }
  const read = (name: string, args: readonly unknown[] = []) =>
    v2Read(rpc, candidate!, cloneAbi, name, args);
  if (!same(await read("FACTORY"), factory) || !same(await read("USDC"), pin.usdc))
    return v2GuardFailure("The V2 clone's factory or payment token differs from the local pins.");
  const salt = keccak256(toHex(order.id));
  const suppliedCreation = creationArgs;
  let poster: Address, total: bigint, feeBp: number, termsHash: Hex;
  let terms: V2EscrowTerms | undefined, verifier: Address | undefined;
  const milestones: VerifiedV2Target["milestones"] = [];
  if (pool) {
    poster = address.parse(await read("poster"));
    verifier = address.parse(await read("verifier"));
    total = uint.parse(await read("budget"));
    feeBp = feeBpSchema.parse(await read("feeBp"));
    termsHash = hash.parse(await read("termsHash"));
    creationArgs = [
      poster,
      uint.parse(await read("rewardPerClaim")),
      total,
      uint.parse(await read("deadline")),
      termsHash,
      small(1).parse(await read("gate")),
      verifier,
      feeBp,
      salt,
    ];
  } else {
    terms = escrowTermsSchema.parse(await read("terms"));
    poster = terms.poster;
    feeBp = terms.feeBp;
    termsHash = terms.termsHash;
    if ((terms.shape === 1) !== bounty)
      return v2GuardFailure("The registered V2 escrow shape differs from the accepted order.");
    total = uint.parse(await read("totalPrincipal"));
    if (!bounty) {
      const count = small(5)
        .pipe(z.number().min(1))
        .parse(await read("milestoneCount"));
      for (let i = 0; i < count; i++) {
        const m = milestoneSchema.parse(await read("milestone", [i]));
        milestones.push({ amount: m.amount, deadline: m.deadline, status: m.status });
      }
    }
    // Clones are created with no worker, pending milestones and empty delivery hashes.
    creationArgs = [
      { ...terms, worker: zeroAddress },
      milestones.map(({ amount, deadline }) => ({
        amount,
        deadline,
        status: 0,
        deliveryHash: zeroHash,
      })),
      salt,
    ];
  }
  if (
    !same(poster, order.clientAddress) ||
    (action.action === "fund" && !same(poster, options.account.address))
  )
    return v2GuardFailure("The registered V2 poster differs from the task or acting wallet.");
  if (action.action === "fund" && pool && order.terms?.pool?.verifier !== "poster")
    return v2GuardFailure("Pool funding requires a locally accepted poster verifier.");
  if (total !== acceptedV2Total(view))
    return v2GuardFailure(
      "The registered target or funding calldata differs from accepted order terms.",
    );
  verifyAcceptedCreation(
    options,
    view,
    pin,
    creationArgs,
    pool,
    chainId,
    { feeBp, minObjectionWindow: pool ? 0n : await minObjectionWindow(rpc, pin) },
    action.action === "fund",
  );
  if (suppliedCreation && canon(suppliedCreation) !== canon(creationArgs))
    return v2GuardFailure("Funding inputs differ from the registered escrow's frozen terms.");
  if (!same(await predict(creationArgs), candidate))
    return v2GuardFailure(
      "The V2 target differs from the pinned factory's prediction for the requested order.",
    );
  const worker = terms && !bounty ? terms.worker : undefined;
  verifyActor(action, options.account.address, poster, worker, verifier);
  return {
    chainId,
    pin,
    rpc,
    escrow: candidate,
    factory,
    pool,
    bounty,
    abi: cloneAbi,
    poster,
    total,
    feeBp,
    termsHash,
    ...(terms ? { terms } : {}),
    milestones,
    creationArgs,
    ...(worker ? { worker } : {}),
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
    // The hosted authorization starts at 0 and expires within the hour; only its end is bounded.
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
      message.validBefore > block.timestamp + 3600n
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
      target.pool ||
      target.bounty ||
      typed.primaryType !== primary ||
      canonicalJson(typed.types) !== canonicalJson({ [primary]: consentTypes[primary] }) ||
      typed.domain.name !== CONSENT_DOMAIN.name ||
      typed.domain.version !== CONSENT_DOMAIN.version ||
      !same(typed.domain.verifyingContract, target.escrow)
    )
      return v2GuardFailure("Consent domain or schema differs from the verified escrow.");
    const m = typed.message;
    if (
      !same(m.escrow, target.escrow) ||
      !same(m.worker ?? m.signer, signer) ||
      String(m.termsHash).toLowerCase() !== target.termsHash ||
      uint.parse(m.expiry) <= block.timestamp ||
      uint.parse(m.expiry) > block.timestamp + 3600n ||
      uint.parse(m.nonce) !==
        uint.parse(await v2Read(target.rpc, target.escrow, escrowV2Abi, "consentNonces", [signer]))
    )
      return v2GuardFailure("Consent signer, escrow, terms, nonce or expiry mismatch.");
    if (
      action.action === "split-consent" &&
      (String(m.milestone) !== String(action.i) || String(m.toWorker) !== action.toWorker)
    )
      return v2GuardFailure("Split consent differs from the requested index or amount.");
  }
}

export const V2_RESOLVER_ACTIONS = [
  "open-jury",
  "draw-jury",
  "rearm-draw",
  "resolve",
  "commit-vote",
  "reveal-vote",
] as const;
export type TaskV2ResolverAction = Extract<
  TaskV2Action,
  { action: (typeof V2_RESOLVER_ACTIONS)[number] }
>;
export function isV2ResolverAction(
  action: TaskV2Action | TaskV2Consent,
): action is TaskV2ResolverAction {
  return (V2_RESOLVER_ACTIONS as readonly string[]).includes(action.action);
}

/**
 * The resolver trust chain: DISPUTE_RESOLVER() is an immutable on the clone that
 * verifyV2Target proved against the pinned factory. A local resolver pin must agree.
 */
export async function verifiedV2Resolver(target: VerifiedV2Target) {
  if (target.pool || target.bounty)
    return v2GuardFailure("Jury steps apply only to a verified task escrow.");
  const resolver = address.parse(
    await v2Read(target.rpc, target.escrow, escrowV2Abi, "DISPUTE_RESOLVER"),
  );
  if (
    resolver === zeroAddress ||
    (target.pin.disputeResolverV3 && !same(resolver, target.pin.disputeResolverV3))
  )
    return v2GuardFailure("The verified escrow's dispute resolver differs from the local pin.");
  return resolver;
}

/**
 * The agreed worker bond, exactly as EscrowV2.award collects it: the verified clone's
 * totalPrincipal() × its terms().workerBondBp / 10,000. The on-chain rate must equal the
 * accepted order terms; a hosted rate is never used.
 */
export function acceptedV2WorkerBond(target: VerifiedV2Target, view: GetOrderResponse) {
  const bp = target.terms?.workerBondBp;
  if (target.pool || target.bounty || bp === undefined || target.milestones.length !== 1)
    return v2GuardFailure("The accepted task terms carry no worker bond.");
  if (bp !== acceptedWorkerBondBp(view))
    return v2GuardFailure("The escrow's worker bond differs from the accepted order terms.");
  if (bp === 0) return v2GuardFailure("The accepted task terms carry no worker bond.");
  return (target.total * BigInt(bp)) / 10_000n;
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
  const authorizationArgs = fundingAuthorization
    ? [
        fundingAuthorization.message.from,
        fundingAuthorization.message.validAfter,
        fundingAuthorization.message.validBefore,
        fundingAuthorization.message.nonce,
        fundingAuthorization.signature,
      ]
    : undefined;
  if (plan.step === "v2-approve-usdc") {
    if (
      !["fund", "raise-dispute", "counter-evidence", "approve-bond"].includes(action.action) ||
      !same(plan.to, target.pin.usdc)
    )
      return v2GuardFailure("Unexpected USDC approval step or destination.");
    const decoded = decodeFunctionData({ abi: approvalAbi, data: plan.data });
    // Funding, dispute fees and the worker bond all approve the verified clone.
    if (!same(decoded.args[0], target.escrow) || decoded.args[1] !== pays)
      return v2GuardFailure("USDC approval spender or amount mismatch.");
    return;
  }
  if (action.action === "fund" && same(plan.to, target.factory)) {
    const decoded = decodeFunctionData({
      abi: target.pool ? bountyPoolFactoryV1Abi : escrowFactoryV2Abi,
      data: plan.data,
    });
    const args = decoded.args ?? [];
    const creation = target.creationArgs;
    if (!creation)
      return v2GuardFailure("Factory funding calldata differs from verified creation terms.");
    const matches = target.pool
      ? plan.step === "v2-create-pool" &&
        decoded.functionName === "createPool" &&
        canon(args) === canon([...creation.slice(0, 7), creation[8]])
      : plan.step === "v2-create-escrow"
        ? decoded.functionName === "createEscrow" && canon(args) === canon(creation)
        : plan.step === "v2-fund" &&
          decoded.functionName === "createAndFundWithAuthorization" &&
          canon(args.slice(0, 3)) === canon(creation);
    if (!matches)
      return v2GuardFailure("Factory funding calldata differs from verified creation terms.");
    if (decoded.functionName === "createAndFundWithAuthorization") {
      if (!authorizationArgs || canon(args.slice(3)) !== canon(authorizationArgs))
        return v2GuardFailure(
          "Factory funding authorization differs from the locally signed payload.",
        );
    }
    return;
  }
  if (action.action === "approve-bond")
    return v2GuardFailure("A worker bond approval must be a USDC approval step.");
  const bind = (
    decoded: { functionName: string; args?: readonly unknown[] },
    names: string[],
    expected: readonly unknown[],
  ) => {
    if (!names.includes(decoded.functionName) || canon(decoded.args ?? []) !== canon(expected))
      v2GuardFailure("V2 calldata selector or arguments differ from the user's action.");
  };
  if (isV2ResolverAction(action)) {
    const resolver = await verifiedV2Resolver(target);
    if (!same(plan.to, resolver) || plan.step !== `v2-${action.action}`)
      return v2GuardFailure(
        "Jury plan step or destination differs from the verified escrow's dispute resolver.",
      );
    const decoded = decodeFunctionData({ abi: disputeResolverV3Abi, data: plan.data });
    const at = [target.escrow, action.i] as const;
    switch (action.action) {
      case "open-jury":
        // A registry larger than one snapshot batch continues the same open step.
        return bind(decoded, ["openJury", "continueJury"], at);
      case "draw-jury":
        return bind(decoded, ["drawJury"], at);
      case "rearm-draw":
        return bind(decoded, ["rearmDraw"], at);
      case "resolve":
        return bind(decoded, ["resolve"], at);
      case "commit-vote":
        return bind(decoded, ["commitVote"], [...at, action.commitment]);
      case "reveal-vote":
        return bind(
          decoded,
          ["revealVote"],
          [...at, action.outcome, BigInt(action.toWorker), action.salt],
        );
    }
  }
  if (!same(plan.to, target.escrow) || plan.step !== `v2-${action.action}`)
    return v2GuardFailure("V2 step or destination differs from the requested verified target.");
  if (action.action === "claim-owed") {
    if (target.pool) return v2GuardFailure("Owed credits are claimed from a task escrow.");
    // plan.from is bound to the operation's expected actor, which the executor binds to the wallet.
    return bind(
      decodeFunctionData({ abi: target.abi, data: plan.data }),
      ["claimOwed"],
      [getAddress(action.to ?? plan.from)],
    );
  }
  const decoded = decodeFunctionData({ abi: target.abi, data: plan.data });
  const args = decoded.args ?? [];
  const taskOnly = () => {
    if (target.pool || target.bounty)
      v2GuardFailure("This V2 action applies only to a verified task escrow.");
  };
  let name: string, expected: readonly unknown[];
  switch (action.action) {
    case "fund":
      // Every shape funds its own clone after creation, by approval or by authorization.
      name = authorizationArgs ? "fundWithAuthorization" : "fund";
      expected = authorizationArgs ?? [];
      break;
    case "submit":
      taskOnly();
      name = "submitMilestone";
      expected = [action.i, digest(action.proof)];
      break;
    case "approve":
      taskOnly();
      name = "approveMilestone";
      expected = [action.i];
      break;
    case "reject":
      taskOnly();
      name = "rejectMilestone";
      expected = [action.i, digest(action.reason)];
      break;
    case "finalize":
      taskOnly();
      name = "finalizeMilestone";
      expected = [action.i];
      break;
    case "cancel-offer":
      if (target.pool) return v2GuardFailure("Unknown participant action or selector.");
      name = "cancelOffer";
      expected = [];
      break;
    case "cancel-remainder":
      taskOnly();
      name = "cancelRemainder";
      expected = [];
      break;
    case "expire":
      if (!target.bounty) return v2GuardFailure("Only a verified bounty escrow expires.");
      name = "expireBounty";
      expected = [];
      break;
    case "refund":
      taskOnly();
      name = "refundRemainder";
      expected = [];
      break;
    case "raise-dispute":
      taskOnly();
      name = "raiseDispute";
      expected = [action.i, digest(action.evidence)];
      break;
    case "counter-evidence":
      taskOnly();
      name = "submitCounterEvidence";
      expected = [action.i, digest(action.evidence)];
      break;
    case "resolve-unmatched":
      taskOnly();
      name = "resolveUnmatched";
      expected = [action.i];
      break;
    case "award-bounty": {
      if (!target.bounty) return v2GuardFailure("Only a verified bounty escrow awards winners.");
      // Each winner's submission hash is the one committed on-chain, never a hosted value.
      const hashes: Hex[] = [];
      for (const winner of action.winners) {
        const [submissionHash, , active] = z
          .tuple([hash, uint, z.boolean()])
          .parse(
            await v2Read(target.rpc, target.escrow, bountyEscrowV2Abi, "submissionCommitment", [
              getAddress(winner),
            ]),
          );
        if (!active) return v2GuardFailure("A named winner has no committed submission.");
        hashes.push(submissionHash);
      }
      name = "awardBounty";
      expected = [action.winners.map((v) => getAddress(v)), hashes];
      break;
    }
    case "award":
      taskOnly();
      name = "award";
      // The worker consent bytes are opaque here; EscrowV2.award verifies them on-chain.
      expected = [getAddress(action.worker), args[1]];
      break;
    case "split":
      taskOnly();
      name = "resolveWithSplit";
      expected = [action.i, BigInt(action.toWorker), args[2]];
      break;
    case "pay-claim":
      if (!target.pool) return v2GuardFailure("Only a verified pool pays claims.");
      name = "payClaim";
      expected = [getAddress(action.claimant), hash.parse(args[1])];
      break;
    default:
      return v2GuardFailure("Unknown participant action or selector.");
  }
  if (decoded.functionName !== name || canon(args) !== canon(expected))
    return v2GuardFailure("V2 calldata selector or arguments differ from the user's action.");
}

const caseDataSchema = z.looseObject({
  state: small(255),
  raisedBy: address,
  evidenceDeadline: uint,
  commitDeadline: uint,
  revealDeadline: uint,
});
/** The current round of a milestone's dispute, read from the verified escrow's own resolver. */
export async function verifiedV2Case(target: VerifiedV2Target, i: number) {
  const resolver = await verifiedV2Resolver(target);
  return {
    resolver,
    data: caseDataSchema.parse(
      await v2Read(target.rpc, resolver, disputeResolverV3Abi, "caseData", [target.escrow, i]),
    ),
  };
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
  const onchain = (await verifiedV2Case(target, i)).data;
  if (
    onchain.state !== TASK_V2_CASE_STATE.Raised ||
    (await target.rpc.getBlock()).timestamp <= onchain.evidenceDeadline
  )
    return v2GuardFailure("The on-chain unmatched evidence window has not closed.");
  if (!same(onchain.raisedBy, data.raisedBy))
    return v2GuardFailure("The unmatched dispute opener differs from its verified chain case.");
  return { gross: milestone.amount, toWorker: same(data.raisedBy, target.worker) };
}
