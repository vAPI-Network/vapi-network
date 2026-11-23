---
title: "Pay with the CLI, MCP and SDK"
description: "Search, inspect and pay x402 APIs from a local wallet with the vapi CLI, the MCP server for Claude, Cursor and Codex, or the TypeScript SDK. One wallet, the…"
order: 5
---

The `vapi-network` package is one open-source client with three doors: the `vapi` command, a local MCP server, and a TypeScript SDK. They share one encrypted wallet on your machine, the same spend caps, and the same receipts. Start with one and add another later.

New here? The [Quickstart](/call/quickstart/) walks each door through a first paid call. This page is the detail behind it.

The latest released client is 0.14.0. Update before following this guide:

```bash
npm i -g vapi-network@latest
```

## Set up once

```bash
npm i -g vapi-network
vapi init
vapi fund
```

`vapi init` creates the vault and the account `main`. `vapi fund` opens the funding page for its address. Run `vapi backup` once, in a terminal, and keep the 12 words; vAPI cannot recover them.

Spend caps belong to the account and are applied before anything is signed. The defaults are $0.10 per call and $1.00 per UTC day. Change them at any time:

```bash
vapi accounts caps main --per-call 0.05 --per-day 1
```

`vapi accounts` lists every account with its address, balance and caps.

## Search

```bash
vapi search "weather"
vapi search "onchain data" --network eip155:8453 --limit 5
vapi search "weather" --include-unverified
vapi search "weather" --include-outage
vapi search "weather" --json
```

Each result shows the listing `ref`, its group tag (`[vapi]`, `[added]`, `[partner]` or `[external]`), its verification tag (`[verified]`, `[requested]` or `[unverified]`), the summary and the fee line. Health and cheaper or healthier alternatives appear when supplied by the registry. Outage results are hidden unless you pass `--include-outage`. By default search returns verified listings plus the external mirror; `--include-unverified` adds self-listed APIs that passed the automated probe but were not reviewed. See [Find APIs](/call/use-call/find-apis/).

## Inspect

```bash
vapi inspect <ref>
vapi inspect the-graph --endpoint uniswap_v3_base
```

Inspecting is free and needs no wallet. It prints the verification state, the fee, liveness and conformance when vAPI has measured them, and the endpoint's method, URL, request schema, optional response schema and example request, and the registry's last observed quote (price, network and payee). Paying fetches a fresh quote, so set an explicit maximum with `--max` or `maxPriceUsd`. A listing with several endpoints asks you to name one with `--endpoint`.

## Pay

```bash
vapi pay <ref> --max 0.05 [--timeout <seconds>]
```

| Option                        | What it does                                                                                                |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `--max <usd>`                 | The most you agree to pay for this call. The client refuses to sign a higher live offer.                    |
| `--timeout <seconds>`         | Sets the paid-response wait to an integer from 1 to 300 seconds, capped at the offer's `maxTimeoutSeconds`. |
| `--endpoint <name>`           | Picks one endpoint of a listing with several.                                                               |
| `--method <method>`           | Sets the HTTP method when the contract allows more than one.                                                |
| `--body '<json>'`             | The request body.                                                                                           |
| `--content-type <type>`       | The request content type, usually `application/json`.                                                       |
| `--expected-pay-to <address>` | Refuse any offer that pays a different address.                                                             |
| `--network <caip2>`           | Pick one network when the offer accepts several.                                                            |
| `--account <name>`            | Pay from a named account instead of the default.                                                            |
| `--json`                      | Print the result as JSON only.                                                                              |

A worked POST:

```bash
vapi pay the-graph \
  --endpoint uniswap_v3_base \
  --method POST \
  --content-type application/json \
  --body '{"query":"{ pools(first: 5, orderBy: totalValueLockedUSD, orderDirection: desc) { id totalValueLockedUSD } }"}' \
  --max 0.05
```

`vapi pay` also takes a URL instead of a listing ref, for any x402 endpoint, listed or not:

```bash
vapi pay https://weather.cyberwarex.com/forecast?place=Amsterdam --max 0.05
```

The client reads the live 402 offer, checks it against `--max` and the account's caps, signs the USDC authorization, sends the request again with the payment, and prints the result as JSON: `status`, `body`, `payment` with `network`, `amountUsd` and `payTo`, and `verification` for a listed API. When the listing is not verified, one line above the result says so.

By default, the client uses the offer's `maxTimeoutSeconds` for the paid response, with a minimum of 30 seconds and a maximum of 120 seconds. Use `--timeout` to change this wait, capped at the offer's `maxTimeoutSeconds`. The unpaid 402 probe waits at most 30 seconds.

If a paid call loses its response or times out, the client reports `settlement_unknown` and names its receipt. `vapi pay --resume <receipt-id>` reads the chain and tells you whether it settled, without paying again. See [Receipts and retries](/call/use-call/receipts-and-retries/).

## MCP: Claude, Cursor and Codex

