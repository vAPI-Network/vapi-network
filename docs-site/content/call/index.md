---
title: "Call"
description: "Call is vAPI Network's directory of x402 APIs. Find an API, read its live price, and pay per request in USDC from your own wallet."
order: 7
---

Call is a directory of APIs you pay per request. No API key, no subscription, no account with the provider. You find an API, the API quotes a price in USDC, your wallet signs a payment for exactly that amount, and the API answers.

Payments use [x402](/reference/x402/x402/), an HTTP payment flow: the API answers `402 Payment Required` with its price, and the same request is sent again with the signed payment attached. Discovery is free. vAPI Call takes no fee. Providers are paid directly.

## Who Call is for

| You are                                                 | Call gives you                                                                                        | Start here                                          |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| A developer or an AI agent that needs data or a service | One wallet for every x402 API, from your terminal, your AI app, or your own code                      | [Quickstart](/call/quickstart/)                     |
| A person who wants to try an API by hand                | The console at [api.vapinetwork.ai/call](https://api.vapinetwork.ai/call), paid with a browser wallet | [Quickstart](/call/quickstart/), curl + console tab |
| A provider with an API to sell                          | A listing that goes live when it answers x402, a verification tier, and a payout path you control     | [List your API](/call/sell-on-call/list-your-api/)  |

## The three parties

- **The buyer** is you or your agent. You hold the wallet, set spend caps, and sign every payment yourself.
- **The provider** hosts the API and answers the 402 quote. The payment goes to the address the provider names in that quote.
- **vAPI** runs the directory, probes listings, shows verification and liveness, and offers the open-source client. vAPI never holds your funds, never signs for you, and stays outside provider-hosted request paths. Some partners use a [vAPI-hosted shim](/call/providers/o1/); its x402 challenge pays the partner's own wallet, and vAPI never receives the payment.

The provider's live 402 quote is the source of truth for the amount, network, asset, and payee. Prices in the directory are the last quote vAPI saw, not a promise.

## What you can do

- [Make your first paid call](/call/quickstart/) with MCP, the CLI, the SDK, or curl and the console.
- [Find APIs](/call/use-call/find-apis/) by what they do, with verification and liveness facts before you pay.
- [Pay with the CLI, MCP and SDK](/call/use-call/pay-with-vapi/) from a local wallet with per-call and per-day caps.
- [Query The Graph](/call/providers/the-graph/), the first Verified Provider, with a worked example per path.
- [List your API](/call/sell-on-call/list-your-api/) and [get verified](/call/sell-on-call/get-verified/).

The console pays exact-USDC offers on Base, Arc mainnet and Solana mainnet. The `vapi` CLI and local MCP 0.14.0 pay Base and Arc; Solana listings appear in search, but inspect/pay return `unsupported_network`. New self-listings pay the proven payout wallet directly, with no splitter deployment. See [Networks and schemes](/call/reference/networks-and-schemes/).

Checked on 2026-11-17.
