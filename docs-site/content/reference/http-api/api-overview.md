---
title: "HTTP API overview"
description: "The vAPI Network HTTP API provides public Call discovery reads and bearer-authenticated listing management."
order: 5
---

> [!NOTE]
> Call, Router, Stake and Agents are live. Tasks is coming soon.

The vAPI HTTP API gives you public discovery and catalogue reads for Call listings, plus a bearer-authenticated API for publishing and managing your own listings. Use it when you need direct HTTP access instead of the CLI, SDK, or MCP server.

## Base URL

Use this base URL for the API:

```text
https://api.vapinetwork.ai
```

Public read endpoints do not need authentication. They are rate-limited. Listing writes and the machine listing API use a bearer credential.

Guarded credentials require a ready account and confirmed vAPI ID. Applicable session mutations require wallet proof. Public reads remain public.

To create an API key, open the [API keys page](https://api.vapinetwork.ai/connect?advanced=keys#api-keys) in the vAPI console. Send the key in the standard `Authorization` header:

```http
Authorization: Bearer vapi_...
```

An OAuth access token is also accepted where the API specifies bearer auth. API keys have no scopes today. Treat an active key as full authority over its profile's listings.

## Content types

Most successful API responses use JSON. Errors use either JSON or plain text as documented by each endpoint. Send JSON request bodies with `Content-Type: application/json` and ask for JSON with `Accept: application/json`.

These successful responses use a content type other than `application/json`:

| Endpoint                       | Content type               |
| ------------------------------ | -------------------------- |
| `GET /call/feed.xml`           | `application/atom+xml`     |
| `GET /.well-known/api-catalog` | `application/linkset+json` |
| `GET /api/supply/total`        | Plain-text decimal number  |
| `GET /api/supply/circulating`  | Plain-text decimal number  |

## Errors and status codes

The documented routes use these statuses for the cases described in the API contract:

| Status | Meaning in the documented routes                                                                                |
| ------ | --------------------------------------------------------------------------------------------------------------- |
| `201`  | A listing was created as a draft.                                                                               |
| `202`  | A listing recheck was accepted.                                                                                 |
| `401`  | Bearer authentication or a signature is invalid.                                                                |
| `403`  | A claim signer is not the payout wallet; guarded access can return account_not_ready or wallet_proof_required.  |
| `404`  | A listing or catalogue entry is not found, unpublished, or not owned by the credential.                         |
| `409`  | A state change is invalid, a slug collides, a claim is already owned, or a mirrored listing cannot be resynced. |
| `422`  | A publish or status request has no usable x402 challenge.                                                       |
| `429`  | A protection or recheck rate limit was reached.                                                                 |
| `503`  | The nonce store or a payout network is unavailable.                                                             |

Unknown `/api/*` paths return the resource-not-found route, not an HTML page.

## Versioning and deprecated paths

Public paths are versionless. A breaking change gets a new path. The old path can remain as a deprecated alias for one release, with these headers on the deprecated path:

```http
Deprecation: true
Link: </api/call/discovery>; rel="successor-version"
```

Bodies, statuses, and authentication are the same on an alias and its canonical path. The discovery alias points to `/api/call/discovery`; the services alias points to `/api/call/services`.

For `GET /api/network/services`, the successor header is instead:

```http
Deprecation: true
Link: </api/call/services>; rel="successor-version"
```

## Endpoint index

The public API also exposes these endpoints:

| Method        | Path                              | Purpose                                                                                                              |
| ------------- | --------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `GET`         | `/api/call/identity/:wallet`      | Read an ERC-8004 identity and reputation for a wallet.                                                               |
| `GET`         | `/api/wallet/usage`               | Read call and spend totals for a wallet.                                                                             |
| `POST`        | `/api/id/mint`                    | Mint the signed-in account's vAPI ID; owner session, same-origin request and join-verification eligibility required. |
| `GET`         | `/api/id/access`                  | Poll readiness and waiting outcomes for account access.                                                              |
| `GET`         | `/api/id/me`                      | Read the signed-in wallet's ID and reconcile mint status; never mints.                                               |
| `GET`         | `/api/id/:address`                | Read a public address-only vAPI ID card.                                                                             |
| `GET`         | `/api/id/token/:tokenId`          | Read ERC-721 metadata for an existing ID.                                                                            |
| `GET`         | `/api/id/token/:tokenId/card.svg` | Read the ID card as SVG.                                                                                             |
| `POST`        | `/api/wallet/onramp-session`      | Create a Coinbase Onramp session for a wallet.                                                                       |
| `GET`, `HEAD` | `/api/supply/total`               | Read the total supply as whole vAPI units.                                                                           |
| `GET`, `HEAD` | `/api/supply/circulating`         | Read the circulating supply as whole vAPI units.                                                                     |
| `POST`        | `/api/support/reports`            | Submit a privacy-preserving client report.                                                                           |
| `GET`         | `/api/tasks/readiness`            | Check task deployment readiness where Tasks routes are mounted; Tasks is not live on production.                     |
| `GET`, `POST` | `/mcp`                            | Use the bearer-authenticated hosted MCP transport.                                                                   |
| `GET`         | `/mcp/health`                     | Check the hosted MCP transport and revision.                                                                         |
| `POST`        | `/x402/decode`                    | Decode a payment authorization after x402 payment.                                                                   |
| `GET`         | `/x402/openapi.json`              | Read the decoder's OpenAPI document.                                                                                 |
| `GET`         | `/.well-known/x402`               | Discover the public x402 resources.                                                                                  |

The detailed endpoint pages are:

| Endpoint                                   | Page                                                                  |
| ------------------------------------------ | --------------------------------------------------------------------- |
| `GET /api/call/discovery`                  | [Discovery and services](/reference/http-api/discovery-and-services/) |
| `GET /api/marketplace/discovery`           | [Discovery and services](/reference/http-api/discovery-and-services/) |
| `GET /api/call/services`                   | [Discovery and services](/reference/http-api/discovery-and-services/) |
| `GET /api/network/services`                | [Discovery and services](/reference/http-api/discovery-and-services/) |
| `GET /api/calls/list`                      | [Listing detail](/reference/http-api/listing-detail/)                 |
| `GET /api/calls/search`                    | [Discovery and services](/reference/http-api/discovery-and-services/) |
| `GET /api/calls/:serviceId`                | [Listing detail](/reference/http-api/listing-detail/)                 |
| `POST /api/call/listings/:slug/resync`     | [Listing detail](/reference/http-api/listing-detail/)                 |
| `GET /api/call/stats`                      | [Stats and activity](/reference/http-api/stats-and-activity/)         |
| `GET /api/call/activity`                   | [Stats and activity](/reference/http-api/stats-and-activity/)         |
| `GET /api/call/activity/:address`          | [Stats and activity](/reference/http-api/stats-and-activity/)         |
| `GET /call/feed.xml`                       | [Feed and API catalog](/reference/http-api/feed-and-api-catalog/)     |
| `GET /.well-known/api-catalog`             | [Feed and API catalog](/reference/http-api/feed-and-api-catalog/)     |
| `HEAD /.well-known/api-catalog`            | [Feed and API catalog](/reference/http-api/feed-and-api-catalog/)     |
| `GET /api/call/listings/mine`              | [Listings write API](/reference/http-api/listings-write-api/)         |
| `GET /api/call/listings/payout-nonce`      | [Listings write API](/reference/http-api/listings-write-api/)         |
| `POST /api/call/listings/probe`            | [Listings write API](/reference/http-api/listings-write-api/)         |
| `POST /api/call/listings`                  | [Listings write API](/reference/http-api/listings-write-api/)         |
| `POST /api/call/listings/:slug/status`     | [Listings write API](/reference/http-api/listings-write-api/)         |
| `GET /api/call/listings/claim-nonce`       | [Claim and edit](/reference/http-api/claim-and-edit/)                 |
| `POST /api/call/listings/claim`            | [Claim and edit](/reference/http-api/claim-and-edit/)                 |
| `PATCH /api/call/listings/:slug`           | [Claim and edit](/reference/http-api/claim-and-edit/)                 |
| `POST /oauth/device_authorization`         | [Agents and Router](/reference/http-api/agents-and-router/)           |
| `POST /oauth/token`                        | [Agents and Router](/reference/http-api/agents-and-router/)           |
| `GET /api/agents`                          | [Agents and Router](/reference/http-api/agents-and-router/)           |
| `PATCH /api/agents/:clientId`              | [Agents and Router](/reference/http-api/agents-and-router/)           |
| `DELETE /api/agents/:clientId`             | [Agents and Router](/reference/http-api/agents-and-router/)           |
| `GET /api/agents/self`                     | [Agents and Router](/reference/http-api/agents-and-router/)           |
| `DELETE /api/agents/self`                  | [Agents and Router](/reference/http-api/agents-and-router/)           |
| `GET /api/agents/self/router`              | [Agents and Router](/reference/http-api/agents-and-router/)           |
| `POST /api/agents/self/router-key`         | [Agents and Router](/reference/http-api/agents-and-router/)           |
| `POST /api/agents/self/router-balance-key` | [Agents and Router](/reference/http-api/agents-and-router/)           |
| `GET /api/agents/self/stake`               | [Agents and Router](/reference/http-api/agents-and-router/)           |
| `POST /api/router/top-up/{1\|5\|20\|50}`   | [Agents and Router](/reference/http-api/agents-and-router/)           |
| `GET, POST /api/router/keys`               | [Router reference](/reference/http-api/agents-and-router/)            |
| `DELETE /api/router/keys/:id`              | [Router reference](/reference/http-api/agents-and-router/)            |
| `GET /api/router/usage`                    | [Router reference](/reference/http-api/agents-and-router/)            |
| `GET /api/router/models`                   | [Router reference](/reference/http-api/agents-and-router/)            |
| `GET /api/router/deposit-address`          | [Router reference](/reference/http-api/agents-and-router/)            |
| `GET /api/router/deposits`                 | [Router reference](/reference/http-api/agents-and-router/)            |
| `POST /api/router/deposits/:id/claim`      | [Router reference](/reference/http-api/agents-and-router/)            |
| `GET /api/router/burns`                    | [Router reference](/reference/http-api/burns/)                        |
| `GET /api/router/burns/ledger`             | [Router reference](/reference/http-api/burns/)                        |
| `GET, HEAD /api/supply/total`              | [Burn and supply](/reference/http-api/burns/)                         |
| `GET, HEAD /api/supply/circulating`        | [Burn and supply](/reference/http-api/burns/)                         |

Checked on 2026-11-17.
