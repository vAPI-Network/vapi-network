# vAPI Network

[![npm version](https://img.shields.io/npm/v/vapi-network?label=npm)](https://www.npmjs.com/package/vapi-network)
[![CI](https://github.com/vAPI-Network/vapi-network/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/vAPI-Network/vapi-network/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue)](./LICENSE)
[![Node.js 22 or newer](https://img.shields.io/badge/node-%3E%3D22-brightgreen)](https://nodejs.org)

**One wallet, every x402 API.** `vapi-network` is the open-source, non-custodial
TypeScript client for discovering and paying x402 services in USDC on Base, from a
terminal, an MCP client or your own code.

vAPI Network builds payment and trust infrastructure for AI agents on Base. Call,
Router, Stake and Agents are live on production. Tasks is coming soon. See
[vapinetwork.ai](https://vapinetwork.ai) and the
[documentation](https://docs.vapinetwork.ai).

vAPI Network is not related to Vapi.ai, the voice AI company.

## Quickstart

This README describes client 0.14.0. `npm view vapi-network version` shows the latest published release.
The client needs Node.js 22 or newer.

```bash
npm i -g vapi-network
vapi setup [--no-cloud-backup]   # creates or restores the vault, derives main, links it to your owner wallet; safe to rerun
vapi fund                        # opens the hosted funding page for your address
vapi search "weather"            # every catalogue, merged, with provenance
vapi pay <listing-ref> --max 0.02
vapi receipts                    # one line per paid call: quote, settlement, latency
```

No install? Prefix any command with `npx vapi-network`, for example
`npx vapi-network setup`. (`npx vapi` cannot work: the bare `vapi` name on npm
belongs to an unrelated package.)

Back up the recovery phrase only in a terminal; vAPI cannot recover it.
Turn on encrypted cloud backup with `vapi backup --cloud`; only the owner can approve a restore.
On a server, a container or GitHub Codespaces, read
[Linux without a keyring](./docs/wallets.md#linux-without-a-keyring) before `vapi setup`.

An agent can set itself up from the agent skill. Tell it: "Read
https://vapinetwork.ai/SKILL.md and follow it to set up vAPI." The same file
ships in this package as [SKILL.md](./packages/vapi-network/SKILL.md), with the
CLI version it describes in its frontmatter.

Interactive CLI runs check for a newer release at most once a day and cache the result in
`~/.vapi/update-check.json`. JSON, MCP server, CI and non-TTY runs skip the check. Set
`VAPI_NO_UPDATE_CHECK=1` to disable it.

## How a payment works

The device vault encrypts your keys on this machine, using an OS-stored device key
with optional password protection. vAPI applies your spend caps before signing,
sends the payment straight to the service, and writes a local receipt. There is no
payment proxy and no server-side signer. vAPI Call takes no fee; providers are paid
directly.

Local runs keep keys on this machine; experimental Railway runs require explicit
member-key export. Call and discovery metrics are measured locally and nothing is
uploaded unless you send a report yourself. Every payment identifies this client as
`vapi` through x402 `builder-code`; when an API advertises `payment-identifier`, the
generated id is kept on that receipt.

## Three ways to use it

The CLI, the MCP server and the SDK share one vault, one set of spend caps and one
receipt ledger under `~/.vapi/`.

Register the MCP server with your agent client, then ask it to "Search vAPI for a
weather API":

```bash
vapi mcp install <claude-code|claude-desktop|cursor|codex>
```

Call the same client from TypeScript:

```ts
import { createVapiClient } from "vapi-network";

const vapi = await createVapiClient({ account: "researcher" });
const listings = await vapi.call.search("Base DEX volume");
const result = await vapi.call.pay({ id: "base-dex-volume", maxPriceUsd: 0.05 });
console.log(result.body);
```

The MCP server has no tool that reveals a recovery phrase or a private key, and no
tool that creates or retires a listing. The tool list is in [docs/mcp.md](./docs/mcp.md#tools).

## What you can do

| Surface      | What it does                                                               | Guide                                                        |
| ------------ | -------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Call         | Discover, check, publish and pay for x402 APIs.                            | [docs/call.md](./docs/call.md)                               |
| Router       | Use vAPI Router for model access and balance.                              | [docs/router.md](./docs/router.md)                           |
| Coding tools | Run Claude Code and Codex on your daily Compute allowance.                 | [docs/code.md](./docs/code.md)                               |
| Tasks        | Preview task posting, USDC escrow and delivery; coming soon on production. | [docs/tasks.md](./docs/tasks.md)                             |
| Agents       | Run capped local agents with dedicated wallets and profiles.               | [docs/agents.md](./docs/agents.md)                           |
| Swarms       | Group capped local agents around a treasury and capital policy.            | [docs/swarms.md](./docs/swarms.md)                           |
| MCP          | Use namespaced payment tools from an MCP client.                           | [docs/mcp.md](./docs/mcp.md)                                 |
| SDK          | Use Call, vAPI Router and local agents behind one wallet-bound API.        | [docs/sdk.md](./docs/sdk.md)                                 |
| Vault        | Manage the owner wallet, device vault, accounts and spend caps.            | [docs/wallets.md](./docs/wallets.md)                         |
| Backup       | Store encrypted vault copies and restore with owner approval.              | [docs/backup-and-recovery.md](./docs/backup-and-recovery.md) |

Every command, option and exit code is in the [CLI reference](./docs/cli.md).
Account transfers are in [docs/sending.md](./docs/sending.md). Configuration,
funding, networks and bug reports are in [docs/configuration.md](./docs/configuration.md).
When something fails, start with [docs/troubleshooting.md](./docs/troubleshooting.md).
The full list of guides is in [docs/README.md](./docs/README.md).

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
All five packages share one version and are released together; each release is
described in [CHANGELOG.md](./CHANGELOG.md).

## vAPI Desktop

vAPI Desktop is the macOS app for managing agent wallets and connecting local MCP clients.
The signer process keeps keys on your computer.
Version 0.1.0 is not released yet; signing and notarization are pending. The source is in `apps/desktop`.
See [the desktop release guide](apps/desktop/RELEASE.md) for building and signing the app.

## Support and community

| You have                             | Go to                                                                             |
| ------------------------------------ | --------------------------------------------------------------------------------- |
| A bug in the CLI, MCP server or SDK  | [Open an issue](https://github.com/vAPI-Network/vapi-network/issues/new/choose)   |
| A question or an idea                | [GitHub Discussions](https://github.com/vAPI-Network/vapi-network/discussions)    |
| An account, points or quest question | [Discord](https://discord.gg/vapinetwork) or [Telegram](https://t.me/vapinetwork) |
| An API you want listed on vAPI Call  | `vapi publish`, described in [docs/call.md](./docs/call.md#publish-an-api)        |
| A vulnerability                      | security@vapinetwork.ai, described in [SECURITY.md](./SECURITY.md)                |

[SUPPORT.md](./SUPPORT.md) says what to include so a report can be answered in one round.

## Contributing

Bug fixes, tests, documentation and discovery sources are welcome. Read
[CONTRIBUTING.md](./CONTRIBUTING.md) for the setup, the checks and the sign-off each
commit needs, and [AGENTS.md](./AGENTS.md) for the layout and the invariants a change
must keep. Participation is governed by the [Code of Conduct](./CODE_OF_CONDUCT.md).

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm build
pnpm pack:check
```

## License

Apache-2.0. See [LICENSE](./LICENSE).
