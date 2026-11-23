---
title: "Reference"
description: "vAPI Network reference docs cover the vapi-network CLI, MCP server, TypeScript SDK, HTTP API, and x402 payment contracts."
order: 12
---

> [!NOTE]
> Call, Router, Stake and Agents are live. Tasks is coming soon.

This tab is for developers who need exact commands, package interfaces, HTTP routes, or x402 contract details.

The open-source `vapi-network` client is published on npm at version 0.14.0. It provides the same local wallet through its CLI, MCP server, and SDK. The package includes `SKILL.md` with setup, discovery, payment, and recovery guidance for agents.

Clients ≤ 0.9.0 fail every search whose results include a Solana row. Update with `npm i -g vapi-network@latest`.

Install the client:

```bash
npm i -g vapi-network
```

vAPI Desktop source lives in the client monorepo at [vAPI-Network/vapi-network/apps/desktop](https://github.com/vAPI-Network/vapi-network/tree/main/apps/desktop). It has no released installer.

## Choose a reference

| Need                                | Reference                                                                                |
| ----------------------------------- | ---------------------------------------------------------------------------------------- |
| Use every client command            | [CLI reference](/reference/cli/cli-reference/)                                           |
| Add vAPI to TypeScript code         | [SDK](/reference/sdk/sdk/)                                                               |
| Call the public API directly        | [HTTP API overview](/reference/http-api/api-overview/)                                   |
| Inspect x402 behavior and contracts | [x402 on vAPI](/reference/x402/x402/)                                                    |
| Review the code and packages        | [Open source](/reference/open-source/)                                                   |
| Let an agent read these docs        | [Read the docs from your AI app](/agents/in-your-ai-app/read-the-docs-from-your-ai-app/) |

## Next

- [Open source](/reference/open-source/)
- [CLI reference](/reference/cli/cli-reference/)
- [HTTP API overview](/reference/http-api/api-overview/)

Checked on 2026-11-17.
