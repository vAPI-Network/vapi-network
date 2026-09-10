import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { appendReceipt, type Receipt } from "./receipts.js";
import { createSupportReport } from "./support-report.js";

const temporaryDirectories: string[] = [];
const NOW = new Date("2026-09-10T08:09:10.123Z");
const SYSTEM = {
  platform: "test-os",
  release: "1.2.3",
  arch: "test-arch",
  node: "v22.0.0-test",
};

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("support reports", () => {
  it("writes only the newest five receipt ids locally without fetching or leaking details", async () => {
    const directory = await temporaryDirectory();
    const receiptsPath = join(directory, "receipts.jsonl");
    const reportsDirectory = join(directory, "reports");
    for (let index = 0; index < 6; index += 1) {
      await appendReceipt(receipt(index), receiptsPath);
    }
    const fetchImpl = vi.fn<typeof fetch>();

    const result = await createSupportReport({
      message: "  payment failed oddly  ",
      receiptsPath,
      reportsDirectory,
      now: NOW,
      systemInfo: SYSTEM,
      fetchImpl,
    });

    expect(result).toMatchObject({
      path: join(reportsDirectory, "2026-09-10T08-09-10-123Z.json"),
      issueUrl:
        "https://github.com/vAPI-Network/vapi-network/issues/new?template=bug.yml&title=payment%20failed%20oddly&version=0.2.0-dev.3",
      report: {
        message: "payment failed oddly",
        clientVersion: "0.2.0-dev.3",
        os: { platform: "test-os", release: "1.2.3", arch: "test-arch" },
        node: "v22.0.0-test",
        receiptIds: ["receipt-1", "receipt-2", "receipt-3", "receipt-4", "receipt-5"],
      },
    });
    expect(result.report).not.toHaveProperty("receiptAddresses");
    expect(fetchImpl).not.toHaveBeenCalled();

    const serialized = await readFile(result.path, "utf8");
    expect(serialized).not.toContain("0xpayer");
    expect(serialized).not.toContain("0xpayee");
    expect(serialized).not.toContain("amountAtomic");
    expect((await stat(reportsDirectory)).mode & 0o777).toBe(0o700);
    expect((await stat(result.path)).mode & 0o777).toBe(0o600);
  });

  it("includes payer and payee metadata only when explicitly requested", async () => {
    const directory = await temporaryDirectory();
    const receiptsPath = join(directory, "receipts.jsonl");
    await appendReceipt(receipt(1), receiptsPath);

    const result = await createSupportReport({
      message: "show addresses",
      includeAddresses: true,
      receiptsPath,
      reportsDirectory: join(directory, "reports"),
      now: NOW,
      systemInfo: SYSTEM,
    });

    expect(result.report.receiptAddresses).toEqual([
      { receiptId: "receipt-1", payer: "0xpayer1", payTo: "0xpayee1" },
    ]);
    expect(await readFile(result.path, "utf8")).not.toContain("amountAtomic");
  });

  it("posts only after writing and returns non-success HTTP response codes", async () => {
    const directory = await temporaryDirectory();
    const reportsDirectory = join(directory, "reports");
    let existedWhenFetched = false;
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      existedWhenFetched = (await readdir(reportsDirectory)).length === 1;
      expect(String(input)).toBe("https://registry.example/base/api/support/reports");
      expect(init?.method).toBe("POST");
      expect(init?.headers).toEqual({ "content-type": "application/json" });
      expect(JSON.parse(String(init?.body))).toMatchObject({
        message: "the request failed",
        receiptIds: [],
      });
      return new Response(null, { status: 404 });
    });

    const result = await createSupportReport({
      message: "the request failed",
      send: true,
      reportsDirectory,
      receiptsPath: join(directory, "missing-receipts.jsonl"),
      now: NOW,
      systemInfo: SYSTEM,
      registryUrl: "https://registry.example/base/",
      fetchImpl,
    });

    expect(existedWhenFetched).toBe(true);
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(result.responseCode).toBe(404);
  });

  it("uses the guarded sender by default and refuses a private registry target", async () => {
    const directory = await temporaryDirectory();
    const reportsDirectory = join(directory, "reports");

    await expect(
      createSupportReport({
        message: "do not send privately",
        send: true,
        reportsDirectory,
        receiptsPath: join(directory, "missing-receipts.jsonl"),
        now: NOW,
        systemInfo: SYSTEM,
        registryUrl: "http://127.0.0.1:1",
      }),
    ).rejects.toThrow('URL hostname "127.0.0.1" is not allowed');
    expect(await readdir(reportsDirectory)).toEqual(["2026-09-10T08-09-10-123Z.json"]);
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "vapi-support-report-"));
  temporaryDirectories.push(directory);
  return directory;
}

function receipt(index: number): Receipt {
  return {
    id: `receipt-${index}`,
    timestamp: new Date(NOW.getTime() + index).toISOString(),
    resourceUrl: `https://api.example/${index}`,
    quote: {
      network: "eip155:8453",
      asset: "0xasset",
      amountAtomic: String(index + 1),
      payTo: `0xpayee${index}`,
    },
    payer: `0xpayer${index}`,
  };
}
