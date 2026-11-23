---
title: "Access and keys"
description: "Create and revoke wallet-bound Router keys, and choose Compute, Router balance, or an owner hybrid key."
order: 7
---

Key creation requires a ready account with a confirmed vAPI ID. Complete [account setup](/account-and-sign-in/) if access is blocked. Wallet, email and Google sign-in can open the account. Own-wallet creation and revocation can require wallet proof; embedded owners pass that guard.

A Router key is a bearer token bound to a wallet. Send it in the `Authorization: Bearer <key>` header to `https://router.vapinetwork.ai`.

## Create an owner key

1. Sign in to your account at [Router](https://api.vapinetwork.ai/router).
2. Open [API keys](https://api.vapinetwork.ai/router/keys).
3. Enter a label, choose a source, and select Create Router key.
4. Copy the secret. It is shown once.

| Source    | What it spends                                                             |
| --------- | -------------------------------------------------------------------------- |
| `compute` | The wallet's daily Compute limit from staking.                             |
| `balance` | The owner's prepaid Router balance.                                        |
| `hybrid`  | Compute first, then Router balance; shown as Compute, then Router balance. |

Single-source keys spend only their selected source. Direct clients switch those keys themselves.

A hybrid key spends Compute first, then Router balance, with the same secret throughout. The switch is not instant: for up to about two minutes after Compute runs out, requests can get HTTP 429 `budget_exceeded`. Retry after a short wait. The last request admitted before the switch can spend slightly more than the Compute left.

The key list labels hybrid as Compute → Router balance. When known, Paying now: Compute or Paying now: Router balance identifies its current source. Hybrid keys have no key-level spending budget. If neither source has room, the key remains attached to its current source.

The default funding choice is Compute. After Done, only the preview remains. Revoke and replace the key if you lose its secret.

## Key limits

| Limit                                                  |           Value |
| ------------------------------------------------------ | --------------: |
| Active owner keys per wallet, across all three choices |              10 |
| Label length                                           | 1–80 characters |
| Requests per minute per key                            |             200 |
| Tokens per minute per key                              |       1,000,000 |
| Concurrent requests per key                            |              20 |

Router applies the request and concurrency defaults above when creating a new key. Keys created before 2026-11-02 keep 60 requests per minute, 100,000 tokens per minute and 10 concurrent requests until replaced with new keys.

Select Revoke on the API keys page to stop a key. Revocation cannot be undone.

## Linked agents

Agent Router keys allow model calls. The owner's approved allowance caps the agent's Compute key and balance key separately. A Compute call is also bounded by the owner's daily Compute limit; a balance call spends the owner's shared prepaid balance.

Agent key recovery preserves the existing key, spend, and reset window. If recovery is unavailable, the owner must revoke the link and approve a new one. See [Use Router from your agents](/router/use-router-from-your-agents/).

## From the CLI

Use `vapi whoami --account <name>` to inspect the owner link. These Router commands also accept `--account <name>`:

| Command                    | Behavior                                                                                       |
| -------------------------- | ---------------------------------------------------------------------------------------------- |
| `vapi router key`          | Print the Compute key through the CLI's human-only secret-export gate. JSON output is refused. |
| `vapi router key --rotate` | Request and store the Compute key without printing it.                                         |

Despite the flag name, `--rotate` calls the recovery endpoint: an existing server key is reused, with its spend and budget window preserved. It does not create a fresh allowance or replace a live key. A successful balance purchase fetches and stores the balance key automatically.

## Next

- [Call your first model](/router/api-quickstart/)
- [Usage and limits](/router/usage-and-limits/)

Checked on 2026-11-17.
