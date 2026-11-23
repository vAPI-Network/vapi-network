---
title: "Agents and Router"
description: "HTTP routes for owner links, controls, prepaid balances, and live Router keys and usage."
order: 13
---

> [!NOTE]
> Router and Stake are live. For your first model request, start with [Call your first model](/router/api-quickstart/).

This page is for developers who need the HTTP routes behind agent links, owner controls, Router balance, and Router keys.

The `vapi` client and MCP server handle these flows for most users. See [Agents](/agents/) and the [CLI reference](/reference/cli/cli-reference/).

## Base URL

Use this base URL for every request on this page:

```text
https://api.vapinetwork.ai
```

## Device grant

The device grant lets an agent prove control of its wallet, then wait for the owner to approve the link.

| Endpoint                           | Auth | Surface | Stability |
| ---------------------------------- | ---- | ------- | --------- |
| `POST /oauth/device_authorization` | none | all     | `beta`    |
| `POST /oauth/token`                | none | all     | `stable`  |

### POST /oauth/device_authorization

Start the agent device grant with JSON or form data.

Auth: none.

| Request field          | Required | Description                                                                                                                                                                |
| ---------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agent_message`        | Yes      | EIP-4361 message bound to the API host and origin.                                                                                                                         |
| `agent_signature`      | Yes      | Agent wallet signature over `agent_message`.                                                                                                                               |
| `label`                | Yes      | 1 to 32 lowercase letters, digits, or hyphens. It must start with a letter or digit.                                                                                       |
| `device`               | No       | Device name using the same 1 to 32 character rule as `label`.                                                                                                              |
| `trust_device`         | No       | Boolean requesting approval through an owner-trusted device.                                                                                                               |
| `scope`                | No       | Space-separated subset of `mcp:call router.use call.publish tasks:read tasks:write`. Tasks scopes do not make Tasks live on production. Defaults to `mcp:call router.use`. |
| `router_allowance_usd` | No       | Number from 0 to 1000 that suggests an initial allowance. The owner chooses the value during approval.                                                                     |

Use the statement `Link this wallet to a vAPI account as an agent.` in the EIP-4361 message. Get its link-purpose nonce with `GET /api/auth/siwe-nonce?purpose=link`.

For automatic approval, send `device`, `trust_device=true`, and a bearer token for an account linked from that device. The owner must have trusted the device, and the token must cover the requested scopes. For `router.use`, supply `router_allowance_usd` within the trusted allowance. A successful automatic approval adds `auto_approved: true` to the response.

```bash
curl -X POST 'https://api.vapinetwork.ai/oauth/device_authorization' \
  -H 'Content-Type: application/json' \
  --data '{"agent_message":"<EIP-4361 message>","agent_signature":"<signature>","label":"weather-agent","scope":"mcp:call router.use","router_allowance_usd":25}'
```

A successful response contains the codes, approval URLs, polling interval, expiry, and agent client ID. Agent client IDs use the form `agent_<lowercase wallet>`.

```json
{
  "device_code": "<device code>",
  "user_code": "<user code>",
  "verification_uri": "<verification URI>",
  "verification_uri_complete": "<verification URI with code>",
  "expires_in": 1200,
  "interval": 5,
  "client_id": "agent_<lowercase wallet>"
}
```

| Status | Error                     | Meaning                                        |
| ------ | ------------------------- | ---------------------------------------------- |
| `400`  | `invalid_request`         | The request is invalid.                        |
| `400`  | `invalid_scope`           | The requested scope is not an allowed subset.  |
| `401`  | `invalid_agent_signature` | The agent signature is invalid.                |
| `503`  | `temporarily_unavailable` | The nonce or device-code store is unavailable. |

Error responses include `error_description`.

```json
{
  "error": "invalid_request",
  "error_description": "<description>"
}
```

### POST /oauth/token

Poll the token endpoint with the device grant form fields.

Auth: none.

| Form field    | Required | Description                                                   |
| ------------- | -------- | ------------------------------------------------------------- |
| `grant_type`  | Yes      | `urn:ietf:params:oauth:grant-type:device_code`                |
| `device_code` | Yes      | Code returned by the device authorization request.            |
| `client_id`   | Yes      | Agent client ID returned by the device authorization request. |

```bash
curl -X POST 'https://api.vapinetwork.ai/oauth/token' \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  --data-urlencode 'grant_type=urn:ietf:params:oauth:grant-type:device_code' \
  --data-urlencode 'device_code=<device code>' \
  --data-urlencode 'client_id=agent_<lowercase wallet>'
