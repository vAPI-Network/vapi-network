import { activeAgentMarker, createPublicFetch, getVapiPaths, loadConfig } from "@vapi-network/core";
import {
  DEFAULT_AGENT_SCOPES,
  agentSecretAccounts,
  forgetAgentLink,
  pollDeviceLink,
  saveAgentLink,
  startDeviceLink,
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
    ].join("\n"),
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
