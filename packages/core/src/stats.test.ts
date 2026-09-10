import { describe, expect, it } from "vitest";

import type { Receipt } from "./receipts.js";
import type { SearchEvent } from "./searches.js";
import { aggregateStats, receiptsToCsv } from "./stats.js";

const now = new Date("2026-09-10T12:00:00.000Z");
const receipts: Receipt[] = [
  receipt("paid-a", "2026-09-10T11:00:00.000Z", "https://a.example/call", {
    quote: quote("1500000"),
    outcome: "paid",
    latencyMs: 100,
    phases: { quoteMs: 20, requestMs: 70 },
    listing: { name: "API A", providerHost: "a.example", source: "vapi" },
  }),
  receipt("declined-b", "2026-09-10T10:00:00.000Z", "https://b.example/call", {
    quote: quote("250000"),
    outcome: "declined_policy",
    latencyMs: 200,
    phases: { quoteMs: 40 },
    listing: { name: "API B", providerHost: "b.example", source: "vapi" },
  }),
  receipt("old-a", "2026-09-10T09:00:00.000Z", "https://a.example/call", {
    quote: quote("500000"),
    settlement: { outcome: "succeeded" },
    latencyMs: 300,
  }),
  receipt("outside", "2026-09-08T09:00:00.000Z", "https://old.example/call", {
    quote: quote("9000000"),
    outcome: "paid",
  }),
];
const searches: SearchEvent[] = [
  {
    timestamp: "2026-09-10T10:00:00.000Z",
    query: "weather",
    sources: [
      { source: "api.vapinetwork.ai", latencyMs: 10, count: 2 },
      { source: "bazaar", latencyMs: 50, count: 1 },
    ],
    mergedCount: 2,
  },
  {
    timestamp: "2026-09-10T11:00:00.000Z",
    query: "empty",
    sources: [{ source: "api.vapinetwork.ai", latencyMs: 30, count: 0 }],
    mergedCount: 0,
  },
];

describe("local metrics aggregation", () => {
  it("aggregates spend, outcomes, latency, services, and search health", () => {
    const stats = aggregateStats({ receipts, searches, range: "24h", now });

    expect(stats.totals).toEqual({
      spendUsd: "2",
      calls: 3,
      uniqueApis: 2,
      policyDeclines: 1,
    });
    expect(stats.outcomes).toMatchObject({
      paid: { count: 2, rate: 0.666667 },
      declined_policy: { count: 1, rate: 0.333333 },
      failed_request: { count: 0, rate: 0 },
    });
    expect(stats.latency.total).toEqual({ p50Ms: 200, p95Ms: 300 });
    expect(stats.latency.phases.quote).toEqual({ p50Ms: 20, p95Ms: 40 });
    expect(stats.topServices.bySpend[0]).toMatchObject({
      name: "API A",
      spendUsd: "2",
      calls: 2,
    });
    expect(stats.search).toEqual({
      count: 2,
      zeroResultRate: 0.5,
      sources: {
        "api.vapinetwork.ai": { count: 2, p95Ms: 30 },
        bazaar: { count: 1, p95Ms: 50 },
      },
    });
  });

  it("exports stable flattened CSV fields with quoting", () => {
    const csv = receiptsToCsv([
      receipt("csv", "2026-09-10T11:00:00.000Z", "https://a.example/call", {
        outcome: "failed_request",
        error: { code: "bad", message: "provider, failed" },
      }),
    ]);
    expect(csv.split("\n")[0]).toContain("amountUsd");
    expect(csv.split("\n")[1]).toContain('"provider, failed"');
  });
});

function receipt(
  id: string,
  timestamp: string,
  resourceUrl: string,
  fields: Partial<Receipt>,
): Receipt {
  return { id, timestamp, resourceUrl, ...fields };
}

function quote(amountAtomic: string): NonNullable<Receipt["quote"]> {
  return {
    network: "eip155:8453",
    asset: "0xasset",
    amountAtomic,
    payTo: "0xpayee",
  };
}
