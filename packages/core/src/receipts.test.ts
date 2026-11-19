import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  __setReceiptTestHooks,
  appendReceipt,
  parseReceipt,
  readReceipts,
  renameReceiptWallet,
  syncReceipts,
  type Receipt,
} from "./receipts.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  __setReceiptTestHooks(undefined);
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("receipts ledger", () => {
  it("syncs each append and the directory on creation, and rejects a missing sync target", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vapi-receipts-sync-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "receipts.jsonl");
    const synced: string[] = [];
    __setReceiptTestHooks({
      afterSync: (path) => {
        synced.push(path);
      },
    });
    const receipt: Receipt = {
      id: "durable",
      timestamp: "2026-09-10T08:00:00.000Z",
      resourceUrl: "https://api.example/paid",
    };
    await appendReceipt(receipt, path);
    expect(synced).toEqual([path, directory]);
    await appendReceipt({ ...receipt, id: "next" }, path);
    expect(synced).toEqual([path, directory, path]);
    await expect(syncReceipts(join(directory, "missing"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("syncs the rename temporary file before replacement and the directory afterward", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vapi-receipts-rename-sync-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "receipts.jsonl");
    const receipt: Receipt = {
      id: "rename",
      timestamp: "2026-09-10T08:00:00.000Z",
      resourceUrl: "https://api.example/paid",
      wallet: "main",
    };
    await appendReceipt(receipt, path);
    const synced: string[] = [];
    __setReceiptTestHooks({
      afterSync: async (target) => {
        synced.push(target);
        expect((await readReceipts(path))[0]?.wallet).toBe(
          target === directory ? "renamed" : "main",
        );
      },
    });
    expect(await renameReceiptWallet("main", "renamed", path)).toBe(1);
    expect(synced).toEqual([expect.stringMatching(/\.tmp$/), directory]);
    __setReceiptTestHooks({
      beforeSync: () => {
        throw new Error("sync failed");
      },
    });
    await expect(renameReceiptWallet("renamed", "other", path)).rejects.toThrow("sync failed");
    expect((await readReceipts(path))[0]?.wallet).toBe("renamed");
  });

  it("coalesces Router revisions at the original position before wallet filtering", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vapi-receipts-revisions-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "receipts.jsonl");
    const original: Receipt = {
      id: "purchase",
      timestamp: "2026-09-10T08:00:00.000Z",
      resourceUrl: "https://api.example/top-up/5",
      source: "router.topup",
      wallet: "main",
      settlement: { outcome: "unknown" },
    };
    const ordinary: Receipt = { ...original, id: "ordinary", source: "other" };
    const revision: Receipt = {
      ...original,
      wallet: "research",
      settlement: { outcome: "succeeded" },
    };
    for (const row of [original, ordinary, revision, ordinary]) await appendReceipt(row, path);
    expect(await readReceipts(path)).toEqual([revision, ordinary, ordinary]);
    expect(await readReceipts(path, { wallet: "main" })).toEqual([ordinary, ordinary]);
    expect(await readReceipts(path, { wallet: "research" })).toEqual([revision]);
    expect((await readFile(path, "utf8")).trim().split("\n")).toHaveLength(4);
  });

  it("appends one JSON object per line and reads the newest limit", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vapi-receipts-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "receipts.jsonl");
    const first: Receipt = {
      id: "receipt-1",
      timestamp: "2026-09-10T08:00:00.000Z",
      resourceUrl: "https://api.example/one",
      status: 200,
    };
    const second: Receipt = {
      id: "receipt-2",
      timestamp: "2026-09-10T08:01:00.000Z",
      resourceUrl: "https://api.example/two",
      settlement: { outcome: "succeeded", transaction: "0xabc" },
    };

    await appendReceipt(first, path);
    await appendReceipt(second, path);

    expect((await readFile(path, "utf8")).trim().split("\n")).toHaveLength(2);
    expect(await readReceipts(path)).toEqual([first, second]);
    expect(await readReceipts(path, { limit: 1 })).toEqual([second]);
  });

  it("returns an empty list when the ledger does not exist", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vapi-receipts-"));
    temporaryDirectories.push(directory);
    await expect(readReceipts(join(directory, "missing.jsonl"))).resolves.toEqual([]);
  });

  it("parses old records and validates the optional rich receipt fields", () => {
    expect(
      parseReceipt({
        id: "old",
        timestamp: "2026-09-10T08:00:00.000Z",
        resourceUrl: "https://api.example/old",
      }),
    ).toMatchObject({ id: "old" });

    expect(
      parseReceipt({
        id: "rich",
        timestamp: "2026-09-10T08:00:00.000Z",
        resourceUrl: "https://api.example/paid",
        source: "vapi",
        phases: { discoverMs: 2, quoteMs: 8, signMs: 3, requestMs: 12, settleMs: 1 },
        listing: { name: "Weather", providerHost: "api.example", source: "vapi" },
        retry: 0,
        policy: { maxPriceUsd: "0.01", capsApplied: true },
        client: { name: "vapi-network", version: "0.2.0-dev.3" },
        outcome: "paid",
      }),
    ).toMatchObject({ outcome: "paid", client: { version: "0.2.0-dev.3" } });
  });

  it("keeps the signed authorization a lost response is settled against", () => {
    const authorization = {
      from: "0x9858EfFD232B4033E47d90003D41EC34EcaEda94",
      nonce: `0x${"ab".repeat(32)}`,
      validBefore: "1790000000",
    };
    const receipt = {
      id: "lost",
      timestamp: "2026-09-21T10:00:00.000Z",
      resourceUrl: "https://api.example/paid",
      quote: {
        network: "eip155:8453",
        asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        amountAtomic: "2500",
      },
      authorization,
      outcome: "settlement_unknown",
    };
    expect(parseReceipt(receipt).authorization).toEqual(authorization);
    expect(() =>
      parseReceipt({ ...receipt, authorization: { ...authorization, nonce: "0x1234" } }),
    ).toThrow();
  });

  it("derives the Arc mainnet explorer URL from a settlement hash", () => {
    expect(
      parseReceipt({
        id: "arc-paid",
        timestamp: "2026-09-21T10:00:00.000Z",
        resourceUrl: "https://api.example/paid",
        quote: { network: "eip155:5042", amountAtomic: "2500" },
        settlement: { outcome: "succeeded", transaction: "0xabc" },
      }).settlement,
    ).toEqual({
      outcome: "succeeded",
      transaction: "0xabc",
      explorerUrl: "https://explorer.arc.io/tx/0xabc",
    });
  });

  it("round-trips payment ids while old literal JSONL rows remain readable", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vapi-receipts-payment-id-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "receipts.jsonl");
    const oldLine =
      '{"id":"old","timestamp":"2026-09-10T08:00:00.000Z","resourceUrl":"https://api.example/old"}';
    await writeFile(path, `${oldLine}\n`, "utf8");
    const current: Receipt = {
      id: "current",
      timestamp: "2026-09-10T08:01:00.000Z",
      resourceUrl: "https://api.example/paid",
      paymentId: `pay_${"ab".repeat(16)}`,
    };
    await appendReceipt(current, path);

    expect(await readReceipts(path)).toEqual([
      {
        id: "old",
        timestamp: "2026-09-10T08:00:00.000Z",
        resourceUrl: "https://api.example/old",
      },
      current,
    ]);
    expect(() => parseReceipt({ ...current, paymentId: "bad id" })).toThrow();
  });

  it("parses old rows without a run descriptor", () => {
    expect(
      parseReceipt({
        id: "old-without-run",
        timestamp: "2026-09-10T08:00:00.000Z",
        resourceUrl: "https://api.example/old",
      }),
    ).toEqual({
      id: "old-without-run",
      timestamp: "2026-09-10T08:00:00.000Z",
      resourceUrl: "https://api.example/old",
    });
  });

  it("round trips a run descriptor", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vapi-receipts-run-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "receipts.jsonl");
    const receipt: Receipt = {
      id: "run-receipt",
      timestamp: "2026-09-10T08:00:00.000Z",
      resourceUrl: "https://api.example/paid",
      run: {
        id: "run_000102030405060708090a0b",
        swarm: "research",
        member: "research-lead-1",
        parentRunId: "run_111111111111111111111111",
      },
    };

    await appendReceipt(receipt, path);

    await expect(readReceipts(path)).resolves.toEqual([receipt]);
  });
});
