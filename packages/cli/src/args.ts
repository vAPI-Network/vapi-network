import { STATS_RANGES, type StatsRange } from "@vapi-network/core";

export class UsageError extends Error {}

export const WALLET_OPTION = "--wallet";
export const ACCOUNT_OPTION = "--account";

export const RESUME_OPTION = "--resume";

type ArgumentSpec = {
  valueOptions: Set<string>;
  booleanOptions?: Set<string>;
  repeatableOptions?: Set<string>;
  maximumPositionals: number;
};

export function parseArguments(argv: string[], spec: ArgumentSpec) {
  const positionals: string[] = [];
  const options = new Map<string, string[]>();
  const flags = new Set<string>();
  const acceptsAccountAlias = spec.valueOptions.has(WALLET_OPTION);
  let sawWalletOption = false;
  let sawAccountOption = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (!argument.startsWith("--")) {
      positionals.push(argument);
      continue;
    }
    if (spec.booleanOptions?.has(argument)) {
      if (flags.has(argument)) throw new UsageError(`${argument} may only be provided once.`);
      flags.add(argument);
      continue;
    }
    if (acceptsAccountAlias && argument === WALLET_OPTION) sawWalletOption = true;
    if (acceptsAccountAlias && argument === ACCOUNT_OPTION) sawAccountOption = true;
    if (sawWalletOption && sawAccountOption) {
      throw new UsageError("--wallet and --account cannot be used together.");
    }
    const option = acceptsAccountAlias && argument === ACCOUNT_OPTION ? WALLET_OPTION : argument;
    if (!spec.valueOptions.has(option)) throw new UsageError(`Unknown option ${argument}.`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new UsageError(`Expected ${argument} <value>.`);
    index += 1;
    const previous = options.get(option) ?? [];
    if (previous.length > 0 && !spec.repeatableOptions?.has(option)) {
      throw new UsageError(`${argument} may only be provided once.`);
    }
    options.set(option, [...previous, value]);
  }
  if (positionals.length > spec.maximumPositionals) {
    throw new UsageError("Too many positional arguments.");
  }
  return {
    positionals,
    one: (name: string) => options.get(name)?.[0],
    many: (name: string) => options.get(name) ?? [],
    has: (name: string) => flags.has(name),
  };
}

export function removeJsonFlag(
  argv: string[],
  preserveForwarded = false,
): { args: string[]; json: boolean } {
  let json = false;
  const args: string[] = [];
  let forwarding = false;
  for (const argument of argv) {
    if (preserveForwarded && argument === "--") forwarding = true;
    if (argument !== "--json" || forwarding) {
      args.push(argument);
      continue;
    }
    if (json) throw new UsageError("--json may only be provided once.");
    json = true;
  }
  return { args, json };
}

export function requireNoArguments(argv: string[], command: string): void {
  if (argv.length > 0) throw new UsageError(`${command} does not accept arguments.`);
}

export function requiredPositional(
  value: string | undefined,
  argument: string,
  usage: string,
): string {
  if (!value) throw new UsageError(`Missing ${argument}.\n${usage}`);
  return value;
}

export function optionalPositiveInteger(
  value: string | undefined,
  option: string,
): number | undefined {
  const result = optionalNonNegativeInteger(value, option);
  if (result === 0) throw new UsageError(`${option} must be a positive integer.`);
  return result;
}

export function optionalBoundedInteger(
  value: string | undefined,
  option: string,
  minimum: number,
  maximum: number,
): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value)) {
    throw new UsageError(`${option} must be an integer from ${minimum} to ${maximum}.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new UsageError(`${option} must be an integer from ${minimum} to ${maximum}.`);
  }
  return parsed;
}

export function optionalUsdAmount(value: string | undefined, option: string): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+(?:\.\d{1,2})?$/.test(value)) {
    throw new UsageError(`${option} must be a US dollar amount such as 20 or 19.99.`);
  }
  const parsed = Number(value);
  if (parsed <= 0) throw new UsageError(`${option} must be greater than zero.`);
  if (parsed > 100_000) throw new UsageError(`${option} must be at most 100000.`);
  return parsed;
}

export function optionalNonNegativeInteger(
  value: string | undefined,
  option: string,
): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value)) throw new UsageError(`${option} must be a non-negative integer.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new UsageError(`${option} is too large.`);
  return parsed;
}

export function parseStatsRange(value: string): StatsRange {
  if ((STATS_RANGES as readonly string[]).includes(value)) return value as StatsRange;
  throw new UsageError(`--range must be one of ${STATS_RANGES.join(", ")}.`);
}

export function parseJson(value: string, option: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new UsageError(`${option} must contain valid JSON.`);
  }
}

export function aliasedOption(
  parsed: { one(name: string): string | undefined },
  preferred: string,
  legacy: string,
): string | undefined {
  const preferredValue = parsed.one(preferred);
  const legacyValue = parsed.one(legacy);
  if (preferredValue !== undefined && legacyValue !== undefined) {
    throw new UsageError(`${preferred} and ${legacy} cannot be used together.`);
  }
  return preferredValue ?? legacyValue;
}

export function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export function parseInitNetworks(value: string): string[] {
  const networks = value
    .split(",")
    .map((network) => network.trim().toLowerCase())
    .filter(Boolean);
  if (networks.length === 0 || new Set(networks).size !== networks.length) {
    throw new UsageError("--networks must be a comma-separated list without duplicates.");
  }
  for (const network of networks) {
    if (network !== "base" && network !== "arc" && network !== "solana") {
      throw new UsageError("--networks supports base and arc; Solana vault setup is unavailable.");
    }
  }
  return networks;
}
