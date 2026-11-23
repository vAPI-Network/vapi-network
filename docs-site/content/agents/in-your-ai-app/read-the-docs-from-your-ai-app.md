---
title: "Read the docs from your AI app"
description: "AI apps can search and read public vAPI Network docs through the docs MCP server, Markdown pages, or llms.txt without a wallet."
order: 11
---

This page shows how an AI app or agent can search and read these docs by itself, for anyone who wants answers inside Claude, Cursor, or their own code.

The docs are public and need no account, wallet, or payment. There are two ways in, from the most convenient to the most basic.

The released vAPI client can also search and read them directly. Use these commands, or the local MCP tools `docs.search` and `docs.read`:

```bash
vapi docs "How do Router keys work?"
vapi docs search "Router keys"
vapi docs read https://docs.vapinetwork.ai/router/access-and-keys
```

## Add the docs as an MCP server

The docs site runs its own MCP server at `https://docs.vapinetwork.ai/mcp`. Both of its tools only read.

| Tool          | Input                                  | What it returns                                                                                      |
| ------------- | -------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `search_docs` | `query`, optional `limit` from 1 to 10 | The best matching sections, best first, each with its link, page title, heading and a snippet.       |
| `get_page`    | `path`                                 | The full page as markdown. The path is a link from `search_docs`, or a page path such as `/router/`. |

In Claude Code:

```bash
claude mcp add --transport http vapi-docs https://docs.vapinetwork.ai/mcp
```

In Cursor, add this to `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "vapi-docs": { "url": "https://docs.vapinetwork.ai/mcp" }
  }
}
```

Any other MCP client that supports Streamable HTTP can use the same URL. This server only reads docs. To search, pay, and use Router, add the local server from [Use vAPI in Claude, Cursor and Codex](/agents/in-your-ai-app/use-vapi-in-claude-cursor-and-codex/) next to it.

## Read pages as markdown

Add `.md` to any page URL, in place of the last slash, to get the page as markdown.

```bash
curl https://docs.vapinetwork.ai/three-ways-to-use-vapi.md
```

[`llms.txt`](https://docs.vapinetwork.ai/llms.txt) lists every page with its title, the link to its markdown, and a one-line description.

## Next

- [Use vAPI in Claude, Cursor and Codex](/agents/in-your-ai-app/use-vapi-in-claude-cursor-and-codex/)
- [Hosted MCP](/agents/in-your-ai-app/hosted-mcp/)
- [Three ways to use vAPI](/three-ways-to-use-vapi/)

Checked on 2026-10-30.