```

Owner-bound issuance and refresh require account readiness and a confirmed vAPI ID.

After approval, the response contains the OAuth tokens, scopes, and owner wallet. It may also contain a vAPI Router key and base URL.

```json
{
  "access_token": "<access token>",
  "token_type": "<token type>",
  "expires_in": "<seconds>",
  "refresh_token": "<refresh token>",
  "scope": "mcp:call router.use",
  "owner_wallet": "0x1234567890abcdef1234567890abcdef12345678",
  "router_key": "<Router key>",
  "router_base_url": "<Router base URL>"
}
```

If the account link succeeds but Router key creation fails, the response omits `router_key` and `router_base_url` and adds this field:

```json
{
  "access_token": "<access token>",
  "token_type": "<token type>",
  "expires_in": "<seconds>",
  "refresh_token": "<refresh token>",
  "scope": "mcp:call router.use",
  "owner_wallet": "0x1234567890abcdef1234567890abcdef12345678",
  "router_key_error": "router_unavailable"
}
```

| Status        | Error                     | Meaning                          |
| ------------- | ------------------------- | -------------------------------- |
| `400`         | `authorization_pending`   | Device-grant polling error.      |
| `400`         | `slow_down`               | Device-grant polling error.      |
| `400`         | `access_denied`           | Device-grant polling error.      |
| `400`         | `expired_token`           | Device-grant polling error.      |
| Not specified | `invalid_request`         | Invalid input or client binding. |
| Not specified | `invalid_client`          | Invalid input or client binding. |
| Not specified | `invalid_grant`           | Invalid input or client binding. |
| `503`         | `temporarily_unavailable` | The device store is unavailable. |

The public contract does not specify status codes for `invalid_request`, `invalid_client`, or `invalid_grant` on this endpoint.

### Related OAuth endpoints

| Method    | Endpoint                                  | Auth    | Surface                   | Stability | Purpose                                                            |
| --------- | ----------------------------------------- | ------- | ------------------------- | --------- | ------------------------------------------------------------------ |
| GET       | `/.well-known/oauth-authorization-server` | none    | all                       | `stable`  | Authorization-server metadata.                                     |
| GET       | `/.well-known/oauth-protected-resource`   | none    | all                       | `stable`  | Protected-resource metadata.                                       |
| POST      | `/oauth/revoke`                           | none    | all                       | `stable`  | Token revocation.                                                  |
| POST      | `/oauth/register`                         | none    | `call`, `network`, `full` | `stable`  | Dynamic client registration.                                       |
| GET       | `/oauth/authorize`                        | session | `call`, `network`, `full` | `stable`  | Interactive consent page in HTML. It is guarded on other surfaces. |
| GET, POST | `/link`                                   | session | `call`, `network`, `full` | `beta`    | Agent approval page in HTML.                                       |

Approval requires a ready owner account with a confirmed vAPI ID. Wallet, email and Google owners are supported; applicable own-wallet sessions require wallet proof.

`/link` is the owner's approval page. An unsigned caller sees the sign-in prompt, and approval or denial requires the owner's session.

## Linked agents (owner session)

These routes require the owner's session. They are internal console endpoints that may change. Owner-session writes need a same-origin `Origin` header, such as `Origin: https://api.vapinetwork.ai`.

