import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { sep } from "node:path";

import {
  buildStatus,
  createPublicFetch,
  ensureDeviceName,
  getDefaultConfig,
  getVapiPaths,
  isMissingFile,
  loadConfig,
  sweepAllAboveCeiling,
  type StatusAccount,
  type StatusReport,
  type VapiConfig,
  type WalletName,
  type WalletStore,
} from "@vapi-network/core";
import { readCloudBackupState } from "@vapi-network/core/cloud-backup";
import { routerUsage } from "@vapi-network/core/router-client";

import {
  UsageError,
  baseUsdcBalanceReader,
  getEnvironment,
  getSecretStore,
  openWalletStore,
  registryBaseUrl,
  unlockTarget,
  type CliDependencies,
  type CliIo,
  type WalletTarget,
} from "./cli.js";
import { agentLinkStatus } from "./login.js";
import { routerDeps } from "./router.js";
import { CLI_VERSION } from "./version.js";

export async function statusCommand(
  argv: string[],
  json: boolean,
  io: CliIo,
  dependencies: CliDependencies,
): Promise<void> {
  if (argv.length > 0) throw new UsageError("vapi status does not accept arguments.");
  const report = await collectStatus(dependencies, { sweepCeilings: true, warn: io.stderr });
  if (json) {
    io.stdout(JSON.stringify(report));
    return;
  }
  for (const line of renderStatusScreen(report)) io.stdout(line);
}

export function renderStatusScreen(report: StatusReport): string[] {
  const cloudBackup = cloudBackupLines(report);
  if (!report.vault.exists) {
    return [
      `Run vapi setup to create a vault in ${displayHome(report.home)} and link your first account.`,
      ...cloudBackup,
    ];
  }
  const header = statusHeader(report);

  const owner =
    report.owner === undefined
      ? `Owner`.padEnd(11) + `not linked   console: ${report.registry}/agents`
      : `Owner`.padEnd(11) +
        `${shortAddress(report.owner.address)}   ${report.owner.linked ? "linked" : "not linked"}      console: ${report.owner.console}`;
  const vaultState = report.vault.unlocked
    ? `unlocked on this device (${report.vault.store})`
    : report.vault.protected
      ? `protected, locked (${report.vault.store})`
      : `locked (${report.vault.store})`;
  const accounts =
    report.accounts.length === 0
      ? ["  (none yet — run vapi setup)"]
      : report.accounts.flatMap((account) => [
          formatAccountLine(account, accountNameWidth(report.accounts)),
          ...(account.caps.ceilingFloorUsd === undefined
            ? []
            : [
                `    ${account.name}: swept down to ${account.caps.ceilingFloorUsd} USDC, the per-day cap`,
              ]),
        ]);
  const unfinishedMovements = report.unfinishedMovements.map(
    (movement) =>
      `Unfinished movement ${movement.id} from ${movement.from}: vapi accounts distribute --resume ${movement.id}`,
  );
  return [
    header,
    "",
    owner,
    `Vault`.padEnd(11) + `${vaultState}   backup: vapi backup`,
    ...cloudBackup,
    "",
    "Accounts",
    ...accounts,
    ...(unfinishedMovements.length === 0 ? [] : ["", ...unfinishedMovements]),
    "",
    "Next",
    ...report.next.map((line) => `  ${line}`),
  ];
}

function cloudBackupLines(report: StatusReport): string[] {
  if (report.cloudBackup === undefined) return [];
  return [
    report.cloudBackup.enabled
      ? `Cloud backup: on (${report.cloudBackup.lastUploadAt === undefined ? "no upload yet" : `last upload ${report.cloudBackup.lastUploadAt}`})`
      : "Cloud backup: off",
  ];
}

export function formatAccountLine(account: StatusAccount, nameWidth: number): string {
  const name = `${account.name}${account.default ? " *" : ""}`.padEnd(nameWidth);
  const balance = `${account.usdc ?? "…"} USDC`.padEnd(10);
  const router =
    account.link === "not_linked"
      ? "Router today —"
      : `Router today $${account.routerTodayUsd ?? "…"} of $${account.routerAllowanceUsd ?? "…"}`;
  const link = account.link === "not_linked" ? "not linked" : account.link;
  const ceiling =
    account.caps.ceilingUsd === "off" ? "ceiling off" : `ceiling ${account.caps.ceilingUsd} USDC`;
  return `  ${name}  ${shortAddress(account.address)}   ${balance}   ${router}   caps $${account.caps.perCallUsd} / $${account.caps.perDayUsd} per day   ${ceiling}   ${link}`;
}

export function accountNameWidth(accounts: StatusAccount[]): number {
  return Math.max(0, ...accounts.map((account) => account.name.length)) + 2;
}

