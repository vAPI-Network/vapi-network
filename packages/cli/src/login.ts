import { activeAgentMarker, createPublicFetch, getVapiPaths, loadConfig } from "@vapi-network/core";
import {
  DEFAULT_AGENT_SCOPES,
  AgentLinkError,
  agentFetch,
  agentSecretAccounts,
  forgetAgentLink,
  pollDeviceLink,
  saveAgentLink,
  startDeviceLink,
  withAgentCredentialLock,
} from "@vapi-network/core/agent-link";

import {
  getEnvironment,
  getSecretStore,
  openInBrowser,
  parseArguments,
  registryBaseUrl,
  targetWallet,
  unlockTarget,
  type CliDependencies,
  type CliIo,
} from "./cli.js";

const WALLET_OPTION = "--wallet";

export async function loginCommand(
  argv: string[],
  json: boolean,
  io: CliIo,
  dependencies: CliDependencies,
): Promise<void> {
  await runLoginFlow(argv, json, io, dependencies);
}

/** Shared device-link flow used by `vapi login` and `vapi agent create`. */
export async function runLoginFlow(
  argv: string[],
  json: boolean,
  io: CliIo,
  dependencies: CliDependencies,
  options: { routerAllowanceUsd?: number } = {},
): Promise<void> {
  const parsed = parseArguments(argv, {
    valueOptions: new Set([WALLET_OPTION, "--label"]),
    booleanOptions: new Set(["--publish", "--no-browser"]),
    maximumPositionals: 0,
  });
  const target = await targetWallet(parsed, dependencies);
  const { account } = await unlockTarget(target, dependencies);
  const label = parsed.one("--label") ?? target.name;
  const scopes = [...DEFAULT_AGENT_SCOPES, ...(parsed.has("--publish") ? ["call.publish"] : [])];
  const config = await loadConfig(getVapiPaths().config, process.env, { notice: io.stderr });
  const apiBase = registryBaseUrl(config);
  const fetchImpl = dependencies.fetchImpl ?? createPublicFetch({ allowPrivateNetwork: false });
  const begin = dependencies.agentLink?.startDeviceLink ?? startDeviceLink;
  const poll = dependencies.agentLink?.pollDeviceLink ?? pollDeviceLink;
  const started = await begin({
    apiBase,
    account,
    label,
    scopes,
    fetchImpl,
    ...(options.routerAllowanceUsd === undefined
      ? {}
      : { routerAllowanceUsd: options.routerAllowanceUsd }),
  });
  const instructions = loginInstructions(
    target.name,
    account.address,
    started.userCode,
    started.verificationUriComplete,
  );
  (json ? io.stderr : io.stdout)(instructions);

  if (
    !parsed.has("--no-browser") &&
    (dependencies.interactive ?? Boolean(process.stdout.isTTY)) &&
    activeAgentMarker(getEnvironment(dependencies)) === undefined
  ) {
    (dependencies.openUrl ?? openInBrowser)(started.verificationUriComplete);
  }

  const result = await poll({ apiBase, start: started, fetchImpl });
  const secrets = getSecretStore(dependencies);
  const link = await saveAgentLink({
    secrets,
    wallets: target.store,
    wallet: target.name,
    start: started,
    result,
    apiBase,
    label,
    home: target.store.home,
  });
  const router = result.routerKey !== undefined;

  if (json) {
    io.stdout(
      JSON.stringify({
        wallet: target.name,
        agentWallet: account.address,
        owner: link.owner,
        scopes: link.scopes,
        router,
      }),
    );
    return;
  }

  const routerMessage = router
    ? `Router key stored in ${secrets.description}.`
    : "vAPI Router is not available right now; run vapi router key --rotate later.";
  io.stdout(`Linked ${target.name} to ${shortAddress(link.owner)}. ${routerMessage}`);
}

export async function logoutCommand(
  argv: string[],
  json: boolean,
  io: CliIo,
  dependencies: CliDependencies,
): Promise<void> {
  const parsed = parseArguments(argv, {
    valueOptions: new Set([WALLET_OPTION]),
    maximumPositionals: 0,
  });
  const target = await targetWallet(parsed, dependencies);
  const fetchImpl = dependencies.fetchImpl ?? createPublicFetch({ allowPrivateNetwork: false });
  await forgetAgentLink({
    secrets: getSecretStore(dependencies),
    wallets: target.store,
    wallet: target.name,
    fetchImpl,
    home: target.store.home,
  });
  io.stdout(
    json ? JSON.stringify({ wallet: target.name, unlinked: true }) : `Unlinked ${target.name}.`,
  );
}

