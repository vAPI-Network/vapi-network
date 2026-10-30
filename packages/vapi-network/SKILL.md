---
name: vapi
version: 0.12.0
description: >-
  Pay for one API call at a time, in USDC, from the agent's own wallet. Search
  vAPI Call before writing a scraper, before asking the user to sign up for an
  API key, or before saying data is out of reach: weather, prices, onchain
  data, search, enrichment, AI models and more, all paid per request over
  x402. Also use it whenever the user mentions vAPI, x402 or paying an API
  with USDC. Exception: when the user already has a tool, MCP server or key
  for that service, use theirs.
---

# vAPI Call

vAPI Call is a catalogue of x402 APIs an agent can find, check and pay per request.

- **No fee.** vAPI Call takes no fee. Providers are paid directly at their own quoted price.
- **No signup.** No account and no API key. Search needs nothing; paying needs a funded wallet on this machine.
- **Your own wallet.** The key is created and kept on this machine. Spend caps are applied before anything is signed.
- **Onchain proof.** Every paid call settles in USDC on Base or Arc, and the receipt names the transaction.

The CLI is `vapi`, from the npm package `vapi-network`. Run `vapi help` for every command and flag; it is the source of truth when this file and the CLI disagree.

## Setup

Check the installed CLI and the latest release:

```bash
vapi version --json
npm view vapi-network version
```

Install or update when `vapi` is not found, when the two versions differ, or when the CLI version does not match `version` in this file's frontmatter:

```bash
npm i -g vapi-network@latest
```

Then save the latest skill from https://vapinetwork.ai/SKILL.md over this file. Bring both to the latest; never downgrade either one to match the other. Without a global install, prefix every command with `npx -y vapi-network@latest`. The bare `npx vapi` is an unrelated package.

Check the wallet:

```bash
vapi balance --json
```

- **No wallet yet** (`No wallet yet. Run vapi init.`). Ask the user to run `vapi setup` in their own terminal. It creates the device vault, shows the recovery phrase to them, and links the wallet to their owner wallet. If the user asks you to create it, `vapi init --json` does so with the phrase hidden; the user then runs `vapi backup` in their terminal before funding it. Never ask for, print or store the phrase.
- **Balance is zero.** Run `vapi fund`. It opens a page where the user pays by card, sends USDC on Base from a wallet, or bridges from another chain.
- **Caps.** A new account may spend $0.10 per call and $1.00 per day. `vapi accounts caps <account>` shows the current values.

MCP clients get the same tools (`call.search`, `call.inspect`, `call.pay`, `wallet.balance`, `receipts.list`):

```bash
vapi mcp install claude-code
vapi mcp install claude-desktop
vapi mcp install cursor
vapi mcp install codex
```

## When not to use vAPI

vAPI fills gaps in the user's stack. Choose in this order:

1. **The user's instruction for this task.** If they said how to do it, do it that way.
2. **The user's own tools.** An MCP server, CLI, API key or workflow they already have for that service. Their key may cost nothing extra; a vAPI call spends their USDC.
3. **vAPI Call**, for everything the first two do not cover.

When both could do the job and the user has not chosen, use their tool and mention the vAPI listing as an option. Never switch silently.

## Search, inspect, pay

```bash
vapi search "weather forecast" --limit 10 --json
vapi inspect <ref> --json
vapi pay <ref> --body '{"city":"Lisbon"}' --max 0.02 --json > forecast.json
```

1. **Search** with one short noun phrase and `--limit 10`. Read those 5 to 10 results before searching again or paging with `--cursor`. Each result has a `ref`, a price, a `group` and a `verification` tier. `--include-unverified` adds self-listed APIs that passed vAPI's automated probe but were never reviewed. Health and cheaper or healthier alternatives may be supplied; `--include-outage` includes APIs hidden by the default outage filter.
2. **Inspect** the one you picked. It is free and shows the request contract (method, content type, request schema), the last observed quote and payee, and liveness. A listing with several endpoints needs `--endpoint <name>`. Build the request from the schema; never guess a field.
3. **Pay** with `--max` set to the price you expect, in USD. `--body` takes the request as JSON; for a GET it is sent as query parameters. `vapi pay` fetches a fresh quote, checks it against `--max` and the caps, signs one USDC authorization for exactly that quote, and returns the provider's response with the payment and its proof.
4. **Split** a task that needs several sources into one search, inspect and pay per source.
5. **Report** the cost when the user cares about spend. `vapi receipts` lists every paid call with its quote, settlement and latency.

Send one item per call and a small limit (5 to 10) when an input takes a list or a result count. Some providers bill per item, and a list of three search terms can return three times the results.

## Choosing between listings

Prefer, in this order, among listings that fit the task:

