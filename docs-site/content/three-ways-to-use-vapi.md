---
title: "Three ways to use vAPI"
description: "The vapi-network CLI, local MCP server, and TypeScript SDK share one local wallet, payment limits, and receipts."
order: 2
---

> [!NOTE]
> Call, Router, Stake and Agents are live. Tasks is coming soon on production.

This page helps you choose between the terminal, your AI app, and your own code.

All three are the same open-source client. They share one local wallet, the same limits, and the same receipts, so you can start with one and add another later.

![Three ways into one open-source client. The terminal runs the vapi command on your machine, for example vapi pay with a maximum. Your AI app, Claude, Cursor or Codex, uses a local MCP server started with npx -y vapi-network@latest mcp. Your own code uses the TypeScript SDK through createVapiClient. All three share one local wallet whose keys stay on your machine, the same per-call and per-day caps, and the same receipts, one for every payment, so you can start with one way and add another later. Through the client you search, inspect and pay for APIs on Call with x402 in exact USDC, and use Router for model calls through Venice and 0G with Compute or prepaid balance keys. The public HTTP API sits under all three; call it directly from another language, or for discovery only.](vapi-three-ways-light.svg)
![Three ways into one open-source client. The terminal runs the vapi command on your machine, for example vapi pay with a maximum. Your AI app, Claude, Cursor or Codex, uses a local MCP server started with npx -y vapi-network@latest mcp. Your own code uses the TypeScript SDK through createVapiClient. All three share one local wallet whose keys stay on your machine, the same per-call and per-day caps, and the same receipts, one for every payment, so you can start with one way and add another later. Through the client you search, inspect and pay for APIs on Call with x402 in exact USDC, and use Router for model calls through Venice and 0G with Compute or prepaid balance keys. The public HTTP API sits under all three; call it directly from another language, or for discovery only.](vapi-three-ways-dark.svg)

_Three ways in, one client underneath._

| Way           | What it is                                         | Pick it when                                                                      | First step                                                                                          |
| ------------- | -------------------------------------------------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Terminal      | The `vapi` command on your machine.                | You want direct control or a command you can script.                              | [Quickstart](/quickstart/)                                                                          |
| Your AI app   | The local MCP server for Claude, Cursor, or Codex. | You want an assistant to search, inspect, pay, and use Router within your limits. | [Use vAPI in Claude, Cursor and Codex](/agents/in-your-ai-app/use-vapi-in-claude-cursor-and-codex/) |
| Your own code | The TypeScript SDK.                                | You are adding vAPI to a product or a custom agent.                               | [SDK](/reference/sdk/sdk/)                                                                          |

In Claude Desktop, MCP search and inspection support interactive results. For hosted discovery, use Add to Claude on [Connect](https://api.vapinetwork.ai/connect); payments use the local client. vAPI Desktop for macOS is listed as coming soon.

The public [HTTP API](/reference/http-api/api-overview/) sits under all three. Call it directly when you work in another language or only need discovery.

Give your agent one line with [Start with your agent](/start-with-your-agent/).

Continue with these guides.

| Guide or feature                                                                                    |
| --------------------------------------------------------------------------------------------------- |
| [Quickstart](/quickstart/)                                                                          |
| [Call quickstart: the same first call on every path](/call/quickstart/)                             |
| [Use vAPI in Claude, Cursor and Codex](/agents/in-your-ai-app/use-vapi-in-claude-cursor-and-codex/) |
| [Open source](/reference/open-source/)                                                              |

Checked on 2026-11-17.
