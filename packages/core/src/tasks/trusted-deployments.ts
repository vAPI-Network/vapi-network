import { getAddress, type Address } from "viem";

export const TRUSTED_TASKS_DEPLOYMENTS: Readonly<
  Partial<Record<number, { readonly escrowFactory: Address }>>
> = {
  // Source: ../app-main/contracts/deployments/base-sepolia.json
  84532: { escrowFactory: getAddress("0x6Ba83621eb386B3E093032096251cA504F6ee033") },
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
