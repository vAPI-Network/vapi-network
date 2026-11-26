// SPDX-License-Identifier: Apache-2.0
// The live creation fee and size limit of Tasks V2, read from the locally pinned factories.
// The hosted readiness document describes these only where the API chooses to, and on a
// V2-only deployment it has answered `feeBp: null`. The pinned factory is the contract that
// applies both values, so it is the source wherever a local pin and an RPC client exist.
import type { PublicClient } from "viem";
import { z } from "zod";

import { formatBaseUnitsUsd } from "./money.js";
import { taskNetworkName } from "./availability.js";
import { TaskInputError } from "./operation-support.js";
import { bountyPoolFactoryV1Abi, escrowFactoryV2Abi } from "./v2-abi.js";
import { getTrustedTasksV2Deployment, type TasksV2DeploymentOverrides } from "./v2-trust.js";

export type TaskV2Shape = "task" | "bounty" | "pool";
export type TaskV2Limits = {
  chainId: number;
  shape: TaskV2Shape;
  /** The fee a new escrow or pool freezes at creation, in basis points. */
  feeBp: number;
  /** The largest total one task, bounty or pool may hold, in USDC base units. */
  maxBaseUnits: bigint;
};
export type TaskV2LimitsReader = (
  chainId: number,
  shape: TaskV2Shape,
) => Promise<TaskV2Limits | undefined>;

const feeBpSchema = z
  .union([z.number(), z.bigint()])
  .transform(Number)
  .pipe(z.number().int().min(0).max(2000));
const capSchema = z.bigint().positive();

/**
 * Reads `feeBp()` and `maxEscrowAmount()` (tasks and bounties) or `maxPoolBudget()` (pools)
 * from the pinned factory. Returns undefined when the chain has no local pin, the RPC answers
 * for another chain, a read fails or the time runs out: the caller then falls back to the
 * hosted fee, and the API and the contract still enforce the limit.
 */
export async function readTaskV2Limits(input: {
  chainId: number;
  shape: TaskV2Shape;
  rpcFor: (chainId: number) => PublicClient;
  trustedV2Deployments?: TasksV2DeploymentOverrides;
  env?: NodeJS.ProcessEnv;
  onV2UntrustedOverride?: (message: string) => void;
  timeoutMs?: number;
}): Promise<TaskV2Limits | undefined> {
  const read = async (): Promise<TaskV2Limits> => {
    const pin = getTrustedTasksV2Deployment(input.chainId, {
      ...(input.trustedV2Deployments ? { overrides: input.trustedV2Deployments } : {}),
      ...(input.env ? { env: input.env } : {}),
      // Display and pre-check only; the signing path prints the override notice.
      notice: input.onV2UntrustedOverride ?? (() => {}),
    });
    const rpc = input.rpcFor(input.chainId);
    if ((await rpc.getChainId()) !== input.chainId) throw new Error("RPC chain mismatch");
    const pool = input.shape === "pool";
    const address = pool ? pin.bountyPoolFactoryV1 : pin.escrowFactoryV2;
    const abi = pool ? bountyPoolFactoryV1Abi : escrowFactoryV2Abi;
    const [feeBp, cap] = await Promise.all([
      rpc.readContract({ address, abi, functionName: "feeBp" }),
      rpc.readContract({
        address,
        abi,
        functionName: pool ? "maxPoolBudget" : "maxEscrowAmount",
      } as Parameters<PublicClient["readContract"]>[0]),
    ]);
    return {
      chainId: input.chainId,
      shape: input.shape,
      feeBp: feeBpSchema.parse(feeBp),
      maxBaseUnits: capSchema.parse(cap),
    };
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      read(),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), input.timeoutMs ?? 5000);
      }),
    ]);
  } catch {
    return undefined;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Refuses a total above the live limit, in the words a poster can act on. */
export function assertWithinTaskV2Limit(
  totalBaseUnits: bigint,
  limits: TaskV2Limits,
  untouched = "Nothing was signed and no money moved.",
): void {
  if (totalBaseUnits <= limits.maxBaseUnits) return;
  throw new TaskInputError(
    `The total of $${formatBaseUnitsUsd(totalBaseUnits)} USDC is above the live limit of $${formatBaseUnitsUsd(limits.maxBaseUnits)} USDC per ${limits.shape} on ${taskNetworkName(limits.chainId)}. ${untouched}`,
  );
}
