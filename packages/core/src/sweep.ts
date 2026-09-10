import { createWalletClient, getAddress } from "viem";

import type { AgentCashConfig } from "./config.js";
import type { VapiPaymentAccount } from "./keystore.js";
import {
  ARC_TESTNET_CAIP2,
  configuredNetworkFor,
  createChain,
  createNetworkHttpTransport,
  createNetworkPublicClient,
  DEFAULT_ARC_GAS_HEADROOM_ATOMIC,
  getNetworkDefinition,
  isSolanaNetwork,
  requireRpcUrl,
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
    address: getAddress(args.configured.usdc),
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
  const headroomAtomic =
    args.network === ARC_TESTNET_CAIP2
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
  const transaction = await walletClient.writeContract({
    address: getAddress(configured.usdc),
    abi: ERC20_ABI,
    functionName: "transfer",
    args: [getAddress(args.destination), amountAtomic],
  });
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
