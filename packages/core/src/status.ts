import { join } from "node:path";

import { ceilingFloorApplies } from "./ceiling.js";
import type { AgentRouterUsage } from "./router-client.js";
import { listUnfinishedMovements, type MovementSummary } from "./movement.js";
import type { SecretStore } from "./secret-store.js";
import { formatUsdc } from "./networks.js";
import { unlockProtectedVault, VAULT_KEY_ACCOUNT } from "./vault-key.js";
import { openVault, readVaultFileUnlocked, VaultError } from "./vault.js";
import type { WalletName } from "./wallet-name.js";
import {
  formatCeilingUsd,
  type WalletCeilingCaps,
  type WalletInfo,
  type WalletStore,
} from "./wallet-store.js";

export type AccountLinkStatus = "active" | "paused" | "revoked" | "not_linked" | "unknown";
export type StatusAccount = {
  name: string;
  default: boolean;
  address: string;
  usdc?: string;
  routerTodayUsd?: string;
  routerAllowanceUsd?: string;
  caps: {
    perCallUsd: string;
    perDayUsd: string;
    ceilingUsd: string;
    ceilingFloorUsd?: string;
  };
  link: AccountLinkStatus;
};
export type StatusReport = {
  version: string;
  home: string;
  registry: string;
  owner?: { address: string; linked: boolean; console: string };
  vault: { exists: boolean; unlocked: boolean; store: string; protected: boolean };
  accounts: StatusAccount[];
  unfinishedMovements: MovementSummary[];
  cloudBackup?: { enabled: boolean; lastUploadAt?: string };
  next: string[];
};
export type StatusDeps = {
  version: string;
  home: string;
  registry: string;
  wallets: WalletStore;
  secrets: SecretStore;
  env?: NodeJS.ProcessEnv;
  chain: { usdcBalance: (address: string, signal?: AbortSignal) => Promise<bigint> };
  agents: {
    routerUsage: (account: WalletName, signal?: AbortSignal) => Promise<AgentRouterUsage>;
    linkStatus: (
      account: WalletName,
      signal?: AbortSignal,
    ) => Promise<Exclude<AccountLinkStatus, "not_linked">>;
  };
  cloudBackup?: (signal?: AbortSignal) => Promise<{ enabled: boolean; lastUploadAt?: string }>;
  now: () => Date;
  timeoutMs?: number;
  timers?: { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout };
};

export const STATUS_TIMEOUT_MS = 2_000;

type VaultStatus = StatusReport["vault"];
type AccountProbe = {
  link: AccountLinkStatus;
  usdc: string | undefined;
  routerTodayUsd: string | undefined;
  routerAllowanceUsd: string | undefined;
};

export async function buildStatus(deps: StatusDeps): Promise<StatusReport> {
  const timers = deps.timers ?? { setTimeout, clearTimeout };
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => {
    timeout = timers.setTimeout(() => {
      controller.abort(new Error("Status request deadline exceeded."));
      resolve();
    }, deps.timeoutMs ?? STATUS_TIMEOUT_MS);
  });

  try {
    const cloudBackupProbe = deps.cloudBackup;
    const cloudBackup =
      cloudBackupProbe === undefined
        ? Promise.resolve(undefined)
        : callBeforeDeadline<StatusReport["cloudBackup"]>(
            () => cloudBackupProbe(controller.signal),
            undefined,
            deadline,
          );
    const [vault, walletInfos, unfinishedMovements] = await Promise.all([
      readVaultStatus(deps),
      deps.wallets.list(),
      listUnfinishedMovements({ home: deps.home }),
    ]);
    const probes = await Promise.all(
      walletInfos.map(async (info) => await probeAccount(deps, info, deadline, controller.signal)),
    );
    const registry = stripTrailingSlash(deps.registry);
    const accounts = walletInfos.map((info, index) =>
      statusAccount(info, probes[index]!, deps.wallets.ceilingCaps(info.name)),
    );
    const linked = walletInfos.find((info) => info.entry.link !== undefined)?.entry.link;
    const owner =
      linked === undefined
        ? undefined
        : { address: linked.owner, linked: true, console: `${registry}/agents` };
    const cloudBackupResult = await cloudBackup;

    return {
      version: deps.version,
      home: deps.home,
      registry,
      ...(owner === undefined ? {} : { owner }),
      vault,
      accounts,
      unfinishedMovements,
      ...(cloudBackupResult === undefined ? {} : { cloudBackup: cloudBackupResult }),
      next: nextActions(vault.exists, accounts, deps.wallets.defaultName),
    };
  } finally {
    if (timeout !== undefined) timers.clearTimeout(timeout);
  }
}

export function formatUsdAmount(value: bigint | number): string {
  const decimal = typeof value === "bigint" ? formatUsdc(value) : numberToDecimal(value);
  const [whole, fraction = ""] = decimal.split(".");
  return `${whole}.${fraction.padEnd(2, "0")}`;
}

async function readVaultStatus(deps: StatusDeps): Promise<VaultStatus> {
  const store = deps.secrets.description.replace(/^the /u, "");
  const path = join(deps.home, "vault.json");
  let file;
  try {
    file = await readVaultFileUnlocked(path);
  } catch (error) {
    if (error instanceof VaultError && error.code === "not_found") {
      return { exists: false, unlocked: false, store, protected: false };
    }
    throw error;
  }

  return {
    exists: true,
    unlocked: await vaultIsUnlocked(deps, path, file.protected),
    store,
    protected: file.protected,
  };
}

