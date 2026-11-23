---
title: "Quickstart: your first paid call"
description: "Make your first paid x402 API call in five minutes with MCP, the vapi CLI, the TypeScript SDK, or curl and the vAPI console."
order: 1
---

Pick the path you already use. Every tab has the same four steps, so you can switch later without relearning anything.

1. **Install** the client.
2. **Fund a wallet** with a few dollars of USDC on Base.
3. **Find an API** and read its live price. This is free.
4. **Pay and call.** Your wallet signs one payment for the quoted amount, and the API answers.

You need Node.js 22 or later for the MCP, CLI and SDK paths, and a supported payment wallet for the console path, including the email/Google vAPI wallet for EVM offers. The examples cost $0.01 or less per call. You do not need ETH for gas: an x402 payment is a signed USDC authorization, and the provider settles it.

The latest released client is 0.14.0. Update before following this guide:

```bash
npm i -g vapi-network@latest
```

## MCP

Let Claude, Cursor or Codex find and pay APIs for you. The MCP server runs on your machine and pays from a wallet that stays there.

## 1. Install and create a wallet

```bash
npm i -g vapi-network
vapi init
```

Already installed? Run `npm i -g vapi-network@latest` to update; the CLI tells you when a newer version is out.

`vapi init` creates an encrypted wallet on your machine and prints its address:

```text
vAPI wallet created. Its encrypted key stays on this machine.
Address: 0x782F38a2cADbeA094bc89895A1edf965901A7600
Fund the EVM address with USDC and a little ETH for gas on Base mainnet (eip155:8453).
```

Run `vapi backup` once, in your own terminal, and write the 12 words down. vAPI cannot recover them.

## 2. Fund the wallet

```bash
vapi fund
```

This opens the funding page for your address. Pay by card through Coinbase, send USDC from another wallet, or bridge from another chain. You can also send USDC on Base straight to the address from step 1. Check the balance with `vapi balance`.

## 3. Add the server to your AI app

```bash
vapi mcp install claude-desktop    # or: claude-code, cursor, codex
```

`claude-desktop` writes the Claude Desktop config, `cursor` writes `.cursor/mcp.json` in the current folder, and `codex` writes `~/.codex/config.toml`. The `claude-code` target registers the server through Claude Code's CLI; `claude` remains an alias for Claude Desktop. The entry runs `npx -y vapi-network@latest mcp`. Running the install command again rewrites an older entry to this form. The command prints the file it touched (file targets):

```text
Updated /Users/you/Library/Application Support/Claude/claude_desktop_config.json.
Restart Claude Desktop, then ask it: "Search vAPI for a weather API."
```

If the wallet is not linked to your vAPI dashboard yet, the command then asks `Link main to your vAPI dashboard? [Y/n]`. Press Enter, approve in the browser from your ready vAPI account, and the agent's payments show up under My agents and Usage in the console. Skip it with `--no-link`; you can link later with `vapi login`.

For other MCP clients, add this server entry to the MCP config:

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

## 4. Ask your agent

Restart the app, then ask:

> Find a weather API on vAPI Call and call it for Amsterdam. Spend at most $0.05.

The agent uses three tools in order:

| Tool           | What it does                                                                            | Costs money            |
| -------------- | --------------------------------------------------------------------------------------- | ---------------------- |
| `call.search`  | Finds listings for a query                                                              | No                     |
| `call.inspect` | Reads a listing's request contract, verification and the registry's last observed quote | No                     |
| `call.pay`     | Signs the payment within your caps and sends the request                                | Yes, the quoted amount |

`call.search` can show health and cheaper or healthier alternatives. In Claude Desktop, search and inspect can render interactive MCP Apps results. `call.inspect` shows stored registry data, including response schemas and example requests when available. `call.pay` fetches a fresh quote, so give it an explicit `maxPriceUsd`.

The wallet's spend caps bound every payment: $0.10 per call and $1.00 per day by default. Change them with:

```bash
vapi accounts caps main --per-call 0.05 --per-day 1
```

