import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  WalletStore,
  getDefaultConfig,
  protectVault,
  readAuditLog,
  type AgentRouterUsage,
  type SecretStore,
} from "@vapi-network/core";
import { agentSecretAccounts } from "@vapi-network/core/agent-link";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { createVapiServer } from "../server.js";

const API_BASE = "https://api.vapinetwork.ai";
const OTHER_BASE = "https://other.example";
const NOW = new Date("2026-09-29T12:00:00.000Z").getTime();
const TEST_PHRASE = "test test test test test test test test test test test junk";
const DEVICE_CODE = "device-code-that-must-stay-private";
const ACCESS_TOKEN = "access-token-that-must-stay-private";
const REFRESH_TOKEN = "refresh-token-that-must-stay-private";
const TRUSTED_TOKEN = "trusted-account-access-token";
const OWNER = "0x1111111111111111111111111111111111111111" as const;
const FALLBACK_KEY = "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" as Hex;
const TRANSFER_NONCE = `0x${"ab".repeat(32)}` as Hex;
const TRANSFER_TX_HASH = `0x${"34".repeat(32)}` as Hex;
const temporaryDirectories: string[] = [];

type RecordedRequest = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
};

type PollAnswer = "pending" | "success" | "access_denied" | "expired_token";

class FakeLinkApi {
  readonly requests: RecordedRequest[] = [];
  readonly sleepers: Array<() => void> = [];
  readonly tokenSignals: AbortSignal[] = [];
  autoApproved = false;
  hangToken = false;
  pollAnswer: PollAnswer = "pending";
  expiresIn = 600;
  sleepCalls = 0;
  transferFrom: string | undefined;
  transferSibling: { name: string; address: string } | undefined;
  relayRequests = 0;
  onRequest: ((request: RecordedRequest) => Promise<void> | void) | undefined;

  readonly sleep = async (): Promise<void> => {
    this.sleepCalls += 1;
    await new Promise<void>((resolve) => this.sleepers.push(resolve));
  };

  release(answer: PollAnswer): void {
    this.pollAnswer = answer;
    for (const resolve of this.sleepers.splice(0)) resolve();
  }

