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

Discovery API hits may include `health` and `alternatives`. Health reports
`state`, `uptime7d`, `latencyP50Ms`, `latencyP95Ms` and `checks7d`.
Alternatives contain a `ref` and a `reason` of `cheaper` or `healthier`.
Inspected endpoints may include `responseSchema` and one `exampleRequest`.

`{ wallet }` remains a deprecated alias for `{ account }` in 0.12.0 and prints one deprecation line to stderr.

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
const passphrase = (await store.hasVaultAccount(name))
  ? ""
  : (await resolvePassphrase(name)).passphrase;
const account = await store.unlock(name, passphrase);
const wallet = new LocalWallet(
  account,
  new SpendPolicy(await spendCapsForWallet(store, name), {
    ledgerPath: paths.ledger,
    wallet: name,
  }),
);
```

Vault accounts use the device key or an open protected-vault session. The legacy
passphrase lookup runs only for an account not yet migrated to the vault.

The x402 payment path throws `SpendCapExceededError`, exported from
`@vapi-network/core`, before signing when a spend cap blocks payment. It has the
stable code `spend_cap_exceeded`, `retryable: false`, and the fields `cap`,
`amountUsd`, `limitUsd`, optional `spentUsd` and `wallet`, plus `command`.
`cap` is `per_call`, `per_day`, `max_price`, `max_amount` or `run_budget`.
Amounts are decimal USD strings. `command` is an account-cap command, a flag
fragment for `max_price` or `run_budget`, or null for `max_amount`.
Increase the SDK's `maxAtomic` in atomic USDC units for `max_amount`.
`toJSON()` returns the fields and message without the cause or `retryable`.
For the bundled client, catch the class from its `core` namespace. Lower-level
payments use the class imported directly from `@vapi-network/core`.

```ts
import { core } from "vapi-network";

try {
  await vapi.call.pay({ id: "weather", maxPriceUsd: 0.05 });
} catch (error) {
  if (!(error instanceof core.SpendCapExceededError)) throw error;
  console.error(error.cap, error.amountUsd, error.limitUsd, error.command);
}
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
`setSpendCaps`, `remove`, `restore` and `listTrash`. It manages accounts in the device vault and their registry metadata.
Names, labels and caps do not change an account's key.

Two runnable examples live in [`examples/`](../examples):
[`pay-with-sdk.ts`](../examples/pay-with-sdk.ts) (`pnpm example:pay -- weather`)
and [`wallets.ts`](../examples/wallets.ts) (`pnpm example:wallets -- agent-demo`).
