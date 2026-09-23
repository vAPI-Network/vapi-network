import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { type SecretStore, WalletStore } from "@vapi-network/core";
import { RouterClientError } from "@vapi-network/core/router-client";

import { runCli, type CliDependencies, type CliIo } from "./cli.js";

const PASSPHRASE = "test-only-passphrase";
const WALLET = "researcher";
const OWNER = "0x1111111111111111111111111111111111111111";
const STAKE_URL = "https://api.vapinetwork.ai/stake";
const homes: string[] = [];
const originalHome = process.env.VAPI_HOME;

afterEach(async () => {
  restoreEnvironment("VAPI_HOME", originalHome);
  await Promise.all(homes.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("vapi stake status", () => {
  it("formats base units as vAPI and prints human and JSON output", async () => {
    await initializedHome();
    const ownerStake = vi.fn(async () => ({
      owner: OWNER,
      stake: "1500000000000000000",
      computeTodayUsd: 2.5,
      stakeUrl: "https://untrusted.example/stake",
    }));
    const dependencies = commandDependencies({ router: { ownerStake } });
    const human = captureIo();

    expect(await runCli(["stake", "status", "--wallet", WALLET], human.io, dependencies)).toBe(0);
    expect(human.stdout).toEqual([
      `Owner ${OWNER}  Stake 1.5 vAPI  Compute today $2.50`,
      `Stake or unstake at ${STAKE_URL}`,
    ]);

    const json = captureIo();
    expect(
      await runCli(["stake", "status", "--wallet", WALLET, "--json"], json.io, dependencies),
    ).toBe(0);
    expect(JSON.parse(json.stdout[0]!)).toEqual({
      owner: OWNER,
      stake: "1500000000000000000",
      stakeFormatted: "1.5",
      computeTodayUsd: 2.5,
      stakeUrl: STAKE_URL,
    });
  });

  it("normalizes an unlinked wallet error", async () => {
    await initializedHome();
    const ownerStake = vi.fn(async () => {
      throw new RouterClientError("not_linked", "unsafe service detail");
    });
    const captured = captureIo();

    expect(
      await runCli(
        ["stake", "status", "--wallet", WALLET],
        captured.io,
        commandDependencies({ router: { ownerStake } }),
      ),
    ).toBe(1);
    expect(captured.stderr).toEqual(["Not linked. Run vapi login."]);
  });
});

describe("vapi stake open", () => {
  it("prints and opens the constant stake URL for an interactive person", async () => {
    await initializedHome();
    const openUrl = vi.fn(() => true);
    const ownerStake = vi.fn();
    const human = captureIo();

    expect(
      await runCli(
        ["stake", "open", "--wallet", WALLET],
        human.io,
        commandDependencies({
          interactive: true,
          env: {},
          openUrl,
          router: { ownerStake },
        }),
      ),
    ).toBe(0);
    expect(human.stdout).toEqual([STAKE_URL]);
    expect(openUrl).toHaveBeenCalledWith(STAKE_URL);
    expect(ownerStake).not.toHaveBeenCalled();

    const json = captureIo();
    expect(
      await runCli(
        ["stake", "open", "--wallet", WALLET, "--json"],
        json.io,
        commandDependencies({ interactive: true, env: {}, openUrl }),
      ),
    ).toBe(0);
    expect(JSON.parse(json.stdout[0]!)).toEqual({ url: STAKE_URL });
  });

  it("does not open a browser with --no-browser or an agent marker", async () => {
    await initializedHome();
    const openUrl = vi.fn(() => true);

    expect(
      await runCli(
        ["stake", "open", "--wallet", WALLET, "--no-browser"],
        captureIo().io,
        commandDependencies({ interactive: true, env: {}, openUrl }),
      ),
    ).toBe(0);
    expect(openUrl).not.toHaveBeenCalled();

    expect(
      await runCli(
        ["stake", "open", "--wallet", WALLET],
        captureIo().io,
        commandDependencies({ interactive: true, env: { CLAUDECODE: "1" }, openUrl }),
      ),
    ).toBe(0);
    expect(openUrl).not.toHaveBeenCalled();
  });
});

function commandDependencies(overrides: Partial<CliDependencies> = {}): CliDependencies {
  return {
    interactive: false,
    env: {},
    secretStore: secretStoreStub(),
    ...overrides,
  };
}

function secretStoreStub(): SecretStore {
  return {
    available: true,
    platform: "darwin",
    description: "the macOS Keychain",
    get: async () => undefined,
    has: async () => false,
    set: async () => undefined,
    remove: async () => false,
  };
}

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

async function initializedHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "vapi-stake-cli-"));
  homes.push(home);
  process.env.VAPI_HOME = home;
  const store = await WalletStore.open(home);
  await store.create(WALLET, PASSPHRASE);
  return home;
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