  readonly fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input instanceof Request ? input.url : input);
    const headers = Object.fromEntries(
      new Headers(
        init?.headers ?? (input instanceof Request ? input.headers : undefined),
      ).entries(),
    );
    const body =
      init?.body === undefined
        ? input instanceof Request
          ? await input.clone().text()
          : ""
        : String(init.body);
    const request = {
      url,
      method: init?.method ?? (input instanceof Request ? input.method : "GET"),
      headers,
      body,
    };
    this.requests.push(request);
    await this.onRequest?.(request);

    const parsed = new URL(url);
    if (parsed.pathname === "/api/auth/siwe-nonce") {
      return Response.json({ nonce: "n".repeat(32) });
    }
    if (parsed.pathname === "/oauth/device_authorization") {
      return Response.json({
        client_id: "agent_research",
        device_code: DEVICE_CODE,
        user_code: "BCDF-GHJK",
        verification_uri: `${API_BASE}/link`,
        verification_uri_complete: `${API_BASE}/link?code=BCDF-GHJK`,
        expires_in: this.expiresIn,
        interval: 1,
        auto_approved: this.autoApproved,
      });
    }
    if (parsed.pathname === "/oauth/token") {
      if (this.hangToken) {
        const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
        if (signal === undefined) throw new Error("Expected the token request to be abortable.");
        this.tokenSignals.push(signal);
        return await new Promise<Response>((_resolve, reject) => {
          const abort = () => reject(signal.reason);
          if (signal.aborted) abort();
          else signal.addEventListener("abort", abort, { once: true });
        });
      }
      if (this.pollAnswer === "success") {
        return Response.json({
          access_token: ACCESS_TOKEN,
          refresh_token: REFRESH_TOKEN,
          expires_in: 3600,
          scope: "mcp:call router.use",
          owner_wallet: OWNER,
        });
      }
      return Response.json(
        { error: this.pollAnswer === "pending" ? "authorization_pending" : this.pollAnswer },
        { status: 400 },
      );
    }
    if (parsed.pathname === "/api/agents/self") return Response.json({ status: "active" });
    if (parsed.pathname === "/api/agents/self/siblings" && this.transferFrom !== undefined) {
      return Response.json({
        owner: OWNER,
        siblings: [
          transferSibling("main", this.transferFrom, true),
          ...(this.transferSibling === undefined
            ? []
            : [transferSibling(this.transferSibling.name, this.transferSibling.address)]),
        ],
      });
    }
    if (parsed.pathname === "/api/agents/relay-transfer") {
      this.relayRequests += 1;
      const transfer = JSON.parse(request.body) as {
        network: string;
        authorization: { from: string; to: string; value: string };
      };
      return Response.json({
        txHash: TRANSFER_TX_HASH,
        network: transfer.network,
        from: transfer.authorization.from,
        to: transfer.authorization.to,
        value: transfer.authorization.value,
        replayed: false,
      });
    }
    throw new Error(`Unexpected request ${request.method} ${url}`);
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("accounts.add", () => {
  it("returns an owner-approval link immediately and saves it after approval", async () => {
    const fake = new FakeLinkApi();
    const fixture = await servedVault(fake);

    const added = await fixture.server.callTool({
      name: "accounts.add",
      arguments: {
        name: "research",
        caps: { perCallUsd: 0.2, perDayUsd: 2 },
        routerAllowanceUsd: 1,
      },
    });

    expect(added.isError).not.toBe(true);
    expect(added.structuredContent).toMatchObject({
      account: "research",
      caps: { perCallUsd: "0.2", perDayUsd: "2" },
      created: true,
      linked: false,
      autoApproved: false,
      link: {
        userCode: "BCDF-GHJK",
        verificationUri: `${API_BASE}/link`,
        verificationUriComplete: `${API_BASE}/link?code=BCDF-GHJK`,
        expiresInSeconds: 600,
      },
    });

    fake.release("success");
    await vi.waitFor(async () => {
      await fixture.store.reload();
      expect(fixture.store.entry("research")?.link).toMatchObject({ owner: OWNER });
    });
    const accounts = await fixture.server.callTool({ name: "vapi.accounts" });
    expect(accounts.structuredContent).toMatchObject({
      accounts: expect.arrayContaining([
        expect.objectContaining({ name: "research", link: "active" }),
      ]),
    });
    await fixture.server.close();
  });

  it("auto-approves on a trusted device without returning a link code", async () => {
    const fake = new FakeLinkApi();
    fake.autoApproved = true;
    fake.pollAnswer = "success";
    const fixture = await servedVault(fake);
    await trustMain(fixture.store, fixture.secrets, API_BASE);

    const added = await fixture.server.callTool({
      name: "accounts.add",
      arguments: { name: "research", caps: { perDayUsd: 2 }, routerAllowanceUsd: 1 },
    });

    expect(added.structuredContent).toMatchObject({
      account: "research",
      created: true,
      linked: true,
      autoApproved: true,
      message: "Account research added and linked on this trusted device.",
    });
    expect(added.structuredContent).not.toHaveProperty("link");
    expect(JSON.stringify(added)).not.toContain("BCDF-GHJK");
    const authorization = fake.requests.find((request) =>
      request.url.endsWith("/oauth/device_authorization"),
    );
    expect(JSON.parse(authorization?.body ?? "{}")).toMatchObject({
      device: "test-host",
      trust_device: true,
      router_allowance_usd: 1,
    });
    expect(authorization?.headers.authorization).toBe(`Bearer ${TRUSTED_TOKEN}`);
    expect(
      fake.requests
        .filter((request) => request.headers.authorization !== undefined)
        .every((request) => new URL(request.url).origin === new URL(API_BASE).origin),
    ).toBe(true);
    await fixture.server.close();
  });

  it("accounts.add with caps.perDayUsd 2 on a trusted device auto-approves with router_allowance_usd 2", async () => {
    const fake = new FakeLinkApi();
    fake.autoApproved = true;
    fake.pollAnswer = "success";
    const fixture = await servedVault(fake);
    await trustMain(fixture.store, fixture.secrets, API_BASE);

    const added = await fixture.server.callTool({
      name: "accounts.add",
      arguments: { name: "research", caps: { perDayUsd: 2 } },
    });

    expect(added.structuredContent).toMatchObject({ linked: true, autoApproved: true });
    const authorization = fake.requests.find((request) =>
      request.url.endsWith("/oauth/device_authorization"),
    );
    expect(JSON.parse(authorization?.body ?? "{}")).toMatchObject({
      router_allowance_usd: 2,
      device: "test-host",
      trust_device: true,
    });
    expect(authorization?.headers.authorization).toBe(`Bearer ${TRUSTED_TOKEN}`);
    await fixture.server.close();
  });

  it("accounts.add with link scopes excluding router.use sends no router_allowance_usd", async () => {
    const fake = new FakeLinkApi();
    const fixture = await servedVault(fake, { scopes: ["mcp:call"] });

    const added = await fixture.server.callTool({
      name: "accounts.add",
      arguments: { name: "research", caps: { perDayUsd: 2 }, routerAllowanceUsd: 1 },
    });

    expect(added.structuredContent).toMatchObject({ linked: false, autoApproved: false });
    const authorization = fake.requests.find((request) =>
      request.url.endsWith("/oauth/device_authorization"),
    );
    expect(JSON.parse(authorization?.body ?? "{}")).not.toHaveProperty("router_allowance_usd");
    fake.release("access_denied");
    await pendingLinkSettled(fixture.server, "research");
    await fixture.server.close();
  });

  it("never sends a bearer saved for another API origin", async () => {
    const fake = new FakeLinkApi();
    fake.autoApproved = true;
    fake.pollAnswer = "success";
    const fixture = await servedVault(fake);
    await trustMain(fixture.store, fixture.secrets, OTHER_BASE);

    const added = await fixture.server.callTool({
      name: "accounts.add",
      arguments: { name: "research" },
    });

    expect(added.structuredContent).toMatchObject({ linked: true, autoApproved: true });
    expect(fake.requests.every((request) => request.headers.authorization === undefined)).toBe(
      true,
    );
    await fixture.server.close();
  });

  it("writes caps before linking and changes nothing on an idempotent repeat", async () => {
    const fake = new FakeLinkApi();
    const fixture = await servedVault(fake);
    fake.onRequest = async () => {
      const registry = JSON.parse(await readFile(join(fixture.home, "wallets.json"), "utf8")) as {
        wallets: Record<string, { spendCaps: unknown }>;
      };
      expect(registry.wallets.research?.spendCaps).toEqual({
        perCallAtomic: "200000",
        perDayAtomic: "2000000",
      });
    };

    const first = await fixture.server.callTool({
      name: "accounts.add",
      arguments: { name: "research", caps: { perCallUsd: 0.2, perDayUsd: 2 } },
    });
    const walletsBefore = await readFile(join(fixture.home, "wallets.json"), "utf8");
    const vaultBefore = await readFile(join(fixture.home, "vault.json"), "utf8");
    const requestsBefore = fake.requests.length;
    const second = await fixture.server.callTool({
      name: "accounts.add",
      arguments: { name: "research", caps: { perCallUsd: 0.01, perDayUsd: 0.1 } },
    });

    expect(first.structuredContent).toMatchObject({ created: true });
    expect(second.structuredContent).toMatchObject({
      created: false,
      caps: { perCallUsd: "0.2", perDayUsd: "2" },
      message: "Account research already exists. Nothing was changed.",
      link: { userCode: "BCDF-GHJK" },
    });
    expect(await readFile(join(fixture.home, "wallets.json"), "utf8")).toBe(walletsBefore);
    expect(await readFile(join(fixture.home, "vault.json"), "utf8")).toBe(vaultBefore);
    expect(fake.requests).toHaveLength(requestsBefore);
    fake.release("access_denied");
    await pendingLinkSettled(fixture.server, "research");
    await fixture.server.close();
  });

  it("single-flights concurrent calls for one account name", async () => {
    const fake = new FakeLinkApi();
    const fixture = await servedVault(fake);

    const [first, second] = await Promise.all([
      fixture.server.callTool({ name: "accounts.add", arguments: { name: "research" } }),
      fixture.server.callTool({ name: "accounts.add", arguments: { name: "research" } }),
    ]);

    expect(first.structuredContent).toEqual(second.structuredContent);
    expect(fake.requests.filter((request) => request.url.includes("siwe-nonce"))).toHaveLength(1);
    fake.release("access_denied");
    await pendingLinkSettled(fixture.server, "research");
    await fixture.server.close();
  });

  it("keeps the capped account when linking cannot start and returns no link internals", async () => {
    const fake = new FakeLinkApi();
    fake.onRequest = () => {
      throw new Error(`link start failed with ${ACCESS_TOKEN}`);
    };
    const fixture = await servedVault(fake);

    const added = await fixture.server.callTool({
      name: "accounts.add",
      arguments: { name: "research", caps: { perDayUsd: 0.5 } },
    });

    expect(added.isError).not.toBe(true);
    expect(added.structuredContent).toMatchObject({
      account: "research",
      created: true,
      linked: false,
      autoApproved: false,
      caps: { perCallUsd: "0.1", perDayUsd: "0.5" },
      message:
        "Account research was added with its caps, but the link did not start. Run auth.link to try again.",
    });
    expect(added.structuredContent).not.toHaveProperty("link");
    expect(JSON.stringify(added)).not.toContain(ACCESS_TOKEN);
    await fixture.store.reload();
    expect(fixture.store.entry("research")?.link).toBeUndefined();
    await fixture.server.close();
  });

  it.each([
    ["access_denied", "access_denied"],
    ["expired_token", "expired_token"],
    ["clock expiry", "clock"],
  ] as const)(
    "keeps a capped, unlinked account after %s without an unhandled rejection",
    async (_label, outcome) => {
      const fake = new FakeLinkApi();
      let clock = NOW;
      if (outcome === "clock") fake.expiresIn = 1;
      const fixture = await servedVault(fake, {
        now: () => clock,
        ...(outcome === "clock"
          ? {
              sleep: async () => {
                fake.sleepCalls += 1;
                clock += 2_000;
              },
            }
          : {}),
      });
      const unhandled: unknown[] = [];
      const listener = (reason: unknown) => unhandled.push(reason);
      process.on("unhandledRejection", listener);
      try {
        const added = await fixture.server.callTool({
          name: "accounts.add",
          arguments: { name: "research", caps: { perCallUsd: 0.03, perDayUsd: 0.3 } },
        });
        expect(added.structuredContent).toMatchObject({ created: true, linked: false });
        if (outcome !== "clock") fake.release(outcome);
        await pendingLinkSettled(fixture.server, "research");
        await fixture.store.reload();
        expect(fixture.store.entry("research")).toMatchObject({
          spendCaps: { perCallAtomic: "30000", perDayAtomic: "300000" },
        });
        expect(fixture.store.entry("research")?.link).toBeUndefined();
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(unhandled).toEqual([]);
      } finally {
        process.off("unhandledRejection", listener);
        await fixture.server.close();
      }
    },
  );

  it("aborts a hanging token poll when the MCP server closes without an unhandled rejection", async () => {
    const fake = new FakeLinkApi();
    fake.hangToken = true;
    const fixture = await servedVault(fake);
    const unhandled: unknown[] = [];
    const listener = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", listener);
    try {
      const added = await fixture.server.callTool({
        name: "accounts.add",
        arguments: { name: "research" },
      });
      expect(added.structuredContent).toMatchObject({ linked: false });

      fake.release("pending");
      await vi.waitFor(() => expect(fake.tokenSignals).toHaveLength(1));
      expect(fake.tokenSignals[0]?.aborted).toBe(false);

      await fixture.server.close();

      expect(fake.tokenSignals[0]?.aborted).toBe(true);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", listener);
      await fixture.server.close();
    }
  });

  it("refuses a protected, locked vault without registering or requesting", async () => {
    const fake = new FakeLinkApi();
    const fixture = await servedVault(fake);
    await protectVault({
      path: join(fixture.home, "vault.json"),
      secrets: fixture.secrets,
      password: "test-vault-password",
      env: {},
    });
    const lockedStore = await WalletStore.open(fixture.home, { secrets: fixture.secrets, env: {} });
    const server = createServer({
      home: fixture.home,
      store: lockedStore,
      secrets: fixture.secrets,
      fake,
      account: fixture.account,
    });

    const result = await server.callTool({
      name: "accounts.add",
      arguments: { name: "research" },
    });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("vapi vault unlock");
    expect(JSON.stringify(result.content)).toContain("VAPI_VAULT_PASSWORD");
    await lockedStore.reload();
    expect(lockedStore.has("research")).toBe(false);
    expect(fake.requests).toEqual([]);
    await server.close();
    await fixture.server.close();
  });

  it("reports missing setup state and can create without linking", async () => {
    const fake = new FakeLinkApi();
    const noStore = createVapiServer({
      account: privateKeyToAccount(FALLBACK_KEY),
      config: getDefaultConfig({}),
      env: {},
      fetchImpl: fake.fetch as typeof fetch,
    });
    const withoutStore = await noStore.callTool({
      name: "accounts.add",
      arguments: { name: "research" },
    });
    expect(withoutStore).toEqual({
      isError: true,
      content: [
        {
          type: "text",
          text: "No wallet store is available on this machine, so accounts cannot be changed. Run vapi setup.",
        },
      ],
    });
    await noStore.close();

    const emptyHome = await temporaryHome("vapi-mcp-accounts-empty-");
    const emptySecrets = memorySecretStore();
    const emptyStore = await WalletStore.open(emptyHome, { secrets: emptySecrets, env: {} });
    const noVault = createServer({
      home: emptyHome,
      store: emptyStore,
      secrets: emptySecrets,
      fake,
      account: privateKeyToAccount(FALLBACK_KEY),
    });
    const withoutVault = await noVault.callTool({
      name: "accounts.add",
      arguments: { name: "research" },
    });
    expect(withoutVault.isError).toBe(true);
    expect(JSON.stringify(withoutVault.content)).toContain("No vault yet. Run vapi setup.");
    expect(emptyStore.has("research")).toBe(false);
    await noVault.close();

    const fixture = await servedVault(fake);
    const localOnly = await fixture.server.callTool({
      name: "accounts.add",
      arguments: { name: "local-only", caps: { perDayUsd: 2 }, link: false },
    });
    expect(localOnly.structuredContent).toMatchObject({
      account: "local-only",
      linked: false,
      autoApproved: false,
      caps: { perCallUsd: "0.1", perDayUsd: "2" },
      message: "Account local-only added with its caps. Linking was skipped.",
    });
    expect(fake.requests).toEqual([]);
    await fixture.server.close();
  });

  it("audits one secret-free creation and none for an idempotent repeat", async () => {
    const fake = new FakeLinkApi();
    const fixture = await servedVault(fake, { env: { CLAUDECODE: "1" } });

    await fixture.server.callTool({
      name: "accounts.add",
      arguments: { name: "research", link: false },
    });
    await fixture.server.callTool({
      name: "accounts.add",
      arguments: { name: "research", link: false },
    });

    const entries = (await readAuditLog(fixture.home)).filter(
      (entry) => entry.event === "wallet.create",
    );
    expect(entries).toEqual([
      {
        time: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/u),
        event: "wallet.create",
        wallet: "research",
        tty: false,
        agentMarker: "CLAUDECODE",
        detail: "mcp accounts.add",
      },
    ]);
    const audit = await readFile(join(fixture.home, "audit.log"), "utf8");
    expect(audit).not.toContain(TEST_PHRASE);
    expect(audit).not.toContain(DEVICE_CODE);
    expect(audit).not.toContain(ACCESS_TOKEN);
    expect(audit).not.toContain(REFRESH_TOKEN);
    await fixture.server.close();
  });
});

