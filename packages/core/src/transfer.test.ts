import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { getAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { agentSecretAccounts } from "./agent-link.js";
import { readAuditLog } from "./audit.js";
import { getVapiPaths, type SpendCaps } from "./config.js";
import { __setReceiptTestHooks, readReceipts } from "./receipts.js";
import type { SecretStore } from "./secret-store.js";
import { readSpendLedger, reserveSpend } from "./spend-policy.js";
import {
  parseTransferAmount,
  transferBetweenAccounts,
  TransferError,
  type TransferArgs,
  type TransferSigner,
} from "./transfer.js";
import { WalletStore, type WalletName } from "./wallet-store.js";
import type { X402TypedData } from "./x402.js";

const API_BASE = "https://api.vapinetwork.ai";
const TEST_PHRASE = "test test test test test test test test test test test junk";
const TEST_PRIVATE_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex;
const TEST_PASSPHRASE = "test passphrase that must stay local";
const ACCESS_TOKEN = "access-token-that-must-stay-secret";
const REFRESH_TOKEN = "refresh-token-that-must-stay-secret";
const OWNER = getAddress("0x1111111111111111111111111111111111111111");
const OUTSIDER = getAddress("0x2222222222222222222222222222222222222222");
const TX_HASH = `0x${"34".repeat(32)}` as Hex;
const NONCE = `0x${"ab".repeat(32)}` as Hex;
const NOW_MS = 1_790_676_000_000;
const GENEROUS_CAPS = { perCallAtomic: "10000000", perDayAtomic: "20000000" };

const vectors = JSON.parse(
  await readFile(new URL("./transfer-vectors.json", import.meta.url), "utf8"),
) as Record<
  "base" | "arc",
  {
    input: {
      from: string;
      recipient: string;
      value: string;
      nowSeconds: number;
      nonce: Hex;
    };
    expectedTypedData: unknown;
    expectedSignature: Hex;
  }
>;

type MemorySecretStore = SecretStore & { entries: Record<string, string> };
type RecordedCall = { url: string; init: RequestInit | undefined; body?: unknown };
type TestFixture = {
  home: string;
  store: WalletStore;
  secrets: MemorySecretStore;
  fromAddress: `0x${string}`;
  writerAddress: `0x${string}`;
  signer: TransferSigner;
  unlock: ReturnType<typeof vi.fn<(account: WalletName) => Promise<TransferSigner>>>;
  signTypedData: ReturnType<typeof vi.fn<(typedData: X402TypedData) => Promise<`0x${string}`>>>;
};

const temporaryDirectories: string[] = [];

afterEach(async () => {
  __setReceiptTestHooks(undefined);
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("transferBetweenAccounts", () => {
  it("1. refuses a recipient that is not a sibling or owner before signing", async () => {
    const fixture = await linkedFixture();
    const transport = fakeTransport(fixture);

    await expect(runTransfer(fixture, transport.fetchImpl, { to: OUTSIDER })).rejects.toMatchObject(
      {
        name: "TransferError",
        code: "recipient_not_allowed",
        moneyMoved: false,
        reservationReleased: false,
      },
    );

    expect(fixture.unlock).not.toHaveBeenCalled();
    expect(fixture.signTypedData).not.toHaveBeenCalled();
    expect(relayCalls(transport.calls)).toHaveLength(0);
  });

  it("refuses addresses that differ from the movement binding before signing", async () => {
    const senderFixture = await linkedFixture();
    const senderTransport = fakeTransport(senderFixture);
    await expect(
      runTransfer(senderFixture, senderTransport.fetchImpl, {
        expectedFromAddress: OUTSIDER,
      }),
    ).rejects.toMatchObject({ code: "account_address_mismatch", moneyMoved: false });
    expect(senderFixture.unlock).not.toHaveBeenCalled();
    expect(relayCalls(senderTransport.calls)).toHaveLength(0);

    const recipientFixture = await linkedFixture();
    const recipientTransport = fakeTransport(recipientFixture);
    await expect(
      runTransfer(recipientFixture, recipientTransport.fetchImpl, {
        expectedFromAddress: recipientFixture.fromAddress,
        expectedToAddress: OUTSIDER,
      }),
    ).rejects.toMatchObject({ code: "account_address_mismatch", moneyMoved: false });
    expect(recipientFixture.unlock).not.toHaveBeenCalled();
    expect(relayCalls(recipientTransport.calls)).toHaveLength(0);
  });

  it("2. refuses per-call and per-day cap violations before signing without changing spend state", async () => {
    const perCall = await linkedFixture({
      caps: { perCallAtomic: "1000000", perDayAtomic: "10000000" },
    });
    const perCallTransport = fakeTransport(perCall);
    const perCallPath = getVapiPaths(perCall.home).ledger;
    const beforePerCall = await fileContentsOrMissing(perCallPath);

    await expect(
      runTransfer(perCall, perCallTransport.fetchImpl, { amountUsd: "2" }),
    ).rejects.toMatchObject({ code: "per_call_cap_exceeded", moneyMoved: false });
    expect(await fileContentsOrMissing(perCallPath)).toBe(beforePerCall);
    expect(perCall.unlock).not.toHaveBeenCalled();
    expect(perCall.signTypedData).not.toHaveBeenCalled();
    expect(relayCalls(perCallTransport.calls)).toHaveLength(0);

    const perDay = await linkedFixture({
      caps: { perCallAtomic: "2000000", perDayAtomic: "2000000" },
    });
    const perDayPath = getVapiPaths(perDay.home).ledger;
    await reserveSpend(1_500_000n, perDay.store.entry("research")!.spendCaps, {
      ledgerPath: perDayPath,
      now: new Date(NOW_MS),
      wallet: "research",
    });
    const beforePerDay = await fileContentsOrMissing(perDayPath);
    const perDayTransport = fakeTransport(perDay);

    await expect(
      runTransfer(perDay, perDayTransport.fetchImpl, { amountUsd: "1" }),
    ).rejects.toMatchObject({ code: "per_day_cap_exceeded", moneyMoved: false });
    expect(await fileContentsOrMissing(perDayPath)).toBe(beforePerDay);
    expect(perDay.unlock).not.toHaveBeenCalled();
    expect(perDay.signTypedData).not.toHaveBeenCalled();
    expect(relayCalls(perDayTransport.calls)).toHaveLength(0);
  });

  it("3. releases the reservation after relay failure without resending the authorization", async () => {
    const fixture = await linkedFixture();
    const transport = fakeTransport(fixture, {
      relay: async () => Response.json({ error: "relay_failed" }, { status: 502 }),
    });

    const failure = await runTransfer(fixture, transport.fetchImpl).then(
      () => new Error("Expected the transfer to fail."),
      (error: unknown) => error as TransferError,
    );

    expect(failure).toMatchObject({
      name: "TransferError",
      code: "relay_failed",
      moneyMoved: false,
      reservationReleased: true,
    });
    expect(failure.message).toMatch(/No money moved\.$/);
    expect(relayCalls(transport.calls)).toHaveLength(1);
    await expect(
      readSpendLedger(getVapiPaths(fixture.home).ledger, new Date(NOW_MS), "research"),
    ).resolves.toMatchObject({ spentAtomic: "0" });
    await expect(readReceipts(getVapiPaths(fixture.home).receipts)).resolves.toMatchObject([
      { kind: "transfer", transfer: { status: "failed" }, error: { code: "relay_failed" } },
    ]);
  });

  it("4. records exactly one sent receipt when the relay reports a replay", async () => {
    const fixture = await linkedFixture();
    const transport = fakeTransport(fixture, {
      relay: async (body) => successfulRelay(body, { replayed: true }),
    });

    await expect(runTransfer(fixture, transport.fetchImpl)).resolves.toMatchObject({
      status: "sent",
      replayed: true,
      txHash: TX_HASH,
    });
    const receipts = await readReceipts(getVapiPaths(fixture.home).receipts);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({
      kind: "transfer",
      wallet: "research",
      transfer: { status: "sent", replayed: true, txHash: TX_HASH },
      settlement: { outcome: "succeeded", transaction: TX_HASH },
    });
  });

  it("returns sent evidence after a successful relay when the terminal receipt sync fails", async () => {
    const fixture = await linkedFixture();
    const path = getVapiPaths(fixture.home).receipts;
    let terminalSyncs = 0;
    const transport = fakeTransport(fixture, {
      relay: async (body) => {
        __setReceiptTestHooks({
          beforeSync: (target) => {
            if (target === path) {
              terminalSyncs += 1;
              throw new Error("terminal receipt sync failed");
            }
          },
        });
        return successfulRelay(body);
      },
    });

    await expect(runTransfer(fixture, transport.fetchImpl)).resolves.toMatchObject({
      status: "sent",
      txHash: TX_HASH,
      nonce: NONCE,
    });
    expect(terminalSyncs).toBe(1);
    expect(relayCalls(transport.calls)).toHaveLength(1);
    expect(await readReceipts(path)).toMatchObject([
      { transfer: { status: "sent", txHash: TX_HASH, nonce: NONCE } },
    ]);
  });

  it.each(["file", "directory"] as const)(
    "does not relay and records failure when the authorization %s sync fails",
    async (target) => {
      const fixture = await linkedFixture();
      const paths = getVapiPaths(fixture.home);
      const transport = fakeTransport(fixture);
      const release = vi.spyOn(await import("./spend-policy.js"), "releaseSpend");
      __setReceiptTestHooks({
        beforeSync: (path) => {
          if (path === (target === "file" ? paths.receipts : fixture.home)) {
            throw new Error("authorization sync failed");
          }
        },
      });

      await expect(runTransfer(fixture, transport.fetchImpl)).rejects.toMatchObject({
        name: "TransferError",
        code: "network_error",
        message: expect.stringContaining("No money moved."),
        moneyMoved: false,
        reservationReleased: true,
      });
      expect(relayCalls(transport.calls)).toHaveLength(0);
      expect(release).toHaveBeenCalledTimes(1);
      expect(await readSpendLedger(paths.ledger, new Date(NOW_MS), "research")).toMatchObject({
        spentAtomic: "0",
      });
      const rows = (await readFile(paths.receipts, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(rows.map((row) => row.transfer.status)).toEqual(["unknown", "failed"]);
      expect(rows.at(-1).transfer.nonce).toBe(NONCE);
      expect(rows.at(-1).transfer.request).toBeUndefined();
    },
  );

  it("keeps the reservation and resumes when authorization sync and the failed append both fail", async () => {
    const fixture = await linkedFixture();
    const paths = getVapiPaths(fixture.home);
    const transport = fakeTransport(fixture);
    const receipts = await import("./receipts.js");
    const appendReceipt = receipts.appendReceipt;
    const append = vi
      .spyOn(receipts, "appendReceipt")
      .mockImplementationOnce(appendReceipt)
      .mockRejectedValueOnce(new Error("failed row could not be appended"));
    const release = vi.spyOn(await import("./spend-policy.js"), "releaseSpend");
    __setReceiptTestHooks({
      beforeSync: (path) => {
        if (path === paths.receipts)
          throw new TransferError("network_error", "Original durability failure. No money moved.");
      },
    });

    const unknown = await runTransfer(fixture, transport.fetchImpl);
    expect(unknown).toMatchObject({
      status: "unknown",
      nonce: NONCE,
      txHash: null,
      replayed: false,
    });
    expect(append).toHaveBeenCalledTimes(2);
    expect(release).not.toHaveBeenCalled();
    expect(relayCalls(transport.calls)).toHaveLength(0);
    const ledger = JSON.parse(await readFile(paths.ledger, "utf8"));
    expect(ledger).toMatchObject({
      rows: [
        {
          wallet: "research",
          spentAtomic: "2000000",
          reservations: [{ id: NONCE, amountAtomic: "2000000" }],
        },
      ],
    });
    expect(await readReceipts(paths.receipts)).toMatchObject([
      { transfer: { status: "unknown", nonce: NONCE, request: expect.any(Object) } },
    ]);

    __setReceiptTestHooks(undefined);
    append.mockRestore();
    const sent = await runTransfer(fixture, transport.fetchImpl, { resume: unknown.nonce });
    expect(sent).toMatchObject({ status: "sent", nonce: NONCE, txHash: TX_HASH });
    expect(relayCalls(transport.calls)).toHaveLength(1);
    expect(fixture.signTypedData).toHaveBeenCalledTimes(1);
    expect(release).not.toHaveBeenCalled();
    expect(JSON.parse(await readFile(paths.ledger, "utf8"))).toEqual(ledger);
    const rows = await readReceipts(paths.receipts);
    expect(rows.map((row) => row.transfer?.status)).toEqual(["unknown", "sent"]);
    expect(rows[1]!.transfer?.request).toBeUndefined();
  });

  it("keeps a rejected resume reserved when its failed row cannot be written and stays within the cap", async () => {
    // $2 fits the $3 daily cap; another $2 only fits if the reservation is lost.
    const fixture = await linkedFixture({
      caps: { perCallAtomic: "2000000", perDayAtomic: "3000000" },
    });
    const paths = getVapiPaths(fixture.home);
    const release = vi.spyOn(await import("./spend-policy.js"), "releaseSpend");
    const accepted: Record<string, unknown>[] = [];
    let relayAttempt = 0;
    const transport = fakeTransport(fixture, {
      relay: async (body) => {
        relayAttempt += 1;
        if (relayAttempt === 1) return Response.json({ error: "in_progress" }, { status: 409 });
        if (relayAttempt === 2) return Response.json({ error: "relay_failed" }, { status: 502 });
        accepted.push(body);
        return successfulRelay(body);
      },
    });

    await expect(runTransfer(fixture, transport.fetchImpl)).resolves.toMatchObject({
      status: "unknown",
      nonce: NONCE,
    });
    expect(release).not.toHaveBeenCalled();
    const ledger = JSON.parse(await readFile(paths.ledger, "utf8"));
    expect(ledger).toMatchObject({
      rows: [
        {
          wallet: "research",
          spentAtomic: "2000000",
          reservations: [{ id: NONCE, amountAtomic: "2000000" }],
        },
      ],
    });
    const signedRows = await readFile(paths.receipts, "utf8");
    const receipts = await import("./receipts.js");
    const append = vi
      .spyOn(receipts, "appendReceipt")
      .mockRejectedValueOnce(new Error("failed row could not be appended"));

    await expect(
      runTransfer(fixture, transport.fetchImpl, { resume: NONCE }),
    ).resolves.toMatchObject({
      status: "unknown",
      nonce: NONCE,
      txHash: null,
      replayed: false,
    });
    expect(append).toHaveBeenCalledTimes(1);
    expect(release).not.toHaveBeenCalled();
    expect(JSON.parse(await readFile(paths.ledger, "utf8"))).toEqual(ledger);
    expect(await readFile(paths.receipts, "utf8")).toBe(signedRows);
    expect((await readReceipts(paths.receipts)).at(-1)?.transfer).toMatchObject({
      status: "unknown",
      nonce: NONCE,
      request: {
        authorization: (relayCalls(transport.calls)[0]!.body as Record<string, unknown>)
          .authorization,
        signature: expect.any(String),
      },
    });
    append.mockRestore();

    const callsBeforeNewTransfer = relayCalls(transport.calls).length;
    await expect(
      runTransfer(fixture, transport.fetchImpl, { nonce: `0x${"cd".repeat(32)}`, amountUsd: "2" }),
    ).rejects.toMatchObject({
      name: "TransferError",
      code: "per_day_cap_exceeded",
      moneyMoved: false,
    });
    expect(fixture.unlock).toHaveBeenCalledTimes(1);
    expect(fixture.signTypedData).toHaveBeenCalledTimes(1);
    expect(relayCalls(transport.calls)).toHaveLength(callsBeforeNewTransfer);

    const callsBeforeResume = relayCalls(transport.calls).length;
    await expect(
      runTransfer(fixture, transport.fetchImpl, { resume: NONCE }),
    ).resolves.toMatchObject({
      status: "sent",
      nonce: NONCE,
      txHash: TX_HASH,
    });
    const relays = relayCalls(transport.calls);
    expect(relays).toHaveLength(callsBeforeResume + 1);
    expect(relays.map((call) => call.body)).toEqual([
      relays[0]!.body,
      relays[0]!.body,
      relays[0]!.body,
    ]);
    expect(fixture.signTypedData).toHaveBeenCalledTimes(1);
    expect(release).not.toHaveBeenCalled();
    expect(JSON.parse(await readFile(paths.ledger, "utf8"))).toEqual(ledger);
    expect(accepted).toHaveLength(1);
    const acceptedAtomic = accepted.reduce(
      (total, body) => total + BigInt((body.authorization as { value: string }).value),
      0n,
    );
    expect(acceptedAtomic).toBe(2_000_000n);
    expect(acceptedAtomic).toBeLessThanOrEqual(3_000_000n);
  });

  it("releases a rejected resume only after its failed row is written on a later resume", async () => {
    const fixture = await linkedFixture();
    const paths = getVapiPaths(fixture.home);
    const policy = await import("./spend-policy.js");
    const releaseSpend = policy.releaseSpend;
    const release = vi.spyOn(policy, "releaseSpend").mockImplementation(async (...args) => {
      expect((await readReceipts(paths.receipts)).at(-1)?.transfer).toMatchObject({
        status: "failed",
        nonce: NONCE,
      });
      return await releaseSpend(...args);
    });
    let relayAttempt = 0;
    const transport = fakeTransport(fixture, {
      relay: async () => {
        relayAttempt += 1;
        return relayAttempt === 1
          ? Response.json({ error: "in_progress" }, { status: 409 })
          : Response.json({ error: "relay_failed" }, { status: 502 });
      },
    });
    await expect(runTransfer(fixture, transport.fetchImpl)).resolves.toMatchObject({
      status: "unknown",
      nonce: NONCE,
    });
    const ledger = JSON.parse(await readFile(paths.ledger, "utf8"));
    expect(ledger).toMatchObject({
      rows: [{ spentAtomic: "2000000", reservations: [{ id: NONCE, amountAtomic: "2000000" }] }],
    });
    const signedRows = await readFile(paths.receipts, "utf8");
    const append = vi
      .spyOn(await import("./receipts.js"), "appendReceipt")
      .mockRejectedValueOnce(new Error("failed row could not be appended"));

    await expect(
      runTransfer(fixture, transport.fetchImpl, { resume: NONCE }),
    ).resolves.toMatchObject({ status: "unknown", nonce: NONCE, txHash: null, replayed: false });
    expect(append).toHaveBeenCalledTimes(1);
    expect(release).not.toHaveBeenCalled();
    expect(relayCalls(transport.calls)).toHaveLength(2);
    expect(JSON.parse(await readFile(paths.ledger, "utf8"))).toEqual(ledger);
    expect(await readFile(paths.receipts, "utf8")).toBe(signedRows);
    expect((await readReceipts(paths.receipts)).at(-1)?.transfer).toMatchObject({
      status: "unknown",
      nonce: NONCE,
      request: expect.any(Object),
    });
    append.mockRestore();

    await expect(
      runTransfer(fixture, transport.fetchImpl, { resume: NONCE }),
    ).rejects.toMatchObject({
      name: "TransferError",
      code: "relay_failed",
      moneyMoved: false,
      reservationReleased: true,
    });
    expect(release).toHaveBeenCalledTimes(1);
    expect(relayCalls(transport.calls)).toHaveLength(3);
    const releasedLedger = await readFile(paths.ledger, "utf8");
    expect(JSON.parse(releasedLedger)).toMatchObject({ rows: [{ spentAtomic: "0" }] });
    const failed = (await readReceipts(paths.receipts)).at(-1)!;
    expect(failed.transfer).toMatchObject({ status: "failed", nonce: NONCE });
    expect(failed.transfer?.request).toBeUndefined();
    expect(failed.error).toEqual({
      code: "relay_failed",
      message: "The vAPI relay failed. No money moved.",
    });

    await expect(
      runTransfer(fixture, transport.fetchImpl, { resume: NONCE }),
    ).rejects.toMatchObject({ name: "TransferError", code: "relay_failed", moneyMoved: false });
    expect(relayCalls(transport.calls)).toHaveLength(3);
    expect(await readFile(paths.ledger, "utf8")).toBe(releasedLedger);
    expect(fixture.signTypedData).toHaveBeenCalledTimes(1);
  });

  it("keeps a rejected first attempt unknown and reserved when its failed row cannot be written", async () => {
    const fixture = await linkedFixture();
    const paths = getVapiPaths(fixture.home);
    const transport = fakeTransport(fixture, {
      relay: async () => Response.json({ error: "relay_failed" }, { status: 502 }),
    });
    const receipts = await import("./receipts.js");
    const appendReceipt = receipts.appendReceipt;
    const append = vi
      .spyOn(receipts, "appendReceipt")
      .mockImplementationOnce(appendReceipt)
      .mockRejectedValueOnce(new Error("failed row could not be appended"));
    const release = vi.spyOn(await import("./spend-policy.js"), "releaseSpend");

    await expect(runTransfer(fixture, transport.fetchImpl)).resolves.toMatchObject({
      status: "unknown",
      nonce: NONCE,
      txHash: null,
      replayed: false,
    });
    expect(append).toHaveBeenCalledTimes(2);
    expect(release).not.toHaveBeenCalled();
    expect(relayCalls(transport.calls)).toHaveLength(1);
    expect(JSON.parse(await readFile(paths.ledger, "utf8"))).toMatchObject({
      rows: [{ spentAtomic: "2000000", reservations: [{ id: NONCE, amountAtomic: "2000000" }] }],
    });
    expect(await readReceipts(paths.receipts)).toMatchObject([
      { transfer: { status: "unknown", nonce: NONCE, request: expect.any(Object) } },
    ]);
  });

  it("returns sent evidence when the sent row cannot be written and records a later replay", async () => {
    const fixture = await linkedFixture();
    const paths = getVapiPaths(fixture.home);
    let relayAttempt = 0;
    const transport = fakeTransport(fixture, {
      relay: async (body) => {
        relayAttempt += 1;
        return relayAttempt === 1
          ? successfulRelay(body)
          : Response.json({ error: "authorization_used" }, { status: 409 });
      },
    });
    const receipts = await import("./receipts.js");
    const appendReceipt = receipts.appendReceipt;
    const append = vi
      .spyOn(receipts, "appendReceipt")
      .mockImplementationOnce(appendReceipt)
      .mockRejectedValueOnce(new Error("sent row could not be appended"));
    const release = vi.spyOn(await import("./spend-policy.js"), "releaseSpend");

    await expect(runTransfer(fixture, transport.fetchImpl)).resolves.toMatchObject({
      status: "sent",
      nonce: NONCE,
      txHash: TX_HASH,
      replayed: false,
    });
    expect(append).toHaveBeenCalledTimes(2);
    expect(relayCalls(transport.calls)).toHaveLength(1);
    const ledger = await readFile(paths.ledger, "utf8");
    expect(JSON.parse(ledger)).toMatchObject({
      rows: [{ spentAtomic: "2000000", reservations: [{ id: NONCE, amountAtomic: "2000000" }] }],
    });
    expect(await readReceipts(paths.receipts)).toMatchObject([
      { transfer: { status: "unknown", nonce: NONCE, request: expect.any(Object) } },
    ]);
    append.mockRestore();

    await expect(
      runTransfer(fixture, transport.fetchImpl, { resume: NONCE }),
    ).resolves.toMatchObject({ status: "sent", nonce: NONCE, txHash: null, replayed: true });
    const rows = await readReceipts(paths.receipts);
    expect(rows.map((row) => row.transfer?.status)).toEqual(["unknown", "sent"]);
    expect(rows.filter((row) => row.transfer?.status === "sent")).toHaveLength(1);
    expect(rows.at(-1)?.transfer).toMatchObject({ nonce: NONCE, replayed: true });
    expect(rows.at(-1)?.transfer?.request).toBeUndefined();
    const relays = relayCalls(transport.calls);
    expect(relays).toHaveLength(2);
    expect(relays[1]!.body).toEqual(relays[0]!.body);
    expect(fixture.signTypedData).toHaveBeenCalledTimes(1);
    expect(release).not.toHaveBeenCalled();
    expect(await readFile(paths.ledger, "utf8")).toBe(ledger);
  });

  it("returns sent replay evidence when a resumed authorization_used row cannot be written", async () => {
    const fixture = await linkedFixture();
    const paths = getVapiPaths(fixture.home);
    let relayAttempt = 0;
    const transport = fakeTransport(fixture, {
      relay: async () => {
        relayAttempt += 1;
        return Response.json(
          { error: relayAttempt === 1 ? "in_progress" : "authorization_used" },
          { status: 409 },
        );
      },
    });
    const release = vi.spyOn(await import("./spend-policy.js"), "releaseSpend");
    await expect(runTransfer(fixture, transport.fetchImpl)).resolves.toMatchObject({
      status: "unknown",
      nonce: NONCE,
    });
    const ledger = await readFile(paths.ledger, "utf8");
    const signedRows = await readFile(paths.receipts, "utf8");
    const append = vi
      .spyOn(await import("./receipts.js"), "appendReceipt")
      .mockRejectedValueOnce(new Error("sent replay row could not be appended"));

    await expect(
      runTransfer(fixture, transport.fetchImpl, { resume: NONCE }),
    ).resolves.toMatchObject({ status: "sent", nonce: NONCE, txHash: null, replayed: true });
    expect(append).toHaveBeenCalledTimes(1);
    expect(release).not.toHaveBeenCalled();
    expect(await readFile(paths.ledger, "utf8")).toBe(ledger);
    expect(await readFile(paths.receipts, "utf8")).toBe(signedRows);
    expect((await readReceipts(paths.receipts)).at(-1)?.transfer).toMatchObject({
      status: "unknown",
      nonce: NONCE,
      request: expect.any(Object),
    });
    const relays = relayCalls(transport.calls);
    expect(relays).toHaveLength(2);
    expect(relays[1]!.body).toEqual(relays[0]!.body);
    expect(fixture.signTypedData).toHaveBeenCalledTimes(1);
  });

  it("returns unknown when the second unknown row cannot be written and resumes the signed row", async () => {
    const fixture = await linkedFixture();
    const paths = getVapiPaths(fixture.home);
    let relayAttempt = 0;
    const transport = fakeTransport(fixture, {
      relay: async (body) => {
        relayAttempt += 1;
        return relayAttempt === 1
          ? Response.json({ error: "in_progress" }, { status: 409 })
          : successfulRelay(body);
      },
    });
    const receipts = await import("./receipts.js");
    const appendReceipt = receipts.appendReceipt;
    const append = vi
      .spyOn(receipts, "appendReceipt")
      .mockImplementationOnce(appendReceipt)
      .mockRejectedValueOnce(new Error("unknown row could not be appended"));
    const release = vi.spyOn(await import("./spend-policy.js"), "releaseSpend");

    await expect(runTransfer(fixture, transport.fetchImpl)).resolves.toMatchObject({
      status: "unknown",
      nonce: NONCE,
      txHash: null,
      replayed: false,
    });
    expect(append).toHaveBeenCalledTimes(2);
    expect(relayCalls(transport.calls)).toHaveLength(1);
    const rows = await readReceipts(paths.receipts);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.transfer).toMatchObject({
      status: "unknown",
      nonce: NONCE,
      request: expect.any(Object),
    });
    expect(rows[0]?.status).toBeUndefined();
    const ledger = await readFile(paths.ledger, "utf8");
    expect(JSON.parse(ledger)).toMatchObject({
      rows: [{ spentAtomic: "2000000", reservations: [{ id: NONCE, amountAtomic: "2000000" }] }],
    });
    append.mockRestore();

    await expect(
      runTransfer(fixture, transport.fetchImpl, { resume: NONCE }),
    ).resolves.toMatchObject({ status: "sent", nonce: NONCE, txHash: TX_HASH });
    expect((await readReceipts(paths.receipts)).at(-1)?.transfer).toMatchObject({
      status: "sent",
      nonce: NONCE,
    });
    const relays = relayCalls(transport.calls);
    expect(relays).toHaveLength(2);
    expect(relays[1]!.body).toEqual(relays[0]!.body);
    expect(fixture.signTypedData).toHaveBeenCalledTimes(1);
    expect(release).not.toHaveBeenCalled();
    expect(await readFile(paths.ledger, "utf8")).toBe(ledger);
  });

  it("5. refuses a revoked sibling before signing", async () => {
    const fixture = await linkedFixture();
    const transport = fakeTransport(fixture, { writerStatus: "revoked" });

    await expect(runTransfer(fixture, transport.fetchImpl)).rejects.toMatchObject({
      code: "recipient_not_allowed",
      moneyMoved: false,
    });
    expect(fixture.unlock).not.toHaveBeenCalled();
    expect(fixture.signTypedData).not.toHaveBeenCalled();
    expect(relayCalls(transport.calls)).toHaveLength(0);
  });

  it("6. lets an owner sweep bypass caps and refuses a sibling sweep", async () => {
    const ownerFixture = await linkedFixture({
      caps: { perCallAtomic: "0", perDayAtomic: "0" },
    });
    const ownerTransport = fakeTransport(ownerFixture);

    await expect(
      runTransfer(ownerFixture, ownerTransport.fetchImpl, {
        to: "owner",
        amountUsd: "2",
        purpose: "sweep",
      }),
    ).resolves.toMatchObject({ status: "sent", to: OWNER, toKind: "owner" });
    expect(await fileContentsOrMissing(getVapiPaths(ownerFixture.home).ledger)).toBe("<missing>");

    const siblingFixture = await linkedFixture();
    const siblingTransport = fakeTransport(siblingFixture);
    await expect(
      runTransfer(siblingFixture, siblingTransport.fetchImpl, { purpose: "sweep" }),
    ).rejects.toMatchObject({ code: "sweep_not_owner", moneyMoved: false });
    expect(siblingFixture.unlock).not.toHaveBeenCalled();
    expect(relayCalls(siblingTransport.calls)).toHaveLength(0);
  });

  it("7. matches the checked-in Base and Arc EIP-3009 typed-data vectors", async () => {
    for (const name of ["base", "arc"] as const) {
      const vector = vectors[name];
      const fixture = await linkedFixture();
      expect(fixture.fromAddress).toBe(vector.input.from);
      const transport = fakeTransport(fixture);

      await runTransfer(fixture, transport.fetchImpl, {
        to: "owner",
        amountUsd: "2.000001",
        network: name,
        nonce: vector.input.nonce,
        now: () => vector.input.nowSeconds * 1_000,
      });

      expect(normalizeTypedData(fixture.signTypedData.mock.calls[0]![0])).toEqual(
        vector.expectedTypedData,
      );
      const request = relayCalls(transport.calls)[0]!.body as {
        signature: Hex;
        authorization: { value: string };
      };
      expect(request.signature).toBe(vector.expectedSignature);
      expect(request.authorization.value).toBe(vector.input.value);
    }
  });

  it("8. parses plain decimal USDC amounts without floating point", () => {
    expect(parseTransferAmount("0.1")).toEqual({ amountUsd: "0.10", amountAtomic: 100_000n });
    expect(parseTransferAmount(2)).toEqual({ amountUsd: "2.00", amountAtomic: 2_000_000n });
    expect(parseTransferAmount("2.000001")).toEqual({
      amountUsd: "2.000001",
      amountAtomic: 2_000_001n,
    });
    for (const value of ["0", "-1", "1.0000001", "1e3", "abc", 1e-7]) {
      expect(() => parseTransferAmount(value)).toThrowError(
        expect.objectContaining({ code: "invalid_amount", moneyMoved: false }),
      );
    }
  });

  it("9. posts only the signed authorization and records no wallet or agent secrets", async () => {
    const fixture = await linkedFixture();
    const transport = fakeTransport(fixture);

    await runTransfer(fixture, transport.fetchImpl);

    const relay = relayCalls(transport.calls)[0]!;
    const body = relay.body as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(["network", "authorization", "signature"]);
    expect(Object.keys(body.authorization as object)).toEqual([
      "from",
      "to",
      "value",
      "validAfter",
      "validBefore",
      "nonce",
    ]);
    const recorded = [
      JSON.stringify(body),
      await readFile(getVapiPaths(fixture.home).receipts, "utf8"),
      JSON.stringify(await readAuditLog(fixture.home)),
    ].join("\n");
    for (const secret of [
      TEST_PHRASE,
      TEST_PRIVATE_KEY,
      TEST_PASSPHRASE,
      ACCESS_TOKEN,
      REFRESH_TOKEN,
    ]) {
      expect(recorded).not.toContain(secret);
    }
  });

  it("persists the signed authorization before submitting it to the relay", async () => {
    const fixture = await linkedFixture();
    let inspectedBeforeRelay = false;
    const transport = fakeTransport(fixture, {
      relay: async (body) => {
        const receipts = await readReceipts(getVapiPaths(fixture.home).receipts);
        expect(receipts).toHaveLength(1);
        expect(receipts[0]?.transfer).toMatchObject({
          status: "unknown",
          nonce: NONCE,
          request: {
            authorization: body.authorization,
            signature: body.signature,
          },
        });
        inspectedBeforeRelay = true;
        return successfulRelay(body);
      },
    });

    await expect(runTransfer(fixture, transport.fetchImpl)).resolves.toMatchObject({
      status: "sent",
    });
    expect(inspectedBeforeRelay).toBe(true);
    await expect(readReceipts(getVapiPaths(fixture.home).receipts)).resolves.toHaveLength(1);
  });

  it("11. keeps an unknown reservation and resumes the identical authorization without signing again", async () => {
    const fixture = await linkedFixture();
    let relayAttempt = 0;
    const transport = fakeTransport(fixture, {
      relay: async (body) => {
        relayAttempt += 1;
        return relayAttempt === 1
          ? Response.json({ error: "in_progress" }, { status: 409 })
          : successfulRelay(body);
      },
    });

    const unknown = await runTransfer(fixture, transport.fetchImpl);
    expect(unknown).toMatchObject({ status: "unknown", nonce: NONCE, txHash: null });
    await expect(
      readSpendLedger(getVapiPaths(fixture.home).ledger, new Date(NOW_MS), "research"),
    ).resolves.toMatchObject({ spentAtomic: "2000000" });
    const unknownReceipt = (await readReceipts(getVapiPaths(fixture.home).receipts))[0]!;
    expect(unknownReceipt.transfer).toMatchObject({
      status: "unknown",
      nonce: NONCE,
      reservedOn: "2026-09-29",
      request: expect.any(Object),
    });

    const sent = await runTransfer(fixture, transport.fetchImpl, { resume: NONCE });
    expect(sent).toMatchObject({ status: "sent", nonce: NONCE, txHash: TX_HASH });
    expect(fixture.unlock).toHaveBeenCalledTimes(1);
    expect(fixture.signTypedData).toHaveBeenCalledTimes(1);
    const relays = relayCalls(transport.calls);
    expect(relays).toHaveLength(2);
    expect(relays[1]!.body).toEqual(relays[0]!.body);
    await expect(
      readSpendLedger(getVapiPaths(fixture.home).ledger, new Date(NOW_MS), "research"),
    ).resolves.toMatchObject({ spentAtomic: "2000000" });
    const receipts = await readReceipts(getVapiPaths(fixture.home).receipts);
    expect(receipts).toHaveLength(2);
    expect(receipts.map((receipt) => receipt.transfer?.status)).toEqual(["unknown", "sent"]);
    expect(receipts[1]!.transfer?.request).toBeUndefined();
  });

  it.each([
    [
      "a 503 from the relay",
      async () => Response.json({ error: "temporarily_unavailable" }, { status: 503 }),
    ],
    [
      "a network failure on the first submission",
      async (): Promise<Response> => {
        throw new Error("connection reset after submission");
      },
    ],
  ])("treats %s as unknown and keeps the reservation", async (_label, relay) => {
    const fixture = await linkedFixture();
    let relayAttempt = 0;
    const transport = fakeTransport(fixture, {
      relay: async (body) => {
        relayAttempt += 1;
        return relayAttempt === 1 ? await relay() : successfulRelay(body, { replayed: true });
      },
    });

    await expect(runTransfer(fixture, transport.fetchImpl)).resolves.toMatchObject({
      status: "unknown",
      nonce: NONCE,
      txHash: null,
    });
    await expect(
      readSpendLedger(getVapiPaths(fixture.home).ledger, new Date(NOW_MS), "research"),
    ).resolves.toMatchObject({ spentAtomic: "2000000" });

    await expect(
      runTransfer(fixture, transport.fetchImpl, { resume: NONCE }),
    ).resolves.toMatchObject({ status: "sent", nonce: NONCE, replayed: true });
    expect(fixture.signTypedData).toHaveBeenCalledTimes(1);
    const relays = relayCalls(transport.calls);
    expect(relays).toHaveLength(2);
    expect(relays[1]!.body).toEqual(relays[0]!.body);
    await expect(
      readSpendLedger(getVapiPaths(fixture.home).ledger, new Date(NOW_MS), "research"),
    ).resolves.toMatchObject({ spentAtomic: "2000000" });
  });

  it("keeps a resumed transfer unknown after a network failure", async () => {
    const fixture = await linkedFixture();
    let relayAttempt = 0;
    const transport = fakeTransport(fixture, {
      relay: async () => {
        relayAttempt += 1;
        if (relayAttempt === 1) {
          return Response.json({ error: "in_progress" }, { status: 409 });
        }
        throw new Error("connection reset after submission");
      },
    });

    await expect(runTransfer(fixture, transport.fetchImpl)).resolves.toMatchObject({
      status: "unknown",
      nonce: NONCE,
    });
    await expect(
      runTransfer(fixture, transport.fetchImpl, { resume: NONCE }),
    ).resolves.toMatchObject({ status: "unknown", nonce: NONCE });

    await expect(
      readSpendLedger(getVapiPaths(fixture.home).ledger, new Date(NOW_MS), "research"),
    ).resolves.toMatchObject({ spentAtomic: "2000000" });
    expect(fixture.signTypedData).toHaveBeenCalledTimes(1);
    expect(relayCalls(transport.calls)).toHaveLength(2);
    const receipts = await readReceipts(getVapiPaths(fixture.home).receipts);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]?.transfer?.status).toBe("unknown");
  });

  it("serializes concurrent failed resumes and releases their reservation only once", async () => {
    const fixture = await linkedFixture();
    let relayAttempt = 0;
    const transport = fakeTransport(fixture, {
      relay: async () => {
        relayAttempt += 1;
        return relayAttempt === 1
          ? Response.json({ error: "in_progress" }, { status: 409 })
          : Response.json({ error: "relay_failed" }, { status: 502 });
      },
    });
    await runTransfer(fixture, transport.fetchImpl);
    await reserveSpend(1_000_000n, fixture.store.entry("research")!.spendCaps, {
      ledgerPath: getVapiPaths(fixture.home).ledger,
      now: new Date(NOW_MS),
      wallet: "research",
    });

    const outcomes = await Promise.allSettled([
      runTransfer(fixture, transport.fetchImpl, { resume: NONCE }),
      runTransfer(fixture, transport.fetchImpl, { resume: NONCE }),
    ]);

    expect(outcomes).toHaveLength(2);
    for (const outcome of outcomes) {
      expect(outcome.status).toBe("rejected");
      if (outcome.status === "rejected") {
        expect(outcome.reason).toMatchObject({ code: "relay_failed", moneyMoved: false });
      }
    }
    expect(relayCalls(transport.calls)).toHaveLength(2);
    await expect(
      readSpendLedger(getVapiPaths(fixture.home).ledger, new Date(NOW_MS), "research"),
    ).resolves.toMatchObject({ spentAtomic: "1000000" });
  });

  it("refuses an ambiguous sibling name even when it is also local", async () => {
    const fixture = await linkedFixture();
    const duplicate = getAddress("0x3333333333333333333333333333333333333333");
    const transport = fakeTransport(fixture, {
      extraSiblings: [sibling("writer", duplicate)],
    });

    await expect(runTransfer(fixture, transport.fetchImpl, { to: "writer" })).rejects.toMatchObject(
      {
        code: "ambiguous_recipient",
        addresses: [fixture.writerAddress, duplicate],
      },
    );
    expect(fixture.unlock).not.toHaveBeenCalled();
  });

  it("classifies a local account at the owner address as an owner sweep", async () => {
    const fixture = await linkedFixture({ caps: { perCallAtomic: "0", perDayAtomic: "0" } });
    const transport = fakeTransport(fixture, {
      owner: fixture.writerAddress,
      includeWriter: false,
    });

    await expect(
      runTransfer(fixture, transport.fetchImpl, { to: "writer", purpose: "sweep" }),
    ).resolves.toMatchObject({
      status: "sent",
      to: fixture.writerAddress,
      toName: "writer",
      toKind: "owner",
    });
  });

  it("lists every address when a sibling name is ambiguous", async () => {
    const fixture = await linkedFixture();
    const duplicate = getAddress("0x3333333333333333333333333333333333333333");
    const transport = fakeTransport(fixture, {
      extraSiblings: [sibling("shared", fixture.writerAddress), sibling("shared", duplicate)],
    });

    await expect(runTransfer(fixture, transport.fetchImpl, { to: "shared" })).rejects.toMatchObject(
      {
        code: "ambiguous_recipient",
        addresses: [fixture.writerAddress, duplicate],
        moneyMoved: false,
      },
    );
    expect(fixture.unlock).not.toHaveBeenCalled();
  });

  it("allows a treasury sweep without reserving spend, rejects another sibling, and still allows the owner", async () => {
    const treasuryFixture = await linkedFixture({
      caps: { perCallAtomic: "0", perDayAtomic: "0" },
    });
    const treasuryTransport = fakeTransport(treasuryFixture);
    const treasuryLedger = getVapiPaths(treasuryFixture.home).ledger;
    const beforeTreasurySweep = await fileContentsOrMissing(treasuryLedger);

    await expect(
      runTransfer(treasuryFixture, treasuryTransport.fetchImpl, {
        purpose: "sweep",
        sweepParent: treasuryFixture.writerAddress.toLowerCase() as `0x${string}`,
      }),
    ).resolves.toMatchObject({
      status: "sent",
      to: treasuryFixture.writerAddress,
      toKind: "account",
    });
    expect(await fileContentsOrMissing(treasuryLedger)).toBe(beforeTreasurySweep);

    const siblingFixture = await linkedFixture();
    const siblingTransport = fakeTransport(siblingFixture);
    await expect(
      runTransfer(siblingFixture, siblingTransport.fetchImpl, {
        purpose: "sweep",
        sweepParent: OUTSIDER,
      }),
    ).rejects.toMatchObject({ code: "sweep_not_owner", moneyMoved: false });
    expect(siblingFixture.unlock).not.toHaveBeenCalled();
    expect(relayCalls(siblingTransport.calls)).toHaveLength(0);

    const ownerFixture = await linkedFixture({
      caps: { perCallAtomic: "0", perDayAtomic: "0" },
    });
    const ownerTransport = fakeTransport(ownerFixture);
    await expect(
      runTransfer(ownerFixture, ownerTransport.fetchImpl, {
        to: "owner",
        purpose: "sweep",
      }),
    ).resolves.toMatchObject({ status: "sent", to: OWNER, toKind: "owner" });
  });
});

async function linkedFixture(options: { caps?: SpendCaps } = {}): Promise<TestFixture> {
  const home = await mkdtemp(join(tmpdir(), "vapi-transfer-"));
  temporaryDirectories.push(home);
  const secrets = memorySecretStore();
  const store = await WalletStore.open(home, { secrets, env: {} });
  const created = await store.create("research", TEST_PASSPHRASE, {
    phrase: TEST_PHRASE,
    spendCaps: options.caps ?? GENEROUS_CAPS,
  });
  const writer = await store.create("writer", TEST_PASSPHRASE, { spendCaps: GENEROUS_CAPS });
  await store.setLink("research", {
    apiBase: API_BASE,
    clientId: "agent_research",
    owner: OWNER,
    label: "research",
    scopes: ["mcp:call", "router.use"],
    linkedAt: "2026-09-29T09:00:00.000Z",
  });
  await secrets.set(
    agentSecretAccounts("research").tokens,
    JSON.stringify({
      accessToken: ACCESS_TOKEN,
      refreshToken: REFRESH_TOKEN,
      expiresAt: Number.MAX_SAFE_INTEGER,
      scopes: ["mcp:call", "router.use"],
    }),
  );

  const account = privateKeyToAccount(TEST_PRIVATE_KEY);
  expect(created.account.address).toBe(account.address);
  const signTypedData = vi.fn(async (typedData: X402TypedData) => {
    return await account.signTypedData(typedData);
  });
  const signer: TransferSigner = { address: account.address, signTypedData };
  const unlock = vi.fn(async (_account: WalletName) => signer);
  return {
    home,
    store,
    secrets,
    fromAddress: created.account.address,
    writerAddress: writer.account.address,
    signer,
    unlock,
    signTypedData,
  };
}

function fakeTransport(
  fixture: TestFixture,
  options: {
    writerStatus?: "active" | "revoked";
    extraSiblings?: unknown[];
    owner?: string;
    includeWriter?: boolean;
    relay?: (body: Record<string, unknown>) => Promise<Response>;
  } = {},
): { fetchImpl: typeof fetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
    calls.push({ url, init, ...(body === undefined ? {} : { body }) });
    const pathname = new URL(url).pathname;
    if (pathname === "/api/agents/self/siblings") {
      return Response.json({
        owner: options.owner ?? OWNER,
        siblings: [
          sibling("research", fixture.fromAddress, { self: true }),
          ...(options.includeWriter === false
            ? []
            : [
                sibling("writer", fixture.writerAddress, {
                  status: options.writerStatus ?? "active",
                }),
              ]),
          ...(options.extraSiblings ?? []),
        ],
      });
    }
    if (pathname === "/api/agents/relay-transfer") {
      const relayBody = body as Record<string, unknown>;
      return options.relay ? await options.relay(relayBody) : successfulRelay(relayBody);
    }
    throw new Error(`Unexpected test request to ${url}.`);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function sibling(
  name: string,
  address: string,
  overrides: { self?: boolean; status?: "active" | "revoked" } = {},
) {
  return {
    name,
    address,
    device: "test-device",
    status: overrides.status ?? "active",
    allowance: { routerPerDayUsd: null, perCallUsd: null, perDayUsd: null },
    self: overrides.self ?? false,
  };
}

function successfulRelay(
  body: Record<string, unknown>,
  overrides: { replayed?: boolean } = {},
): Response {
  const authorization = body.authorization as Record<string, unknown>;
  return Response.json({
    txHash: TX_HASH,
    network: body.network,
    from: authorization.from,
    to: authorization.to,
    value: authorization.value,
    replayed: overrides.replayed ?? false,
  });
}

async function runTransfer(
  fixture: TestFixture,
  fetchImpl: typeof fetch,
  overrides: Partial<TransferArgs> = {},
) {
  return await transferBetweenAccounts({
    store: fixture.store,
    secrets: fixture.secrets,
    apiBase: API_BASE,
    from: "research",
    to: "writer",
    amountUsd: "2",
    fetchImpl,
    now: () => NOW_MS,
    nonce: NONCE,
    unlock: fixture.unlock,
    home: fixture.home,
    ...overrides,
  });
}

function relayCalls(calls: readonly RecordedCall[]): RecordedCall[] {
  return calls.filter((call) => new URL(call.url).pathname === "/api/agents/relay-transfer");
}

function normalizeTypedData(typedData: X402TypedData): unknown {
  return JSON.parse(
    JSON.stringify(typedData, (_key, value) =>
      typeof value === "bigint" ? value.toString() : value,
    ),
  );
}

async function fileContentsOrMissing(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return "<missing>";
    throw error;
  }
}

function memorySecretStore(): MemorySecretStore {
  const entries: Record<string, string> = {};
  return {
    available: true,
    platform: "darwin",
    description: "the test keychain",
    entries,
    get: async (name) => entries[name],
    has: async (name) => entries[name] !== undefined,
    set: async (name, value) => {
      entries[name] = value;
    },
    remove: async (name) => {
      if (entries[name] === undefined) return false;
      delete entries[name];
      return true;
    },
  };
}
