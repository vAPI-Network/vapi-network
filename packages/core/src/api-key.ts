/**
 * `@vapi-network/core/api-key` — the registry key a person publishes with.
 *
 * Reading APIs needs no account, so nothing else in this client has ever held
 * a credential for the registry itself. Listing an API does: the write API
 * authenticates a bearer key, `vapi_sk_…`, that the provider creates in the
 * console. That key can create and retire listings under their name, so it is
 * treated like every other secret here — typed by a person on a terminal, kept
 * in the operating system's credential store when there is one, and never
 * passed as an argument where a shell history and `ps` would keep it.
 *
 * It is a separate package entry point for the same reason `@vapi-network/core/secrets`
 * is: the MCP server has no publish tool and must not be able to reach a
 * provider credential by importing `@vapi-network/core`. The repository lint
 * rules enforce that for `packages/mcp`.
 */

import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { getDefaultConfig, getVapiPaths, isMissingFile } from "./config.js";
import type { SecretStore } from "./secret-store.js";

/** Every key the registry issues carries this prefix; a paste that does not is a typo. */
export const API_KEY_PREFIX = "vapi_sk_";

/**
 * The shape of a registry key: the prefix plus 16 to 128 URL-safe characters.
 * Bounded on purpose — an unbounded "secret" is usually a whole file that was
 * pasted by accident.
 */
export const API_KEY_PATTERN = /^vapi_sk_[A-Za-z0-9_-]{16,128}$/;

/** The CI route. Checked before the OS secret store, like `VAPI_KEYSTORE_PASSWORD`. */
export const API_KEY_ENV = "VAPI_API_KEY";

/**
 * The account the key is filed under in the OS secret store. A dot is not
 * legal in a wallet name, so this entry can never collide with the passphrase
 * `vapi unlock` stores for a wallet of the same name.
 */
export const API_KEY_SECRET_ACCOUNT = "vapi.api-key";

/** The field `config.json` keeps the key in when the machine has no secret store. */
export const API_KEY_CONFIG_FIELD = "apiKey";

/** Where a key was found, in the order the resolver looks. */
export type ApiKeySource = "env" | "secret-store" | "config";

export type ResolvedApiKey = {
  key: string;
  source: ApiKeySource;
};

export type ApiKeyStatus = {
  present: boolean;
  source?: ApiKeySource;
  /** The key with everything but its last four characters removed. */
  masked?: string;
  /** Where the key is kept, in words, for a person reading `vapi auth status`. */
  location?: string;
};

export type ApiKeyOptions = {
  /** Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** The OS secret store, when this platform has one. */
  store?: SecretStore;
  /** Defaults to `~/.vapi/config.json`. */
  configPath?: string;
};

export class ApiKeyError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ApiKeyError";
  }
}

export const API_KEY_MALFORMED = `A vAPI API key starts with ${API_KEY_PREFIX} and is created in the console. Copy the whole key, including the prefix.`;

/** The key, trimmed, or a sentence about why this is not one. */
export function validateApiKey(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new ApiKeyError("A vAPI API key cannot be empty.");
  if (!API_KEY_PATTERN.test(trimmed)) throw new ApiKeyError(API_KEY_MALFORMED);
  return trimmed;
}

/**
 * The key with everything but its tail removed, so a person can tell two keys
 * apart in `vapi auth status` without the whole secret entering a scrollback.
 */
export function maskApiKey(key: string): string {
  const tail = key.trim().slice(-4);
  return `${API_KEY_PREFIX}…${tail}`;
}

/**
 * The key this machine publishes with: `VAPI_API_KEY`, then the OS secret
 * store, then `config.json`. A keyring that will not answer is treated as
 * "no key there", never as a failure of the command that asked.
 */
export async function resolveApiKey(
  options: ApiKeyOptions = {},
): Promise<ResolvedApiKey | undefined> {
  const env = options.env ?? process.env;
  const fromEnv = env[API_KEY_ENV]?.trim();
  if (fromEnv) return { key: fromEnv, source: "env" };

  const store = options.store;
  if (store?.available) {
    try {
      const stored = (await store.get(API_KEY_SECRET_ACCOUNT))?.trim();
      if (stored) return { key: stored, source: "secret-store" };
    } catch {
      // An unreachable keyring must not hide the key in config.json.
    }
  }

  const fromConfig = await readConfigApiKey(options.configPath ?? getVapiPaths().config);
  return fromConfig === undefined ? undefined : { key: fromConfig, source: "config" };
}

