import {
  assertWalletName,
  createPublicFetch,
  explorerTransactionUrl,
  getDefaultConfig,
  getVapiPaths,
  isMissingFile,
  loadConfig,
  transferBetweenAccounts,
} from "@vapi-network/core";
import {
  accountsSend,
  runAction,
  type AccountsPort,
  type ActionContext,
  type CallPort,
} from "@vapi-network/mcp";

import {
  UsageError,
  getEnvironment,
  getSecretStore,
  openWalletStore,
  parseArguments,
  registryBaseUrl,
  requiredPositional,
  unlockTarget,
  type CliDependencies,
  type CliIo,
} from "./cli.js";

const SEND_USAGE =
  "Usage: vapi send <amount> --from <account> --to <account|owner|0x…> [--network base|arc] [--resume <nonce>] [--json]";

export async function sendCommand(
  argv: string[],
  json: boolean,
  io: CliIo,
  dependencies: CliDependencies,
): Promise<number> {
  const parsed = parseArguments(argv, {
    valueOptions: new Set(["--from", "--to", "--network", "--resume"]),
    maximumPositionals: 1,
  });
  const amountUsd = requiredPositional(parsed.positionals[0], "<amount>", SEND_USAGE);
  const fromValue = parsed.one("--from");
  if (fromValue === undefined) throw new UsageError(`Missing --from <account>.\n${SEND_USAGE}`);
  const to = parsed.one("--to");
  if (to === undefined) {
    throw new UsageError(`Missing --to <account|owner|0x…>.\n${SEND_USAGE}`);
  }
  const network = parsed.one("--network") ?? "base";
  if (network !== "base" && network !== "arc") {
    throw new UsageError(`--network must be base or arc.\n${SEND_USAGE}`);
  }

  const from = assertWalletName(fromValue);
  const store = await openWalletStore(dependencies);
  const selected = store.resolve({ name: from, env: {} });
  const address = await store.readAddress(selected.name);
  const config = await sendConfig(dependencies);
  const apiBase = selected.entry.link?.apiBase ?? registryBaseUrl(config);
  const fetchImpl =
    dependencies.fetchImpl ??
    createPublicFetch({ allowPrivateNetwork: config.allowPrivateNetwork ?? false });
  const resume = parsed.one("--resume") as `0x${string}` | undefined;

  const accounts: AccountsPort = {
    async send(input) {
      return await transferBetweenAccounts({
        store,
        secrets: getSecretStore(dependencies),
        apiBase,
        from: input.from,
        to: input.to,
        amountUsd: input.amountUsd,
        ...(input.network === undefined ? {} : { network: input.network }),
        purpose: "send",
        fetchImpl,
        unlock: async () =>
          (
            await unlockTarget(
              { store, ...selected, ...(address === undefined ? {} : { address }) },
              dependencies,
            )
          ).account,
        ...(resume === undefined ? {} : { resume }),
        ...(dependencies.now === undefined ? {} : { now: () => dependencies.now!().getTime() }),
        ...(dependencies.transfer?.nonce === undefined
          ? {}
          : { nonce: dependencies.transfer.nonce }),
        ...(dependencies.transfer?.timeoutMs === undefined
          ? {}
          : { timeoutMs: dependencies.transfer.timeoutMs }),
      });
    },
  };
  const context: ActionContext = {
    config,
    clock: () => new Date(),
    call: unavailableSendCallPort(),
    accounts,
    caller: { surface: "cli" },
  };
  const { message: _message, ...result } = await runAction(
    accountsSend,
    { from, to, amountUsd, network },
    context,
  );
  void _message;

  if (json) {
    io.stdout(JSON.stringify(result));
  } else if (result.status === "unknown") {
    io.stderr(
      `The transfer outcome is unknown; the spend stays reserved. Run the same command with --resume ${result.nonce} to finish it. Do not send it again.`,
    );
  } else {
    const networkLabel = result.network === "eip155:8453" ? "Base" : "Arc";
    io.stdout(
      `Sent ${result.amountUsd} USDC from ${result.from} to ${result.toName} on ${networkLabel}`,
    );
    const explorer =
      result.txHash === null ? undefined : explorerTransactionUrl(result.network, result.txHash);
    if (explorer !== undefined) io.stdout(explorer);
    else if (result.replayed) io.stdout("The transfer was already relayed earlier.");
  }

  return result.status === "unknown" ? 1 : 0;
}

function unavailableSendCallPort(): CallPort {
  const unavailable = async (): Promise<never> => {
    throw new Error("not available for send");
  };
  return { search: unavailable, inspect: unavailable, pay: unavailable };
}

async function sendConfig(dependencies: CliDependencies) {
  try {
    return await loadConfig(getVapiPaths().config, getEnvironment(dependencies));
  } catch (error) {
    if (!isMissingFile(error)) throw error;
    return getDefaultConfig(getEnvironment(dependencies));
  }
}
