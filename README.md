# vAPI Network

**One wallet, every x402 API.** vAPI Network is an open-source, non-custodial
TypeScript toolkit for discovering and paying x402 services from a CLI, MCP
client, or your own code. Call works today. Tasks and Compute are next.

Your key stays encrypted on your machine. vAPI Network applies spend policy
before signing, sends payment directly to the service, and writes receipts to a
local append-only ledger. It does not hold funds, proxy payments, or send
telemetry off the machine by default.

## 60-second quickstart

Install once, then every command is `vapi …`:

```bash
npm i -g vapi-network
vapi init                      # encrypted wallet + config under ~/.vapi (or $VAPI_HOME), prints the address
```

Fund that address with `vapi fund`, which opens the funding page: card via
Coinbase (needs a Coinbase account; US guest checkout), send from
MetaMask/Coinbase Wallet/WalletConnect, or bridge from another chain. Or send
USDC on Base to the address yourself. Then:

```bash
vapi fund                      # opens the hosted funding page for your address
vapi search "weather"          # every catalog, merged, with provenance
vapi inspect <listing-ref>     # request contract and the live 402 quote, before paying
vapi pay <listing-ref> --max 0.02
vapi balance
vapi accounts                   # balances plus network-specific deposit guidance
vapi receipts                  # one line per paid call: quote, settlement, latency
vapi backup                    # print the 12-word recovery phrase, on a terminal only
vapi export-key                # print the private key for this wallet, on a terminal only
vapi wallet list               # every wallet on this machine, with caps and the default
```

`vapi search` tags each listing with its group — `[vapi]`, `[added]`,
`[partner]`, or `[external]` — and prints the network fee already inside the
price: vAPI and added APIs carry a 5% network fee inside the quoted price, while
partner and external listings carry none. `vapi inspect` and `--json` return the
same `group` and `fee` fields.

No install? Prefix any command with `npx vapi-network`, for example `npx vapi-network init`.
(`npx vapi` cannot work: the bare `vapi` name on npm belongs to an unrelated package.)

### Use it from an agent (MCP)

Add this to Claude Desktop, Claude Code, or Cursor. The passphrase unlocks the local keystore; it never leaves the machine.

```json
{
  "mcpServers": {
    "vapi": {
      "command": "npx",
      "args": ["-y", "vapi-network", "mcp"],
      "env": { "VAPI_KEYSTORE_PASSWORD": "your-passphrase" }
    }
  }
}
```

Tools: `call.search`, `call.inspect`, `call.pay`, `wallet.list`, `wallet.use`, `wallet.address`,
`wallet.balance`, `wallet.accounts`, `wallet.fund`, `receipts.list`, `receipts.stats`,
`support.report`. Spend caps default to $0.10 per call and $1.00 per day; the wallet checks both
before it signs a payment.

`wallet.list` shows every wallet on the machine — address, label, spend caps in US dollars, USDC
balances, which one is the default and which one this session is paying from. `wallet.use <name>`
moves the session onto another wallet **for this process only**: it never rewrites `wallets.json`,
so your own terminal keeps the default you chose. `wallet.address`, `wallet.balance`,
`wallet.accounts`, `wallet.fund`, `call.pay`, `receipts.list` and `receipts.stats` all take an
optional `wallet` argument; without it the session's active wallet is used, then `VAPI_WALLET`,
then the default. Every result names the wallet it used. `receipts.list` and `receipts.stats` also
take `allWallets: true`.

What the MCP server cannot do: create, rename, remove, restore, back up, import or export a
wallet, or return a recovery phrase, a private key or a passphrase — those stay in the CLI, in
front of a person.

Give an agent its own capped wallet by creating it yourself and pinning the agent to it with
`VAPI_WALLET`:

```bash
vapi wallet create agent-claude --label "claude code"
vapi wallet caps agent-claude --per-day 5
```

```json
{
  "mcpServers": {
    "vapi": {
      "command": "npx",
      "args": ["-y", "vapi-network", "mcp", "--wallet", "agent-claude"],
      "env": {
        "VAPI_WALLET": "agent-claude",
        "VAPI_KEYSTORE_PASSWORD": "your-passphrase",
        "VAPI_NO_SECRETS": "1"
      }
    }
  }
}
```

The agent pays from `agent-claude` and no more than $5 a day, whatever it asks for; your own
wallet is not reachable from that session unless you gave the agent its passphrase too.

## Wallets

