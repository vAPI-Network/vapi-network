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

Fund that address with USDC on Base. Then:

```bash
vapi search "weather"          # every catalog, merged, with provenance
vapi inspect <listing-ref>     # request contract and the live 402 quote, before paying
vapi pay <listing-ref> --max 0.02
vapi balance
vapi accounts                   # balances plus network-specific deposit guidance
vapi receipts                  # one line per paid call: quote, settlement, latency
```

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

Tools: `call.search`, `call.inspect`, `call.pay`, `wallet.address`, `wallet.balance`,
`wallet.accounts`, `receipts.list`, `receipts.stats`, `support.report`. Spend caps default to $0.10
per call and $1.00 per day; the wallet checks both before it signs a payment.

## Sign-in with X

x402 v2 services can require Sign-In-With-X (SIWX) before returning a price. When `call.pay` or
`vapi pay` receives that challenge, vAPI checks that both the challenge domain and URI match the
final resource origin, signs the canonical EIP-4361 message locally with EVM `personal_sign`, and
retries once with `SIGN-IN-WITH-X`. The proof is never sent to a redirect or a different host.

If the retry returns a normal 402 quote, the usual spend-policy and payment flow continues. If the
resource is free after sign-in, the result has `outcome: "signed_in"` and the local receipt records
`amountAtomic: "0"`.

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
  and tries the configured fallback at `https://console.vapinetwork.ai`.
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
| `@vapi-network/core`    | x402 protocol, wallet, spend policy, discovery merge, and receipts       |
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
keystore.json
receipts.jsonl
spend-ledger.json
reports/
```

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

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the development workflow and
[SECURITY.md](./SECURITY.md) for private vulnerability reports.

CLI commands exit `0` on success, `1` on an operational failure, and `2` for
invalid usage or an announced preview-only command. `--json` sends both success
values and errors to stdout as one JSON value; `mcp --json` is accepted as a
no-op because the stdio transport is already JSON-RPC.

## Publishing

All five packages share one version and are published together. npm reads a
package manifest before lifecycle hooks run, so the release is made from the
generated `publish/` directories, never from the workspace package roots.

First update every package to the same version, keep
`publishConfig.tag = "next"`, and verify the exact tarballs:

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
with `npm publish ./publish --access public --tag next`. The manual release
workflow verifies and prints these commands; it never receives npm credentials
or publishes automatically.

## License

Apache-2.0. See [LICENSE](./LICENSE).
