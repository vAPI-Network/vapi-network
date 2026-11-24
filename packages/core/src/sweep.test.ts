import { afterEach, describe, expect, it, vi } from "vitest";
import { formatEther, parseTransaction, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import {
  calculateSweepAmount,
  getArcGasHeadroomAtomic,
  SweepGasError,
  sweepBack,
  sweepNativeEth,
  supportsNativeEthSweep,
  NATIVE_ETH_L1_FEE_FALLBACK_WEI,
} from "./sweep.js";
import { ARC_MAINNET_CAIP2, BASE_MAINNET_CAIP2, usesUsdcGas } from "./networks.js";

const SWEEP_ACCOUNT = privateKeyToAccount(
  "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
);
const SWEEP_DESTINATION = "0x2222222222222222222222222222222222222222";
const SWEEP_CONFIG = {
  discoveryUrl: "https://api.vapinetwork.ai",
  marketplaceDiscoveryUrl: "https://api.vapinetwork.ai",
  networks: {
    [BASE_MAINNET_CAIP2]: {
      rpcUrl: "https://rpc.example",
      usdc: "0x3600000000000000000000000000000000000000",
    },
    [ARC_MAINNET_CAIP2]: {
      rpcUrl: "https://rpc.example",
      usdc: "0x3600000000000000000000000000000000000000",
    },
    "eip155:1": {
      rpcUrl: "https://rpc.example",
      usdc: "0x3600000000000000000000000000000000000000",
    },
  },
  spendCaps: { perCallAtomic: "100000", perDayAtomic: "1000000" },
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("sweep amount math", () => {
  it("sweeps a full Base USDC balance when headroom is zero", () => {
    expect(calculateSweepAmount(2_500_000n, 0n)).toBe(2_500_000n);
  });

  it("leaves Arc's default 0.05 USDC gas headroom", () => {
    vi.stubEnv("VAPI_ARC_GAS_HEADROOM_USDC", "");
    expect(getArcGasHeadroomAtomic()).toBe(50_000n);
    expect(calculateSweepAmount(2_500_000n, 50_000n)).toBe(2_450_000n);
    expect(calculateSweepAmount(40_000n, 50_000n)).toBe(0n);
    expect(usesUsdcGas(ARC_MAINNET_CAIP2)).toBe(true);
    expect(calculateSweepAmount(2_500_000n, usesUsdcGas(ARC_MAINNET_CAIP2) ? 50_000n : 0n)).toBe(
      2_450_000n,
    );
  });

  it("parses configured Arc gas headroom as atomic USDC", () => {
    vi.stubEnv("VAPI_ARC_GAS_HEADROOM_USDC", "1.234567");
    expect(getArcGasHeadroomAtomic()).toBe(1_234_567n);
  });

  it("preserves the Arc gas headroom validation error", () => {
    vi.stubEnv("VAPI_ARC_GAS_HEADROOM_USDC", "1.2345678");
    expect(() => getArcGasHeadroomAtomic()).toThrow(
      "VAPI_ARC_GAS_HEADROOM_USDC must be a non-negative USDC amount with at most 6 decimals.",
    );
  });
});

describe("sweep gas errors", () => {
  it.each(["gas required exceeds allowance (0)", "insufficient funds for gas * price + value"])(
    "turns %j into a friendly Base gas error",
    async (message) => {
      const error = await sweepBack({
        account: SWEEP_ACCOUNT,
        config: SWEEP_CONFIG,
        network: BASE_MAINNET_CAIP2,
        destination: SWEEP_DESTINATION,
        fetchImpl: noGasSweepRpc(message, "0x2105"),
      }).catch((caught: unknown) => caught);

      const friendly =
        `This wallet has no ETH on Base to pay the gas for the sweep. Send a little ETH on Base ` +
        `(a few cents) to ${SWEEP_ACCOUNT.address}, then run vapi sweep again.`;
      expect(error).toBeInstanceOf(SweepGasError);
      expect(error).toMatchObject({ address: SWEEP_ACCOUNT.address, message: friendly });
      expect((error as SweepGasError).cause).toBeDefined();
    },
  );

  it("keeps Arc's insufficient-funds error as a normal error", async () => {
    const error = await sweepBack({
      account: SWEEP_ACCOUNT,
      config: SWEEP_CONFIG,
      network: ARC_MAINNET_CAIP2,
      destination: SWEEP_DESTINATION,
      fetchImpl: noGasSweepRpc("insufficient funds for gas * price + value", "0x13b2"),
    }).catch((caught: unknown) => caught);

    expect(error).not.toBeInstanceOf(SweepGasError);
  });

  it("does not call a non-Base EVM gas error a Base gas error", async () => {
    const error = await sweepBack({
      account: SWEEP_ACCOUNT,
      config: SWEEP_CONFIG,
      network: "eip155:1",
      destination: SWEEP_DESTINATION,
      fetchImpl: noGasSweepRpc("insufficient funds for gas * price + value", "0x1"),
    }).catch((caught: unknown) => caught);

    expect(error).not.toBeInstanceOf(SweepGasError);
  });
});

function noGasSweepRpc(message: string, chainId: string) {
  return vi.fn<typeof fetch>(async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as { id: number; method: string };
    if (request.method === "eth_estimateGas" || request.method === "eth_sendRawTransaction") {
      return Response.json({
        jsonrpc: "2.0",
        id: request.id,
        error: { code: -32000, message },
      });
    }
    const result =
      request.method === "eth_call"
        ? `0x${(1_000_000).toString(16).padStart(64, "0")}`
        : request.method === "eth_chainId"
          ? chainId
          : "0x0";
    return Response.json({ jsonrpc: "2.0", id: request.id, result });
  });
}

describe("native ETH sweep", () => {
  const balance = 1_000_000_000_000_000n;
  const l1Fee = 1_000_000_000n;
  // viem estimates maxFeePerGas as ceil(baseFee * 1.2) + priorityFee.
  const maxFee = 120n + 10n;
  const fee = ((maxFee * 21_000n + l1Fee) * 120n) / 100n;

  function rpc(
    options: {
      balance?: bigint;
      oracleFails?: boolean;
      gasFails?: boolean;
      code?: string;
      reverted?: boolean;
      gasForValue?: (value: bigint, call: number) => bigint;
    } = {},
  ) {
    const sent: Hex[] = [];
    const estimatedValues: bigint[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as {
        id: number;
        method: string;
        params: Hex[];
      };
      let result: unknown;
      switch (request.method) {
        case "eth_chainId":
          result = "0x2105";
          break;
        case "eth_getBalance":
          result = `0x${(options.balance ?? balance).toString(16)}`;
          break;
        case "eth_estimateGas": {
          const { value } = request.params[0] as unknown as { value: Hex };
          estimatedValues.push(BigInt(value));
          if (options.gasFails)
            return Response.json({
              jsonrpc: "2.0",
              id: request.id,
              error: { code: -32000, message: "estimation failed" },
            });
          result = `0x${(options.gasForValue?.(BigInt(value), estimatedValues.length) ?? 21_000n).toString(16)}`;
          break;
        }
        case "eth_getCode":
          result = options.code ?? "0x";
          break;
        case "eth_maxPriorityFeePerGas":
          result = "0xa";
          break;
        case "eth_getBlockByNumber":
          result = {
            number: "0x1",
            hash: `0x${"11".repeat(32)}`,
            baseFeePerGas: "0x64",
            transactions: [],
          };
          break;
        case "eth_call":
          if (options.oracleFails)
            return Response.json({
              jsonrpc: "2.0",
              id: request.id,
              error: { code: -32000, message: "oracle unavailable" },
            });
          expect(request.params[0]).toMatchObject({
            to: expect.stringMatching(/^0x420000000000000000000000000000000000000f$/i),
          });
          result = `0x${l1Fee.toString(16).padStart(64, "0")}`;
          break;
        case "eth_getTransactionCount":
          result = "0x0";
          break;
        case "eth_sendRawTransaction":
          sent.push(request.params[0]!);
          result = `0x${"22".repeat(32)}`;
          break;
        case "eth_getTransactionReceipt":
          result = {
            transactionHash: `0x${"22".repeat(32)}`,
            blockHash: `0x${"11".repeat(32)}`,
            blockNumber: "0x1",
            transactionIndex: "0x0",
            from: SWEEP_ACCOUNT.address,
            to: SWEEP_DESTINATION,
            cumulativeGasUsed: "0x5208",
            gasUsed: "0x5208",
            effectiveGasPrice: "0x82",
            logs: [],
            logsBloom: `0x${"00".repeat(256)}`,
            status: options.reverted ? "0x0" : "0x1",
            type: "0x2",
            contractAddress: null,
          };
          break;
        case "eth_blockNumber":
          result = "0x1";
          break;
        default:
          throw new Error(`Unexpected RPC: ${request.method}`);
      }
      return Response.json({ jsonrpc: "2.0", id: request.id, result });
    });
    return { fetchImpl, sent, estimatedValues };
  }
  const args = {
    account: SWEEP_ACCOUNT,
    config: SWEEP_CONFIG,
    network: BASE_MAINNET_CAIP2,
    destination: SWEEP_DESTINATION,
  };

  it("sends balance minus both fees and pins the signed gas and fees", async () => {
    const node = rpc();
    const result = await sweepNativeEth({ ...args, fetchImpl: node.fetchImpl });
    expect(result.amountAtomic).toBe((balance - fee).toString());
    expect(node.sent).toHaveLength(1);
    expect(parseTransaction(node.sent[0]!)).toMatchObject({
      to: SWEEP_DESTINATION,
      value: balance - fee,
      gas: 21_000n,
      maxFeePerGas: maxFee,
      maxPriorityFeePerGas: 10n,
    });
  });
  it("recalculates the reserve and validates the actual value for a contract", async () => {
    const node = rpc({ code: "0x1234", gasForValue: (value) => (value > 1n ? 80_000n : 21_000n) });
    const result = await sweepNativeEth({ ...args, fetchImpl: node.fetchImpl });
    const expectedAmount = balance - ((maxFee * 80_000n + l1Fee) * 120n) / 100n;
    expect(result.amountAtomic).toBe(expectedAmount.toString());
    expect(node.estimatedValues).toEqual([1n, balance - fee, expectedAmount]);
    expect(parseTransaction(node.sent[0]!)).toMatchObject({
      value: expectedAmount,
      gas: 80_000n,
      maxFeePerGas: maxFee,
      maxPriorityFeePerGas: 10n,
    });
  });

  it("does not sign when estimation of the actual contract deposit fails", async () => {
    const node = rpc({
      code: "0x1234",
      gasForValue: (value) => {
        if (value > 1n) throw new Error("deposit rejected");
        return 21_000n;
      },
    });
    await expect(sweepNativeEth({ ...args, fetchImpl: node.fetchImpl })).rejects.toThrow(
      "deposit rejected",
    );
    expect(node.sent).toEqual([]);
  });

  it("fails closed when contract gas estimates keep increasing", async () => {
    const node = rpc({ code: "0x1234", gasForValue: (_value, call) => BigInt(call) * 21_000n });
    await expect(sweepNativeEth({ ...args, fetchImpl: node.fetchImpl })).rejects.toThrow(
      "Could not safely estimate gas",
    );
    expect(node.estimatedValues).toHaveLength(6);
    expect(node.sent).toEqual([]);
  });

  it.each(["eip155:1", "eip155:137", "eip155:56", "invalid", "solana:mainnet"])(
    "does not treat %s as Base ETH",
    (network) => {
      expect(supportsNativeEthSweep(network)).toBe(false);
    },
  );

  it("allows Base mainnet and Sepolia only", () => {
    expect(supportsNativeEthSweep(BASE_MAINNET_CAIP2)).toBe(true);
    expect(supportsNativeEthSweep("eip155:84532")).toBe(true);
  });

  it("rejects a configured non-Base EVM chain before RPC access", async () => {
    const node = rpc();
    await expect(
      sweepNativeEth({ ...args, network: "eip155:1", fetchImpl: node.fetchImpl }),
    ).rejects.toThrow("Native ETH sweeps are supported only on Base mainnet and Base Sepolia.");
    expect(node.fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects a balance too small to cover the fee without signing", async () => {
    const node = rpc({ balance: 100n });
    await expect(sweepNativeEth({ ...args, fetchImpl: node.fetchImpl })).rejects.toThrow(
      `The ETH balance on Base mainnet (${formatEther(100n)} ETH) is too small to cover the Base mainnet network fee.`,
    );
    expect(node.sent).toEqual([]);
  });
  it("rejects Arc before making an RPC request", async () => {
    const node = rpc();
    await expect(
      sweepNativeEth({ ...args, network: ARC_MAINNET_CAIP2, fetchImpl: node.fetchImpl }),
    ).rejects.toThrow("Arc has no native ETH; use vapi sweep --asset usdc.");
    expect(node.fetchImpl).not.toHaveBeenCalled();
    expect(supportsNativeEthSweep(ARC_MAINNET_CAIP2)).toBe(false);
  });
  it("reserves the fallback plus margin when the L1 oracle fails", async () => {
    const node = rpc({ oracleFails: true });
    const result = await sweepNativeEth({ ...args, fetchImpl: node.fetchImpl });
    expect(result.amountAtomic).toBe(
      (balance - ((maxFee * 21_000n + NATIVE_ETH_L1_FEE_FALLBACK_WEI) * 120n) / 100n).toString(),
    );
  });
  it("falls back to 21000 gas only for an EOA", async () => {
    const node = rpc({ gasFails: true });
    expect((await sweepNativeEth({ ...args, fetchImpl: node.fetchImpl })).amountAtomic).toBe(
      (balance - fee).toString(),
    );
    const contract = rpc({ gasFails: true, code: "0x1234" });
    await expect(sweepNativeEth({ ...args, fetchImpl: contract.fetchImpl })).rejects.toThrow(
      "estimation failed",
    );
    expect(contract.sent).toEqual([]);
  });
  it("reports a reverted receipt", async () => {
    const node = rpc({ reverted: true });
    await expect(sweepNativeEth({ ...args, fetchImpl: node.fetchImpl })).rejects.toThrow(
      "reverted",
    );
  });
});
