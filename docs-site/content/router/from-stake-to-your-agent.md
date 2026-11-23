---
title: "From stake to your agent"
description: "Stake vAPI, receive a daily Compute limit, create a Router key, and give that key to your agent or AI app."
order: 2
---

This page is for a vAPI holder who wants to run the whole loop on production in one pass: stake, get Compute, call a model, and put Router inside an agent.

## Before you start

| You need                      | Why                                                                   |
| ----------------------------- | --------------------------------------------------------------------- |
| A wallet on Base holding vAPI | Staking is on Base mainnet.                                           |
| A little ETH on Base          | Staking pays gas for one transaction, or two when approval is needed. |
| Node.js 20 or newer           | Only for the optional CLI steps.                                      |

You can also start without staking: buy Router balance in USDC on the [Router page](https://api.vapinetwork.ai/router) and skip to step 3.

## 1. Stake

1. Open [api.vapinetwork.ai/stake](https://api.vapinetwork.ai/stake). Sign in to the account holding your stake. Wallet, email and Google login are supported. Connect the matching external wallet for transactions; the embedded connector cannot pay staking network fees.
2. Select Stake, then enter Amount to stake in review. Approve if needed, then confirm the stake transaction.
3. The page confirms the stake and shows the Compute projection for your position.

Your active stake must be at least 1 vAPI. The stake shows on [Basescan](https://basescan.org/address/0x845971FC0CE42A4840B05D89271595D6645928C3) under the staking contract.

## 2. Wait for the snapshot

Active stake is read at 00:00:00 UTC. The job sets the daily limit from 00:10 UTC. A stake made today counts from tomorrow.

```text
daily pool  = remaining pool / runway days
your limit  = daily pool × your stake / total eligible stake
```

The console shows the current pool and your projected limit. The pool declines as Compute is used, so the projection can change before the next snapshot. Unused Compute expires at the next 00:00 UTC and does not roll over. Read [Compute entitlement](/stake/compute-entitlement/) for the cap, floor and exclusions.

From 00:10 UTC, the [Router page](https://api.vapinetwork.ai/router) shows today's limit, spent and remaining.

## 3. Create a Router key

1. Open [API keys](https://api.vapinetwork.ai/router/keys) with the same wallet.
2. Enter a label and choose Compute, Router balance, or Compute, then Router balance.
3. Select Create Router key and copy the secret. It is shown once.

Single-source keys spend only their chosen source. Owner hybrid keys use Compute first, then Router balance, preserving the same secret. Switching is asynchronous. Requests can receive a 429 budget error until reassignment completes. Repairs run every minute; a replica that missed cache eviction can take another 60 seconds. The last admitted request can overshoot Compute. See [Access and keys](/router/access-and-keys/). A Compute key answers with a budget error until your first snapshot has run.

New keys default to 200 requests per minute, 1,000,000 tokens per minute and 20 concurrent requests. Router applies these defaults when creating a key. Keys created before 2026-11-02 keep 60 requests per minute, 100,000 tokens per minute and 10 concurrent requests until replaced with new keys.

## 4. Call a model

```bash
export VAPI_ROUTER_KEY='sk-…redacted'

curl https://router.vapinetwork.ai/v1/chat/completions \
  -H "Authorization: Bearer $VAPI_ROUTER_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "venice/claude-sonnet-4-5",
    "max_tokens": 40,
    "messages": [{"role": "user", "content": "Hello from vAPI Router"}]
  }'
```

Response from production on 2026-10-28, trimmed to the fields you use:

```json
{
  "id": "msg_011CgUemUyjZo4YSt4uTTvKW",
  "model": "venice/claude-sonnet-4-5",
  "object": "chat.completion",
  "choices": [
    {
      "finish_reason": "length",
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "Hello! I see you're working with vAPI Router. How can I help you today? Are you looking to:\n\n- Set up or configure vAPI routing\n- Troubleshoot an"
      }
    }
  ],
  "usage": { "completion_tokens": 40, "prompt_tokens": 12, "total_tokens": 52 },
  "cost": { "usd": 0.000636 }
}
```

List the model ids your key can use:

```bash
curl https://router.vapinetwork.ai/v1/models \
  -H "Authorization: Bearer $VAPI_ROUTER_KEY"
```

```json
{
  "object": "list",
  "data": [
    { "id": "venice/aion-labs-aion-3-0", "object": "model", "owned_by": "openai", "mode": "chat" },
    {
      "id": "venice/aion-labs-aion-3-0-mini",
      "object": "model",
      "owned_by": "openai",
      "mode": "chat"
    }
  ]
}
```

Prices, context sizes and privacy labels are on the console [Models page](https://api.vapinetwork.ai/router/models). Ids are prefixed by upstream: `venice/…` or `0g/…`, for example `0g/qwen3.7-flash`.

## 5. Put Router inside your agent

Router is OpenAI-compatible, so any framework that takes a base URL and an API key works. Set the base URL to `https://router.vapinetwork.ai/v1`, the key to your Router key, and the model to an id from step 4.

```python
import os
from openai import OpenAI

client = OpenAI(base_url="https://router.vapinetwork.ai/v1", api_key=os.environ["VAPI_ROUTER_KEY"])
reply = client.chat.completions.create(
    model="venice/claude-sonnet-4-5",
    messages=[{"role": "user", "content": "Summarize today's plan in one line."}],
)
print(reply.choices[0].message.content)
```

```javascript
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "https://router.vapinetwork.ai/v1",
  apiKey: process.env.VAPI_ROUTER_KEY,
});
const reply = await client.chat.completions.create({
  model: "0g/qwen3.7-flash",
  messages: [{ role: "user", content: "Summarize today's plan in one line." }],
});
console.log(reply.choices[0].message.content);
```

Tools that read the OpenAI environment variables work without code: set `OPENAI_BASE_URL=https://router.vapinetwork.ai/v1` and `OPENAI_API_KEY` to your Router key, then pick a model id in the tool's settings. Streaming works with `stream: true`.

To run Claude Code or Codex on your Compute, with your own subscription as the fallback, see [Use your Compute in Claude Code and Codex](/router/use-compute-in-claude-code-and-codex/).

## 6. Optional: link a vAPI agent

A vAPI agent is a local wallet linked to your account. It gets its own Router keys within an allowance you approve, and it can also pay x402 APIs on Call.

```bash
npm i -g vapi-network
vapi init
vapi login
```

`login` prints a code and a link such as `https://api.vapinetwork.ai/link?code=XXXX-XXXX`. Open it, sign in to the ready account that owns the stake. Wallet, email and Google login are supported; own-wallet proof may be requested. Set the agent's daily Router allowance in USD and approve. Then:

```bash
vapi stake status
vapi router models
vapi router chat --model venice/claude-sonnet-4-5 "Hello from my agent"
```

The agent's Compute calls are bounded by its allowance and by your daily limit. To use the same agent inside Claude, Cursor or Codex, see [MCP server for Claude, Cursor and Codex](/agents/in-your-ai-app/use-vapi-in-claude-cursor-and-codex/). Your agents and their spend are on [My agents](https://api.vapinetwork.ai/agents) and [Usage](https://api.vapinetwork.ai/usage).

## 7. Check usage and unstake

The [Router page](https://api.vapinetwork.ai/router) shows today's limit, spent and remaining, and [Router usage](https://api.vapinetwork.ai/router/usage) lists the request records for the current epoch.

On the [Stake page](https://api.vapinetwork.ai/stake), select Unstake, enter Amount to withdraw and review Request withdrawal. The amount leaves active stake immediately and starts a 24-hour cooldown. When ready, select Withdraw {amount} vAPI. You can cancel during or after cooldown until withdrawal.

## If something does not work

| What you see                               | Cause                                                                                       | What to do                                                                                                        |
| ------------------------------------------ | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Router shows no Compute the day you staked | The snapshot has not run yet                                                                | Wait for 00:10 UTC, or buy Router balance for today                                                               |
| `401` from `router.vapinetwork.ai`         | Wrong key, or a console session token used as a key                                         | Create a key on API keys and send it as `Authorization: Bearer`                                                   |
| `400 Invalid model name`                   | The id is not in the catalog                                                                | Copy an id from `GET /v1/models` or the Models page                                                               |
| Budget exceeded                            | Today's Compute or the key's balance is used up                                             | Wait for the next epoch, or fund balance and use a balance or hybrid key. Hybrid reassignment can require a retry |
| `429`                                      | Request, token or concurrency limits, budget exhaustion, or hybrid reassignment; see step 3 | Slow down and retry after a minute                                                                                |
| Stake transaction fails before signing     | No ETH on Base for gas                                                                      | Send a small amount of ETH to the wallet                                                                          |

## Next

- [Compute entitlement](/stake/compute-entitlement/)
- [Use Router from your agents](/router/use-router-from-your-agents/)
- [Use your Compute in Claude Code and Codex](/router/use-compute-in-claude-code-and-codex/)
- [Buy Router balance](/router/buy-router-balance/)

Checked on 2026-11-17.