One machine can hold several wallets: your own, and a capped one per agent. The
keystores live in `$VAPI_HOME/wallets/<name>.json`; `$VAPI_HOME/wallets.json`
records which one is the default, what each may spend, and its label. Names are
1 to 32 characters of lowercase letters, digits and dashes.

| Command                                             | What it does                                                       |
| --------------------------------------------------- | ------------------------------------------------------------------ |
| `vapi wallet list [--json]`                         | Name, address, default marker, caps in USD, label                  |
| `vapi wallet create <name> [--label <text>]`        | A new wallet, with its own phrase, caps and passphrase             |
| `vapi wallet use <name>`                            | Makes it the default for every later command                       |
| `vapi wallet rename <old> <new>`                    | Renames the keystore, the registry entry and the wallet's receipts |
| `vapi wallet remove <name> [--force]`               | Moves the keystore to `wallets/.trash/`; asks you to type the name |
| `vapi wallet restore <name>`                        | Brings a removed wallet back, same passphrase                      |
| `vapi wallet caps <name> [--per-call \| --per-day]` | Sets the spend caps of that wallet, in US dollars                  |

Every command that touches a wallet takes `--wallet <name>`: `balance`,
`accounts`, `fund`, `pay`, `sweep`, `receipts`, `stats`, `export-key`, `backup`,
`import`, `passphrase`, `mcp`. Without it, `VAPI_WALLET` decides, and without
that, the default does. Each of them names the wallet it used — `Wallet: main
(0x…)` on the first line, or a `wallet` field in `--json` — so neither you nor
an agent can be wrong about which key just moved.

```bash
vapi wallet create agent --label "claude code"   # a wallet of its own for the agent
vapi wallet caps agent --per-call 0.05 --per-day 1
vapi pay <listing-ref> --wallet agent --max 0.02
vapi receipts --wallet agent                     # or --all-wallets for every one
```

Spend caps belong to the wallet, not to the machine, and today's total is
counted per wallet: an agent cannot spend your daily allowance.

## Your wallet is yours

`vapi init` generates a 12-word BIP-39 recovery phrase on your machine, derives
the Base account (`m/44'/60'/0'/0/0`) and, with `--networks base,solana`, the
Solana account (`m/44'/501'/0'/0'`) from it, and writes the phrase encrypted
under your passphrase to `$VAPI_HOME/keystore.json` (`~/.vapi/keystore.json` by
default, mode 0600). The phrase is shown once, on a terminal, and never in
`--json` or piped output.

Three things vAPI cannot do:

- **See it.** No key, phrase, or passphrase ever leaves the machine.
- **Recover it.** There is no copy anywhere to restore from.
- **Freeze it.** Payments go straight from your wallet to the service.

Back it up:

```bash
vapi backup            # the 12 words, numbered, on a terminal
vapi backup --json     # { "wallet": "main", "recoveryPhrase": "..." }
```

Write the words on paper and keep them somewhere only you reach. Anyone holding
them can spend the wallet, so never type them into a website or a chat.

Restore on another machine, or move the wallet to a new one:

```bash
vapi import --phrase                        # type the words at the prompt
vapi import --phrase --networks base,solana # restore both accounts
vapi import --key                           # a 0x private key instead of words
```

`vapi import` reads the secret from a prompt, never from the command line, and
asks for a new passphrase. If this machine already has a wallet it refuses to
touch it: pass `--replace` to move the old `keystore.json` aside to
`keystore.json.bak-<timestamp>` first, which still needs the old passphrase to
open. A `--replace` on a wallet that still holds USDC on Base stops as well;
sweep the funds out first, or accept the loss with `--force`.

Change the passphrase, keeping the same wallet and addresses:

```bash
vapi passphrase        # current passphrase, then the new one twice
```

Wallets created before 0.2.5 have no recovery phrase. `vapi backup` says so and
points at `vapi export-key`, which prints the private key itself; back that key
up, or `vapi import --key` it into a new wallet. Restoring a phrase-based
wallet in MetaMask, Rabby, Coinbase Wallet or Phantom gives the same addresses.

### Agents and secrets

An agent can drive vAPI all day without ever seeing a secret. It can search,
inspect, pay from the wallet you gave it, read balances and receipts, and pick a
wallet by name with `wallet.use` — which changes only that session, never your
default on disk. It cannot see a recovery phrase, a private key or a passphrase,
and the MCP server has no tool that creates, removes, renames, backs up or
exports a wallet. Switching the session's wallet appends a `wallet.use.session`
line to the audit log, so the log still answers which wallet paid for what.

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

