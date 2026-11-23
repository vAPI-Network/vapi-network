---
title: "Agents"
description: "Local programs use separate capped wallets linked to an owner-controlled vAPI Network account."
order: 8
---

This page is for owners and builders who want an agent to use Router and pay Call APIs within local limits.

A vAPI agent is a small program that runs on your machine with its own capped wallet, linked to your vAPI account. It thinks with vAPI Router and pays for APIs on vAPI Call.

![Your vAPI account opens through email, Google or a connected wallet; email and Google can create a vAPI wallet; agents can never move money from it. In My agents in the console you link agents, set Router allowances, or revoke links. Local CLI commands set wallet caps and pause local agent profiles. Two example agents: researcher has its own capped wallet, $2 a day for Router and $1 a day for Call; trader has its own capped wallet, $5 a day for Router and $3 a day for Call. Add more with vapi accounts add; each runs on your machine with its own wallet and limits. Every agent pays for data and tools on Call from its own wallet with x402 in exact USDC, and uses Router through one OpenAI-compatible endpoint. Router serves models from Venice and 0G on production.](vapi-agents-overview-light.svg)
![Your vAPI account opens through email, Google or a connected wallet; email and Google can create a vAPI wallet; agents can never move money from it. In My agents in the console you link agents, set Router allowances, or revoke links. Local CLI commands set wallet caps and pause local agent profiles. Two example agents: researcher has its own capped wallet, $2 a day for Router and $1 a day for Call; trader has its own capped wallet, $5 a day for Router and $3 a day for Call. Add more with vapi accounts add; each runs on your machine with its own wallet and limits. Every agent pays for data and tools on Call from its own wallet with x402 in exact USDC, and uses Router through one OpenAI-compatible endpoint. Router serves models from Venice and 0G on production.](vapi-agents-overview-dark.svg)

_Agents think with Router and pay for APIs on Call from their own wallet. They can never move money from your wallet._

Status: Live. Agent hosting is coming.

Use [Start with your agent](/start-with-your-agent/) for terminal setup or a browser-only connection.

## What you get

1. One place for thinking and doing: the agent's model calls go through vAPI Router, while its data and tools come from vAPI Call, all from one small wallet.
2. Your wallet stays yours: agents get rights on your account, never on your wallet.
3. Hard limits you set: per-call and per-day caps, a daily Router allowance, an approval threshold, and verified APIs by default.
4. Stake sets your daily Router usage limit, which also bounds your agents' Router use.
5. Buy more when you need it: Router balance is bought with USDC and never expires.
6. Works where you work: the same link serves the CLI, Claude, Cursor, or Codex over MCP, and your own code through the SDK.
7. Everything is on the record: you get receipts for every payment, an audit log, and **My agents** in the console.

Agents run on your own machines with their own wallets. They can use vAPI on your account within the limits you set. They can never move money from your wallet.

## For agents

Clients ≤ 0.9.0 fail every search whose results include a Solana row. Update to 0.14.0 with the global install below.

Install the client:

```bash
npm i -g vapi-network
```

MCP provides namespaced tools such as `call.search`, `call.pay`, and `router.chat`. Account caps, Router allowances, and local run budgets limit their work.

## Next

- [Run your first agent](/agents/quickstart/)
- [Owner and agents](/agents/control/owner-and-agents/)
- [Limits and ceilings](/agents/wallets/limits-and-ceilings/)

Checked on 2026-11-17.
