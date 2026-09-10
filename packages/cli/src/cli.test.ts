import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { appendReceipt, appendSearchEvent, getVapiPaths } from "@vapi-network/core";

import { runCli, type CliIo } from "./cli.js";

const originalHome = process.env.VAPI_HOME;
const originalPassword = process.env.VAPI_KEYSTORE_PASSWORD;

afterEach(() => {
  restoreEnvironment("VAPI_HOME", originalHome);
  restoreEnvironment("VAPI_KEYSTORE_PASSWORD", originalPassword);
});

describe("CLI JSON output", () => {
  it("initializes a wallet without printing a QR code", async () => {
    const home = await mkdtemp(join(tmpdir(), "vapi-cli-init-"));
    process.env.VAPI_HOME = home;
    process.env.VAPI_KEYSTORE_PASSWORD = "test-only-passphrase";
    const captured = captureIo();

    expect(await runCli(["init", "--json"], captured.io, { fetchImpl: zeroBalanceRpc() })).toBe(0);
    expect(captured.stderr).toEqual([]);
    expect(captured.stdout).toHaveLength(1);
    const value = JSON.parse(captured.stdout[0]!) as Record<string, unknown>;
    expect(value).toMatchObject({
      accounts: [
        {
          caip2: "eip155:8453",
          usdcBalance: { atomic: "0", formatted: "0" },
          gasTokenBalance: { symbol: "ETH", atomic: "0", formatted: "0" },
        },
      ],
      config: join(home, "config.json"),
      keystore: join(home, "keystore.json"),
      message: "vAPI wallet created. Its encrypted key stays on this machine.",
    });
    expect(value.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(captured.stdout[0]).not.toContain("█");
    expect(JSON.parse(await readFile(join(home, "keystore.json"), "utf8"))).not.toHaveProperty(
      "privateKey",
    );
  });

  it("reports an empty configured balance without making a network request", async () => {
    const home = await mkdtemp(join(tmpdir(), "vapi-cli-balance-"));
    process.env.VAPI_HOME = home;
    process.env.VAPI_KEYSTORE_PASSWORD = "test-only-passphrase";
    expect(await runCli(["init", "--json"], captureIo().io, { fetchImpl: zeroBalanceRpc() })).toBe(
      0,
    );

    const paths = getVapiPaths(home);
    const config = JSON.parse(await readFile(paths.config, "utf8")) as Record<string, unknown>;
    config.networks = {};
    await writeFile(paths.config, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    const captured = captureIo();

    expect(await runCli(["balance", "--json"], captured.io)).toBe(0);
    expect(captured.stderr).toEqual([]);
    expect(JSON.parse(captured.stdout[0]!)).toEqual({
      address: expect.stringMatching(/^0x[0-9a-fA-F]{40}$/),
      balances: [],
    });
  });
});

describe("accounts and support commands", () => {
  it("lists deposit accounts as stable JSON", async () => {
    const home = await mkdtemp(join(tmpdir(), "vapi-cli-accounts-"));
    process.env.VAPI_HOME = home;
    process.env.VAPI_KEYSTORE_PASSWORD = "test-only-passphrase";
    const fetchImpl = zeroBalanceRpc();
    expect(await runCli(["init", "--json"], captureIo().io, { fetchImpl })).toBe(0);
    const captured = captureIo();

    expect(await runCli(["accounts", "--json"], captured.io, { fetchImpl })).toBe(0);
    expect(captured.stderr).toEqual([]);
    expect(JSON.parse(captured.stdout[0]!)).toMatchObject({
      accounts: [
        {
          caip2: "eip155:8453",
          name: "Base mainnet",
          address: expect.stringMatching(/^0x[0-9a-fA-F]{40}$/),
          usdcBalance: { atomic: "0", formatted: "0" },
          gasTokenBalance: { symbol: "ETH", atomic: "0", formatted: "0" },
          depositInstructions: expect.stringContaining("Send USDC on Base"),
        },
      ],
    });
  });

  it("writes a private local report without a network request", async () => {
    const home = await mkdtemp(join(tmpdir(), "vapi-cli-report-"));
    process.env.VAPI_HOME = home;
    const paths = getVapiPaths();
    await appendReceipt(
      {
        id: "latest-receipt",
        timestamp: new Date().toISOString(),
        resourceUrl: "https://api.example/call",
        quote: {
          network: "eip155:8453",
          asset: "0xasset",
          amountAtomic: "2500",
          payTo: "0xpayee",
        },
        payer: "0xpayer",
      },
      paths.receipts,
    );
    const fetchImpl = vi.fn<typeof fetch>();
    const captured = captureIo();

    expect(await runCli(["report", "payment failed", "--json"], captured.io, { fetchImpl })).toBe(
      0,
    );
    const result = JSON.parse(captured.stdout[0]!) as { path: string; issueUrl: string };
    const report = await readFile(result.path, "utf8");
    expect(result.issueUrl).toContain("title=payment%20failed");
    expect(report).toContain('"receiptIds"');
    expect(report).toContain("latest-receipt");
    expect(report).not.toContain("0xpayer");
    expect(report).not.toContain("0xpayee");
    expect(report).not.toContain("2500");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("local metrics commands", () => {
  it("prints stable stats JSON and exports flattened CSV", async () => {
    const home = await mkdtemp(join(tmpdir(), "vapi-cli-metrics-"));
    process.env.VAPI_HOME = home;
    const paths = getVapiPaths();
    const timestamp = new Date().toISOString();
    await appendReceipt(
      {
        id: "paid-weather",
        timestamp,
        resourceUrl: "https://weather.example/call",
        quote: {
          network: "eip155:8453",
          asset: "0xasset",
          amountAtomic: "2500",
          payTo: "0xpayee",
        },
        outcome: "paid",
        latencyMs: 25,
        phases: { quoteMs: 10, requestMs: 15 },
        listing: { name: "Weather", providerHost: "weather.example", source: "vapi" },
        policy: { capsApplied: true },
        client: { name: "vapi-network", version: "0.2.0-dev.3" },
      },
      paths.receipts,
    );
    await appendSearchEvent(
      {
        timestamp,
        query: "weather",
        sources: [{ source: "api.vapinetwork.ai", latencyMs: 12, count: 1 }],
        mergedCount: 1,
      },
      paths.searches,
    );

    const statsOutput = captureIo();
    expect(await runCli(["stats", "--range", "24h", "--json"], statsOutput.io)).toBe(0);
    expect(JSON.parse(statsOutput.stdout[0]!)).toMatchObject({
      range: "24h",
      totals: { spendUsd: "0.0025", calls: 1, uniqueApis: 1, policyDeclines: 0 },
      outcomes: { paid: { count: 1, rate: 1 } },
      search: { count: 1, zeroResultRate: 0 },
    });

    const csvOutput = captureIo();
    expect(
      await runCli(["receipts", "export", "--format", "csv", "--range", "24h"], csvOutput.io),
    ).toBe(0);
    expect(csvOutput.stdout[0]).toContain("id,timestamp,outcome,resourceUrl");
    expect(csvOutput.stdout[0]).toContain("paid-weather");
    expect(csvOutput.stdout[0]).toContain("0.0025");
  });
});

describe("future gateway commands", () => {
  for (const command of ["serve", "publish"] as const) {
    it(`${command} exits 2 with the promised message`, async () => {
      const captured = captureIo();
      expect(await runCli([command], captured.io)).toBe(2);
      expect(captured.stdout).toEqual([]);
      expect(captured.stderr).toEqual(["gateway daemon lands in 0.3"]);
    });

    it(`${command} remains a stub when its future arguments are supplied`, async () => {
      const captured = captureIo();
      const argumentsForPreview = command === "serve" ? ["--port", "4020"] : ["openapi.json"];
      expect(await runCli([command, ...argumentsForPreview], captured.io)).toBe(2);
      expect(captured.stderr).toEqual(["gateway daemon lands in 0.3"]);
    });

    it(`${command} has machine-readable JSON output`, async () => {
      const captured = captureIo();
      expect(await runCli([command, "--json"], captured.io)).toBe(2);
      expect(captured.stderr).toEqual([]);
      expect(JSON.parse(captured.stdout[0]!)).toEqual({
        error: "gateway daemon lands in 0.3",
        exitCode: 2,
      });
    });
  }
});

function captureIo(): { io: CliIo; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      stdout: (message) => stdout.push(message),
      stderr: (message) => stderr.push(message),
    },
  };
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function zeroBalanceRpc() {
  return vi.fn<typeof fetch>(async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as { id: number; method: string };
    return Response.json({
      jsonrpc: "2.0",
      id: request.id,
      result: request.method === "eth_call" ? `0x${"0".repeat(64)}` : "0x0",
    });
  });
}
