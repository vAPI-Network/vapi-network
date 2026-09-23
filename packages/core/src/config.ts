import { constants } from "node:fs";
import { copyFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { getAddress } from "viem";
import { z } from "zod";

import {
  ARC_MAINNET_CAIP2,
  ARC_TESTNET_CAIP2,
  BASE_MAINNET_CAIP2,
  configuredNetworkFor,
  isSolanaNetwork,
  isSupportedPaymentNetwork,
  NETWORKS,
  SOLANA_MAINNET_CAIP2,
} from "./networks.js";

export const DEFAULT_REGISTRY_URL = "https://api.vapinetwork.ai";
export const DEFAULT_DISCOVERY_URL = `${DEFAULT_REGISTRY_URL}/api/call/services`;
export const DEFAULT_MARKETPLACE_DISCOVERY_URL = `${DEFAULT_REGISTRY_URL}/api/call/discovery`;
// The retired console host is no longer a usable fallback, so the defaults name
// the canonical registry. `registryRequest` de-duplicates endpoints, which keeps
// this entry from costing a second request.
export const DEFAULT_REGISTRY_FALLBACKS = [
  {
    discoveryUrl: DEFAULT_DISCOVERY_URL,
    marketplaceDiscoveryUrl: DEFAULT_MARKETPLACE_DISCOVERY_URL,
  },
] as const;

/**
 * The caps a wallet starts with. Since 0.3.0 the caps that are enforced belong
 * to the wallet entry in `wallets.json`, not to `config.json`: an agent wallet
 * can have a small daily cap while the owner's has a large one. `spendCaps`
 * stays in `config.json` so 0.2.x files keep parsing, and it is still the
 * fallback for a home that has no wallet registry yet — see
 * `spendCapsForWallet` in `wallet-store.ts`.
 */
export const DEFAULT_SPEND_CAPS = {
  perCallAtomic: "100000",
  perDayAtomic: "1000000",
} as const;

export type VapiPaths = {
  directory: string;
  config: string;
  keystore: string;
  receipts: string;
  searches: string;
  ledger: string;
};

/** @deprecated The public name is now vAPI; retained for source compatibility. */
export type AgentCashPaths = VapiPaths;

const atomicString = z.string().regex(/^\d+$/, "Expected non-negative atomic units.");
export const spendCapsSchema = z.object({
  perCallAtomic: atomicString,
  perDayAtomic: atomicString,
});
export const configSchema = z
  .object({
    discoveryUrl: z.url(),
    marketplaceDiscoveryUrl: z.url().default(DEFAULT_MARKETPLACE_DISCOVERY_URL),
    registryFallbacks: z
      .array(
        z.object({
          discoveryUrl: z.url(),
          marketplaceDiscoveryUrl: z.url(),
        }),
      )
      .optional(),
    allowPrivateNetwork: z.boolean().default(false).optional(),
    networks: z.record(
      z.string().refine((network) => isSupportedPaymentNetwork(network), {
        message: "Expected a supported eip155:<chainId> or Solana network identifier.",
      }),
      z.object({
        rpcUrl: z.string(),
        usdc: z.string().trim().min(1),
        depositUrl: z.url().optional(),
        depositInstructions: z.string().trim().min(1).max(500).optional(),
        eip712Domain: z
          .object({
            name: z.string().trim().min(1).max(64),
            version: z.string().trim().min(1).max(32),
          })
          .optional(),
      }),
    ),
    spendCaps: spendCapsSchema,
  })
  .superRefine((config, context) => {
    for (const [network, configured] of Object.entries(config.networks)) {
      if (isSolanaNetwork(network)) {
        if (configured.usdc !== NETWORKS[SOLANA_MAINNET_CAIP2].usdc) {
          context.addIssue({
            code: "custom",
            path: ["networks", network, "usdc"],
            message: "Expected canonical Solana mainnet USDC mint.",
          });
        }
        continue;
      }
      try {
        const usdc = getAddress(configured.usdc);
        if (
          (network === ARC_MAINNET_CAIP2 || network === ARC_TESTNET_CAIP2) &&
          usdc !== getAddress(NETWORKS[network].usdc)
        ) {
          context.addIssue({
            code: "custom",
            path: ["networks", network, "usdc"],
            message: "Expected the canonical Arc USDC predeploy.",
          });
        }
      } catch {
        context.addIssue({
          code: "custom",
          path: ["networks", network, "usdc"],
          message: "Expected a valid EVM USDC contract address.",
        });
      }
    }
  });

export type SpendCaps = z.infer<typeof spendCapsSchema>;
export type VapiConfig = z.infer<typeof configSchema>;
/** @deprecated Use VapiConfig. */
export type AgentCashConfig = VapiConfig;

export function isNetworkConfigured(networks: VapiConfig["networks"], network: string): boolean {
  return Boolean(configuredNetworkFor(networks, network)?.rpcUrl.trim());
}

export function getVapiPaths(
  directory = process.env.VAPI_HOME?.trim() || join(homedir(), ".vapi"),
): VapiPaths {
  return {
    directory,
    config: join(directory, "config.json"),
    keystore: join(directory, "keystore.json"),
    receipts: join(directory, "receipts.jsonl"),
    searches: join(directory, "searches.jsonl"),
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
    "searches.jsonl",
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

/**
 * Hosts and paths older installs wrote into `config.json`. The console hosts are
 * retired — `console-staging` no longer resolves at all, so every command failed
 * the outbound URL guard before it could reach the registry.
 */
const LEGACY_REGISTRY_HOSTS = new Map([
  ["console.vapinetwork.ai", "api.vapinetwork.ai"],
  ["console-staging.vapinetwork.ai", "api-staging.vapinetwork.ai"],
]);
const LEGACY_REGISTRY_PATHS = new Map([
  ["/api/network/services", "/api/call/services"],
  ["/api/marketplace/discovery", "/api/call/discovery"],
]);
const REGISTRY_DOMAIN = "vapinetwork.ai";

export type LegacyRegistryRewrite = {
  field: string;
  from: string;
  to: string;
};

/**
 * Rewrites one retired registry URL to its canonical form. Anything that is not
 * a legacy vAPI registry URL — including self-hosted registries on the old
 * paths — is returned byte for byte, so this is safe to run over any config.
 */
export function rewriteLegacyRegistryUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return value;
  }
  let rewritten = false;
  const host = LEGACY_REGISTRY_HOSTS.get(url.hostname.toLowerCase());
  if (host) {
    url.hostname = host;
    rewritten = true;
  }
  const hostname = url.hostname.toLowerCase();
  if (hostname === REGISTRY_DOMAIN || hostname.endsWith(`.${REGISTRY_DOMAIN}`)) {
    const path = LEGACY_REGISTRY_PATHS.get(url.pathname.replace(/\/+$/, ""));
    if (path) {
      url.pathname = path;
      rewritten = true;
    }
  }
  return rewritten ? url.href : value;
}

/**
 * Pure counterpart of {@link rewriteLegacyRegistryUrl} over a whole config. The
 * input is never mutated, and an untouched config is returned as-is.
 */
export function rewriteLegacyRegistryUrls(config: VapiConfig): {
  config: VapiConfig;
  changes: LegacyRegistryRewrite[];
} {
  const changes: LegacyRegistryRewrite[] = [];
  const rewrite = (field: string, from: string): string => {
    const to = rewriteLegacyRegistryUrl(from);
    if (to !== from) changes.push({ field, from, to });
    return to;
  };
  const next: VapiConfig = {
    ...config,
    discoveryUrl: rewrite("discoveryUrl", config.discoveryUrl),
    marketplaceDiscoveryUrl: rewrite("marketplaceDiscoveryUrl", config.marketplaceDiscoveryUrl),
    ...(config.registryFallbacks
      ? {
          registryFallbacks: config.registryFallbacks.map((fallback, index) => ({
            discoveryUrl: rewrite(
              `registryFallbacks[${index}].discoveryUrl`,
              fallback.discoveryUrl,
            ),
            marketplaceDiscoveryUrl: rewrite(
              `registryFallbacks[${index}].marketplaceDiscoveryUrl`,
              fallback.marketplaceDiscoveryUrl,
            ),
          })),
        }
      : {}),
  };
  return changes.length === 0 ? { config, changes } : { config: next, changes };
}

export function formatLegacyRegistryRewrites(changes: readonly LegacyRegistryRewrite[]): string {
  return [
    "Rewrote retired vAPI registry URLs in the local config:",
    ...changes.map((change) => `  ${change.field}: ${change.from} -> ${change.to}`),
  ].join("\n");
}

/**
 * Rewrites retired registry URLs in `config.json` on disk. Returns what changed
 * so the caller can report it; an absent or already-current file is a no-op.
 */
export async function migrateLegacyRegistryConfig(
  path = getVapiPaths().config,
): Promise<LegacyRegistryRewrite[]> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isMissingFile(error)) return [];
    throw error;
  }
  const { config, changes } = rewriteLegacyRegistryUrls(configSchema.parse(JSON.parse(raw)));
  if (changes.length === 0) return [];
  await writeConfigFile(path, config);
  return changes;
}

