import { randomUUID } from "node:crypto";

import {
  LocalWallet,
  SpendPolicy,
  appendReceipt,
  buildCompatibleX402Payment,
  classifySettlement,
  createPublicFetch,
  getKeystorePassphrase,
  getVapiPaths,
  loadConfig,
  parse402Response,
  parseSettlementResponse,
  unlockKeystore,
} from "../packages/core/dist/index.js";
import { vapiRegistrySource } from "../packages/sources/dist/index.js";

const query = process.argv[2] ?? "weather";
const paths = getVapiPaths();
const config = await loadConfig(paths.config);
const source = vapiRegistrySource(config.marketplaceDiscoveryUrl, {
  discoveryUrl: config.discoveryUrl,
});
const [listing] = await source.search(query);
if (!listing) throw new Error(`No payable listing found for ${JSON.stringify(query)}.`);

const account = await unlockKeystore(await getKeystorePassphrase(), paths.keystore);
const wallet = new LocalWallet(
  account,
  new SpendPolicy(config.spendCaps, { ledgerPath: paths.ledger }),
);
const guardedFetch = createPublicFetch({
  allowPrivateNetwork: config.allowPrivateNetwork ?? false,
});
const method = listing.method ?? "POST";
const body = method === "GET" || method === "HEAD" ? undefined : JSON.stringify({ query });
const headers = new Headers({ accept: "application/json" });
if (body) headers.set("content-type", "application/json");

const initial = await guardedFetch(listing.resource.url, { method, headers, body });
if (initial.status !== 402) {
  console.log(await initial.text());
  process.exit(0);
}

const registeredPayment = asRecord(listing.metadata?.payment);
const expectedPayTo =
  typeof registeredPayment?.payTo === "string" ? registeredPayment.payTo : undefined;
const quote = await parse402Response(initial, config.networks, listing.network, expectedPayTo);
await wallet.authorize({
  amountAtomic: quote.amountAtomic,
  network: quote.accepted.network,
  payTo: quote.accepted.payTo,
  resourceUrl: listing.resource.url,
});
const payment = await buildCompatibleX402Payment({ account: wallet, quote });
for (const [name, value] of Object.entries(payment.headers)) headers.set(name, value);

const startedAt = Date.now();
const response = await guardedFetch(listing.resource.url, { method, headers, body });
const settlement = parseSettlementResponse(response.headers);
await appendReceipt({
  id: randomUUID(),
  timestamp: new Date().toISOString(),
  resourceUrl: listing.resource.url,
  method,
  provenance: listing.provenance,
  quote: {
    network: quote.accepted.network,
    asset: quote.accepted.asset,
    amountAtomic: quote.amountAtomic.toString(),
    payTo: quote.accepted.payTo,
  },
  payer: wallet.address,
  settlement: { outcome: classifySettlement(settlement), evidence: settlement },
  latencyMs: Date.now() - startedAt,
  status: response.status,
});

console.log(await response.text());

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
