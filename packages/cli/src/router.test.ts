import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  SpendCapError,
  SpendCapExceededError,
  getDefaultConfig,
  appendReceipt,
  __setReceiptTestHooks,
  readReceipts,
  type RouterPendingPurchase,
  getVapiPaths,
  drainCeilingSweeps,
  type Receipt,
  type SecretStore,
  WalletStore,
} from "@vapi-network/core";
import { AGENT_LINK_REVOKED_MESSAGE, agentSecretAccounts } from "@vapi-network/core/agent-link";
import {
  ROUTER_KEY_REVOKED_MESSAGE,
  RouterClientError,
  type buyRouterBalance,
  type AgentRouterUsage,
  type ChatRequest,
  type ChatResult,
  type RouterClientDeps,
} from "@vapi-network/core/router-client";

import { runCli, type CliDependencies, type CliIo } from "./cli.js";
import { purchaseTransport } from "../../../test-fixtures/router-purchase.js";

const PASSPHRASE = "test-only-passphrase";
const WALLET = "researcher";
const TEST_ROUTER_KEY = "test-router-key-value";
const REVOKED_ACCESS_TOKEN = "revoked-agent-access-token";
const REVOKED_REFRESH_TOKEN = "revoked-agent-refresh-token";
const REVOKED_ROUTER_KEY = "revoked-router-key";
const homes: string[] = [];
const originalHome = process.env.VAPI_HOME;
let activeSecretStore: SecretStore | undefined;
let activeSecretEntries: Record<string, string> | undefined;