> [!NOTE]
> The hosted MCP at `https://api.vapinetwork.ai/mcp` only searches and inspects, with interactive results in compatible MCP Apps clients. Use Add to Claude on [Connect](https://api.vapinetwork.ai/connect) to add it. It holds no key and has no paid tool. Payments run on your machine through the local server above.

Every paid call writes a receipt you can list with `vapi receipts`.

### CLI

Search and pay from your terminal, with a wallet that stays on your machine.

## 1. Install and create a wallet

```bash
npm i -g vapi-network
vapi init
```

Already installed? Run `npm i -g vapi-network@latest` to update; the CLI tells you when a newer version is out.

No global install? Prefix every command with `npx vapi-network`, for example `npx vapi-network init`.

`vapi init` creates an encrypted wallet on your machine and prints its address:

```text
vAPI wallet created. Its encrypted key stays on this machine.
Address: 0x782F38a2cADbeA094bc89895A1edf965901A7600
Fund the EVM address with USDC and a little ETH for gas on Base mainnet (eip155:8453).
```

Run `vapi backup` once and write the 12 words down. vAPI cannot recover them.

## 2. Fund the wallet

```bash
vapi fund
```

This opens the funding page for your address. Pay by card through Coinbase, send USDC from another wallet, or bridge from another chain. You can also send USDC on Base straight to the address from step 1.

```bash
vapi balance
```

```text
Wallet: main (0x782F38a2cADbeA094bc89895A1edf965901A7600)
Base mainnet (eip155:8453): 5 USDC (5000000 atomic)
```

## 3. Find an API and read its terms

```bash
vapi search "weather"
```

Each result is one listing. The first column is its `ref`, the tag says where it comes from, and the fee line discloses the payout terms. Call takes no fee and providers are paid directly; legacy splitter listings keep their disclosed fee until migrated:

```text
https://weather.cyberwarex.com/forecast	api	[external] weather.cyberwarex.com/forecast
  Weather forecast for a location (global, keyless): current conditions, an hourly series (up to 48h) and a daily summary (up to 10 days). Pass lat+lon, or a place name. No API key.
  Fee: No network fee
```

Inspect the listing you want. This is free and shows the request contract, verification state and the registry's last observed quote. `vapi pay` fetches a fresh quote, so set an explicit maximum with `--max`:

```bash
vapi inspect <ref>
```

```text
Verification: external
Fee: No network fee
{
  "name": "call",
  "method": "GET",
  "url": "https://weather.cyberwarex.com/forecast",
  "price": "Live x402 quote",
  ...
}
```

## 4. Pay and call

```bash
vapi pay <ref> --max 0.05
```

`--max` is the most you agree to pay for this call. The client reads the live 402 quote, refuses to sign if the quote is above `--max` or above your caps, signs the USDC authorization, and sends the request again with the payment attached. The result is JSON:

```json
{
  "status": 200,
  "body": { "...": "the API's response" },
  "payment": {
    "network": "eip155:8453",
    "amountUsd": "0.002",
    "payTo": "0x058D0Cc5CC97e61e8A9f38D6d6365bce525921B2",
    "settlement": { "...": "the provider's settlement response" }
  }
}
```

Pass request inputs when the contract asks for them, for example `vapi pay <ref> --method POST --body '{"city":"Amsterdam"}' --content-type application/json --max 0.05`. Run `vapi inspect <ref>` to see what an endpoint expects.

The wallet's spend caps bound every payment: $0.10 per call and $1.00 per day by default. Change them with:

```bash
vapi accounts caps main --per-call 0.05 --per-day 1
```

Every paid call writes a local receipt:

```bash
vapi receipts
```

```text
Wallet: main (0x782F38a2cADbeA094bc89895A1edf965901A7600)
2026-10-15T09:41:12.000Z	succeeded	GET https://weather.cyberwarex.com/forecast (https://basescan.org/tx/0x...)
```

If a paid call loses its response, `vapi pay --resume <receipt-id>` reads the chain and tells you whether it settled. It never pays again.

### SDK

Pay APIs from your own TypeScript code. The SDK uses the same local wallet, caps and receipts as the CLI.

## 1. Install and create a wallet

```bash
npm i vapi-network
npx vapi-network init
```

`init` creates an encrypted wallet on your machine and prints its address. If you already ran `vapi init`, skip it. Run `npx vapi-network backup` once and write the 12 words down.

## 2. Fund the wallet

```bash
npx vapi-network fund
```

This opens the funding page for your address. Pay by card through Coinbase, send USDC from another wallet, or bridge from another chain. You can also send USDC on Base straight to the address from step 1.

## 3. Find an API and read its terms

Create `first-call.ts`:

```ts
// npm i vapi-network
import { createVapiClient } from "vapi-network";

const vapi = await createVapiClient({ account: "main" });

const apis = await vapi.call.search("weather");
const terms = await vapi.call.inspect("<ref>");
const result = await vapi.call.pay({ id: "<ref>", maxPriceUsd: 0.05 });
console.log(result.body);
```

`search` returns an array of listings. Each has a `ref`, a `card` with title and summary, and `group`, `fee` and `verification` fields. Replace both `<ref>` placeholders with the one you want, for example `apis[0].ref`. `inspect` is free and returns the request contract, verification state and the registry's last observed quote (price, network and payee). Paying fetches a fresh quote, so set an explicit `maxPriceUsd`.

## 4. Pay and call

```bash
npx tsx first-call.ts
```

`pay` reads the live 402 quote, refuses if it is above `maxPriceUsd` or above the wallet's caps, signs the USDC authorization, and sends the request with the payment. The result has `status`, `body`, `payment` with `network`, `amountUsd` and `payTo`, and `verification` for a listed API.

For an endpoint that needs inputs, pass them on the same call:

```ts
const result = await vapi.call.pay({
  id: "<ref>",
  method: "POST",
  contentType: "application/json",
  body: { city: "Amsterdam" },
  maxPriceUsd: 0.05,
});
```

`pay` also accepts `url` instead of `id` for a concrete endpoint, `endpoint` for a listing with several endpoints, and `expectedPayTo` to refuse any quote that pays a different address.

The wallet's spend caps bound every payment: $0.10 per call and $1.00 per day by default. Change them in the terminal with `vapi accounts caps main --per-call 0.05 --per-day 1`. Receipts are in `vapi receipts`.

### curl + console

See how Call works underneath. Search and prices are plain HTTP, so you can read them with curl. Paying needs a wallet signature, so the last step moves to the console.

## 1. Install

Nothing. You need curl and a browser.

## 2. Fund a wallet

For this Base example, use USDC on Base in your email/Google vAPI wallet or a browser wallet. The console also pays Arc mainnet and Solana mainnet offers with a wallet and USDC on the quoted network; see [Pay in the console](/call/use-call/pay-in-the-console/).

## 3. Find an API and read its price

Search the public catalog:

```bash
curl 'https://api.vapinetwork.ai/api/call/discovery?q=weather&kinds=api&limit=5'
```

Each item has a `ref`, a `card` with the title, summary and price facts, and `group`, `fee` and `verification` fields. The `action.href` is the console page for that listing:

```json
{
  "protocol": "vapi.marketplace.discovery/1",
  "items": [
    {
      "ref": "https://weather.cyberwarex.com/forecast",
      "card": {
        "title": "weather.cyberwarex.com/forecast",
        "facts": [
          { "label": "Price", "value": "$0.002" },
          { "label": "Network", "value": "eip155:8453" },
          { "label": "Method", "value": "GET" }
        ]
      },
      "group": "external",
      "fee": { "bps": 0, "label": "No network fee" },
      "verification": "none",
      "action": {
        "type": "invoke_api",
        "href": "/call/invoke?url=https%3A%2F%2Fweather.cyberwarex.com%2Fforecast&method=GET&network=eip155%3A8453&sig=..."
      }
    }
  ]
}
```

Call an API without paying. It answers 402 with its price:

```bash
curl -i '<api-url>'
```

```http
HTTP/2 402
content-type: application/json
payment-required: eyJ4NDAyVmVyc2lvbiI6IDIsICJyZXNvdXJjZSI6IHsidXJsIjogImh0dHBzOi8v...
```

The `payment-required` header is base64. Decoded, it is the x402 offer:

```json
{
  "x402Version": 2,
  "resource": { "url": "https://weather.cyberwarex.com/forecast", "mimeType": "application/json" },
  "accepts": [
    {
      "scheme": "exact",
      "network": "eip155:8453",
      "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      "amount": "2000",
      "payTo": "0x058D0Cc5CC97e61e8A9f38D6d6365bce525921B2",
      "maxTimeoutSeconds": 300,
      "extra": { "name": "USD Coin", "version": "2" }
    }
  ]
}
```

| Field               | Meaning                                                                                 |
| ------------------- | --------------------------------------------------------------------------------------- |
| `scheme`            | `exact`: you authorize exactly this amount. Call pays `exact` offers only.              |
| `network`           | The chain, as a CAIP-2 id. `eip155:8453` is Base.                                       |
| `asset`             | The token contract. This is USDC on Base.                                               |
| `amount`            | The price in the token's smallest unit. USDC has 6 decimals, so `2000` is $0.002.       |
| `payTo`             | The address that receives the payment. Your wallet signs for this address and no other. |
| `maxTimeoutSeconds` | How long the provider gives the payment to settle.                                      |
| `extra`             | The token's EIP-712 domain, which your wallet needs to sign the authorization.          |

Some providers put the same offer in the JSON body as well; a v2 client reads the header. This offer is the source of truth for price, network, asset and payee. The directory shows the last offer vAPI saw.

## 4. Pay and call in the console

curl alone cannot complete the payment. The second request needs a `PAYMENT-SIGNATURE` header carrying an EIP-3009 authorization signed by your wallet. Sign it yourself, use the CLI, MCP or SDK tabs, or let the console request your payment approval:

1. Open [api.vapinetwork.ai/call](https://api.vapinetwork.ai/call) and open the API. A listed API lives at `/call/<slug>`, for example [/call/the-graph](https://api.vapinetwork.ai/call/the-graph). An external listing opens from its `action.href`.
2. Fill in the request inputs and choose **Check live price**. This sends the unpaid request and shows the 402 offer: amount, network, payee and the exact request body. Nothing is paid yet.
3. Sign in with email, Google or a wallet and finish setup and confirmed vAPI ID, then choose Pay … USDC and call.
4. Your external wallet shows one typed-data signature for exactly that amount to exactly that payee. There is no gas and no approval transaction. Sign it.
5. The console sends the request again with the payment attached, the provider settles it, and the page shows the response and the settlement reference. Choose **View result**.

Your wallet signs; vAPI never holds funds, never signs for you, and does not relay the request.

## After your first call

- [What is Call](/call/): who the three parties are, and what vAPI does and never does.
- [Find APIs](/call/use-call/find-apis/): groups, verification and liveness, and how to include unverified listings.
- [Pay with the CLI, MCP and SDK](/call/use-call/pay-with-vapi/): endpoints, request bodies, caps and named accounts.
- [Receipts and retries](/call/use-call/receipts-and-retries/): what a receipt records and how to check an uncertain payment.
- [Query The Graph](/call/providers/the-graph/): a full worked example against a Verified Provider.
- [Provider guides](/call/providers/): one page per provider on Call, with its price and a worked example.

Owner approval supports wallet, email and Google sign-in. Finish account setup and confirmed vAPI ID first.
An own-wallet account may require wallet proof; embedded email/Google owners can approve without external-wallet SIWE.

Email and Google sign-in can create a vAPI wallet for supported EVM payments.
Its payment approval appears in the vAPI confirmation sheet; Solana requires a Solana payment wallet.
See [Pay in the console](/call/use-call/pay-in-the-console/) for sign-in and funding recovery.

Checked on 2026-11-17.