export type DefaultConfigOptions = {
  networks?: readonly string[];
};

export function getDefaultConfig(
  source: NodeJS.ProcessEnv = process.env,
  options: DefaultConfigOptions = {},
): VapiConfig {
  const registry = registryEndpoints(source.VAPI_REGISTRY_URL?.trim() || DEFAULT_REGISTRY_URL);
  const requested = new Set(options.networks ?? ["base"]);
  const networks: VapiConfig["networks"] = {};
  if (requested.has("base") || requested.has(BASE_MAINNET_CAIP2)) {
    networks[BASE_MAINNET_CAIP2] = {
      rpcUrl: source.BASE_RPC_URL?.trim() || NETWORKS[BASE_MAINNET_CAIP2].publicRpcUrl,
      usdc: NETWORKS[BASE_MAINNET_CAIP2].usdc,
    };
  }
  const arcMainnetRpcUrl = source.ARC_RPC_URL?.trim();
  if (arcMainnetRpcUrl || requested.has("arc") || requested.has(ARC_MAINNET_CAIP2)) {
    networks[ARC_MAINNET_CAIP2] = {
      rpcUrl: arcMainnetRpcUrl || NETWORKS[ARC_MAINNET_CAIP2].publicRpcUrl,
      usdc: NETWORKS[ARC_MAINNET_CAIP2].usdc,
    };
  }
  const arcTestnetRpcUrl = source.ARC_TESTNET_RPC_URL?.trim();
  if (arcTestnetRpcUrl || requested.has("arc-testnet") || requested.has(ARC_TESTNET_CAIP2)) {
    if (!arcTestnetRpcUrl) {
      throw new Error(
        "Arc testnet RPC is required. Set ARC_TESTNET_RPC_URL before enabling Arc testnet.",
      );
    }
    networks[ARC_TESTNET_CAIP2] = {
      rpcUrl: arcTestnetRpcUrl,
      usdc: NETWORKS[ARC_TESTNET_CAIP2].usdc,
    };
  }
  const solanaRpcUrl = source.SOLANA_RPC_URL?.trim();
  if (solanaRpcUrl || requested.has("solana") || requested.has(SOLANA_MAINNET_CAIP2)) {
    networks[SOLANA_MAINNET_CAIP2] = {
      rpcUrl: solanaRpcUrl || NETWORKS[SOLANA_MAINNET_CAIP2].publicRpcUrl,
      usdc: NETWORKS[SOLANA_MAINNET_CAIP2].usdc,
    };
  }
  return {
    discoveryUrl: source.VAPI_DISCOVERY_URL?.trim() || registry.discoveryUrl,
    marketplaceDiscoveryUrl:
      source.VAPI_MARKETPLACE_DISCOVERY_URL?.trim() || registry.marketplaceDiscoveryUrl,
    registryFallbacks: DEFAULT_REGISTRY_FALLBACKS.map((fallback) => ({ ...fallback })),
    allowPrivateNetwork: false,
    networks,
    spendCaps: { ...DEFAULT_SPEND_CAPS },
  };
}

