---
title: "Birdeye"
description: "Read Solana token prices, candles, holders, trades and trader rankings from Birdeye through vAPI Call: $0.003 in USDC on Solana per request over x402, paid…"
order: 9
---

Birdeye Data indexes Solana markets: token prices, OHLCV candles, liquidity, holders, trades, trending tokens and trader rankings. On Call, Birdeye is a Verified Provider. You pay $0.003 in USDC on Solana per request, straight to Birdeye's own x402 endpoint, with no API key and no account at Birdeye.

Birdeye settles on Solana only. The console pays it from a Solana wallet. The `vapi` CLI, SDK and MCP server, version 0.14.0, do not pay on Solana yet; they refuse the listing before signing.

| Fact              | Value                                                                                     |
| ----------------- | ----------------------------------------------------------------------------------------- |
| Listing           | [api.vapinetwork.ai/call/birdeye](https://api.vapinetwork.ai/call/birdeye), ref `birdeye` |
| Group and tier    | Verified Provider, verified by vAPI                                                       |
| Price             | $0.003 per request, from the live offer                                                   |
| Asset and network | USDC on Solana (`solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`)                                |
| Protocol          | x402 v2, `exact` scheme                                                                   |
| Payee             | `3Wuj6VjJXuCmQZjGRhW56xbEk6TzCyMEUVRZgLBYNE2Z` (Birdeye)                                  |
| vAPI network fee  | None                                                                                      |

## How a request is paid

1. You send a `GET` with query parameters to Birdeye's x402 API, `public-api.birdeye.so/x402/...`.
2. Birdeye answers 402 with its offer: $0.003 in USDC on Solana, with Birdeye's fee payer named in the offer.
3. Your Solana wallet signs a USDC transfer for that amount. Birdeye's fee payer covers the Solana network fee.
4. Birdeye settles the transfer and returns the data.
5. The console shows the result and the settlement reference.

## Endpoints

The listing has 20 endpoints, a curated set of Birdeye's API. Every endpoint takes a `GET` with query parameters. `address` is a token mint, except for `pair_overview`, where it is a pool address.

| Endpoint              | Data                                             | Query parameters                                                                         |
| --------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| `price`               | Price of one token                               | `address`                                                                                |
| `multi_price`         | Prices for several tokens                        | `list_address`, comma-separated mints                                                    |
| `history_price`       | Price history                                    | `address`, `address_type` (`token` or `pair`), `type` (interval), `time_from`, `time_to` |
| `ohlcv`               | OHLCV candles for a token                        | `address`, `type` (interval), `currency`, `time_from`, `time_to`                         |
| `token_overview`      | Price, liquidity, market cap, volume and holders | `address`                                                                                |
| `token_security`      | Authorities, top-holder share and creator        | `address`                                                                                |
| `token_creation_info` | When and by whom a token was created             | `address`                                                                                |
| `token_metadata`      | Name, symbol, decimals and links                 | `address`                                                                                |
| `token_market_data`   | Price, liquidity, supply and market cap          | `address`                                                                                |
| `token_holders`       | Top holders of a token                           | `address`, `offset`, `limit` (up to 100)                                                 |
| `token_trades`        | Recent trades of a token                         | `address`, `offset`, `limit`, `sort_by`, `sort_type`, `tx_type`                          |
| `token_list`          | Tokens ranked by liquidity, volume or market cap | `sort_by`, `sort_type`, `offset`, `limit`                                                |
| `token_trending`      | Trending tokens                                  | `sort_by`, `sort_type`, `interval`, `offset`, `limit`                                    |
| `new_listing`         | Newly listed tokens                              | `limit`, `time_to`, `meme_platform_enabled`                                              |
| `top_traders`         | Top traders of a token                           | `address`, `time_frame`, `sort_by`, `sort_type`, `offset`, `limit`                       |
| `markets`             | Pools that trade a token                         | `address`, `time_frame`, `sort_by`, `sort_type`, `offset`, `limit`                       |
| `pair_overview`       | Overview of one trading pair                     | `address` (pool)                                                                         |
| `search`              | Tokens and markets by name, symbol or address    | `keyword`, `chain`, `target`, `sort_by`, `sort_type`                                     |
| `gainers_losers`      | Top gaining and losing traders                   | `type` (`today`, `yesterday`, `1W`), `sort_by`, `sort_type`, `offset`, `limit`           |
| `smart_money_tokens`  | Tokens that smart-money traders trade            | `interval`, `trader_style`, `sort_by`, `sort_type`, `offset`, `limit`                    |

Times are Unix seconds. Each endpoint's URL in the listing carries a working example query. Most examples ask about wrapped SOL, `So11111111111111111111111111111111111111112`. The `price` endpoint:

```text
https://public-api.birdeye.so/x402/defi/price?address=So11111111111111111111111111111111111111112
```

Check an endpoint's offer for free:

```bash
vapi check 'https://public-api.birdeye.so/x402/defi/price?address=So11111111111111111111111111111111111111112'
```

```text
Check: GET https://public-api.birdeye.so/x402/defi/price?address=So11111111111111111111111111111111111111112 — HTTP 402
  pass  status      HTTP 402 Payment Required.
  warn  transport   The offer is only in the PAYMENT-REQUIRED header; x402 v1 clients and several indexers read the JSON body. [offer_header_only]
  pass  version     Declares x402 version 2.
  pass  fields      Every field x402 v2 requires is present and well-typed.
  pass  scheme      1 of 1 accepted option uses the exact scheme.
  pass  asset       Pays canonical USDC on solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp.
  pass  pay_to      Every exact option names a well-formed payTo address.
  pass  timeout     maxTimeoutSeconds 60.
  pass  extensions  Advertises bazaar, payment-identifier.
  warn  discovery   No discovery document at https://public-api.birdeye.so/.well-known/x402: HTTP 301. [discovery_missing]
  warn  openapi     No OpenAPI document with paths from https://public-api.birdeye.so/x402/defi/openapi.json through https://public-api.birdeye.so/openapi.json, or in same-origin service-desc links from https://public-api.birdeye.so/.well-known/api-catalog. [openapi_missing]
8 passed, 3 warnings, 0 failed.
```

## Before you start

You need a Solana browser wallet, such as Phantom, Solflare or Backpack, holding a little USDC on Solana mainnet. One request costs $0.003. You do not need SOL: Birdeye's fee payer pays the Solana network fee. A Base wallet cannot pay this listing, and the console asks for a Solana wallet before it pays.

## In the console

1. Open [api.vapinetwork.ai/call/birdeye](https://api.vapinetwork.ai/call/birdeye) and choose an endpoint, for example `price`.
2. Choose **Check live price**. The quote shows $0.003, Solana, and Birdeye's address as the payee. The console sends the endpoint's example query from its URL; for `price`, that is wrapped SOL.
3. Choose **Connect a Solana wallet to continue** and pick your wallet.
4. Choose **Pay 0.003 USDC and call**, and approve the transfer your wallet shows.
5. Choose **View result** to read the JSON response and its settlement reference.

## With the CLI, SDK and MCP

The `vapi` client 0.14.0 does not sign Solana payments. `vapi inspect`, `vapi pay`, `vapi.call.pay` and the MCP `call.pay` tool all stop before signing and leave your wallet untouched:

```bash
vapi pay birdeye --endpoint price --max 0.01
```

```text
Solana payments are not supported in this version of vAPI yet; they arrive in a later release. This listing pays on solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp.
```

`vapi check` works on any Birdeye URL, as shown above, because it reads the 402 offer without paying. Until the client adds Solana, pay Birdeye from the console, or call its x402 API from any x402 client that pays USDC on Solana.

## Price

$0.003 per request on every endpoint in the 2026-10-20 sample, with no vAPI fee. Birdeye's live 402 offer is the price; the console shows it before you approve the transfer.

## Limits and errors

| Problem                                                         | What to do                                                                                       |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| "Solana payments are not supported in this version of vAPI yet" | The `vapi` CLI, SDK or MCP server cannot pay this listing. Use the console with a Solana wallet. |
| "No Solana wallet found" in the console                         | Install Phantom, Solflare or Backpack, add USDC on Solana, and reload the listing.               |
| "Connect a Solana wallet before approving payment"              | Connect a Solana wallet. A Base wallet cannot pay this listing.                                  |

## Learn more

- [Birdeye Data documentation](https://docs.birdeye.so)
- [Pay in the console](/call/use-call/pay-in-the-console/)
- [Networks and schemes](/call/reference/networks-and-schemes/)

Checked on 2026-11-17.
