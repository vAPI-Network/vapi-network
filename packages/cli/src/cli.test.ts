import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { getVapiPaths } from "@vapi-network/core";

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

    expect(await runCli(["init", "--json"], captured.io)).toBe(0);
    expect(captured.stderr).toEqual([]);
    expect(captured.stdout).toHaveLength(1);
    const value = JSON.parse(captured.stdout[0]!) as Record<string, unknown>;
    expect(value).toMatchObject({
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
    expect(await runCli(["init", "--json"], captureIo().io)).toBe(0);

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
