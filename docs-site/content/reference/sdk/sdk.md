---
title: "SDK"
description: "The TypeScript SDK provides local wallets, x402 payments, policy checks, and receipts through the vapi-network client."
order: 3
---

> [!NOTE]
> Call, Router, Stake and Agents are live. Tasks is coming soon.

New to vAPI? Start with the [Quickstart](/quickstart/).

The SDK gives your TypeScript process one client for vAPI Call, vAPI Router, and local vAPI agents. Use the lower-level packages when you need direct control of x402 payments, wallet policy, and receipts.

For empty vaults, wallet links, remote signing and custom MCP streams, see [Embedding the wallet and MCP server](/reference/sdk/embedding-mcp/).

## Install

Clients ≤ 0.9.0 fail every search whose results include a Solana row. Update to 0.14.0 with `npm i -g vapi-network@latest`.

Install the bundled client:

```bash
npm i vapi-network
```

## createVapiClient

Create an account-bound client:

```ts
import { createVapiClient } from "vapi-network";

const vapi = await createVapiClient({ account: "researcher" });
const reply = await vapi.router.chat({
  model: "venice/deepseek-v4-flash",
  messages: [{ role: "user", content: "Summarise Base DEX activity." }],
});
console.log(reply.content);

const listings = await vapi.call.search("Base DEX volume");
console.log(listings);
const result = await vapi.call.pay({ id: "base-dex-volume", maxPriceUsd: 0.05 });
console.log(result.body);

const purchase = await vapi.router.buy(5);
console.log(purchase.balance);
```

| Option        | What it does                                                                                                          |
| ------------- | --------------------------------------------------------------------------------------------------------------------- |
| `account`     | Selects a local account name or injects a `VapiPaymentAccount`. It defaults to `VAPI_WALLET`, then the vault default. |
| `home`        | Sets the local state directory. It defaults to `VAPI_HOME`, then `~/.vapi`.                                           |
| `fetch`       | Injects a Fetch implementation.                                                                                       |
| `secretStore` | Injects an OS secret-store implementation for embedded runtimes or tests.                                             |
| `env`         | Injects environment values for home, account, and passphrase lookup.                                                  |
| `passphrase`  | Supplies a fallback legacy keystore passphrase after environment and OS secret-store lookup.                          |

The deprecated `wallet` option remains for compatibility. Use `account` in new code.

The client surface is:

- vAPI Call: `call.search`, `call.inspect`, and `call.pay`.
- vAPI Router: `router.models`, `router.usage`, `router.chat`, `router.buy`, and `router.openai()`.
- vAPI agents: `agent.run`.
- Public docs: `docs.search`, `docs.read`, and `docs.ask`, without a wallet.

`call.pay(input)` accepts optional `timeoutSeconds`, an integer from 1 to 300. By default, the client uses the offer's `maxTimeoutSeconds` for the paid response, with a minimum of 30 seconds and a maximum of 120 seconds. An override is capped at the offer's `maxTimeoutSeconds`. The unpaid 402 probe waits at most 30 seconds. If the paid response times out, the client reports `settlement_unknown`. Run `vapi pay --resume <receipt-id>` to see whether it settled.

For server use, pass an injected signing account with the `account` option instead of a local vault account. Router methods require an owner link for that account in local state.

Protected local vaults use the vault signer after the process gains vault access. Supply `VAPI_VAULT_PASSWORD` for unattended access. Open an eight-hour device session before starting the process with:

```bash
vapi vault unlock
```

### router.openai()

`router.openai()` returns `{ baseURL, apiKey }` for any OpenAI-compatible framework. Use it in your own code. Do not pass it into a model prompt.

```ts
const { baseURL, apiKey } = await vapi.router.openai();
// Pass baseURL and apiKey to your OpenAI-compatible client constructor.
```

Your wallet's spend caps apply to every purchase, including automatic refill. Bought vAPI Router balance never expires and is used after the daily Compute allowance.

## Lower-level packages

Install the core package and the discovery adapters:

```bash
npm i @vapi-network/core @vapi-network/sources
```

`@vapi-network/core` is the main SDK entry point. It provides the x402 protocol, wallet store, spend policy, network guard, discovery merge, and receipt ledger. `@vapi-network/sources` provides `vapiRegistrySource`, `bazaarSource`, `localFileSource`, and `x402scanSource`.