| Method | Endpoint                | Auth    | Surface                   | Stability  |
| ------ | ----------------------- | ------- | ------------------------- | ---------- |
| GET    | `/api/agents`           | session | `call`, `network`, `full` | `internal` |
| PATCH  | `/api/agents/:clientId` | session | `call`, `network`, `full` | `internal` |
| DELETE | `/api/agents/:clientId` | session | `call`, `network`, `full` | `internal` |

Owners can list, download, or delete their encrypted device backups.

| Method | Endpoint                             | Auth                       | Purpose                                          |
| ------ | ------------------------------------ | -------------------------- | ------------------------------------------------ |
| GET    | `/api/agents/backups`                | owner session              | List encrypted device backup metadata.           |
| GET    | `/api/agents/devices/:device/backup` | owner session              | Download the device's stored encrypted envelope. |
| DELETE | `/api/agents/devices/:device/backup` | owner session, same origin | Delete the device's stored encrypted envelope.   |

Each agent summary contains `clientId`, `wallet`, `label`, `scopes`, `linkedAt`, `lastUsedAt`, and `router`. The `router` value is `null` or contains `allowanceUsd` and `spentTodayUsd`.

### GET /api/agents

List the owner's live agent links.

Auth: session.

```bash
curl 'https://api.vapinetwork.ai/api/agents' \
  --cookie '<owner session>'
```

```json
{
  "agents": [
    {
      "clientId": "agent_0x1234567890abcdef1234567890abcdef12345678",
      "wallet": "0x1234567890abcdef1234567890abcdef12345678",
      "label": "weather-agent",
      "scopes": ["mcp:call", "router.use"],
      "linkedAt": "<timestamp>",
      "lastUsedAt": "<timestamp>",
      "router": {
        "allowanceUsd": "<USD amount>",
        "spentTodayUsd": "<USD amount>"
      }
    }
  ]
}
```

One owner may have at most 50 linked agents. Relinking an agent wallet to an owner revokes its previous live link.

### PATCH /api/agents/:clientId

Change an agent's Router allowance.

Auth: session.

| Path or body field   | Description            |
| -------------------- | ---------------------- |
| `clientId`           | Agent client ID.       |
| `routerAllowanceUsd` | Number from 0 to 1000. |

```bash
curl -X PATCH 'https://api.vapinetwork.ai/api/agents/agent_0x1234567890abcdef1234567890abcdef12345678' \
  --cookie '<owner session>' \
  -H 'Origin: https://api.vapinetwork.ai' \
  -H 'Content-Type: application/json' \
  --data '{"routerAllowanceUsd":25}'
```

The response wraps the updated agent summary in `agent`. An unknown client ID returns `404`.

```json
{
  "agent": {
    "clientId": "agent_0x1234567890abcdef1234567890abcdef12345678",
    "wallet": "0x1234567890abcdef1234567890abcdef12345678",
    "label": "weather-agent",
    "scopes": ["mcp:call", "router.use"],
    "linkedAt": "<timestamp>",
    "lastUsedAt": "<timestamp>",
    "router": {
      "allowanceUsd": "<USD amount>",
      "spentTodayUsd": "<USD amount>"
    }
  }
}
```

### DELETE /api/agents/:clientId

Revoke the owner's tokens and vAPI Router keys for an agent. The request is idempotent.

Auth: session.

```bash
curl -X DELETE 'https://api.vapinetwork.ai/api/agents/agent_0x1234567890abcdef1234567890abcdef12345678' \
  -H 'Origin: https://api.vapinetwork.ai' \
  --cookie '<owner session>'
```

The response is `200` JSON with `autoApprovedLinks`, `auditRecorded`, `derivedStateCleanup`, and `routerCleanup`. Cleanup fields report `complete` or `incomplete`; do not assume every Router key was removed when cleanup is incomplete.

## Agent self endpoints (agent bearer)

These endpoints use an OAuth access token whose client ID starts with `agent_`.

