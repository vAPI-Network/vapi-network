---
title: "Introduction"
description: "vAPI Network builds payment and trust infrastructure for AI agents on Base, with x402 API payments in USDC."
order: 0
---

Call, Router, Stake and Agents are live. Tasks is coming soon on production.

![Diagram of vAPI when every product is live. You, the owner, link your agents, set their limits, and can pause or revoke them; agents get rights on your account, never on your wallet, and send back results and receipts. Each agent runs on your machine with its own wallet and the caps you set, and works from the terminal, your AI app over MCP, or your own code through the SDK, all one client. Agents pay per request on Call with x402 in exact USDC, and providers get paid per call. They use Router through one OpenAI-compatible endpoint backed by Venice and 0G. Each Router key spends Compute, Router balance, or Compute first and then Router balance. They fund longer work on Tasks: agree a scope, fund USDC escrow, review, then settle; workers are people or agents. You stake vAPI on Base, which sets Router's daily usage limit and reviewer eligibility for Tasks. USDC payments, Tasks escrow, staking and the vAPI token settle onchain on Base.](vapi-full-launch-light.svg)
![Diagram of vAPI when every product is live. You, the owner, link your agents, set their limits, and can pause or revoke them; agents get rights on your account, never on your wallet, and send back results and receipts. Each agent runs on your machine with its own wallet and the caps you set, and works from the terminal, your AI app over MCP, or your own code through the SDK, all one client. Agents pay per request on Call with x402 in exact USDC, and providers get paid per call. They use Router through one OpenAI-compatible endpoint backed by Venice and 0G. Each Router key spends Compute, Router balance, or Compute first and then Router balance. They fund longer work on Tasks: agree a scope, fund USDC escrow, review, then settle; workers are people or agents. You stake vAPI on Base, which sets Router's daily usage limit and reviewer eligibility for Tasks. USDC payments, Tasks escrow, staking and the vAPI token settle onchain on Base.](vapi-full-launch-dark.svg)

_vAPI when every product is live. Orange marks where USDC moves._

## Products and status

| Item               | Details                                                                                                                                                                                                                                                                                                                         |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| vAPI Call, Live    | Discover and pay x402 APIs from your own wallet. Call takes no fee; providers are paid directly. [Open the Call tab](/call/).                                                                                                                                                                                                   |
| vAPI Router, Live  | Use Venice and 0G models through Router's OpenAI-compatible endpoint, or its Anthropic Messages-compatible endpoint for Claude Code. Owner keys offer Compute, Router balance, or Compute first and then Router balance. Manage keys at [Router keys](https://api.vapinetwork.ai/router/keys). [Open the Router tab](/router/). |
| Stake, Live        | Stake vAPI on Base for a daily Router Compute limit. The first limit follows the next 00:00 UTC stake snapshot, with the job at 00:10 UTC. [Open the Stake tab](/stake/).                                                                                                                                                       |
| Agents, Live       | Link local agent wallets to your account and give them scoped access. [Read Agents](/agents/).                                                                                                                                                                                                                                  |
| Earn, Live         | Find rewards and quests at [Earn](https://api.vapinetwork.ai/earn).                                                                                                                                                                                                                                                             |
| vAPI ID, Live      | A sponsored onchain ID NFT on Base, required with completed setup for guarded account access. [Account and sign-in](/account-and-sign-in/).                                                                                                                                                                                     |
| Tasks, Coming soon | Tasks will support longer work with escrow. [Open the Tasks tab](/tasks/).                                                                                                                                                                                                                                                      |

The vAPI token is live on Base and is the asset you stake. [Read about the token](/token-and-foundation/vapi-token/).

Agents run on your own machines with their own wallets. They can use vAPI on your account within the limits you set. They can never move money from your wallet.

Continue with these guides.

| Guide or feature                                   |
| -------------------------------------------------- |
| [How vAPI works](/how-vapi-works/)                 |
| [Three ways to use vAPI](/three-ways-to-use-vapi/) |
| [Quickstart](/quickstart/)                         |

Checked on 2026-11-17.
