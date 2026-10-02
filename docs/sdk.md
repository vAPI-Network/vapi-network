# SDK

The bundled client and lower-level packages are covered here; see [README.md](../README.md).

## SDK

### `createVapiClient`

Install the bundled client when you want documentation, Call, vAPI Router and
local agents behind one API:

```bash
npm i vapi-network
```

```ts
import { createVapiClient } from "vapi-network";

const vapi = await createVapiClient({ account: "researcher" });
const reply = await vapi.router.chat({
  model: "venice/claude-sonnet-5",
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

The `docs` namespace needs no wallet, account, credential or payment. It is
available before `vapi init` or `vapi setup`:

```ts
import { createVapiClient } from "vapi-network";

const vapi = await createVapiClient();
const matches = await vapi.docs.search("spend caps", { limit: 5 });
const page = await vapi.docs.read("/agents/quickstart");
const answer = await vapi.docs.ask("How do agent spend caps work?");
```

Lower-level code can import `searchDocs`, `readDocs` and `askDocs` directly
from `@vapi-network/core`. Documentation reads are restricted to the configured
docs origin, which defaults to `https://docs.vapinetwork.ai` and can be changed
with `VAPI_DOCS_URL`.

`{ wallet }` still works in 0.6 and prints one deprecation line to stderr; it goes away in 0.7.

### Lower-level packages

```bash
npm i @vapi-network/core @vapi-network/sources
```

`@vapi-network/core` is the main entry point: the x402 protocol, the wallet
store, spend policy, the network guard, discovery merge and the receipt ledger.
`@vapi-network/core/secrets` is a second, deliberately separate entry point for
the four functions that return a recovery phrase or a private key,
`exportRecoveryPhrase`, `exportKeystoreKeys`, `createKeystoreWithPhrase` and
`decryptPrivateKey`. They are not re-exported from the main index, and the MCP
package is forbidden by lint to import them, so a surface an agent drives cannot
reach a secret by accident.

Search and pay:

```ts
import {
  LocalWallet,
  SpendPolicy,
  WalletStore,
  getVapiPaths,
  loadConfig,
  resolvePassphrase,
  spendCapsForWallet,
} from "@vapi-network/core";
import { vapiRegistrySource } from "@vapi-network/sources";

const paths = getVapiPaths();
const config = await loadConfig(paths.config);
const [listing] = await vapiRegistrySource(config.marketplaceDiscoveryUrl, {
  discoveryUrl: config.discoveryUrl,
}).search("weather");

const store = await WalletStore.open(paths.directory);
const { name } = store.resolve();
const account = await store.unlock(name, (await resolvePassphrase(name)).passphrase);
const wallet = new LocalWallet(
  account,
  new SpendPolicy(await spendCapsForWallet(store, name), {
    ledgerPath: paths.ledger,
    wallet: name,
  }),
);
```

Manage wallets:

```ts
import { WalletStore, getVapiPaths, usdToAtomic } from "@vapi-network/core";

const store = await WalletStore.open(getVapiPaths().directory);
for (const wallet of await store.list()) {
  console.log(wallet.name, wallet.address, wallet.isDefault, wallet.spendCaps);
}
await store.setSpendCaps("agent", {
  perCallAtomic: String(usdToAtomic(0.05)),
  perDayAtomic: String(usdToAtomic(1)),
});
```

`WalletStore` is the one entry point for the layout: `open`, `list`, `resolve`,
`create`, `importKey`, `unlock`, `setDefault`, `rename`, `setLabel`,
`setSpendCaps`, `remove`, `restore` and `listTrash`. It never rewrites key
material; it moves, names and caps keystores.

Two runnable examples live in [`examples/`](../examples):
[`pay-with-sdk.ts`](../examples/pay-with-sdk.ts) (`pnpm example:pay -- weather`)
and [`wallets.ts`](../examples/wallets.ts) (`pnpm example:wallets -- agent-demo`).