In the SDK the same line is drawn by the module layout: `exportRecoveryPhrase`,
`exportKeystoreKeys` and `createKeystoreWithPhrase` live in the separate
`@vapi-network/core/secrets` entry point, which the MCP package is forbidden to
import. `@vapi-network/core` itself returns accounts, never phrases or keys.

Every secret export and every wallet change — create, import, remove, restore,
rename, default, caps, passphrase — and every MCP session wallet switch appends
one JSON line to
`$VAPI_HOME/audit.log` (mode 0600): the time, the event, the wallet, whether a
terminal was attached, and which marker was set. The line never contains the
secret itself, so the log answers "did anything export my phrase while the agent
was running" without you having to trust the agent's own account of it.

## Sign-in with X

x402 v2 services can require Sign-In-With-X (SIWX) before returning a price. When `call.pay` or
`vapi pay` receives that challenge, vAPI checks that both the challenge domain and URI match the
final resource origin, signs the canonical EIP-4361 message locally with EVM `personal_sign`, and
retries once with `SIGN-IN-WITH-X`. The proof is never sent to a redirect or a different host.

If the retry returns a normal 402 quote, the usual spend-policy and payment flow continues. If the
resource is free after sign-in, the result has `outcome: "signed_in"` and the local receipt records
`amountAtomic: "0"`.

## Fund the wallet

```bash
vapi fund                 # open the funding page for your address
vapi fund --amount 25     # prefill a US dollar amount
vapi fund --json          # { address, network, url }
```

`vapi fund` prints `<registry>/fund/<your-address>` and opens it in your default
browser when you are on a terminal. Opens the funding page: card via Coinbase
(needs a Coinbase account; US guest checkout), send from MetaMask/Coinbase
Wallet/WalletConnect, or bridge from another chain. The page is public, takes no
sign-in, and mints the card session when you click — so the link keeps working
while you log in, and nothing expires in your scrollback.

The command itself makes **no network call**: it works offline, and it always
also prints

```text
Send USDC on Base (eip155:8453) to this address; add a little ETH for gas if you plan to sweep.
```

Whichever route you pick, the USDC lands on your local address on Base. **vAPI
never holds your funds**, never proxies the payment, and never sees your card
details or your private key. MCP clients can use the `wallet.fund` tool, which
returns the same `{ address, network, url }` plus a line telling the agent to
hand the link to its human.

## Accounts and deposits

`vapi accounts` lists one deposit account for every configured network, including its CAIP-2 ID,
network name, address, atomic and formatted USDC balance, gas-token balance, and deposit guidance.
Use `--json` for the stable `{ "accounts": [...] }` shape. `vapi init` prints the same account list
after creating the encrypted keystore and configuration. MCP clients can use `wallet.accounts`.

Base uses the wallet's EVM address and tells you to send USDC on Base. For Arc testnet, add the
faucet URL or instructions to that network's `config.json` entry:

```json
{
  "depositUrl": "https://your-arc-faucet.example",
  "depositInstructions": "Use the configured Arc testnet faucet, then send USDC to this address."
}
```

Account lookup dispatches by CAIP namespace: the EVM and Solana adapters use their corresponding
local address and guarded RPC balance calls without coupling one wallet family to the other.

## Exporting the key

The wallet is yours, so the key can leave on demand:

```bash
vapi export-key                       # EVM key (eip155:8453) as 0x-prefixed hex
vapi export-key --network solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d
vapi export-key --json                # { "network", "address", "privateKey" }
```

The command asks for the keystore passphrase, prints a one-line warning on
stderr, and writes the key alone on stdout so it can be piped into a password
manager. Anyone holding that key can spend the wallet: never paste it into a
website or a chat. Nothing else in vAPI ever logs it.

## Reporting a bug

```bash
vapi report "the provider returned 402 twice"
vapi report "the provider returned 402 twice" --include-addresses
vapi report "the provider returned 402 twice" --send
```

The command first writes `$VAPI_HOME/reports/<timestamp>.json`, then prints that path and a prefilled
GitHub issue URL. Reports contain the message, client version, OS/Node information, and only the
newest five receipt IDs. Wallet and payee addresses are included only with `--include-addresses`;
amounts are never included. No report is uploaded unless `--send` is explicit. With `--send`, vAPI
uses the guarded network client to POST the same JSON to the configured registry and prints the HTTP
response code, including non-success responses such as 404. MCP clients can use `support.report`
with the corresponding `includeAddresses` and `send` booleans.

