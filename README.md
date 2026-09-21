# vAPI Network

**One wallet, every x402 API.** vAPI Network is an open-source, non-custodial
TypeScript toolkit for discovering and paying x402 services from a terminal, an
MCP client, or your own code. Your key is generated on your machine, encrypted
under your passphrase, and never leaves it. vAPI applies spend policy before
signing, sends the payment straight to the service, and writes a local receipt.

Call works today. Tasks and Compute are next.

## Quickstart

```bash
npm i -g vapi-network
vapi init                        # creates ~/.vapi, the wallet main, and prints its address
vapi backup                      # write the 12 words down; vAPI cannot recover them
vapi fund                        # opens the hosted funding page for your address
vapi search "weather"            # every catalogue, merged, with provenance
vapi pay <listing-ref> --max 0.02
vapi receipts                    # one line per paid call: quote, settlement, latency
```

That is the same order `vapi init` prints as its next steps, and the same order
`vapi` alone lists. Two more are worth knowing early: `vapi inspect <ref>` shows
a listing's request contract and live 402 quote for free, before you pay, and
`vapi balance` shows what the wallet holds.

`vapi search` tags each listing with its group — `[vapi]`, `[added]`,
`[partner]` or `[external]` — and prints the network fee that is already inside
the price. vAPI and added APIs carry a 5% network fee inside the quoted price;
partner and external listings carry none. `vapi inspect` and `--json` return the
same `group` and `fee` fields.

Listing on vAPI is permissionless, and verification is a tier on top of it. Each
result also carries `[verified]`, `[requested]` or `[unverified]`, and a
mirrored catalog row carries `[external]` instead. By default `vapi search`
answers with vAPI-verified listings plus the mirrored external catalogs;
`--include-unverified` also returns self-listed APIs that passed vAPI's
automated x402 probe but were never reviewed. `vapi inspect` prints a
`Verification:` line, `vapi pay` says so in one line before the result when the
listing it just paid is not verified, and `--json` carries `verification` on
all three.

`vapi inspect` also says how a listing has behaved lately, when the registry
has measured it: a `Liveness:` line with its uptime over the last seven days of
hourly re-probes and its p50 and p95 latency, and a `Conformance:` line with the
x402 version its 402 declares, whether it follows that version, where the offer
travels, and any issue codes — the same codes `vapi check` reports. A registry
that has not measured a listing sends neither, and neither line is printed.
`--json` carries them as `liveness` and `conformance`.

No install? Prefix any command with `npx vapi-network`, for example
`npx vapi-network init`. (`npx vapi` cannot work: the bare `vapi` name on npm
belongs to an unrelated package.)

## Wallets

One machine can hold several wallets: your own, and a capped one per agent. Each
keystore lives in `$VAPI_HOME/wallets/<name>.json`; `$VAPI_HOME/wallets.json`
records which one is the default, what each may spend, and its label. Names are
1 to 32 characters of lowercase letters, digits and dashes.

```bash
vapi wallet list                                 # address, default marker, caps, unlocked, label
vapi wallet create agent --label "claude code"   # a wallet of its own for the agent
vapi wallet caps agent --per-call 0.05 --per-day 1
vapi wallet use agent                            # make it the default for later commands
vapi pay <listing-ref> --wallet agent --max 0.02
vapi receipts --wallet agent                     # or --all-wallets for every one
```

Every command that touches a wallet takes `--wallet <name>`: `balance`,
`accounts`, `fund`, `pay`, `sweep`, `receipts`, `stats`, `export-key`, `backup`,
`import`, `passphrase`, `unlock`, `lock` and `mcp`. Without it, `VAPI_WALLET`
decides; without that, the default set by `vapi wallet use` does. Each of them
names the wallet it used — `Wallet: main (0x…)` on the first line, or a `wallet`
field in `--json` — so neither you nor an agent can be wrong about which key
just moved.

Spend caps belong to the wallet, not to the machine, and today's total is
counted per wallet: an agent cannot spend your daily allowance. Removing a
wallet is a move, not a delete — the encrypted keystore goes to
`wallets/.trash/`, where `vapi wallet restore` can bring it back.

