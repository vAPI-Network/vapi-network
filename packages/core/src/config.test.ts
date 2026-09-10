import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_DISCOVERY_URL,
  DEFAULT_MARKETPLACE_DISCOVERY_URL,
  DEFAULT_REGISTRY_FALLBACKS,
  getDefaultConfig,
  loadConfig,
} from "./config.js";
import { BASE_MAINNET_CAIP2, NETWORKS } from "./networks.js";

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
