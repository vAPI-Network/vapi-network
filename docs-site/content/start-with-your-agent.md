---
title: "Start with your agent"
description: "Give your agent one line to connect to vAPI and show you what it can do."
order: 4
---

Paste this line into a terminal agent such as Claude Code, Codex or Cursor, or a chat app such as ChatGPT or Claude.
The agent reads the maintained guide and walks you through it.
Use this line when you have no account yet:

```text
Read https://vapinetwork.ai/agent-start.md and follow it to set me up on vAPI.
```

If you already have an account, use this variant:

```text
I have a vAPI account. Read https://vapinetwork.ai/agent-start.md and follow it to connect yourself to it.
```

My agents, Connect and the setup Done step show the prompt ready to copy under Give this to your agent.
Done and Account Settings fill in your username; My agents and Connect use the variant without a username.
For a new account, follow [Account and sign-in](/account-and-sign-in/) for Google, email or wallet entry, setup and ID readiness.

## Part 1: Connect

The agent checks whether you have an account and whether it can run terminal commands.
The signed-in prompt already answers the account question.
Without an account, the agent sends you to sign in with Google, email or a wallet and waits until setup is done.

With terminal access, the agent checks the client version and existing link before asking you to run setup yourself.
You approve the link, compare the owner address, and let the agent install the local MCP tools.
Recovery material stays in your terminal; the agent must not read it.

Without a terminal, the agent uses the hosted MCP at [api.vapinetwork.ai/mcp](https://api.vapinetwork.ai/mcp).
You add the connector, sign in and approve it, then the agent checks the connection with the echo tool.
This connector can only search and inspect Call listings; it holds no wallet and cannot pay or use Router.
Paying, holding an agent wallet and using Router need the local CLI or MCP, or the console for supported actions.

## Part 2: Prove it works

The agent runs a free weather search through the CLI or hosted Call search tool.
It shows three results with their names, prices and verification tiers; nothing has been paid.
It offers a paid call only if you want one, explains the price, and asks before spending.

## Part 3: Explain vAPI

The agent gives one sentence per product, covering Call, Router, Stake, Agents, Tasks, Earn and vAPI ID.
It explains what each product does and its status.
It then asks what you want to do.

## Part 4: Let them choose

You choose one next action, and the agent follows that path with you.
The guide covers API calls, models, staking, agents, selling an API, rewards and reading more.
It also explains that Tasks is not open yet.

## When something fails

The agent checks the specific failure against the guide and the current CLI help or docs.
An expired or revoked link needs a new login; a paused agent needs to be resumed.
If a spending cap blocks a payment, you decide whether to change the cap.

## Finish

The agent states what is set up, which limits apply and how to undo the connection.
You can see and revoke linked agents on My agents.
The local logout command unlinks the computer.

Read the [live agent guide](https://vapinetwork.ai/agent-start.md) for the maintained steps.
For manual terminal setup, use [Quickstart](/quickstart/).

Checked on 2026-11-17.
