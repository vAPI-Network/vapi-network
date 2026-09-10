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

Tools: `call.search`, `call.inspect`, `call.pay`, `wallet.address`, `wallet.balance`, `receipts.list`.
Spend caps default to $0.10 per call and $1.00 per day; the wallet checks both before it signs.

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
