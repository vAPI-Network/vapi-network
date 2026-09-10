import { formatUnits, getAddress, type Address } from "viem";

import type { VapiConfig } from "./config.js";
import type { LookupFn } from "./net-guard.js";
import {
  BASE_MAINNET_CAIP2,
  createNetworkPublicClient,
  formatUsdc,
  getNetworkDefinition,
  type ConfiguredNetwork,
} from "./networks.js";
import { readUsdcBalance } from "./sweep.js";

export type AccountBalance = {
  atomic: string;
  formatted: string;
};

export type GasTokenBalance = AccountBalance & {
  symbol: string;
};

export type AccountInfo = {
  caip2: string;
  name: string;
  address: string;
  usdcBalance: AccountBalance | null;
  gasTokenBalance?: GasTokenBalance | null;
  depositUrl?: string;
  depositInstructions?: string;
  error?: string;
};

export type AccountNetworkAdapterContext = {
  caip2: string;
  configured: VapiConfig["networks"][string];
  defaultAddress: string;
  allowPrivateNetwork?: boolean;
  fetchImpl?: typeof fetch;
  lookup?: LookupFn;
};

export type AccountNetworkAdapter = (
  context: AccountNetworkAdapterContext,
) => Promise<Omit<AccountInfo, "caip2">>;

export type ListAccountsArgs = {
  address: string;
  config: VapiConfig;
  fetchImpl?: typeof fetch;
  lookup?: LookupFn;
  /** Namespace adapters, keyed by the CAIP-2 namespace (for example `solana`). */
  adapters?: Readonly<Record<string, AccountNetworkAdapter>>;
};

const EIP155_NAMESPACE = "eip155";

/** List deposit destinations and balances without needing access to a private key. */
export async function listAccounts(args: ListAccountsArgs): Promise<AccountInfo[]> {
  return await Promise.all(
    Object.entries(args.config.networks).map(async ([caip2, configured]) => {
      const namespace = caip2Namespace(caip2);
      const adapter =
        args.adapters?.[namespace] ??
        (namespace === EIP155_NAMESPACE ? eip155AccountAdapter : undefined);
      if (!adapter) {
        return failedAccount(
          caip2,
          configured,
          args.address,
          `No account adapter is available for CAIP-2 namespace ${namespace}.`,
        );
      }

      try {
        return {
          caip2,
          ...(await adapter({
            caip2,
            configured,
            defaultAddress: args.address,
            allowPrivateNetwork: args.config.allowPrivateNetwork,
            ...(args.fetchImpl ? { fetchImpl: args.fetchImpl } : {}),
            ...(args.lookup ? { lookup: args.lookup } : {}),
          })),
        };
      } catch (error) {
        return failedAccount(caip2, configured, args.address, conciseError(error));
      }
    }),
  );
}

async function eip155AccountAdapter(
  context: AccountNetworkAdapterContext,
): Promise<Omit<AccountInfo, "caip2">> {
  const configured = context.configured as ConfiguredNetwork;
  const address = getAddress(context.defaultAddress) as Address;
  const definition = getNetworkDefinition(context.caip2);
  const usdcAtomic = await readUsdcBalance({
    network: context.caip2,
    configured,
    address,
    allowPrivateNetwork: context.allowPrivateNetwork,
    ...(context.fetchImpl ? { fetchImpl: context.fetchImpl } : {}),
    ...(context.lookup ? { lookup: context.lookup } : {}),
  });
  const usdcBalance = atomicBalance(usdcAtomic, formatUsdc);

  let gasTokenBalance: GasTokenBalance;
  if (definition.gasToken === "USDC") {
    gasTokenBalance = { symbol: "USDC", ...usdcBalance };
  } else {
    const client = createNetworkPublicClient(context.caip2, configured, {
      allowPrivateNetwork: context.allowPrivateNetwork,
      ...(context.fetchImpl ? { fetch: context.fetchImpl } : {}),
      ...(context.lookup ? { lookup: context.lookup } : {}),
    });
    const gasAtomic = await client.getBalance({ address });
    gasTokenBalance = {
      symbol: definition.gasToken,
      ...atomicBalance(gasAtomic, (amount) => formatUnits(amount, 18)),
    };
  }

  return {
    name: definition.name,
    address,
    usdcBalance,
    gasTokenBalance,
    ...depositDetails(context.caip2, configured, address),
  };
}

function failedAccount(
  caip2: string,
  configured: VapiConfig["networks"][string],
  address: string,
  error: string,
): AccountInfo {
  const name = caip2.startsWith(`${EIP155_NAMESPACE}:`) ? getNetworkDefinition(caip2).name : caip2;
  return {
    caip2,
    name,
    address,
    usdcBalance: null,
    gasTokenBalance: null,
    ...depositDetails(caip2, configured, address),
    error,
  };
}

function atomicBalance(amount: bigint, formatter: (amount: bigint) => string): AccountBalance {
  return { atomic: amount.toString(), formatted: formatter(amount) };
}

function depositDetails(
  caip2: string,
  configured: VapiConfig["networks"][string],
  address: string,
): Pick<AccountInfo, "depositUrl" | "depositInstructions"> {
  const depositUrl = configuredString(configured, "depositUrl");
  const configuredInstructions = configuredString(configured, "depositInstructions");
  const depositInstructions =
    configuredInstructions ??
    (caip2 === BASE_MAINNET_CAIP2 ? `Send USDC on Base to ${address}.` : undefined);
  return {
    ...(depositUrl ? { depositUrl } : {}),
    ...(depositInstructions ? { depositInstructions } : {}),
  };
}

function configuredString(
  configured: VapiConfig["networks"][string],
  key: "depositUrl" | "depositInstructions",
): string | undefined {
  const value = (configured as unknown as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function caip2Namespace(caip2: string): string {
  return caip2.split(":", 1)[0] ?? caip2;
}

function conciseError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const summary = message.split("\n", 1)[0] ?? message;
  const details = /^Details: (.+)$/m.exec(message)?.[1];
  return details ? `${summary} ${details}` : summary;
}