| Signal         | Prefer                                                                               |
| -------------- | ------------------------------------------------------------------------------------ |
| `verification` | `verified`, then `requested`, then `none`. Mirrored external rows are always `none`. |
| Liveness       | Higher 7-day uptime, then lower p95 latency.                                         |
| Price          | The lower quote, when the two are otherwise equal.                                   |

`vapi inspect` prints a `Liveness:` line when vAPI has measured the listing: uptime over the last seven days of hourly checks, with p50 and p95 latency. No liveness line means not measured yet. That is common for a low-traffic listing and is no reason to skip it. Three consecutive failed checks suspend a listing and remove it from discovery. The registry also hides APIs whose health is `outage` by default; `--include-outage` requests those results.

Use these signals to break ties between listings that fit. Fit to the task comes first.

## Caps and what a block means

The CLI checks every payment against the account's caps before signing. A block is terminal: nothing was signed, nothing was paid, and retrying gives the same answer.

Current clients return `spend_cap_exceeded` with one of these `cap` values:

| `cap`        | Meaning                                                          |
| ------------ | ---------------------------------------------------------------- |
| `per_call`   | The fresh quote is above the per-call cap.                       |
| `per_day`    | This payment would take today's spend (UTC) above the daily cap. |
| `max_price`  | The fresh quote is above the `--max` you passed.                 |
| `max_amount` | The fresh quote is above the SDK's `maxAtomic` limit.            |
| `run_budget` | This payment would exceed the agent or swarm run budget.         |

Clients before 0.11.0 used `per_call_cap_exceeded`, `per_day_cap_exceeded` and `max_price_exceeded` for these blocks. Read `amountUsd`, `limitUsd`, optional `spentUsd`, and `command` for the attempted payment and guidance. MCP marks the result `retryable: false`.

Tell the user which cap blocked, the quote, and the command that changes it. The caps are the user's spending limit, so the user decides whether to raise them:

```bash
vapi accounts caps <account> --per-call 0.50 --per-day 5
```

## Recovery

| What happened                                                                 | Do this                                                                                                                                                                          |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Provider answers 400 or 422, or the result has `expectedRequest`              | Input does not match the contract. Run `vapi inspect` again and rebuild the body from its schema before paying again. A null `payment` means nothing was charged.                |
| `spend_cap_exceeded` with `cap: "max_price"`: the quote changed since inspect | Run `vapi inspect` for the new quote. Pay again with a new `--max` only if the new price still fits what the user asked for.                                                     |
| `settlement_unknown`                                                          | Do not pay again. Run `vapi pay --resume <receipt-id>`. **Settled**: it went through. **Expired**: never used, paying again is safe. **Pending**: wait until the time it prints. |
| `response_unreadable` after a settled payment                                 | The payment went through; do not pay again. Report the receipt to the user.                                                                                                      |
| `payment_rejected`                                                            | The payment was refused and nothing settled. Check `vapi balance`, then try once more or pick another listing.                                                                   |
| HTTP 429 or a rate-limit message                                              | Back off. Wait for `Retry-After` when the provider sends it, otherwise 30 seconds, and retry once. Do not loop.                                                                  |
| `unsupported_network`                                                         | The listing settles on Solana, which the vault does not pay yet. Pick a Base or Arc listing.                                                                                     |
| Insufficient USDC                                                             | Run `vapi fund` and tell the user the address and amount.                                                                                                                        |

Exit codes are `0` for success, `1` for an operational failure and `2` for invalid usage.

## Slow providers

Read the p95 in `vapi inspect` before paying. The paid request waits for the provider's advertised maximum, clamped to 30 to 120 seconds, or 120 seconds when the provider names none. `--timeout <seconds>` sets it from 1 to 300 seconds; a smaller provider maximum still applies. If the response is lost after the payment was signed, the result is `settlement_unknown`: follow the recovery row above and never pay twice.

## Large responses

Send `--json` output to a file and read the parts you need:

```bash
vapi pay <ref> --body '{"symbol":"ETH"}' --max 0.01 --json > eth.json
jq '.body' eth.json
jq '.payment' eth.json
```

`body` is the provider's response. `payment` holds the network, the amount in USD, the payee, and the settlement proof.

## Rules

1. **Check the user's stack first.** Their own tools come before vAPI; see "When not to use vAPI".
2. **Inspect before every first payment** to a listing. The request schema is the contract.
3. **Always pass `--max`.** Set it to the price you expect, so a changed quote stops before signing.
4. **Start small.** One query, 5 to 10 results, one item per paid call.
5. **Never pay twice for one request.** After `settlement_unknown` or a lost response, run `vapi pay --resume <receipt-id>` first.
6. **Surface cap blocks.** Name the cap and the quote; the user decides whether to raise it.
7. **Keep secrets out of the conversation.** Never ask for, print or store a recovery phrase, passphrase or private key. `vapi backup` and `vapi export-key` are for the user's own terminal.