**Coming from 0.2.x?** Nothing to do. The first command you run opens the wallet
store, moves `keystore.json` to `wallets/main.json` with its contents untouched,
turns `config.json`'s spend caps into the caps of `main`, and leaves
`keystore.json` behind as a mode 0600 symlink for one release so existing
scripts keep working. A home with no keystore migrates nothing.

## Your wallet is yours

`vapi init` generates a 12-word BIP-39 recovery phrase on your machine, derives
the Base account (`m/44'/60'/0'/0/0`) and, with `--networks base,solana`, the
Solana account (`m/44'/501'/0'/0'`) from it, and writes the phrase encrypted
under your passphrase to `$VAPI_HOME/wallets/main.json` (mode 0600). The phrase
is shown once, on a terminal, and never in `--json` or piped output.

Three things vAPI cannot do:

- **See it.** No key, phrase or passphrase ever leaves the machine.
- **Recover it.** There is no copy anywhere to restore from.
- **Freeze it.** Payments go straight from your wallet to the service.

### Back it up

```bash
vapi backup                       # the 12 words, numbered, on a terminal
vapi backup --json                # { "wallet": "main", "recoveryPhrase": "..." }
```

Write the words on paper and keep them somewhere only you reach. Anyone holding
them can spend the wallet, so never type them into a website or a chat.

Wallets created before 0.2.5 have no recovery phrase. `vapi backup` says so and
points at `vapi export-key`, which prints the private key itself; back that key
up, or `vapi import --key` it into a new wallet. Restoring a phrase-based wallet
in MetaMask, Rabby, Coinbase Wallet or Phantom gives the same addresses.

### Import and move a wallet

```bash
vapi import --phrase                          # type the words at the prompt
vapi import --phrase --networks base,solana   # restore both accounts
vapi import --key                             # a 0x private key instead of words
vapi import --phrase --wallet backup-2026     # into a named wallet of its own
```

`vapi import` reads the secret from a prompt, never from the command line where
a shell history would keep it, and asks for a new passphrase. It writes a new
named wallet rather than replacing one: `--wallet <name>` chooses the name, and
`main` is assumed only on a machine with no wallet yet. `--replace` moves the
named wallet to `wallets/.trash/` first, and still refuses a wallet that holds
USDC on Base unless you add `--force`.

### Change the passphrase

```bash
vapi passphrase                   # current passphrase, then the new one twice
```

The wallet, its addresses and its recovery phrase are unchanged. Any copy of the
old passphrase stored by `vapi unlock` is removed at the same time, so nothing
is left behind that no longer opens the wallet.

### Agents and secrets

An agent can drive vAPI all day without ever seeing a secret. It can search,
inspect, pay from the wallet you gave it, read balances and receipts, and pick a
wallet by name with `wallet.use` — which changes only that session, never your
default on disk. It cannot see a recovery phrase, a private key or a passphrase,
and the MCP server has no tool that creates, removes, renames, backs up or
exports a wallet.

`vapi backup` and `vapi export-key` print a secret, so they run only when a
person is demonstrably there: stdin and stdout are both a real terminal, no
agent or CI marker is set, and you type the wallet's own name to confirm.
Otherwise they print nothing and say:

```text
Run this yourself in a terminal; an agent must never see these words.
```

The markers vAPI refuses on are `VAPI_NO_SECRETS`, `CLAUDECODE`, `CLAUDE_CODE`,
`CURSOR_AGENT`, `CODEX_SANDBOX`, `OPENAI_CODEX`, `AGENT` and `CI`. Set
`VAPI_NO_SECRETS=1` in a machine's agent configuration to switch secret printing
off outright. `vapi init` and `vapi wallet create` still create the wallet under
those conditions; they simply say `Recovery phrase: run vapi backup yourself in
a terminal to see it.`

In the SDK the same line is drawn by the module layout: the functions that
return a phrase or a key live in the separate `@vapi-network/core/secrets` entry
point, which the MCP package is forbidden by lint to import.

### Where the passphrase lives

An unlock looks in three places, in this order:

1. `VAPI_KEYSTORE_PASSWORD`, kept for CI and for Windows.
2. The OS secret store: the macOS Keychain, or libsecret on Linux, under the
   service `vapi-network` and the wallet's name.
3. A prompt, when a person is there to answer it.

