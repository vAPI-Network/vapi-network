import type { Receipt } from "./receipts.js";
import type { SearchEvent } from "./searches.js";

export const STATS_RANGES = ["24h", "7d", "30d"] as const;
export type StatsRange = (typeof STATS_RANGES)[number];
export type LatencyPercentiles = Readonly<{ p50Ms: number | null; p95Ms: number | null }>;
export type ReceiptOutcome = NonNullable<Receipt["outcome"]>;

const OUTCOMES: readonly ReceiptOutcome[] = [
  "paid",
  "signed_in",
  "declined_policy",
  "failed_request",
  "settlement_rejected",
  "settlement_unknown",
];
const RANGE_MS: Record<StatsRange, number> = {
  "24h": 24 * 60 * 60 * 1_000,
  "7d": 7 * 24 * 60 * 60 * 1_000,
  "30d": 30 * 24 * 60 * 60 * 1_000,
};

export interface StatsReport {
  readonly range: StatsRange;
  readonly generatedAt: string;
  readonly totals: Readonly<{
    spendUsd: string;
    calls: number;
    uniqueApis: number;
    policyDeclines: number;
  }>;
  readonly outcomes: Readonly<Record<ReceiptOutcome, Readonly<{ count: number; rate: number }>>>;
  readonly latency: Readonly<{
    total: LatencyPercentiles;
    phases: Readonly<
      Record<"discover" | "quote" | "sign" | "request" | "settle", LatencyPercentiles>
    >;
  }>;
  readonly topServices: Readonly<{
    bySpend: readonly ServiceStats[];
    byCalls: readonly ServiceStats[];
  }>;
  readonly search: Readonly<{
    count: number;
    zeroResultRate: number;
    sources: Readonly<Record<string, Readonly<{ count: number; p95Ms: number | null }>>>;
  }>;
}

export interface ServiceStats {
  readonly name: string;
  readonly resourceUrl: string;
  readonly providerHost?: string;
  readonly spendUsd: string;
  readonly calls: number;
}

export function aggregateStats(args: {
  receipts: readonly Receipt[];
  searches: readonly SearchEvent[];
  range?: StatsRange;
  now?: Date;
}): StatsReport {
  const range = args.range ?? "24h";
  const now = args.now ?? new Date();
  const cutoff = now.getTime() - RANGE_MS[range];
  const receipts = args.receipts.filter((receipt) => inRange(receipt.timestamp, cutoff, now));
  const searches = args.searches.filter((event) => inRange(event.timestamp, cutoff, now));
  const outcomeCounts = Object.fromEntries(OUTCOMES.map((outcome) => [outcome, 0])) as Record<
    ReceiptOutcome,
    number
  >;
  const services = new Map<
    string,
    { name: string; resourceUrl: string; providerHost?: string; spendAtomic: bigint; calls: number }
  >();
  let spendAtomic = 0n;

  for (const receipt of receipts) {
    const outcome = receiptOutcome(receipt);
    outcomeCounts[outcome] += 1;
    const paidAtomic =
      outcome === "paid" && receipt.quote ? BigInt(receipt.quote.amountAtomic) : 0n;
    spendAtomic += paidAtomic;
    const current = services.get(receipt.resourceUrl);
    const name =
      receipt.listing?.name ?? receipt.listing?.providerHost ?? serviceHost(receipt.resourceUrl);
    services.set(receipt.resourceUrl, {
      name: current?.name ?? name,
      resourceUrl: receipt.resourceUrl,
      ...(current?.providerHost || receipt.listing?.providerHost
        ? { providerHost: current?.providerHost ?? receipt.listing?.providerHost }
        : {}),
      spendAtomic: (current?.spendAtomic ?? 0n) + paidAtomic,
      calls: (current?.calls ?? 0) + 1,
    });
  }

  const serviceRows = [...services.values()].map((service): ServiceStats => ({
    name: service.name,
    resourceUrl: service.resourceUrl,
    ...(service.providerHost ? { providerHost: service.providerHost } : {}),
    spendUsd: atomicToUsd(service.spendAtomic),
    calls: service.calls,
  }));
  const outcomes = Object.fromEntries(
    OUTCOMES.map((outcome) => [
      outcome,
      { count: outcomeCounts[outcome], rate: rate(outcomeCounts[outcome], receipts.length) },
    ]),
  ) as StatsReport["outcomes"];
  const sourceLatencies = new Map<string, number[]>();
  const sourceCounts = new Map<string, number>();
  for (const event of searches) {
    for (const source of event.sources) {
      sourceLatencies.set(source.source, [
        ...(sourceLatencies.get(source.source) ?? []),
        source.latencyMs,
      ]);
      sourceCounts.set(source.source, (sourceCounts.get(source.source) ?? 0) + 1);
    }
  }
  const searchSources = Object.fromEntries(
    [...sourceLatencies]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([source, values]) => [
        source,
        { count: sourceCounts.get(source) ?? 0, p95Ms: percentile(values, 0.95) },
      ]),
  );

  return {
    range,
    generatedAt: now.toISOString(),
    totals: {
      spendUsd: atomicToUsd(spendAtomic),
      calls: receipts.length,
      uniqueApis: services.size,
      policyDeclines: outcomeCounts.declined_policy,
    },
    outcomes,
    latency: {
      total: latency(receipts.map((receipt) => receipt.latencyMs)),
      phases: {
        discover: latency(receipts.map((receipt) => receipt.phases?.discoverMs)),
        quote: latency(receipts.map((receipt) => receipt.phases?.quoteMs)),
        sign: latency(receipts.map((receipt) => receipt.phases?.signMs)),
        request: latency(receipts.map((receipt) => receipt.phases?.requestMs)),
        settle: latency(receipts.map((receipt) => receipt.phases?.settleMs)),
      },
    },
    topServices: {
      bySpend: [...serviceRows]
        .sort(
          (a, b) =>
            compareAtomic(b.spendUsd, a.spendUsd) ||
            b.calls - a.calls ||
            a.name.localeCompare(b.name),
        )
        .slice(0, 10),
      byCalls: [...serviceRows]
        .sort(
          (a, b) =>
            b.calls - a.calls ||
            compareAtomic(b.spendUsd, a.spendUsd) ||
            a.name.localeCompare(b.name),
        )
        .slice(0, 10),
    },
    search: {
      count: searches.length,
      zeroResultRate: rate(
        searches.filter((event) => event.mergedCount === 0).length,
        searches.length,
      ),
      sources: searchSources,
    },
  };
}

