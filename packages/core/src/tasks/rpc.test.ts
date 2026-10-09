import { describe, expect, it, vi } from "vitest";

import type { AgentCashConfig } from "../config.js";
import { TasksChainError } from "./chain-port.js";
import { createTasksRpcFor } from "./rpc.js";

function config(networks: AgentCashConfig["networks"] = {}): AgentCashConfig {
  return { allowPrivateNetwork: true, networks } as AgentCashConfig;
}

function rpcFetch() {
  return vi.fn<typeof fetch>(async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as { id: number; method: string };
    const chainId = request.method === "eth_chainId" ? "0x2105" : null;
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: chainId }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
}

describe("createTasksRpcFor", () => {
  it("uses the configured Base mainnet RPC and caches its client", async () => {
    const fetch = rpcFetch();
    const rpcFor = createTasksRpcFor(
      config({
        "eip155:8453": {
          rpcUrl: "https://base.example/rpc",
          usdc: "0x0000000000000000000000000000000000000001",
        },
      }),
      { fetch, env: {} },
    );

    const client = rpcFor(8453);
    expect(rpcFor(8453)).toBe(client);
    await client.getChainId();
    expect(fetch).toHaveBeenCalledWith(
      "https://base.example/rpc",
      expect.objectContaining({ method: "POST", redirect: "manual" }),
    );
  });

  it("uses the Base Sepolia environment override and public fallback", () => {
    const configured = config();
    const fromEnv = createTasksRpcFor(configured, {
      env: { BASE_SEPOLIA_RPC_URL: " https://sepolia.example/rpc " },
    })(84532);
    const fallback = createTasksRpcFor(configured, { env: {} })(84532);

    expect(fromEnv.chain?.rpcUrls.default.http).toEqual(["https://sepolia.example/rpc"]);
    expect(fallback.chain?.rpcUrls.default.http).toEqual(["https://sepolia.base.org"]);
  });

  it("requires an Arc testnet RPC", () => {
    expect(() => createTasksRpcFor(config(), { env: {} })(5042002)).toThrow(
      /Arc testnet RPC is required/u,
    );
  });

  it("rejects every other chain without claiming a broadcast", () => {
    let thrown: unknown;
    try {
      createTasksRpcFor(config(), { env: {} })(1);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(TasksChainError);
    expect(thrown).toMatchObject({ broadcast: false, authorizationExposed: false });
  });
});
