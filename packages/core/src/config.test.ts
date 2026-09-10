import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_MARKETPLACE_DISCOVERY_URL, loadConfig } from "./config.js";
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
          },
        },
        spendCaps: { perCallAtomic: "100000", perDayAtomic: "1000000" },
      }),
    );

    await expect(loadConfig(path, {})).resolves.toMatchObject({
      marketplaceDiscoveryUrl: DEFAULT_MARKETPLACE_DISCOVERY_URL,
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
  });
});
