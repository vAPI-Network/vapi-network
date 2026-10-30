import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { createMcpHost } from "./host.js";
import type { SignerRequest, SignerResponse } from "../signer/messages.js";

async function request(socketPath: string, lines: string[], expected?: number): Promise<unknown[]> {
  const socket = connect(socketPath);
  const replies: unknown[] = [];
  let buffer = "";
  const done = new Promise<void>((resolve, reject) => {
    socket.on("error", reject);
    socket.setTimeout(2000, () => reject(new Error("Timed out waiting for MCP replies.")));
    socket.on("connect", () => {
      for (const line of lines) socket.write(`${line}\n`);
    });
    socket.on("end", () => {
      if (expected === undefined || replies.length === expected) resolve();
      else reject(new Error(`Expected ${expected} replies, received ${replies.length}.`));
    });
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let index = buffer.indexOf("\n");
      while (index >= 0) {
        try {
          replies.push(JSON.parse(buffer.slice(0, index)));
        } catch (error) {
          reject(error);
          return;
        }
        buffer = buffer.slice(index + 1);
        if (replies.length === expected) resolve();
        index = buffer.indexOf("\n");
      }
    });
  });
  try {
    await done;
    // JSON-RPC lets the server answer concurrent requests in any order.
    const id = (reply: unknown) =>
      Number((reply as { id?: unknown }).id ?? Number.MAX_SAFE_INTEGER);
    return replies.sort((a, b) => id(a) - id(b));
  } finally {
    socket.destroy();
  }
}

describe("createMcpHost", () => {
  let home: string;
  let host: Awaited<ReturnType<typeof createMcpHost>>;
  let claude: ReturnType<typeof privateKeyToAccount>;
  let research: ReturnType<typeof privateKeyToAccount>;
  let seen: SignerRequest[];
  afterEach(async () => {
    await host?.close();
    await rm(home, { recursive: true, force: true });
  });

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "mcp-host-"));
    // Minimal config core's configSchema accepts: every network needs a USDC
    // address and spendCaps is required (packages/core/src/config.ts).
    await writeFile(
      join(home, "config.json"),
      JSON.stringify({
        discoveryUrl: "https://vapinetwork.ai/api/discovery",
        networks: {
          "eip155:8453": {
            rpcUrl: "https://mainnet.base.org",
            usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
          },
        },
        spendCaps: { perCallAtomic: "100000", perDayAtomic: "1000000" },
      }),
    );
    claude = privateKeyToAccount(generatePrivateKey());
    research = privateKeyToAccount(generatePrivateKey());
    seen = [];
    const signer = async (message: SignerRequest): Promise<SignerResponse> => {
      seen.push(message);
      if (message.type === "listWallets") {
        return {
          ok: true,
          type: "listWallets",
          wallets: [claude, research].map((account, index) => ({
            name: index === 0 ? "claude" : "research",
            address: account.address,
            publicKey: account.publicKey,
            caps: { perCallAtomic: "1000000", perDayAtomic: "5000000" },
            spentTodayAtomic: "0",
          })),
        };
      }
      return { ok: false, code: "error", message: "unexpected" };
    };
    host = await createMcpHost({
      socketPath: join(home, "mcp.sock"),
      home,
      signer,
    });
  });

  it("restricts the socket and its parent directory to this user", async () => {
    expect((await stat(join(home, "mcp.sock"))).mode & 0o777).toBe(0o600);
    expect((await stat(home)).mode & 0o777).toBe(0o700);
  });

  it("serves tools/list over the socket and asks the signer for wallet facts, never a key", async () => {
    const replies = (await request(
      join(home, "mcp.sock"),
      [
        JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
        JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
      ],
      2,
    )) as { id: number; result: { tools?: { name: string }[] } }[];
    expect(replies[0]?.id).toBe(1);
    const names = replies[1]?.result.tools?.map((tool) => tool.name) ?? [];
    expect(names).toContain("call.search");
    expect(names).toContain("wallet.address");
    expect(seen.map((message) => message.type)).toEqual(["listWallets"]);
  });

  it("uses the research hello wallet for wallet.address", async () => {
    const replies = (await request(
      join(home, "mcp.sock"),
      [
        JSON.stringify({ vapiDesktop: 1, wallet: "research" }),
        JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
        JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "wallet.address" },
        }),
      ],
      2,
    )) as { id: number; result: unknown }[];
    expect(replies[0]?.id).toBe(1);
    expect(replies[1]?.id).toBe(2);
    expect(JSON.stringify(replies[1]?.result)).toContain(research.address);
  });

  it("uses the first wallet, claude, when a legacy shim sends no hello", async () => {
    const replies = (await request(
      join(home, "mcp.sock"),
      [
        JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
        JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "wallet.address" },
        }),
      ],
      2,
    )) as { id: number; result: unknown }[];
    expect(replies[0]?.id).toBe(1);
    expect(replies[1]?.id).toBe(2);
    expect(JSON.stringify(replies[1]?.result)).toContain(claude.address);
  });

  it("returns one actionable JSON-RPC error when the hello names an unknown wallet", async () => {
    const replies = await request(join(home, "mcp.sock"), [
      JSON.stringify({ vapiDesktop: 1, wallet: "nobody" }),
    ]);
    expect(replies).toEqual([
      {
        jsonrpc: "2.0",
        id: null,
        error: {
          code: -32000,
          message:
            'The agent wallet "nobody" is not in vAPI Desktop. Reconnect this app from vAPI Desktop.',
        },
      },
    ]);
  });

  it("keeps serving after a client hangs up before its reply", async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const dropped = connect(join(home, "mcp.sock"));
      await new Promise((resolve) => dropped.once("connect", resolve));
      dropped.write(`${JSON.stringify({ vapiDesktop: 1, wallet: "claude" })}\n`);
      dropped.write(`${JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/list" })}\n`);
      dropped.destroy();
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
    const replies = (await request(
      join(home, "mcp.sock"),
      [JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })],
      1,
    )) as { id: number }[];
    expect(replies[0]?.id).toBe(1);
  });
  it.skipIf(process.platform !== "darwin")(
    "pays from the wallet the native shim names, end to end",
    async () => {
      const shim = resolve(__dirname, "../../native/out/vapi-mcp-shim");
      const ask = async (wallet: string) => {
        const child = spawn(shim, [], {
          env: { VAPI_DESKTOP_SOCKET: join(home, "mcp.sock"), VAPI_DESKTOP_WALLET: wallet },
        });
        let stdout = "";
        child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
        child.stdin.write(
          `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`,
        );
        child.stdin.write(
          `${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "wallet.address" } })}\n`,
        );
        await expect.poll(() => stdout.split("\n").length, { timeout: 5000 }).toBeGreaterThan(2);
        child.kill();
        return stdout;
      };
      const fromResearch = await ask("research");
      expect(fromResearch).toContain(research.address);
      expect(fromResearch).not.toContain(claude.address);
      const fromClaude = await ask("claude");
      expect(fromClaude).toContain(claude.address);
      expect(fromClaude).not.toContain(research.address);
    },
  );
});