/** What `vapi auth status` answers with. The key itself never leaves this module. */
export async function apiKeyStatus(options: ApiKeyOptions = {}): Promise<ApiKeyStatus> {
  const resolved = await resolveApiKey(options);
  if (resolved === undefined) return { present: false };
  return {
    present: true,
    source: resolved.source,
    masked: maskApiKey(resolved.key),
    location: describeApiKeySource(resolved.source, options.store),
  };
}

export function describeApiKeySource(source: ApiKeySource, store?: SecretStore): string {
  if (source === "env") return `the ${API_KEY_ENV} environment variable`;
  if (source === "secret-store") return store?.description ?? "the OS secret store";
  return "config.json";
}

export type StoredApiKey = {
  source: Exclude<ApiKeySource, "env">;
  location: string;
  masked: string;
};

/**
 * Keeps the key where `vapi unlock` keeps a passphrase: the OS secret store
 * when the platform has one, and `config.json` at mode 0600 otherwise. The
 * value is validated first, so a half-copied key is refused before it is
 * written anywhere.
 */
export async function storeApiKey(
  value: string,
  options: ApiKeyOptions = {},
): Promise<StoredApiKey> {
  const key = validateApiKey(value);
  const store = options.store;
  if (store?.available) {
    await store.set(API_KEY_SECRET_ACCOUNT, key);
    return {
      source: "secret-store",
      location: store.description,
      masked: maskApiKey(key),
    };
  }
  const configPath = options.configPath ?? getVapiPaths().config;
  await writeConfigApiKey(configPath, key, options.env ?? process.env);
  return { source: "config", location: configPath, masked: maskApiKey(key) };
}

/**
 * Removes the key from everywhere this client put it, and says which places
 * had one. `VAPI_API_KEY` belongs to the process that set it, so it is named
 * rather than touched.
 */
export async function clearApiKey(
  options: ApiKeyOptions = {},
): Promise<{ cleared: Exclude<ApiKeySource, "env">[]; envStillSet: boolean }> {
  const cleared: Exclude<ApiKeySource, "env">[] = [];
  const store = options.store;
  if (store?.available) {
    try {
      if (await store.remove(API_KEY_SECRET_ACCOUNT)) cleared.push("secret-store");
    } catch {
      // Same as the resolver: a keyring that will not answer is not a reason
      // to leave the copy in config.json behind.
    }
  }
  const configPath = options.configPath ?? getVapiPaths().config;
  if ((await readConfigApiKey(configPath)) !== undefined) {
    await writeConfigApiKey(configPath, undefined, options.env ?? process.env);
    cleared.push("config");
  }
  const env = options.env ?? process.env;
  return { cleared, envStillSet: Boolean(env[API_KEY_ENV]?.trim()) };
}

/**
 * The key in `config.json`, read straight from the file rather than through
 * `loadConfig`. The config schema drops the field on purpose: the parsed
 * config object travels into the MCP server, which must never hold this key.
 */
async function readConfigApiKey(path: string): Promise<string | undefined> {
  const record = await readConfigRecord(path);
  const value = record?.[API_KEY_CONFIG_FIELD];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

async function readConfigRecord(path: string): Promise<Record<string, unknown> | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isMissingFile(error)) return undefined;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  return parsed as Record<string, unknown>;
}

/**
 * Writes the key into `config.json` without disturbing anything else in it. A
 * home that has no config yet gets the default one first, so storing a key can
 * never leave a file the config schema refuses to parse.
 */
async function writeConfigApiKey(
  path: string,
  key: string | undefined,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const existing = await readConfigRecord(path);
  const record: Record<string, unknown> =
    existing ?? (getDefaultConfig(env) as unknown as Record<string, unknown>);
  if (key === undefined) delete record[API_KEY_CONFIG_FIELD];
  else record[API_KEY_CONFIG_FIELD] = key;

  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${process.pid}.api-key.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(record, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "w",
  });
  await rename(temporaryPath, path);
  // A config written before this release may be world-readable; a file that
  // now holds a credential may not be.
  await chmod(path, 0o600);
}
