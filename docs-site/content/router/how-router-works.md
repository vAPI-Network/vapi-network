---
title: "How Router works"
description: "Router runs LiteLLM Proxy with Venice and 0G models, wallet-bound keys, Compute limits, and prepaid balance."
order: 6
---

vAPI Router runs LiteLLM Proxy at `https://router.vapinetwork.ai`. It forwards OpenAI-compatible requests to Venice and 0G, the production upstreams.

## Request flow

1. Your client sends a request with a Router bearer key.
2. Router checks the key's funding source and limits.
3. Venice or 0G serves the model request.
4. Router meters usage at the model's USD list price.

Use `https://router.vapinetwork.ai/v1` as the SDK base URL. See [Call your first model](/router/api-quickstart/).

## Two funding sources

| Source         | Mechanism                                                                                     |
| -------------- | --------------------------------------------------------------------------------------------- |
| Compute        | A daily USD usage limit calculated from active vAPI stake. Unused Compute does not roll over. |
| Router balance | Prepaid usage bought with USDC. Purchased balance does not expire.                            |

Single-source keys use the source selected at creation; direct clients switch those keys themselves. Owner hybrid keys use Compute first, then Router balance, preserving the same secret. Switching is asynchronous. Requests can receive a 429 budget error until reassignment completes. Repairs run every minute; a replica that missed cache eviction can take another 60 seconds. The last admitted request can overshoot Compute. See [Access and keys](/router/access-and-keys/). Linked agents also have owner-approved key allowances. See [Usage and limits](/router/usage-and-limits/).

CLI chat, local MCP chat, and SDK `client.router.chat()` try Compute first, then a stored balance key on budget exhaustion. Rate limits do not trigger that fallback. See [Use Router from your agents](/router/use-router-from-your-agents/) for these clients.

## Models and privacy

Router supports text, embeddings, speech, transcription, and image generation. The [Models page](/router/models/) explains billing units and the `private` and `anonymized` labels for rows from either upstream.

For anonymized Venice rows:

Venice strips user-identifying metadata; the upstream provider's own retention and training policy applies.

0G TeeML rows run inference inside a TEE and carry `private`. TeeTLS rows attest the route and carry `anonymized`; the upstream sees the prompt and its retention and training policy applies.

Router has no shared response cache. Venice text models meter prompt-cache reads and writes at their configured cache prices on both endpoints; 0G rows carry no cache prices. See [Models](/router/models/#prompt-cache-pricing).

## Console controls

The console provides key creation and revocation, balance purchases, the model catalog, and usage views. Keys, usage and balance are managed in the vAPI console only. Router does not serve the upstream proxy dashboard or its generated API documentation. Model inference runs through Router rather than the console API.

Checked on 2026-11-17.