afterEach(async () => {
  __setReceiptTestHooks(undefined);
  await drainCeilingSweeps();
  restoreEnvironment("VAPI_HOME", originalHome);
  activeSecretStore = undefined;
  activeSecretEntries = undefined;
  await Promise.all(homes.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("vapi router models", () => {
  it("prints model ids in human and JSON output without requiring a link", async () => {
    await initializedHome();
    const listRouterModels = vi.fn(async () => [{ id: "model-a" }, { id: "model-b" }]);
    const dependencies = commandDependencies({ router: { listRouterModels } });
    const human = captureIo();

    expect(await runCli(["router", "models", "--wallet", WALLET], human.io, dependencies)).toBe(0);
    expect(human.stdout).toEqual(["model-a", "model-b"]);
    expect(listRouterModels).toHaveBeenCalledWith({ apiBase: "https://api.vapinetwork.ai/" });

    const json = captureIo();
    expect(
      await runCli(["router", "models", "--wallet", WALLET, "--json"], json.io, dependencies),
    ).toBe(0);
    expect(JSON.parse(json.stdout[0]!)).toEqual(["model-a", "model-b"]);
  });
});

describe("vapi router clear-pending", () => {
  it.each(["none", "file", "directory"] as const)(
    "syncs an existing receipt and directory before clearing and retains the journal on %s sync failure",
    async (failure) => {
      const home = await initializedHome();
      const store = await WalletStore.open(home);
      const pending = pendingPurchase();
      await store.setRouterPendingPurchase(WALLET, pending);
      const path = getVapiPaths(home).receipts;
      await appendReceipt(
        {
          id: pending.receiptId,
          timestamp: pending.createdAt,
          wallet: WALLET,
          resourceUrl: `${pending.link.apiBase}/api/router/top-up/5`,
          source: "router.topup",
          settlement: { outcome: "succeeded" },
        },
        path,
      );
      const events: string[] = [];
      __setReceiptTestHooks({
        beforeSync: (target) => {
          if (
            (failure === "file" && target === path) ||
            (failure === "directory" && target === home)
          )
            throw new Error("ledger sync failed");
        },
        afterSync: (target) => {
          expect([path, home]).toContain(target);
          events.push(target === path ? "file-sync" : "directory-sync");
        },
      });
      const original = WalletStore.prototype.setRouterPendingPurchase;
      const clear = vi
        .spyOn(WalletStore.prototype, "setRouterPendingPurchase")
        .mockImplementation(async function (this: WalletStore, name, value, expected) {
          if (value === null) {
            expect(events).toEqual(["file-sync", "directory-sync"]);
            events.push("clear");
          }
          return await original.call(this, name, value, expected);
        });
      try {
        const captured = captureIo();
        expect(
          await runCli(
            ["router", "clear-pending", "--confirm-settled", "--account", WALLET, "--json"],
            captured.io,
            commandDependencies(),
          ),
        ).toBe(failure === "none" ? 0 : 1);
        if (failure !== "none") {
          expect(events).toEqual(failure === "file" ? [] : ["file-sync"]);
          expect(JSON.parse(captured.stdout[0]!)).toMatchObject({ error: "ledger sync failed" });
          expect((await WalletStore.open(home)).entry(WALLET)?.routerPendingPurchase).toEqual(
            pending,
          );
        } else {
          expect(events).toEqual(["file-sync", "directory-sync", "clear"]);
          expect(JSON.parse(captured.stdout[0]!)).toMatchObject({
            cleared: true,
            receiptAppended: false,
          });
          expect(
            (await WalletStore.open(home)).entry(WALLET)?.routerPendingPurchase,
          ).toBeUndefined();
        }
      } finally {
        clear.mockRestore();
      }
    },
  );

  it.each([false, true])(
    "records and prints settled evidence before retiring (JSON %s)",
    async (json) => {
      const home = await initializedHome();
      const store = await WalletStore.open(home);
      const pending = pendingPurchase();
      await store.setRouterPendingPurchase(WALLET, pending);
      const captured = captureIo();
      const original = WalletStore.prototype.setRouterPendingPurchase;
      const clear = vi
        .spyOn(WalletStore.prototype, "setRouterPendingPurchase")
        .mockImplementation(async function (this: WalletStore, name, value, expected) {
          if (value === null) {
            expect(expected).toBe(pending.receiptId);
            const rows = await readReceipts(getVapiPaths(home).receipts);
            expect(rows).toHaveLength(1);
            expect(rows[0]).toMatchObject({
              id: pending.receiptId,
              payer: pending.authorization!.from,
              authorization: { nonce: pending.authorization!.nonce },
              settlement: { outcome: "succeeded", transaction: pending.transaction },
            });
            if (json) expect(captured.stdout).toEqual([]);
            else {
              const output = captured.stdout.join("\n");
              expect(output).toContain(pending.receiptId);
              expect(output).toContain(pending.transaction);
              expect(output).toContain("$4.75 USDC");
              expect(output).toContain("Base");
              expect(output).toMatch(/keep.*evidence.*contact support/i);
            }
          }
          return original.call(this, name, value, expected);
        });
      try {
        const args = [
          "router",
          "clear-pending",
          "--confirm-settled",
          "--account",
          WALLET,
          ...(json ? ["--json"] : []),
        ];
        expect(await runCli(args, captured.io, commandDependencies())).toBe(0);
        if (json) {
          expect(captured.stdout).toHaveLength(1);
          expect(JSON.parse(captured.stdout[0]!)).toMatchObject({
            wallet: WALLET,
            pending: { receiptId: pending.receiptId, status: "settled" },
            cleared: true,
            receipt: {
              id: pending.receiptId,
              amountUsd: 4.75,
              network: "eip155:8453",
              transaction: pending.transaction,
            },
            receiptAppended: true,
            notice: expect.stringMatching(/keep.*evidence.*contact support/i),
          });
        } else expect(captured.stdout.at(-1)).toBe("Cleared the settled Router purchase.");
        expect((await WalletStore.open(home)).entry(WALLET)?.routerPendingPurchase).toBeUndefined();
        const again = captureIo();
        expect(await runCli(args, again.io, commandDependencies())).toBe(0);
        expect(await readReceipts(getVapiPaths(home).receipts)).toHaveLength(1);
        expect(again.stdout).toEqual([
          json
            ? JSON.stringify({ wallet: WALLET, pending: null, cleared: false })
            : "No pending Router purchase.",
        ]);
      } finally {
        clear.mockRestore();
      }
    },
  );

  it("emits one JSON error and retains evidence if settled clearing cannot be persisted", async () => {
    const home = await initializedHome();
    const store = await WalletStore.open(home);
    const pending = pendingPurchase();
    await store.setRouterPendingPurchase(WALLET, pending);
    const failure = vi
      .spyOn(WalletStore.prototype, "setRouterPendingPurchase")
      .mockRejectedValue(new Error("pending file is read-only"));
    try {
      const captured = captureIo();
      expect(
        await runCli(
          ["router", "clear-pending", "--confirm-settled", "--account", WALLET, "--json"],
          captured.io,
          commandDependencies(),
        ),
      ).toBe(1);
      expect(captured.stdout).toHaveLength(1);
      expect(JSON.parse(captured.stdout[0]!)).toMatchObject({
        error: "pending file is read-only",
        exitCode: 1,
      });
      expect((await WalletStore.open(home)).entry(WALLET)?.routerPendingPurchase).toEqual(pending);
      expect(await readReceipts(getVapiPaths(home).receipts)).toHaveLength(1);
    } finally {
      failure.mockRestore();
    }
  });

  it("reuses a durable receipt and reports an absent transaction", async () => {
    const home = await initializedHome();
    const store = await WalletStore.open(home);
    const pending = pendingPurchase();
    delete pending.transaction;
    await store.setRouterPendingPurchase(WALLET, pending);
    await appendReceipt(
      {
        id: pending.receiptId,
        timestamp: pending.createdAt,
        wallet: WALLET,
        resourceUrl: `${pending.link.apiBase}/api/router/top-up/5`,
        quote: { network: pending.network!, amountAtomic: pending.amountAtomic! },
        settlement: { outcome: "succeeded" },
      },
      getVapiPaths(home).receipts,
    );
    const captured = captureIo();
    expect(
      await runCli(
        ["router", "clear-pending", "--confirm-settled", "--account", WALLET, "--json"],
        captured.io,
        commandDependencies(),
      ),
    ).toBe(0);
    const output = JSON.parse(captured.stdout[0]!);
    expect(output.receiptAppended).toBe(false);
    expect(output.receipt).toEqual({
      id: pending.receiptId,
      amountUsd: 4.75,
      network: pending.network,
    });
    expect(await readReceipts(getVapiPaths(home).receipts)).toHaveLength(1);
    await store.setRouterPendingPurchase(WALLET, pending);
    const human = captureIo();
    expect(
      await runCli(
        ["router", "clear-pending", "--confirm-settled", "--account", WALLET],
        human.io,
        commandDependencies(),
      ),
    ).toBe(0);
    expect(human.stdout).toContain("Transaction: none recorded");
    expect(await readReceipts(getVapiPaths(home).receipts)).toHaveLength(1);
  });

  it.each(["prepared", "signed", "unknown"] as const)(
    "refuses settled retirement of %s without resolving or clearing it",
    async (status) => {
      const home = await initializedHome();
      const store = await WalletStore.open(home);
      const pending = pendingPurchase(status);
      await store.setRouterPendingPurchase(WALLET, pending);
      const path = join(home, "router-pending", `${WALLET}.json`);
      const before = await readFile(path, "utf8");
      const captured = captureIo();
      const fetchImpl = vi.fn<typeof fetch>();
      expect(
        await runCli(
          ["router", "clear-pending", "--confirm-settled", "--account", WALLET, "--json"],
          captured.io,
          commandDependencies({ fetchImpl }),
        ),
      ).toBe(1);
      expect(JSON.parse(captured.stdout[0]!).error).toMatch(
        /retry vapi router chat.*check the chain.*--confirm-unpaid/i,
      );
      expect(await readFile(path, "utf8")).toBe(before);
      expect(await readReceipts(getVapiPaths(home).receipts)).toEqual([]);
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  it("keeps settled evidence when the receipt ledger cannot be appended", async () => {
    const home = await initializedHome();
    const store = await WalletStore.open(home);
    const pending = pendingPurchase();
    await store.setRouterPendingPurchase(WALLET, pending);
    await mkdir(getVapiPaths(home).receipts);
    const captured = captureIo();
    expect(
      await runCli(
        ["router", "clear-pending", "--confirm-settled", "--account", WALLET, "--json"],
        captured.io,
        commandDependencies(),
      ),
    ).toBe(1);
    expect(captured.stdout).toHaveLength(1);
    expect(JSON.parse(captured.stdout[0]!)).toHaveProperty("error");
    expect((await WalletStore.open(home)).entry(WALLET)?.routerPendingPurchase).toEqual(pending);
  });

  it("does not clear if human payment evidence cannot be printed", async () => {
    const home = await initializedHome();
    const store = await WalletStore.open(home);
    const pending = pendingPurchase();
    await store.setRouterPendingPurchase(WALLET, pending);
    const captured = captureIo();
    const io = {
      ...captured.io,
      stdout: () => {
        throw new Error("output unavailable");
      },
    };
    expect(
      await runCli(
        ["router", "clear-pending", "--confirm-settled", "--account", WALLET],
        io,
        commandDependencies(),
      ),
    ).toBe(1);
    expect((await WalletStore.open(home)).entry(WALLET)?.routerPendingPurchase).toEqual(pending);
    expect(await readReceipts(getVapiPaths(home).receipts)).toHaveLength(1);
  });

  it("rejects conflicting confirmation flags", async () => {
    const home = await initializedHome();
    const store = await WalletStore.open(home);
    await store.setRouterPendingPurchase(WALLET, pendingPurchase());
    const captured = captureIo();
    expect(
      await runCli(
        [
          "router",
          "clear-pending",
          "--confirm-settled",
          "--confirm-unpaid",
          "--account",
          WALLET,
          "--json",
        ],
        captured.io,
        commandDependencies(),
      ),
    ).toBe(2);
    expect(JSON.parse(captured.stdout[0]!).error).toContain("cannot be used together");
    expect((await WalletStore.open(home)).entry(WALLET)?.routerPendingPurchase).toEqual(
      pendingPurchase(),
    );
  });

  it.each(["rename", "remove"] as const)(
    "permits %s after explicit settled retirement",
    async (operation) => {
      const home = await initializedHome();
      const store = await WalletStore.open(home, { secrets: currentSecretStore() });
      await store.create("other", PASSPHRASE);
      await store.setDefault("other");
      await store.setRouterPendingPurchase(WALLET, pendingPurchase());
      const change = () =>
        operation === "rename"
          ? store.rename(WALLET, "renamed")
          : store.remove(WALLET, { force: true });
      await expect(change()).rejects.toThrow(/pending Router purchase/);
      expect(
        await runCli(
          ["router", "clear-pending", "--confirm-settled", "--account", WALLET],
          captureIo().io,
          commandDependencies(),
        ),
      ).toBe(0);
      await expect(change()).resolves.toMatchObject({
        name: operation === "rename" ? "renamed" : WALLET,
      });
    },
  );

  it.each([
    "receipt",
    "settled",
    "used",
    "live",
    "margin",
    "expired",
    "rpc-error",
    "unsupported",
    "prepared",
  ] as const)("resolves %s evidence before an explicit clear", async (state) => {
    const home = await initializedHome();
    const store = await WalletStore.open(home);
    const now = new Date("2026-11-07T10:00:00.000Z");
    const config = getDefaultConfig({});
    // Explicit fixture networks keep the test independent of operator RPC settings.
    config.networks["eip155:5042"] = {
      rpcUrl: "https://rpc.example",
      usdc: "0x3600000000000000000000000000000000000000",
    };
    await writeFile(join(home, "config.json"), JSON.stringify(config));
    const validBefore =
      Math.floor(now.getTime() / 1000) + (state === "live" ? 120 : state === "margin" ? -5 : -120);
    const pending = {
      receiptId: `clear-${state}`,
      status:
        state === "prepared"
          ? ("prepared" as const)
          : state === "settled"
            ? ("settled" as const)
            : ("signed" as const),
      createdAt: now.toISOString(),
      tierUsd: 5 as const,
      link: {
        apiBase: "https://console.example",
        clientId: "public-client",
        owner: "0x1111111111111111111111111111111111111111" as const,
        label: "test",
        scopes: [],
        linkedAt: now.toISOString(),
      },
      network: state === "unsupported" ? "eip155:999999" : "eip155:5042",
      ...(state === "prepared"
        ? {}
        : {
            authorization: {
              token: config.networks["eip155:5042"]!.usdc,
              from: "0x1111111111111111111111111111111111111111",
              nonce: `0x${"ab".repeat(32)}`,
              validBefore: String(validBefore),
            },
          }),
    };
    await store.setRouterPendingPurchase(WALLET, pending);
    if (state === "receipt")
      await appendReceipt(
        {
          id: pending.receiptId,
          timestamp: now.toISOString(),
          wallet: WALLET,
          resourceUrl: "https://console.example/api/router/top-up/5",
          method: "POST",
          outcome: "paid",
          settlement: { outcome: "succeeded", transaction: `0x${"33".repeat(32)}` },
        },
        getVapiPaths(home).receipts,
        { wallet: WALLET },
      );
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const body = (await request.json()) as {
        id: number;
        method: string;
        params: [{ to: string; data: string }];
      };
      expect(body.method).toBe("eth_call");
      expect(body.params[0].to).toBe(pending.authorization!.token);
      expect(body.params[0].data).toContain(pending.authorization!.nonce.slice(2));
      if (state === "rpc-error") throw new Error("RPC unavailable");
      return Response.json({
        jsonrpc: "2.0",
        id: body.id,
        result: `0x${(state === "used" ? "1" : "0").padStart(64, "0")}`,
      });
    });
    const captured = captureIo();
    const exit = await runCli(
      ["router", "clear-pending", "--confirm-unpaid", "--account", WALLET, "--json"],
      captured.io,
      commandDependencies({ fetchImpl, now: () => now }),
    );
    const refuses = ["receipt", "settled", "used", "live", "margin"].includes(state);
    expect(exit).toBe(refuses ? 1 : 0);
    expect(fetchImpl).toHaveBeenCalledTimes(
      ["used", "live", "margin", "expired", "rpc-error"].includes(state) ? 1 : 0,
    );
    const retained = (await WalletStore.open(home)).entry(WALLET)?.routerPendingPurchase;
    expect(retained?.receiptId).toBe(refuses ? pending.receiptId : undefined);
    expect(captured.stdout).toHaveLength(1);
    const output = JSON.parse(captured.stdout[0]!);
    if (["receipt", "settled", "used"].includes(state))
      expect(output.error).toMatch(/payment settled.*retry chat.*key/iu);
    if (state === "live" || state === "margin")
      expect(output.error).toContain(new Date((validBefore + 31) * 1000).toISOString());
    if (state === "rpc-error" || state === "unsupported")
      expect(output.confirmation).toMatch(/human confirmed.*without chain evidence/iu);
    else if (!refuses) expect(output.confirmation).toBeUndefined();
  });

  it("emits only one JSON error when the confirmed clear cannot be persisted", async () => {
    const home = await initializedHome();
    const store = await WalletStore.open(home);
    await store.setRouterPendingPurchase(WALLET, {
      receiptId: "clear-write-failure",
      status: "unknown",
      createdAt: "2026-09-23T10:00:00.000Z",
      tierUsd: 5,
      link: {
        apiBase: "https://console.example",
        clientId: "client",
        owner: "0x1111111111111111111111111111111111111111",
        label: "test",
        scopes: [],
        linkedAt: "2026-09-23T10:00:00.000Z",
      },
    });
    const failure = vi
      .spyOn(WalletStore.prototype, "setRouterPendingPurchase")
      .mockRejectedValue(new Error("pending file is read-only"));
    try {
      const captured = captureIo();
      expect(
        await runCli(
          ["router", "clear-pending", "--confirm-unpaid", "--account", WALLET, "--json"],
          captured.io,
          commandDependencies(),
        ),
      ).toBe(1);
      expect(captured.stdout).toHaveLength(1);
      expect(JSON.parse(captured.stdout[0]!)).toMatchObject({
        error: "pending file is read-only",
        exitCode: 1,
      });
    } finally {
      failure.mockRestore();
    }
    expect((await WalletStore.open(home)).entry(WALLET)?.routerPendingPurchase?.receiptId).toBe(
      "clear-write-failure",
    );
  });

  it("prints public evidence without clearing, then requires explicit unpaid confirmation", async () => {
    const home = await initializedHome();
    const store = await WalletStore.open(home);
    const pending = {
      receiptId: "manual-recovery",
      status: "unknown" as const,
      createdAt: "2026-09-23T10:00:00.000Z",
      tierUsd: 5 as const,
      link: {
        apiBase: "https://console.example",
        clientId: "public-client",
        owner: `0x${"11".repeat(20)}` as const,
        label: "test",
        scopes: [],
        linkedAt: "2026-09-23T10:00:00.000Z",
      },
      network: "eip155:8453",
      authorization: {
        token: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        from: `0x${"11".repeat(20)}`,
        nonce: `0x${"ab".repeat(32)}`,
        validBefore: "1790157600",
      },
    };
    await store.setRouterPendingPurchase(WALLET, pending);
    const human = captureIo();
    const dependencies = commandDependencies({
      fetchImpl: vi.fn<typeof fetch>().mockRejectedValue(new Error("RPC offline")),
    });
    expect(
      await runCli(["router", "clear-pending", "--account", WALLET], human.io, dependencies),
    ).toBe(0);
    expect(human.stdout.join("\n")).toContain(pending.authorization.nonce);
    expect(human.stdout.join("\n")).toContain("https://basescan.org/address/");
    expect((await WalletStore.open(home)).entry(WALLET)?.routerPendingPurchase).toEqual(pending);
    const json = captureIo();
    expect(
      await runCli(
        ["router", "clear-pending", "--confirm-unpaid", "--account", WALLET, "--json"],
        json.io,
        dependencies,
      ),
    ).toBe(0);
    expect(JSON.parse(json.stdout[0]!)).toMatchObject({
      wallet: WALLET,
      cleared: true,
      pending: {
        receiptId: pending.receiptId,
        authorization: pending.authorization,
        instructions: expect.stringContaining("authorizationState"),
      },
    });
    expect((await WalletStore.open(home)).entry(WALLET)?.routerPendingPurchase).toBeUndefined();
  });
});

describe("vapi router usage", () => {
  it("prints the Compute allowance and preserves the usage object as JSON", async () => {
    await initializedHome();
    const usage = usageResult();
    const dependencies = commandDependencies({
      router: { routerUsage: vi.fn(async () => usage) },
    });
    const human = captureIo();

    expect(await runCli(["router", "usage", "--wallet", WALLET], human.io, dependencies)).toBe(0);
    expect(human.stdout).toEqual([
      "Compute today: $0.42 of $2.00 (resets 03:07 UTC)",
      "Owner's Compute: $0.90 of $5.00",
      "Router balance: none bought yet",
    ]);

    const json = captureIo();
    expect(
      await runCli(["router", "usage", "--wallet", WALLET, "--json"], json.io, dependencies),
    ).toBe(0);
    expect(JSON.parse(json.stdout[0]!)).toEqual(usage);
  });

  it("formats a purchased Router balance", async () => {
    await initializedHome();
    const dependencies = commandDependencies({
      router: {
        routerUsage: async () => ({
          ...usageResult(),
          balance: { purchasedUsd: 10, spentUsd: 2.25, remainingUsd: 7.75 },
        }),
      },
    });
    const captured = captureIo();

    expect(await runCli(["router", "usage", "--wallet", WALLET], captured.io, dependencies)).toBe(
      0,
    );
    expect(captured.stdout).toContain("Router balance: $7.75 (bought $10.00, used $2.25)");
  });
});

describe("vapi router buy", () => {
  it("does not claim payment succeeded when settlement was rejected", async () => {
    await initializedHome();
    const purchase = purchaseResult(null);
    const captured = captureIo();
    const dependencies = commandDependencies({
      router: {
        buyRouterBalance: async () => ({
          ...purchase,
          receipt: {
            ...purchase.receipt,
            settlement: { outcome: "rejected", transaction: "0xtransaction" },
          },
        }),
      },
    });
    expect(
      await runCli(["router", "buy", "5", "--account", WALLET], captured.io, dependencies),
    ).toBe(0);
    expect(captured.stdout[0]).toContain("settlement was rejected");
    expect(allOutput(captured)).not.toMatch(/\bPaid\b|Payment succeeded/);
    expect(captured.stdout).toContain("Transaction: 0xtransaction");
  });

  it.each([false, true])(
    "reports an unconfirmed authorization through real payment (JSON %s)",
    async (json) => {
      const dependencies = await linkedRouterDependencies(async (input, init) =>
        transport.fetchImpl(input, init),
      );
      const home = process.env.VAPI_HOME!;
      const transport = purchaseTransport(home, "key-store", "https://router.example", {
        noSettlementHeader: true,
      });
      await writeFile(
        join(home, "config.json"),
        JSON.stringify({ ...getDefaultConfig({}), allowPrivateNetwork: true }),
      );
      const store = await WalletStore.open(home, { secrets: currentSecretStore() });
      await store.setSpendCaps(WALLET, { perCallAtomic: "5000000", perDayAtomic: "20000000" });
      const captured = captureIo();
      expect(
        await runCli(
          ["router", "buy", "5", "--account", WALLET, ...(json ? ["--json"] : [])],
          captured.io,
          dependencies,
        ),
      ).toBe(0);
      const pending = (await WalletStore.open(home)).entry(WALLET)?.routerPendingPurchase;
      expect(pending?.status).toBe("signed");
      expect(transport.calls.paid).toBe(1);
      if (json)
        expect(JSON.parse(captured.stdout[0]!)).toMatchObject({
          receipt: { id: pending!.receiptId, settlement: "unknown" },
          warnings: [{ code: "settlement_unconfirmed" }],
        });
      else {
        expect(captured.stdout[0]).toMatch(
          /authorization was sent.*settlement is not confirmed yet.*do not repeat/i,
        );
        expect(allOutput(captured)).not.toMatch(/\bPaid\b|Payment succeeded/);
        expect(captured.stdout).toContain(`Receipt: ${pending!.receiptId}`);
        expect(captured.stderr.join("\n")).toContain("settlement is not confirmed yet");
      }
    },
  );

  it.each(["audit", "key", "balance"] as const)(
    "returns success through real payment when %s follow-up fails",
    async (failure) => {
      const dependencies = await linkedRouterDependencies(
        async (input, init) => await transport.fetchImpl(input, init),
      );
      const home = process.env.VAPI_HOME!;
      const transport = purchaseTransport(home, failure);
      await writeFile(
        join(home, "config.json"),
        JSON.stringify({ ...getDefaultConfig({}), allowPrivateNetwork: true }),
      );
      const store = await WalletStore.open(home, { secrets: currentSecretStore() });
      await store.setSpendCaps(WALLET, { perCallAtomic: "5000000", perDayAtomic: "20000000" });
      const captured = captureIo();
      expect(
        await runCli(
          ["router", "buy", "5", "--wallet", WALLET, "--json"],
          captured.io,
          dependencies,
        ),
      ).toBe(0);
      expect(transport.calls.paid).toBe(1);
      expect(JSON.parse(captured.stdout[0]!)).toMatchObject({
        receipt: { amountUsd: 4.75, id: expect.any(String) },
        warnings: [
          {
            code:
              failure === "audit"
                ? "audit_unavailable"
                : failure === "key"
                  ? "router_key_unavailable"
                  : "balance_unavailable",
          },
          ...(failure === "key" || failure === "balance" ? [{ code: "credit_pending" }] : []),
        ],
      });
      expect(allOutput(captured)).not.toContain("private-follow-up-error-must-not-leak");
    },
  );

  it.each([
    {
      label: "the charged quote rather than the requested tier",
      quote: { network: "eip155:5042", amountAtomic: "4750000" },
      evidence: { network: "eip155:8453" },
      amountUsd: 4.75,
      network: "eip155:5042",
    },
    {
      label: "settlement evidence when the quote is absent",
      quote: undefined,
      evidence: { network: "eip155:5042" },
      amountUsd: null,
      network: "eip155:5042",
    },
    {
      label: "unknown values when payment metadata is absent",
      quote: undefined,
      evidence: undefined,
      amountUsd: null,
      network: "unknown",
    },
  ])(
    "reports $label after a successful purchase",
    async ({ quote, evidence, amountUsd, network }) => {
      await initializedHome();
      const receipt: Receipt = {
        ...purchaseResult().receipt,
        quote,
        settlement: { outcome: "succeeded", transaction: "0xtransaction", evidence },
      };
      const buy = vi.fn<typeof buyRouterBalance>(async () => ({ receipt, balance: null }));
      const dependencies = {
        ...commandDependencies(),
        router: { buyRouterBalance: buy },
      };
      const captured = captureIo();

      expect(
        await runCli(
          ["router", "buy", "5", "--wallet", WALLET, "--json"],
          captured.io,
          dependencies,
        ),
      ).toBe(0);
      expect(JSON.parse(captured.stdout[0]!)).toMatchObject({
        receipt: { amountUsd, network },
        tierUsd: 5,
      });
      expect(buy).toHaveBeenCalledTimes(1);

      const human = captureIo();
      expect(await runCli(["router", "buy", "5", "--wallet", WALLET], human.io, dependencies)).toBe(
        0,
      );
      expect(human.stdout.join("\n")).toContain(
        amountUsd === null ? "charged amount unknown" : "Paid $4.75 USDC",
      );
    },
  );

  it("unlocks the wallet, applies its spend caps, and prints the paid balance", async () => {
    await initializedHome();
    const buy = vi.fn<typeof buyRouterBalance>(async () => purchaseResult());
    const secret = vi.fn(async () => PASSPHRASE);
    const captured = captureIo();

    expect(
      await runCli(["router", "buy", "5", "--wallet", WALLET], captured.io, {
        ...commandDependencies(),
        interactive: true,
        prompts: { secret },
        router: { buyRouterBalance: buy },
      }),
    ).toBe(0);
    expect(captured.stdout).toEqual([
      "Paid $5.00 USDC on Base. Router balance: $7.40.",
      "Receipt: router-receipt",
      "Transaction: 0xtransaction",
    ]);
    expect(secret).not.toHaveBeenCalled();
    expect(buy).toHaveBeenCalledWith(
      expect.objectContaining({
        wallet: WALLET,
        caps: { perCallAtomic: "100000", perDayAtomic: "1000000" },
        paths: expect.objectContaining({
          ledgerPath: expect.stringContaining("spend-ledger.json"),
          receiptsPath: expect.stringContaining("receipts.jsonl"),
        }),
      }),
      5,
    );
    expect(allOutput(captured)).toContain("router-receipt");
    expect(allOutput(captured)).toContain("0xtransaction");
  });

  it("prints a secret-free JSON summary and handles a not-yet-visible balance", async () => {
    await initializedHome();
    const buy = vi.fn<typeof buyRouterBalance>(async () => purchaseResult(null));
    const dependencies = {
      ...commandDependencies(),
      interactive: true,
      prompts: { secret: async () => PASSPHRASE },
      router: { buyRouterBalance: buy },
    };
    const json = captureIo();

    expect(
      await runCli(["router", "buy", "5", "--wallet", WALLET, "--json"], json.io, dependencies),
    ).toBe(0);
    expect(JSON.parse(json.stdout[0]!)).toEqual({
      tierUsd: 5,
      receipt: {
        amountUsd: 5,
        network: "eip155:8453",
        transaction: "0xtransaction",
        settlement: "succeeded",
        id: "router-receipt",
      },
      balance: null,
    });
    expect(allOutput(json)).not.toContain(TEST_ROUTER_KEY);

    const human = captureIo();
    expect(await runCli(["router", "buy", "5", "--wallet", WALLET], human.io, dependencies)).toBe(
      0,
    );
    expect(human.stdout).toEqual([
      "Paid $5.00 USDC on Base. Router balance is not visible yet.",
      "Receipt: router-receipt",
      "Transaction: 0xtransaction",
    ]);
  });

  it("stores and clears automatic refill without unlocking the wallet", async () => {
    const home = await initializedHome();
    const secret = vi.fn(async () => PASSPHRASE);
    const human = captureIo();
    const dependencies = {
      ...commandDependencies(),
      interactive: true,
      prompts: { secret },
    };

    expect(
      await runCli(
        ["router", "buy", "--auto", "5", "--below", "2.50", "--wallet", WALLET],
        human.io,
        dependencies,
      ),
    ).toBe(0);
    expect(human.stdout).toEqual([
      "Automatic Router refill: buy $5.00 when the balance is below $2.50.",
    ]);
    expect(
      (await WalletStore.open(home, { secrets: currentSecretStore() })).entry(WALLET)?.routerRefill,
    ).toEqual({
      tierUsd: 5,
      belowUsd: 2.5,
    });
    expect(secret).not.toHaveBeenCalled();

    const json = captureIo();
    expect(
      await runCli(
        ["router", "buy", "--auto", "off", "--wallet", WALLET, "--json"],
        json.io,
        dependencies,
      ),
    ).toBe(0);
    expect(JSON.parse(json.stdout[0]!)).toEqual({ wallet: WALLET, routerRefill: null });
    expect(
      (await WalletStore.open(home, { secrets: currentSecretStore() })).entry(WALLET)?.routerRefill,
    ).toBeUndefined();
    expect(secret).not.toHaveBeenCalled();
  });

  it("rejects unsupported tiers as usage errors", async () => {
    await initializedHome();
    const captured = captureIo();

    expect(
      await runCli(["router", "buy", "3", "--wallet", WALLET, "--json"], captured.io, {
        ...commandDependencies(),
        interactive: true,
        prompts: { secret: async () => PASSPHRASE },
      }),
    ).toBe(2);
    expect(JSON.parse(captured.stdout[0]!)).toEqual({
      error: "Router balance tier must be 1, 5, 20, or 50.",
      exitCode: 2,
    });
  });

  it("reports spend-policy refusal as an operational error with the caps remedy", async () => {
    await initializedHome();
    const buy = vi.fn<typeof buyRouterBalance>(async () => {
      throw new SpendCapError("per_call_cap_exceeded", "Refusing to sign.");
    });
    const captured = captureIo();

    expect(
      await runCli(["router", "buy", "5", "--wallet", WALLET, "--json"], captured.io, {
        ...commandDependencies(),
        interactive: true,
        prompts: { secret: async () => PASSPHRASE },
        router: { buyRouterBalance: buy },
      }),
    ).toBe(1);
    expect(JSON.parse(captured.stdout[0]!)).toEqual({
      error:
        "Router balance purchase refused by the wallet spend policy: Refusing to sign. Review or change it with vapi accounts caps researcher.",
      exitCode: 1,
    });
  });

  it("preserves a typed spend-cap refusal for the top-level JSON handler", async () => {
    await initializedHome();
    const refusal = new SpendCapExceededError({
      cap: "per_call",
      amountUsd: "5",
      limitUsd: "1",
      wallet: WALLET,
    });
    const buy = vi.fn<typeof buyRouterBalance>(async () => {
      throw refusal;
    });
    const captured = captureIo();

    expect(
      await runCli(["router", "buy", "5", "--wallet", WALLET, "--json"], captured.io, {
        ...commandDependencies(),
        interactive: true,
        prompts: { secret: async () => PASSPHRASE },
        router: { buyRouterBalance: buy },
      }),
    ).toBe(1);
    expect(JSON.parse(captured.stdout[0]!)).toEqual({ error: refusal.toJSON(), exitCode: 1 });
  });
});

describe("vapi router chat", () => {
  it.each([
    { mode: "stake", json: false },
    { mode: "stake", json: true },
    { mode: "budget", json: false },
    { mode: "budget", json: true },
    { mode: "missing", json: false },
    { mode: "missing", json: true },
  ])(
    "preserves unlinked payment warnings during $mode chat (JSON $json)",
    async ({ mode, json }) => {
      const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
        const req = input instanceof Request ? input : new Request(input, init);
        expect(req.url).toBe("https://router.example/v1/chat/completions");
        expect(req.headers.get("authorization")).toBe(`Bearer ${REVOKED_ROUTER_KEY}`);
        return mode === "budget"
          ? new Response("Budget has been exceeded", { status: 429 })
          : Response.json({ choices: [{ message: { content: "stake answer" } }] });
      });
      const dependencies = await linkedRouterDependencies(fetchImpl);
      const home = process.env.VAPI_HOME!;
      const store = await WalletStore.open(home, { secrets: currentSecretStore() });
      const pending = pendingPurchase();
      await store.setRouterPendingPurchase(WALLET, pending);
      await store.setRouterRefill(WALLET, { belowUsd: 1, tierUsd: 5 });
      if (mode === "missing") await store.clearLink(WALLET);
      else
        await store.setLink(WALLET, {
          ...pending.link,
          owner: "0x2222222222222222222222222222222222222222",
        });
      const captured = captureIo();
      expect(
        await runCli(
          [
            "router",
            "chat",
            "--model",
            "m",
            "hi",
            "--account",
            WALLET,
            ...(json ? ["--json"] : []),
          ],
          captured.io,
          dependencies,
        ),
      ).toBe(mode === "stake" ? 0 : 1);
      if (json) {
        const output = JSON.parse(captured.stdout[0]!);
        expect(output.refill).toMatchObject({
          receipt: { id: pending.receiptId, settlement: "succeeded" },
          balance: null,
          warnings: [
            {
              code: "pending_purchase_unlinked",
              message: expect.stringContaining(
                `vapi router clear-pending --confirm-settled --account ${WALLET}`,
              ),
            },
          ],
        });
        if (mode === "stake") expect(output.content).toBe("stake answer");
        else expect(output.code).toBe(mode === "missing" ? "not_linked" : "budget_exhausted");
        if (mode === "missing") expect(output.error).toBe("Not linked. Run vapi login.");
      } else {
        expect(captured.stderr.join("\n")).toContain(pending.receiptId);
        expect(captured.stderr.join("\n")).toContain(
          `vapi router clear-pending --confirm-settled --account ${WALLET}`,
        );
        if (mode === "stake") expect(captured.stdout).toEqual(["stake answer"]);
        if (mode === "missing") expect(captured.stderr).toContain("Not linked. Run vapi login.");
      }
      expect(fetchImpl).toHaveBeenCalledTimes(mode === "missing" ? 0 : 1);
      expect((await WalletStore.open(home)).entry(WALLET)?.routerPendingPurchase).toEqual(pending);
    },
  );

  it.each(["chat", "buy"] as const)(
    "preserves refill while normalizing not_linked %s errors",
    async (command) => {
      await initializedHome();
      const refill = {
        ...purchaseResult(null),
        warnings: [
          {
            code: "pending_purchase_unlinked" as const,
            message: `Keep router-receipt; run vapi router clear-pending --confirm-settled --account ${WALLET}.`,
          },
        ],
      };
      const fail = async () => {
        throw new RouterClientError("not_linked", "Original missing-link message", 401, refill);
      };
      const dependencies = commandDependencies({
        router: { routerChat: fail, buyRouterBalance: fail },
      });
      const args =
        command === "chat"
          ? ["router", "chat", "--model", "m", "hi", "--account", WALLET]
          : ["router", "buy", "5", "--account", WALLET];
      const json = captureIo();
      expect(await runCli([...args, "--json"], json.io, dependencies)).toBe(1);
      expect(JSON.parse(json.stdout[0]!)).toMatchObject({
        error: "Not linked. Run vapi login.",
        code: "not_linked",
        refill: {
          receipt: { id: "router-receipt", settlement: "succeeded" },
          warnings: refill.warnings,
        },
      });
      const human = captureIo();
      expect(await runCli(args, human.io, dependencies)).toBe(1);
      expect(human.stderr).toContain(refill.warnings[0]!.message);
      expect(human.stderr).toContain("Not linked. Run vapi login.");
    },
  );

  it("does not unlock the payment account for a credential-only retry", async () => {
    const home = await initializedHome();
    const store = await WalletStore.open(home, { secrets: currentSecretStore() });
    await store.setRouterRefill(WALLET, { tierUsd: 5, belowUsd: 2 });
    const unlock = vi.spyOn(WalletStore.prototype, "unlock");
    try {
      const result = await runCli(
        ["router", "chat", "--wallet", WALLET, "--model", "model-a", "retry"],
        captureIo().io,
        commandDependencies({ router: { routerChat: async () => chatResult() } }),
      );
      expect(result).toBe(0);
      expect(unlock).not.toHaveBeenCalled();
    } finally {
      unlock.mockRestore();
    }
  });

  it("preserves settled refill evidence in chat errors and payment-aware guidance", async () => {
    await initializedHome();
    const purchase = {
      ...purchaseResult(null),
      warnings: [{ code: "router_key_unavailable" as const, message: "Key recovery is pending." }],
    };
    const message =
      "Payment settled, but the Router balance key is not yet available. It will be fetched on the next request.";
    const dependencies = commandDependencies({
      router: {
        routerChat: async () => {
          throw new RouterClientError("refill_pending", message, undefined, purchase);
        },
      },
    });
    const json = captureIo();
    expect(
      await runCli(
        ["router", "chat", "--wallet", WALLET, "--model", "model-a", "hi", "--json"],
        json.io,
        dependencies,
      ),
    ).toBe(1);
    expect(JSON.parse(json.stdout[0]!)).toMatchObject({
      error: message,
      code: "refill_pending",
      exitCode: 1,
      refill: {
        receipt: { id: "router-receipt", amountUsd: 5 },
        balance: null,
        warnings: purchase.warnings,
      },
    });
    const human = captureIo();
    expect(
      await runCli(
        ["router", "chat", "--wallet", WALLET, "--model", "model-a", "hi"],
        human.io,
        dependencies,
      ),
    ).toBe(1);
    expect(human.stderr).toContain(message);
    expect(human.stderr.join("\n")).toContain("router-receipt");
    expect(human.stderr.join("\n")).toContain("0xtransaction");
  });

  it("keeps auto-refill warnings in chat JSON and human diagnostics", async () => {
    await initializedHome();
    const refill = {
      ...purchaseResult(null),
      warnings: [
        {
          code: "balance_unavailable" as const,
          message: "Payment succeeded; balance unavailable.",
        },
      ],
    };
    const dependencies = commandDependencies({
      router: { routerChat: async () => ({ ...chatResult(), refill }) },
    });
    const json = captureIo();
    expect(
      await runCli(
        ["router", "chat", "--wallet", WALLET, "--model", "model-a", "hi", "--json"],
        json.io,
        dependencies,
      ),
    ).toBe(0);
    expect(JSON.parse(json.stdout[0]!)).toMatchObject({
      content: "Done.",
      refill: {
        receipt: {
          id: "router-receipt",
          amountUsd: 5,
          network: "eip155:8453",
          transaction: "0xtransaction",
        },
        balance: null,
        warnings: refill.warnings,
      },
    });
    const human = captureIo();
    expect(
      await runCli(
        ["router", "chat", "--wallet", WALLET, "--model", "model-a", "hi"],
        human.io,
        dependencies,
      ),
    ).toBe(0);
    expect(human.stderr).toContain(refill.warnings[0]!.message);
    expect(allOutput(human)).toContain("router-receipt");
    expect(allOutput(human)).toContain("0xtransaction");
  });

  it("builds system and user messages and prints human and JSON results", async () => {
    await initializedHome();
    const result: ChatResult = {
      model: "model-a",
      content: "Hello from the Router.",
      toolCalls: [],
      usage: { prompt_tokens: 4, completion_tokens: 5, total_tokens: 9 },
      keyUsed: "stake",
    };
    const routerChat = vi.fn(async (_deps: RouterClientDeps, _request: ChatRequest) => result);
    const dependencies = commandDependencies({ router: { routerChat } });
    const human = captureIo();

    expect(
      await runCli(
        [
          "router",
          "chat",
          "--wallet",
          WALLET,
          "--model",
          "model-a",
          "--system",
          "Be concise.",
          "--max-tokens",
          "200",
          "Hello",
        ],
        human.io,
        dependencies,
      ),
    ).toBe(0);
    expect(human.stdout).toEqual(["Hello from the Router."]);
    expect(routerChat.mock.calls[0]![1]).toEqual({
      model: "model-a",
      messages: [
        { role: "system", content: "Be concise." },
        { role: "user", content: "Hello" },
      ],
      max_tokens: 200,
    });

    const json = captureIo();
    expect(
      await runCli(
        ["router", "chat", "--wallet", WALLET, "--model", "model-a", "Hello", "--json"],
        json.io,
        dependencies,
      ),
    ).toBe(0);
    expect(JSON.parse(json.stdout[0]!)).toEqual({
      model: "model-a",
      content: "Hello from the Router.",
      usage: { prompt_tokens: 4, completion_tokens: 5, total_tokens: 9 },
    });
  });

  it("reads a dash prompt from the injected stdin reader", async () => {
    await initializedHome();
    const routerChat = vi.fn(async (_deps: RouterClientDeps, _request: ChatRequest) =>
      chatResult(),
    );
    const readStdin = vi.fn(async () => "Prompt from stdin\n");
    const captured = captureIo();

    expect(
      await runCli(
        ["router", "chat", "--wallet", WALLET, "--model", "model-a", "-"],
        captured.io,
        commandDependencies({ router: { routerChat }, readStdin }),
      ),
    ).toBe(0);
    expect(readStdin).toHaveBeenCalledOnce();
    expect(routerChat.mock.calls[0]![1].messages).toEqual([
      { role: "user", content: "Prompt from stdin\n" },
    ]);
  });

  it("reports a revoked link in one line for chat, including JSON errors", async () => {
    const fetchImpl = revokedLinkFetch();
    const dependencies = await linkedRouterDependencies(fetchImpl);
    const human = captureIo();

    expect(
      await runCli(
        ["router", "chat", "--wallet", WALLET, "--model", "model-a", "Hello"],
        human.io,
        dependencies,
      ),
    ).toBe(1);
    expect(human.stdout).toEqual([]);
    expect(human.stderr).toEqual([
      "--wallet is now --account; --wallet keeps working for one release.",
      AGENT_LINK_REVOKED_MESSAGE,
    ]);
    expect(human.stderr.join("\n")).not.toContain("could not be read safely");
    expect(human.stderr.join("\n")).not.toMatch(/\bat\s/);
    expect(allOutput(human)).not.toContain(REVOKED_ACCESS_TOKEN);
    expect(allOutput(human)).not.toContain(REVOKED_REFRESH_TOKEN);
    expect(allOutput(human)).not.toContain(REVOKED_ROUTER_KEY);

    const json = captureIo();
    expect(
      await runCli(
        ["router", "chat", "--wallet", WALLET, "--model", "model-a", "Hello", "--json"],
        json.io,
        dependencies,
      ),
    ).toBe(1);
    expect(JSON.parse(json.stdout[0]!)).toEqual({ error: AGENT_LINK_REVOKED_MESSAGE, exitCode: 1 });
    expect(json.stderr).toEqual([
      "--wallet is now --account; --wallet keeps working for one release.",
    ]);
    expect(allOutput(json)).not.toContain(REVOKED_ACCESS_TOKEN);
    expect(allOutput(json)).not.toContain(REVOKED_REFRESH_TOKEN);
    expect(allOutput(json)).not.toContain(REVOKED_ROUTER_KEY);
  });

  it("reports a revoked Router link for usage and key rotation", async () => {
    const fetchImpl = revokedLinkFetch();
    const dependencies = await linkedRouterDependencies(fetchImpl);

    for (const argv of [
      ["router", "usage", "--wallet", WALLET],
      ["router", "key", "--rotate", "--wallet", WALLET],
    ]) {
      const captured = captureIo();
      expect(await runCli(argv, captured.io, dependencies)).toBe(1);
      expect(captured.stdout).toEqual([]);
      expect(captured.stderr).toEqual([
        "--wallet is now --account; --wallet keeps working for one release.",
        AGENT_LINK_REVOKED_MESSAGE,
      ]);
      expect(allOutput(captured)).not.toContain(REVOKED_ACCESS_TOKEN);
      expect(allOutput(captured)).not.toContain(REVOKED_REFRESH_TOKEN);
      expect(allOutput(captured)).not.toContain(REVOKED_ROUTER_KEY);
    }
  });

  it("reports a rejected Router key when the agent link is still active", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.host === "router.example") return new Response("rejected", { status: 401 });
      if (url.pathname === "/api/agents/self/router") return Response.json(usageResult());
      throw new Error(`Unexpected test URL ${url.origin}${url.pathname}`);
    });
    const dependencies = await linkedRouterDependencies(fetchImpl);
    const captured = captureIo();

    expect(
      await runCli(
        ["router", "chat", "--wallet", WALLET, "--model", "model-a", "Hello"],
        captured.io,
        dependencies,
      ),
    ).toBe(1);
    expect(captured.stdout).toEqual([]);
    expect(captured.stderr).toEqual([
      "--wallet is now --account; --wallet keeps working for one release.",
      ROUTER_KEY_REVOKED_MESSAGE,
    ]);
    expect(allOutput(captured)).not.toContain(REVOKED_ACCESS_TOKEN);
    expect(allOutput(captured)).not.toContain(REVOKED_REFRESH_TOKEN);
    expect(allOutput(captured)).not.toContain(REVOKED_ROUTER_KEY);
  });

  it("offers auto-refill for a device-vault wallet without prompting", async () => {
    const home = await initializedHome();
    const store = await WalletStore.open(home, { secrets: currentSecretStore() });
    await store.setRouterRefill(WALLET, { tierUsd: 5, belowUsd: 2 });
    const prompt = vi.fn(async () => PASSPHRASE);
    const unlockedChat = vi.fn(async (_deps: RouterClientDeps, _request: ChatRequest) =>
      chatResult(),
    );
    expect(
      await runCli(
        ["router", "chat", "--wallet", WALLET, "--model", "model-a", "Hello"],
        captureIo().io,
        commandDependencies({
          interactive: true,
          prompts: { secret: prompt },
          router: { routerChat: unlockedChat },
        }),
      ),
    ).toBe(0);
    const refill = unlockedChat.mock.calls[0]![0].refill;
    expect(refill).toBeDefined();
    expect(typeof refill!.caps === "function" ? await refill!.caps() : refill!.caps).toEqual({
      perCallAtomic: "100000",
      perDayAtomic: "1000000",
    });
    expect(prompt).not.toHaveBeenCalled();
  });

  it.each([
    [
      ["router", "chat", "hello"],
      'Missing --model <id>.\nUsage: vapi router chat --model <id> [--system <text>] [--max-tokens <n>] "<prompt>".',
    ],
    [
      ["router", "chat", "--model", "model-a"],
      'Missing <prompt>.\nUsage: vapi router chat --model <id> [--system <text>] [--max-tokens <n>] "<prompt>".',
    ],
  ] as const)("rejects an incomplete invocation", async (argv, message) => {
    await initializedHome();
    const captured = captureIo();

    expect(await runCli([...argv, "--json"], captured.io, commandDependencies())).toBe(2);
    expect(JSON.parse(captured.stdout[0]!)).toEqual({ error: message, exitCode: 2 });
  });
});

