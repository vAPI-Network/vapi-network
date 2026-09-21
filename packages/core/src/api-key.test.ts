import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  API_KEY_ENV,
  API_KEY_SECRET_ACCOUNT,
  apiKeyStatus,
  clearApiKey,
  maskApiKey,
  resolveApiKey,
  storeApiKey,
  validateApiKey,
} from "./api-key.js";
import { enableDefaultNetwork, loadConfig, writeDefaultConfig } from "./config.js";
import { SOLANA_MAINNET_CAIP2 } from "./networks.js";
import type { SecretStore } from "./secret-store.js";

const KEY = "vapi_sk_0123456789abcdefghij";
const OTHER_KEY = "vapi_sk_zyxwvutsrqponmlkjihg";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function home(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  directories.push(path);
  return path;
}

/** An OS secret store in a plain object, so no test ever touches a keychain. */
function secretStoreStub(entries: Record<string, string> = {}): SecretStore {
  return {
    available: true,
    platform: "darwin",
    description: "the macOS Keychain",
    get: async (name) => entries[name],
    has: async (name) => entries[name] !== undefined,
    set: async (name, value) => {
      entries[name] = value;
    },
    remove: async (name) => {
      if (entries[name] === undefined) return false;
      delete entries[name];
      return true;
    },
  };
}

/** Windows, and any platform without a credential store vAPI can drive. */
function unsupportedStore(): SecretStore {
  const refuse = (): never => {
    throw new Error("No OS secret store on this platform yet.");
  };
  return {
    available: false,
    platform: "win32",
    description: "no OS secret store",
    get: async () => refuse(),
    has: async () => refuse(),
    set: async () => refuse(),
    remove: async () => refuse(),
  };
}

describe("validateApiKey", () => {
  it("accepts a registry key and trims it", () => {
    expect(validateApiKey(` ${KEY}\n`)).toBe(KEY);
  });

  it("refuses anything that is not a vapi_sk_ key", () => {
    expect(() => validateApiKey("")).toThrow("cannot be empty");
    expect(() => validateApiKey("sk-live-1234567890abcdef")).toThrow("vapi_sk_");
    expect(() => validateApiKey("vapi_sk_short")).toThrow("vapi_sk_");
  });
});

describe("maskApiKey", () => {
  it("keeps only the last four characters", () => {
    expect(maskApiKey(KEY)).toBe("vapi_sk_…ghij");
    expect(maskApiKey(KEY)).not.toContain("0123456789");
  });
});

describe("resolveApiKey", () => {
  it("prefers the environment, then the secret store, then config.json", async () => {
    const directory = await home("vapi-api-key-order-");
    const configPath = join(directory, "config.json");
    await writeDefaultConfig(configPath, {});
    await storeApiKey(OTHER_KEY, { configPath, store: unsupportedStore(), env: {} });
    const store = secretStoreStub({ [API_KEY_SECRET_ACCOUNT]: KEY });

    expect(await resolveApiKey({ env: { [API_KEY_ENV]: " env-key " }, store, configPath })).toEqual(
      {
        key: "env-key",
        source: "env",
      },
    );
    expect(await resolveApiKey({ env: {}, store, configPath })).toEqual({
      key: KEY,
      source: "secret-store",
    });
    expect(await resolveApiKey({ env: {}, store: secretStoreStub(), configPath })).toEqual({
      key: OTHER_KEY,
      source: "config",
    });
  });

  it("falls through to config.json when the keyring will not answer", async () => {
    const directory = await home("vapi-api-key-keyring-");
    const configPath = join(directory, "config.json");
    await writeDefaultConfig(configPath, {});
    await storeApiKey(KEY, { configPath, store: unsupportedStore(), env: {} });
    const broken: SecretStore = {
      ...secretStoreStub(),
      get: async () => {
        throw new Error("the keyring is locked");
      },
    };

    expect(await resolveApiKey({ env: {}, store: broken, configPath })).toEqual({
      key: KEY,
      source: "config",
    });
  });

  it("answers undefined on a machine that has no key", async () => {
    const directory = await home("vapi-api-key-none-");
    const configPath = join(directory, "config.json");
    await writeDefaultConfig(configPath, {});

    expect(await resolveApiKey({ env: {}, store: secretStoreStub(), configPath })).toBeUndefined();
  });
});