| Method | Endpoint                              | Required scope            | Launch surface                      | Funding data or key        | Stability |
| ------ | ------------------------------------- | ------------------------- | ----------------------------------- | -------------------------- | --------- |
| GET    | `/api/agents/self`                    | No additional scope check | `call`, `market`, `network`, `full` | Link identity              | `beta`    |
| DELETE | `/api/agents/self`                    | No additional scope check | `call`, `market`, `network`, `full` | Revokes both sources' keys | `beta`    |
| GET    | `/api/agents/self/router`             | `router.use`              | `router`, `network`, `full`         | Both Compute and balance   | `beta`    |
| POST   | `/api/agents/self/router-key`         | `router.use`              | `router`, `network`, `full`         | Compute key                | `beta`    |
| POST   | `/api/agents/self/router-balance-key` | `router.use`              | `router`, `network`, `full`         | Balance key                | `beta`    |
| GET    | `/api/agents/self/stake`              | No additional scope check | `call`, `market`, `network`, `full` | Owner stake and Compute    | `beta`    |

The local client commands and tools are documented in [Use Router from your agents](/router/use-router-from-your-agents/). The client flag `vapi router key --rotate` calls the Compute key recovery endpoint; it does not reset an existing key's spend or budget window.

Additional routes expose sibling accounts, encrypted backup uploads, backup relays, and signed transfers.

| Method | Endpoint                                 | Auth                          | Purpose                                                                               |
| ------ | ---------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------- |
| GET    | `/api/agents/self/siblings`              | agent bearer, any agent scope | Read the owner's sibling accounts, devices, status, allowances, and self marker.      |
| PUT    | `/api/agents/self/backup`                | agent bearer, any agent scope | Store the owner-encrypted envelope for the agent's device.                            |
| POST   | `/api/agents/backup-relays`              | none                          | Create a backup relay with a public key, code, device, and purpose.                   |
| GET    | `/api/agents/backup-relays/:code`        | owner session                 | Bind the relay to the owner and read its public key and metadata.                     |
| PUT    | `/api/agents/backup-relays/:code`        | owner session, same origin    | Upload the sealed result as the bound owner.                                          |
| GET    | `/api/agents/backup-relays/:code/result` | code capability               | Read the pending status or retrieve the sealed result once.                           |
| POST   | `/api/agents/relay-transfer`             | agent bearer, any agent scope | Relay an unchanged agent-signed USDC authorization to the owner or an active sibling. |

### GET /api/agents/self

Read the calling agent's link.

Auth: agent bearer with any agent scope.

```bash
curl -H 'Authorization: Bearer <agent access token>' \
  'https://api.vapinetwork.ai/api/agents/self'
```

```json
{
  "clientId": "agent_0x1234567890abcdef1234567890abcdef12345678",
  "wallet": "0x1234567890abcdef1234567890abcdef12345678",
  "owner": "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
  "label": "weather-agent",
  "scopes": ["mcp:call", "router.use"],
  "linkedAt": "<timestamp>"
}
```

A revoked, expired, inactive, or non-agent credential receives `401` with `WWW-Authenticate`.

### DELETE /api/agents/self

Revoke the calling agent's link and vAPI Router keys.

Auth: agent bearer.

```bash
curl -X DELETE \
  -H 'Authorization: Bearer <agent access token>' \
  'https://api.vapinetwork.ai/api/agents/self'
```

The response is `200` JSON with `autoApprovedLinks`, `auditRecorded`, `derivedStateCleanup`, and `routerCleanup`. Cleanup fields report `complete` or `incomplete`; do not assume every Router key was removed when cleanup is incomplete.

Console API keys and non-agent OAuth clients receive `403`.

### GET /api/agents/self/router

Read the agent's daily Compute allowance and the owner's Router balance.

Auth: agent bearer with `router.use`.

```bash
curl -H 'Authorization: Bearer <agent access token>' \
  'https://api.vapinetwork.ai/api/agents/self/router'
```

```json
{
  "compute": {
    "allowanceUsd": "<USD amount>",
    "spentTodayUsd": "<USD amount>",
    "remainingTodayUsd": "<USD amount>",
    "resetsAt": "<timestamp>",
    "ownerLimitUsd": "<USD amount>",
    "ownerSpentUsd": "<USD amount>"
  },
  "balance": {
    "purchasedUsd": "<USD amount>",
    "spentUsd": "<USD amount>",
    "remainingUsd": "<USD amount>"
  }
}
```