## Networks

| Network        | x402 identifier                                       | USDC                                           | Gas / RPC notes                                        |
| -------------- | ----------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------ |
| Base mainnet   | `eip155:8453`                                         | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`   | ETH; defaults to `https://mainnet.base.org`            |
| Arc testnet    | `eip155:5042002`                                      | `0x3600000000000000000000000000000000000000`   | USDC is also the gas token; set `ARC_TESTNET_RPC_URL`  |
| Solana mainnet | `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d` | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` | SOL; defaults to `https://api.mainnet-beta.solana.com` |

The x402 reference packages shorten the Solana CAIP-2 reference to
`solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`; vAPI accepts that identifier as an
alias while persisting the full genesis hash above. Arc mainnet is not enabled:
**not yet — placeholder only.** Arc and the x402 packages do not publish a
mainnet RPC plus canonical USDC, so the client deliberately carries only a
non-routable code placeholder instead of guessing a production configuration.

Create both local accounts during initialization:

```bash
vapi init --networks base,solana
```

Or add an Ed25519 account to an existing encrypted keystore:

```bash
vapi accounts --enable solana
```

Fund the printed Solana address with SPL USDC. Exact x402 payments use the
facilitator advertised in the challenge as fee payer, so they do not consume the
local SOL balance. `vapi sweep <solana-address> --network
solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d` is a separate transaction
and requires a small amount of SOL locally for fees and, when necessary,
creation of the destination token account. The default public Solana RPC is
rate-limited and has no availability guarantee; set `SOLANA_RPC_URL` to a
trusted dedicated endpoint for regular use.

## Discovery sources

Discovery is a plugin interface. The client can merge listings from multiple
sources, de-duplicate them by resource URL, and retain each listing's
provenance:

- **vAPI Registry** is enabled by the default distribution, using
  `https://api.vapinetwork.ai/api/call/discovery` for discovery and
  `https://api.vapinetwork.ai/api/call/services` for service details. If the
  primary returns HTTP 404 or cannot be resolved, the client logs one notice
  and tries the fallbacks in `registryFallbacks`, using the same canonical
  paths; the default distribution no longer ships a distinct fallback host,
  because the `console.vapinetwork.ai` and `console-staging.vapinetwork.ai`
  hosts are retired. A `config.json` that still names them is repaired in
  memory on load and rewritten on disk by `vapi init`. The registry's historical `/api/marketplace/discovery`
  and `/api/network/services` paths still answer for one release and reply with
  `Deprecation: true` plus a `Link` header naming the successor; a base URL
  supplied on either of them is normalized to the canonical pair.
- **Coinbase Bazaar** reads the public x402 v2
  `/discovery/resources` catalog exposed by a facilitator.
- **Local file** reads a JSON array of listings for private or development
  catalogs.
- **x402scan** is a deliberate stub for now. The source research documents its
  discovery convention, but not a stable public read API that this client can
  safely target.

Use `@vapi-network/sources` to compose only the catalogs you trust. Network
access is guarded against local and private destinations before a request is
made.

Set `VAPI_REGISTRY_URL` to replace the registry base; the client derives
`/api/call/discovery` and `/api/call/services` beneath it. The existing
`VAPI_MARKETPLACE_DISCOVERY_URL` and `VAPI_DISCOVERY_URL` variables can still
override either full endpoint separately. Registry fallbacks are stored in
`config.json` under `registryFallbacks`.

## Packages

| Package                 | Purpose                                                                  |
| ----------------------- | ------------------------------------------------------------------------ |
| `@vapi-network/core`    | x402 protocol, wallet store, spend policy, discovery merge, and receipts |
| `@vapi-network/sources` | vAPI Registry, Coinbase Bazaar, local-file, and x402scan source adapters |
| `@vapi-network/mcp`     | stdio MCP server with namespaced payment tools                           |
| `@vapi-network/cli`     | `init`, discovery, payment, wallet, receipt, and MCP commands            |
| `vapi-network`          | zero-dependency distribution with the `vapi` binary and defaults         |

Every npm tarball is bundled and has zero runtime dependencies. The scoped
packages are useful for embedding; most users should start with
`vapi-network`.

## SDK