describe("vapi router key", () => {
  it("prints a Router key only for an allowed terminal run and audits the export", async () => {
    const home = await initializedHome();
    const routerCredentials = vi.fn(async () => ({
      baseURL: "https://router.vapinetwork.ai/v1",
      apiKey: TEST_ROUTER_KEY,
    }));
    const captured = captureIo();

    expect(
      await runCli(
        ["router", "key", "--wallet", WALLET],
        captured.io,
        commandDependencies({ interactive: true, env: {}, router: { routerCredentials } }),
      ),
    ).toBe(0);
    expect(captured.stdout).toEqual([TEST_ROUTER_KEY]);
    expect(captured.stderr.join("\n")).not.toContain(TEST_ROUTER_KEY);
    const audit = await readFile(join(home, "audit.log"), "utf8");
    expect(audit).toContain('"event":"secret.export.key"');
    expect(audit).not.toContain(TEST_ROUTER_KEY);
  });

  it.each([
    ["an agent marker", true, { CLAUDECODE: "1" }, "CLAUDECODE is set."],
    ["non-TTY output", false, {}, "stdin is not a terminal."],
  ])("refuses for %s before reading the key", async (_name, interactive, env, reason) => {
    await initializedHome();
    const routerCredentials = vi.fn(async () => ({
      baseURL: "https://router.vapinetwork.ai/v1",
      apiKey: TEST_ROUTER_KEY,
    }));
    const captured = captureIo();

    expect(
      await runCli(
        ["router", "key", "--wallet", WALLET],
        captured.io,
        commandDependencies({ interactive, env, router: { routerCredentials } }),
      ),
    ).toBe(1);
    expect(routerCredentials).not.toHaveBeenCalled();
    expect(captured.stdout).toEqual([]);
    expect(captured.stderr.join("\n")).toContain(
      "Run this yourself in a terminal; an agent must never see these words.",
    );
    expect(captured.stderr.join("\n")).toContain(reason);
    expect(allOutput(captured)).not.toContain(TEST_ROUTER_KEY);
  });

  it("always refuses JSON output before reading the key", async () => {
    await initializedHome();
    const routerCredentials = vi.fn(async () => ({
      baseURL: "https://router.vapinetwork.ai/v1",
      apiKey: TEST_ROUTER_KEY,
    }));
    const captured = captureIo();

    expect(
      await runCli(
        ["router", "key", "--wallet", WALLET, "--json"],
        captured.io,
        commandDependencies({ interactive: true, env: {}, router: { routerCredentials } }),
      ),
    ).toBe(1);
    expect(routerCredentials).not.toHaveBeenCalled();
    expect(JSON.parse(captured.stdout[0]!)).toEqual({
      error:
        "Run this yourself in a terminal; an agent must never see these words. Router keys are never printed as JSON.",
      exitCode: 1,
    });
    expect(allOutput(captured)).not.toContain(TEST_ROUTER_KEY);
  });

  it("rotates the key without exposing it in human or JSON output", async () => {
    await initializedHome();
    const rotateRouterKey = vi.fn(async () => undefined);
    const dependencies = commandDependencies({ router: { rotateRouterKey } });
    const human = captureIo();

    expect(
      await runCli(["router", "key", "--wallet", WALLET, "--rotate"], human.io, dependencies),
    ).toBe(0);
    expect(human.stdout).toEqual(["New Router key stored."]);
    expect(allOutput(human)).not.toContain(TEST_ROUTER_KEY);

    const json = captureIo();
    expect(
      await runCli(
        ["router", "key", "--wallet", WALLET, "--rotate", "--json"],
        json.io,
        dependencies,
      ),
    ).toBe(0);
    expect(JSON.parse(json.stdout[0]!)).toEqual({ wallet: WALLET, rotated: true });
    expect(allOutput(json)).not.toContain(TEST_ROUTER_KEY);
  });
});