export async function collectStatus(
  dependencies: CliDependencies,
  options: { sweepCeilings?: boolean; warn?: (message: string) => void } = {},
): Promise<StatusReport> {
  const paths = getVapiPaths();
  const config = await statusConfig(paths.config);
  const wallets = await openWalletStore(dependencies);
  const readUsage = dependencies.router?.routerUsage ?? routerUsage;
  const fetchImpl =
    dependencies.fetchImpl ??
    createPublicFetch({ allowPrivateNetwork: config.allowPrivateNetwork ?? false });
  const device = await ensureDeviceName({
    env: getEnvironment(dependencies),
    configPath: paths.config,
    ...(dependencies.hostname === undefined ? {} : { hostname: dependencies.hostname() }),
  });

  const report = await buildStatus({
    version: CLI_VERSION,
    home: paths.directory,
    registry: registryBaseUrl(config).replace(/\/+$/u, ""),
    wallets,
    secrets: getSecretStore(dependencies),
    env: getEnvironment(dependencies),
    chain: {
      usdcBalance: async (address, signal) =>
        await baseUsdcBalanceReader(config, {
          ...dependencies,
          fetchImpl: withDeadlineSignal(fetchImpl, signal),
        })(address),
    },
    agents: {
      routerUsage: async (name, signal) =>
        await readUsage(
          routerDeps(await statusTarget(wallets, name, dependencies), {
            ...dependencies,
            fetchImpl: withDeadlineSignal(fetchImpl, signal),
          }),
        ),
      linkStatus: async (name, signal) => {
        const target = await statusTarget(wallets, name, dependencies);
        const link = target.entry.link;
        if (link === undefined) return "unknown";
        return (
          await agentLinkStatus(target, link, {
            ...dependencies,
            fetchImpl: withDeadlineSignal(fetchImpl, signal),
          })
        ).value;
      },
    },
    cloudBackup: async () =>
      await readCloudBackupState({ secrets: getSecretStore(dependencies), device }),
    now: dependencies.now ?? (() => new Date()),
    ...(dependencies.status?.timeoutMs === undefined
      ? {}
      : { timeoutMs: dependencies.status.timeoutMs }),
  });
  if (options.sweepCeilings) {
    await runStatusSweep({
      dependencies,
      wallets,
      config,
      fetchImpl,
      ...(options.warn === undefined ? {} : { warn: options.warn }),
    });
  }
  return report;
}

async function runStatusSweep(args: {
  dependencies: CliDependencies;
  wallets: WalletStore;
  config: VapiConfig;
  fetchImpl: typeof fetch;
  warn?: (message: string) => void;
}): Promise<void> {
  const timeoutMs = args.dependencies.ceiling?.timeoutMs ?? 10_000;
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      (args.dependencies.ceiling?.sweepAllAboveCeiling ?? sweepAllAboveCeiling)({
        store: args.wallets,
        secrets: getSecretStore(args.dependencies),
        apiBase: registryBaseUrl(args.config),
        config: args.config,
        fetchImpl: args.fetchImpl,
        signal: controller.signal,
        ...(args.dependencies.now === undefined
          ? {}
          : { now: () => args.dependencies.now!().getTime() }),
        ...(args.dependencies.ceiling?.balanceReader === undefined
          ? {}
          : { balanceReader: args.dependencies.ceiling.balanceReader }),
        ...(args.dependencies.ceiling?.fetchSiblingsImpl === undefined
          ? {}
          : { fetchSiblingsImpl: args.dependencies.ceiling.fetchSiblingsImpl }),
        ...(args.dependencies.ceiling?.transfer === undefined
          ? {}
          : { transfer: args.dependencies.ceiling.transfer }),
        unlock: async (name) =>
          (
            await unlockTarget(
              await statusTarget(args.wallets, name, args.dependencies),
              args.dependencies,
            )
          ).account,
        timeoutMs,
        ...(args.warn === undefined ? {} : { warn: args.warn }),
      }),
      new Promise<void>((resolve) => {
        timeout = setTimeout(() => {
          controller.abort();
          resolve();
        }, timeoutMs);
        timeout.unref();
      }),
    ]);
  } catch {
    // Ceiling enforcement is best effort and cannot hide the status screen.
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function withDeadlineSignal(fetchImpl: typeof fetch, deadline?: AbortSignal): typeof fetch {
  if (deadline === undefined) return fetchImpl;
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const requestSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    const signal =
      requestSignal === undefined || requestSignal === deadline
        ? deadline
        : AbortSignal.any([requestSignal, deadline]);
    return await fetchImpl(input, { ...init, signal });
  }) as typeof fetch;
}

async function statusConfig(path: string): Promise<VapiConfig> {
  try {
    await stat(path);
  } catch (error) {
    if (isMissingFile(error)) return getDefaultConfig(process.env);
    throw error;
  }
  return await loadConfig(path, process.env);
}

async function statusTarget(
  wallets: WalletStore,
  name: WalletName,
  dependencies: CliDependencies,
): Promise<WalletTarget> {
  const resolved = wallets.resolve({ name, env: getEnvironment(dependencies) });
  const address = await wallets.readAddress(name);
  return { store: wallets, ...resolved, ...(address === undefined ? {} : { address }) };
}

function statusHeader(report: StatusReport): string {
  return `vAPI ${report.version}        home ${displayHome(report.home)}        registry ${new URL(report.registry).host}`;
}

function displayHome(home: string): string {
  const userHome = homedir();
  if (home === userHome) return "~";
  return home.startsWith(`${userHome}${sep}`) ? `~${home.slice(userHome.length)}` : home;
}

function shortAddress(address: string): string {
  return address.length <= 12 ? address : `${address.slice(0, 6)}…${address.slice(-4)}`;
}
