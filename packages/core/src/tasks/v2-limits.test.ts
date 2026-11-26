import { describe, expect, it, vi } from "vitest";
import type { PublicClient } from "viem";

import { assertWithinTaskV2Limit, readTaskV2Limits } from "./v2-limits.js";
import { TRUSTED_TASKS_V2_DEPLOYMENTS } from "./v2-trust.js";

const BASE = TRUSTED_TASKS_V2_DEPLOYMENTS[8453]!;
/** The live values on Base mainnet on 2026-11-25: no fee, 5,000 USDC per task and per pool. */
function rpc(values: Record<string, unknown> = {}) {
  const readContract = vi.fn(async (call: { address: string; functionName: string }) => {
    const all: Record<string, unknown> = {
      feeBp: 0,
      maxEscrowAmount: 5_000_000_000n,
      maxPoolBudget: 5_000_000_000n,
      ...values,
    };
    const value = all[call.functionName];
    if (value instanceof Error) throw value;
    return value;
  });
  return {
    readContract,
    client: { getChainId: async () => 8453, readContract } as unknown as PublicClient,
  };
}

describe("readTaskV2Limits", () => {
  it("reads the fee and the task limit from the pinned escrow factory", async () => {
    const { client, readContract } = rpc();
    expect(
      await readTaskV2Limits({ chainId: 8453, shape: "task", rpcFor: () => client, env: {} }),
    ).toEqual({ chainId: 8453, shape: "task", feeBp: 0, maxBaseUnits: 5_000_000_000n });
    expect(readContract.mock.calls.map(([call]) => [call.address, call.functionName])).toEqual([
      [BASE.escrowFactoryV2, "feeBp"],
      [BASE.escrowFactoryV2, "maxEscrowAmount"],
    ]);
  });
  it("reads a pool's fee and limit from the pinned pool factory", async () => {
    const { client, readContract } = rpc({ feeBp: 250n, maxPoolBudget: 1_000_000_000n });
    expect(
      await readTaskV2Limits({ chainId: 8453, shape: "pool", rpcFor: () => client, env: {} }),
    ).toEqual({ chainId: 8453, shape: "pool", feeBp: 250, maxBaseUnits: 1_000_000_000n });
    expect(readContract.mock.calls.map(([call]) => [call.address, call.functionName])).toEqual([
      [BASE.bountyPoolFactoryV1, "feeBp"],
      [BASE.bountyPoolFactoryV1, "maxPoolBudget"],
    ]);
  });
  it.each([
    ["a chain without a local pin", { chainId: 84532 }, {}],
    ["a failed read", {}, { maxEscrowAmount: new Error("rate limited") }],
    ["a fee above the contract maximum", {}, { feeBp: 2001 }],
    ["a zero limit", {}, { maxEscrowAmount: 0n }],
  ])("falls back to undefined on %s", async (_name, input, values) => {
    const { client } = rpc(values);
    expect(
      await readTaskV2Limits({
        chainId: 8453,
        shape: "task",
        rpcFor: () => client,
        env: {},
        ...input,
      }),
    ).toBeUndefined();
  });
  it("falls back when the RPC answers for another chain or does not answer in time", async () => {
    const { client } = rpc();
    const other = { ...client, getChainId: async () => 1 } as unknown as PublicClient;
    expect(
      await readTaskV2Limits({ chainId: 8453, shape: "task", rpcFor: () => other, env: {} }),
    ).toBeUndefined();
    const silent = { getChainId: () => new Promise<number>(() => {}) } as unknown as PublicClient;
    expect(
      await readTaskV2Limits({
        chainId: 8453,
        shape: "task",
        rpcFor: () => silent,
        env: {},
        timeoutMs: 5,
      }),
    ).toBeUndefined();
    expect(
      await readTaskV2Limits({
        chainId: 8453,
        shape: "task",
        rpcFor: () => {
          throw new Error("no RPC");
        },
        env: {},
      }),
    ).toBeUndefined();
  });
});

describe("assertWithinTaskV2Limit", () => {
  const limits = { chainId: 8453, shape: "task" as const, feeBp: 0, maxBaseUnits: 5_000_000_000n };
  it("accepts the limit itself and refuses one base unit more in plain words", () => {
    expect(() => assertWithinTaskV2Limit(5_000_000_000n, limits)).not.toThrow();
    expect(() => assertWithinTaskV2Limit(6_000_000_000n, limits)).toThrow(
      "The total of $6000.00 USDC is above the live limit of $5000.00 USDC per task on Base. Nothing was signed and no money moved.",
    );
  });
});
