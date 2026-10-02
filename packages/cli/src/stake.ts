import { activeAgentMarker } from "@vapi-network/core";
import {
  RouterClientError,
  ownerStake,
  type RouterClientDeps,
} from "@vapi-network/core/router-client";
import { AGENT_LINK_REVOKED_MESSAGE } from "@vapi-network/core/agent-link";
import { formatUnits } from "viem";

import {
  UsageError,
  getEnvironment,
  getSecretStore,
  openInBrowser,
  parseArguments,
  targetWallet,
  type CliDependencies,
  type CliIo,
  type WalletTarget,
} from "./cli.js";

const WALLET_OPTION = "--wallet";
export const STAKE_URL = "https://api.vapinetwork.ai/stake";

export async function stakeCommand(
  argv: string[],
  json: boolean,
  io: CliIo,
  dependencies: CliDependencies,
): Promise<void> {
  const subcommand = argv[0];
  switch (subcommand) {
    case "status":
      await statusCommand(argv.slice(1), json, io, dependencies);
      return;
    case "open":
      await openCommand(argv.slice(1), json, io, dependencies);
      return;
    default:
      throw new UsageError("Usage: vapi stake <status|open>.");
  }
}

async function statusCommand(
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
  const readStake = dependencies.router?.ownerStake ?? ownerStake;
  const result = await withRouterError(() => readStake(routerDeps(target, dependencies)));
  const stakeFormatted = formatUnits(BigInt(result.stake), 18);
  if (json) {
    io.stdout(
      JSON.stringify({
        owner: result.owner,
        stake: result.stake,
        stakeFormatted,
        computeTodayUsd: result.computeTodayUsd,
        stakeUrl: STAKE_URL,
      }),
    );
    return;
  }
  io.stdout(
    `Owner ${result.owner}  Stake ${stakeFormatted} vAPI  Compute today $${result.computeTodayUsd.toFixed(
      2,
    )}`,
  );
  io.stdout(`Stake or unstake at ${STAKE_URL}`);
}

async function openCommand(
  argv: string[],
  json: boolean,
  io: CliIo,
  dependencies: CliDependencies,
): Promise<void> {
  const parsed = parseArguments(argv, {
    valueOptions: new Set([WALLET_OPTION]),
    booleanOptions: new Set(["--no-browser"]),
    maximumPositionals: 0,
  });
  await targetWallet(parsed, dependencies);
  if (
    !parsed.has("--no-browser") &&
    (dependencies.interactive ?? Boolean(process.stdout.isTTY)) &&
    activeAgentMarker(getEnvironment(dependencies)) === undefined
  ) {
    (dependencies.openUrl ?? openInBrowser)(STAKE_URL);
  }
  io.stdout(json ? JSON.stringify({ url: STAKE_URL }) : STAKE_URL);
}

function routerDeps(target: WalletTarget, dependencies: CliDependencies): RouterClientDeps {
  return {
    secrets: getSecretStore(dependencies),
    wallets: target.store,
    wallet: target.name,
    ...(dependencies.fetchImpl === undefined ? {} : { fetchImpl: dependencies.fetchImpl }),
  };
}

async function withRouterError<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof RouterClientError && error.code === "not_linked") {
      throw new Error(
        error.message === AGENT_LINK_REVOKED_MESSAGE
          ? AGENT_LINK_REVOKED_MESSAGE
          : "Not linked. Run vapi login.",
      );
    }
    throw error;
  }
}
