---
title: "Usage and limits"
description: "Check daily Compute, prepaid balance, linked-agent allowances, and per-key request limits."
order: 9
---

Open [Router](https://api.vapinetwork.ai/router) in the account that owns your keys to see the daily Compute limit, spent and remaining amounts, and remaining prepaid Router balance. The [Usage page](https://api.vapinetwork.ai/router/usage) lists requests paid from Compute or purchased Router balance in the current daily epoch, starting at 00:00 UTC.

Available today combines remaining Compute and Router balance, with each source listed separately. Used today combines both sources, with a breakdown. Requests today counts requests; Resets in refers to Compute's daily reset. Account-session reads do not require an active browser-wallet connection.

## Daily Compute

An epoch is one 24-hour period starting at 00:00 UTC. Compute is a USD usage limit at model list price; unused Compute does not roll over.

Active stake is read as at 00:00:00 UTC. The snapshot job runs at 00:10 UTC to distribute the daily limit. Stake added during a day first counts at the next 00:00 UTC snapshot.

The limit depends on the daily pool (a fixed fraction of the remaining treasury-funded pool), eligible stake, any per-wallet cap, and an allocation floor. See [Compute entitlement](/stake/compute-entitlement/).

## Prepaid balance

Balance keys spend the owner's shared purchased Router balance. Purchased balance does not expire and is separate from the daily Compute limit. See [Buy Router balance](/router/buy-router-balance/).

Single-source keys spend only their selected source; direct clients switch those keys themselves. Owner hybrid keys use Compute first, then Router balance, preserving the same secret. Switching is asynchronous. Requests can receive a 429 budget error until reassignment completes. Repairs run every minute; a replica that missed cache eviction can take another 60 seconds. The last admitted request can overshoot Compute. See [Access and keys](/router/access-and-keys/).

CLI chat, local MCP `router.chat`, and SDK `client.router.chat()` try Compute first and fall back to a stored balance key on budget exhaustion. Rate limits do not trigger fallback. Use `vapi router usage --account <name> --json` or local MCP `router.usage` to inspect usage before a call; see [Use Router from your agents](/router/use-router-from-your-agents/) for the tool fields.

## Linked-agent limits

The owner's approved allowance caps each of the agent's Compute and balance keys separately. Each key has its own 24-hour reset window; the two keys do not share a single cap.

A Compute request is also bounded by the owner's remaining daily Compute. Usable Compute is the smaller of the agent key's remaining allowance and the owner's remaining limit. A balance request also requires sufficient owner prepaid balance.

## Per-key request limits

| Limit               | Default for new keys |
| ------------------- | -------------------: |
| Requests per minute |                  200 |
| Tokens per minute   |            1,000,000 |
| Concurrent requests |                   20 |

Router applies these defaults when creating a key. Keys created before 2026-11-02 keep 60 requests per minute, 100,000 tokens per minute and 10 concurrent requests until replaced with new keys.

These limits apply in addition to funding limits. Upstream model rate limits can also constrain requests.

## Shared daily ceiling

Router has a shared daily ceiling on upstream spending across all users. When the ceiling is reached, Router refuses requests until the daily reset. This ceiling is separate from your Compute limit, prepaid balance and per-agent allowance.

## Read usage through the console API

| Caller       | Endpoint                      | Authentication                 |
| ------------ | ----------------------------- | ------------------------------ |
| Owner        | `GET /api/router/usage`       | Owner session                  |
| Linked agent | `GET /api/agents/self/router` | Agent bearer with `router.use` |

Use `https://api.vapinetwork.ai` for these management endpoints. A Router model key is for the inference endpoint, not the console API.

Owner usage reports Compute-only spentUsd and remainingUsd against usageLimitUsd, with separate Router balance totals. Request rows cover both sources and identify source and Paid by. Attribution follows the user paying when the request began. Rejected rows display Rejected, No charge and None. Usage reads trigger hybrid reconciliation and wait at most two seconds.

The agent response reports its Compute allowance, the owner's Compute limit, usable Compute, and the owner's prepaid balance. Its `resetsAt` field is the owner's epoch boundary; each agent key retains its own 24-hour reset window.

See [Access and keys](/router/access-and-keys/) and [Use Router from your agents](/router/use-router-from-your-agents/).

Checked on 2026-11-17.
