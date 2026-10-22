import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { WalletStore, type SecretStore } from "@vapi-network/core";

import { runCli, type CliDependencies, type CliIo } from "./cli.js";
import { dashboardUrl, offerDashboardLink } from "./dashboard.js";
import * as login from "./login.js";

const API_BASE = "https://console.example/tenant///";
const OWNER = "0x1111111111111111111111111111111111111111" as const;
const originalHome = process.env.VAPI_HOME;
const originalRegistry = process.env.VAPI_REGISTRY_URL;
const homes: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const [name, value] of [
    ["VAPI_HOME", originalHome],
    ["VAPI_REGISTRY_URL", originalRegistry],
  ]) {
    if (value === undefined) delete process.env[name!];
    else process.env[name!] = value;
  }
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

const commands = [
  { label: "init", argv: ["init"], account: "main" },
  { label: "wallet create", argv: ["wallet", "create", "researcher"], account: "researcher" },
  { label: "mcp install", argv: ["mcp", "install", "cursor"], account: "main" },
];

for (const command of commands) {
  describe(`dashboard linking after ${command.label}`, () => {
    it.each(["yes", "", "Y"])("offers linking and accepts %j", async (answer) => {
      const fixture = await setup(command.label !== "init", answer);
      const flow = vi.spyOn(login, "runLoginFlow").mockImplementation(async () => {
        await setLink(fixture.home, command.account, fixture.dependencies);
      });

      expect(await runCli(command.argv, fixture.io, fixture.dependencies)).toBe(0);

      expect(fixture.line).toHaveBeenCalledWith(
        `Link ${command.account} to your vAPI dashboard? [Y/n] `,
      );
      expect(flow).toHaveBeenCalledExactlyOnceWith(
        ["--account", command.account, "--label", command.account],
        false,
        expect.anything(),
        fixture.dependencies,
      );
      expect(fixture.stdout).toContain(
        "See it on your dashboard: https://console.example/tenant/agents",
      );
    });

    it.each([
      { mode: "declined", args: [], interactive: true, answer: "n", env: {} },
      { mode: "--no-link", args: ["--no-link"], interactive: true, answer: "yes", env: {} },
      { mode: "non-TTY", args: [], interactive: false, answer: "yes", env: {} },
      { mode: "agent", args: [], interactive: true, answer: "yes", env: { CLAUDECODE: "1" } },
      { mode: "--json", args: ["--json"], interactive: true, answer: "yes", env: {} },
    ])("skips linking when $mode", async ({ mode, args, interactive, answer, env }) => {
      const fixture = await setup(command.label !== "init", answer);
      const flow = vi.spyOn(login, "runLoginFlow").mockRejectedValue(new Error("must not run"));
      const dependencies = { ...fixture.dependencies, interactive, env };

      expect(await runCli([...command.argv, ...args], fixture.io, dependencies)).toBe(0);

      expect(flow).not.toHaveBeenCalled();
      const linkPrompts = fixture.line.mock.calls.filter(([prompt]) => prompt.startsWith("Link "));
      expect(linkPrompts).toHaveLength(mode === "declined" ? 1 : 0);
      if (mode === "--json") {
        expect(fixture.stdout).toHaveLength(1);
        expect(JSON.parse(fixture.stdout[0]!)).toMatchObject({
          linked: false,
          next: [
            {
              kind: "link",
              account: command.account,
              command: `vapi login --account ${command.account}`,
            },
          ],
        });
        expect(fixture.stderr.filter((line) => line.includes("Link "))).toEqual([]);
      } else {
        expect(fixture.stdout.filter((line) => line === hint(command.account))).toHaveLength(1);
      }
    });

    it.each([
      "Device grant denied",
      "Device grant expired",
      "Vault is locked",
      "Network unavailable",
    ])("preserves successful local writes when linking fails: %s", async (message) => {
      const fixture = await setup(command.label !== "init");
      vi.spyOn(login, "runLoginFlow").mockRejectedValue(new Error(message));

      expect(await runCli(command.argv, fixture.io, fixture.dependencies)).toBe(0);

      expect(fixture.stderr).toContain(`Link not completed: ${message}`);
      expect(fixture.stdout).toContain(hint(command.account));
      const store = await WalletStore.open(fixture.home, {
        secrets: fixture.dependencies.secretStore,
      });
      expect(store.entry(command.account)).toBeDefined();
      expect(store.entry(command.account)?.link).toBeUndefined();
      if (command.label === "mcp install") {
        expect(await readFile(join(fixture.home, ".cursor", "mcp.json"), "utf8")).toContain(
          "vapi-network@latest",
        );
      }
    });
  });
}