`balance` is `null` when the owner has no Router balance.

The agent's Compute key is bounded by both its approved allowance and the owner's daily Compute limit. Compute and balance keys each have their own approved cap and 24-hour reset window; they do not share a single cap. `resetsAt` reports the owner's Compute epoch boundary.

### POST /api/agents/self/router-key

Get a Compute key, reusing the existing key without resetting spend or its 24-hour budget window when one exists. Recovery requires the calling credential and persisted owner approval to remain live. If recovery is unavailable, the owner must revoke the link and approve a new one.

Auth: agent bearer with `router.use`.

```bash
curl -X POST \
  -H 'Authorization: Bearer <agent access token>' \
  'https://api.vapinetwork.ai/api/agents/self/router-key'
```

```json
{
  "router_key": "<Router key>",
  "router_base_url": "<Router base URL>"
}
```

### POST /api/agents/self/router-balance-key

Get a balance key, reusing the existing key without resetting spend or its 24-hour budget window when one exists. The key has a separate cap equal to the approved agent allowance and spends the owner's shared prepaid Router balance.

Auth: agent bearer with `router.use`.

```bash
curl -X POST \
  -H 'Authorization: Bearer <agent access token>' \
  'https://api.vapinetwork.ai/api/agents/self/router-balance-key'
```

```json
{
  "router_key": "<Router key>",
  "router_base_url": "<Router base URL>"
}
```

### GET /api/agents/self/stake

Read the owner's stake and today's Compute amount for the agent.

Auth: agent bearer with any agent scope.

```bash
curl -H 'Authorization: Bearer <agent access token>' \
  'https://api.vapinetwork.ai/api/agents/self/stake'
```

```json
{
  "owner": "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
  "epoch": "<epoch>",
  "stake": "<token amount in base units>",
  "computeTodayUsd": "<USD amount>",
  "stakeUrl": "<stake URL>"
}
```

The `stake` value is a decimal string in token base units.

## Router top-up

### POST /api/router/top-up/{1|5|20|50}

Buy the selected vAPI Router balance tier with exact USDC. An owner session, API key, or agent bearer may call this endpoint.

| Auth                                                      | Surface                                       | Stability |
| --------------------------------------------------------- | --------------------------------------------- | --------- |
| owner session, API key, or agent bearer with `router.use` | `call`, `market`, `router`, `network`, `full` | `beta`    |

| Path value              | Description                   |
| ----------------------- | ----------------------------- |
| `1`, `5`, `20`, or `50` | Router balance amount in USD. |

Send an authenticated request first. This example selects the 5 USD tier.

```bash
curl -i -X POST 'https://api.vapinetwork.ai/api/router/top-up/5' \
  -H 'Authorization: Bearer <API key or agent access token>'
```

Missing owner authentication returns `401` without a `PAYMENT-REQUIRED` header.

```json
{
  "error": "owner_required"
}
```

An authenticated unpaid request returns `402` with exact-USDC `accepts` entries for the configured networks. The payment is USDC on Base; Arc is included when that network is configured.

```http
HTTP/1.1 402 Payment Required
Content-Type: application/json

{
  "accepts": ["<exact USDC payment requirement>"]
}
```

After settlement, the selected tier returns `200` and includes the `PAYMENT-RESPONSE` header.

```http
HTTP/1.1 200 OK
PAYMENT-RESPONSE: <payment response>
Content-Type: application/json

{
  "status": "accepted",
  "usd": 5,
  "owner": "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd"
}
```

See [x402 on vAPI](/reference/x402/x402/) for the payment flow.

## Owner Router endpoints

Management requests use https://api.vapinetwork.ai; inference uses https://router.vapinetwork.ai.
Owner-bound issuance, refresh and link completion require a ready account with a confirmed vAPI ID.
Wallet, email and Google owners can approve links; applicable own-wallet sessions must supply wallet proof.

