---
title: "Pool"
description: "View the Compute pool, today's allocation and a simulation of your total stake."
order: 4
---

The [Pool page](https://api.vapinetwork.ai/stake/pool) shows the funds available for daily Compute.
Your stake sets your share.
You can simulate a stake without connecting a wallet or signing in.

## Read the pool

Compute pool shows the dollars remaining after measured Compute spend.
Daily Compute divides that remaining pool by its configured runway.
The illustration highlights Simulated share, Your share today or Projected share according to the available data.

| Display                  | Meaning                                                                                                                            |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| Your Compute today       | Current snapshot allocation, with 30-day and 365-day equivalents at today's rate. This is allocation, rather than remaining spend. |
| Total staked             | Active contract stake, including protocol wallets.                                                                                 |
| Stakers                  | Wallets with active stake.                                                                                                         |
| Runway                   | Configured runway, shown for funded pools.                                                                                         |
| Most one wallet can take | Configured share of a day's pool, shown for funded pools when a restrictive per-wallet cap applies.                                |

Your Compute today requires sign-in, a connected address, a configured staking contract and an available personal position.
It polls the current allocation every 60 seconds.
Estimates change with pool funds and stake; unused daily Compute does not roll over.

| Allocation state           | Display                                                                  |
| -------------------------- | ------------------------------------------------------------------------ |
| Signed out or disconnected | Connect your wallet and sign in to see your Compute today.               |
| Loading                    | Reading today's snapshot allocation.                                     |
| Unavailable                | Today's Compute is unavailable. You can still estimate your usage below. |

## Simulate your Compute

Enter your proposed total vAPI stake in Total stake to simulate.
The hint reads Your total active stake at the next snapshot.
Unlike [Stake's calculator](/stake/compute-entitlement/#view-and-use-compute), this input is a total, rather than an additional amount.

The simulation starts with active network stake excluding protocol wallets.
When authenticated, it subtracts your known current stake before adding the proposed total.
It applies the configured cap and allocation floor.

| Output                 | Meaning                                                  |
| ---------------------- | -------------------------------------------------------- |
| Daily                  | Projected daily Router usage in USD.                     |
| Monthly (30 days)      | Daily estimate multiplied by 30 at today's rate.         |
| Yearly (365 days)      | Daily estimate multiplied by 365 at today's rate.        |
| Share of counted stake | Proposed stake as a percentage of counted network stake. |

Empty input uses an authenticated wallet's current stake and projection when available.
Otherwise it asks for a total stake to project daily, monthly and yearly Router usage.
Input must be numeric, nonnegative and within the token's decimal precision; no explicit maximum applies.
Simulation is unavailable when the pool is unfunded or current network stake totals cannot be read.

How staking works explains Stake the vAPI token, Daily limit and Use any OpenAI SDK.
The collapsed Rules section covers snapshot timing, no rollover, withdrawal requests, cooldown, reviewer threshold and agents.
See [Stake and unstake](/stake/stake-and-unstake/) for transaction steps.