describe("dashboard link helper", () => {
  it("skips an existing link without prompting or printing a hint", async () => {
    const fixture = await setup();
    await setLink(fixture.home, "main", fixture.dependencies);
    expect(
      await offerDashboardLink({
        name: "main",
        json: false,
        io: fixture.io,
        dependencies: fixture.dependencies,
      }),
    ).toEqual({ linked: true });
    expect(fixture.line).not.toHaveBeenCalled();
    expect(fixture.stdout).toEqual([]);
  });

  it("treats a closed prompt as an optional link failure", async () => {
    const fixture = await setup();
    fixture.line.mockRejectedValue(new Error("readline closed"));
    expect(await runCli(["mcp", "install", "cursor"], fixture.io, fixture.dependencies)).toBe(0);
    expect(fixture.stderr).toContain("Link not completed: readline closed");
    expect(fixture.stdout).toContain(hint("main"));
  });

  it.each([true, false])("preserves the real login flow (trusted=%s)", async (trusted) => {
    const fixture = await setup();
    const start = vi.fn(async () => ({
      clientId: "agent_main",
      deviceCode: "test-device-code",
      userCode: "BCDF-GHJK",
      verificationUri: "https://console.example/link",
      verificationUriComplete: "https://console.example/link?code=BCDF-GHJK",
      expiresIn: 600,
      interval: 5,
      autoApproved: trusted,
    }));
    const poll = vi.fn(async () => ({
      owner: OWNER,
      tokens: {
        accessToken: "test-access",
        refreshToken: "test-refresh",
        expiresAt: 2_000_000_000_000,
        scopes: ["mcp:call"],
      },
    }));
    expect(
      await runCli(
        trusted ? ["mcp", "install", "cursor"] : ["dashboard", "--no-browser"],
        fixture.io,
        {
          ...fixture.dependencies,
          agentLink: { startDeviceLink: start, pollDeviceLink: poll },
        },
      ),
    ).toBe(0);
    expect(start).toHaveBeenCalledOnce();
    if (trusted) {
      expect(poll).toHaveBeenCalledWith(expect.objectContaining({ immediate: true }));
      expect(fixture.stdout).toContain("Linked on this trusted device.");
    } else {
      expect(poll).toHaveBeenCalledWith(expect.not.objectContaining({ immediate: true }));
    }
    expect(fixture.stdout).toContain("See it on your dashboard: https://api.vapinetwork.ai/agents");
    expect(fixture.dependencies.openUrl).not.toHaveBeenCalled();
  });

  it.each([false, true])("never prompts for another MCP home (json=%s)", async (json) => {
    const fixture = await setup();
    const otherHome = join(fixture.home, "other home");
    const store = await WalletStore.open(otherHome, { secrets: fixture.dependencies.secretStore });
    await store.create("main", "");
    const flow = vi.spyOn(login, "runLoginFlow");
    expect(
      await runCli(
        ["mcp", "install", "cursor", "--home", otherHome, ...(json ? ["--json"] : [])],
        fixture.io,
        fixture.dependencies,
      ),
    ).toBe(0);
    expect(fixture.line).not.toHaveBeenCalled();
    expect(flow).not.toHaveBeenCalled();
    const command = `VAPI_HOME='${otherHome}' vapi login --account main`;
    if (json) {
      expect(fixture.stdout).toHaveLength(1);
      expect(JSON.parse(fixture.stdout[0]!)).toMatchObject({ linked: false, next: [{ command }] });
    } else {
      expect(fixture.stdout).toContain(`Run \`${command}\` to see this wallet on your dashboard.`);
    }
  });

  it("leaves MCP output unchanged when the default account is linked", async () => {
    const fixture = await setup();
    await setLink(fixture.home, "main", fixture.dependencies);
    expect(
      await runCli(["mcp", "install", "cursor", "--json"], fixture.io, fixture.dependencies),
    ).toBe(0);
    expect(JSON.parse(fixture.stdout[0]!)).not.toHaveProperty("linked");
    expect(fixture.line).not.toHaveBeenCalled();
  });
});

