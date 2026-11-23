---
title: "Router"
description: "Call models through one OpenAI-compatible endpoint, using prepaid Router balance or a daily Compute limit from staking."
order: 9
---

vAPI Router provides OpenAI-compatible model access at `https://router.vapinetwork.ai`. It runs LiteLLM Proxy with Venice and 0G as production upstreams. It also exposes an Anthropic Messages-compatible endpoint at `POST /v1/messages` for clients such as Claude Code.

[Call your first model](/router/api-quickstart/) with curl, Python, or JavaScript. Buy prepaid Router balance to start without waiting for a stake snapshot, or use the daily Compute limit from staking vAPI.

## In the console

Open [Router](https://api.vapinetwork.ai/router) to see Available today, combining remaining Compute and Router balance. Each source appears separately underneath. Used today combines spending from both sources. Compute resets at 00:00 UTC; Router balance stays until spent. The 100 cells show used amounts in grey, remaining Compute in orange and remaining balance in blue. Use [API keys](https://api.vapinetwork.ai/router/keys) to create a key, [Models](https://api.vapinetwork.ai/router/models) to choose a model, and [Usage](https://api.vapinetwork.ai/router/usage) to inspect requests paid from Compute or purchased Router balance.

Owner keys offer Compute, Router balance, or Compute, then Router balance. Owner hybrid keys use Compute first, then Router balance, preserving the same secret. Switching is asynchronous. Requests can receive a 429 budget error until reassignment completes. Repairs run every minute; a replica that missed cache eviction can take another 60 seconds. The last admitted request can overshoot Compute. See [Access and keys](/router/access-and-keys/).

The header action is Create Router key. Get more offers Stake vAPI, Add from wallet and Send USDC from an exchange. Stake vAPI becomes Manage stake when applicable. The hero Top up Router balance button opens Add from wallet and scrolls to Get more. It does not submit payment or open Send USDC. See [Buy Router balance](/router/buy-router-balance/).

Signed-out visitors see public pool metrics without personal dollar figures or Send USDC. Failed reads show Usage is unavailable; missing figures are not shown as zero.

## Next

- [Call your first model](/router/api-quickstart/)
- [From stake to your agent](/router/from-stake-to-your-agent/)
- [Buy Router balance](/router/buy-router-balance/)
- [Use Router from your agents](/router/use-router-from-your-agents/)
- [How Router works](/router/how-router-works/)

Checked on 2026-11-17.