describe("accounts.caps", () => {
  it("lowers caps and the ceiling, refuses raises and off without changing storage", async () => {
    const fake = new FakeLinkApi();
    const fixture = await servedVault(fake);
    await fixture.server.callTool({
      name: "accounts.add",
      arguments: { name: "research", caps: { perCallUsd: 0.2, perDayUsd: 2 }, link: false },
    });

    const lowered = await fixture.server.callTool({
      name: "accounts.caps",
      arguments: { name: "research", perDayUsd: 1 },
    });
    expect(lowered.structuredContent).toMatchObject({
      account: "research",
      caps: { perCallUsd: "0.2", perDayUsd: "1" },
      message: "Account research caps lowered to 0.2 USD per call and 1 USD per day.",
    });
    await fixture.store.reload();
    expect(fixture.store.entry("research")?.spendCaps).toEqual({
      perCallAtomic: "200000",
      perDayAtomic: "1000000",
    });
    const beforeRaise = await readFile(join(fixture.home, "wallets.json"), "utf8");

    const raised = await fixture.server.callTool({
      name: "accounts.caps",
      arguments: { name: "research", perDayUsd: 5 },
    });
    expect(raised).toEqual({
      isError: true,
      content: [
        {
          type: "text",
          text: "Raise caps in the terminal: vapi accounts caps research --per-day 5",
        },
      ],
    });
    expect(await readFile(join(fixture.home, "wallets.json"), "utf8")).toBe(beforeRaise);

    const loweredCeiling = await fixture.server.callTool({
      name: "accounts.caps",
      arguments: { name: "research", ceilingUsd: 2 },
    });
    expect(loweredCeiling.structuredContent).toMatchObject({
      account: "research",
      caps: { perCallUsd: "0.2", perDayUsd: "1", ceilingUsd: "2" },
    });
    await fixture.store.reload();
    expect(fixture.store.ceilingCaps("research").ceilingAtomic).toBe(2_000_000n);
    const beforeCeilingRefusals = await readFile(join(fixture.home, "wallets.json"), "utf8");

    const raisedCeiling = await fixture.server.callTool({
      name: "accounts.caps",
      arguments: { name: "research", ceilingUsd: 6 },
    });
    expect(raisedCeiling).toEqual({
      isError: true,
      content: [
        {
          type: "text",
          text: "Raise the ceiling in the terminal: vapi accounts caps research --ceiling 6",
        },
      ],
    });
    const disabledCeiling = await fixture.server.callTool({
      name: "accounts.caps",
      arguments: { name: "research", ceilingUsd: "off" },
    });
    expect(disabledCeiling).toEqual({
      isError: true,
      content: [
        {
          type: "text",
          text: "Turn off the ceiling in the terminal: vapi accounts caps research --ceiling off",
        },
      ],
    });
    expect(await readFile(join(fixture.home, "wallets.json"), "utf8")).toBe(beforeCeilingRefusals);

    const missing = await fixture.server.callTool({
      name: "accounts.caps",
      arguments: { name: "research" },
    });
    expect(missing).toEqual({
      isError: true,
      content: [{ type: "text", text: "Set at least one of perCallUsd, perDayUsd or ceilingUsd." }],
    });
    const audit = await readAuditLog(fixture.home);
    expect(audit.filter((entry) => entry.event === "wallet.caps")).toEqual([
      expect.objectContaining({
        wallet: "research",
        tty: false,
        detail: "0.2 USD per call, 1 USD per day, ceilingUsd=5",
      }),
      expect.objectContaining({
        wallet: "research",
        tty: false,
        detail: "0.2 USD per call, 1 USD per day, ceilingUsd=2",
      }),
    ]);
    await fixture.server.close();
  });

  it("does not let overlapping MCP reductions restore a lower ceiling", async () => {
    const fake = new FakeLinkApi();
    const fixture = await servedVault(fake);
    await fixture.server.callTool({
      name: "accounts.add",
      arguments: { name: "research", link: false },
    });
    const otherStore = await WalletStore.open(fixture.home, {
      secrets: fixture.secrets,
      env: {},
    });
    const otherServer = createServer({
      home: fixture.home,
      store: otherStore,
      secrets: fixture.secrets,
      fake,
      account: fixture.account,
    });

    await Promise.all([
      fixture.server.callTool({
        name: "accounts.caps",
        arguments: { name: "research", ceilingUsd: 2 },
      }),
      otherServer.callTool({
        name: "accounts.caps",
        arguments: { name: "research", ceilingUsd: 4 },
      }),
    ]);

    await fixture.store.reload();
    expect(fixture.store.ceilingCaps("research").ceilingAtomic).toBe(2_000_000n);
    await otherServer.close();
    await fixture.server.close();
  });

  it("returns the setup message when there is no wallet store", async () => {
    const server = createVapiServer({
      account: privateKeyToAccount(FALLBACK_KEY),
      config: getDefaultConfig({}),
      env: {},
      fetchImpl: () => Promise.reject(new Error("No request expected.")),
    });

    const result = await server.callTool({
      name: "accounts.caps",
      arguments: { name: "research", perDayUsd: 1 },
    });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("Run vapi setup.");
    await server.close();
  });
});

