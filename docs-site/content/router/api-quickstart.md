---
title: "Call your first model"
description: "Get access, create a Router key, and call a model with curl or the OpenAI Python and JavaScript SDKs."
order: 1
---

## 1. Get access

Wallet, email and Google sign-in can open your account. Key creation requires a ready account with a confirmed vAPI ID; applicable own-wallet actions can require wallet proof. Sign in to your account at [Router](https://api.vapinetwork.ai/router). Choose how to fund usage:

| Source         | How to start                                                                                                                                                           |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Router balance | Buy a $1, $5, $20, or $50 top-up in USDC. Use this path to start without waiting for a stake snapshot.                                                                 |
| Compute        | [Stake vAPI](https://api.vapinetwork.ai/stake). Stake made during a day first counts at the next 00:00 UTC snapshot; the job runs at 00:10 UTC to set the daily limit. |

You can also send Base USDC to your per-user deposit address. See [Buy Router balance](/router/buy-router-balance/) for funding and confirmation details.

## 2. Create a key

From `/router`, open [API keys](https://api.vapinetwork.ai/router/keys). Enter a label, select Compute, Router balance, or Compute, then Router balance, and select Create Router key. Copy the secret when it appears; it is shown once.

Set it in your terminal:

```bash
export VAPI_ROUTER_KEY='paste-your-router-key-here'
```

Single-source keys spend only their selected source; direct clients switch those keys themselves. Owner hybrid keys use Compute first, then Router balance, preserving the same secret. Switching is asynchronous. Requests can receive a 429 budget error until reassignment completes. Repairs run every minute; a replica that missed cache eviction can take another 60 seconds. The last admitted request can overshoot Compute. See [Access and keys](/router/access-and-keys/).

## 3. Send a request

```bash
curl https://router.vapinetwork.ai/v1/chat/completions \
  -H "Authorization: Bearer $VAPI_ROUTER_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "venice/deepseek-v4-flash",
    "messages": [{"role": "user", "content": "Hello from vAPI Router"}]
  }'
```

The reply is in `choices[0].message.content`. For streaming, add `"stream": true` to the JSON body and use `curl -N`.

## Use the OpenAI Python SDK

Install with `pip install openai`, then run:

```python
import os
from openai import OpenAI

client = OpenAI(
    base_url="https://router.vapinetwork.ai/v1",
    api_key=os.environ["VAPI_ROUTER_KEY"],
)
response = client.chat.completions.create(
    model="venice/deepseek-v4-flash",
    messages=[{"role": "user", "content": "Hello from vAPI Router"}],
)
print(response.choices[0].message.content)
```

## Use the OpenAI JavaScript SDK

Install with `npm install openai`. Save this as `router.mjs` and run `node router.mjs`:

```javascript
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "https://router.vapinetwork.ai/v1",
  apiKey: process.env.VAPI_ROUTER_KEY,
});
const response = await client.chat.completions.create({
  model: "venice/deepseek-v4-flash",
  messages: [{ role: "user", content: "Hello from vAPI Router" }],
});
console.log(response.choices[0].message.content);
```

Both SDKs accept `stream=True` in Python or `stream: true` in JavaScript for streaming responses.

## Anthropic Messages-compatible clients

Router also accepts `POST /v1/messages`, the Anthropic Messages-compatible endpoint used by Claude Code. It routes through chat completions and uses your Router key and its selected funding source. Model-specific prompt-cache prices apply to reported cache reads and writes; see [Models](/router/models/#prompt-cache-pricing).

## List models

Use the same bearer key:

```bash
curl https://router.vapinetwork.ai/v1/models \
  -H "Authorization: Bearer $VAPI_ROUTER_KEY"
```

The console [Models page](https://api.vapinetwork.ai/router/models) shows prices, capabilities, and privacy labels. See [Models](/router/models/) for model kinds and billing units.

## See usage

Open [Router](https://api.vapinetwork.ai/router) in the account that owns the key, without requiring a browser-wallet connection, to see today's Compute usage and remaining prepaid balance. The [Usage page](https://api.vapinetwork.ai/router/usage) lists requests paid from Compute or purchased Router balance in the current daily epoch, starting at 00:00 UTC. Records can take a short time to appear because Router batches spend writes.

See [Usage and limits](/router/usage-and-limits/) and [Access and keys](/router/access-and-keys/). For the vAPI CLI, local MCP, or bundled JS/TS client, see [Use Router from your agents](/router/use-router-from-your-agents/).

Checked on 2026-11-17.
