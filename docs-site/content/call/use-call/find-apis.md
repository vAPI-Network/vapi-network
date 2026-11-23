---
title: "Find APIs"
description: "Find x402 APIs on vAPI Call by what they do, in the console, with the vapi CLI, through MCP, or on the public discovery API, and read verification, fee and…"
order: 3
---

Search Call by what the API should do. Every result shows where the listing comes from, whether vAPI verified it, the disclosed payout fee, and when vAPI last saw it answer. Search and inspection are free.

## In the console

Open [api.vapinetwork.ai/call](https://api.vapinetwork.ai/call). The directory is one ranked catalogue with a card view and a table view. Tabs narrow it to **All**, **Verified Providers**, **Verified**, **External** or **Most used**; filters narrow it by network and method. Results sit under three headings in a fixed order: **vAPI APIs**, **Verified Providers**, **External**. The vAPI APIs section holds vAPI's own endpoints; Added APIs and unverified partner rows appear under External.

Open a listing to see its page: description, endpoints, the last live quote, verification, fee, health, liveness and on-chain identity. Inspection also includes response schemas and example requests when available. The **Live x402** label means the last check saw a valid 402 offer. From there you can [pay in the console](/call/use-call/pay-in-the-console/), copy a prompt for your agent, or copy the `curl` and `vapi` commands for the endpoint.

## With the CLI, MCP or SDK

The latest released client is 0.14.0. Update before following this guide:

```bash
npm i -g vapi-network@latest
```

```bash
vapi search "weather"
vapi search "onchain data" --network eip155:8453 --limit 5
vapi search "weather" --include-unverified
vapi search "weather" --include-outage
```

```text
https://weather.cyberwarex.com/forecast	api	[external] weather.cyberwarex.com/forecast
  Weather forecast for a location (global, keyless): current conditions, an hourly series (up to 48h) and a daily summary (up to 10 days). Pass lat+lon, or a place name. No API key.
  Fee: No network fee
the-graph	api	[partner] [verified] The Graph
  Query onchain data from 20 Subgraphs: Uniswap, Aave, Aerodrome, ENS, Curve, Lido and more. Each request costs $0.01 in USDC on Base over x402.
  Fee: No network fee
```

The first column is the `ref` you pass to `vapi inspect` and `vapi pay`. In MCP the same search is `call.search` with `query`, `network`, `limit`, `includeUnverified` and `includeOutage`; in the SDK it is `vapi.call.search(query, { network, includeUnverified })`. See [Pay with the CLI, MCP and SDK](/call/use-call/pay-with-vapi/).

## On the public API

```bash
curl 'https://api.vapinetwork.ai/api/call/discovery?q=weather&kinds=api&limit=5'
```

The response is a cursor-paged list of items, each with `ref`, `card`, `group`, `fee`, `verification`, optional `health` and `alternatives`, and an `action.href` that opens the listing in the console. Add `network=eip155:8453`, `includeUnverified=true` or `includeOutage=true` as query parameters. The full contract is on [Discovery and services](/reference/http-api/discovery-and-services/).

## The four groups

Call sorts listings by where they come from. Within a group, ranking considers relevance, payability, health, price, first-party status, trust and freshness.

| Group                  | What it is                                                          | Tag in `vapi search` |
| ---------------------- | ------------------------------------------------------------------- | -------------------- |
| **vAPI endpoints**     | vAPI's own paid APIs, listed through the same flow as anyone else's | `[vapi]`             |
| **Added APIs**         | APIs their owners listed through the console or `vapi publish`      | `[added]`            |
| **Verified Providers** | Partners added by a vAPI operator, such as The Graph                | `[partner]`          |
| **External**           | Listings mirrored from the Coinbase x402 Bazaar                     | `[external]`         |

Group, verification and payout fee are separate facts. Call takes no fee on direct-payout listings; legacy splitter rows disclose their retained fee. See [Groups and fees](/call/reference/groups-and-fees/).

## Verification

Verification is a tier on top of the group, granted by a vAPI operator after testing the API: every endpoint answers a live quote and a paid call, the quote pays the listing's own payout address, and the response matches the documentation. The tier is `none`, `requested` or `verified`; `vapi search` tags it `[unverified]`, `[requested]` or `[verified]`.

Default search shows verified listings plus External listings whose catalog-reported live check succeeded in the last 24 hours. To add self-listed APIs that passed the automated probe but were not reviewed, switch on **Include unverified APIs** in the console, pass `--include-unverified` to `vapi search`, or set `includeUnverified` to `true` in MCP, the SDK or the discovery API. Inspect the request contract and the registry's last observed quote before paying an unverified listing. Payment fetches a fresh quote, so set an explicit maximum with `--max` or `maxPriceUsd`.

Trust labels on a listing are separate facts and can appear together: **Live x402**, **Payout wallet confirmed**, **Verified Provider**, **vAPI**, **External catalog**.

## Liveness

A listing that passed its probe once is not proof that it still answers. vAPI rechecks self-listed and partner listings every hour and mirrored External listings at most once a day. Three failed checks in a row suspend a listing and take it out of search until it passes again. Anyone can trigger a recheck from the listing page.

Once a listing has three checks in the last seven days, its page and `vapi inspect` show uptime over that week and the p50 and p95 latency of the checks.

Search can include health states (`healthy`, `degraded`, `outage`, `unknown`) and cheaper or healthier alternatives when available. Outage listings are hidden by default; use `--include-outage` in the CLI, `includeOutage: true` in local MCP, or `includeOutage=true` in the HTTP API to include them. In Claude Desktop, `call.search` and `call.inspect` can render interactive MCP Apps results.

## Not payable here

A listing can be in the directory and still not be payable with Call:

- Offers with the `upto` or `auth-capture` scheme show a **Payment** fact such as _needs a compatible x402 client_. Call pays `exact` only.
- An API that answers 402 with a Stripe/Tempo Machine Payments Protocol challenge shows **MPP (Stripe/Tempo), not payable here**. `vapi check` recognises it and reports `transport: mpp`.

See [Networks and schemes](/call/reference/networks-and-schemes/).

## Next

- [Pay in the console](/call/use-call/pay-in-the-console/)
- [Pay with the CLI, MCP and SDK](/call/use-call/pay-with-vapi/)
- [The Graph](/call/providers/the-graph/)

Checked on 2026-11-17.
