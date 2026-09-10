import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { appendReceipt, readReceipts, type Receipt } from "./receipts.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("receipts ledger", () => {
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
});
