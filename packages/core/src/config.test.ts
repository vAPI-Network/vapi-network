import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  configSchema,
  DEFAULT_DISCOVERY_URL,
  DEFAULT_MARKETPLACE_DISCOVERY_URL,
  DEFAULT_REGISTRY_FALLBACKS,
  getDefaultConfig,
  loadConfig,
  migrateLegacyRegistryConfig,
  rewriteLegacyRegistryUrl,
  rewriteLegacyRegistryUrls,
} from "./config.js";
import { BASE_MAINNET_CAIP2, NETWORKS, SOLANA_MAINNET_CAIP2 } from "./networks.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("vAPI config", () => {
  it("uses the api host by default and derives both paths from VAPI_REGISTRY_URL", () => {
    expect(getDefaultConfig({})).toMatchObject({
      discoveryUrl: DEFAULT_DISCOVERY_URL,
      marketplaceDiscoveryUrl: DEFAULT_MARKETPLACE_DISCOVERY_URL,
      registryFallbacks: DEFAULT_REGISTRY_FALLBACKS,
    });
    expect(getDefaultConfig({ VAPI_REGISTRY_URL: "https://registry.example/base/" })).toMatchObject(
      {
        discoveryUrl: "https://registry.example/base/api/call/services",
        marketplaceDiscoveryUrl: "https://registry.example/base/api/call/discovery",
      },
    );
  });

  it("adds the documented Solana mainnet RPC and USDC when selected", () => {
    expect(getDefaultConfig({}, { networks: ["base", "solana"] }).networks).toMatchObject({
      [BASE_MAINNET_CAIP2]: {
        rpcUrl: "https://mainnet.base.org",
        usdc: NETWORKS[BASE_MAINNET_CAIP2].usdc,
      },
      [SOLANA_MAINNET_CAIP2]: {
        rpcUrl: "https://api.mainnet-beta.solana.com",
        usdc: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      },
    });
  });

  it("rejects a non-canonical mint for the Solana mainnet config", () => {
    const config = getDefaultConfig({}, { networks: ["solana"] });
    config.networks[SOLANA_MAINNET_CAIP2]!.usdc = "So11111111111111111111111111111111111111112";

    expect(() => configSchema.parse(config)).toThrow(/canonical Solana mainnet USDC mint/);
  });

  it("keeps existing config files compatible and allows environment overrides", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vapi-mcp-config-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "config.json");
    await writeFile(
      path,
      JSON.stringify({
        discoveryUrl: "https://console.example/api/network/services",
        networks: {
          [BASE_MAINNET_CAIP2]: {
            rpcUrl: "https://rpc.example",
            usdc: NETWORKS[BASE_MAINNET_CAIP2].usdc,
            depositUrl: "https://bridge.example/base",
            depositInstructions: "Send USDC on Base.",
          },
        },
        spendCaps: { perCallAtomic: "100000", perDayAtomic: "1000000" },
      }),
    );

    await expect(loadConfig(path, {})).resolves.toMatchObject({
      marketplaceDiscoveryUrl: DEFAULT_MARKETPLACE_DISCOVERY_URL,
      registryFallbacks: DEFAULT_REGISTRY_FALLBACKS,
      networks: {
        [BASE_MAINNET_CAIP2]: {
          depositUrl: "https://bridge.example/base",
          depositInstructions: "Send USDC on Base.",
        },
      },
    });
    const configured = await loadConfig(path, {
      VAPI_MARKETPLACE_DISCOVERY_URL: "https://console.example/api/marketplace/discovery",
      VAPI_WORK_API_URL: "https://console.example/v1/",
      VAPI_ACCESS_TOKEN: "vapi_at_agent-token",
    });
    expect(configured).toMatchObject({
      marketplaceDiscoveryUrl: "https://console.example/api/marketplace/discovery",
    });
    expect(configured).not.toHaveProperty("workApiUrl");
    expect(configured).not.toHaveProperty("accessToken");

    const registryOverride = await loadConfig(path, {
      VAPI_REGISTRY_URL: "https://registry.example",
    });
    expect(registryOverride).toMatchObject({
      discoveryUrl: "https://registry.example/api/call/services",
      marketplaceDiscoveryUrl: "https://registry.example/api/call/discovery",
    });
  });
});

