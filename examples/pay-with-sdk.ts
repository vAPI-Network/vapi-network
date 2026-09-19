/**
 * Discover one x402 listing, apply the wallet's own spend caps, sign locally
 * and pay the service directly.
 *
 * Run it with `pnpm example:pay -- weather`. It uses the wallet `vapi init`
 * created: `VAPI_WALLET` or the machine default, unless you pass a name as the
 * second argument. The passphrase comes from `VAPI_KEYSTORE_PASSWORD`, then
 * from the OS secret store `vapi unlock` writes to, then from a prompt.
 */
import { randomUUID } from "node:crypto";

import {
  SpendPolicy,
  WalletStore,
  LocalWallet,
  appendReceipt,
  buildCompatibleX402Payment,
  classifySettlement,
  createPublicFetch,
  getVapiPaths,
  loadConfig,
  parse402Response,
  parseSettlementResponse,
  resolvePassphrase,
  spendCapsForWallet,
} from "@vapi-network/core";
import { vapiRegistrySource } from "@vapi-network/sources";

const query = process.argv[2] ?? "weather";
const requestedWallet = process.argv[3];

const paths = getVapiPaths();
const config = await loadConfig(paths.config);
const source = vapiRegistrySource(config.marketplaceDiscoveryUrl, {
  discoveryUrl: config.discoveryUrl,
});
const [listing] = await source.search(query);
if (!listing) throw new Error(`No payable listing found for ${JSON.stringify(query)}.`);

// The wallet store owns the layout: one keystore per named wallet, and the
// caps that belong to that wallet rather than to the machine.
const store = await WalletStore.open(paths.directory);
const selected = store.resolve(requestedWallet === undefined ? {} : { name: requestedWallet });
const { passphrase } = await resolvePassphrase(selected.name);
const account = await store.unlock(selected.name, passphrase);
console.error(`Wallet: ${selected.name} (${account.address})`);

const wallet = new LocalWallet(
  account,
  new SpendPolicy(await spendCapsForWallet(store, selected.name), {
    ledgerPath: paths.ledger,
    wallet: selected.name,
  }),
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
// Policy first: a declined call must never produce a payment authorization.
await wallet.authorize({
  amountAtomic: quote.amountAtomic,
  network: quote.accepted.network,
  // The challenge is wire data, so its payTo arrives as a plain string; the
  // 402 parser has already checked its shape against the network.
  payTo: quote.accepted.payTo as `0x${string}`,
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
  wallet: selected.name,
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
