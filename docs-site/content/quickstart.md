---
title: "Quickstart"
description: "Make a paid API call and link an agent wallet."
order: 3
---

> [!NOTE]
> Call, Router, Stake and Agents are live. Tasks is coming soon on production.

This guide is for people who want to install the client, make a paid API call, and link an agent from one machine. For the same first call through MCP, the SDK, or curl and the console, use the [Call quickstart](/call/quickstart/).

![The quickstart in three stages. You need Node.js and a little USDC on Base. Set up: vapi init creates a local wallet and vapi fund sends USDC on Base to it, which leaves you with a funded wallet. Find and pay: vapi search finds an API and vapi inspect shows its contract and the registry's last observed quote, both free; vapi pay with a maximum checks your limits, then signs, which leaves you with a paid call and a receipt. Link an agent: vapi login approves the link and its allowance, and vapi whoami checks it, which leaves you with an agent on your account. Only vapi pay signs a payment. At any time, vapi accounts caps sets standing per-call and per-day caps.](vapi-quickstart-light.svg)
![The quickstart in three stages. You need Node.js and a little USDC on Base. Set up: vapi init creates a local wallet and vapi fund sends USDC on Base to it, which leaves you with a funded wallet. Find and pay: vapi search finds an API and vapi inspect shows its contract and the registry's last observed quote, both free; vapi pay with a maximum checks your limits, then signs, which leaves you with a paid call and a receipt. Link an agent: vapi login approves the link and its allowance, and vapi whoami checks it, which leaves you with an agent on your account. Only vapi pay signs a payment. At any time, vapi accounts caps sets standing per-call and per-day caps.](vapi-quickstart-dark.svg)

_The quickstart at a glance. Only vapi pay signs a payment._

## Make a paid API call

The latest released client is 0.14.0. Update before following this guide:

```bash
npm i -g vapi-network@latest
```

Install the client and create a wallet:

```bash
npm i -g vapi-network
vapi init
```

If you do not want a global install, use this prefix for each command:

```bash
npx vapi-network
```

Fund the wallet from the page that the client opens:

```bash
vapi fund
```

Send USDC on Base to the account address printed during initialization.

Search for an API, inspect its request contract and the registry's last observed quote, then pay:

```bash
vapi search "weather"
vapi inspect <listing-ref>
vapi pay <listing-ref> --max 0.02
```

Search can show health and cheaper or healthier alternatives; `--include-outage` adds outage listings hidden by default. Inspection is free and includes response schemas and example requests when available, alongside the registry's last observed quote (price, network and payee). Payment fetches a fresh quote and checks your wallet limits before signing, so set an explicit maximum with `--max`.

Set the account's per-call and daily caps when you want a standing limit:

```bash
vapi accounts caps main --per-call 0.05 --per-day 1
```

Add `--json` to search, inspect, or pay when another program needs the result. The client stores a local receipt after each payment attempt.

## Link an agent

Run this on the machine that owns the local agent wallet:

```bash
vapi login
```

Open the link page from your [ready owner account](/account-and-sign-in/), approve the link, and set a daily Router allowance in USD.
Email and Google owners can approve links; own-wallet accounts may need wallet proof. Check the link from the local machine:

```bash
vapi whoami
```

Open My agents from the local machine:

```bash
vapi dashboard
```

Give your agent one line with [Start with your agent](/start-with-your-agent/).

Continue with these guides.

| Guide or feature                                                             |
| ---------------------------------------------------------------------------- |
| [Call quickstart: MCP, CLI, SDK, or curl and the console](/call/quickstart/) |
| [Run your first agent](/agents/quickstart/)                                  |
| [Call your first model](/router/api-quickstart/)                             |

Checked on 2026-11-17.
