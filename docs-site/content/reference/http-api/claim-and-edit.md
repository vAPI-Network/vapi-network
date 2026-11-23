---
title: "Claim and edit"
description: "The Call claim API requires bearer authentication and a payout-wallet signature before a provider can edit a mirrored listing."
order: 12
---

You can claim a mirrored listing when your payout wallet signs the claim message. After the claim, use the same bearer-authenticated API to edit the listing name or description.

## Claim a mirrored listing

The claim flow uses an API key and a signature from the wallet that receives the listing's x402 payouts. The signature proves control of that payout wallet. It does not make a payment.

### GET /api/call/listings/claim-nonce

Get an EIP-4361 claim message for an origin and payout wallet.

**Auth:** bearer.

| Query parameter | Description                 |
| --------------- | --------------------------- |
| `origin`        | Required bare HTTPS origin. |
| `wallet`        | Required payout wallet.     |

```bash
curl -H 'Authorization: Bearer vapi_...' \
  'https://api.vapinetwork.ai/api/call/listings/claim-nonce?origin=https%3A%2F%2Fapi.example.com&wallet=0x1234567890abcdef1234567890abcdef12345678'
```

The response contains the exact message to sign.

```json
{
  "message": "<EIP-4361 claim message>"
}
```

Sign the message unchanged with the wallet your x402 quotes pay. Keep the signature local and send it to the claim route.

### POST /api/call/listings/claim

Claim every unowned mirrored listing from the origin whose EVM quotes pay the signing wallet.

**Auth:** bearer.

| Body field  | Description                                      |
| ----------- | ------------------------------------------------ |
| `origin`    | The origin used for the nonce.                   |
| `message`   | The exact message returned by the nonce route.   |
| `signature` | The payout wallet's signature over that message. |

```bash
curl -X POST 'https://api.vapinetwork.ai/api/call/listings/claim' \
  -H 'Authorization: Bearer vapi_...' \
  -H 'Content-Type: application/json' \
  --data '{"origin":"https://api.example.com","message":"<EIP-4361 claim message>","signature":"0x..."}'
```

On success, the route returns `200` with the slugs now owned. The documented errors are `not_payee` with `403`, `no_listings` with `404`, `already_owned` with `409`, and `invalid_signature` with `401`.

```json
{
  "claimed": ["weather-call"]
}
```

Claiming changes who manages the mirrored listing. It remains a direct-payout listing. The claimed listing can appear in your `mine` response, request verification, and keep its name and description under your control.

## Edit an owned listing

### PATCH /api/call/listings/:slug

Update the name, description, or both on a listing owned by the credential's profile.

**Auth:** bearer.

| Path or body field | Description               |
| ------------------ | ------------------------- |
| `slug`             | Listing slug.             |
| `name`             | Optional new name.        |
| `description`      | Optional new description. |

```bash
curl -X PATCH 'https://api.vapinetwork.ai/api/call/listings/weather-call' \
  -H 'Authorization: Bearer vapi_...' \
  -H 'Content-Type: application/json' \
  --data '{"name":"Weather API","description":"Current weather data"}'
```

The response is the listing's new `{ ok, slug, name, description }` shape.

```json
{
  "ok": true,
  "slug": "weather-call",
  "name": "Weather API",
  "description": "Current weather data"
}
```

If the credential's profile does not own the slug, the route returns `404`.

Checked on 2026-10-15.