```bash
vapi unlock --wallet agent        # store it, once, in your own terminal
vapi wallet list                  # the UNLOCKED column says which agents can pay
vapi lock --all                   # take every stored passphrase back out
```

`vapi unlock` runs only on a real terminal with no agent marker set, and only
after it has verified that the passphrase really opens that wallet. The
passphrase is handed to the OS binary over its standard input, never as a
command-line argument, so it never appears in `ps`. A run that finds no
passphrase anywhere and has no terminal says so and names both other routes; an
agent is never prompted. Windows has no store yet and keeps
`VAPI_KEYSTORE_PASSWORD`.

### The audit log

Every secret export, every wallet change — create, import, remove, restore,
rename, default, caps, passphrase, unlock, lock — and every MCP session wallet
switch appends one JSON line to `$VAPI_HOME/audit.log` (mode 0600): the time,
the event, the wallet, whether a terminal was attached, and which marker was
set. The line never contains the secret itself, so the log answers "did anything
export my phrase while the agent was running" without you having to trust the
agent's own account of it.

## CLI reference

Every command accepts `--json`, which writes one JSON value — success or error —
to stdout. Exit codes are `0` for success, `1` for an operational failure, and
`2` for invalid usage or an announced preview-only command.

| Command                              | Options                                                                                                                                                                                     | What it does                                                                |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `vapi init`                          | `--networks <base,solana>`                                                                                                                                                                  | Creates `~/.vapi`, the wallet `main` and the config. Says so if one exists. |
| `vapi wallet list`                   | —                                                                                                                                                                                           | Name, address, default marker, caps in USD, unlocked, label                 |
| `vapi wallet create <name>`          | `--networks <base,solana>`, `--label <text>`                                                                                                                                                | A new wallet, with its own phrase, caps and passphrase                      |
| `vapi wallet use <name>`             | —                                                                                                                                                                                           | Makes it the default for every later command                                |
| `vapi wallet rename <old> <new>`     | —                                                                                                                                                                                           | Renames the keystore, the registry entry and that wallet's receipts         |
| `vapi wallet remove <name>`          | `--force`                                                                                                                                                                                   | Moves the keystore to `wallets/.trash/`; asks you to type the name          |
| `vapi wallet restore <name>`         | —                                                                                                                                                                                           | Brings a removed wallet back, same passphrase                               |
| `vapi wallet caps <name>`            | `--per-call <usd>`, `--per-day <usd>`                                                                                                                                                       | Sets that wallet's spend caps, in US dollars                                |
| `vapi fund`                          | `--amount <usd>`, `--wallet <name>`                                                                                                                                                         | Prints and opens the hosted funding page. Makes no network call.            |
| `vapi accounts`                      | `--enable solana`, `--wallet <name>`                                                                                                                                                        | One deposit account per configured network, with balances and guidance      |
| `vapi search [query]`                | `--kind <kind>` (repeatable), `--network <caip2>`, `--limit <n>`, `--cursor <cursor>`, `--include-unverified`                                                                               | Merged discovery across every configured source, tagged by group and tier   |
| `vapi inspect <id>`                  | `--endpoint <name>`                                                                                                                                                                         | Verification, fee, liveness, conformance, contract and live quote, for free |
| `vapi pay <id-or-url>`               | `--method`, `--endpoint`, `--body <json>`, `--content-type`, `--network <caip2>`, `--expected-pay-to`, `--max <usd>`, `--wallet <name>`                                                     | Calls the API and pays it from the local wallet, naming an unverified tier  |
| `vapi pay --resume <receipt-id>`     | —                                                                                                                                                                                           | After a lost response: did that payment settle? Reads the chain, never pays |
| `vapi balance`                       | `--wallet <name>`                                                                                                                                                                           | The wallet's address and USDC balances                                      |
| `vapi receipts`                      | `--limit <n>`, `--wallet <name>`, `--all-wallets`                                                                                                                                           | The local append-only call ledger, newest last                              |
| `vapi receipts export`               | `--format <json\|csv>`, `--range <24h\|7d\|30d>`, `--wallet <name>`, `--all-wallets`                                                                                                        | Raw receipts for a spreadsheet or dashboard                                 |
| `vapi stats`                         | `--range <24h\|7d\|30d>`, `--wallet <name>`, `--all-wallets`                                                                                                                                | Spend, outcomes, latency percentiles and top services                       |
| `vapi sweep <address>`               | `--network <caip2>`, `--wallet <name>`                                                                                                                                                      | Moves the USDC balance out to an address you own                            |
| `vapi export-key`                    | `--network <caip2>`, `--wallet <name>`                                                                                                                                                      | Prints the private key. Terminal only, never for an agent.                  |
| `vapi backup`                        | `--wallet <name>`                                                                                                                                                                           | Prints the 12 words. Terminal only, never for an agent.                     |
| `vapi import`                        | `--phrase` or `--key`, `--wallet <name>`, `--networks <base,solana>`, `--replace`, `--force`                                                                                                | Restores a wallet from a prompt, never from argv                            |
| `vapi passphrase`                    | `--wallet <name>`                                                                                                                                                                           | Re-encrypts the keystore under a new passphrase                             |
| `vapi unlock`                        | `--wallet <name>`                                                                                                                                                                           | Puts that wallet's passphrase in the OS secret store                        |
| `vapi lock`                          | `--wallet <name>`, `--all`                                                                                                                                                                  | Takes a stored passphrase back out                                          |
| `vapi report "<what>"`               | `--include-addresses`, `--send`                                                                                                                                                             | Writes a privacy-preserving local bug report                                |
| `vapi auth set-key`                  | —                                                                                                                                                                                           | Types the registry API key on a prompt into the OS secret store             |
| `vapi auth status`                   | —                                                                                                                                                                                           | Whether this machine has a key and where it comes from, masked              |
| `vapi auth clear`                    | —                                                                                                                                                                                           | Takes the stored key back out                                               |
| `vapi publish <url>`                 | `--method`, `--mode <origin\|endpoint\|openapi>`, `--name <text>`, `--description <text>`, `--category <ai\|data\|crypto\|compute\|search>`, `--select <names>`, `--wallet <name>`, `--yes` | Probes your API, lists the endpoints you pick, signs the payout wallet      |
| `vapi publish activate <slug>`       | —                                                                                                                                                                                           | Takes a listing live once its FeeSplitter is deployed                       |
| `vapi publish verify-request <slug>` | —                                                                                                                                                                                           | Asks vAPI to review the listing                                             |
| `vapi publish list`                  | —                                                                                                                                                                                           | Every listing this API key owns                                             |
| `vapi mcp`                           | `--wallet <name>`                                                                                                                                                                           | Serves the MCP tools over stdio                                             |
| `vapi serve`                         | —                                                                                                                                                                                           | Preview only; exits `2` with a message                                      |
| `vapi version`                       | —                                                                                                                                                                                           | The client version, also as `--version` or `-v`                             |
| `vapi help`                          | —                                                                                                                                                                                           | The same help bare `vapi` shows, also as `--help` or `-h`                   |