describe("Router client errors", () => {
  it("lists the buy command in the router usage error", async () => {
    const captured = captureIo();

    expect(await runCli(["router", "--json"], captured.io, commandDependencies())).toBe(2);
    expect(JSON.parse(captured.stdout[0]!)).toEqual({
      error: "Usage: vapi router <models|usage|chat|key|buy|clear-pending>.",
      exitCode: 2,
    });
  });

  it("normalizes an unlinked wallet in human and JSON output", async () => {
    await initializedHome();
    const routerUsage = vi.fn(async () => {
      throw new RouterClientError("not_linked", "unsafe service detail");
    });
    const dependencies = commandDependencies({ router: { routerUsage } });
    const human = captureIo();

    expect(await runCli(["router", "usage", "--wallet", WALLET], human.io, dependencies)).toBe(1);
    expect(human.stderr).toEqual([
      "--wallet is now --account; --wallet keeps working for one release.",
      "Not linked. Run vapi login.",
    ]);

    const json = captureIo();
    expect(
      await runCli(["router", "usage", "--wallet", WALLET, "--json"], json.io, dependencies),
    ).toBe(1);
    expect(JSON.parse(json.stdout[0]!)).toEqual({
      error: "Not linked. Run vapi login.",
      exitCode: 1,
    });
  });
});