export type LoadConfigOptions = {
  /** Sink for the one-line legacy-URL notice; omitted means stay silent. */
  notice?: (message: string) => void;
};

export async function loadConfig(
  path = getVapiPaths().config,
  source: NodeJS.ProcessEnv = process.env,
  options: LoadConfigOptions = {},
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

  const parsed: VapiConfig = configSchema.parse(JSON.parse(raw));
  parsed.registryFallbacks ??= DEFAULT_REGISTRY_FALLBACKS.map((fallback) => ({ ...fallback }));
  // Retired hosts are repaired in memory only; `vapi init` owns the file.
  const migrated = rewriteLegacyRegistryUrls(parsed);
  const config = migrated.config;
  if (migrated.changes.length > 0 && options.notice) {
    options.notice(
      `${formatLegacyRegistryRewrites(migrated.changes)}\nRun vapi init to write the new URLs to ${path}.`,
    );
  }
  const baseRpcUrl = source.BASE_RPC_URL?.trim();
  const arcMainnetRpcUrl = source.ARC_RPC_URL?.trim();
  const arcTestnetRpcUrl = source.ARC_TESTNET_RPC_URL?.trim();
  const solanaRpcUrl = source.SOLANA_RPC_URL?.trim();
  const discoveryUrl = source.VAPI_DISCOVERY_URL?.trim();
  const marketplaceDiscoveryUrl = source.VAPI_MARKETPLACE_DISCOVERY_URL?.trim();
  const registryUrl = source.VAPI_REGISTRY_URL?.trim();
  if (config.networks[BASE_MAINNET_CAIP2] && baseRpcUrl) {
    config.networks[BASE_MAINNET_CAIP2].rpcUrl = baseRpcUrl;
  }
  if (arcMainnetRpcUrl) {
    const existing = config.networks[ARC_MAINNET_CAIP2];
    config.networks[ARC_MAINNET_CAIP2] = {
      ...(existing ?? { usdc: NETWORKS[ARC_MAINNET_CAIP2].usdc }),
      rpcUrl: arcMainnetRpcUrl,
    };
  }
  if (arcTestnetRpcUrl) {
    const existing = config.networks[ARC_TESTNET_CAIP2];
    config.networks[ARC_TESTNET_CAIP2] = {
      ...(existing ?? { usdc: NETWORKS[ARC_TESTNET_CAIP2].usdc }),
      rpcUrl: arcTestnetRpcUrl,
    };
  }
  if (solanaRpcUrl) {
    config.networks[SOLANA_MAINNET_CAIP2] = {
      rpcUrl: solanaRpcUrl,
      usdc: config.networks[SOLANA_MAINNET_CAIP2]?.usdc ?? NETWORKS[SOLANA_MAINNET_CAIP2].usdc,
    };
  }
  if (registryUrl) {
    const registry = registryEndpoints(registryUrl);
    config.discoveryUrl = registry.discoveryUrl;
    config.marketplaceDiscoveryUrl = registry.marketplaceDiscoveryUrl;
  }
  if (discoveryUrl) config.discoveryUrl = discoveryUrl;
  if (marketplaceDiscoveryUrl) config.marketplaceDiscoveryUrl = marketplaceDiscoveryUrl;
  for (const [network, configured] of Object.entries(config.networks)) {
    configured.rpcUrl = configured.rpcUrl.trim();
    configured.usdc = configured.usdc.trim();
    if (isSolanaNetwork(network) && configured.usdc !== NETWORKS[SOLANA_MAINNET_CAIP2].usdc) {
      throw new Error(`Network ${network} must use canonical Solana mainnet USDC.`);
    }
    if (!configured.rpcUrl) delete config.networks[network];
  }
  return config;
}