`vapi pay` also accepts `--max-price-usd` as a long-standing alias for `--max`;
the two cannot be combined. When a paid call loses its response, `vapi pay` refuses to guess
and names its receipt: `vapi pay --resume <receipt-id>` asks the token contract
on that receipt's network, with EIP-3009 `authorizationState(authorizer,
nonce)`, whether the signed authorization was used. **Settled** means the
payment went through — do not pay again. **Expired** means it was never used
and the chain is past its `validBefore`, so it never can be — paying again is
safe. **Pending** means it is unused but still valid — wait until the time it
prints. It unlocks no wallet and signs nothing. EVM only for now; a Solana
receipt says so, and a receipt written before 0.4.0 does not record the nonce. `mcp --json` is accepted as a no-op, because the
stdio transport is already JSON-RPC.

## Publish an API

Listing on vAPI is permissionless. vAPI probes the URL you hand it; if it
answers x402, the listing exists, and you decide when it goes live.

```bash
vapi auth set-key                        # paste the key from the console, once
vapi publish https://weather.example     # probe, pick endpoints, sign the payout wallet
vapi publish activate weather-call       # once the FeeSplitter is deployed
vapi publish verify-request weather-call # ask for the review that ends the [unverified] tag
vapi publish list
```

`vapi publish` takes an origin, a single endpoint, or an OpenAPI document, plus
`--mode` when the registry should not have to guess which. It prints every
probe step; on a refusal it prints the code, the reason and the hint, and exits
`2` without signing anything. On a terminal it asks which endpoints to list — a
script names them with `--select forecast,alerts`, or takes all of them with
`--yes`, and then has to supply `--name`, `--description` and `--category`
itself.

Your wallet signs one line, `Confirm this wallet receives vAPI Call payouts`,
so the registry knows where the money goes. It is an EIP-4361 message bound to
the registry's own host and to Base: nothing is paid, nothing is approved, and
no key leaves the machine.

Payouts arrive through a FeeSplitter you own. Deploying it is a wallet
transaction against the factory, so it stays in the console at
`<registry>/providers`; `vapi publish` prints the address it will have on each
network and the exact next step. An active listing answers
`vapi search --include-unverified`, and `vapi publish verify-request <slug>`
asks for the review that puts it in the default search.

The API key is a secret like any other here. `vapi auth set-key` reads it from
a prompt, never from an argument, and keeps it in the same OS secret store as
your passphrase — or in `~/.vapi/config.json` at mode 0600 on a platform that
has none. `VAPI_API_KEY` is the route for CI. No agent can reach it: there is
no publish tool on the MCP server, and the key lives behind its own package
entry point that `packages/mcp` is forbidden to import.

## MCP

Add this to Claude Code, Claude Desktop or Cursor:

```json
{
  "mcpServers": {
    "vapi": {
      "command": "npx",
      "args": ["-y", "vapi-network", "mcp"]
    }
  }
}
```

Then hand the passphrase to your operating system once, in your own terminal:

```bash
vapi unlock            # the passphrase goes into the macOS Keychain or libsecret
```

The passphrase never leaves the machine and never has to appear in an editor's
configuration file. `vapi lock` takes it back out. On Windows, until there is a
Credential Manager path, keep using
`"env": { "VAPI_KEYSTORE_PASSWORD": "your-passphrase" }` instead.

Give an agent its own capped wallet by creating it yourself and pinning the
agent to it:

```bash
vapi wallet create agent-claude --label "claude code"
vapi wallet caps agent-claude --per-day 5
vapi unlock --wallet agent-claude
```

```json
{
  "mcpServers": {
    "vapi": {
      "command": "npx",
      "args": ["-y", "vapi-network", "mcp", "--wallet", "agent-claude"],
      "env": {
        "VAPI_WALLET": "agent-claude",
        "VAPI_NO_SECRETS": "1"
      }
    }
  }
}
```

The agent pays from `agent-claude` and no more than $5 a day, whatever it asks
for; your own wallet is not reachable from that session, because only
`agent-claude` was unlocked. `vapi wallet list` shows which wallets are unlocked
that way.

### Tools

| Tool              | Input                                                                                                           | Result                                                                                                                              |
| ----------------- | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `call.search`     | `query`, `kinds[]`, `network`, `limit`, `cursor`, `includeUnverified`                                           | One discovery page: `items` with `group`, `fee` and `verification`, plus `nextCursor`, `unavailableKinds`, `rankingVersion`         |
| `call.inspect`    | `id`, `endpoint`                                                                                                | A listing's `verification`, `fee`, `liveness`, `conformance`, request contract and live quote, for free                             |
| `call.pay`        | `wallet`, `id` or `url`, `method`, `endpoint`, `body`, `contentType`, `network`, `expectedPayTo`, `maxPriceUsd` | `wallet`, `status`, `body`, `payment`, `verification` for a registry listing, and `expectedRequest` when a 402 named one            |
| `wallet.address`  | `wallet`                                                                                                        | `wallet`, `address`                                                                                                                 |
| `wallet.balance`  | `wallet`                                                                                                        | `wallet`, `address`, `balances[]` per configured network                                                                            |
| `wallet.accounts` | `wallet`                                                                                                        | `wallet`, `accounts[]` with USDC, gas balance and deposit guidance                                                                  |
| `wallet.list`     | —                                                                                                               | `wallet`, `default`, and every wallet with caps in atomic USDC and dollars, balances, and `balanceError` when an RPC is unreachable |
| `wallet.use`      | `name`                                                                                                          | `wallet`, `active`, `previous`, `scope: "session"`                                                                                  |
| `wallet.fund`     | `wallet`, `amountUsd`                                                                                           | `wallet`, `address`, `network`, `url`, `instructions`                                                                               |
| `receipts.list`   | `wallet`, `allWallets`, `limit`                                                                                 | `wallet`, `receipts[]`                                                                                                              |
| `receipts.stats`  | `wallet`, `allWallets`, `range`                                                                                 | `wallet`, `range`, `generatedAt`, `totals`, `outcomes`, `latency`, `topServices`, `search`                                          |
| `support.report`  | `message`, `includeAddresses`, `send`                                                                           | `path`, `issueUrl`, the report itself, and `responseCode` when sent                                                                 |

`wallet` is optional on every tool that takes it: without it the session's
active wallet is used, then `VAPI_WALLET`, then the machine default. Every
result names the wallet it used. `call.pay` applies that wallet's own spend caps
before it signs and tags the receipt with its name. When a paid call's outcome
is uncertain, `call.pay` fails with `settlement_unknown`, says not to retry
automatically, and names the `vapi pay --resume <receipt-id>` that settles the
question on-chain. `wallet.use` moves the
session onto another wallet **for this process only** — it never rewrites
`wallets.json`, so your own terminal keeps the default you chose — and appends a
`wallet.use.session` line to the audit log. Reads need no passphrase at all.

Spend caps default to $0.10 per call and $1.00 per day.

`call.search` returns vAPI-verified listings plus mirrored external catalogs;
`includeUnverified: true` adds unverified self-listed APIs, which passed vAPI's
automated x402 probe but were not reviewed. Every result of `call.search`,
`call.inspect` and `call.pay` carries `verification`, one of `"none"`,
`"requested"` or `"verified"` — a mirrored external row is always `"none"`.
Prefer a verified listing, and read the request contract and the price with
`call.inspect` before paying one that is not.

#### Deprecated tool aliases

These four pre-namespace names still work and still behave identically, but each
result carries one `DEPRECATED:` line naming its replacement. They will be
removed in a later release.

| Alias     | Use instead      |
| --------- | ---------------- |
| `search`  | `call.search`    |
| `inspect` | `call.inspect`   |
| `call`    | `call.pay`       |
| `wallet`  | `wallet.balance` |

#### What the MCP server cannot do

Create, rename, remove, restore, back up, import or export a wallet, or return a
recovery phrase, a private key or a passphrase. Those stay in the CLI, in front
of a person.

## SDK

```bash
npm i @vapi-network/core @vapi-network/sources
```

`@vapi-network/core` is the main entry point: the x402 protocol, the wallet
store, spend policy, the network guard, discovery merge and the receipt ledger.
`@vapi-network/core/secrets` is a second, deliberately separate entry point for
the four functions that return a recovery phrase or a private key —
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

Two runnable examples live in [`examples/`](./examples):
[`pay-with-sdk.ts`](./examples/pay-with-sdk.ts) (`pnpm example:pay -- weather`)
and [`wallets.ts`](./examples/wallets.ts) (`pnpm example:wallets -- agent-demo`).

## Configuration

Local state lives in `~/.vapi/`:

```text
config.json           registry URLs, networks and RPC endpoints
wallets.json          which wallet is the default, plus per-wallet caps and labels
wallets/
  main.json           one encrypted keystore per wallet, mode 0600
  .trash/             removed wallets, kept encrypted, never deleted for you
