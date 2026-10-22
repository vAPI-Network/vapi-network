import { resolve } from "node:path";

import { activeAgentMarker, getVapiPaths, WalletStore } from "@vapi-network/core";

import {
  getEnvironment,
  getLinePrompt,
  getSecretStore,
  isInteractive,
  openInBrowser,
  parseArguments,
  readConfig,
  registryBaseUrl,
  targetWallet,
  type CliDependencies,
  type CliIo,
} from "./cli.js";
import { runLoginFlow } from "./login.js";

type DashboardLink =
  { linked: true } | { linked: false; next: { kind: "link"; account: string; command: string }[] };

export function dashboardUrl(apiBase: string): string {
  return `${apiBase.replace(/\/+$/u, "")}/agents`;
}

/** An optional device grant must never turn a completed local write into a failure. */
export async function offerDashboardLink({
  name,
  json,
  noLink = false,
  io,
  dependencies,
  home = getVapiPaths().directory,
}: {
  name: string;
  json: boolean;
  noLink?: boolean;
  io: CliIo;
  dependencies: CliDependencies;
  home?: string;
}): Promise<DashboardLink> {
  const otherHome = resolve(home) !== resolve(getVapiPaths().directory);
  const command = `${otherHome ? `VAPI_HOME=${shellQuote(home)} ` : ""}vapi login --account ${name}`;
  const unlinked: DashboardLink = {
    linked: false,
    next: [{ kind: "link", account: name, command }],
  };
  const hint = () => {
    if (!json) io.stdout(`Run \`${command}\` to see this wallet on your dashboard.`);
    return unlinked;
  };

  try {
    const store = await WalletStore.open(home, {
      secrets: getSecretStore(dependencies),
      env: getEnvironment(dependencies),
    });
    if (store.entry(name)?.link !== undefined) return { linked: true };
    if (
      noLink ||
      otherHome ||
      json ||
      !isInteractive(dependencies) ||
      activeAgentMarker(getEnvironment(dependencies)) !== undefined
    ) {
      return hint();
    }
    const answer = (
      await getLinePrompt(dependencies)(`Link ${name} to your vAPI dashboard? [Y/n] `)
    ).trim();
    if (!/^(?:y|yes)?$/iu.test(answer)) return hint();

    await runLoginFlow(["--account", name, "--label", name], false, io, dependencies);
    // The login flow opens its own store; reload before reading its saved link.
    await store.reload();
    const link = store.entry(name)?.link;
    if (link === undefined) return hint();
    io.stdout(`See it on your dashboard: ${dashboardUrl(link.apiBase)}`);
    return { linked: true };
  } catch (error) {
    if (!json) {
      io.stderr(`Link not completed: ${error instanceof Error ? error.message : String(error)}`);
    }
    return hint();
  }
}

export async function dashboardCommand(
  argv: string[],
  json: boolean,
  io: CliIo,
  dependencies: CliDependencies,
): Promise<void> {
  const parsed = parseArguments(argv, {
    valueOptions: new Set(["--wallet"]),
    booleanOptions: new Set(["--no-browser", "--no-link"]),
    maximumPositionals: 0,
  });
  const target = await targetWallet(parsed, dependencies);
  let status: DashboardLink = { linked: true };
  if (target.entry.link === undefined) {
    if (!json) io.stdout(`${target.name} is not linked to your vAPI dashboard yet.`);
    status = await offerDashboardLink({
      name: target.name,
      json,
      noLink: parsed.has("--no-link"),
      io,
      dependencies: parsed.has("--no-browser")
        ? { ...dependencies, openUrl: () => false }
        : dependencies,
    });
  }
  await target.store.reload();
  const apiBase =
    target.store.entry(target.name)?.link?.apiBase ??
    registryBaseUrl(await readConfig(getVapiPaths().config, io));
  const url = dashboardUrl(apiBase);
  let opened = false;
  if (
    status.linked &&
    !parsed.has("--no-browser") &&
    (dependencies.interactive ?? Boolean(process.stdout.isTTY)) &&
    activeAgentMarker(getEnvironment(dependencies)) === undefined
  ) {
    opened = (dependencies.openUrl ?? openInBrowser)(url);
  }
  io.stdout(json ? JSON.stringify({ account: target.name, url, ...status, opened }) : url);
}

function shellQuote(value: string): string {
  return /^[a-zA-Z0-9_./-]+$/u.test(value) ? value : `'${value.replace(/'/gu, "'\\''")}'`;
}
