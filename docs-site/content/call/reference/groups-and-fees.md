---
title: "Groups and fees"
description: "Call groups listings by source; provenance, verification, payout path, and network fee are separate listing facts."
order: 23
---

Use this page to understand why a listing appears in a Call group and which payout path applies. The live x402 challenge remains the source of truth for the amount and payee.

## The four groups

Call derives the group from provenance and ownership. The group is separate from the verification tier.

| Group                  | What it is                                                                         |           Network fee | Payout path                                            | Default visibility                                                             |
| ---------------------- | ---------------------------------------------------------------------------------- | --------------------: | ------------------------------------------------------ | ------------------------------------------------------------------------------ |
| **vAPI endpoints**     | A `self_listed` listing owned by a wallet in the first-party provider wallet set.  | 0% for direct payout. | The signed provider payout wallet.                     | Verified listings are shown by default.                                        |
| **Added APIs**         | A `self_listed` listing whose owner is not in the first-party provider wallet set. | 0% for direct payout. | The signed provider payout wallet is the live `payTo`. | Verified listings are shown by default.                                        |
| **Verified Providers** | A listing with `provenance: "partner"`, added through the partner flow.            | 0% for direct payout. | The provider's live `payTo` directly.                  | Partner listings are shown by default when eligible.                           |
| **External**           | A listing with `provenance: "indexed"`, mirrored from the Coinbase x402 Bazaar.    |                   0%. | The provider's own live `payTo` directly.              | Shown when the catalog-reported live check succeeded within the last 24 hours. |

The `includeUnverified` switch adds unverified self-listed listings with verification `none` or `requested`. With the switch on, External listings are shown regardless of catalog-check freshness.

## Sort order and discovery fields

Group is the primary sort order: `vapi`, `added`, `partner`, then `external`. Within a group, ranking considers relevance, payability, health, price, first-party status, trust and freshness.

Discovery responses carry `group`, `fee`, and `verification` on each listing. You can see these fields on [`/api/call/discovery`](https://api.vapinetwork.ai/api/call/discovery) and [`/api/call/services`](https://api.vapinetwork.ai/api/call/services).

## Direct and legacy payouts

vAPI Call takes no fee. Providers are paid directly. New self-listings require every selected endpoint's live `payTo` to match the signed payout wallet, with no splitter deployment. Direct rows report `fee.bps: 0` and `No network fee`.

Legacy rows whose stored endpoints still pay their stored per-network splitter retain the disclosed 500-basis-point fee until migrated. Their label is `Network fee kept by this API's legacy payout splitter`. Retaining an old splitter address for historical attribution alone does not make a listing charge a fee.

## Routed through vAPI

The stats API retains routedThroughVapi and routedRange. The console hides routed totals and shows “x402 payments to listed APIs”. The totals are counted from the x402 `builder-code` tag (`vapi`) in settle calldata. This is network volume attributed to vAPI clients, not vAPI revenue.

See [x402 extensions](/call/reference/x402-extensions/) for the `builder-code` extension.

Call statistics use retained snapshots. The console describes these as “Onchain x402 payments to the APIs Call indexes.”
The 7d and 30d totals combine closed UTC-day rollups with live today.
Producers use live summaries if rollup coverage is incomplete or outdated; reads do not start expensive summaries.

| Window | Freshness                                                                     |
| ------ | ----------------------------------------------------------------------------- |
| 24h    | Fresh for one minute, stale for another 15 minutes.                           |
| 7d     | Fresh for 15 minutes; snapshots retained another day beyond the stale window. |
| 30d    | Fresh for 15 minutes; snapshots retained another day beyond the stale window. |

Failed refreshes preserve last-good data and its generatedAt timestamp. Missing snapshots fail immediately.
The console shows “Stats unavailable” when statistics cannot be read.

Checked on 2026-11-17.