keystore.json         a 0600 symlink to wallets/main.json, for one release
audit.log             one JSON line per secret export or wallet change
receipts.jsonl        the append-only call ledger
searches.jsonl        one line per discovery query
spend-ledger.json     today's total, per wallet
reports/              what vapi report writes
```

| Variable                 | What it does                                                                |
| ------------------------ | --------------------------------------------------------------------------- |
| `VAPI_HOME`              | Use a different directory instead of `~/.vapi`                              |
| `VAPI_WALLET`            | The wallet to use when no `--wallet` is given                               |
| `VAPI_REGISTRY_URL`      | Replace the registry base; the canonical discovery paths derive from it     |
| `VAPI_KEYSTORE_PASSWORD` | The passphrase, for CI and for Windows. Checked before the OS secret store. |
| `VAPI_API_KEY`           | The registry key `vapi publish` authenticates with, for CI                  |
| `VAPI_NO_SECRETS`        | Set to `1` to stop `vapi backup` and `vapi export-key` printing anything    |

`ARC_TESTNET_RPC_URL` and `SOLANA_RPC_URL` point those two networks at an
endpoint you trust. On first use of the default home, the client copies an
existing `~/.vapi/agent-cash/` configuration into `~/.vapi/` when it can do so
without overwriting files, prints a notice, and leaves the old directory alone.

## Funding

```bash
vapi fund                 # open the funding page for your address
vapi fund --amount 25     # prefill a US dollar amount
vapi fund --json          # { address, network, url }
```

`vapi fund` prints `<registry>/fund/<your-address>` and opens it in your default
browser when you are on a terminal. The page offers three routes: a card via
Coinbase (needs a Coinbase account; US guest checkout), a transfer from
MetaMask, Coinbase Wallet or WalletConnect, or a bridge from another chain. It
is public, takes no sign-in, and mints the card session when you click — so the
link keeps working while you log in, and nothing expires in your scrollback.

The command itself makes **no network call**: it works offline, and it always
also prints

```text
Send USDC on Base (eip155:8453) to this address; add a little ETH for gas if you plan to sweep.
```

Whichever route you pick, the USDC lands on your local address on Base. **vAPI
never holds your funds**, never proxies the payment, and never sees your card
details or your private key. MCP clients use `wallet.fund`, which returns the
same `{ address, network, url }` plus a line telling the agent to hand the link
to its human.

## Networks and accounts

| Network        | x402 identifier                                       | USDC                                           | Gas / RPC notes                                        |
| -------------- | ----------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------ |
| Base mainnet   | `eip155:8453`                                         | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`   | ETH; defaults to `https://mainnet.base.org`            |
| Arc testnet    | `eip155:5042002`                                      | `0x3600000000000000000000000000000000000000`   | USDC is also the gas token; set `ARC_TESTNET_RPC_URL`  |
| Solana mainnet | `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d` | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` | SOL; defaults to `https://api.mainnet-beta.solana.com` |