The core and source packages can be used without the CLI or MCP layer. See the
runnable [SDK example](./examples/pay-with-sdk.ts) for discovery, policy
validation, local signing, and direct x402 payment construction.

Run it after initialization with `pnpm example:pay -- weather`.

## Local state and migration

By default, local state lives in `~/.vapi/`:

```text
config.json
wallets.json          which wallet is the default, plus per-wallet caps and labels
wallets/
  main.json           one encrypted keystore per wallet, mode 0600
  .trash/             removed wallets, kept encrypted, never deleted for you
keystore.json         a 0600 symlink to wallets/main.json, for one release
audit.log             one JSON line per secret export or wallet change
receipts.jsonl
searches.jsonl
spend-ledger.json
reports/
```

A `~/.vapi` from 0.2.x migrates itself once, the first time a command opens the
wallet store: `keystore.json` moves to `wallets/main.json` with its contents
untouched, `config.json`'s spend caps become the caps of `main`, and
`keystore.json` stays behind as a symlink so existing scripts keep working. A
home without a keystore migrates nothing.

Set `VAPI_HOME` to use a different directory. On first use of the default home,
the client copies an existing `~/.vapi/agent-cash/` configuration into
`~/.vapi/` when it can do so without overwriting files, prints a migration
notice, and leaves the old directory untouched.

## Metrics

vAPI measures call and discovery health locally. Call receipts can include the
listing name and provider host, policy decision, retry count, client version,
outcome, total latency, and discovery, quote, signing, request, and settlement
phase timings. Policy declines are recorded with the quoted amount but without
a payer or transaction, so blocked spend remains visible without creating a
payment authorization. Search events record the query, sources tried,
per-source latency and result count, merged result count, and timestamp.

Call receipts are appended to `$VAPI_HOME/receipts.jsonl`; search events are
appended to `$VAPI_HOME/searches.jsonl`. Nothing in either ledger is uploaded,
and vAPI sends no telemetry off the machine by default. The vAPI website can
show public on-chain usage for a wallet address directly from the chain; that
view does not require uploading these local files.

Use `vapi stats --range 24h|7d|30d` for a human-readable summary or add `--json`
for the stable `{ range, generatedAt, totals, outcomes, latency, topServices,
search }` shape. `receipts.stats` exposes the same shape through MCP. Export raw
receipts for spreadsheets and dashboards with:

```sh
vapi receipts export --format json --range 30d
vapi receipts export --format csv --range 30d
```

## Roadmap

- A local gateway daemon (`vapi serve`) with per-key budgets
- OpenTelemetry traces and metrics, with exporters enabled only by the user
- `task.*` tools for posting, funding, delivering, and reviewing work
- `compute.*` tools for discovering models and paying for inference

Until the gateway lands, `vapi serve` and the provider-side `vapi publish`
command exit with a preview message. Payments remain direct from the local
wallet to each service.

## Development

This is a pnpm workspace for Node.js 22 and pnpm 10.

```sh
pnpm install
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm pack:check
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the development workflow,
[CHANGELOG.md](./CHANGELOG.md) for what shipped in each release, and
[SECURITY.md](./SECURITY.md) for private vulnerability reports.

CLI commands exit `0` on success, `1` on an operational failure, and `2` for
invalid usage or an announced preview-only command. `--json` sends both success
values and errors to stdout as one JSON value; `mcp --json` is accepted as a
no-op because the stdio transport is already JSON-RPC.

## Publishing

All five packages share one version and are published together. npm reads a
package manifest before lifecycle hooks run, so the release is made from the
generated `publish/` directories, never from the workspace package roots.

First update every package to the same version and verify the exact tarballs:

```sh
pnpm install --frozen-lockfile
pnpm pack:check
```

After reviewing the output, a maintainer with npm access runs these commands
manually:

```sh
npm login
pnpm --dir packages/core publish:npm
pnpm --dir packages/sources publish:npm
pnpm --dir packages/mcp publish:npm
pnpm --dir packages/cli publish:npm
pnpm --dir packages/vapi-network publish:npm
```

Each package's `publish:npm` script publishes its staged `./publish` directory
to the `latest` npm tag. Every package also has a `publish:npm:next` script that
publishes the same tarball to `next` instead, for preview builds. The manual
release workflow verifies and prints these commands; it never receives npm
credentials or publishes automatically.

## License

Apache-2.0. See [LICENSE](./LICENSE).
