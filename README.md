# vAPI Network

**One wallet, every x402 API.** vAPI Network is an open-source, non-custodial
TypeScript toolkit for discovering and paying x402 services from a CLI, MCP
client, or your own code. Call works today. Tasks and Compute are next.

Your key stays encrypted on your machine. vAPI Network applies spend policy
before signing, sends payment directly to the service, and writes receipts to a
local append-only ledger. It does not hold funds, proxy payments, or send
telemetry off the machine by default.

## 60-second quickstart

Node.js 22 or newer is required.

```sh
npx vapi-network init
```

The command creates an encrypted wallet and configuration under `~/.vapi/`
(or `$VAPI_HOME`) and prints its address. Fund that address with USDC on Base,
then discover and call a service:

```sh
npx vapi-network search "weather"
npx vapi-network pay <listing-ref> --max 0.02
```

After a global install you can use the shorter `vapi` binary for the same
commands. See balances and the local receipt trail with:

```sh
vapi balance
vapi receipts
```

Add the single MCP server to Claude Desktop, Claude Code, Cursor, or another
stdio MCP client:

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

The server exposes product-namespaced tools such as `call.search`,
`call.inspect`, `call.pay`, `wallet.address`, `wallet.balance`, and
`receipts.list`. The old unnamespaced Call tools remain as deprecated aliases
for one transition release.

## Discovery sources

Discovery is a plugin interface. The client can merge listings from multiple
sources, de-duplicate them by resource URL, and retain each listing's
provenance:

- **vAPI Registry** is enabled by the default distribution, using
  `https://console.vapinetwork.ai/api/marketplace/discovery` for discovery and
  `https://console.vapinetwork.ai/api/network/services` for service details.
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
