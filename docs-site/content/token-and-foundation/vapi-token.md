---
title: "The vAPI token"
description: "Supply, allocation, and trading fee for the vAPI token."
order: 116
---

The vAPI token is the network token of vAPI Network on Base. Supply was fixed at deployment at 100,000,000; the contract has no mint function, no owner, and no admin keys. Supply can only decrease through burns.

![Screenshot: The vAPI token](vapi-token-banner.jpg)

| Fact                 | Value                           |
| -------------------- | ------------------------------- |
| Ticker               | $vAPI                           |
| Network              | Base                            |
| Total supply         | 100,000,000, fixed              |
| Supply changes       | Can only decrease through burns |
| Owner and admin keys | None                            |

## Official Token Contracts

| Chain | Token Contract                                                                                                      | Pool                                                               |
| ----- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Base  | [0x1eA8deB921AA6015f4938010C848140b98108Dd2](https://basescan.org/token/0x1eA8deB921AA6015f4938010C848140b98108Dd2) | 0x05da2eb0bd58cb74ce0a0c4c93200a2e96778075fbe611b46967a334986c5671 |

## Allocation

TGE = token generation event.

![Bar chart of the fixed 100,000,000 vAPI supply with release terms. Liquidity pool 80%, seeded at launch into the Uniswap V4 pool. Ecosystem and listing 7%, 20% at TGE, then 6 months linear. Founding team 6%, 3-month cliff, then 9 months linear. Strategic sale 5%, 40% at TGE, 14-day cliff, the rest over 4 months. Airdrop 2%, 20% at TGE, then 6 months linear.](vapi-token-allocation-light.svg)
![Bar chart of the fixed 100,000,000 vAPI supply with release terms. Liquidity pool 80%, seeded at launch into the Uniswap V4 pool. Ecosystem and listing 7%, 20% at TGE, then 6 months linear. Founding team 6%, 3-month cliff, then 9 months linear. Strategic sale 5%, 40% at TGE, 14-day cliff, the rest over 4 months. Airdrop 2%, 20% at TGE, then 6 months linear.](vapi-token-allocation-dark.svg)

_Allocation and release of the fixed 100,000,000 supply._

| Allocation          | Share | Terms                                                      |
| ------------------- | ----- | ---------------------------------------------------------- |
| Liquidity pool      | 80%   | Seeded at launch into the Uniswap V4 pool                  |
| Ecosystem & listing | 7%    | 20% at TGE, 6-month linear release                         |
| Founding team       | 6%    | 3-month cliff, then 9-month linear                         |
| Strategic sale      | 5%    | 40% at TGE, 14-day cliff, 60% linear released over 4-month |
| Airdrop             | 2%    | 20% at TGE, 6-month linear                                 |

> [!NOTE]
> _The strategic sale was priced across two tranches at a weighted average valuation of $2M FDV._

## Trading fee

The token's trading pool carries a 3% fee on buys and sells, taken in vAPI and routed to the network treasury. It exists to bootstrap the network before platform fees carry it, primarily funding the reward pool, development, security, legal, and marketing.

> [!NOTE]
> Staking is live and gives a daily Router usage limit. Reviewer rewards and governance are in development. [Network economics](/token-and-foundation/network-economics/) describes the designed mechanics of the network so holders understand what the token is for. The final mechanics become public after a successful audit by a third-party security firm. See [Roadmap & status](/products/roadmap-status/).

The Genesis Goose Eggs NFT campaign is a separate collection on Base. See [NFT campaign: vAPI Genesis Goose Eggs](/token-and-foundation/genesis-eggs/).
