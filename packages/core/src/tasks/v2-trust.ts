import { getAddress, zeroAddress, type Address } from "viem";
import { TaskOperationError } from "./operation-support.js";

export type TasksV2Deployment = {
  escrowFactoryV2: Address;
  bountyPoolFactoryV1: Address;
  usdc: Address;
  usdcName: string;
  usdcVersion: string;
};
export type TasksV2DeploymentOverrides = Partial<Record<number, TasksV2Deployment>>;

/** Intentionally empty until the control room verifies the deployed V2 tuple. */
export const TRUSTED_TASKS_V2_DEPLOYMENTS: Readonly<TasksV2DeploymentOverrides> = {};

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
  const names = ["ESCROW_FACTORY", "POOL_FACTORY", "USDC", "USDC_NAME", "USDC_VERSION"] as const;
  const values = names.map((name) => env[`VAPI_TASKS_V2_${name}_${chainId}`]);
  const anyEnv = values.some((v) => v !== undefined);
  let configured = options.overrides?.[chainId];
  if (anyEnv && !configured) {
    if (values.some((v) => !v?.trim()))
      throw new TaskOperationError(
        "v2_trust_unavailable",
        "A V2 override requires both factories, USDC, its domain name and version for the same chain.",
      );
    configured = {
      escrowFactoryV2: values[0]! as Address,
      bountyPoolFactoryV1: values[1]! as Address,
      usdc: values[2]! as Address,
      usdcName: values[3]!,
      usdcVersion: values[4]!,
    };
  }
  const tuple = configured ?? TRUSTED_TASKS_V2_DEPLOYMENTS[chainId];
  if (!tuple)
    throw new TaskOperationError(
      "v2_trust_unavailable",
      `No locally pinned V2 deployment for chain ${chainId}. Configure an explicit VAPI_TASKS_V2_*_${chainId} staging override or wait for the verified deployment pins.`,
    );
  const normalized = {
    ...tuple,
    escrowFactoryV2: getAddress(tuple.escrowFactoryV2),
    bountyPoolFactoryV1: getAddress(tuple.bountyPoolFactoryV1),
    usdc: getAddress(tuple.usdc),
  };
  if (
    [normalized.escrowFactoryV2, normalized.bountyPoolFactoryV1, normalized.usdc].includes(
      zeroAddress,
    ) ||
    !tuple.usdcName ||
    !tuple.usdcVersion
  )
    throw new TaskOperationError(
      "v2_trust_unavailable",
      "The local V2 deployment override is incomplete or contains a zero address.",
    );
  if (configured)
    (options.notice ?? console.error)(
      `Tasks V2 untrusted override for chain ${chainId}: escrow factory ${normalized.escrowFactoryV2}, pool factory ${normalized.bountyPoolFactoryV1}, USDC ${normalized.usdc}.`,
    );
  return normalized;
}