The x402 reference packages shorten the Solana CAIP-2 reference to
`solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`; vAPI accepts that identifier as an
alias while persisting the full genesis hash above. Arc mainnet is **not yet — a
placeholder only**: Arc and the x402 packages publish no mainnet RPC plus
canonical USDC, so the client carries a non-routable placeholder rather than
guessing a production configuration.

`vapi accounts` lists one deposit account per configured network: its CAIP-2 ID,
network name, address, atomic and formatted USDC balance, gas-token balance, and
deposit guidance. Account lookup dispatches by CAIP namespace, so the EVM and
Solana adapters stay independent of one another. For Arc testnet, add the faucet
to that network's `config.json` entry:

```json
{
  "depositUrl": "https://your-arc-faucet.example",
  "depositInstructions": "Use the configured Arc testnet faucet, then send USDC to this address."
}
```

Create both local accounts at initialization with `vapi init --networks
base,solana`, or add an Ed25519 account to an existing keystore with `vapi
accounts --enable solana`. Fund the printed Solana address with SPL USDC. Exact
x402 payments use the facilitator advertised in the challenge as fee payer, so
they do not consume the local SOL balance; `vapi sweep` is a separate
transaction and does need a little SOL. The default public Solana RPC is
rate-limited and has no availability guarantee; set `SOLANA_RPC_URL` to a
dedicated endpoint for regular use.

