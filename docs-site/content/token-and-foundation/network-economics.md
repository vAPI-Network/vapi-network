---
title: "Network economics"
description: "How fees, staking, reviewers, and governance are designed to connect."
order: 118
---

**The core idea: the people who secure the network are the people who benefit from its growth.**

vAPI can offer non-custodial escrow and onchain trust precisely because the network is not designed to depend on a company's goodwill. It is designed to depend on stakers whose position gains value only when the network is honest, used, and trusted. That alignment is the product.

## How the pieces are designed to connect

1. **Fees come from real usage.** The network charges a fee on settled platform transactions (see [Fees and payouts](/call/sell-on-call/fees-and-payouts/)) and a trading fee on the token pool during the bootstrap phase.
2. **Fees flow to three places.** The reward pool for stakers; network operations (development, security, legal, marketing); and buyback-and-burn, which permanently reduces token supply.
3. **Staking is the entry ticket to the network's paid roles.** Stakers are designed to become eligible as dispute reviewers in vAPI Tasks. Reviewer eligibility already passes through a stake-gate hook onchain; the deployed gate is an allowlist until reviewer eligibility ships.
4. **Reviewers are paid from the dispute itself.** Each party to a dispute deposits a separate dispute fee, outside the escrow amount. The reviewers who vote share the losing deposit. Reviewing is paid work, funded by the case, not by emissions.
5. **Staking rewards are usage-funded, not printed.** The reward pool is designed to buy real resources in bulk (compute and other network services) and allocate them to stakers as usage credits with daily rate limits. As platform volume grows, fee income grows, and with it the rate limits for stakers. Rewards scale with real network activity, not with emissions.
6. **Governance follows stake.** Voting power on network decisions is designed to follow staked positions, within limits fixed in the contracts that no vote can override. The pattern already exists onchain: the escrow fee router's rate is immutable at deployment.
7. **The loop closes at trust.** Reviewers with stake decide disputes, honest verdicts protect the network's reputation, reputation grows volume, volume grows fees, and fees reward the stakers who keep it honest. Dishonesty is designed to be economically irrational: it damages exactly the position the staker holds.

**What this means per participant, by design:** buyers get escrow and recourse without trusting a company; vendors get paid on delivery and build reputation that cannot be bought; stakers get access to the network's paid roles and usage-funded rewards; and the token records the value of keeping all of that honest.

> [!WARNING]
> Status: the `BuybackBurner` contract is deployed on Base and launched without an external audit. Staking and Compute are live on Base. Reviewer rewards and governance are in development and require a third-party audit before going live. Deployed contract addresses, with Basescan links, are in the [contract reference](/reference/x402/contracts/). This page serves as design documentation, not an offer. See [Roadmap & status](/products/roadmap-status/).