describe("vapi dashboard", () => {
  it("strips trailing slashes and retains the configured base path", () => {
    expect(dashboardUrl(API_BASE)).toBe("https://console.example/tenant/agents");
  });

  it.each([[], ["--no-browser"], ["--json"], ["--wallet", "main"]])(
    "opens a linked account with options %j",
    async (...args: string[]) => {
      const fixture = await setup();
      await setLink(fixture.home, "main", fixture.dependencies);
      expect(await runCli(["dashboard", ...args], fixture.io, fixture.dependencies)).toBe(0);
      if (args.includes("--no-browser"))
        expect(fixture.dependencies.openUrl).not.toHaveBeenCalled();
      else
        expect(fixture.dependencies.openUrl).toHaveBeenCalledExactlyOnceWith(
          "https://console.example/tenant/agents",
        );
      if (args.includes("--json")) {
        expect(fixture.stdout).toEqual([
          JSON.stringify({
            account: "main",
            url: "https://console.example/tenant/agents",
            linked: true,
            opened: true,
          }),
        ]);
      } else expect(fixture.stdout).toEqual(["https://console.example/tenant/agents"]);
      expect(fixture.line).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    "reports an unlinked account without prompting outside a terminal (json=%s)",
    async (json) => {
      const fixture = await setup();
      expect(
        await runCli(["dashboard", "--account", "main", ...(json ? ["--json"] : [])], fixture.io, {
          ...fixture.dependencies,
          interactive: false,
        }),
      ).toBe(0);
      expect(fixture.line).not.toHaveBeenCalled();
      expect(fixture.dependencies.openUrl).not.toHaveBeenCalled();
      if (json) {
        expect(fixture.stdout).toHaveLength(1);
        expect(JSON.parse(fixture.stdout[0]!)).toEqual({
          account: "main",
          url: "https://api.vapinetwork.ai/agents",
          linked: false,
          next: [{ kind: "link", account: "main", command: "vapi login --account main" }],
          opened: false,
        });
      } else {
        expect(fixture.stdout).toEqual([
          "main is not linked to your vAPI dashboard yet.",
          hint("main"),
          "https://api.vapinetwork.ai/agents",
        ]);
      }
    },
  );

  it("offers to link and uses the newly saved console URL", async () => {
    const fixture = await setup();
    vi.spyOn(login, "runLoginFlow").mockImplementation(async () =>
      setLink(fixture.home, "main", fixture.dependencies),
    );
    expect(await runCli(["dashboard", "--no-browser"], fixture.io, fixture.dependencies)).toBe(0);
    expect(fixture.line).toHaveBeenCalledWith("Link main to your vAPI dashboard? [Y/n] ");
    expect(fixture.stdout.at(-1)).toBe("https://console.example/tenant/agents");
    expect(fixture.dependencies.openUrl).not.toHaveBeenCalled();
  });

  it.each(["decline", "--no-link", "--json", "failure"])(
    "prints the unlinked URL without opening a browser after %s",
    async (mode) => {
      const fixture = await setup(true, "n");
      const flow = vi
        .spyOn(login, "runLoginFlow")
        .mockRejectedValue(new Error("Device grant denied"));
      if (mode === "failure") fixture.line.mockResolvedValue("yes");
      const args = mode.startsWith("--") ? [mode] : [];
      expect(await runCli(["dashboard", ...args], fixture.io, fixture.dependencies)).toBe(0);
      expect(fixture.dependencies.openUrl).not.toHaveBeenCalled();
      if (mode !== "failure") expect(flow).not.toHaveBeenCalled();
      if (mode === "--json") {
        expect(fixture.stdout).toHaveLength(1);
        expect(JSON.parse(fixture.stdout[0]!)).toMatchObject({ linked: false, opened: false });
        expect(fixture.line).not.toHaveBeenCalled();
      } else {
        expect(fixture.stdout).toContain(hint("main"));
        expect(fixture.stdout.at(-1)).toBe("https://api.vapinetwork.ai/agents");
      }
    },
  );

  it("uses a selected account instead of the default", async () => {
    const fixture = await setup();
    const store = await WalletStore.open(fixture.home, {
      secrets: fixture.dependencies.secretStore,
    });
    await store.create("selected", "");
    await setLink(fixture.home, "selected", fixture.dependencies);
    expect(
      await runCli(
        ["dashboard", "--account", "selected", "--json"],
        fixture.io,
        fixture.dependencies,
      ),
    ).toBe(0);
    expect(JSON.parse(fixture.stdout[0]!)).toMatchObject({ account: "selected", linked: true });
  });
});

async function setup(initialized = true, answer = "yes") {
  const home = await mkdtemp(join(tmpdir(), "vapi-dashboard-"));
  homes.push(home);
  process.env.VAPI_HOME = home;
  delete process.env.VAPI_REGISTRY_URL;
  const entries = new Map<string, string>();
  const secretStore: SecretStore = {
    available: true,
    platform: "darwin",
    description: "test keychain",
    get: async (name) => entries.get(name),
    has: async (name) => entries.has(name),
    set: async (name, value) => {
      entries.set(name, value);
    },
    remove: async (name) => entries.delete(name),
  };
  const line = vi.fn(async (_prompt: string) => answer);
  const dependencies: CliDependencies = {
    interactive: true,
    env: {},
    secretStore,
    openUrl: vi.fn(() => true),
    hostname: () => "test device",
    now: () => new Date("2026-10-01T00:00:00.000Z"),
    prompts: {
      line,
      secret: async (prompt) => {
        if (prompt === "Write these 12 words down, then press Enter. ") return "";
        throw new Error(`unexpected secret prompt: ${prompt}`);
      },
    },
    fetchImpl: vi.fn<typeof fetch>(async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as { id: number; method: string };
      return Response.json({
        jsonrpc: "2.0",
        id: request.id,
        result: request.method === "eth_call" ? `0x${"0".repeat(64)}` : "0x0",
      });
    }),
    mcpInstall: { platform: "darwin", homedir: home, cwd: home },
  };
  if (initialized) {
    const store = await WalletStore.open(home, { secrets: secretStore });
    await store.create("main", "");
  }
  const stdout: string[] = [];
  const stderr: string[] = [];
  const io: CliIo = {
    stdout: (message) => stdout.push(message),
    stderr: (message) => stderr.push(message),
  };
  return { home, dependencies, line, io, stdout, stderr };
}

async function setLink(home: string, name: string, dependencies: CliDependencies) {
  const store = await WalletStore.open(home, { secrets: dependencies.secretStore });
  await store.setLink(name, {
    apiBase: API_BASE,
    clientId: `agent_${name}`,
    owner: OWNER,
    label: name,
    scopes: ["mcp:call"],
    linkedAt: "2026-10-01T00:00:00.000Z",
  });
}

function hint(name: string): string {
  return `Run \`vapi login --account ${name}\` to see this wallet on your dashboard.`;
}
