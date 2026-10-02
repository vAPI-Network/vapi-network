import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";

import { agentSecretAccounts } from "./agent-link.js";
import { agentProfileSchema, type AgentGrant } from "./agent-profile.js";
import { configSchema, getDefaultConfig, type VapiConfig } from "./config.js";
import * as index from "./index.js";
import {
  createMemberBundle,
  headlessConfigFromBundle,
  MEMBER_BUNDLE_MAX_BYTES,
  MemberBundleError,
  memberBundleConfig,
  openMemberBundle,
  readMemberCredentials,
  type MemberBundle,
} from "./member-bundle.js";
import {
  ARC_MAINNET_CAIP2,
  ARC_TESTNET_CAIP2,
  BASE_MAINNET_CAIP2,
  NETWORKS,
  SOLANA_MAINNET_CAIP2,
} from "./networks.js";
import { memorySecretStore, type SecretStore } from "./secret-store.js";
import * as secrets from "./secrets.js";
import { createVault, exportMemberKey } from "./vault.js";

const PRIVATE_KEY = "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" as const;
const OTHER_KEY = "0xfedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210" as const;
const ADDRESS = privateKeyToAccount(PRIVATE_KEY).address;
const OWNER = "0x1111111111111111111111111111111111111111" as const;
const RUN_ID = "run_0123456789abcdef01234567";
const PARENT_RUN_ID = "run_89abcdef0123456789abcdef";
const LINKED_AT = "2026-09-28T12:00:00.000Z";
const VAULT_KEY = Buffer.alloc(32, 7);
const NOW = () => new Date(LINKED_AT);
// Hardhat's well-known phrase: its words cannot collide with a JSON key below.
const FIXTURE_PHRASE = "test test test test test test test test test test test junk";

const ALPHA_TOKENS = JSON.stringify({
  accessToken: "alpha-access-7f3",
  refreshToken: "alpha-refresh-7f3",
  expiresAt: 4_102_444_800_000,
  scopes: ["mcp:call", "router.use"],
});
const ALPHA_REMOTE_TOKENS = JSON.stringify({
  accessToken: "alpha-access-7f3",
  expiresAt: 4_102_444_800_000,
  scopes: ["mcp:call", "router.use"],
  refreshable: false,
});
const ALPHA_STAKE = "alpha-router-stake-key-91c";
const ALPHA_BALANCE = "alpha-router-balance-key-91c";
const BETA_TOKENS = JSON.stringify({
  accessToken: "beta-access-4d2",
  refreshToken: "beta-refresh-4d2",
  expiresAt: 4_102_444_800_000,
  scopes: ["mcp:call", "router.use"],
});
const BETA_STAKE = "beta-router-stake-key-5e8";
const BETA_BALANCE = "beta-router-balance-key-5e8";

const directories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

function profile(grants: AgentGrant[] = ["read"]) {
  return agentProfileSchema.parse({
    version: 1,
    name: "alpha",
    wallet: "alpha",
    model: "model-a",
    instructions: "Find the cheapest weather listing and report it.",
    grants,
    createdAt: LINKED_AT,
  });
}

function bundleInput(overrides: Partial<Omit<MemberBundle, "v">> = {}): Omit<MemberBundle, "v"> {
  return {
    account: "alpha",
    address: ADDRESS,
    privateKey: PRIVATE_KEY,
    swarm: "crew",
    profile: profile(),
    link: {
      apiBase: "https://api.vapinetwork.ai",
      clientId: "client-alpha",
      owner: OWNER,
      label: "alpha",
      scopes: ["mcp:call", "router.use"],
      linkedAt: LINKED_AT,
    },
    credentials: { tokens: ALPHA_REMOTE_TOKENS, routerStake: ALPHA_STAKE },
    caps: { perCallAtomic: "100000", perDayAtomic: "1000000" },
    allowanceExpiresAt: "2026-09-30T00:00:00.000Z",
    ceilingAtomic: "5000000",
    config: memberBundleConfig(getDefaultConfig({}), BASE_MAINNET_CAIP2),
    runId: RUN_ID,
    parentRunId: PARENT_RUN_ID,
    ...overrides,
  };
}

function decode(text: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(text, "base64url").toString("utf8")) as Record<string, unknown>;
}

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function tampered(mutate: (bundle: Record<string, unknown>) => void): string {
  const bundle = decode(createMemberBundle(bundleInput()));
  mutate(bundle);
  return encode(bundle);
}