function usageResult(): AgentRouterUsage {
  return {
    compute: {
      allowanceUsd: 2,
      spentTodayUsd: 0.42,
      remainingTodayUsd: 1.58,
      resetsAt: "2026-09-24T03:07:00.000Z",
      ownerLimitUsd: 5,
      ownerSpentUsd: 0.9,
    },
    balance: null,
  };
}

function purchaseResult(
  balance: AgentRouterUsage["balance"] = {
    purchasedUsd: 10,
    spentUsd: 2.6,
    remainingUsd: 7.4,
  },
): Awaited<ReturnType<typeof buyRouterBalance>> {
  return {
    receipt: {
      id: "router-receipt",
      timestamp: "2026-09-23T12:00:00.000Z",
      resourceUrl: "https://api.vapinetwork.ai/api/router/top-up/5",
      quote: { network: "eip155:8453", amountAtomic: "5000000" },
      settlement: { outcome: "succeeded", transaction: "0xtransaction" },
    },
    balance,
  };
}

function chatResult(): ChatResult {
  return {
    model: "model-a",
    content: "Done.",
    toolCalls: [],
    keyUsed: "stake",
  };
}

function commandDependencies(overrides: Partial<CliDependencies> = {}): CliDependencies {
  return {
    interactive: false,
    env: {},
    secretStore: activeSecretStore ?? secretStoreStub(),
    ...overrides,
  };
}

