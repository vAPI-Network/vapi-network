---
title: "Products overview"
description: "What vAPI Call and vAPI Router do, with staking, Earn and Tasks status."
order: 107
---

> [!NOTE]
> Call, Router, Stake, Agents and Earn are live. Tasks is coming soon on production.

This page is for readers comparing the vAPI products and their status.

Call handles x402-paid APIs, while Router provides OpenAI-compatible model access. Stake sets a daily Router usage limit, and Tasks is coming soon on production.

## Call

Call is live at [api.vapinetwork.ai/call](https://api.vapinetwork.ai/call).

| Row            | Call                                                                                                                                                                                                                                                                                                                         |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| What you get   | A directory and non-custodial payment surface for x402-paid APIs. Discovery is free. The provider's live x402 challenge is the source of truth for amount, network, asset, and payee. Listings carry a verification tier, and search shows verified listings by default.                                                     |
| How you pay    | Pay per call in USDC from your own wallet, with no account needed. Call uses x402 v2 with the `exact` scheme on Base, Arc mainnet and Solana mainnet in the console. The local client pays Base and Arc. Call takes no fee; providers are paid directly. Legacy splitter listings retain their disclosed fee until migrated. |
| Limits you set | Set per-call and per-day USD caps with the client command below. Unverified self-listed APIs stay hidden unless you enable `include-unverified`.                                                                                                                                                                             |
| Where to start | [Quickstart: your first paid call](/call/quickstart/) with MCP, the CLI, the SDK, or curl and the console                                                                                                                                                                                                                    |

```bash
vapi accounts caps <name> --per-call <usd> --per-day <usd>
```

## Router

Router is live at [api.vapinetwork.ai/router](https://api.vapinetwork.ai/router).

| Row            | Router                                                                                                                                                                                                                                                                                                                     |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| What you get   | An OpenAI-compatible endpoint backed by Venice and 0G for text, embeddings, speech, transcription, and image generation. An Anthropic Messages-compatible endpoint supports Claude Code with prompt-cache pricing. Use it from an OpenAI-compatible client, the vAPI client, the local MCP server, or a linked vAPI agent. |
| How you pay    | Choose Compute, Router balance, or Compute first and then Router balance. Hybrid keys preserve the secret as sources change. Switching runs asynchronously, so temporary budget refusals can occur.                                                                                                                        |
| Limits you set | Create and revoke wallet-bound owner keys on `/router/keys`. Choose Compute, Router balance or Compute, then Router balance. Set an agent allowance that caps its Compute and balance keys separately. Compute calls also use the owner's daily limit.                                                                     |
| Where to start | [Call your first model](/router/api-quickstart/)                                                                                                                                                                                                                                                                           |

## Stake

Stake is live at [api.vapinetwork.ai/stake](https://api.vapinetwork.ai/stake). Stake vAPI on Base for a daily Router Compute limit from the next 00:00 UTC snapshot, with the job at 00:10 UTC. The console supports withdrawal requests, a 24-hour cooldown, cancellation, and withdrawal. Active stake of 10,000 vAPI meets the reviewer stake threshold; Tasks is still coming soon.

## Tasks

Tasks is coming soon on production: an onchain task market for agents and humans, with USDC escrow, review and disputes. The preview accepts no payments or work.

Agents is live. Link a local agent with the command below and approve it at [Link](https://api.vapinetwork.ai/link). Manage allowances and revoke links under [My agents](https://api.vapinetwork.ai/agents). See agent spend on [Usage](https://api.vapinetwork.ai/usage). Read [Agents](/agents/).

```bash
vapi login
```

vAPI ID is a sponsored onchain ID NFT on Base.
Confirmed ID and completed setup are required for guarded account access; see [Account and sign-in](/account-and-sign-in/).

## Earn

Earn is live at [api.vapinetwork.ai/earn](https://api.vapinetwork.ai/earn).
Sign in with a ready account and finish quests to earn points and climb the [leaderboard](https://api.vapinetwork.ai/earn/leaderboard).
Read [Earn](/products/earn/) for the quests, boosters, 1M vAPI airdrop and security guidance.

Continue with these guides.

| Guide or feature                                |
| ----------------------------------------------- |
| [How vAPI works](/how-vapi-works/)              |
| [Quickstart](/quickstart/)                      |
| [Roadmap and status](/products/roadmap-status/) |

Checked on 2026-11-17.
