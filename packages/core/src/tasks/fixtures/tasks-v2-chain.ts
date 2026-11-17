// SPDX-License-Identifier: Apache-2.0
// An RPC stand-in that answers every read through the copied vapi-app contract artifact
// (v2-abi.generated.ts): a call the current contracts do not expose, or arguments that do not
// encode against them, throws, and every result is round-tripped through the artifact's
// output encoding so it decodes exactly as a live node would return it.
import {
  decodeFunctionResult,
  encodeFunctionData,
  encodeFunctionResult,
  getAddress,
  keccak256,
  parseAbi,
  slice,
  type Abi,
  type Address,
  type Hex,
} from "viem";

export type ArtifactContract = {
  abi: Abi;
  /** Results by function name; a function receives the decoded call arguments. */
  values: Record<string, unknown | ((args: readonly unknown[]) => unknown)>;
};

/** The pinned USDC is an external token, not a Tasks artifact. */
export const usdcTokenAbi = parseAbi([
  "function name() view returns (string)",
  "function version() view returns (string)",
]);

/** Deterministic stand-in for CREATE2: a hash of the exact prediction calldata. */
export function predictedAddress(
  abi: Abi,
  functionName: string,
  args: readonly unknown[],
): Address {
  return getAddress(slice(keccak256(encodeFunctionData({ abi, functionName, args })), 12));
}

export function createArtifactRpc(input: {
  chainId: number;
  now: bigint;
  contracts: Record<string, ArtifactContract>;
}) {
  const contracts = new Map(
    Object.entries(input.contracts).map(([key, value]) => [key.toLowerCase(), value]),
  );
  const reads: Array<{ address: string; functionName: string }> = [];
  return {
    reads,
    getChainId: async () => input.chainId,
    getBlock: async () => ({ timestamp: input.now }),
    readContract: async (call: {
      address: Address;
      functionName: string;
      args?: readonly unknown[];
    }) => {
      reads.push({ address: call.address, functionName: call.functionName });
      const contract = contracts.get(call.address.toLowerCase());
      if (!contract) throw new Error(`No artifact for ${call.address}`);
      const data: Hex = encodeFunctionData({
        abi: contract.abi,
        functionName: call.functionName,
        args: call.args ?? [],
      });
      if (!(call.functionName in contract.values))
        throw new Error(`No fixture value for ${call.functionName} (${data.slice(0, 10)})`);
      const value = contract.values[call.functionName];
      const result = typeof value === "function" ? value(call.args ?? []) : value;
      return decodeFunctionResult({
        abi: contract.abi,
        functionName: call.functionName,
        data: encodeFunctionResult({
          abi: contract.abi,
          functionName: call.functionName,
          result: result as never,
        }),
      });
    },
  };
}