The local MCP server gives your AI app the same three steps as tools. It runs on your machine and pays from the same wallet, within the same caps.

```bash
vapi mcp install claude-desktop    # or: claude-code, cursor, codex
```

`claude-desktop` writes the Claude Desktop config, `cursor` writes `.cursor/mcp.json` in the current folder, and `codex` writes `~/.codex/config.toml`. The `claude-code` target registers the server through Claude Code's CLI; `claude` remains an alias for Claude Desktop. The entry runs `npx -y vapi-network@latest mcp`. Running the install command again rewrites an older entry to this form. Any other MCP client takes this server entry:

```json
{
  "mcpServers": {
    "vapi": {
      "command": "npx",
      "args": ["-y", "vapi-network@latest", "mcp"]
    }
  }
}
```

| Tool           | Input                                                                                                                            | Costs money            |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| `call.search`  | `query`, optional `network`, `limit`, `includeUnverified`, `includeOutage`                                                       | No                     |
| `call.inspect` | `id`, optional `endpoint`                                                                                                        | No                     |
| `call.pay`     | `id` or `url`, `maxPriceUsd`, optional `endpoint`, `method`, `body`, `contentType`, `network`, `expectedPayTo`, `timeoutSeconds` | Yes, the quoted amount |

`timeoutSeconds` is an integer from 1 to 300. It uses the same timeout rules as `--timeout`.

In Claude Desktop, `call.search` and `call.inspect` support interactive MCP Apps results, with text fallback when offline. A payment above the account's caps returns `spend_cap_exceeded`; it signs nothing and must not be retried automatically.

Give an agent its own capped account and pin the server to it:

```bash
vapi accounts add agent-claude --label "claude"
vapi accounts caps agent-claude --per-call 0.05 --per-day 2
```

```json
{
  "mcpServers": {
    "vapi": {
      "command": "npx",
      "args": ["-y", "vapi-network@latest", "mcp", "--account", "agent-claude"],
      "env": { "VAPI_WALLET": "agent-claude", "VAPI_NO_SECRETS": "1" }
    }
  }
}
```

No MCP tool returns a key, a recovery phrase or a passphrase. The full tool list, including wallet and receipt tools, is on [MCP server for Claude, Cursor and Codex](/agents/in-your-ai-app/use-vapi-in-claude-cursor-and-codex/).

> [!NOTE]
> The hosted MCP at `https://api.vapinetwork.ai/mcp` exposes `echo`, `call.search` and `call.inspect` as its three base tools. It holds no key and cannot pay. Use Add to Claude on [Connect](https://api.vapinetwork.ai/connect) for hosted search and inspection with interactive results. See [Hosted MCP](/agents/in-your-ai-app/hosted-mcp/).

## SDK

```bash
npm i vapi-network
```

```ts
import { createVapiClient } from "vapi-network";

const vapi = await createVapiClient({ account: "main" });

const apis = await vapi.call.search("weather", { includeUnverified: false });
const terms = await vapi.call.inspect(apis[0].ref);
const result = await vapi.call.pay({
  id: apis[0].ref,
  method: "GET",
  maxPriceUsd: 0.05,
});
console.log(result.status, result.body, result.payment);
```

- `createVapiClient({ account })` binds the client to a local account by name. It falls back to `VAPI_WALLET`, then the vault default. For a server process, pass an injected signing account instead of a local vault account.
- `call.search(query, { network?, includeUnverified? })` returns an array of discovery items with `ref`, `card`, `group`, `fee`, `verification`, and optional `health` and `alternatives`.
- `call.inspect(ref)` returns the request contract, verification and the registry's last observed quote for a single-endpoint listing or a concrete URL.
- `call.pay(input)` takes `id` or `url`, `maxPriceUsd`, and optional `endpoint`, `method`, `body`, `contentType`, `network`, `expectedPayTo` and `timeoutSeconds`. It returns `status`, `body`, `payment` and `verification`.

`timeoutSeconds` is an integer from 1 to 300. It uses the same timeout rules as `--timeout`.

Outage search is available in the CLI (`--include-outage`), local MCP and the HTTP API.

The SDK applies the account's caps exactly like the CLI and writes the same receipts. The full client surface, including Router and agents, is on [SDK](/reference/sdk/sdk/).

## Networks

Client 0.14.0 pays `exact` USDC offers on Base (`eip155:8453`) and Arc mainnet (`eip155:5042`). Base is enabled by default; enable Arc with `vapi init --networks base,arc` or `vapi accounts --enable arc`. Solana listings appear in search, but inspect/pay return `unsupported_network`. The console also pays Solana mainnet offers. See [Networks and schemes](/call/reference/networks-and-schemes/).

## Next

- [Find APIs](/call/use-call/find-apis/)
- [Receipts and retries](/call/use-call/receipts-and-retries/)
- [CLI reference](/reference/cli/cli-reference/)

Checked on 2026-11-17.
