import { createWalletClient, formatEther, getAddress, type Hash } from "viem";
import { estimateL1Fee } from "viem/op-stack";

import type { AgentCashConfig } from "./config.js";
import type { VapiPaymentAccount } from "./keystore.js";
import {
  BASE_MAINNET_CAIP2,
  configuredNetworkFor,
  createChain,
  createNetworkHttpTransport,
  createNetworkPublicClient,
  DEFAULT_ARC_GAS_HEADROOM_ATOMIC,
  getNetworkDefinition,
  isSolanaNetwork,
  requireRpcUrl,
  usesUsdcGas,
} from "./networks.js";
import type { LookupFn } from "./net-guard.js";
import { readSolanaUsdcBalance, sweepSolanaUsdc } from "./svm.js";
import { usdToAtomic } from "./x402.js";

export const ERC20_ABI = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "balance", type: "uint256" }],
  },
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "success", type: "bool" }],
  },
] as const;

export type SweepResult = {
  network: string;
  amountAtomic: string;
  transaction: string;
};

export class SweepGasError extends Error {
  readonly address: string;

  constructor(address: string, cause: unknown) {
    super(
      `This wallet has no ETH on Base to pay the gas for the sweep. Send a little ETH on Base (a few cents) to ${address}, then run vapi sweep again.`,
      { cause },
    );
    this.name = "SweepGasError";
    this.address = address;
  }
}

export function calculateSweepAmount(balanceAtomic: bigint, gasHeadroomAtomic: bigint): bigint {
  if (balanceAtomic < 0n || gasHeadroomAtomic < 0n) {
    throw new Error("Sweep balance and gas headroom cannot be negative.");
  }
  return balanceAtomic > gasHeadroomAtomic ? balanceAtomic - gasHeadroomAtomic : 0n;
}

export function getArcGasHeadroomAtomic(): bigint {
  const configured = process.env.VAPI_ARC_GAS_HEADROOM_USDC?.trim();
  if (!configured) {
    return DEFAULT_ARC_GAS_HEADROOM_ATOMIC;
  }
  try {
    return usdToAtomic(configured);
  } catch {
    throw new Error(
      "VAPI_ARC_GAS_HEADROOM_USDC must be a non-negative USDC amount with at most 6 decimals.",
    );
  }
}

export async function readUsdcBalance(args: {
  network: string;
  configured: AgentCashConfig["networks"][string];
  address: string;
  allowPrivateNetwork?: boolean;
  fetchImpl?: typeof fetch;
  lookup?: LookupFn;
}): Promise<bigint> {
  if (isSolanaNetwork(args.network)) {
    return await readSolanaUsdcBalance({
      network: args.network,
      configured: args.configured,
      address: args.address,
      allowPrivateNetwork: args.allowPrivateNetwork,
      ...(args.fetchImpl ? { fetchImpl: args.fetchImpl } : {}),
      ...(args.lookup ? { lookup: args.lookup } : {}),
    });
  }
  const client = createNetworkPublicClient(args.network, args.configured, {
    allowPrivateNetwork: args.allowPrivateNetwork,
    ...(args.fetchImpl ? { fetch: args.fetchImpl } : {}),
    ...(args.lookup ? { lookup: args.lookup } : {}),
  });
  return await client.readContract({
    address: getAddress(
      usesUsdcGas(args.network) ? getNetworkDefinition(args.network).usdc : args.configured.usdc,
    ),
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [getAddress(args.address)],
  });
}