export async function whoamiCommand(
  argv: string[],
  json: boolean,
  io: CliIo,
  dependencies: CliDependencies,
): Promise<void> {
  const parsed = parseArguments(argv, {
    valueOptions: new Set([WALLET_OPTION]),
    maximumPositionals: 0,
  });
  const target = await targetWallet(parsed, dependencies);
  const link = target.entry.link;
  if (link === undefined) {
    if (json) {
      io.stdout(
        JSON.stringify({
          wallet: target.name,
          ...(target.address === undefined ? {} : { address: target.address }),
          linked: false,
        }),
      );
      return;
    }
    io.stdout(walletHeading(target.name, target.address));
    io.stdout("Not linked. Run vapi login.");
    return;
  }

  const routerKey = (await getSecretStore(dependencies).has(
    agentSecretAccounts(target.name).routerStake,
  ))
    ? "stored"
    : "missing";
  const status = await checkAgentLinkStatus(target, link, dependencies);
  if (json) {
    io.stdout(
      JSON.stringify({
        wallet: target.name,
        ...(target.address === undefined ? {} : { address: target.address }),
        linked: true,
        owner: link.owner,
        label: link.label,
        scopes: link.scopes,
        linkedAt: link.linkedAt,
        routerKey,
        status: status.value,
      }),
    );
    return;
  }

  io.stdout(walletHeading(target.name, target.address));
  io.stdout(
    [
      `Owner: ${link.owner}`,
      `Label: ${link.label}`,
      `Permissions: ${link.scopes.join(" ")}`,
      `Linked: ${link.linkedAt}`,
      `Router key: ${routerKey}`,
      `Status: ${status.line}`,
    ].join("\n"),
  );
}

type AgentLinkStatus = {
  value: "active" | "revoked" | "unknown";
  line: string;
};

async function checkAgentLinkStatus(
  target: Awaited<ReturnType<typeof targetWallet>>,
  link: NonNullable<Awaited<ReturnType<typeof targetWallet>>["entry"]["link"]>,
  dependencies: CliDependencies,
): Promise<AgentLinkStatus> {
  const secrets = getSecretStore(dependencies);
  try {
    if (!secrets.available || !(await secrets.has(agentSecretAccounts(target.name).tokens))) {
      return couldNotCheckStatus("no stored agent token");
    }

    const agentFetchArgs = {
      secrets,
      wallets: target.store,
      wallet: target.name,
      ...(dependencies.fetchImpl === undefined ? {} : { fetchImpl: dependencies.fetchImpl }),
      ...(dependencies.now === undefined ? {} : { now: () => dependencies.now!().getTime() }),
    };
    return await withAgentCredentialLock(target.store, `wallet:${target.name}`, async () => {
      await target.store.reload();
      const currentLink = target.store.entry(target.name)?.link;
      if (currentLink === undefined || !sameAgentLink(currentLink, link)) {
        return couldNotCheckStatus("link changed during check");
      }
      const response = await agentFetch(
        agentFetchArgs,
        `${link.apiBase.replace(/\/+$/u, "")}/api/agents/self`,
        { method: "GET" },
      );
      if (response.status === 200) return { value: "active", line: "active" };
      if (response.status === 401) return revokedStatus();
      if (response.status === 404) {
        return {
          value: "unknown",
          line: "not checked (this console does not support it yet)",
        };
      }
      return couldNotCheckStatus(`HTTP ${response.status}`);
    });
  } catch (error) {
    if (error instanceof AgentLinkError && error.code === "not_linked") {
      return revokedStatus();
    }
    return couldNotCheckStatus(
      error instanceof AgentLinkError && error.code !== "http"
        ? "agent link error"
        : "network error",
    );
  }
}

function revokedStatus(): AgentLinkStatus {
  return {
    value: "revoked",
    line: "revoked or expired on the server. Run vapi login to link again.",
  };
}

function couldNotCheckStatus(reason: string): AgentLinkStatus {
  return { value: "unknown", line: `could not check (${reason})` };
}

function sameAgentLink(
  left: NonNullable<Awaited<ReturnType<typeof targetWallet>>["entry"]["link"]>,
  right: NonNullable<Awaited<ReturnType<typeof targetWallet>>["entry"]["link"]>,
): boolean {
  return (
    left.apiBase === right.apiBase &&
    left.clientId === right.clientId &&
    left.owner === right.owner &&
    left.label === right.label &&
    left.linkedAt === right.linkedAt &&
    left.routerBaseUrl === right.routerBaseUrl &&
    left.scopes.length === right.scopes.length &&
    left.scopes.every((scope, index) => scope === right.scopes[index])
  );
}

function loginInstructions(
  wallet: string,
  address: string,
  userCode: string,
  verificationUrl: string,
): string {
  return [
    "Link this agent to your vAPI account",
    "",
    `  Agent wallet  ${wallet}  ${shortAddress(address)}`,
    `  Code          ${userCode}`,
    `  Open          ${verificationUrl}`,
    "",
    "Sign in there with your own wallet and approve. Waiting…",
  ].join("\n");
}

function walletHeading(name: string, address: string | undefined): string {
  return address === undefined ? `Wallet: ${name}` : `Wallet: ${name} (${address})`;
}

function shortAddress(address: string): string {
  return address.length <= 12 ? address : `${address.slice(0, 6)}…${address.slice(-4)}`;
}
