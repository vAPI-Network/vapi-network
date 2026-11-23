---
title: "Remote MCP server for vAPI Network"
description: "The vAPI Network remote MCP server uses Streamable HTTP for authenticated discovery; payment keys stay with the buyer."
order: 10
---

The vAPI Network remote MCP server provides authenticated discovery over Streamable HTTP while payment keys stay with the buyer.

vAPI's hosted MCP gives authenticated clients free discovery tools over Streamable HTTP.

## Endpoint

The production MCP endpoint is:

```text
https://api.vapinetwork.ai/mcp
```

The transport is stateless and uses bearer authentication. The public API also exposes a health probe:

```text
https://api.vapinetwork.ai/mcp/health
```

Browser connectors use OAuth. Claude Code and direct bearer integrations may use a `vapi_sk_*` API key managed through Connect's Advanced section.

## Capabilities

The hosted server exposes three free tools:

| Tool           | What it does                                             |
| -------------- | -------------------------------------------------------- |
| `echo`         | Verifies the connection.                                 |
| `call.search`  | Discovers marketplace APIs, services, and open requests. |
| `call.inspect` | Returns a listing's executable request contract.         |

Hosted `call.inspect` accepts first-party Call API refs returned by `call.search`. Mirrored catalog and Tasks results cannot be inspected there.

`call.search` hides outage APIs by default; set `includeOutage: true` to include them. Search can return health and cheaper or healthier alternatives. `call.inspect` includes response schemas and example requests when available.

The hosted server records per-tool usage. It does not provide the local client's wallet, receipt, or payment tools.

## Add vAPI to Claude

Open this link while signed in to claude.ai:

[Add vAPI to Claude](https://claude.ai/customize/connectors?modal=add-custom-connector&connectorName=vAPI&connectorUrl=https%3A%2F%2Fapi.vapinetwork.ai%2Fmcp)

Claude opens the "Add custom connector" dialog with the name `vAPI` and the URL `https://api.vapinetwork.ai/mcp` filled in. Confirm the dialog, then sign in to vAPI and approve the connection. You can also add it by hand under **Settings → Connectors → Add custom connector**.

Claude lists the connector as "Custom". Claude labels every connector added by URL that way; it works the same as a directory connector.

## Interactive results in Claude

The hosted server shows Call results as interactive cards in Claude on the web, in Claude Desktop and in the Claude mobile apps.

- **Search** (`call.search`): a row of cards, one per listing, with logo, price, chain and health. Click **Inspect** on a card to open that listing in place.
- **Inspect** (`call.inspect`): one listing card with price, chain, the first endpoint and the last health check, plus buttons to copy the `vapi pay` command and open the listing in the console.
- While a tool runs, the card shows a placeholder with the pulsing vAPI mark.
- Cards follow Claude's light or dark theme.

The first time a card appears, Claude asks whether it may display the app. Choose **Allow** or **Always allow**. All three hosted tools are read-only, so they run without a confirmation prompt.

Claude Code and MCP clients without interactive app support get the same results as text. No setup changes are needed.

## Payments stay with the buyer

The hosted MCP never holds a buyer key and never signs for a buyer. It has no paid tool. To pay a provider, use a buyer-controlled x402 client, such as the local [`vapi mcp`](/agents/in-your-ai-app/use-vapi-in-claude-cursor-and-codex/) server or the [SDK](/reference/sdk/sdk/), from the buyer's own wallet.

The local server keeps the encrypted payment key, spend ledger, and caps on the buyer's machine. The hosted MCP only handles the free discovery and inspection surface.

![Hosted and local MCP side by side. Your AI app, such as Claude, Cursor, Codex or any MCP client, can connect one server or both. The hosted MCP at api.vapinetwork.ai/mcp connects over Streamable HTTP with a bearer key or OAuth and offers three free tools: echo checks the connection, call.search finds APIs and services, and call.inspect returns a listing's request contract. It holds no buyer key, never signs and has no paid tool. The local vapi mcp server, started with npx -y vapi-network@latest mcp over stdio, or the SDK, runs on the buyer's machine as a buyer-controlled x402 client. It keeps the encrypted payment key, the spend ledger and receipts, and the per-call and per-day caps there, and can search, inspect and pay with call.pay within the account's caps. Only that local client pays provider APIs on Call, per request with x402 in exact USDC.](vapi-hosted-vs-local-mcp-light.svg)
![Hosted and local MCP side by side. Your AI app, such as Claude, Cursor, Codex or any MCP client, can connect one server or both. The hosted MCP at api.vapinetwork.ai/mcp connects over Streamable HTTP with a bearer key or OAuth and offers three free tools: echo checks the connection, call.search finds APIs and services, and call.inspect returns a listing's request contract. It holds no buyer key, never signs and has no paid tool. The local vapi mcp server, started with npx -y vapi-network@latest mcp over stdio, or the SDK, runs on the buyer's machine as a buyer-controlled x402 client. It keeps the encrypted payment key, the spend ledger and receipts, and the per-call and per-day caps there, and can search, inspect and pay with call.pay within the account's caps. Only that local client pays provider APIs on Call, per request with x402 in exact USDC.](vapi-hosted-vs-local-mcp-dark.svg)

_Discovery can be hosted. Payment keys and signing stay on the buyer's machine. Orange marks where USDC moves._

Owner sign-in supports email, Google and wallets; see [Account and sign-in](/account-and-sign-in/).
Finish setup and confirmed vAPI ID before approval. Own-wallet accounts may require wallet proof.
Embedded owners can approve OAuth without external-wallet SIWE.
Terminal-capable agents can follow the [agent-start guide](/start-with-your-agent/); browser-only agents use the hosted connector.

## Next

- [Use vAPI in Claude, Cursor and Codex](/agents/in-your-ai-app/use-vapi-in-claude-cursor-and-codex/)
- [SDK](/reference/sdk/sdk/)
- [How wallets work](/agents/wallets/how-wallets-work/)

Checked on 2026-11-17.
