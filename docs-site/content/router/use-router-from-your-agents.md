---
title: "Use Router from your agents"
description: "Give linked agents scoped model access with separate Compute and balance key caps."
order: 3
---

Owner-bound credentials require a ready account with a confirmed vAPI ID. Complete [account setup](/account-and-sign-in/) before linking.

A linked agent uses Router on its owner's account. Its model keys do not grant control over the owner's wallet.

## Link a local account

Install or update to client 0.14.0.

```bash
npm i -g vapi-network@latest
```

Link your local account.

```bash
vapi login --account researcher
vapi whoami --account researcher
```

Use an existing local account name. `login` accepts `--label <name>`, `--no-browser`, and `--publish` for optional Call publishing permission. Follow the approval URL printed by the client and approve in the ready owner account. Wallet, email and Google sign-in are supported; own-wallet proof may be requested; the code lasts 20 minutes. `whoami` reports the owner link and scopes.

Clients ≤0.9.0 fail searches whose results include a Solana row. The first published fix was 0.9.2; 0.9.1 was never published. Version 0.14.0 includes that fix. Solana payments remain unsupported in 0.14.0.

## Approve an allowance

An owner can link up to 50 agents. When approving a link, the owner chooses a Router allowance in USD. The approval accepts $0–$1,000 and defaults to $1 when the agent has not suggested an amount.

The allowance is stored with the approval and applies separately to the agent's Compute key and prepaid-balance key.

## Understand the two sources

| Agent key | Constraints                                                                         |
| --------- | ----------------------------------------------------------------------------------- |
| Compute   | The agent key's approved allowance and the owner's daily Compute limit both apply.  |
| Balance   | The key's own approved allowance and the owner's shared prepaid balance both apply. |

Both keys use a 24-hour budget duration. Each has its own reset window and spend counter; they do not share a single daily cap. The owner's Compute epoch starts at 00:00 UTC.

CLI chat, local MCP `router.chat`, and SDK `client.router.chat()` try Compute first, then a stored balance key when Router reports budget exhaustion. Rate limits return retry guidance without spending balance or triggering a top-up. Direct OpenAI-compatible clients use the supplied key's source and must switch keys themselves.

![How an agent's Router request is paid. Two daily budgets feed usable Compute: what is left of the owner's stake-based Compute today, and what is left of the agent's daily allowance, the USD amount the owner set when approving the link. Usable Compute is the smaller remaining amount. The owner's epoch starts at 00:00 UTC; each agent key has its own 24-hour reset window. Each key spends its selected source; a direct OpenAI-compatible client must switch keys to change sources. A balance key draws on shared Router balance and has its own daily cap equal to the approved agent allowance. Purchased balance never expires. An agent wallet can top up Router balance over x402 in tiers of $1, $5, $20 or $50. Router serves the model call through one OpenAI-compatible endpoint, and agent keys can only make model calls.](vapi-router-budgets-light.svg)
![How an agent's Router request is paid. Two daily budgets feed usable Compute: what is left of the owner's stake-based Compute today, and what is left of the agent's daily allowance, the USD amount the owner set when approving the link. Usable Compute is the smaller remaining amount. The owner's epoch starts at 00:00 UTC; each agent key has its own 24-hour reset window. Each key spends its selected source; a direct OpenAI-compatible client must switch keys to change sources. A balance key draws on shared Router balance and has its own daily cap equal to the approved agent allowance. Purchased balance never expires. An agent wallet can top up Router balance over x402 in tiers of $1, $5, $20 or $50. Router serves the model call through one OpenAI-compatible endpoint, and agent keys can only make model calls.](vapi-router-budgets-dark.svg)

_Compute and balance keys have separate approved caps. Orange marks where USDC moves._

## From the CLI

| Command                                    | Use                                                                                                   |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| `vapi router models`                       | List model ids.                                                                                       |
| `vapi router usage`                        | Read agent Compute, owner Compute, and prepaid balance totals.                                        |
| `vapi router chat --model <id> "<prompt>"` | Send one chat; accepts `--system <text>` and `--max-tokens <n>`. Use `-` as the prompt to read stdin. |

All three accept `--account <name>` and `--json`. For purchases and refill settings, see [Buy Router balance](/router/buy-router-balance/); for key access, see [Access and keys](/router/access-and-keys/).

## From local MCP