describe("accounts.send", () => {
  it("returns a structured transfer result and always applies send policy", async () => {
    const fake = new FakeLinkApi();
    const fixture = await servedVault(fake, { nonce: TRANSFER_NONCE });
    const recipient = await fixture.store.create("research", "", {
      spendCaps: { perCallAtomic: "100000", perDayAtomic: "1000000" },
    });
    await trustMain(fixture.store, fixture.secrets, API_BASE);
    fake.transferFrom = fixture.account.address;
    fake.transferSibling = { name: "research", address: recipient.account.address };

    const result = await fixture.server.callTool({
      name: "accounts.send",
      arguments: { from: "main", to: "research", amountUsd: "0.05" },
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({
      status: "sent",
      from: "main",
      to: recipient.account.address,
      toName: "research",
      toKind: "account",
      amountUsd: "0.05",
      amountAtomic: "50000",
      network: "eip155:8453",
      txHash: TRANSFER_TX_HASH,
      nonce: TRANSFER_NONCE,
      replayed: false,
      message: "Sent 0.05 USDC from main to research.",
    });
    expect(fake.relayRequests).toBe(1);
    await fixture.server.close();
  });

  it("returns a coded cap error before opening a signer or calling the relay", async () => {
    const fake = new FakeLinkApi();
    const fixture = await servedVault(fake, { nonce: TRANSFER_NONCE });
    const recipient = await fixture.store.create("research", "");
    await trustMain(fixture.store, fixture.secrets, API_BASE);
    fake.transferFrom = fixture.account.address;
    fake.transferSibling = { name: "research", address: recipient.account.address };
    const unlock = vi.spyOn(fixture.store, "unlock");

    const result = await fixture.server.callTool({
      name: "accounts.send",
      arguments: { from: "main", to: "research", amountUsd: "1" },
    });

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]!.text)).toEqual({
      code: "per_call_cap_exceeded",
      message: "The amount exceeds the sending account's per-call cap. No money moved.",
    });
    expect(unlock).not.toHaveBeenCalled();
    expect(fake.relayRequests).toBe(0);
    await fixture.server.close();
  });
});

