---
title: "Buy Router balance"
description: "Fund prepaid Router balance with x402 or a Base USDC deposit, then spend it with balance or hybrid keys."
order: 5
---

Router balance is prepaid model spending that stays until spent.
Use a balance key or an owner hybrid key to spend it.
Hybrid uses Compute first and switches asynchronously; see [Access and keys](/router/access-and-keys/) for the rejection window.

## Add from wallet

Sign in to your account with wallet, email or Google.
On [Router](https://api.vapinetwork.ai/router), select Top up Router balance in the hero, or Add from wallet under Get more.
The hero opens the wallet panel and scrolls to Get more; it does not submit payment.
Choose a tier, review the payment and authorize it.

| Tier | Payment |
| ---- | ------- |
| $1   | 1 USDC  |
| $5   | 5 USDC  |
| $20  | 20 USDC |
| $50  | 50 USDC |

Top-ups use x402 on Base; Arc is supported only when configured.
The panel says “No fee. One x402 signature, no gas.”
Embedded-wallet payments use a confirmation sheet.
A failed USDC preflight for the connected embedded payer can offer Add funds, opening its wallet funding page.
Opening Add funds does not retry or submit the top-up.
The funding page offers card, wallet-send and bridge paths when available; card funding adds onchain funds rather than Router balance directly.
Card availability depends on configuration.

Payment review identifies “vAPI (paid by your signature)” and warns “Sending USDC directly to this address does not add balance.”
This payment payee differs from your issued deposit address.
Create a balance or hybrid key on [API keys](https://api.vapinetwork.ai/router/keys) after funding.

The separate [join top-up](https://api.vapinetwork.ai/join/top-up) admits setup-complete accounts waiting for a vAPI ID.
It offers only $1 for join verification.
Credit is checked before sponsored ID creation.

## Send USDC

Select Send USDC under Send USDC from an exchange in Get more.
The reusable buy card also has Pay with wallet and Send USDC tabs.
Wallet and Send USDC share one panel, opened one at a time.
Opening Send USDC issues your permanent per-profile address on first use and polls deposits every 15 seconds while open.

Your deposit address has a QR code and Copy address control.
Send canonical USDC on Base mainnet, chain ID 8453, with a minimum of $1.
Amounts can differ from the four x402 tiers.
The address is a forwarder, rather than a wallet you control.
Exchanges and third-party wallets can fund your profile through this address.
See [Router deposit contracts](/reference/http-api/router-deposit-contracts/) for deployment addresses and treasury forwarding.

The panel says “Send USDC from any exchange or wallet. It is added to your Router balance once it is confirmed on Base, usually a few minutes.”
This describes expected timing without a latency guarantee.
With safe confirmation, transfers at or below Base's safe block can be credited; newer observations are display-only.

| Status            | Meaning                                                   |
| ----------------- | --------------------------------------------------------- |
| Arriving          | Observed above the confirmation block; not credited.      |
| Adding to balance | Pending credit processing.                                |
| Credited          | Added to Router balance.                                  |
| Held              | Transfer under $1 awaiting aggregation.                   |
| Not credited      | Rejected transfer; “Contact support about this transfer”. |

Held transfers release when their combined amount reaches $1 or the profile has a pending deposit.
The panel says “${heldTotalUsd} held. Added together with your next deposit”.
That total includes held records older than the loaded list.
Credits are retryable and deduplicated by transfer identity.
A durable credit can precede successful Router balance synchronization; failed synchronization is queued for repair.
Treasury sweeping is not required before crediting.
Success shows “+${amount} added to your Router balance” and refreshes usage.

Five rows appear initially; Show all {count} deposits expands the loaded list.
The server loads the newest 50 stored rows, then merges current Arriving observations.
The combined response can exceed 50 rows; Show all does not paginate full history.
On failure, previously loaded rows remain visible.
The panel says “Your deposits could not be loaded. A transfer you sent is not affected.” and offers Reload deposits.

## Claim a detected transfer

A detected transfer to the configured payee can offer “We found a ${amount} USDC transfer from your wallet. Add it to Router balance?”
Select Add ${amount} to balance to confirm explicitly.
Plain payee transfers do not automatically add balance.

| Claim condition | Requirement                                                                            |
| --------------- | -------------------------------------------------------------------------------------- |
| Sender          | Profile wallet or a currently linked agent wallet belonging to that profile.           |
| Amount          | At least $1; smaller claims do not enter held-deposit aggregation.                     |
| Transfer        | Exactly one matching USDC transfer to the payee in a successful canonical transaction. |
| Finality        | Transaction must be finalized, even when deposit addresses use safe confirmation.      |
| Credit          | Transfer must have no prior top-up credit.                                             |

If finality is pending, the panel asks you to try again in a few minutes.
Transfers under $1 cannot be added through claims.
Deposit addresses and payee recovery have different confirmation rules.

## Spend and inspect balance

Single-source keys spend only their selected source; direct clients switch those keys themselves.
Owner hybrid keys preserve the secret while switching from Compute to balance asynchronously.
Requests can receive a 429 budget error until reassignment completes.
Linked agents retain separate Compute and balance credentials and separately approved caps.

| Management route         | Access                                                          |
| ------------------------ | --------------------------------------------------------------- |
| Deposit address issuance | Owner session or authenticated bearer; agents need router.use.  |
| Deposit list             | Owner session only; Authorization-header callers are rejected.  |
| Transfer claim           | Owner session only.                                             |
| x402 top-up              | Owner session, console API key or agent bearer with router.use. |

See [Agents and Router HTTP API](/reference/http-api/agents-and-router/) for routes and error contracts.
See [Use Router from your agents](/router/use-router-from-your-agents/) for CLI, local MCP and SDK funding.
See [Usage and limits](/router/usage-and-limits/) for Compute and balance accounting.

Checked on 2026-11-17.