export function filterReceiptsByRange(
  receipts: readonly Receipt[],
  range: StatsRange,
  now = new Date(),
): Receipt[] {
  const cutoff = now.getTime() - RANGE_MS[range];
  return receipts.filter((receipt) => inRange(receipt.timestamp, cutoff, now));
}

export function receiptsToCsv(receipts: readonly Receipt[]): string {
  const headers = [
    "id",
    "timestamp",
    "outcome",
    "resourceUrl",
    "method",
    "source",
    "listingName",
    "providerHost",
    "network",
    "asset",
    "amountAtomic",
    "amountUsd",
    "payTo",
    "payer",
    "transaction",
    "status",
    "latencyMs",
    "discoverMs",
    "quoteMs",
    "signMs",
    "requestMs",
    "settleMs",
    "retry",
    "maxPriceUsd",
    "capsApplied",
    "clientName",
    "clientVersion",
    "errorCode",
    "errorMessage",
  ];
  const rows = receipts.map((receipt) => {
    const quote = receipt.quote;
    return [
      receipt.id,
      receipt.timestamp,
      receipt.outcome ?? receiptOutcome(receipt),
      receipt.resourceUrl,
      receipt.method,
      receipt.source,
      receipt.listing?.name,
      receipt.listing?.providerHost,
      quote?.network,
      quote?.asset,
      quote?.amountAtomic,
      quote ? atomicToUsd(BigInt(quote.amountAtomic)) : undefined,
      quote?.payTo,
      receipt.payer,
      receipt.settlement?.transaction,
      receipt.status,
      receipt.latencyMs,
      receipt.phases?.discoverMs,
      receipt.phases?.quoteMs,
      receipt.phases?.signMs,
      receipt.phases?.requestMs,
      receipt.phases?.settleMs,
      receipt.retry,
      receipt.policy?.maxPriceUsd,
      receipt.policy?.capsApplied,
      receipt.client?.name,
      receipt.client?.version,
      receipt.error?.code,
      receipt.error?.message,
    ]
      .map(csvCell)
      .join(",");
  });
  return [headers.join(","), ...rows].join("\n");
}

function receiptOutcome(receipt: Receipt): ReceiptOutcome {
  if (receipt.outcome) return receipt.outcome;
  if (receipt.settlement?.outcome === "succeeded") return "paid";
  if (receipt.settlement?.outcome === "rejected") return "settlement_rejected";
  if (receipt.settlement?.outcome === "unknown") return "settlement_unknown";
  if (
    receipt.error?.code === "max_price_exceeded" ||
    receipt.error?.code.includes("cap_exceeded")
  ) {
    return "declined_policy";
  }
  return receipt.error || (receipt.status !== undefined && receipt.status >= 400)
    ? "failed_request"
    : "paid";
}

function inRange(timestamp: string, cutoff: number, now: Date): boolean {
  const value = Date.parse(timestamp);
  return value >= cutoff && value <= now.getTime();
}

function latency(values: ReadonlyArray<number | undefined>): LatencyPercentiles {
  const present = values.filter((value): value is number => value !== undefined);
  return { p50Ms: percentile(present, 0.5), p95Ms: percentile(present, 0.95) };
}

function percentile(values: readonly number[], quantile: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(quantile * sorted.length) - 1] ?? null;
}

function atomicToUsd(value: bigint): string {
  const whole = value / 1_000_000n;
  const fraction = (value % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

function compareAtomic(leftUsd: string, rightUsd: string): number {
  const left = usdStringToAtomic(leftUsd);
  const right = usdStringToAtomic(rightUsd);
  return left < right ? -1 : left > right ? 1 : 0;
}

function usdStringToAtomic(value: string): bigint {
  const [whole = "0", fraction = ""] = value.split(".");
  return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
}

function rate(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : Number((numerator / denominator).toFixed(6));
}

function serviceHost(resourceUrl: string): string {
  try {
    return new URL(resourceUrl).hostname;
  } catch {
    return resourceUrl;
  }
}

function csvCell(value: unknown): string {
  if (value === undefined || value === null) return "";
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}