The separate `@vapi-network/core/secrets` entry point exports `exportRecoveryPhrase`, `exportKeystoreKeys`, `createKeystoreWithPhrase`, and `decryptPrivateKey`. These functions are not re-exported from the main entry point. The MCP package is forbidden to import them.

### Discover and pay

This example follows the same order as `examples/pay-with-sdk.ts`: discover a listing, open the named wallet, read the 402 challenge, apply the wallet's policy, sign locally, and send the request.

```ts
import {
  LocalWallet,
  SpendPolicy,
  WalletStore,
  buildCompatibleX402Payment,
  createPublicFetch,
  getVapiPaths,
  loadConfig,
  parse402Response,
  resolvePassphrase,
  spendCapsForWallet,
} from "@vapi-network/core";
import { vapiRegistrySource } from "@vapi-network/sources";

const query = process.argv[2] ?? "weather";
const walletName = process.argv[3];
const paths = getVapiPaths();
const config = await loadConfig(paths.config);
const source = vapiRegistrySource(config.marketplaceDiscoveryUrl, {
  discoveryUrl: config.discoveryUrl,
});
const [listing] = await source.search(query);
if (!listing) throw new Error(`No payable listing found for ${JSON.stringify(query)}.`);

const store = await WalletStore.open(paths.directory);
const selected = store.resolve(walletName === undefined ? {} : { name: walletName });
const account = (await store.hasVaultAccount(selected.name))
  ? await store.unlock(selected.name, "")
  : await store.unlock(selected.name, (await resolvePassphrase(selected.name)).passphrase);
const wallet = new LocalWallet(
  account,
  new SpendPolicy(await spendCapsForWallet(store, selected.name), {
    ledgerPath: paths.ledger,
    wallet: selected.name,
  }),
);

const fetcher = createPublicFetch({
  allowPrivateNetwork: config.allowPrivateNetwork ?? false,
});
const method = listing.method ?? "POST";
const body = method === "GET" || method === "HEAD" ? undefined : JSON.stringify({ query });
const headers = new Headers({ accept: "application/json" });
if (body) headers.set("content-type", "application/json");

const initial = await fetcher(listing.resource.url, { method, headers, body });
if (initial.status !== 402) {
  console.log(await initial.text());
  process.exit(0);
}

const paymentMetadata = asRecord(listing.metadata?.payment);
const expectedPayTo =
  typeof paymentMetadata?.payTo === "string" ? paymentMetadata.payTo : undefined;
const quote = await parse402Response(initial, config.networks, listing.network, expectedPayTo);

// Apply policy before creating a payment authorization.
await wallet.authorize({
  amountAtomic: quote.amountAtomic,
  network: quote.accepted.network,
  payTo: quote.accepted.payTo as `0x${string}`,
  resourceUrl: listing.resource.url,
});

const payment = await buildCompatibleX402Payment({ account: wallet, quote });
for (const [name, value] of Object.entries(payment.headers)) headers.set(name, value);
const response = await fetcher(listing.resource.url, { method, headers, body });
console.log(await response.text());

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
```

`wallet.authorize` checks the wallet's spend policy before the payment is built. A declined call does not create a payment authorization. The complete example also appends a local receipt after the response.

### Manage wallets and caps

`WalletStore` owns the local account layout. Its documented operations are `open`, `list`, `resolve`, `create`, `importKey`, `unlock`, `setDefault`, `rename`, `setLabel`, `setSpendCaps`, `remove`, `restore`, and `listTrash`.

Caps belong to the named wallet. This example sets a separate allowance for an agent wallet:

```ts
import { WalletStore, getVapiPaths, usdToAtomic } from "@vapi-network/core";

const store = await WalletStore.open(getVapiPaths().directory);
await store.setSpendCaps("agent", {
  perCallAtomic: String(usdToAtomic(0.05)),
  perDayAtomic: String(usdToAtomic(1)),
});
```

Legacy account passphrases resolve from `VAPI_KEYSTORE_PASSWORD`, the OS secret store, or a terminal prompt. Keep recovery functions behind the separate secrets entry point and keep them out of agent-driven surfaces.

Checked on 2026-11-17.
