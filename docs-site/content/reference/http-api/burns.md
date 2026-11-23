---
title: "Burn and supply"
description: "Public token supply, buyback totals and the paginated vAPI burn ledger."
order: 9
---

Read vAPI supply and indexed burns without a session or API key.
Supply endpoints return plain-text decimal amounts; burn endpoints return JSON.
The public burn ledger and expanded report are live in production.

## Endpoints and parameters

The two numeric supply endpoints accept GET and HEAD, with no supported query parameters.
HEAD returns the same headers without a body.
The burn report consumes no query parameters and returns at most ten recent executions, with totals across all indexed executions.

| Method    | Path                       | Result                                              |
| --------- | -------------------------- | --------------------------------------------------- |
| GET, HEAD | `/api/supply/total`        | Current token supply.                               |
| GET, HEAD | `/api/supply/circulating`  | Circulating supply under the project's methodology. |
| GET       | `/api/router/burns`        | Burn report and recent executions.                  |
| GET       | `/api/router/burns/ledger` | Burn days, or transfers for a selected UTC day.     |

| Ledger query     | Type and default                           | Meaning                                                                        |
| ---------------- | ------------------------------------------ | ------------------------------------------------------------------------------ |
| day              | Optional string; absent by default.        | UTC date in YYYY-MM-DD format. Selects that day's transfers.                   |
| cursor           | Optional opaque string; absent by default. | The matching page's nextCursor. Day and transfer cursors have different types. |
| Other parameters | Ignored.                                   | A limit parameter does not change the fixed page size.                         |

Without day, the ledger returns 30 days per page, newest first.
With day, it returns 50 transfers per page, ordered by ascending block number and log index.
Pass nextCursor back as cursor, keeping the selected day for transfer pages.
A null nextCursor marks the final page.

## Numeric supply responses

Each body is a plain-text decimal number in whole vAPI units, with up to 18 decimal places.
Circulating supply subtracts still-locked vesting, excluded reserves and excluded airdrop amounts under the project's methodology.
Successful responses include the snapshot block, block timestamp and cache freshness headers.

| Property                 | Contract                                                                                                                           |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| Content-Type             | text/plain; charset=utf-8.                                                                                                         |
| Cache-Control            | no-store.                                                                                                                          |
| X-Content-Type-Options   | nosniff.                                                                                                                           |
| X-Supply-Block-Number    | Snapshot block number.                                                                                                             |
| X-Supply-Block-Timestamp | Snapshot block timestamp.                                                                                                          |
| X-Supply-Cache           | fresh or stale.                                                                                                                    |
| Rate limit               | Shared 60 requests per minute per client IP across both endpoints, including internal cache hits. Unresolvable IPs share a bucket. |
| Freshness                | Fresh for 60 seconds; refresh occurs on demand.                                                                                    |
| Failed refresh           | May serve a snapshot whose record and block are both no more than 300 seconds old.                                                 |

These successful production captures include the HTTP status printed by curl.
Neither request sends credentials.
Their numeric values reflect the capture time.

```bash
curl -sS --max-time 30 https://api.vapinetwork.ai/api/supply/total -w '\nHTTP status: %{http_code}\n'
```

```text
66261232.156495149248286971
HTTP status: 200
```

```bash
curl -sS --max-time 30 https://api.vapinetwork.ai/api/supply/circulating -w '\nHTTP status: %{http_code}\n'
```

```text
66261232.156495149248286971
HTTP status: 200
```

## Burn report fields

The report identifies the configured Base burn network.
Token quantities are decimal integer strings in atomic units, unlike the numeric supply responses.
Divide vAPI quantities by 10 to the power 18, and micro-USDC by 1,000,000, to obtain whole token amounts.

| Field                   | Type             | Meaning and units                                                                                |
| ----------------------- | ---------------- | ------------------------------------------------------------------------------------------------ |
| network                 | string           | eip155:8453.                                                                                     |
| chainId                 | number           | Base chain ID 8453.                                                                              |
| indexedToBlock          | string or null   | Execution/distribution cursor block number.                                                      |
| totalSupply             | string or null   | Latest execution's totalSupplyAfter in 18-decimal vAPI atomic units; null before any execution.  |
| supply                  | object or null   | Cached authoritative token supply snapshot; independent of execution totals.                     |
| supply.launch           | string           | Launch supply of 100,000,000 vAPI in 18-decimal atomic units.                                    |
| supply.total            | string           | Current token supply in 18-decimal vAPI atomic units.                                            |
| supply.burned           | string           | Launch minus total, in 18-decimal vAPI atomic units.                                             |
| supply.asOfBlock        | string           | Supply snapshot block number.                                                                    |
| supply.asOfTime         | string           | ISO timestamp of the supply snapshot.                                                            |
| reconciled              | boolean or null  | Whether indexed transfer amounts equal supply.burned; null without supply or with fixtures.      |
| burns.count             | number           | Indexed burn transfer count.                                                                     |
| burns.lastBurnAt        | string or null   | Newest burn's ISO timestamp.                                                                     |
| totals.vapiBurned       | string           | Burned across indexed executions, in 18-decimal vAPI atomic units.                               |
| totals.usdcSpent        | string           | Indexed execution spending in micro-USDC.                                                        |
| totals.executions       | number           | Indexed execution count.                                                                         |
| totals.vapiAwaitingBurn | string           | Pending burn amount in 18-decimal vAPI atomic units, accounting for subsequent burner transfers. |
| fees.burnRouted         | string           | Micro-USDC routed to burn, excluding shares that fell back to treasury.                          |
| fees.distributed        | string           | Total distributed fees in micro-USDC.                                                            |
| fees.fellBack           | number           | Distributions whose burn share fell back to treasury.                                            |
| recent                  | array of objects | At most ten recent executions; fields below.                                                     |
| fixture                 | boolean          | Whether the report uses fixture execution history.                                               |
| tokenSymbol             | string           | vAPI.                                                                                            |