## Discovery sources

Discovery is a plugin interface. The client merges listings from several
sources, de-duplicates them by normalized resource URL, and keeps each listing's
provenance:

- **vAPI Registry**, enabled by the default distribution, using
  `https://api.vapinetwork.ai/api/call/discovery` and
  `https://api.vapinetwork.ai/api/call/services`. If the primary returns HTTP
  404 or cannot be resolved, the client logs one notice and tries the hosts in
  `registryFallbacks` on the same canonical paths. The historical
  `/api/marketplace/discovery` and `/api/network/services` paths are deprecated;
  a base URL supplied on either is normalized to the canonical pair.
- **Coinbase Bazaar**, the public x402 v2 `/discovery/resources` catalogue
  exposed by a facilitator.
- **Local file**, a JSON array of listings for private or development
  catalogues.
- **x402scan**, a deliberate stub until x402scan documents a stable public read
  API this client can safely target.

Use `@vapi-network/sources` to compose only the catalogues you trust. Every
outbound request is guarded against local and private destinations before it is
made, and redirects and resolved IP addresses are re-validated as new
destinations.

## Sign-in with X

x402 v2 services can require Sign-In-With-X (SIWX) before returning a price.
When `vapi pay` or `call.pay` receives that challenge, vAPI checks that both the
challenge domain and URI match the final resource origin, signs the canonical
EIP-4361 message locally with EVM `personal_sign`, and retries once with
`SIGN-IN-WITH-X`. The proof is never sent to a redirect or a different host.

