import { getAddress, type Address } from "viem";

export type TasksDurationDefaults = {
  readonly workDurationSeconds?: number;
  readonly reviewWindowSeconds?: number;
};
export type TasksDurationOverrides = Record<string, TasksDurationDefaults>;
export const TRUSTED_TASKS_DEPLOYMENTS: Readonly<
  Partial<Record<number, { readonly escrowFactory: Address } & TasksDurationDefaults>>
> = {
  // Source: ../app-main/contracts/deployments/base-sepolia.json
  84532: {
    escrowFactory: getAddress("0x6Ba83621eb386B3E093032096251cA504F6ee033"),
    workDurationSeconds: 604800,
    reviewWindowSeconds: 604800,
  },
};

/** Resolves a locally trusted Tasks escrow factory, with explicit config taking precedence. */
export function getTrustedTasksFactory(
  chainId: number,
  overrides: Record<string, string> = {},
): Address | undefined {
  const configured = overrides[String(chainId)];
  return configured === undefined
    ? TRUSTED_TASKS_DEPLOYMENTS[chainId]?.escrowFactory
    : getAddress(configured);
}

/** Defaults are pinned locally or explicitly configured, never read from server readiness. */
export function getTrustedTasksDurations(
  chainId: number,
  overrides: TasksDurationOverrides = {},
): TasksDurationDefaults {
  const configured = overrides[String(chainId)];
  const result = {
    workDurationSeconds:
      configured?.workDurationSeconds ?? TRUSTED_TASKS_DEPLOYMENTS[chainId]?.workDurationSeconds,
    reviewWindowSeconds:
      configured?.reviewWindowSeconds ?? TRUSTED_TASKS_DEPLOYMENTS[chainId]?.reviewWindowSeconds,
  };
  for (const value of Object.values(result)) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0))
      throw new Error("Trusted task durations must be positive integer seconds.");
  }
  return result;
}
