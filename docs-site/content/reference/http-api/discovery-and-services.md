---
title: "Discovery and services"
description: "Call discovery endpoints filter API listings by capability, kind, network, or category and rank results by group and relevance."
order: 6
---

The discovery endpoints help you find Call listings by capability, kind, network, or category. Use them when you want the public directory without opening the vAPI console.

The default result includes vAPI-verified listings and the fresh external mirror. Set `includeUnverified=true` to add self-listed rows with verification `none` or `requested`. Results are ordered by the Call groups `vapi`, `added`, `partner`, and `external`, then by relevance, payability, health, price, first-party status, trust, freshness, and ref within a group.

| Verification value | Meaning                                            |
| ------------------ | -------------------------------------------------- |
| `none`             | The listing is live but has not been reviewed.     |
| `requested`        | Review was requested and the listing remains live. |
| `verified`         | The listing has the vAPI verification tier.        |

External mirrored rows are identified by `group: "external"`. Their
`verification` value is `"none"`, so `external` is not a verification value.

## Search and discovery

### GET /api/call/discovery

Search the cursor-paged discovery surface. Public clients can call it without authentication.

**Auth:** none.

| Query parameter     | Description                                                                   |
| ------------------- | ----------------------------------------------------------------------------- |
| `q`                 | Search query, up to 200 characters.                                           |
| `kinds`             | Repeat this parameter to filter by `api`, `service_offer`, or `open_request`. |
| `network`           | Network filter.                                                               |
| `cursor`            | Opaque cursor for the next page.                                              |
| `limit`             | Page size from `1` to `50`.                                                   |
| `includeUnverified` | Add unverified self-listed rows when `true`.                                  |
| `includeOutage`     | Include outage APIs when `true`; defaults to `false`.                         |

```bash
curl 'https://api.vapinetwork.ai/api/call/discovery?q=weather&kinds=api&includeUnverified=true&limit=2'
```

Repeat the parameter to request several kinds, for example `kinds=api&kinds=service_offer`.

The bracketed parameter `kinds[]` returns `400`.

The response envelope contains `protocol`, `items`, `nextCursor`, `unavailableKinds`, and `rankingVersion`. Pass `nextCursor` as `cursor` until it is `null`, and inspect `unavailableKinds` for partial availability.

API hits can include `health` with `state` (`healthy`, `degraded`, `outage`, or `unknown`), `uptime7d`, `latencyP50Ms`, `latencyP95Ms`, and `checks7d`. Optional `alternatives` contains `{ ref, reason }` entries naming cheaper or healthier APIs. Outage APIs are hidden before ranking and paging unless `includeOutage=true`; `totals.hiddenOutage` is present only when APIs were hidden.

Search hits omit response schemas and example requests. Inspect the listing for those fields. Treat `rankingVersion` as a label rather than pinning its literal value; changing `includeOutage` requires restarting from the first page.

This captured response is shortened to one item.

```json
{
  "protocol": "vapi.marketplace.discovery/1",
  "items": [
    {
      "ref": "https://weather.cyberwarex.com/forecast",
      "card": {
        "title": "weather.cyberwarex.com/forecast",
        "summary": "Weather forecast for a location (global, keyless): current conditions, an hourly series (up to 48h) and a daily summary (up to 10 days: min/max temp + condition), from met.no. Pass lat+lon, or a place name. For travel, logistics, events, energy. No API key.",
        "byline": "x402 Bazaar",
        "badges": [{ "code": "external_catalog", "label": "External catalog" }],
        "facts": [
          { "label": "Price", "value": "$0.002" },
          { "label": "Network", "value": "eip155:8453" },
          { "label": "Method", "value": "GET" }
        ]
      },
      "kind": "api",
      "provenance": "indexed",
      "group": "external",
      "fee": { "bps": 0, "label": "No network fee" },
      "verification": "none",
      "execution": {
        "mode": "direct",
        "url": "https://weather.cyberwarex.com/forecast",
        "method": "GET",
        "network": "eip155:8453",
        "payable": true
      },
      "action": {
        "type": "invoke_api",
        "href": "/call/invoke?url=https%3A%2F%2Fweather.cyberwarex.com%2Fforecast&method=GET&schema=%7B%22type%22%3A%22object%22%2C%22properties%22%3A%7B%22days%22%3A%7B%22type%22%3A%22integer%22%7D%2C%22hours%22%3A%7B%22type%22%3A%22integer%22%7D%2C%22lat%22%3A%7B%22type%22%3A%22number%22%7D%2C%22lon%22%3A%7B%22type%22%3A%22number%22%7D%2C%22place%22%3A%7B%22type%22%3A%22string%22%7D%7D%7D&network=eip155%3A8453&sig=2iIGp2kZ7fZoTUPkmPE9cN67EFLVEXd-HhMwJrdnY_I"
      }
    }
  ],
  "nextCursor": "eyJ2ZXJzaW9uIjoibWFya2V0cGxhY2UtcmFua2luZy12MSIsInF1ZXJ5Ijoid2VhdGhlciIsImtpbmRzIjpbImFwaSJdLCJuZXR3b3JrIjoiIiwiaW5jbHVkZVVudmVyaWZpZWQiOnRydWUsImxpbWl0IjoyLCJvZmZzZXQiOjIsInNvdXJjZVBvc2l0aW9ucyI6eyJhcGk6ZXh0ZXJuYWwiOjJ9LCJzb3VyY2VCb3VuZGFyaWVzIjp7ImFwaTpleHRlcm5hbCI6ImU1Y2YyZTUxYjYxOGFlYWQ4YTA4M2U3ZTQyYjMzMzM4MjQ2ZWZmYmZlZDQ0OTgwZDU3MmY3NTViYjRkZmQ5MzAifX0.cYcgRV9itTEIV_3Vzt16uhqFyG4w3mjkytV28N0PGBU",
  "unavailableKinds": [],
  "rankingVersion": "marketplace-ranking-v1"
}
```