async function linkedRouterDependencies(fetchImpl: typeof fetch): Promise<CliDependencies> {
  const home = await initializedHome();
  const store = await WalletStore.open(home, { secrets: currentSecretStore() });
  await store.setLink(WALLET, {
    apiBase: "https://console.example",
    clientId: "agent_researcher",
    owner: "0x1111111111111111111111111111111111111111",
    label: WALLET,
    scopes: ["mcp:call", "router.use"],
    linkedAt: "2026-09-23T10:00:00.000Z",
    routerBaseUrl: "https://router.example",
  });
  const accounts = agentSecretAccounts(WALLET);
  const secretStore = currentSecretStore();
  await secretStore.set(
    accounts.tokens,
    JSON.stringify({
      accessToken: REVOKED_ACCESS_TOKEN,
      refreshToken: REVOKED_REFRESH_TOKEN,
      expiresAt: Number.MAX_SAFE_INTEGER,
      scopes: ["mcp:call", "router.use"],
    }),
  );
  await secretStore.set(accounts.routerStake, REVOKED_ROUTER_KEY);
  return commandDependencies({ fetchImpl, secretStore });
}

function revokedLinkFetch(): typeof fetch {
  return vi.fn<typeof fetch>(async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname === "/oauth/token") {
      return Response.json({ error: "invalid_grant" }, { status: 400 });
    }
    if (url.host === "router.example") return new Response("revoked", { status: 401 });
    if (url.pathname.startsWith("/api/agents/self/")) {
      return new Response(null, { status: 401 });
    }
    throw new Error(`Unexpected test URL ${url.origin}${url.pathname}`);
  });
}

