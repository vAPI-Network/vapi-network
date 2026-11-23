---
title: "Pay in the console"
description: "Pay an x402 API from the vAPI console with a supported payment wallet: check the live price for free, review the offer, sign one USDC payment, read the…"
order: 4
---

Use the console to try an API by hand. Email or Google sign-in can create a vAPI wallet for supported EVM payments. You see the live offer before you sign, and vAPI never holds your funds or signs for you.

## Before you start

- A wallet that supports the offer's network. Email/Google vAPI wallets support EVM payments; Solana requires a Solana payment wallet.
- USDC on that network in the wallet. The buyer does not pay settlement gas.

## Steps

1. Open [api.vapinetwork.ai/call](https://api.vapinetwork.ai/call) and open an API. A listed API lives at `/call/<slug>`. Look for the **Live x402** label: it means vAPI saw a valid 402 offer on its last check.
2. Fill in the request. The form shows the endpoint's inputs; switch to **JSON** when you would rather write the body yourself.
3. Choose **Check live price**. The console sends the unpaid request and shows the 402 offer: the amount, the network, the payee, and the exact request that will be paid. Nothing is paid yet.
4. Sign in with email, Google or a wallet and finish account setup and confirmed vAPI ID if needed. The quote shows your balance check and the Buyer cap.
5. Choose Pay … USDC and call. On Base or Arc, an external wallet shows an EIP-3009 typed-data authorization for exactly that amount to exactly that payee. An embedded vAPI wallet shows the payment in the vAPI confirmation sheet. On Solana, the Solana wallet shows a transaction to sign. Sign the payment.
6. The console sends the request again with the payment. The provider settles it onchain and answers. Choose **View result** to read the response and its settlement reference.

A wallet decline is harmless; nothing was sent. The quote expires with the offer's settlement window, so run **Check live price** again if you waited.

## What you approve and sign

| Network                                                    | Console | `vapi` CLI / local MCP (0.14.0)                       | Direct-payout self-listing |
| ---------------------------------------------------------- | ------- | ----------------------------------------------------- | -------------------------- |
| Base mainnet (`eip155:8453`)                               | Yes     | Yes                                                   | Yes                        |
| Arc mainnet (`eip155:5042`)                                | Yes     | Yes, with Arc enabled                                 | No                         |
| Solana mainnet (`solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`) | Yes     | Search only; inspect/pay return `unsupported_network` | No                         |

Of these mainnets, self-listing accepts Base only today.

On Base and Arc, the EIP-3009 signature names the amount, payee, token contract and validity window from the live offer, without a token approval transaction. On Solana, your wallet signs a transaction with compute-budget instructions, a USDC `TransferChecked` to the payee's associated token account, and a memo; the facilitator is the fee payer.

Listings with `upto` or `auth-capture` offers, or with a Stripe/Tempo MPP challenge, appear in the directory but cannot be paid in the console. See [Networks and schemes](/call/reference/networks-and-schemes/).

## When the console hands off

Some APIs refuse requests from a browser (CORS). The page then shows Buyer-local client required with the exact `vapi pay` command for that request: endpoint, method, body and maximum price. For Base or Arc offers, run it in your terminal with the [CLI](/call/use-call/pay-with-vapi/). Client 0.14.0 cannot pay Solana offers. vAPI does not relay the request for you.

## Uncertain settlements

If the provider's answer is lost after you signed, the console shows **Settlement may have happened** with whatever receipt data it received. It never retries on its own. Check your wallet's USDC balance or the settlement reference before you pay again. See [Receipts and retries](/call/use-call/receipts-and-retries/).

An insufficient-USDC error for the matching embedded payer offers "Add funds".
It opens the public funding page for that wallet. Review the payment again after funding.

## Next

- [Find APIs](/call/use-call/find-apis/)
- [Pay with the CLI, MCP and SDK](/call/use-call/pay-with-vapi/)
- [How Call works](/call/how-call-works/)

Checked on 2026-11-17.