function registryEndpoints(baseUrl: string): {
  discoveryUrl: string;
  marketplaceDiscoveryUrl: string;
} {
  const base = new URL(baseUrl);
  base.search = "";
  base.hash = "";
  const prefix = base.pathname === "/" ? "" : base.pathname.replace(/\/+$/, "");
  const discovery = new URL(base);
  discovery.pathname = `${prefix}/api/call/services`;
  const marketplace = new URL(base);
  marketplace.pathname = `${prefix}/api/call/discovery`;
  return { discoveryUrl: discovery.href, marketplaceDiscoveryUrl: marketplace.href };
}

export async function writeDefaultConfig(
  path = getVapiPaths().config,
  source: NodeJS.ProcessEnv = process.env,
  options: DefaultConfigOptions = {},
): Promise<VapiConfig> {
  if (!process.env.VAPI_HOME?.trim() && path === getVapiPaths(join(homedir(), ".vapi")).config) {
    const copied = await migrateLegacyVapiHome({ targetDirectory: join(homedir(), ".vapi") });
    if (copied.includes(path)) return await loadConfig(path, source);
  }
  const config = getDefaultConfig(source, options);
  await writeConfigFile(path, config);
  return config;
}

export async function enableDefaultNetwork(
  network: "solana" | "arc",
  path = getVapiPaths().config,
  source: NodeJS.ProcessEnv = process.env,
): Promise<VapiConfig> {
  const config = await loadConfig(path, source);
  if (network === "solana") {
    config.networks[SOLANA_MAINNET_CAIP2] = {
      rpcUrl: source.SOLANA_RPC_URL?.trim() || NETWORKS[SOLANA_MAINNET_CAIP2].publicRpcUrl,
      usdc: NETWORKS[SOLANA_MAINNET_CAIP2].usdc,
    };
  } else {
    const existing = config.networks[ARC_MAINNET_CAIP2];
    config.networks[ARC_MAINNET_CAIP2] = {
      ...(existing ?? { usdc: NETWORKS[ARC_MAINNET_CAIP2].usdc }),
      rpcUrl: source.ARC_RPC_URL?.trim() || NETWORKS[ARC_MAINNET_CAIP2].publicRpcUrl,
    };
  }
  await writeConfigFile(path, config);
  return config;
}

/**
 * Fields `config.json` keeps but the parsed config never carries. Today that
 * is `apiKey`, the registry key `vapi auth set-key` writes when a machine has
 * no OS secret store: the config schema drops it, because the parsed object
 * travels into the MCP server and a credential must not ride along. A rewrite
 * still has to keep it, or enabling a network would quietly sign a provider
 * out. `@vapi-network/core/api-key` owns reading and writing the value.
 */
const PRESERVED_CONFIG_FIELDS = ["apiKey"] as const;

async function readPreservedConfigFields(path: string): Promise<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
  const record = parsed as Record<string, unknown>;
  return Object.fromEntries(
    PRESERVED_CONFIG_FIELDS.filter((field) => record[field] !== undefined).map((field) => [
      field,
      record[field],
    ]),
  );
}

async function writeConfigFile(path: string, config: VapiConfig): Promise<void> {
  const preserved = await readPreservedConfigFields(path);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify({ ...config, ...preserved }, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  await rename(temporaryPath, path);
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
