---
title: "Stats and activity"
description: "Beta stats and activity endpoints report onchain-observed x402 settlements and catalog counts rather than vAPI Network revenue."
order: 8
---

The stats and activity endpoints show network-wide x402 settlement activity and catalogue counts. Use them to explore the network, not to read vAPI revenue.

Both surfaces are beta and are based on onchain-observed x402 settlements.

## GET /api/call/stats

Read network totals, time buckets, catalogue counts, and payer concentration for a time range.

Auth: none.

| Query parameter | Description                               |
| --------------- | ----------------------------------------- |
| `range`         | `24h`, `7d`, or `30d`. Defaults to `30d`. |

```bash
curl 'https://api.vapinetwork.ai/api/call/stats?range=7d'
```

The response contains range, totals, buckets, catalogue, concentration and generatedAt. Applicable responses retain routedThroughVapi and routedRange; the console hides routed totals until real routed volume is shown. `concentration.topPayerTxShare` is a value from `0` to `1`.

Requests consume retained snapshots rather than starting expensive summaries.
Closed UTC-day rollups plus live today provide 7d and 30d summaries, with live fallback for incomplete rollup coverage.
Failed refresh preserves last-good data and generatedAt; missing snapshots fail immediately.

| Range | Freshness and retention                                                        |
| ----- | ------------------------------------------------------------------------------ |
| 24h   | Fresh one minute, stale another 15 minutes.                                    |
| 7d    | Heavy snapshot fresh 15 minutes, retained another day beyond the stale window. |
| 30d   | Heavy snapshot fresh 15 minutes, retained another day beyond the stale window. |

## GET /api/call/activity

Read one cursor-paged page of onchain-observed settlements, newest first.

Auth: none.

| Query parameter | Description                               |
| --------------- | ----------------------------------------- |
| `range`         | `24h`, `7d`, or `30d`. Defaults to `30d`. |
| `cursor`        | Opaque cursor for the next page.          |
| `limit`         | Page size, up to `100`. Defaults to `50`. |
| `listing`       | A listing `ref`.                          |
| `address`       | A public address filter.                  |

```bash
curl 'https://api.vapinetwork.ai/api/call/activity?range=24h&limit=2'
```

Each activity item includes its listing, payer, `payTo`, USDC amount, and `blockNumber` as a decimal string. The page also carries its next cursor when another page exists.

```json
{
  "range": "24h",
  "generatedAt": "2026-10-02T11:06:33.188Z",
  "items": [
    {
      "txHash": "0x75d8c171bceeffc2f846b10370b1de3d0772468f8d077888bdb911b9c4668798",
      "network": "eip155:8453",
      "observedAt": "2026-10-02T11:02:29.000Z",
      "listing": {
        "ref": "x402-43e6e1ca8b0c1191790e",
        "name": "diet.agentic-jp.com/members/search",
        "group": "external"
      },
      "payer": "0x4C29Ec4F680CA88d0019edBfe3A8FF5c80499494",
      "payTo": "0x38c9F689274E2fC3AE360744eF88ce212077a584",
      "amountUsd": "0.005",
      "asset": "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
      "blockNumber": "52074801"
    },
    {
      "txHash": "0xd520a2a483bef67f37775fa96e9debe56a630dd5dcff83a92058820d47f85573",
      "network": "eip155:8453",
      "observedAt": "2026-10-02T11:02:13.000Z",
      "listing": {
        "ref": "x402-bba85ab74f769c729312",
        "name": "api.nansen.ai/api/v1/smart-money/dex-trades",
        "group": "external"
      },
      "payer": "0xC4AE778dd62f98A72cA2B5351Ba5d868D51A11b1",
      "payTo": "0x93053f1e7A5eFEDa532Fe69CbbE43cBEc3A0F13f",
      "amountUsd": "0.05",
      "asset": "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
      "blockNumber": "52074793"
    }
  ],
  "nextCursor": "MjAyNi0xMC0wMlQxMTowMjoxMy4wMDBafGNtdXF1dHRvdTAzbTZwMzAxOXQ1ZHh5aHM"
}
```

## GET /api/call/activity/:address

Read one public address on both sides of the activity ledger.

Auth: none.

| Path or query parameter | Description                               |
| ----------------------- | ----------------------------------------- |
| `address`               | The public address to inspect.            |
| `range`                 | `24h`, `7d`, or `30d`. Defaults to `30d`. |

```bash
curl 'https://api.vapinetwork.ai/api/call/activity/0x1234567890abcdef1234567890abcdef12345678?range=30d'
```

The response contains the address, role, totals, per-bucket series, top listings, and the first page of settlements.

Checked on 2026-11-17.