async function pendingLinkSettled(
  server: ReturnType<typeof createVapiServer>,
  name: string,
): Promise<void> {
  await vi.waitFor(async () => {
    const repeated = await server.callTool({ name: "accounts.add", arguments: { name } });
    expect(repeated.structuredContent).not.toHaveProperty("link");
  });
}

async function temporaryHome(prefix = "vapi-mcp-accounts-"): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(home);
  return home;
}

type MemorySecretStore = SecretStore & { entries: Map<string, string> };

function memorySecretStore(): MemorySecretStore {
  const entries = new Map<string, string>();
  return {
    available: true,
    platform: "darwin",
    description: "the test keychain",
    entries,
    get: async (name) => entries.get(name),
    has: async (name) => entries.has(name),
    set: async (name, value) => {
      entries.set(name, value);
    },
    remove: async (name) => entries.delete(name),
  };
}

function routerUsage(): AgentRouterUsage {
  return {
    compute: {
      allowanceUsd: 1,
      spentTodayUsd: 0,
      remainingTodayUsd: 1,
      resetsAt: "2026-09-30T00:00:00.000Z",
      ownerLimitUsd: 1,
      ownerSpentUsd: 0,
    },
    balance: null,
  };
}

async function servedVault(
  fake: FakeLinkApi,
  overrides: {
    env?: NodeJS.ProcessEnv;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    scopes?: string[];
    nonce?: Hex;
  } = {},
) {
  const home = await temporaryHome();
  const secrets = memorySecretStore();
  const store = await WalletStore.open(home, { secrets, env: overrides.env ?? {} });
  await store.create("main", "", { phrase: TEST_PHRASE });
  const account = await store.unlock("main", "");
  const server = createServer({
    home,
    store,
    secrets,
    fake,
    account,
    env: overrides.env,
    now: overrides.now,
    sleep: overrides.sleep,
    scopes: overrides.scopes,
    nonce: overrides.nonce,
  });
  return { home, secrets, store, account, server };
}