function expectBundleError(run: () => unknown, code: string): MemberBundleError {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(MemberBundleError);
  expect(caught).toMatchObject({ code });
  return caught as MemberBundleError;
}

describe("member bundle", () => {
  it("round-trips through create and open", () => {
    const input = bundleInput();
    const text = createMemberBundle(input);

    expect(text).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(openMemberBundle(text)).toEqual({ ...input, v: 1 });
  });

  it("removes the delegate and allocate grants from the profile", () => {
    const text = createMemberBundle(
      bundleInput({ profile: profile(["read", "delegate", "allocate"]) }),
    );

    expect(openMemberBundle(text).profile.grants).toEqual(["read"]);
  });

  it("refuses an opened bundle whose profile holds a remote-blocked grant", () => {
    const text = tampered((bundle) => {
      (bundle.profile as { grants: string[] }).grants = ["read", "delegate"];
    });
    expectBundleError(() => openMemberBundle(text), "invalid");
  });

  it("rejects an unknown top-level key", () => {
    expectBundleError(
      () => openMemberBundle(tampered((bundle) => (bundle.phrase = "anything"))),
      "invalid",
    );
    expectBundleError(
      () => createMemberBundle({ ...bundleInput(), extra: true } as Omit<MemberBundle, "v">),
      "invalid",
    );
  });

  it("rejects an unknown key inside credentials, link, caps and profile", () => {
    for (const field of ["credentials", "link", "caps", "profile"]) {
      const text = tampered((bundle) => {
        (bundle[field] as Record<string, unknown>).otherTokens = "x";
      });
      expectBundleError(() => openMemberBundle(text), "invalid");
    }
  });

  it("rejects an apiKey in the config", () => {
    const text = tampered((bundle) => {
      (bundle.config as Record<string, unknown>).apiKey = "registry-key-9a1";
    });
    const error = expectBundleError(() => openMemberBundle(text), "invalid");
    expect(error.message).not.toContain("registry-key-9a1");
  });

  it("rejects a bad run id and a bad parent run id", () => {
    expectBundleError(() => createMemberBundle(bundleInput({ runId: "run_nothex" })), "invalid");
    expectBundleError(
      () => openMemberBundle(tampered((bundle) => (bundle.parentRunId = "run_1"))),
      "invalid",
    );
  });

  it("rejects a private key that does not match the address, without echoing either", () => {
    const text = tampered((bundle) => (bundle.privateKey = OTHER_KEY));
    const error = expectBundleError(() => openMemberBundle(text), "key_mismatch");

    expect(error.message).not.toContain(OTHER_KEY.slice(2));
    expect(error.message).not.toContain(PRIVATE_KEY.slice(2));
    expect(error.message).not.toContain(text);
    expectBundleError(
      () => createMemberBundle(bundleInput({ privateKey: OTHER_KEY })),
      "key_mismatch",
    );
  });

  it("never puts the key or bundle text in a schema error", () => {
    const text = tampered((bundle) => (bundle.ceilingAtomic = "-1"));
    const error = expectBundleError(() => openMemberBundle(text), "invalid");

    expect(error.message).toContain("ceilingAtomic");
    expect(error.message).not.toContain(PRIVATE_KEY.slice(2));
    expect(error.message).not.toContain(text);
  });

  it("rejects text that is not base64url", () => {
    const text = createMemberBundle(bundleInput());
    expectBundleError(() => openMemberBundle(`${text}=`), "invalid");
    expectBundleError(() => openMemberBundle(`${text.slice(0, 10)}+/${text.slice(10)}`), "invalid");
    expectBundleError(() => openMemberBundle(""), "invalid");
    expectBundleError(() => openMemberBundle(encode("not a bundle")), "invalid");
    expectBundleError(() => openMemberBundle("bm90IGpzb24"), "invalid");
  });

  it("refuses to create a bundle larger than the bound", () => {
    const input = bundleInput({
      credentials: {
        tokens: ALPHA_REMOTE_TOKENS,
        routerStake: "a".repeat(MEMBER_BUNDLE_MAX_BYTES),
      },
    });
    expectBundleError(() => createMemberBundle(input), "too_large");
  });

  it("refuses to open oversized text before decoding it", () => {
    const parse = vi.spyOn(JSON, "parse");
    expectBundleError(() => openMemberBundle("A".repeat(MEMBER_BUNDLE_MAX_BYTES + 1)), "too_large");
    expect(parse).not.toHaveBeenCalled();
  });

  it("is exported from the secrets entry point only", () => {
    for (const name of [
      "exportMemberKey",
      "createMemberBundle",
      "openMemberBundle",
      "readMemberCredentials",
    ]) {
      expect(typeof Reflect.get(secrets, name)).toBe("function");
      expect(Reflect.has(index, name)).toBe(false);
    }
  });
});

