---
title: "Roadmap and status"
description: "Current product status and recently shipped work."
order: 108
---

Production runs vapi-app v3.51.0 and client vapi-network 0.14.0.
This page lists current product status and planned work.

| Area        | Status                                                                                                                     | Where                                               |
| ----------- | -------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| vAPI Call   | Live: pay x402 APIs from the console, the CLI, MCP or the SDK                                                              | [Call](/call/)                                      |
| vAPI Router | Live: OpenAI-compatible Venice and 0G models; Compute, Router balance or Compute first and then Router balance             | [Router](/router/)                                  |
| Stake       | Live: stake vAPI on Base for a daily Router Compute limit; 24-hour withdrawal cooldown                                     | [Stake](/stake/)                                    |
| Agents      | Live: local wallets, owner-approved links (up to 50 agents), Router allowances, My agents and Usage in the console         | [Agents](/agents/)                                  |
| Reference   | Reference for Call: released client 0.14.0, public HTTP API, x402 on vAPI, contracts. Router, Stake and Agents routes live | [Reference](/reference/)                            |
| Earn        | Live: quests, points, leaderboard and a 1M vAPI airdrop program                                                            | [Earn](/products/earn/)                             |
| vAPI ID     | Live: sponsored onchain ID NFT on Base, required with completed setup for guarded account access                           | [Account and sign-in](/account-and-sign-in/)        |
| Tasks       | Coming soon on production                                                                                                  | [Tasks](/tasks/)                                    |
| vAPI token  | Live on Base                                                                                                               | [The vAPI token](/token-and-foundation/vapi-token/) |

## Recently shipped

| Item            | What shipped                                                                                                                                                                |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Account         | Google and email sign-in, embedded vAPI wallets, setup and confirmed-ID readiness.                                                                                          |
| Earn            | Dashboard for activity and performance.                                                                                                                                     |
| Router keys     | Compute, Router balance and hybrid owner keys, managed at `/router/keys`.                                                                                                   |
| Router funding  | Base USDC deposit addresses, minimum $1, alongside wallet top-ups.                                                                                                          |
| Router overview | One-wallet view adds remaining Compute and Router balance as Available today; onchain wallet USDC remains separate. Compute resets at 00:00 UTC; balance stays until spent. |
| Stake           | Stake Pool and Burn pages, including the public Burn ledger.                                                                                                                |

## Live in Call

| Feature                                                                                                                |
| ---------------------------------------------------------------------------------------------------------------------- |
| Directory with card and table views, plus My APIs at `/call/my-apis`.                                                  |
| Permissionless listing with verification as a tier, direct provider payouts and no Call fee.                           |
| Search health, cheaper or healthier alternatives, and an outage opt-in; inspect response schemas and example requests. |
| Interactive MCP Apps search and inspect results, plus Add to Claude on Connect.                                        |
| An A2A discovery card for agents on other platforms.                                                                   |
| The Graph as the first Verified Provider.                                                                              |
| MPP listings shown as Not payable here.                                                                                |
| ERC-8004 identity shown on listings.                                                                                   |
| Indexed-listing x402 statistics in the console; routed-through-vAPI totals remain in the API.                          |

## Live in Router and Stake

| Feature                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------ |
| Router API keys, model catalog, usage, and USDC balance top-ups.                                                                           |
| An Anthropic Messages-compatible endpoint for Claude Code, with prompt-cache pricing.                                                      |
| 0G as the second Router upstream: 53 text models from Qwen, Z.ai, Moonshot AI, MiniMax and others, with the same privacy labels.           |
| Linked agents visible on [My agents](https://api.vapinetwork.ai/agents), with spend on [Usage](https://api.vapinetwork.ai/usage).          |
| Active-stake snapshots at 00:00 UTC, with the Compute job at 00:10 UTC.                                                                    |
| Withdrawal requests, 24-hour cooldown, cancellation, and withdrawal.                                                                       |
| Staking contracts redeployed on 2026-10-20 with the 24-hour cooldown. The current addresses are on [Staking contracts](/stake/contracts/). |
| Owner-approved allowances that cap each linked agent's Compute and balance keys separately.                                                |

Tasks is coming soon on production for longer work with escrow between clients and workers. The public beta runs on Base Sepolia with test USDC; the [Tasks](/tasks/) tab has its rules.

Coming: Agent hosting and vAPI Desktop for macOS.

## Being built

Each item below has a published design and plan. None of them is live yet, and none has a date.

| Item                   | What it does                                                                                   | Product      |
| ---------------------- | ---------------------------------------------------------------------------------------------- | ------------ |
| Owner rules for agents | Allowed providers, verified listings only, owner approval above an amount, more than one owner | Agents       |
| Provider trust score   | One score per listing from live checks, uptime, latency, verification and payment outcomes     | Call         |
| Pay per usage          | The agent signs a maximum and pays what the request used                                       | Call, Router |
| Paid MCP tools         | Tools on the hosted MCP server that any x402-paying MCP client can buy                         | Agents       |

Later work includes:

- Batched tiny payments, so sub-cent prices do not each need their own settlement.
- The trust score published to ERC-8004 reputation onchain.

Continue with these guides.

| Guide or feature                         |
| ---------------------------------------- |
| [How vAPI works](/how-vapi-works/)       |
| [Products overview](/products/overview/) |
| [Tasks](/tasks/)                         |

Checked on 2026-11-17.
