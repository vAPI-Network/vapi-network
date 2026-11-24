import { getAddress, zeroAddress, type Address } from "viem";
import { TaskOperationError } from "./operation-support.js";

export type TasksV2Deployment = {
  escrowFactoryV2: Address;
  /** DisputeResolverV3 pin; jury plans must also match the verified clone's DISPUTE_RESOLVER(). */
  disputeResolverV3: Address;
  bountyPoolFactoryV1: Address;
  usdc: Address;
  usdcName: string;
  usdcVersion: string;
  offerTtlSeconds?: number;
  reviewWindowSeconds?: number;
  evidenceWindowSeconds?: number;
  choiceWindowSeconds?: number;
};
export type TasksV2DeploymentOverrides = Partial<Record<number, TasksV2Deployment>>;

/** Verified Tasks V2 deployment on Base mainnet (chain 8453), audited at tasks-v2-audit-3.
 * All SDK, CLI and MCP trust checks use this complete tuple. Other chains require
 * an explicit local override. See docs/tasks.md for the deployed contracts.
 */
export const TRUSTED_TASKS_V2_DEPLOYMENTS: Readonly<TasksV2DeploymentOverrides> = {
  8453: {
    escrowFactoryV2: getAddress("0x3586A4C92b55a83175D911aBA9B50329319E34BD"),
    disputeResolverV3: getAddress("0xEe36F3B19dcC38B6b5676B6cdcDd63a6d7Fbb435"),
    bountyPoolFactoryV1: getAddress("0xD03264c27AE3900834d6C5ba85cd15C56B21452f"),
    usdc: getAddress("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"),
    usdcName: "USD Coin",
    usdcVersion: "2",
    offerTtlSeconds: 604800,
    reviewWindowSeconds: 604800,
    evidenceWindowSeconds: 172800,
    choiceWindowSeconds: 604800,
  },
};

/** All overrides are local operator decisions, never hosted readiness fields. */
export function getTrustedTasksV2Deployment(
  chainId: number,
  options: {
    overrides?: TasksV2DeploymentOverrides;
    env?: NodeJS.ProcessEnv;
    notice?: (message: string) => void;
  } = {},
): TasksV2Deployment {
  const env = options.env ?? process.env;
  const names = [
    "ESCROW_FACTORY",
    "POOL_FACTORY",
    "USDC",
    "USDC_NAME",
    "USDC_VERSION",
    "DISPUTE_RESOLVER_V3",
  ] as const;
  const values = names.map((name) => env[`VAPI_TASKS_V2_${name}_${chainId}`]);
  const anyEnv =
    values.some((v) => v !== undefined) ||
    env[`VAPI_TASKS_V2_EVIDENCE_WINDOW_SECONDS_${chainId}`] !== undefined ||
    env[`VAPI_TASKS_V2_OFFER_TTL_SECONDS_${chainId}`] !== undefined ||
    env[`VAPI_TASKS_V2_REVIEW_WINDOW_SECONDS_${chainId}`] !== undefined ||
    env[`VAPI_TASKS_V2_CHOICE_WINDOW_SECONDS_${chainId}`] !== undefined;
  let configured = options.overrides?.[chainId];
  if (anyEnv && !configured) {
    if (values.some((v) => !v?.trim()))
      throw new TaskOperationError(
        "v2_trust_unavailable",
        "A V2 override requires both factories, the dispute resolver, USDC, its domain name and version for the same chain.",
      );
    configured = {
      escrowFactoryV2: values[0]! as Address,
      bountyPoolFactoryV1: values[1]! as Address,
      usdc: values[2]! as Address,
      usdcName: values[3]!,
      usdcVersion: values[4]!,
      disputeResolverV3: values[5]! as Address,
      ...(env[`VAPI_TASKS_V2_EVIDENCE_WINDOW_SECONDS_${chainId}`] !== undefined
        ? { evidenceWindowSeconds: Number(env[`VAPI_TASKS_V2_EVIDENCE_WINDOW_SECONDS_${chainId}`]) }
        : {}),
      ...(env[`VAPI_TASKS_V2_OFFER_TTL_SECONDS_${chainId}`] !== undefined
        ? { offerTtlSeconds: Number(env[`VAPI_TASKS_V2_OFFER_TTL_SECONDS_${chainId}`]) }
        : {}),
      ...(env[`VAPI_TASKS_V2_REVIEW_WINDOW_SECONDS_${chainId}`] !== undefined
        ? { reviewWindowSeconds: Number(env[`VAPI_TASKS_V2_REVIEW_WINDOW_SECONDS_${chainId}`]) }
        : {}),
      ...(env[`VAPI_TASKS_V2_CHOICE_WINDOW_SECONDS_${chainId}`] !== undefined
        ? { choiceWindowSeconds: Number(env[`VAPI_TASKS_V2_CHOICE_WINDOW_SECONDS_${chainId}`]) }
        : {}),
    };
  }
  const tuple = configured ?? TRUSTED_TASKS_V2_DEPLOYMENTS[chainId];
  if (!tuple)
    throw new TaskOperationError(
      "v2_trust_unavailable",
      `No locally pinned V2 deployment for chain ${chainId}. Configure an explicit VAPI_TASKS_V2_*_${chainId} override for that chain.`,
    );
  let normalized: TasksV2Deployment;
  try {
    normalized = {
      ...tuple,
      escrowFactoryV2: getAddress(tuple.escrowFactoryV2),
      disputeResolverV3: getAddress(tuple.disputeResolverV3),
      bountyPoolFactoryV1: getAddress(tuple.bountyPoolFactoryV1),
      usdc: getAddress(tuple.usdc),
    };
  } catch {
    throw new TaskOperationError(
      "v2_trust_unavailable",
      "The local V2 deployment override contains an invalid address.",
    );
  }
  if (
    [
      normalized.escrowFactoryV2,
      normalized.bountyPoolFactoryV1,
      normalized.disputeResolverV3,
      normalized.usdc,
    ].includes(zeroAddress) ||
    [
      tuple.offerTtlSeconds,
      tuple.reviewWindowSeconds,
      tuple.choiceWindowSeconds,
      tuple.evidenceWindowSeconds,
    ].some((value) => value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) ||
    !tuple.usdcName ||
    !tuple.usdcVersion
  )
    throw new TaskOperationError(
      "v2_trust_unavailable",
      "The local V2 deployment override is incomplete or contains a zero address.",
    );
  if (configured)
    (options.notice ?? console.error)(
      `Tasks V2 untrusted override for chain ${chainId}: escrow factory ${normalized.escrowFactoryV2}, pool factory ${normalized.bountyPoolFactoryV1}, dispute resolver ${normalized.disputeResolverV3}, USDC ${normalized.usdc}.`,
    );
  return normalized;
}