| Recent execution field | Type    | Meaning and units                                       |
| ---------------------- | ------- | ------------------------------------------------------- |
| txHash                 | string  | Transaction hash.                                       |
| blockNumber            | string  | Decimal block number.                                   |
| blockTime              | string  | ISO timestamp.                                          |
| usdcSpent              | string  | Micro-USDC spent.                                       |
| vapiReceived           | string  | Received vAPI in 18-decimal atomic units.               |
| vapiBurned             | string  | Burned vAPI in 18-decimal atomic units.                 |
| totalSupplyAfter       | string  | Supply after execution in 18-decimal vAPI atomic units. |
| deferred               | boolean | Execution received vAPI but burned zero.                |

Awaiting-burn calculation processes executions and burner transfers chronologically per transaction.
It clears prior deferred burns and floors pending amounts at zero after each transaction.
Production capture on 2026-11-17:

```bash
curl -fsS https://api.vapinetwork.ai/api/router/burns | head -c 1500
```

```json
{
  "network": "eip155:8453",
  "chainId": 8453,
  "indexedToBlock": "58708825",
  "totalSupply": null,
  "supply": {
    "launch": "100000000000000000000000000",
    "total": "66261232156495149248286971",
    "burned": "33738767843504850751713029",
    "asOfBlock": "58708916",
    "asOfTime": "2026-11-17T16:15:58.000Z"
  },
  "reconciled": true,
  "burns": { "count": 50, "lastBurnAt": "2026-08-31T08:07:15.000Z" },
  "totals": { "vapiBurned": "0", "usdcSpent": "0", "executions": 0, "vapiAwaitingBurn": "0" },
  "fees": { "burnRouted": "0", "distributed": "0", "fellBack": 0 },
  "recent": [],
  "fixture": false,
  "tokenSymbol": "vAPI"
}
```

## Ledger response fields

The production ledger capture below was collected on 2026-11-17.
This response fits within the 1,500-byte capture limit.
Day and transfer response contracts follow the sample.

```bash
curl -fsS https://api.vapinetwork.ai/api/router/burns/ledger | head -c 1500
```

```json
{
  "days": [
    {
      "date": "2026-08-31",
      "vapiBurned": "33738767843504850751713029",
      "burns": 50,
      "buybacks": 0,
      "launchDay": true
    }
  ],
  "nextCursor": null
}
```

| Day-list field    | Type             | Meaning and units                               |
| ----------------- | ---------------- | ----------------------------------------------- |
| days              | array of objects | Burn days on this page.                         |
| nextCursor        | string or null   | Opaque next-day cursor, or null at the end.     |
| days[].date       | string           | UTC date in YYYY-MM-DD format.                  |
| days[].vapiBurned | string           | Day's burned vAPI in 18-decimal atomic units.   |
| days[].burns      | number           | Non-buyback burn count; disjoint from buybacks. |
| days[].buybacks   | number           | Buyback burn count.                             |
| days[].launchDay  | boolean          | Identifies the launch date, 2026-08-31.         |

| Day-transfer field      | Type             | Meaning and units                                                               |
| ----------------------- | ---------------- | ------------------------------------------------------------------------------- |
| date                    | string           | Selected UTC date in YYYY-MM-DD format.                                         |
| transfers               | array of objects | Transfers on this page.                                                         |
| nextCursor              | string or null   | Opaque next-transfer cursor, or null at the end.                                |
| transfers[].txHash      | string           | Transaction hash.                                                               |
| transfers[].logIndex    | number           | Log index within the transaction.                                               |
| transfers[].blockNumber | string           | Decimal block number.                                                           |
| transfers[].blockTime   | string           | ISO timestamp.                                                                  |
| transfers[].from        | string           | Sender address.                                                                 |
| transfers[].amount      | string           | Burned vAPI in 18-decimal atomic units.                                         |
| transfers[].kind        | string           | burn or buyback.                                                                |
| transfers[].usdcSpent   | string or null   | Micro-USDC spent, when a buyback joins to an indexed execution; otherwise null. |

A sender matching the configured burner, ignoring case, classifies the transfer as buyback.
Other senders classify as burn.
Day and transfer cursors use distinct canonical base64url encodings.

## Caching and errors

Burn endpoints send Cache-Control private, no-store and X-Content-Type-Options nosniff.
They share an in-process ledger cache with 30 seconds of freshness and no stale window or second-level cache.
The optional supply projection has a separate 30-second in-process cache.

Burn reads refresh missing supply snapshots or snapshots older than 60 seconds from the chain.
Failed refresh can retain a snapshot only within five-minute record and block-age bounds.
The supply projection requires valid configuration; otherwise supply is null.
No numeric supply request is needed first.

| Endpoint       | Status | Cause or handling                                                                             |
| -------------- | ------ | --------------------------------------------------------------------------------------------- |
| Numeric supply | 405    | Unsupported method; Allow lists GET and HEAD.                                                 |
| Numeric supply | 429    | Shared IP limit exceeded; Retry-After gives seconds.                                          |
| Numeric supply | 503    | Protection, configuration or cache unavailable, or data expired. HEAD failures omit the body. |
| Ledger         | 400    | Empty, malformed or impossible day; empty, malformed or wrong-type cursor.                    |
| Ledger         | 500    | Storage failure returns the shared request-failure JSON instead of an empty ledger.           |

Burn handlers have no endpoint-specific request limiter.
Internal caching does not establish a request quota.
See [HTTP API overview](/reference/http-api/api-overview/) for the other public API pages.

Checked on 2026-11-17.
