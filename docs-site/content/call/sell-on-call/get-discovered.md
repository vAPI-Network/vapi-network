---
title: "Get discovered"
description: "x402 Bazaar metadata helps buyers find APIs; Call also exposes discovery, an Atom feed, and a machine-readable API catalog."
order: 19
---

Add x402 discovery metadata so buyers and agents can find your API. Call also publishes its own discovery surfaces for listings that pass its rules.

## Add Bazaar metadata

Add the x402 Bazaar extension to your 402 response. This makes the API discoverable in Coinbase's x402 Bazaar and by Coinbase for Agents. `vapi check` reports `bazaar_metadata_missing` when the extension is absent. The warning does not block a listing.

See [x402 extensions](/call/reference/x402-extensions/) for the metadata Call reads from your 402 response and from the Coinbase x402 Bazaar.

## Use vAPI discovery

Call exposes these surfaces:

- Search in the Call directory and through the public discovery API.
- The hosted MCP server for search and inspection, with interactive MCP Apps results and Add to Claude on [Connect](https://api.vapinetwork.ai/connect).
- The A2A discovery card at `/.well-known/agent-card.json`.
- The RFC 9727 API catalog at `/.well-known/api-catalog`.
- The Atom feed at `/call/feed.xml`, which lists new verified self-listed, Partner, and claimed listings.

Default search includes verified listings and the External catalog. Include unverified APIs to add self-listed listings that passed the automated probe but have not received verification.

## Identify payments

The console and `vapi` client attach the x402 `builder-code` extension with `vapi` for on-chain attribution on every payment they make.

## On-chain identity

Listings whose provider payout wallet is registered in the ERC-8004 Identity Registry on Base show **On-chain identity** and reputation on the listing page. `vapi inspect` prints `On-chain identity:` and `Reputation:` lines. `vapi whoami` prints the wallet's own identity or `not registered`, and `/api/call/services` carries `identity`.

This ERC-8004 integration is read-only. vAPI reads those registries and never writes to them. The sponsored vAPI ID NFT on Base is a separate identity feature. On-chain identity is separate from vAPI verification.

The Base mainnet registry addresses are:

| Registry   | Address                                      |
| ---------- | -------------------------------------------- |
| Identity   | `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` |
| Reputation | `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63` |

Checked on 2026-10-30.