describe("retired registry URLs", () => {
  it("moves the console hosts and the pre-Call paths onto the canonical pair", () => {
    expect(
      rewriteLegacyRegistryUrl("https://console-staging.vapinetwork.ai/api/network/services"),
    ).toBe("https://api-staging.vapinetwork.ai/api/call/services");
    expect(
      rewriteLegacyRegistryUrl("https://console.vapinetwork.ai/api/marketplace/discovery"),
    ).toBe("https://api.vapinetwork.ai/api/call/discovery");
    expect(rewriteLegacyRegistryUrl("https://console.vapinetwork.ai/api/call/services")).toBe(
      "https://api.vapinetwork.ai/api/call/services",
    );
  });

  it("returns anything that is not a retired vAPI registry URL byte for byte", () => {
    for (const value of [
      DEFAULT_DISCOVERY_URL,
      "https://console.example/api/network/services",
      "https://registry.example/base/api/call/services",
      "https://api.vapinetwork.ai",
      "not a url",
      "",
    ]) {
      expect(rewriteLegacyRegistryUrl(value)).toBe(value);
    }
  });

  it("rewrites both endpoints and every fallback without mutating the input", () => {
    const config = configSchema.parse({
      discoveryUrl: "https://console-staging.vapinetwork.ai/api/network/services",
      marketplaceDiscoveryUrl: "https://console-staging.vapinetwork.ai/api/marketplace/discovery",
      registryFallbacks: [
        {
          discoveryUrl: "https://console.vapinetwork.ai/api/network/services",
          marketplaceDiscoveryUrl: "https://console.vapinetwork.ai/api/marketplace/discovery",
        },
      ],
      networks: {},
      spendCaps: { perCallAtomic: "100000", perDayAtomic: "1000000" },
    });

    const { config: rewritten, changes } = rewriteLegacyRegistryUrls(config);

    expect(changes).toHaveLength(4);
    expect(changes[0]).toEqual({
      field: "discoveryUrl",
      from: "https://console-staging.vapinetwork.ai/api/network/services",
      to: "https://api-staging.vapinetwork.ai/api/call/services",
    });
    expect(rewritten.registryFallbacks).toEqual([
      {
        discoveryUrl: DEFAULT_DISCOVERY_URL,
        marketplaceDiscoveryUrl: DEFAULT_MARKETPLACE_DISCOVERY_URL,
      },
    ]);
    expect(config.discoveryUrl).toBe("https://console-staging.vapinetwork.ai/api/network/services");
    expect(rewriteLegacyRegistryUrls(rewritten).config).toBe(rewritten);
  });

  it("repairs a stale config file in memory and notices it once", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vapi-legacy-registry-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "config.json");
    await writeFile(
      path,
      JSON.stringify({
        discoveryUrl: "https://console-staging.vapinetwork.ai/api/network/services",
        marketplaceDiscoveryUrl: "https://console-staging.vapinetwork.ai/api/marketplace/discovery",
        networks: {},
        spendCaps: { perCallAtomic: "100000", perDayAtomic: "1000000" },
      }),
    );
    const notice = vi.fn();

    const config = await loadConfig(path, {}, { notice });

    expect(config).toMatchObject({
      discoveryUrl: "https://api-staging.vapinetwork.ai/api/call/services",
      marketplaceDiscoveryUrl: "https://api-staging.vapinetwork.ai/api/call/discovery",
    });
    expect(notice).toHaveBeenCalledOnce();
    expect(notice.mock.calls[0]?.[0]).toContain("Rewrote retired vAPI registry URLs");
    // loadConfig never writes; only vapi init owns the file.
    expect(await readFile(path, "utf8")).toContain("console-staging.vapinetwork.ai");

    expect(await migrateLegacyRegistryConfig(path)).toHaveLength(2);
    const written = JSON.parse(await readFile(path, "utf8")) as { discoveryUrl: string };
    expect(written.discoveryUrl).toBe("https://api-staging.vapinetwork.ai/api/call/services");
    expect(await migrateLegacyRegistryConfig(path)).toEqual([]);
  });

  it("stays silent for a current config and for a missing file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vapi-current-registry-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "config.json");
    await writeFile(path, JSON.stringify(getDefaultConfig({})));
    const notice = vi.fn();

    await loadConfig(path, {}, { notice });

    expect(notice).not.toHaveBeenCalled();
    expect(await migrateLegacyRegistryConfig(join(directory, "absent.json"))).toEqual([]);
  });
});
