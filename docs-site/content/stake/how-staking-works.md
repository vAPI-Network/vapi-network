---
title: "How staking works"
description: "Active stake, timestamp checkpoints, withdrawal cancellation, and the 24-hour cooldown."
order: 1
---

Email and Google can open your account. Staking transactions require the matching external wallet and network fees. The embedded connector cannot perform Stake, unstake or withdrawal actions; see [Stake and unstake](/stake/stake-and-unstake/).

Staking transfers vAPI into `VapiStaking` on Base. The contract records active stake for each wallet and timestamp checkpoints for daily Compute calculations.

## Stake

Approve the amount to the staking contract, then call `stake(uint256 amount)`. The console handles approval and staking as separate wallet transactions when approval is needed.

The amount must be positive, and the resulting active stake must be at least 1 vAPI. You can add stake while a withdrawal is pending.

## Request a withdrawal

`requestUnstake(uint256 amount)` moves the requested amount out of active stake immediately. The tokens remain in the contract until withdrawn or restored to active stake by cancellation.

| Rule                                   | Value                        |
| -------------------------------------- | ---------------------------- |
| Pending withdrawals per wallet         | 1                            |
| Cooldown                               | 86,400 seconds, or 24 hours  |
| Remaining active stake after a request | Zero or at least 1 vAPI      |
| Withdrawal destination                 | The wallet that requested it |

The amount must be positive and no greater than your active stake. Another request is allowed after the pending request is cancelled or withdrawn.

## Cancel a pending withdrawal

`cancelUnstake()` restores the full pending amount to active stake and clears the request. No tokens leave the contract. You can cancel during the cooldown or after it ends, as long as the tokens have not been withdrawn.

Restored stake counts at the next applicable Compute snapshot. Cancellation does not recalculate today's limit. A later withdrawal request starts a new 24-hour cooldown.

## Withdraw

Once the request's `availableAt` timestamp is reached, `withdraw()` clears the request and transfers its full amount to the requesting wallet. It fails before that timestamp. There is no expiry window after the cooldown.

![The life of staked vAPI. Your wallet calls stake(amount) after approving the exact amount, and the tokens become active stake, which counts at each 00:00 UTC Compute snapshot; you can add more at any time. requestUnstake(amount) moves the amount out of active stake at once into a pending unstake that stays in the contract, with one pending unstake per wallet. cancelUnstake() restores the full pending amount to active stake at any time before withdrawal. 24 hours later, at availableAt, the amount becomes withdrawable with no expiry window, and withdraw() sends it to the same wallet only; withdraw() fails before availableAt. On the timeline, hour 0 is the requestUnstake, the cooldown is 86,400 seconds, and hour 24 is availableAt.](vapi-stake-unstake-light.svg)
![The life of staked vAPI. Your wallet calls stake(amount) after approving the exact amount, and the tokens become active stake, which counts at each 00:00 UTC Compute snapshot; you can add more at any time. requestUnstake(amount) moves the amount out of active stake at once into a pending unstake that stays in the contract, with one pending unstake per wallet. cancelUnstake() restores the full pending amount to active stake at any time before withdrawal. 24 hours later, at availableAt, the amount becomes withdrawable with no expiry window, and withdraw() sends it to the same wallet only; withdraw() fails before availableAt. On the timeline, hour 0 is the requestUnstake, the cooldown is 86,400 seconds, and hour 24 is availableAt.](vapi-stake-unstake-dark.svg)

_Unstake requests remove tokens from active stake immediately. Those tokens stop counting at the next 00:00 UTC Compute snapshot. Today's distribution stays unaffected. You can withdraw the tokens 24 hours after the request._

## Historical stake and contract controls

The daily Compute calculation uses `stakedBalanceAt` and `totalStakedAt` at 00:00:00 UTC. A withdrawal request or cancellation changes future snapshots rather than recalculating today's distribution.

Tokens sent directly to the contract do not count as active stake; use the stake flow.

`VapiStaking` is ownerless and not upgradeable. It has no pause, slashing, or administrative principal-rescue function. The Safe listed in [Staking contracts](/stake/contracts/) owns the reviewer gate, not the staking contract. Token governance controls are not active.

Follow [Stake and unstake](/stake/stake-and-unstake/) for console steps.

Checked on 2026-11-17.
