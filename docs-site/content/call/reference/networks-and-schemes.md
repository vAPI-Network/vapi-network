---
title: "Networks and schemes"
description: "Compare exact-USDC x402 payments on Base, Arc mainnet and Solana mainnet in the console, vapi CLI and local MCP."
order: 22
---

Use this page to check whether a Call listing can be paid from the console or the `vapi` client. The live 402 offer is the source of truth for the network, asset, amount, validity window and payee; this page says which of those Call can act on.

## Payable networks

| Network                                                    | Console | `vapi` CLI / local MCP (0.14.0)                       | Direct-payout self-listing |
| ---------------------------------------------------------- | ------- | ----------------------------------------------------- | -------------------------- |
| Base mainnet (`eip155:8453`)                               | Yes     | Yes                                                   | Yes                        |
| Arc mainnet (`eip155:5042`)                                | Yes     | Yes, with Arc enabled                                 | No                         |
| Solana mainnet (`solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`) | Yes     | Search only; inspect/pay return `unsupported_network` | No                         |

The console pays `exact` USDC offers on these three mainnets. Arc testnet and Solana devnet are not enabled in production. Self-listing accepts Base mainnet only today, and new self-listings pay the signed payout wallet directly. No splitter deployment is required.

Base is enabled by default in the client. Enable Arc with `vapi init --networks base,arc` or `vapi accounts --enable arc`. Solana listings appear in `vapi search`, but client 0.14.0 cannot inspect or pay them.

A `--network` option on `vapi search` or `vapi pay` filters or picks among the networks an offer already accepts. It does not add a network to the client.

## Payable scheme

Call pays `exact` offers only. On Base and Arc, the payment is an EIP-3009 `transferWithAuthorization` for exactly the quoted amount to exactly the quoted payee.

On Solana, the buyer's wallet signs a transaction containing compute-budget instructions, a USDC `TransferChecked` to the payee's associated token account, and a memo. The facilitator is the fee payer; the buyer signs a Solana transaction instead of an EIP-3009 authorization.

Mirrored External listings can carry other schemes. Call keeps them visible so you know the API exists, and says why it cannot pay them:

| Scheme                              | How Call shows it                                                                                               | Payable here |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------ |
| `upto`                              | The amount as a maximum, with a **Payment** fact such as _Pay-as-you-go (upto), needs a compatible x402 client_ | No           |
| `auth-capture`                      | A **Payment** fact such as _Refundable (auth-capture), needs a compatible x402 client_                          | No           |
| `batch-settlement`, unknown schemes | Dropped from the mirror                                                                                         | No           |

When an offer accepts several options, a requested network wins first; otherwise a payable `exact` option is preferred.

## Machine Payments Protocol

An API that answers 402 with a `WWW-Authenticate: Payment` challenge from Stripe/Tempo's Machine Payments Protocol can be listed. It shows the label **MPP (Stripe/Tempo), not payable here**. Neither the console nor `vapi pay` pays MPP. `vapi check` recognises it: the `transport` rule passes with the `mpp` tag and the JSON report's `transport` field is `mpp` instead of `x402`.

## What the 402 must contain

For Call to pay an offer it needs, in the `PAYMENT-REQUIRED` header or the JSON body:

- `x402Version: 2`;
- an `accepts` entry with `scheme: "exact"`, a supported `network`, the network's canonical USDC `asset`, `amount` as a digit string in USDC's six-decimal units, a valid `payTo`, and `maxTimeoutSeconds`;
- for Base and Arc, the token's EIP-712 domain in `extra`; for Solana, the facilitator's `feePayer` in `extra`.

`vapi check <url>` grades all of this without paying. See [Check an x402 API](/call/sell-on-call/check-an-x402-api/).

## Next

- [Groups and fees](/call/reference/groups-and-fees/)
- [x402 extensions](/call/reference/x402-extensions/)
- [How Call works](/call/how-call-works/)

Checked on 2026-11-17.
