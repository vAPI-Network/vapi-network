---
title: "Burn"
description: "Read vAPI supply, burns, buybacks and their Base transactions without connecting a wallet."
order: 5
---

The public [Burn page](https://api.vapinetwork.ai/stake/burn) shows vAPI burns on Base.
You can read it without a wallet.
Its supply headline comes from the token contract and is separate from execution-only buyback totals.

## Read supply and buybacks

Burned shows launch supply minus the cached token total supply.
Missing supply or snapshots older than 60 seconds trigger an on-demand chain refresh. A failed refresh can retain data within five-minute record and block-age bounds. The supply projection cache remains 30 seconds. No numeric supply request is needed first.
It also shows the burned percentage of launch supply.
The supply Block separates Supply now from Burned.

| Statistic              | Meaning or unavailable state                                       |
| ---------------------- | ------------------------------------------------------------------ |
| Supply now             | Current supply rounded to whole vAPI.                              |
| Burns                  | Indexed burn count; missing indexed data can show Not indexed yet. |
| Last burn              | Latest indexed burn; None listed when absent.                      |
| Bought back and burned | Buyback burn totals, separate from all token burns.                |

If supply cannot be read, the page reports that the burn figures could not be read.
The ledger loads independently.
Report and ledger queries stay fresh for 60 seconds, with no periodic polling or window-focus refetch.

## Browse transactions

All burns groups transactions by day with Date, Amount and Burns columns.
Expand a day to read transfers with UTC time, vAPI amount, Buyback or Burn, optional USDC spent and transaction hash.
Transaction links open BaseScan in a new tab.

| Ledger state or control | Behavior                                                                                           |
| ----------------------- | -------------------------------------------------------------------------------------------------- |
| Launch day              | The launch date can carry a Launch day label.                                                      |
| Deferred buyback        | Recent executions still awaiting a burn show tokens received, USDC spent and Bought, burn pending. |
| Incomplete indexing     | Still indexing: some burns are not listed yet.                                                     |
| Empty                   | No burns are listed yet.                                                                           |
| Read failure            | The burn list could not be read.                                                                   |
| Show more               | Separate controls load more days or more transfers within an expanded day.                         |

The ledger indexes nonzero token transfers to the zero address.
Buyback and fee totals come from indexed execution and distribution events.
See [Burn and supply HTTP API](/reference/http-api/burns/) for fields, pagination and caching.

Checked on 2026-11-17.