| Method | Path                     | Access and contract                                                                                                                             |
| ------ | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | /api/router/keys         | Owner session; keys, count and maximum. Hybrid rows include nullable payingNow.                                                                 |
| POST   | /api/router/keys         | Owner session and applicable wallet proof; label and source. Source defaults to compute; accepts balance and hybrid.                            |
| DELETE | /api/router/keys/:id     | Owner session and applicable wallet proof; revoke a key.                                                                                        |
| GET    | /api/router/usage        | Owner session; Compute figures, separate balance, both sources' epoch requests, stakeSnapshot and top-up tiers. Triggers hybrid reconciliation. |
| GET    | /api/router/models       | Public upstream model catalog.                                                                                                                  |
| GET    | /api/router/burns        | Public expanded burn report.                                                                                                                    |
| GET    | /api/router/burns/ledger | Public paginated transfer ledger; optional day and opaque cursor.                                                                               |

Ten active owner keys cover all three source choices.
Labels contain 1–80 characters.
New keys receive 200 requests per minute, 1,000,000 tokens per minute and 20 concurrent requests.
Keys created before 2026-11-02 retain their earlier limits until replaced.

Hybrid uses Compute first, then available Router balance, preserving its secret through source reassignment.
Switching is asynchronous; requests can receive HTTP 429 with budget_exceeded before reassignment completes.
Reconciliation runs after distribution, every minute and before owner usage reads, which wait at most two seconds.
A replica that missed cache eviction can take another 60 seconds.
The last admitted request can overshoot Compute.
Linked agents retain separate Compute and balance credentials with separate approved caps and 24-hour windows.

| Usage or key field     | Meaning                                                                         |
| ---------------------- | ------------------------------------------------------------------------------- |
| source                 | Owner choice compute, balance or hybrid; request rows identify the source used. |
| payingNow              | Nullable current paying source on hybrid key rows.                              |
| usageLimitUsd          | Daily Compute usage limit.                                                      |
| spentUsd, remainingUsd | Compute-only top-level amounts; balance totals are separate.                    |
| stakeSnapshot          | Stake snapshot data when available.                                             |
| Top-up tiers           | Available prepaid purchase tiers.                                               |
| Request attribution    | Uses the paying user when the request began; the console labels this Paid by.   |

Applicable create and revoke sessions can receive HTTP 403 with wallet_proof_required.
Guarded credentials can be refused with account_not_ready until account setup and ID confirmation complete.
See [Burn and supply](/reference/http-api/burns/) for report fields, ledger pagination and numeric supply routes.

## Router deposits

Opening the address endpoint issues and persists an address on first use.
It accepts authenticated bearer access, unlike the list and claim routes.
All three routes return HTTP 404 before authentication when deposits are disabled.

| Method | Path                           | Access                                                         | Contract                                                                                 |
| ------ | ------------------------------ | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| GET    | /api/router/deposit-address    | Owner session or bearer principal; agents require router.use.  | Issues the per-profile address; returns address, chainId, network, asset and minimumUsd. |
| GET    | /api/router/deposits           | Owner session only; Authorization-header callers are rejected. | Returns deposits, held total and claim candidates.                                       |
| POST   | /api/router/deposits/:id/claim | Owner session only.                                            | Credits an eligible stored candidate; error statuses include 400, 403, 404, 409 and 422. |

The list reads the newest 50 stored rows and merges current Arriving observations.
It is not full-history pagination; held totals include older held records.
Claims require an eligible profile or linked-agent sender, at least $1, one matching transfer and finalized canonical success without prior credit.
Deposit-address credits can use safe confirmation; claims retain finalized checks.
No authenticated deposit samples were collected.
See [Router deposit contracts](/reference/http-api/router-deposit-contracts/) for addresses and forwarding mechanics.

## Next

- [Agents](/agents/)
- [CLI reference](/reference/cli/cli-reference/)
- [x402 on vAPI](/reference/x402/x402/)

Checked on 2026-11-17.
