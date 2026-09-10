import { constants } from "node:fs";
import { copyFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { getAddress } from "viem";
import { z } from "zod";

import { ARC_TESTNET_CAIP2, BASE_MAINNET_CAIP2, NETWORKS, parseEip155ChainId } from "./networks.js";

export const DEFAULT_DISCOVERY_URL = "https://console.vapinetwork.ai/api/network/services";
export const DEFAULT_MARKETPLACE_DISCOVERY_URL =
  "https://console.vapinetwork.ai/api/marketplace/discovery";

export const DEFAULT_SPEND_CAPS = {
  perCallAtomic: "100000",
  perDayAtomic: "1000000",
} as const;

export type VapiPaths = {
  directory: string;
  config: string;
  keystore: string;
  receipts: string;
  ledger: string;
};

/** @deprecated The public name is now vAPI; retained for source compatibility. */
export type AgentCashPaths = VapiPaths;

const atomicString = z.string().regex(/^\d+$/, "Expected non-negative atomic units.");
export const spendCapsSchema = z.object({
  perCallAtomic: atomicString,
  perDayAtomic: atomicString,
});
export const configSchema = z.object({
  discoveryUrl: z.url(),
  marketplaceDiscoveryUrl: z.url().default(DEFAULT_MARKETPLACE_DISCOVERY_URL),
  allowPrivateNetwork: z.boolean().default(false).optional(),
  networks: z.record(
    z.string().refine(
      (network) => {
        try {
          parseEip155ChainId(network);
          return true;
        } catch {
          return false;
        }
      },
      { message: "Expected an eip155:<chainId> network identifier." },
    ),
    z.object({
      rpcUrl: z.string(),
      usdc: z.string().transform((value) => getAddress(value)),
      eip712Domain: z
        .object({
          name: z.string().trim().min(1).max(64),
          version: z.string().trim().min(1).max(32),
        })
        .optional(),
    }),
  ),
  spendCaps: spendCapsSchema,
});

export type SpendCaps = z.infer<typeof spendCapsSchema>;
export type VapiConfig = z.infer<typeof configSchema>;
/** @deprecated Use VapiConfig. */
export type AgentCashConfig = VapiConfig;

export function isNetworkConfigured(networks: VapiConfig["networks"], network: string): boolean {
  return Boolean(networks[network]?.rpcUrl.trim());
}

export function getVapiPaths(
  directory = process.env.VAPI_HOME?.trim() || join(homedir(), ".vapi"),
): VapiPaths {
  return {
    directory,
    config: join(directory, "config.json"),
    keystore: join(directory, "keystore.json"),
    receipts: join(directory, "receipts.jsonl"),
    ledger: join(directory, "spend-ledger.json"),
  };
}

/** @deprecated Use getVapiPaths. */
export const getAgentCashPaths = getVapiPaths;

export type MigrationOptions = {
  targetDirectory?: string;
  legacyDirectory?: string;
  notice?: (message: string) => void;
};

/**
 * Copies legacy files into the new config home without overwriting or deleting
 * either side. Returns the copied destination paths.
 */
export async function migrateLegacyVapiHome(options: MigrationOptions = {}): Promise<string[]> {
  const target = getVapiPaths(options.targetDirectory);
  const legacyDirectory = options.legacyDirectory ?? join(homedir(), ".vapi", "agent-cash");
  if (legacyDirectory === target.directory || !(await pathExists(legacyDirectory))) return [];

  await mkdir(target.directory, { recursive: true, mode: 0o700 });
  const copied: string[] = [];
  for (const filename of [
    "config.json",
    "keystore.json",
    "receipts.jsonl",
    "spend-ledger.json",
  ] as const) {
    const source = join(legacyDirectory, filename);
    const destination = join(target.directory, filename);
    try {
      await copyFile(source, destination, constants.COPYFILE_EXCL);
      copied.push(destination);
    } catch (error) {
      if (isMissingFile(error) || isAlreadyExists(error)) continue;
      throw error;
    }
  }
  if (copied.length > 0) {
    const message = `Migrated legacy vAPI wallet files from ${legacyDirectory} to ${target.directory}; originals were kept.`;
    (options.notice ?? ((value) => process.stderr.write(`${value}\n`)))(message);
  }
  return copied;
}

export function getDefaultConfig(source: NodeJS.ProcessEnv = process.env): VapiConfig {
  const networks: VapiConfig["networks"] = {
    [BASE_MAINNET_CAIP2]: {
      rpcUrl: source.BASE_RPC_URL?.trim() || NETWORKS[BASE_MAINNET_CAIP2].publicRpcUrl,
      usdc: NETWORKS[BASE_MAINNET_CAIP2].usdc,
    },
  };
  const arcRpcUrl = source.ARC_TESTNET_RPC_URL?.trim();
  if (arcRpcUrl) {
    networks[ARC_TESTNET_CAIP2] = {
      rpcUrl: arcRpcUrl,
      usdc: NETWORKS[ARC_TESTNET_CAIP2].usdc,
    };
  }
  return {
    discoveryUrl: source.VAPI_DISCOVERY_URL?.trim() || DEFAULT_DISCOVERY_URL,
    marketplaceDiscoveryUrl:
      source.VAPI_MARKETPLACE_DISCOVERY_URL?.trim() || DEFAULT_MARKETPLACE_DISCOVERY_URL,
    allowPrivateNetwork: false,
    networks,
    spendCaps: { ...DEFAULT_SPEND_CAPS },
  };
}

export async function loadConfig(
  path = getVapiPaths().config,
  source: NodeJS.ProcessEnv = process.env,
): Promise<VapiConfig> {
  if (!process.env.VAPI_HOME?.trim() && path === getVapiPaths(join(homedir(), ".vapi")).config) {
    await migrateLegacyVapiHome({ targetDirectory: join(homedir(), ".vapi") });
  }
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isMissingFile(error)) return getDefaultConfig(source);
    throw error;
  }

  const config: VapiConfig = configSchema.parse(JSON.parse(raw));
  const baseRpcUrl = source.BASE_RPC_URL?.trim();
  const arcRpcUrl = source.ARC_TESTNET_RPC_URL?.trim();
  const discoveryUrl = source.VAPI_DISCOVERY_URL?.trim();
  const marketplaceDiscoveryUrl = source.VAPI_MARKETPLACE_DISCOVERY_URL?.trim();
  if (config.networks[BASE_MAINNET_CAIP2] && baseRpcUrl) {
    config.networks[BASE_MAINNET_CAIP2].rpcUrl = baseRpcUrl;
  }
  if (arcRpcUrl) {
    config.networks[ARC_TESTNET_CAIP2] = {
      rpcUrl: arcRpcUrl,
      usdc: config.networks[ARC_TESTNET_CAIP2]?.usdc ?? NETWORKS[ARC_TESTNET_CAIP2].usdc,
    };
  }
  if (discoveryUrl) config.discoveryUrl = discoveryUrl;
  if (marketplaceDiscoveryUrl) config.marketplaceDiscoveryUrl = marketplaceDiscoveryUrl;
  for (const [network, configured] of Object.entries(config.networks)) {
    configured.rpcUrl = configured.rpcUrl.trim();
    if (!configured.rpcUrl) delete config.networks[network];
  }
  return config;
}

export async function writeDefaultConfig(
  path = getVapiPaths().config,
  source: NodeJS.ProcessEnv = process.env,
): Promise<VapiConfig> {
  if (!process.env.VAPI_HOME?.trim() && path === getVapiPaths(join(homedir(), ".vapi")).config) {
    const copied = await migrateLegacyVapiHome({ targetDirectory: join(homedir(), ".vapi") });
    if (copied.includes(path)) return await loadConfig(path, source);
  }
  const config = getDefaultConfig(source);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  await rename(temporaryPath, path);
  return config;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isMissingFile(error)) return false;
    throw error;
  }
}

export function isMissingFile(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isAlreadyExists(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}
