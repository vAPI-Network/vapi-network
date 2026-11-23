---
title: "Listings write API"
description: "The Call write API uses bearer authentication to publish, activate, update, and manage provider listings."
order: 11
---

This page is for developers who want a script, CI job, or agent to publish and manage Call listings without opening the console.

All routes on this page use bearer authentication. Create an API key on the [API keys page](https://api.vapinetwork.ai/connect?advanced=keys#api-keys), then send it as `Authorization: Bearer vapi_...`. An OAuth access token is also accepted. A browser session is not accepted on these routes.

```http
Authorization: Bearer vapi_...
Content-Type: application/json
Accept: application/json
```

The normal sequence is probe, get a payout nonce, sign locally, set every endpoint's live `payTo` to the signed payout wallet, publish a draft, and activate the listing. vAPI Call takes no fee. Providers are paid directly. Then you can request verification or change the listing status.

For the CLI route, see [Publishing from the CLI](/call/sell-on-call/publishing-from-the-cli/).

## Read your listings

### GET /api/call/listings/mine

Read every listing owned by the profile behind the bearer credential.

**Auth:** bearer.

| Query parameter | Description                                       |
| --------------- | ------------------------------------------------- |
| None            | This endpoint has no documented query parameters. |

```bash
curl -H 'Authorization: Bearer vapi_...' 'https://api.vapinetwork.ai/api/call/listings/mine'
```

The response is the My APIs shape and includes the profile's listings with status, verification, liveness, call counts, and `revenue`. Publish and mine responses no longer include `networkStates`.

### GET /api/call/listings/payout-nonce

Get the short-lived, purpose-scoped nonce that the payout wallet signs before publishing.

**Auth:** bearer.

| Query parameter | Description             |
| --------------- | ----------------------- |
| `wallet`        | Optional payout wallet. |

```bash
curl -H 'Authorization: Bearer vapi_...' 'https://api.vapinetwork.ai/api/call/listings/payout-nonce?wallet=0x1234567890abcdef1234567890abcdef12345678'
```

The response contains the payout nonce.

## Probe and publish

### POST /api/call/listings/probe

Probe a candidate endpoint before you publish it. The probe reads the endpoint's x402 challenge and returns its operations with metadata evidence.

**Auth:** bearer.

| Body field | Description                    |
| ---------- | ------------------------------ |
| `url`      | Candidate endpoint URL.        |
| `method`   | Optional HTTP method to probe. |

```bash
curl -X POST 'https://api.vapinetwork.ai/api/call/listings/probe' \
  -H 'Authorization: Bearer vapi_...' \
  -H 'Content-Type: application/json' \
  --data '{"url":"https://weather.example/forecast","method":"GET"}'
```

An x402 result has `kind: "x402"`, nullable `x402Version`, `accepts`, `endpoint`, `operations`, and `conformance`. Each operation includes a `metadataEvidence` string.

MPP results use `kind: "mpp"` with `endpoint`, `operations`, and `challenge`; plain results use `kind: "plain"` with `operations`.

### POST /api/call/listings

Create a listing draft from the console `publishSchema` body.

**Auth:** bearer.

| Body                 | Description                                                                                                                                                   |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `publishSchema` body | The listing, selected operations and their evidence, payout wallet, SIWE message, and signature. Use the values returned or produced by the publish sequence. |

```bash
curl -X POST 'https://api.vapinetwork.ai/api/call/listings' \
  -H 'Authorization: Bearer vapi_...' \
  -H 'Content-Type: application/json' \
  --data-binary @publish-body.json
```

The route answers `201` with the created draft listing and `descriptionWarnings`, an array of non-blocking description findings. New listings store `splitterAddresses: {}`. `PUBLIC-API.md` does not publish a fuller field list for `publishSchema`.

## Change listing status

### POST /api/call/listings/:slug/status

Move a listing through its publish states or request verification.

**Auth:** bearer.

| Path or body field | Description                                                        |
| ------------------ | ------------------------------------------------------------------ |
| `slug`             | Listing slug.                                                      |
| `action`           | One of `activate`, `request_verification`, `suspend`, or `revise`. |

```bash
curl -X POST 'https://api.vapinetwork.ai/api/call/listings/weather-call/status' \
  -H 'Authorization: Bearer vapi_...' \
  -H 'Content-Type: application/json' \
  --data '{"action":"activate"}'
```

The route returns the status transition result. A slug not owned by the credential returns `404`.

Activation re-probes every endpoint and requires each quote to pay the proven payout wallet directly. No splitter lookup or deployment is required. A live listing starts with verification `none`. `request_verification` asks for the operator-granted tier without taking the listing offline. `suspend` takes it down and `revise` returns a rejected row to draft.

## Next

- [Publishing from the CLI](/call/sell-on-call/publishing-from-the-cli/)
- [Claim and edit](/reference/http-api/claim-and-edit/)
- [Check an x402 API](/call/sell-on-call/check-an-x402-api/)

Checked on 2026-10-30.