If the retry returns a normal 402 quote, the usual spend-policy and payment flow
continues. If the resource is free after sign-in, the result has
`outcome: "signed_in"` and the local receipt records `amountAtomic: "0"`.

## Metrics and bug reports

vAPI measures call and discovery health locally and uploads nothing. Receipts
can include the listing name and provider host, policy decision, retry count,
client version, outcome, total latency, and discovery, quote, signing, request
and settlement phase timings. Policy declines are recorded with the quoted
amount but without a payer or transaction, so blocked spend stays visible
without creating a payment authorization. Search events record the query,
sources tried, per-source latency and result count, merged result count and
timestamp.

```sh
vapi stats --range 7d
vapi receipts export --format csv --range 30d
```

`vapi report "<what happened>"` writes `$VAPI_HOME/reports/<timestamp>.json` and
prints that path plus a prefilled GitHub issue URL. Reports contain the message,
client version, OS and Node information, and only the newest five receipt IDs.
Wallet and payee addresses are included only with `--include-addresses`; amounts
never are. Nothing is uploaded unless `--send` is explicit.

## Packages

| Package                 | Purpose                                                                 |
| ----------------------- | ----------------------------------------------------------------------- |
| `vapi-network`          | zero-dependency distribution with the `vapi` binary and defaults        |
| `@vapi-network/core`    | x402 protocol, wallet store, spend policy, discovery merge and receipts |
| `@vapi-network/sources` | vAPI Registry, Coinbase Bazaar, local-file and x402scan source adapters |
| `@vapi-network/mcp`     | stdio MCP server with namespaced payment tools                          |
| `@vapi-network/cli`     | command parsing and the command implementations behind `vapi`           |

Every npm tarball is bundled and has zero runtime dependencies. The scoped
packages are useful for embedding; most users should start with `vapi-network`.

## Roadmap

- A local gateway daemon (`vapi serve`) with per-key budgets
- OpenTelemetry traces and metrics, with exporters enabled only by the user
- `task.*` tools for posting, funding, delivering and reviewing work
- `compute.*` tools for discovering models and paying for inference

Until the gateway lands, `vapi serve` and the provider-side `vapi publish` exit
with a preview message. Payments stay direct from the local wallet to each
service.

## Development

A pnpm workspace for Node.js 22 and pnpm 10. The gate, in order:

```sh
pnpm install
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm pack:check
```

All five packages share one version and are released together. npm reads a
package manifest before lifecycle hooks run, so the release is made from the
generated `publish/` directories, never from the workspace package roots.

```sh
pnpm install --frozen-lockfile
pnpm pack:check
npm login
pnpm --dir packages/core publish:npm
pnpm --dir packages/sources publish:npm
pnpm --dir packages/mcp publish:npm
pnpm --dir packages/cli publish:npm
pnpm --dir packages/vapi-network publish:npm
```

`publish:npm` publishes a package's staged `./publish` directory to the `latest`
npm tag; `publish:npm:next` publishes the same tarball to `next`. The manual
release workflow verifies artifacts and prints these commands; it never receives
npm credentials and never publishes.

See [AGENTS.md](./AGENTS.md) for layout and invariants,
[CONTRIBUTING.md](./CONTRIBUTING.md) for the workflow,
[CHANGELOG.md](./CHANGELOG.md) for what shipped in each release, and
[SECURITY.md](./SECURITY.md) for private vulnerability reports.

## License

Apache-2.0. See [LICENSE](./LICENSE).
