# Documentation

Guides for the `vapi-network` client in this repository. Product documentation for the hosted services is at [docs.vapinetwork.ai](https://docs.vapinetwork.ai).

## Start here

| Guide                                   | Read it when                                                        |
| --------------------------------------- | ------------------------------------------------------------------- |
| [Quickstart](../README.md#quickstart)   | You want a funded wallet and a first paid call.                     |
| [Wallets](./wallets.md)                 | You want to understand the vault, accounts, caps and custody.       |
| [Configuration](./configuration.md)     | You need environment variables, funding, networks or local metrics. |
| [Troubleshooting](./troubleshooting.md) | A command failed and you want the cause.                            |

## Products

| Guide                              | Covers                                                            |
| ---------------------------------- | ----------------------------------------------------------------- |
| [Call](./call.md)                  | Searching, inspecting, paying, checking and publishing x402 APIs. |
| [Router](./router.md)              | Hosted model access, Compute, Router balance and staking status.  |
| [Claude Code and Codex](./code.md) | Running coding tools on your Compute allowance.                   |
| [Tasks](./tasks.md)                | Task commands and tools; Tasks is coming soon on production.      |
| [Agents](./agents.md)              | Capped local agents with their own accounts and profiles.         |
| [Swarms](./swarms.md)              | Groups of agents around a treasury and a capital policy.          |

## Interfaces

| Guide                     | Covers                                                   |
| ------------------------- | -------------------------------------------------------- |
| [CLI reference](./cli.md) | Every `vapi` command, its options and exit codes.        |
| [MCP](./mcp.md)           | The local MCP server, its tools and client installation. |
| [SDK](./sdk.md)           | `createVapiClient` and the lower-level packages.         |

## Money and recovery

| Guide                                           | Covers                                                  |
| ----------------------------------------------- | ------------------------------------------------------- |
| [Sending between accounts](./sending.md)        | Transfers, distribution and unfinished movements.       |
| [Backup and recovery](./backup-and-recovery.md) | Encrypted cloud backup and restore with owner approval. |
| [Backup envelope](./backup-envelope.md)         | The format of an encrypted backup.                      |

## For contributors

| Document                                  | Covers                                                     |
| ----------------------------------------- | ---------------------------------------------------------- |
| [CONTRIBUTING.md](../CONTRIBUTING.md)     | Setup, checks, sign-off and review.                        |
| [AGENTS.md](../AGENTS.md)                 | Repository layout and the invariants every change keeps.   |
| [Releasing](./releasing.md)               | How maintainers version, publish and tag a release.        |
| [Writing rules](./STYLE.md)               | The style every guide follows; `pnpm lint:copy` checks it. |
| [Cloud workspaces](./cloud-workspaces.md) | Maintainer notes for the hosted development environment.   |
