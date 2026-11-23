---
title: "Compute entitlement"
description: "How the treasury-funded Compute pool shrinks with use and becomes a daily Router usage limit from your active stake."
order: 2
---

Compute is your daily Router usage limit, expressed in USD at model list price. It comes from active stake and is separate from purchased Router balance.

## Daily pool

The treasury funds the Compute pool.
Remaining funds equal total funding minus measured Compute spend, with a minimum of zero.
The daily pool divides remaining funds by the configured runway and rounds down in micro-USD.
One USD equals 1,000,000 micro-USD.

Only measured Compute use reduces the remaining pool.
Funding, runway, cap, allocation floor and protocol-wallet exclusions come from deployment settings and snapshot data where available.
Their values can change.

## Your share

The distribution uses active stake at 00:00:00 UTC. Configured protocol wallets receive zero and are excluded from total eligible stake.

Your initial limit is the daily pool multiplied by your share of eligible snapshot stake.

| Step             | Rule                                                                                                                  |
| ---------------- | --------------------------------------------------------------------------------------------------------------------- |
| Pro-rata share   | Calculate in integer micro-USD, rounding down.                                                                        |
| Per-wallet cap   | Apply the configured maximum share of the daily pool, rounded down.                                                   |
| Allocation floor | If the capped amount is below the configured floor, set it to zero.                                                   |
| Exclusions       | Protocol wallets and wallets with no active stake receive zero. If total eligible stake is zero, all limits are zero. |

Amounts removed by the cap, floor, or rounding are not redistributed to other wallets.

![How a wallet's daily Compute is calculated. Step 1: the remaining pool (total funded minus Compute already used) divided by the configured runway in days gives the daily pool, the Compute shared out today. Step 2: your active stake at the 00:00 UTC snapshot, divided by the total stake of every staker except protocol wallets, times the daily pool, gives your initial share. Step 3: if a restrictive per-wallet cap is configured, the initial share is capped at it, and if it falls below the configured floor it becomes zero. The result is your daily Compute, spent through a Compute key; your agents' Compute calls are also bounded by their own key allowances. Daily cycle in UTC: the snapshot of active stake at 00:00, the earliest distribution at 00:10, and at the next 00:00 unused Compute does not roll over. If the two RPC providers disagree, nothing is written and yesterday's limits stay.](vapi-compute-entitlement-light.svg)
![How a wallet's daily Compute is calculated. Step 1: the remaining pool (total funded minus Compute already used) divided by the configured runway in days gives the daily pool, the Compute shared out today. Step 2: your active stake at the 00:00 UTC snapshot, divided by the total stake of every staker except protocol wallets, times the daily pool, gives your initial share. Step 3: if a restrictive per-wallet cap is configured, the initial share is capped at it, and if it falls below the configured floor it becomes zero. The result is your daily Compute, spent through a Compute key; your agents' Compute calls are also bounded by their own key allowances. Daily cycle in UTC: the snapshot of active stake at 00:00, the earliest distribution at 00:10, and at the next 00:00 unused Compute does not roll over. If the two RPC providers disagree, nothing is written and yesterday's limits stay.](vapi-compute-entitlement-dark.svg)

_Stake at 00:00 UTC determines the share; the job runs at 00:10 UTC and applies any cap and the floor. The daily pool comes from the remaining pool._

## Snapshot and timing

| Event                                                               | UTC time   |
| ------------------------------------------------------------------- | ---------- |
| Epoch starts; historical stake is read as at this instant           | 00:00:00   |
| Snapshot job runs and distributes the limit                         | 00:10      |
| Epoch ends; unused Compute does not roll over and stays in the pool | Next 00:00 |

A stake made during a day first counts at the next 00:00 UTC snapshot. For example, stake confirmed on 19 October first counts for the 20 October epoch, with the job at 00:10 UTC. Stake confirmed after 00:00 but before 00:10 does not enter that day's snapshot.

Withdrawal requests remove active stake immediately. Cancellations restore it immediately. Both affect the next applicable snapshot; neither recalculates today's limit.

The job checks historical stake against two independent RPC providers. If their reads disagree, it writes no new snapshot and the previous limits remain until a successful run.

## View and use Compute

Open the [Stake page](https://api.vapinetwork.ai/stake) in the account holding your stake, using wallet, email or Google sign-in.
With account sign-in methods enabled, a ready session reads the signed-in account wallet without a browser-wallet connection. Stake, Unstake, Withdraw and Cancel can prompt for the matching wallet before review. Resumption requires the same session, account and action context. Transactions require a connected matching external wallet and gas; embedded connector actions are unavailable because they require network fees.
Open the initially closed What if I stake more? section to use the calculator.
What if I stake accepts additional stake and adds it to your current stake and the network total.
Projected for tomorrow estimates the next snapshot; [Router](https://api.vapinetwork.ai/router) shows today's distributed limit and usage.

| Calculator detail | Behavior                                                                                                                           |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Input             | Nonnegative decimal vAPI amount; commas are stripped and precision cannot exceed token decimals. No explicit maximum applies.      |
| Invalid input     | Counts as zero additional stake.                                                                                                   |
| Calculation       | Uses the proposed wallet stake and active network total, excluding protocol wallets, with the configured cap and allocation floor. |
| Output            | Projected daily Router usage in USD, rounded down to cents, with the stake share and daily-pool explanation.                       |
| Links             | Create a Router key and Quickstart.                                                                                                |

The browser rounds the cap fraction to basis points; server distribution uses the configured decimal fraction exactly.
Treat the calculator as a projection.
The Compute switch controls indexing and distribution; it does not hide Stake or Pool.

[Pool](/stake/pool/) shows Your Compute today from the current snapshot, with 30-day and 365-day equivalents at today's rate.
This is allocation, rather than remaining spend.
Its Simulate your Compute input takes a proposed total stake and works signed out with public network totals.
When authenticated, it replaces your known current stake in the counted total before adding the proposed amount.

Create a Compute key on Router to use your daily limit.
A Router balance key spends purchased balance instead.
An owner hybrid key uses Compute first, then Router balance with the same secret. Switching is asynchronous and requests can receive a 429 budget error until reassignment. See [Access and keys](/router/access-and-keys/).
See [Call your first model](/router/api-quickstart/).

## Linked agents

Link a local account with `vapi login --account <name>` and approve the printed URL in the ready owner account, using wallet, email or Google sign-in. Own-wallet proof may be requested. The approval sets the agent's Router allowance in USD.

An agent's Compute call uses both its key allowance and your daily Compute limit. Its usable Compute is the smaller remaining amount. An agent balance key uses your shared purchased balance and has a separate approved cap.

CLI chat, local MCP `router.chat`, and SDK `client.router.chat()` try Compute first, then a stored balance key on budget exhaustion. Local MCP `router.usage` reads usage and owner stake without staking transactions. These tools cannot stake or unstake for you.

## From the CLI

The CLI stake status and stake open commands are documented in the [CLI reference](/reference/cli/cli-reference/).

`status` reports the linked owner's stake from the daily Compute snapshot and today's Compute limit; it can report zero before distribution. It accepts `--json`. `open` prints the console staking URL; omit `--no-browser` to open it in an interactive human session. Staking and withdrawal transactions stay in the console.

See [Use Router from your agents](/router/use-router-from-your-agents/).

Checked on 2026-11-17.