Configure your AI app to run `vapi mcp --account researcher` over stdio. `auth.link` starts browser approval and returns a code, approval URL, and expiry; `auth.status` reports the link, owner, scopes, and whether a Router key is stored. The hosted `/mcp` endpoint does not expose these Router tools. See [AI app setup](/agents/in-your-ai-app/use-vapi-in-claude-cursor-and-codex/).

| Tool            | Input                                                                | Structured result                                                                                        |
| --------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `router.models` | `{}`                                                                 | `{ models: string[] }` containing model ids.                                                             |
| `router.usage`  | Optional `wallet` name.                                              | `compute`, nullable `balance`, and `stake: { owner, stake, computeTodayUsd }`.                           |
| `router.chat`   | Required `model` and `messages`; optional `max_tokens` and `wallet`. | `{ content: string \| null, model, usage? }`; usage contains prompt, completion, and total token counts. |
| `router.buy`    | Required `usd`: `1`, `5`, `20`, or `50`; optional `wallet`.          | `{ receipt: { id, amountUsd, network, transaction? }, balance }`; balance can be null.                   |

`compute` contains `allowanceUsd`, `spentTodayUsd`, `remainingTodayUsd`, `resetsAt`, `ownerLimitUsd`, and `ownerSpentUsd`. A non-null `balance` contains `purchasedUsd`, `spentUsd`, and `remainingUsd`. `stake.stake` is a token amount string in base units.

Chat accepts 1–50 text messages with `system`, `user`, or `assistant` roles and string `content`. `max_tokens` is an integer from 1 to 4,096. Its optional `usage` contains `prompt_tokens`, `completion_tokens`, and `total_tokens`. Tool calls are not accepted. `router.buy` pays from the selected local wallet within its spend caps. These tools never return Router keys; keys stay in the OS secret store.

## From the SDK

Install `npm i vapi-network`, link the local account with `vapi login`, then use the bundled JS/TS helper:

```typescript
import { createVapiClient } from "vapi-network";

const client = await createVapiClient({ account: "researcher" });
const reply = await client.router.chat({
  model: "venice/deepseek-v4-flash",
  messages: [{ role: "user", content: "Hello from my agent" }],
});
console.log(reply.content);
```

Choose a text model id with `client.router.models()`. The helper also exposes `client.router.usage()` and `client.router.buy(5)`. Chat returns `content`, `model`, `toolCalls`, optional token `usage`, and `keyUsed` (`stake` for Compute or `balance`).

`await client.router.openai()` returns `{ baseURL, apiKey }` for an OpenAI-compatible framework, using the Compute credential. This credential helper does not add balance fallback to that framework. Keep its key in your code, outside model prompts. See the [SDK reference](/reference/sdk/sdk/).

## Agent HTTP routes

Use an agent OAuth bearer with the `router.use` scope at the console API origin, `https://api.vapinetwork.ai`:

| Method | Endpoint                              | Required scope | Funding data or key                                          |
| ------ | ------------------------------------- | -------------- | ------------------------------------------------------------ |
| `GET`  | `/api/agents/self/router`             | `router.use`   | Both: agent Compute usage, owner Compute, and owner balance. |
| `POST` | `/api/agents/self/router-key`         | `router.use`   | Compute key; reuse it if it already exists.                  |
| `POST` | `/api/agents/self/router-balance-key` | `router.use`   | Balance key; reuse it if it already exists.                  |

These three routes register on the `router`, `network`, and `full` launch surfaces. The read-only `GET /api/agents/self/stake` route reports owner stake and Compute, requires an authenticated agent bearer without an additional scope check, and registers on `call`, `market`, `network`, and `full`.

Recovery returns the existing key without resetting spend or its budget window. An exhausted key stays exhausted until its existing reset. If recovery cannot safely return the key, the owner must revoke the link and approve a new one.

Use the returned Router key only at `https://router.vapinetwork.ai`, with the bearer header shown in [Call your first model](/router/api-quickstart/).

## Owner controls

An allowance edit updates the agent's key caps while preserving established reset windows. Revoking the link revokes its Router keys.

For client setup, see [Agents](/agents/). For the management API, see [Agents and Router](/reference/http-api/agents-and-router/).

## Next

- [Buy Router balance](/router/buy-router-balance/)
- [Usage and limits](/router/usage-and-limits/)
- [Access and keys](/router/access-and-keys/)

Checked on 2026-11-17.