describe("readMemberCredentials", () => {
  function twoLinkedAccounts(): { store: SecretStore; reads: string[] } {
    const alpha = agentSecretAccounts("alpha");
    const beta = agentSecretAccounts("beta");
    const inner = memorySecretStore({
      [alpha.tokens]: ALPHA_TOKENS,
      [alpha.routerStake]: ALPHA_STAKE,
      [alpha.routerBalance]: ALPHA_BALANCE,
      [beta.tokens]: BETA_TOKENS,
      [beta.routerStake]: BETA_STAKE,
      [beta.routerBalance]: BETA_BALANCE,
    });
    const reads: string[] = [];
    const store: SecretStore = {
      ...inner,
      async get(name) {
        reads.push(name);
        return await inner.get(name);
      },
    };
    return { store, reads };
  }

  it("reads exactly one account's three secret names and nothing else", async () => {
    const { store, reads } = twoLinkedAccounts();

    const credentials = await readMemberCredentials({ secrets: store, account: "alpha" });

    expect(credentials).toEqual({
      tokens: ALPHA_REMOTE_TOKENS,
      routerStake: ALPHA_STAKE,
      routerBalance: ALPHA_BALANCE,
    });
    const alpha = agentSecretAccounts("alpha");
    expect(reads.sort()).toEqual([alpha.routerBalance, alpha.routerStake, alpha.tokens].sort());
  });

  it("builds a bundle that carries none of another account's credentials", async () => {
    const { store } = twoLinkedAccounts();
    const credentials = await readMemberCredentials({ secrets: store, account: "alpha" });

    const text = createMemberBundle(bundleInput({ credentials }));
    const json = Buffer.from(text, "base64url").toString("utf8");

    for (const secret of [
      BETA_TOKENS,
      BETA_STAKE,
      BETA_BALANCE,
      "beta-access-4d2",
      "beta-refresh-4d2",
    ]) {
      expect(json).not.toContain(secret);
      expect(text).not.toContain(secret);
    }
    expect(openMemberBundle(text).credentials).toEqual(credentials);
  });

  it("leaves the optional Router keys out when the account has none", async () => {
    const store = memorySecretStore({ [agentSecretAccounts("alpha").tokens]: ALPHA_TOKENS });

    await expect(readMemberCredentials({ secrets: store, account: "alpha" })).resolves.toEqual({
      tokens: ALPHA_REMOTE_TOKENS,
    });
  });

  it("never accepts an owner's refresh token in a member bundle", () => {
    expectBundleError(
      () =>
        createMemberBundle(
          bundleInput({ credentials: { tokens: ALPHA_TOKENS, routerStake: ALPHA_STAKE } }),
        ),
      "invalid",
    );
  });

  it("refuses an account that is not linked", async () => {
    const store = memorySecretStore({ [agentSecretAccounts("beta").tokens]: BETA_TOKENS });

    await expect(readMemberCredentials({ secrets: store, account: "alpha" })).rejects.toMatchObject(
      {
        code: "not_linked",
        message: expect.stringContaining("not linked"),
      },
    );
  });
});

describe("a bundle built from a vault", () => {
  it("carries the member key and never the recovery phrase", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vapi-member-bundle-"));
    directories.push(directory);
    const path = join(directory, "vault.json");
    const vault = await createVault({ path, key: VAULT_KEY, phrase: FIXTURE_PHRASE, now: NOW });
    const account = await vault.deriveAccount("alpha");

    const privateKey = await exportMemberKey({ path, key: VAULT_KEY, name: "alpha" });
    const text = createMemberBundle(
      bundleInput({ address: account.address, privateKey, profile: profile() }),
    );
    const json = Buffer.from(text, "base64url").toString("utf8");

    expect(openMemberBundle(text).privateKey).toBe(privateKey);
    expect(json).not.toContain(FIXTURE_PHRASE);
    const words = FIXTURE_PHRASE.split(" ");
    for (const word of new Set(words)) {
      expect(json).not.toMatch(new RegExp(`\\b${word}\\b`, "u"));
    }
    for (let start = 0; start + 3 <= words.length; start += 1) {
      expect(json).not.toContain(words.slice(start, start + 3).join(" "));
    }
  });
});

