---
title: "Provider guides"
description: "Step-by-step guides for paying specific providers on vAPI Call, one page per provider, with a worked example for the console, the CLI and SDK, and an MCP…"
order: 7
---

Each page in this section is one provider on Call, written for someone who already knows what they want from it and wants the first paid request to work the first time. The [Quickstart](/call/quickstart/) teaches the flow; these pages teach the provider.

| Provider                                | What it offers                                                                                                     | Price                                     | Group             |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------- | ----------------- |
| [The Graph](/call/providers/the-graph/) | GraphQL queries against 20 Subgraphs: Uniswap, Aave, Aerodrome, ENS, Curve, Lido and more                          | $0.01 per query                           | Verified Provider |
| [Birdeye](/call/providers/birdeye/)     | Solana token prices, candles, holders, trades and trader rankings, paid on Solana from the console                 | $0.003 per request                        | Verified Provider |
| [o1 Launchpad](/call/providers/o1/)     | Launchpad tokens, trades, holders and wallets on six chains, plus unsigned swap, launch and fee-claim transactions | $0.001 to $0.05 per call                  | Verified Provider |
| [Dot](/call/providers/dot/)             | Private AI chat completions in the OpenAI format                                                                   | Priced per request, about $0.003 to $0.01 | Verified Provider |

More guides follow as providers are verified. Use the [CLI, MCP and SDK](/call/use-call/pay-with-vapi/) for Base and Arc providers. Solana-only providers such as Birdeye require the console; client 0.14.0 cannot pay them. Each guide adds the provider's endpoints, request shapes and quirks.

## What every guide covers

1. What the provider offers and the listing link, with its group and verification tier.
2. The endpoints, in one table.
3. One worked example per path: the console, the CLI and SDK, and a prompt for an agent on MCP.
4. The price, with the reminder that the provider's live 402 offer is the price.
5. Limits and errors you may meet, and what to do.
6. The provider's own documentation.

Checked on 2026-11-17.
