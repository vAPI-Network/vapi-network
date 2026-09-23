import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";
import { getAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { getDefaultConfig } from "./config.js";
import { NETWORKS } from "./networks.js";
import { readReceipts } from "./receipts.js";
import { readSpendLedger, SpendCapError } from "./spend-policy.js";
import { ARC_TESTNET_CAIP2, BASE_MAINNET_CAIP2 } from "./x402-networks.js";
import { payRequest } from "./x402-pay.js";
import { X402Error } from "./x402.js";

const PAY_TO = getAddress("0x1111111111111111111111111111111111111111");
const PRIVATE_KEY = "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" as Hex;
const NOW = new Date("2026-09-23T10:00:00.000Z");
const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

function exactOffer(network: string, amount = "2500") {
  const configured = NETWORKS[network as keyof typeof NETWORKS];
  if (!configured) throw new Error(`Missing configured network ${network}.`);
  return {
    scheme: "exact",
    network,
    amount,
    asset: configured.usdc,
    payTo: PAY_TO,
    maxTimeoutSeconds: 60,
    extra:
      network === ARC_TESTNET_CAIP2
        ? { name: "USDC", version: "2" }
        : { name: "USD Coin", version: "2" },
  };
}

function challenge(accepts = [exactOffer(BASE_MAINNET_CAIP2)]) {
  return {
    x402Version: 2,
    resource: {
      url: "https://vendor.example/paid",
      description: "Fixture endpoint",
      mimeType: "application/json",
    },
    accepts,
  };
}

function paymentRequired(accepts?: ReturnType<typeof exactOffer>[]) {
  return new Response(JSON.stringify(challenge(accepts)), {
    status: 402,
    headers: { "content-type": "application/json" },
  });
}

function paidResponse(transaction = `0x${"33".repeat(32)}`) {
  const settlement = { success: true, transaction };
  return new Response(JSON.stringify({ paid: true }), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "payment-response": Buffer.from(JSON.stringify(settlement), "utf8").toString("base64"),
    },
  });
}

async function paths() {
  const directory = await mkdtemp(join(tmpdir(), "vapi-core-x402-pay-"));
  temporaryDirectories.push(directory);
  return {
    ledgerPath: join(directory, "spend-ledger.json"),
    receiptsPath: join(directory, "receipts.jsonl"),
  };
}