async function vaultIsUnlocked(
  deps: StatusDeps,
  path: string,
  isProtected: boolean,
): Promise<boolean> {
  let key: Uint8Array | undefined;
  try {
    if (!isProtected) return await deps.secrets.has(VAULT_KEY_ACCOUNT);
    key = await unlockProtectedVault({
      path,
      secrets: deps.secrets,
      env: deps.env ?? process.env,
      now: deps.now,
    });
    await openVault({ path, key });
    return true;
  } catch {
    return false;
  } finally {
    key?.fill(0);
  }
}

async function probeAccount(
  deps: StatusDeps,
  info: WalletInfo,
  deadline: Promise<void>,
  signal: AbortSignal,
): Promise<AccountProbe> {
  const linked = info.entry.link !== undefined;
  const link = linked
    ? callBeforeDeadline(() => deps.agents.linkStatus(info.name, signal), "unknown", deadline)
    : Promise.resolve<AccountLinkStatus>("not_linked");
  const usdc =
    info.address === undefined
      ? Promise.resolve(undefined)
      : callBeforeDeadline(
          async () => formatUsdAmount(await deps.chain.usdcBalance(info.address!, signal)),
          undefined,
          deadline,
        );
  const router = linked
    ? callBeforeDeadline(
        async () => {
          const usage = await deps.agents.routerUsage(info.name, signal);
          return {
            routerTodayUsd: formatUsdAmount(usage.compute.spentTodayUsd),
            routerAllowanceUsd: formatUsdAmount(usage.compute.allowanceUsd),
          };
        },
        undefined,
        deadline,
      )
    : Promise.resolve(undefined);
  const [linkResult, usdcResult, routerResult] = await Promise.all([link, usdc, router]);
  return {
    link: linkResult,
    usdc: usdcResult,
    routerTodayUsd: routerResult?.routerTodayUsd,
    routerAllowanceUsd: routerResult?.routerAllowanceUsd,
  };
}

function callBeforeDeadline<T>(
  call: () => Promise<T>,
  fallback: T,
  deadline: Promise<void>,
): Promise<T> {
  let result: Promise<T>;
  try {
    result = call();
  } catch {
    return Promise.resolve(fallback);
  }
  return Promise.race([
    result.then((value) => value).catch(() => fallback),
    deadline.then(() => fallback),
  ]);
}

function statusAccount(
  info: WalletInfo,
  probe: AccountProbe,
  ceiling: WalletCeilingCaps,
): StatusAccount {
  return {
    name: info.name,
    default: info.isDefault,
    address: info.address ?? "unreadable",
    ...(probe.usdc === undefined ? {} : { usdc: probe.usdc }),
    ...(probe.routerTodayUsd === undefined ? {} : { routerTodayUsd: probe.routerTodayUsd }),
    ...(probe.routerAllowanceUsd === undefined
      ? {}
      : { routerAllowanceUsd: probe.routerAllowanceUsd }),
    caps: {
      perCallUsd: formatUsdAmount(BigInt(info.spendCaps.perCallAtomic)),
      perDayUsd: formatUsdAmount(BigInt(info.spendCaps.perDayAtomic)),
      ceilingUsd: formatCeilingUsd(ceiling.ceilingAtomic),
      ...(ceilingFloorApplies(ceiling.ceilingAtomic, BigInt(info.spendCaps.perDayAtomic))
        ? { ceilingFloorUsd: formatUsdAmount(BigInt(info.spendCaps.perDayAtomic)) }
        : {}),
    },
    link: probe.link,
  };
}

function nextActions(
  vaultExists: boolean,
  accounts: StatusAccount[],
  defaultName: WalletName | undefined,
): string[] {
  if (!vaultExists || accounts.length === 0) {
    return [nextLine("vapi setup", "create your vault and link your first account")];
  }
  const selected = accounts.find((account) => account.name === defaultName) ?? accounts[0]!;
  return [
    ...(selected.link === "not_linked"
      ? [nextLine("vapi setup", `link ${selected.name} to your owner wallet`)]
      : []),
    nextLine("vapi pay <ref> --max 0.02", `pay an API from ${selected.name}`),
    nextLine('vapi router chat "hello"', `talk to a model on ${selected.name}'s allowance`),
    nextLine("vapi accounts add <name>", "add an account"),
  ];
}

function nextLine(command: string, description: string): string {
  return command.padEnd(34) + description;
}

function stripTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function numberToDecimal(value: number): string {
  const raw = String(Object.is(value, -0) ? 0 : value);
  const match = /^(-?)(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/u.exec(raw);
  if (match === null) return raw;
  const [, sign, whole, fraction = "", exponentText] = match;
  const digits = whole! + fraction;
  const point = whole!.length + Number(exponentText);
  if (point <= 0) return `${sign}0.${"0".repeat(-point)}${digits}`;
  if (point >= digits.length) return `${sign}${digits}${"0".repeat(point - digits.length)}`;
  return `${sign}${digits.slice(0, point)}.${digits.slice(point)}`;
}