### GET /api/marketplace/discovery

Use the deprecated discovery alias only when a client still needs the old path. Its body, status codes, and authentication match the canonical route.

**Auth:** none.

| Query parameter     | Description                                                                   |
| ------------------- | ----------------------------------------------------------------------------- |
| `q`                 | Search query, up to 200 characters.                                           |
| `kinds`             | Repeat this parameter to filter by `api`, `service_offer`, or `open_request`. |
| `network`           | Network filter.                                                               |
| `cursor`            | Opaque cursor for the next page.                                              |
| `limit`             | Page size from `1` to `50`.                                                   |
| `includeUnverified` | Add unverified self-listed rows when `true`.                                  |
| `includeOutage`     | Include outage APIs when `true`; defaults to `false`.                         |

```bash
curl 'https://api.vapinetwork.ai/api/marketplace/discovery?q=weather&limit=2'
```

Repeat the parameter to request several kinds, for example `kinds=api&kinds=service_offer`.

The deprecated path adds a successor header and returns the same envelope as the canonical path.

This captured response is shortened to one item.

```json
{
  "protocol": "vapi.marketplace.discovery/1",
  "items": [
    {
      "ref": "https://weather.cyberwarex.com/forecast",
      "card": {
        "title": "weather.cyberwarex.com/forecast",
        "summary": "Weather forecast for a location (global, keyless): current conditions, an hourly series (up to 48h) and a daily summary (up to 10 days: min/max temp + condition), from met.no. Pass lat+lon, or a place name. For travel, logistics, events, energy. No API key.",
        "byline": "x402 Bazaar",
        "badges": [{ "code": "external_catalog", "label": "External catalog" }],
        "facts": [
          { "label": "Price", "value": "$0.002" },
          { "label": "Network", "value": "eip155:8453" },
          { "label": "Method", "value": "GET" }
        ]
      },
      "kind": "api",
      "provenance": "indexed",
      "group": "external",
      "fee": { "bps": 0, "label": "No network fee" },
      "verification": "none",
      "execution": {
        "mode": "direct",
        "url": "https://weather.cyberwarex.com/forecast",
        "method": "GET",
        "network": "eip155:8453",
        "payable": true
      },
      "action": {
        "type": "invoke_api",
        "href": "/call/invoke?url=https%3A%2F%2Fweather.cyberwarex.com%2Fforecast&method=GET&schema=%7B%22type%22%3A%22object%22%2C%22properties%22%3A%7B%22days%22%3A%7B%22type%22%3A%22integer%22%7D%2C%22hours%22%3A%7B%22type%22%3A%22integer%22%7D%2C%22lat%22%3A%7B%22type%22%3A%22number%22%7D%2C%22lon%22%3A%7B%22type%22%3A%22number%22%7D%2C%22place%22%3A%7B%22type%22%3A%22string%22%7D%7D%7D&network=eip155%3A8453&sig=2iIGp2kZ7fZoTUPkmPE9cN67EFLVEXd-HhMwJrdnY_I"
      }
    }
  ],
  "nextCursor": "eyJ2ZXJzaW9uIjoibWFya2V0cGxhY2UtcmFua2luZy12MSIsInF1ZXJ5Ijoid2VhdGhlciIsImtpbmRzIjpbImFwaSJdLCJuZXR3b3JrIjoiIiwiaW5jbHVkZVVudmVyaWZpZWQiOmZhbHNlLCJsaW1pdCI6Miwib2Zmc2V0IjoyLCJzb3VyY2VQb3NpdGlvbnMiOnsiYXBpOmV4dGVybmFsIjoyfSwic291cmNlQm91bmRhcmllcyI6eyJhcGk6ZXh0ZXJuYWwiOiI4NTJmMDExMWZlZmJiNTI5OWYzZDQ2ZmUyMTE0ZjA3MTBjZjJkNjBmNjMwOTEyMjYzYjYyNjE4NjM0MTlhNzQ4In19.7MR_5BaxVCMpV5otL4ZmPJBeM9Oc9fsrN7PPxXIdJ-A",
  "unavailableKinds": [],
  "rankingVersion": "marketplace-ranking-v1"
}
```

