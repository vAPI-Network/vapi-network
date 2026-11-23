---
title: "Open source"
description: "The Apache-2.0 vapi-network client is public on GitHub and npm, with CLI, local MCP, and SDK interfaces."
order: 1
---

> [!NOTE]
> Call, Router, Stake and Agents are live. Tasks is coming soon.

This page shows where the vAPI client's code lives and how to check it yourself, for anyone who wants to verify before they trust.

The client is public at [vAPI-Network/vapi-network](https://github.com/vAPI-Network/vapi-network) under the Apache-2.0 license. It is published on npm as [`vapi-network`](https://www.npmjs.com/package/vapi-network). The `latest` release is 0.14.0.

vAPI Desktop source lives in the client monorepo at [vAPI-Network/vapi-network/apps/desktop](https://github.com/vAPI-Network/vapi-network/tree/main/apps/desktop). It has no released installer.

## Five packages

| Package                 | What it does                                                                               |
| ----------------------- | ------------------------------------------------------------------------------------------ |
| `vapi-network`          | Bundles the public client and installs the `vapi` command.                                 |
| `@vapi-network/core`    | Handles x402, wallets, spend rules, network checks, discovery merging, and local receipts. |
| `@vapi-network/sources` | Normalizes listings from the vAPI registry, Coinbase Bazaar, and local JSON.               |
| `@vapi-network/cli`     | Implements commands for accounts, discovery, payments, receipts, secrets, and MCP startup. |
| `@vapi-network/mcp`     | Runs the local MCP tools without returning recovery phrases, keys, or passphrases.         |

## What runs where

Local execution keeps signing keys on your machine. The experimental Railway runtime exports the selected member's key and credentials. The local client signs each payment and sends it to the service.

vAPI servers provide the catalogue, relays, account links, and Router access. They do not hold the wallet key or sign Call payments.

The deployed fee path and the addresses below live on Base. The client also supports direct USDC payments on the [networks listed in Call](/call/reference/networks-and-schemes/).

## Verify it yourself

Read the repository's [README](https://github.com/vAPI-Network/vapi-network/blob/main/README.md), [changelog](https://github.com/vAPI-Network/vapi-network/blob/main/CHANGELOG.md), and package source. Check which versions are published, then list the files in the published package without installing it:

```bash
npm view vapi-network dist-tags
npm pack vapi-network --dry-run
```

Contributors use Node 22 and pnpm 10. The repository checks formatting, lint, types, tests, builds, and package contents before release.

## Deployed contracts

The fee contracts and the token are deployed on Base mainnet. Each link opens the contract on Basescan, which shows the deployed bytecode and the verified source when available. Roles are described in [x402 contracts](/reference/x402/contracts/).

| Contract           | Address                                                                                                                    |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| FeeRouter          | [0xe11aeeC31E54E8E6E66382c8BdBFfd1000E0194B](https://basescan.org/address/0xe11aeeC31E54E8E6E66382c8BdBFfd1000E0194B#code) |
| FeeSplitterFactory | [0x8405f917f6EfBd1447aF01Fe879529bcD313279D](https://basescan.org/address/0x8405f917f6EfBd1447aF01Fe879529bcD313279D#code) |
| BuybackBurner      | [0x910780Ac98BD2e7509CaF2f6833be947DD30d96b](https://basescan.org/address/0x910780Ac98BD2e7509CaF2f6833be947DD30d96b#code) |
| vAPI token         | [0x1eA8deB921AA6015f4938010C848140b98108Dd2](https://basescan.org/address/0x1eA8deB921AA6015f4938010C848140b98108Dd2#code) |

## Security and contributions

Follow the repository's [security policy](https://github.com/vAPI-Network/vapi-network/blob/main/SECURITY.md) and report issues privately to `security@vapinetwork.ai`. Include the affected version, impact, and a minimal reproduction without secrets or personal data.

For other changes, read the [contribution guide](https://github.com/vAPI-Network/vapi-network/blob/main/CONTRIBUTING.md). Search existing issues first, discuss large interface changes, keep changes focused, and add deterministic tests.

## Next

- [CLI reference](/reference/cli/cli-reference/)
- [SDK](/reference/sdk/sdk/)
- [x402 contracts](/reference/x402/contracts/)

Checked on 2026-11-17.