function createServer(args: {
  home: string;
  store: WalletStore;
  secrets: SecretStore;
  fake: FakeLinkApi;
  account: Awaited<ReturnType<WalletStore["unlock"]>>;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  scopes?: string[];
  nonce?: Hex;
}) {
  return createVapiServer({
    account: args.account,
    config: getDefaultConfig({}),
    store: args.store,
    wallet: "main",
    env: args.env ?? {},
    secretStore: args.secrets,
    fetchImpl: args.fake.fetch as typeof fetch,
    agentLink: { apiBase: API_BASE },
    accounts: {
      hostname: "Test Host",
      configPath: join(args.home, "config.json"),
      now: args.now ?? (() => NOW),
      sleep: args.sleep ?? args.fake.sleep,
      ...(args.scopes === undefined ? {} : { scopes: args.scopes }),
      ...(args.nonce === undefined ? {} : { nonce: args.nonce }),
    },
    status: {
      usdcBalance: async () => 0n,
      routerUsage: async () => routerUsage(),
      linkStatus: async () => "active",
      now: () => new Date(args.now?.() ?? NOW),
    },
  });
}

function transferSibling(name: string, address: string, self = false) {
  return {
    name,
    address,
    device: "test-device",
    status: "active",
    allowance: { routerPerDayUsd: null, perCallUsd: null, perDayUsd: null },
    self,
  };
}

async function trustMain(store: WalletStore, secrets: SecretStore, apiBase: string): Promise<void> {
  await store.setLink("main", {
    apiBase,
    clientId: "agent_main",
    owner: OWNER,
    label: "main",
    scopes: ["mcp:call", "router.use"],
    linkedAt: new Date(NOW).toISOString(),
  });
  await secrets.set(
    agentSecretAccounts("main").tokens,
    JSON.stringify({
      accessToken: TRUSTED_TOKEN,
      refreshToken: "trusted-refresh-token",
      expiresAt: NOW + 3_600_000,
      scopes: ["mcp:call", "router.use"],
    }),
  );
}
