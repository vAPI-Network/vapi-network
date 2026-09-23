import { getVapiPaths, loadConfig } from "@vapi-network/core";
import {
  RouterClientError,
  listRouterModels,
  rotateRouterKey,
  routerChat,
  routerCredentials,
  routerUsage,
  type RouterClientDeps,
} from "@vapi-network/core/router-client";

import {
  UsageError,
  getSecretStore,
  parseArguments,
  recordAudit,
  registryBaseUrl,
  requireSecretsAllowed,
  targetWallet,
  type CliDependencies,
  type CliIo,
  type WalletTarget,
} from "./cli.js";

const WALLET_OPTION = "--wallet";
const CHAT_USAGE =
  'Usage: vapi router chat --model <id> [--system <text>] [--max-tokens <n>] "<prompt>".';

export async function routerCommand(
  argv: string[],
  json: boolean,
  io: CliIo,
  dependencies: CliDependencies,
): Promise<void> {
  const subcommand = argv[0];
  switch (subcommand) {
    case "models":
      await modelsCommand(argv.slice(1), json, io, dependencies);
      return;
    case "usage":
      await usageCommand(argv.slice(1), json, io, dependencies);
      return;
    case "chat":
      await chatCommand(argv.slice(1), json, io, dependencies);
      return;
    case "key":
      await keyCommand(argv.slice(1), json, io, dependencies);
      return;
    default:
      throw new UsageError("Usage: vapi router <models|usage|chat|key>.");
  }
}

async function modelsCommand(
  argv: string[],
  json: boolean,
  io: CliIo,
  dependencies: CliDependencies,
): Promise<void> {
  const parsed = parseArguments(argv, {
    valueOptions: new Set([WALLET_OPTION]),
    maximumPositionals: 0,
  });
  await targetWallet(parsed, dependencies);
  const config = await loadConfig(getVapiPaths().config, process.env, { notice: io.stderr });
  const list = dependencies.router?.listRouterModels ?? listRouterModels;
  const models = await withRouterError(() =>
    list({
      apiBase: registryBaseUrl(config),
      ...(dependencies.fetchImpl === undefined ? {} : { fetchImpl: dependencies.fetchImpl }),
    }),
  );
  if (json) {
    io.stdout(JSON.stringify(models.map(({ id }) => id)));
    return;
  }
  for (const { id } of models) io.stdout(id);
}

async function usageCommand(
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
  const readUsage = dependencies.router?.routerUsage ?? routerUsage;
  const usage = await withRouterError(() => readUsage(routerDeps(target, dependencies)));
  if (json) {
    io.stdout(JSON.stringify(usage));
    return;
  }
  io.stdout(
    `Compute today: $${money(usage.compute.spentTodayUsd)} of $${money(
      usage.compute.allowanceUsd,
    )} (resets ${utcTime(usage.compute.resetsAt)} UTC)`,
  );
  io.stdout(
    `Owner's Compute: $${money(usage.compute.ownerSpentUsd)} of $${money(
      usage.compute.ownerLimitUsd,
    )}`,
  );
  io.stdout(
    usage.balance === null
      ? "Router balance: none"
      : `Router balance: $${money(usage.balance.remainingUsd)} left of $${money(
          usage.balance.purchasedUsd,
        )}`,
  );
}

async function chatCommand(
  argv: string[],
  json: boolean,
  io: CliIo,
  dependencies: CliDependencies,
): Promise<void> {
  const parsed = parseArguments(argv, {
    valueOptions: new Set([WALLET_OPTION, "--model", "--system", "--max-tokens"]),
    maximumPositionals: 1,
  });
  const model = parsed.one("--model");
  if (model === undefined) throw new UsageError("vapi router chat requires --model <id>.");
  const promptArgument = parsed.positionals[0];
  if (promptArgument === undefined) throw new UsageError(CHAT_USAGE);
  const target = await targetWallet(parsed, dependencies);
  const prompt =
    promptArgument === "-" ? await (dependencies.readStdin ?? readProcessStdin)() : promptArgument;
  const system = parsed.one("--system");
  const maxTokens = positiveInteger(parsed.one("--max-tokens"), "--max-tokens");
  const request = {
    model,
    messages: [
      ...(system === undefined ? [] : [{ role: "system" as const, content: system }]),
      { role: "user" as const, content: prompt },
    ],
    ...(maxTokens === undefined ? {} : { max_tokens: maxTokens }),
  };
  const chat = dependencies.router?.routerChat ?? routerChat;
  const result = await withRouterError(() => chat(routerDeps(target, dependencies), request));
  if (json) {
    io.stdout(
      JSON.stringify({
        model: result.model,
        content: result.content,
        ...(result.usage === undefined ? {} : { usage: result.usage }),
      }),
    );
    return;
  }
  io.stdout(result.content ?? "");
}

async function keyCommand(
  argv: string[],
  json: boolean,
  io: CliIo,
  dependencies: CliDependencies,
): Promise<void> {
  const parsed = parseArguments(argv, {
    valueOptions: new Set([WALLET_OPTION]),
    booleanOptions: new Set(["--rotate"]),
    maximumPositionals: 0,
  });
  const target = await targetWallet(parsed, dependencies);
  const deps = routerDeps(target, dependencies);
  if (parsed.has("--rotate")) {
    const rotate = dependencies.router?.rotateRouterKey ?? rotateRouterKey;
    await withRouterError(() => rotate(deps));
    io.stdout(
      json ? JSON.stringify({ wallet: target.name, rotated: true }) : "New Router key stored.",
    );
    return;
  }

  await requireSecretsAllowed(
    dependencies,
    "secret.export.key",
    target.name,
    json ? { forcedReason: "Router keys are never printed as JSON." } : {},
  );
  const credentials = dependencies.router?.routerCredentials ?? routerCredentials;
  const result = await withRouterError(() => credentials(deps));
  await recordAudit(dependencies, "secret.export.key", {
    wallet: target.name,
    detail: "router",
  });
  io.stdout(result.apiKey);
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
      throw new Error("Not linked. Run vapi login.");
    }
    throw error;
  }
}

function money(value: number): string {
  return value.toFixed(2);
}

function utcTime(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new Error("The vAPI Router usage reset time was invalid.");
  }
  return `${String(date.getUTCHours()).padStart(2, "0")}:${String(date.getUTCMinutes()).padStart(
    2,
    "0",
  )}`;
}

function positiveInteger(value: string | undefined, option: string): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/u.test(value)) throw new UsageError(`${option} must be a positive integer.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new UsageError(`${option} must be a positive integer.`);
  }
  return parsed;
}

async function readProcessStdin(): Promise<string> {
  process.stdin.setEncoding("utf8");
  let input = "";
  for await (const chunk of process.stdin) input += String(chunk);
  return input;
}
