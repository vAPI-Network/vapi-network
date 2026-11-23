---
title: "Get verified"
description: "Call verification is a review tier that adds eligible listings to default search and raises their trust score."
order: 15
---

Verification is a review tier for a live listing. It adds the listing to default search and raises its trust score.

## Understand the states

The tier has four states: `none`, `requested`, `verified`, and `rejected`. The public wire never shows `rejected`.

`none` means the listing passed the automated x402 probe but has not been reviewed. `requested` means review is requested and the listing stays live. `verified` means vAPI reviewed the listing against the published rubric. A rejection also leaves the listing live, and you can request verification again.

Default search shows verified self-listed listings and the external catalog. Include unverified APIs to show listings in `none` or `requested`. Within a group, relevance ranks first. A more relevant unverified listing can appear above a verified listing when unverified APIs are included.

## What the review checks

The published rubric checks these points:

1. Every endpoint answers a live 402 quote and a paid call.
2. The quote pays the listing's own payout address.
3. The published request schema matches what the endpoint accepts.
4. The paid amount, asset, and network match the quote.
5. Three separate paid calls per endpoint stay inside the stated latency budget.
6. Your identity and the endpoint host resolve to the same party, without impersonation.
7. The listing and a sample response contain no content prohibited by the console terms.
8. Non-idempotent methods declare retry safety, and one retry is checked.
9. Every 402 matches its declared x402 version and has no conformance issue.

Verification is not a guarantee of quality or uptime. The live endpoint remains the source of truth for every quote, and a verified listing can still be suspended when it stops answering.

## Request verification

In the console, open **My APIs** at `/call/my-apis` and choose **Request verification** on the listing. After a rejection the same place offers **Request verification again**, with the stored reason.

With `vapi`, request review by slug:

```bash
vapi publish verify-request <slug>
```

The machine API uses the same status action:

```http
POST /api/call/listings/<slug>/status
Authorization: Bearer <api-key>
Content-Type: application/json

{"action":"request_verification"}
```

The request re-probes the endpoints. The listing stays live while the review is pending.

Checked on 2026-10-15.