function secretStoreStub(entries?: Record<string, string>): SecretStore {
  if (activeSecretStore !== undefined && activeSecretEntries !== undefined) {
    if (entries !== undefined) {
      Object.assign(entries, activeSecretEntries);
      activeSecretEntries = entries;
    }
    return activeSecretStore;
  }
  activeSecretEntries = entries ?? {};
  activeSecretStore = {
    available: true,
    platform: "darwin",
    description: "the macOS Keychain",
    get: async (name) => activeSecretEntries![name],
    has: async (name) => activeSecretEntries![name] !== undefined,
    set: async (name, value) => {
      activeSecretEntries![name] = value;
    },
    remove: async (name) => {
      if (activeSecretEntries![name] === undefined) return false;
      delete activeSecretEntries![name];
      return true;
    },
  };
  return activeSecretStore;
}

function currentSecretStore(): SecretStore {
  if (activeSecretStore === undefined) throw new Error("Test home has no secret store.");
  return activeSecretStore;
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

function allOutput(captured: { stdout: string[]; stderr: string[] }): string {
  return [...captured.stdout, ...captured.stderr].join("\n");
}

async function initializedHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "vapi-router-cli-"));
  homes.push(home);
  process.env.VAPI_HOME = home;
  const secrets = secretStoreStub();
  const store = await WalletStore.open(home, { secrets });
  await store.create(WALLET, PASSPHRASE);
  return home;
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function pendingPurchase(
  status: RouterPendingPurchase["status"] = "settled",
): RouterPendingPurchase {
  return {
    receiptId: "settled-purchase",
    status,
    createdAt: "2026-09-23T10:00:00.000Z",
    tierUsd: 5,
    link: {
      apiBase: "https://console.example",
      clientId: "agent_researcher",
      owner: "0x1111111111111111111111111111111111111111",
      label: WALLET,
      scopes: ["mcp:call", "router.use"],
      linkedAt: "2026-09-23T10:00:00.000Z",
      routerBaseUrl: "https://router.example",
    },
    network: "eip155:8453",
    amountAtomic: "4750000",
    transaction: `0x${"33".repeat(32)}`,
    authorization: {
      token: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      from: "0x1111111111111111111111111111111111111111",
      nonce: `0x${"ab".repeat(32)}`,
      validBefore: "1790157600",
    },
  };
}