export async function sweepBack(args: {
  account: VapiPaymentAccount;
  config: AgentCashConfig;
  network: string;
  destination: string;
  arcGasHeadroomAtomic?: bigint;
  fetchImpl?: typeof fetch;
  lookup?: LookupFn;
}): Promise<SweepResult> {
  const configured = configuredNetworkFor(args.config.networks, args.network);
  if (!configured) {
    throw new Error(`Network ${args.network} is not configured.`);
  }

  if (isSolanaNetwork(args.network)) {
    if (!args.account.solana) {
      throw new Error(
        "Solana is not enabled in this keystore. Run vapi accounts --enable solana first.",
      );
    }
    const result = await sweepSolanaUsdc({
      network: args.network,
      configured,
      signer: args.account.solana,
      destination: args.destination,
      allowPrivateNetwork: args.config.allowPrivateNetwork,
      ...(args.fetchImpl ? { fetchImpl: args.fetchImpl } : {}),
      ...(args.lookup ? { lookup: args.lookup } : {}),
    });
    return {
      network: args.network,
      amountAtomic: result.amountAtomic.toString(),
      transaction: result.transaction,
    };
  }

  const definition = getNetworkDefinition(args.network);
  const balanceAtomic = await readUsdcBalance({
    network: args.network,
    configured,
    address: args.account.address,
    allowPrivateNetwork: args.config.allowPrivateNetwork,
    ...(args.fetchImpl ? { fetchImpl: args.fetchImpl } : {}),
    ...(args.lookup ? { lookup: args.lookup } : {}),
  });
  const headroomAtomic = usesUsdcGas(args.network)
    ? (args.arcGasHeadroomAtomic ?? getArcGasHeadroomAtomic())
    : 0n;
  const amountAtomic = calculateSweepAmount(balanceAtomic, headroomAtomic);
  if (amountAtomic === 0n) {
    const note =
      definition.gasToken === "USDC"
        ? ` after retaining ${headroomAtomic} atomic USDC for Arc gas`
        : "";
    throw new Error(`No USDC is available to sweep on ${args.network}${note}.`);
  }

  const rpcUrl = requireRpcUrl(args.network, configured);
  const chain = createChain(args.network, rpcUrl);
  const walletClient = createWalletClient({
    account: args.account,
    chain,
    transport: createNetworkHttpTransport(rpcUrl, {
      allowPrivateNetwork: args.config.allowPrivateNetwork,
      ...(args.fetchImpl ? { fetch: args.fetchImpl } : {}),
      ...(args.lookup ? { lookup: args.lookup } : {}),
    }),
  });
  let transaction: Hash;
  try {
    transaction = await walletClient.writeContract({
      address: getAddress(
        usesUsdcGas(args.network) ? getNetworkDefinition(args.network).usdc : configured.usdc,
      ),
      abi: ERC20_ABI,
      functionName: "transfer",
      args: [getAddress(args.destination), amountAtomic],
    });
  } catch (error) {
    if (
      args.network === BASE_MAINNET_CAIP2 &&
      !usesUsdcGas(args.network) &&
      isInsufficientGasError(error)
    ) {
      throw new SweepGasError(args.account.address, error);
    }
    throw error;
  }
  const publicClient = createNetworkPublicClient(args.network, configured, {
    allowPrivateNetwork: args.config.allowPrivateNetwork,
    ...(args.fetchImpl ? { fetch: args.fetchImpl } : {}),
    ...(args.lookup ? { lookup: args.lookup } : {}),
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: transaction });
  if (receipt.status !== "success") {
    throw new Error(`Sweep transaction ${transaction} reverted on ${args.network}.`);
  }

  return {
    network: args.network,
    amountAtomic: amountAtomic.toString(),
    transaction,
  };
}

// Reserve 0.00001 ETH when the OP-stack gas price oracle is unavailable.
export const NATIVE_ETH_L1_FEE_FALLBACK_WEI = 10_000_000_000_000n;
export const NATIVE_ETH_FEE_MARGIN_PERCENT = 20n;

export function supportsNativeEthSweep(network: string): boolean {
  return network === BASE_MAINNET_CAIP2 || network === "eip155:84532";
}

