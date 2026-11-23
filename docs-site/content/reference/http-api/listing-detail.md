---
title: "Listing detail"
description: "Call listing endpoints expose published catalog rows, individual listing details, and a public liveness recheck."
order: 7
---

Listing detail endpoints let you browse the published Call catalogue and inspect one listing. Use the public recheck endpoint when you need a fresh liveness result for a listing.

## GET /api/calls/list

Read published catalogue rows without authentication.

**Auth:** none.

| Query parameter | Description                                       |
| --------------- | ------------------------------------------------- |
| None            | This endpoint has no documented query parameters. |

```bash
curl 'https://api.vapinetwork.ai/api/calls/list'
```

The response contains published catalogue rows. `PUBLIC-API.md` does not specify a fuller response wrapper for this route.

## GET /api/calls/:serviceId

Read one catalogue entry by its service ID. The route returns `404` when the entry is unpublished.

**Auth:** none.

| Path parameter | Description               |
| -------------- | ------------------------- |
| `serviceId`    | The catalogue service ID. |

```bash
curl 'https://api.vapinetwork.ai/api/calls/weather-call'
```

The response contains one catalogue entry. The published listing includes the request contract used to construct a call when that contract is available. Endpoints can also carry optional `responseSchema` and `exampleRequest` fields; the example can contain query strings, a JSON body, or both.

## Recheck liveness

### POST /api/call/listings/:slug/resync

Ask the public API to re-probe one listing. This route needs no authentication and takes no request body.

**Auth:** none.

| Path parameter | Description                  |
| -------------- | ---------------------------- |
| `slug`         | The listing slug to recheck. |

```bash
curl -X POST 'https://api.vapinetwork.ai/api/call/listings/weather-call/resync'
```

The route answers `202` with the recheck result. `outcome` is one of `refreshed`, `failed`, `suspended`, or `not_live`.

```json
{
  "ok": true,
  "outcome": "refreshed",
  "checkedAt": "<timestamp>"
}
```

An unknown slug returns `404`. A mirrored listing returns `409` with `{ "error": "mirrored" }`, because the external catalogue refreshes it. A rate-limited request returns `429`.

## Authentication

All endpoints on this page are public. Do not send an API key for catalogue reads or a liveness recheck.

Checked on 2026-10-30.