describe("payRequest", () => {
  it("declines an over-cap quote before signing or mutating the spend ledger", async () => {
    const localPaths = await paths();
    const config = getDefaultConfig();
    const account = privateKeyToAccount(PRIVATE_KEY);
    const signSpy = vi.spyOn(account, "signTypedData");
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(paymentRequired());

    await expect(
      payRequest({
        url: "https://vendor.example/paid",
        init: { method: "POST", body: JSON.stringify({ prompt: "hello" }) },
        account,
        wallet: "main",
        caps: { perCallAtomic: "2499", perDayAtomic: "10000" },
        config,
        fetchImpl,
        paths: localPaths,
        now: NOW,
        lookup: async () => ["93.184.216.34"],
      }),
    ).rejects.toBeInstanceOf(SpendCapError);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(signSpy).not.toHaveBeenCalled();
    await expect(readSpendLedger(localPaths.ledgerPath, NOW)).resolves.toEqual({
      date: "2026-09-23",
      spentAtomic: "0",
    });
    await expect(readReceipts(localPaths.receiptsPath)).resolves.toMatchObject([
      {
        outcome: "declined_policy",
        quote: { network: BASE_MAINNET_CAIP2, amountAtomic: "2500", payTo: PAY_TO },
        error: { code: "per_call_cap_exceeded" },
      },
    ]);
  });

  it("returns the paid response and writes one paid receipt with settlement details", async () => {
    const localPaths = await paths();
    const transaction = `0x${"44".repeat(32)}`;
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(paymentRequired())
      .mockResolvedValueOnce(paidResponse(transaction));

    const result = await payRequest({
      url: "https://vendor.example/paid",
      init: {
        method: "POST",
        headers: { "x-version": "4" },
        body: JSON.stringify({ prompt: "hello" }),
      },
      account: privateKeyToAccount(PRIVATE_KEY),
      wallet: "main",
      caps: { perCallAtomic: "10000", perDayAtomic: "10000" },
      config: getDefaultConfig(),
      fetchImpl,
      paths: localPaths,
      now: NOW,
      lookup: async () => ["93.184.216.34"],
    });

    expect(result.response.status).toBe(200);
    await expect(result.response.json()).resolves.toEqual({ paid: true });
    expect(result.receipt).toMatchObject({
      outcome: "paid",
      quote: {
        network: BASE_MAINNET_CAIP2,
        amountAtomic: "2500",
        payTo: PAY_TO,
      },
      settlement: { outcome: "succeeded", transaction },
      status: 200,
    });
    await expect(readReceipts(localPaths.receiptsPath)).resolves.toHaveLength(1);
  });

  it("keeps the caller authorization header on the paid retry without recording secrets", async () => {
    const localPaths = await paths();
    const bearer = "Bearer agent-token-must-stay-secret";
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(paymentRequired())
      .mockResolvedValueOnce(paidResponse());

    await payRequest({
      url: "https://vendor.example/paid",
      init: {
        method: "POST",
        headers: { authorization: bearer, "x-caller-header": "kept" },
        body: JSON.stringify({ prompt: "hello" }),
      },
      account: privateKeyToAccount(PRIVATE_KEY),
      wallet: "main",
      caps: { perCallAtomic: "10000", perDayAtomic: "10000" },
      config: getDefaultConfig(),
      fetchImpl,
      paths: localPaths,
      now: NOW,
      lookup: async () => ["93.184.216.34"],
    });

    const paidRequest = fetchImpl.mock.calls[1]![0] as Request;
    expect(paidRequest.headers.get("authorization")).toBe(bearer);
    expect(paidRequest.headers.get("x-caller-header")).toBe("kept");
    expect(paidRequest.headers.get("payment-signature")).toBeTruthy();
    expect(paidRequest.headers.get("x-payment")).toBeTruthy();

    const receiptJson = await readFile(localPaths.receiptsPath, "utf8");
    expect(receiptJson).not.toContain(bearer);
    expect(receiptJson).not.toContain(paidRequest.headers.get("payment-signature"));
    expect(receiptJson).not.toContain(paidRequest.headers.get("x-payment"));
  });

  it("refuses a quote above maxAtomic before reserving or signing", async () => {
    const localPaths = await paths();
    const account = privateKeyToAccount(PRIVATE_KEY);
    const signSpy = vi.spyOn(account, "signTypedData");
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(paymentRequired());

    await expect(
      payRequest({
        url: "https://vendor.example/paid",
        init: { method: "GET" },
        account,
        wallet: "main",
        caps: { perCallAtomic: "10000", perDayAtomic: "10000" },
        config: getDefaultConfig(),
        fetchImpl,
        paths: localPaths,
        maxAtomic: 2499n,
        now: NOW,
        lookup: async () => ["93.184.216.34"],
      }),
    ).rejects.toMatchObject({ code: "max_price_exceeded" } satisfies Partial<X402Error>);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(signSpy).not.toHaveBeenCalled();
    await expect(readSpendLedger(localPaths.ledgerPath, NOW)).resolves.toMatchObject({
      spentAtomic: "0",
    });
    await expect(readReceipts(localPaths.receiptsPath)).resolves.toMatchObject([
      { outcome: "declined_policy", error: { code: "max_price_exceeded" } },
    ]);
  });

  it("honors preferNetworks when two configured exact quotes are offered", async () => {
    const localPaths = await paths();
    const config = getDefaultConfig();
    config.networks[ARC_TESTNET_CAIP2] = {
      rpcUrl: "https://arc-rpc.example",
      usdc: NETWORKS[ARC_TESTNET_CAIP2].usdc,
    };
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        paymentRequired([exactOffer(BASE_MAINNET_CAIP2), exactOffer(ARC_TESTNET_CAIP2, "2000")]),
      )
      .mockResolvedValueOnce(paidResponse());

    const { receipt } = await payRequest({
      url: "https://vendor.example/paid",
      init: { method: "GET" },
      account: privateKeyToAccount(PRIVATE_KEY),
      wallet: "main",
      caps: { perCallAtomic: "10000", perDayAtomic: "10000" },
      config,
      fetchImpl,
      paths: localPaths,
      preferNetworks: [ARC_TESTNET_CAIP2, BASE_MAINNET_CAIP2],
      now: NOW,
      lookup: async () => ["93.184.216.34"],
    });

    expect(receipt.quote).toMatchObject({ network: ARC_TESTNET_CAIP2, amountAtomic: "2000" });
    const paidRequest = fetchImpl.mock.calls[1]![0] as Request;
    const payload = JSON.parse(
      Buffer.from(paidRequest.headers.get("payment-signature")!, "base64").toString("utf8"),
    ) as { accepted: { network: string } };
    expect(payload.accepted.network).toBe(ARC_TESTNET_CAIP2);
  });

  it("does not expose reflected caller or payment credentials in errors or receipts", async () => {
    const localPaths = await paths();
    const bearer = "Bearer reflected-agent-token";
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          ...challenge(),
          x402Version: bearer,
        }),
        { status: 402, headers: { "content-type": "application/json" } },
      ),
    );

    const error = await payRequest({
      url: "https://vendor.example/paid",
      init: { headers: { authorization: bearer } },
      account: privateKeyToAccount(PRIVATE_KEY),
      wallet: "main",
      caps: { perCallAtomic: "10000", perDayAtomic: "10000" },
      config: getDefaultConfig(),
      fetchImpl,
      paths: localPaths,
      now: NOW,
      lookup: async () => ["93.184.216.34"],
    }).then(
      () => new Error("Expected a reflected invalid challenge to fail."),
      (failure: unknown) => failure as Error,
    );

    expect(error.message).not.toContain(bearer);
    expect(error.message).not.toContain("reflected-agent-token");
    expect(inspect(error, { depth: 10 })).not.toContain("reflected-agent-token");
    expect(await readFile(localPaths.receiptsPath, "utf8")).not.toContain("reflected-agent-token");

    const settlementPaths = await paths();
    let paymentSignature = "";
    const settlementFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(paymentRequired())
      .mockImplementationOnce(async (input) => {
        paymentSignature = (input as Request).headers.get("payment-signature") ?? "";
        return paidResponse(paymentSignature);
      });
    const result = await payRequest({
      url: "https://vendor.example/paid",
      init: { headers: { authorization: bearer } },
      account: privateKeyToAccount(PRIVATE_KEY),
      wallet: "main",
      caps: { perCallAtomic: "10000", perDayAtomic: "10000" },
      config: getDefaultConfig(),
      fetchImpl: settlementFetch,
      paths: settlementPaths,
      now: NOW,
      lookup: async () => ["93.184.216.34"],
    });

    expect(paymentSignature).not.toBe("");
    expect(result.receipt.settlement?.transaction).toBe("[redacted]");
    expect(await readFile(settlementPaths.receiptsPath, "utf8")).not.toContain(paymentSignature);
  });

  it("honors cancellation before reserving or signing the paid retry", async () => {
    const localPaths = await paths();
    const controller = new AbortController();
    const account = privateKeyToAccount(PRIVATE_KEY);
    const signSpy = vi.spyOn(account, "signTypedData");
    const fetchImpl = vi.fn<typeof fetch>().mockImplementationOnce(async () => {
      controller.abort();
      return paymentRequired();
    });

    await expect(
      payRequest({
        url: "https://vendor.example/paid",
        init: { signal: controller.signal },
        account,
        wallet: "main",
        caps: { perCallAtomic: "10000", perDayAtomic: "10000" },
        config: getDefaultConfig(),
        fetchImpl,
        paths: localPaths,
        now: NOW,
        lookup: async () => ["93.184.216.34"],
      }),
    ).rejects.toMatchObject({ name: "AbortError" });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(signSpy).not.toHaveBeenCalled();
    await expect(readSpendLedger(localPaths.ledgerPath, NOW)).resolves.toMatchObject({
      spentAtomic: "0",
    });
  });
});