export async function sweepNativeEth(args: {
  account: VapiPaymentAccount;
  config: AgentCashConfig;
  network: string;
  destination: string;
  fetchImpl?: typeof fetch;
  lookup?: LookupFn;
}): Promise<SweepResult> {
  const configured = configuredNetworkFor(args.config.networks, args.network);
  if (!configured) throw new Error(`Network ${args.network} is not configured.`);
  if (isSolanaNetwork(args.network)) {
    throw new Error("Solana has no native ETH; use vapi sweep --asset usdc.");
  }
  if (usesUsdcGas(args.network)) {
    throw new Error("Arc has no native ETH; use vapi sweep --asset usdc.");
  }
  if (!supportsNativeEthSweep(args.network)) {
    throw new Error("Native ETH sweeps are supported only on Base mainnet and Base Sepolia.");
  }
  const rpcUrl = requireRpcUrl(args.network, configured);
  const chain = createChain(args.network, rpcUrl);
  const options = {
    allowPrivateNetwork: args.config.allowPrivateNetwork,
    ...(args.fetchImpl ? { fetch: args.fetchImpl } : {}),
    ...(args.lookup ? { lookup: args.lookup } : {}),
  };
  const publicClient = createNetworkPublicClient(args.network, configured, options);
  const to = getAddress(args.destination);
  const balance = await publicClient.getBalance({ address: args.account.address });
  const estimateTransferGas = async (value: bigint): Promise<bigint> => {
    try {
      return await publicClient.estimateGas({ account: args.account.address, to, value });
    } catch (error) {
      const code = await publicClient.getCode({ address: to });
      if (code && code !== "0x") throw error;
      return 21_000n;
    }
  };
  let gas = await estimateTransferGas(1n);
  const { maxFeePerGas, maxPriorityFeePerGas } = await publicClient.estimateFeesPerGas();
  let l1Fee: bigint;
  try {
    l1Fee = await estimateL1Fee(publicClient, {
      chain,
      account: args.account.address,
      to,
      value: balance,
      gas,
      maxFeePerGas,
      maxPriorityFeePerGas,
      gasPriceOracleAddress: "0x420000000000000000000000000000000000000F",
    });
  } catch {
    l1Fee = NATIVE_ETH_L1_FEE_FALLBACK_WEI;
  }
  let amount = 0n;
  let validated = false;
  // A contract's gas use can depend on value. Recompute the withdrawal after
  // increasing the reserve, then validate that exact value before signing.
  // Keep gas monotonic and bound retries so unstable estimates fail closed.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const fee = ((maxFeePerGas * gas + l1Fee) * (100n + NATIVE_ETH_FEE_MARGIN_PERCENT)) / 100n;
    amount = balance - fee;
    if (amount <= 0n) {
      const name = getNetworkDefinition(args.network).name;
      throw new Error(
        `The ETH balance on ${name} (${formatEther(balance)} ETH) is too small to cover the ${name} network fee.`,
      );
    }
    const requiredGas = await estimateTransferGas(amount);
    if (requiredGas <= gas) {
      validated = true;
      break;
    }
    gas = requiredGas;
  }
  if (!validated) {
    throw new Error(
      "Could not safely estimate gas for the ETH withdrawal; no transaction was sent.",
    );
  }
  const walletClient = createWalletClient({
    account: args.account,
    chain,
    transport: createNetworkHttpTransport(rpcUrl, options),
  });
  const transaction = await walletClient.sendTransaction({
    to,
    value: amount,
    gas,
    maxFeePerGas,
    maxPriorityFeePerGas,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: transaction });
  if (receipt.status !== "success") {
    throw new Error(`Sweep transaction ${transaction} reverted on ${args.network}.`);
  }
  return { network: args.network, amountAtomic: amount.toString(), transaction };
}

function isInsufficientGasError(error: unknown): boolean {
  const seen = new Set<object>();
  let current: unknown = error;
  while (typeof current === "object" && current !== null) {
    if (seen.has(current)) return false;
    seen.add(current);
    const record = current as Record<string, unknown>;
    if (record.name === "InsufficientFundsError") return true;
    for (const field of ["message", "shortMessage", "details"]) {
      const value = record[field];
      if (typeof value !== "string") continue;
      const normalized = value.toLowerCase();
      if (
        normalized.includes("gas required exceeds allowance") ||
        normalized.includes("insufficient funds")
      ) {
        return true;
      }
    }
    current = record.cause;
  }
  return false;
}