describe("storeApiKey", () => {
  it("puts the key in the OS secret store when there is one", async () => {
    const entries: Record<string, string> = {};
    const store = secretStoreStub(entries);
    const directory = await home("vapi-api-key-store-");
    const configPath = join(directory, "config.json");
    await writeDefaultConfig(configPath, {});

    const stored = await storeApiKey(KEY, { store, configPath, env: {} });

    expect(stored).toEqual({
      source: "secret-store",
      location: "the macOS Keychain",
      masked: "vapi_sk_…ghij",
    });
    expect(entries[API_KEY_SECRET_ACCOUNT]).toBe(KEY);
    expect(await readFile(configPath, "utf8")).not.toContain(KEY);
  });

  it("writes config.json at 0600 when the platform has no secret store", async () => {
    const directory = await home("vapi-api-key-config-");
    const configPath = join(directory, "config.json");
    await writeDefaultConfig(configPath, {});

    const stored = await storeApiKey(KEY, { store: unsupportedStore(), configPath, env: {} });

    expect(stored.source).toBe("config");
    const written = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
    expect(written.apiKey).toBe(KEY);
    expect(written.discoveryUrl).toBe("https://api.vapinetwork.ai/api/call/services");
    expect((await stat(configPath)).mode & 0o777).toBe(0o600);
  });

  it("creates a config the schema still parses on a home that had none", async () => {
    const directory = await home("vapi-api-key-fresh-");
    const configPath = join(directory, "config.json");

    await storeApiKey(KEY, { store: unsupportedStore(), configPath, env: {} });

    const config = await loadConfig(configPath, {});
    expect(config.discoveryUrl).toContain("/api/call/services");
    // The parsed config must never carry the credential: it travels into the
    // MCP server, which has no business holding a provider key.
    expect(config).not.toHaveProperty("apiKey");
  });

  it("refuses a malformed key before writing anything", async () => {
    const directory = await home("vapi-api-key-bad-");
    const configPath = join(directory, "config.json");
    await writeDefaultConfig(configPath, {});

    await expect(
      storeApiKey("not-a-key", { store: unsupportedStore(), configPath, env: {} }),
    ).rejects.toThrow("vapi_sk_");
    expect(await readFile(configPath, "utf8")).not.toContain("not-a-key");
  });
});

describe("the key in config.json", () => {
  it("survives a config rewrite", async () => {
    const directory = await home("vapi-api-key-rewrite-");
    const configPath = join(directory, "config.json");
    await writeDefaultConfig(configPath, {});
    await storeApiKey(KEY, { store: unsupportedStore(), configPath, env: {} });

    await enableDefaultNetwork("solana", configPath, {});

    const written = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
    expect(written.apiKey).toBe(KEY);
    expect(written.networks).toHaveProperty(SOLANA_MAINNET_CAIP2);
  });

  it("is read even out of a config that predates the field", async () => {
    const directory = await home("vapi-api-key-legacy-");
    const configPath = join(directory, "config.json");
    await writeFile(configPath, JSON.stringify({ apiKey: KEY }), "utf8");

    expect(await resolveApiKey({ env: {}, store: secretStoreStub(), configPath })).toEqual({
      key: KEY,
      source: "config",
    });
  });
});

describe("apiKeyStatus and clearApiKey", () => {
  it("names where the key comes from without printing it", async () => {
    const directory = await home("vapi-api-key-status-");
    const configPath = join(directory, "config.json");
    await writeDefaultConfig(configPath, {});
    const store = secretStoreStub({ [API_KEY_SECRET_ACCOUNT]: KEY });

    const status = await apiKeyStatus({ env: {}, store, configPath });

    expect(status).toEqual({
      present: true,
      source: "secret-store",
      masked: "vapi_sk_…ghij",
      location: "the macOS Keychain",
    });
    expect(JSON.stringify(status)).not.toContain("0123456789");
  });

  it("reports an empty machine", async () => {
    const directory = await home("vapi-api-key-status-empty-");
    const configPath = join(directory, "config.json");

    expect(await apiKeyStatus({ env: {}, store: secretStoreStub(), configPath })).toEqual({
      present: false,
    });
  });

  it("removes the key from both places and names an environment copy", async () => {
    const directory = await home("vapi-api-key-clear-");
    const configPath = join(directory, "config.json");
    await writeDefaultConfig(configPath, {});
    const entries: Record<string, string> = {};
    const store = secretStoreStub(entries);
    await storeApiKey(KEY, { store, configPath, env: {} });
    await storeApiKey(OTHER_KEY, { store: unsupportedStore(), configPath, env: {} });

    const cleared = await clearApiKey({ env: { [API_KEY_ENV]: KEY }, store, configPath });

    expect(cleared).toEqual({ cleared: ["secret-store", "config"], envStillSet: true });
    expect(entries[API_KEY_SECRET_ACCOUNT]).toBeUndefined();
    expect(await readFile(configPath, "utf8")).not.toContain(OTHER_KEY);
    expect(await clearApiKey({ env: {}, store, configPath })).toEqual({
      cleared: [],
      envStillSet: false,
    });
  });
});
