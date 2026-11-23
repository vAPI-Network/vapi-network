---
title: "Fees and payouts"
description: "vAPI Call takes no fee. Providers are paid directly; legacy splitter listings retain their disclosed fee until migrated."
order: 16
---

vAPI Call takes no fee. Providers are paid directly. Search and discovery are free.

See [Groups and fees](/call/reference/groups-and-fees/) for the discovery group, default visibility, and fee fields.

## Fee by listing type

| Listing type               |  vAPI network fee | Payout path                        |
| -------------------------- | ----------------: | ---------------------------------- |
| Added API, self-listed     |                0% | Your signed payout wallet directly |
| vAPI endpoint, self-listed |                0% | The signed payout wallet directly  |
| Partner, direct payout     |                0% | The provider's live `payTo`        |
| External, mirrored         |                0% | The API's live `payTo`             |
| Legacy splitter listing    | 5% until migrated | The stored `FeeSplitter`           |

New, re-published and migrated listings use direct payout in every group. Group and verification do not determine the fee.

## How providers receive payment

Set every selected endpoint's live x402 `payTo` to the payout wallet you prove by signature. Activation re-probes each endpoint and requires that wallet as payee. Publishing requires no splitter prediction, deployment or onchain identity check.

The wire fee for a direct-payout listing is `{ bps: 0, label: "No network fee" }`. The buyer pays the amount in the provider's live offer directly to the named wallet.

## Legacy splitter contracts

A listing whose stored endpoint still pays its stored per-network `FeeSplitter` discloses 500 basis points (5%) with the label `Network fee kept by this API's legacy payout splitter`. The immutable splitter keeps its distribution rules until the listing migrates to direct payout.

To migrate, change every endpoint's live quote to pay your proven wallet, then contact vAPI; an operator re-probes and switches the listing to direct payout without taking it offline. Activation requires direct payout; unattended liveness checks still accept the stored legacy splitter. Historical splitter addresses remain for settlement attribution.

The deployed contracts remain unchanged. No new deployment is required. Historical addresses are in [x402 contracts](/reference/x402/contracts/).

The live x402 challenge remains the source of truth for the current amount and payee.

Checked on 2026-10-30.