## Services compatibility endpoint

### GET /api/call/services

Read the frozen services compatibility shape when your client expects a `services` array instead of the discovery page.

**Auth:** none.

| Query parameter     | Description                                            |
| ------------------- | ------------------------------------------------------ |
| `q`                 | Search query, up to 200 characters.                    |
| `category`          | One of `ai`, `data`, `crypto`, `compute`, or `search`. |
| `limit`             | Result limit from `1` to `100`. Defaults to `20`.      |
| `includeUnverified` | Add unverified self-listed rows when `true`.           |

```bash
curl 'https://api.vapinetwork.ai/api/call/services?category=data&limit=2'
```

The response is `{ "services": [...] }`. Each service carries `group`, `fee`, and `verification`.

```json
{
  "services": [
    {
      "id": "the-graph",
      "name": "The Graph",
      "description": "Send GraphQL queries directly to The Graph's x402 endpoint. Each request settles $0.01 in USDC on Base.",
      "category": "data",
      "tier": "partner",
      "group": "partner",
      "fee": { "bps": 0, "label": "No network fee" },
      "verified": true,
      "verification": "verified",
      "wrapped": false,
      "lastCheckedAt": "2026-10-02T10:11:00.522Z",
      "liveness": { "uptime7d": 1, "latencyP50Ms": 45, "latencyP95Ms": 563, "checks7d": 168 },
      "conformance": {
        "declaredVersion": 2,
        "versionConformant": true,
        "offerTransport": "header",
        "issues": ["offer_header_only"]
      },
      "price": "$0.01",
      "networks": ["eip155:8453"],
      "endpoints": [
        {
          "name": "query_subgraph",
          "method": "POST",
          "url": "https://gateway.thegraph.com/api/x402/subgraphs/id/5zvR82QoaXYFyDEKLZ9t6v9adgnptxYpKpSbxtgVENFV",
          "price": "$0.01",
          "description": "Direct x402 GraphQL query against the configured published subgraph.",
          "payment": {
            "scheme": "exact",
            "network": "eip155:8453",
            "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
            "payTo": "0x79DC34E41B2b591078d3dE222C43EcaaBD52FcCB",
            "checkedAt": "2026-10-02T10:11:00.522Z"
          }
        }
      ]
    }
  ]
}
```

### GET /api/network/services

Use the deprecated services alias only when a client still needs the old path. Its body, status codes, and authentication match `/api/call/services`.

**Auth:** none.

| Query parameter     | Description                                            |
| ------------------- | ------------------------------------------------------ |
| `q`                 | Search query, up to 200 characters.                    |
| `category`          | One of `ai`, `data`, `crypto`, `compute`, or `search`. |
| `limit`             | Result limit from `1` to `100`. Defaults to `20`.      |
| `includeUnverified` | Add unverified self-listed rows when `true`.           |

```bash
curl -i 'https://api.vapinetwork.ai/api/network/services?q=weather'
```

The deprecated path returns the same services shape and points clients to its canonical successor.

```json
{
  "services": []
}
```

## Search the published catalogue

### GET /api/calls/search

Search published catalogue rows with a text query.

**Auth:** none.

| Query parameter | Description   |
| --------------- | ------------- |
| `q`             | Search query. |
| `limit`         | Result limit. |

```bash
curl 'https://api.vapinetwork.ai/api/calls/search?q=weather&limit=10'
```

The response contains published catalogue rows. The public contract does not specify a fuller response wrapper here.

Checked on 2026-10-30.
