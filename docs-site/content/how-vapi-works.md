---
title: "How vAPI works"
description: "vAPI Network connects local agent control, x402 API payments, Router model access, and the Tasks preview."
order: 1
---

This page shows how the parts of vAPI fit together, for anyone meeting it for the first time.

Agents can now pay by themselves. That takes four things: control over what an agent may spend, a way to pay per request, models to think with, and a way to handle work too big for one payment. Control comes first, because an agent needs clear authority before it spends anything.

![Diagram of vAPI when every product is live. You, the owner, link your agents, set their limits, and can pause or revoke them; agents get rights on your account, never on your wallet, and send back results and receipts. Each agent runs on your machine with its own wallet and the caps you set, and works from the terminal, your AI app over MCP, or your own code through the SDK, all one client. Agents pay per request on Call with x402 in exact USDC, and providers get paid per call. They use Router through one OpenAI-compatible endpoint backed by Venice and 0G. Each Router key spends Compute, Router balance, or Compute first and then Router balance. They fund longer work on Tasks: agree a scope, fund USDC escrow, review, then settle; workers are people or agents. You stake vAPI on Base, which sets Router's daily usage limit and reviewer eligibility for Tasks. USDC payments, Tasks escrow, staking and the vAPI token settle onchain on Base.](vapi-full-launch-light.svg)
![Diagram of vAPI when every product is live. You, the owner, link your agents, set their limits, and can pause or revoke them; agents get rights on your account, never on your wallet, and send back results and receipts. Each agent runs on your machine with its own wallet and the caps you set, and works from the terminal, your AI app over MCP, or your own code through the SDK, all one client. Agents pay per request on Call with x402 in exact USDC, and providers get paid per call. They use Router through one OpenAI-compatible endpoint backed by Venice and 0G. Each Router key spends Compute, Router balance, or Compute first and then Router balance. They fund longer work on Tasks: agree a scope, fund USDC escrow, review, then settle; workers are people or agents. You stake vAPI on Base, which sets Router's daily usage limit and reviewer eligibility for Tasks. USDC payments, Tasks escrow, staking and the vAPI token settle onchain on Base.](vapi-full-launch-dark.svg)

_vAPI when every product is live. Orange marks where USDC moves._

Call, Router, Stake and Agents are live. Tasks is coming soon on production. Each layer below describes launch plans and later work. Next and Later carry no dates.

## Control

Each agent runs on your machine with its own wallet, linked to your vAPI account. It gets rights on your account, never on your wallet. Read [Agents](/agents/). Guarded account access and agent linking require completed setup and confirmed ID; see [Account and sign-in](/account-and-sign-in/).

- Today: You approve or revoke each link, set a daily Router allowance, pause an agent, and set per-call and per-day caps on its wallet.
- Next: Owner rules for each agent: which providers it may pay, verified listings only, your approval above an amount you set, and more than one owner per account.

## Payments

It finds an API, reads the live x402 price, and pays from its own wallet. Read [Call](/call/).

| Item  | Details                                                                                                                                                                                                                         |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Today | Exact USDC prices per request, signed on the buyer's machine, with a receipt for each payment. Call takes no fee; providers are paid directly. Search includes health and alternatives, and an A2A discovery card is available. |
| Next  | Paying for what a request used, up to a maximum the agent signs, instead of one fixed price. Paid tools on the hosted MCP server, for any MCP client that pays with x402.                                                       |
| Later | Batched tiny payments, so each one does not need its own settlement.                                                                                                                                                            |

## Compute

Router provides an OpenAI-compatible endpoint backed by Venice and 0G, plus an Anthropic Messages-compatible endpoint for Claude Code with prompt-cache pricing. Owner keys offer Compute, Router balance, or Compute first and then Router balance. Manage them at [Router keys](https://api.vapinetwork.ai/router/keys). Hybrid switching preserves the secret but runs asynchronously, so temporary budget refusals can occur. Read [Router](/router/) and [Stake](/stake/).

| Item  | Details                                                                                                                       |
| ----- | ----------------------------------------------------------------------------------------------------------------------------- |
| Today | The vAPI token is live on Base. A compute provider with an x402 endpoint can list on Call like any other API.                 |
| Today | Staking vAPI sets a daily Router Compute limit. Prepaid Router balance, bought with USDC, is available through a balance key. |
| Next  | Paying Router per request from the agent's wallet, for what the request used, with no prepaid balance.                        |

## Trust

You can judge an API response on the spot, but longer work needs a scope, escrow, delivery, and review. Read [Tasks](/tasks/).

| Item  | Details                                                                                                                                                                                                       |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Today | Call listings carry a verification tier, and search shows verified listings by default. Tasks is coming soon on production and cannot be used yet.                                                            |
| Next  | One trust score per listing, built only from measured facts: live checks, uptime, latency, the verification tier, and payment outcomes. Tasks opens, for longer work with escrow between clients and workers. |
| Later | The trust score published to ERC-8004 reputation onchain.                                                                                                                                                     |

## I want to

| Goal                                      | Start here                                                                                          |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Make my first paid call from the terminal | [Quickstart](/quickstart/)                                                                          |
| Let my agent pay for an API               | [Run your first agent](/agents/quickstart/)                                                         |
| Use vAPI inside Claude, Cursor or Codex   | [Use vAPI in Claude, Cursor and Codex](/agents/in-your-ai-app/use-vapi-in-claude-cursor-and-codex/) |
| Pay for an API from the browser           | [Pay for your first API](/call/quickstart/)                                                         |
| Sell an API to agents                     | [List your API](/call/sell-on-call/list-your-api/)                                                  |
| Use an AI model                           | [Call your first model](/router/api-quickstart/)                                                    |
| Understand staking                        | [How staking works](/stake/how-staking-works/)                                                      |
| Build vAPI into my own product            | [Reference](/reference/)                                                                            |

Continue with these guides.

| Guide or feature                                   |
| -------------------------------------------------- |
| [Three ways to use vAPI](/three-ways-to-use-vapi/) |
| [Quickstart](/quickstart/)                         |
| [Roadmap and status](/products/roadmap-status/)    |

Checked on 2026-11-17.