/** An owner config whose RPC URLs embed provider API keys, as real ones often do. */
function ownerConfigWithSecrets(): VapiConfig {
  const base = getDefaultConfig({});
  return {
    ...base,
    networks: {
      [BASE_MAINNET_CAIP2]: {
        rpcUrl: "https://base.example/rpc?apikey=SECRET",
        // A hand-edited value: the bundle takes USDC from the network definition.
        usdc: "0x0000000000000000000000000000000000000001",
      },
      [ARC_MAINNET_CAIP2]: {
        rpcUrl: "https://arc.example/v2/SECRET-ARC",
        usdc: NETWORKS[ARC_MAINNET_CAIP2].usdc,
      },
      // No public RPC default: a member bundle cannot run on it, so it is dropped.
      [ARC_TESTNET_CAIP2]: {
        rpcUrl: "https://arc-testnet.example/SECRET-TESTNET",
        usdc: NETWORKS[ARC_TESTNET_CAIP2].usdc,
      },
    },
    apiKey: "vapi_sk_SECRET_REGISTRY_KEY",
  } as VapiConfig;
}

describe("member bundle config", () => {
  it("carries the swarm network id and USDC only, never an owner RPC URL or API key", () => {
    const config = memberBundleConfig(ownerConfigWithSecrets(), BASE_MAINNET_CAIP2);

    expect(config).toEqual({
      discoveryUrl: getDefaultConfig({}).discoveryUrl,
      marketplaceDiscoveryUrl: getDefaultConfig({}).marketplaceDiscoveryUrl,
      networks: {
        [BASE_MAINNET_CAIP2]: { usdc: NETWORKS[BASE_MAINNET_CAIP2].usdc },
      },
    });
    const json = Buffer.from(createMemberBundle(bundleInput({ config })), "base64url").toString(
      "utf8",
    );
    for (const absent of ["SECRET", "rpcUrl", "apiKey", "base.example", "arc.example"]) {
      expect(json).not.toContain(absent);
    }
  });

  it("limits client configuration to the swarm network without limiting key authority", () => {
    // The Railway gate checks every known EVM USDC network separately. Omitting
    // a network here does not stop the exported key from controlling its address there.
    expect(memberBundleConfig(ownerConfigWithSecrets(), ARC_MAINNET_CAIP2).networks).toEqual({
      [ARC_MAINNET_CAIP2]: { usdc: NETWORKS[ARC_MAINNET_CAIP2].usdc },
    });
  });

  it.each([
    ["has no public RPC default", ARC_TESTNET_CAIP2],
    ["is not enabled in the owner's config", SOLANA_MAINNET_CAIP2],
  ])("refuses a swarm network that %s", (_reason, network) => {
    const error = expectBundleError(
      () => memberBundleConfig(ownerConfigWithSecrets(), network),
      "unsupported_network",
    );
    expect(error.message).toContain(network);
    expect(error.message).not.toContain("SECRET");
  });

  it("rejects an opened bundle that carries more than one network", () => {
    const text = tampered((bundle) => {
      (bundle.config as { networks: Record<string, unknown> }).networks[ARC_MAINNET_CAIP2] = {
        usdc: NETWORKS[ARC_MAINNET_CAIP2].usdc,
      };
    });
    expectBundleError(() => openMemberBundle(text), "invalid");
  });

  it("refuses to create a bundle from the owner's full config", () => {
    const error = expectBundleError(
      () =>
        createMemberBundle(
          bundleInput({ config: ownerConfigWithSecrets() as unknown as MemberBundle["config"] }),
        ),
      "invalid",
    );
    expect(error.message).not.toContain("SECRET");
  });

  it("rejects an opened bundle whose config carries an rpcUrl, anywhere", () => {
    for (const mutate of [
      (config: Record<string, unknown>) => {
        (config.networks as Record<string, Record<string, unknown>>)[BASE_MAINNET_CAIP2]!.rpcUrl =
          "https://base.example/rpc?apikey=SECRET";
      },
      (config: Record<string, unknown>) => {
        config.rpcUrl = "https://base.example/rpc?apikey=SECRET";
      },
    ]) {
      const text = tampered((bundle) => mutate(bundle.config as Record<string, unknown>));
      const error = expectBundleError(() => openMemberBundle(text), "invalid");
      expect(error.message).not.toContain("SECRET");
    }
  });

  it("rejects an opened bundle whose config carries an apiKey inside a network", () => {
    const text = tampered((bundle) => {
      const networks = (bundle.config as { networks: Record<string, Record<string, unknown>> })
        .networks;
      networks[BASE_MAINNET_CAIP2]!.apiKey = "provider-key-SECRET";
    });
    const error = expectBundleError(() => openMemberBundle(text), "invalid");
    expect(error.message).not.toContain("SECRET");
  });

  it("rejects an opened bundle whose network has no public RPC default", () => {
    const text = tampered((bundle) => {
      (bundle.config as { networks: Record<string, unknown> }).networks[ARC_TESTNET_CAIP2] = {
        usdc: NETWORKS[ARC_TESTNET_CAIP2].usdc,
      };
    });
    expectBundleError(() => openMemberBundle(text), "invalid");
  });

  it.each([
    ["discoveryUrl", "https://api.example/services?key=SECRET"],
    ["discoveryUrl", "https://user:SECRET@api.example/services"],
    ["discoveryUrl", "https://SECRET@api.example/services"],
    ["marketplaceDiscoveryUrl", "https://api.example/discovery#SECRET"],
    ["marketplaceDiscoveryUrl", "https://api.example/discovery?SECRET"],
  ] as const)("refuses an owner %s that could carry credentials: %s", (field, url) => {
    const owner = { ...getDefaultConfig({}), [field]: url };
    const error = expectBundleError(
      () => memberBundleConfig(owner, BASE_MAINNET_CAIP2),
      "unsafe_config",
    );
    expect(error.message).toContain(field);
    expect(error.message).not.toContain("SECRET");
  });

  it("rejects an opened bundle whose discovery URL carries a query string", () => {
    const text = tampered((bundle) => {
      (bundle.config as Record<string, unknown>).discoveryUrl =
        "https://api.example/services?key=SECRET";
    });
    const error = expectBundleError(() => openMemberBundle(text), "invalid");
    expect(error.message).not.toContain("SECRET");
  });

  it("expands back to a valid config on the public RPC defaults", () => {
    const expanded = headlessConfigFromBundle(
      memberBundleConfig(ownerConfigWithSecrets(), BASE_MAINNET_CAIP2),
    );

    expect(configSchema.parse(expanded)).toEqual(expanded);
    expect(expanded.networks).toEqual({
      [BASE_MAINNET_CAIP2]: {
        rpcUrl: "https://mainnet.base.org",
        usdc: NETWORKS[BASE_MAINNET_CAIP2].usdc,
      },
    });
    expect(JSON.stringify(expanded)).not.toContain("SECRET");
    expect(
      headlessConfigFromBundle(memberBundleConfig(ownerConfigWithSecrets(), ARC_MAINNET_CAIP2))
        .networks,
    ).toEqual({
      [ARC_MAINNET_CAIP2]: {
        rpcUrl: NETWORKS[ARC_MAINNET_CAIP2].publicRpcUrl,
        usdc: NETWORKS[ARC_MAINNET_CAIP2].usdc,
      },
    });
    expect(
      headlessConfigFromBundle(
        memberBundleConfig(
          {
            ...getDefaultConfig({}),
            networks: {
              [SOLANA_MAINNET_CAIP2]: {
                rpcUrl: "https://solana.example/SECRET",
                usdc: NETWORKS[SOLANA_MAINNET_CAIP2].usdc,
              },
            },
          },
          SOLANA_MAINNET_CAIP2,
        ),
      ).networks[SOLANA_MAINNET_CAIP2]?.rpcUrl,
    ).toBe(NETWORKS[SOLANA_MAINNET_CAIP2].publicRpcUrl);
  });

  it("keeps the config helpers on the secrets entry point only", () => {
    for (const name of ["memberBundleConfig", "headlessConfigFromBundle"]) {
      expect(typeof Reflect.get(secrets, name)).toBe("function");
      expect(Reflect.has(index, name)).toBe(false);
    }
  });
});
