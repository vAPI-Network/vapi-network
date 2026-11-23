---
title: "Stake"
description: "Stake vAPI to receive a daily Router Compute limit."
order: 10
---

Your active vAPI stake sets your daily Router usage limit in USD at model list price.
The [Stake page](https://api.vapinetwork.ai/stake) shows your position and withdrawals.
[Pool](/stake/pool/) explains daily Compute and lets you simulate a stake without signing in.
[Burn](/stake/burn/) shows supply, burns and buyback transactions without a wallet.

## Stake in three steps

1. Open Stake and sign in to the account holding your vAPI. Connect its matching external wallet when prompted for transactions.
2. Select Stake, then enter Amount to stake in review. Review also offers Max. Approve if needed, then confirm staking.
3. Open the initially closed What if I stake more? section. Enter additional stake to see Projected for tomorrow.

The calculator adds your input to your active stake and the network total.
It applies the configured cap and allocation floor, excluding protocol wallets from counted stake.
Use See today's limit in Router for today's allocation.
Get vAPI opens Uniswap in a new tab for a Base swap from the native currency to the configured staking token.
This header action requires chain ID 8453, a readable position and no unavailable state.

## Read your position

Your stake shows the account wallet's active vAPI amount.
With account sign-in methods enabled, a ready session reads the signed-in account wallet without a browser-wallet connection. Stake, Unstake, Withdraw and Cancel can prompt for the matching wallet before review. Resumption requires the same session, account and action context. Transactions require a connected matching external wallet and gas; embedded connector actions are unavailable because they require network fees.
The Block separates Yours from Others and includes protocol wallets in its active total.
Pending withdrawals leave that total immediately; Compute excludes protocol wallets.
The header also shows Total staked and Stakers.

| Field, in display order | Meaning                                                                                                                 |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Next snapshot           | Countdown and UTC date; initially shows 00:00 UTC before the client clock initializes.                                  |
| Daily Compute           | Daily pool distributed and your projected share from the next snapshot.                                                 |
| Reviewer                | Eligibility and the configured vAPI threshold, the amount to qualify, or an unconfigured message. Tasks is coming soon. |
| Withdrawal              | None, unavailable, the pending amount with its cooldown, or the amount ready to withdraw.                               |

| Position state                        | Display and controls                                                                                                                     |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Signed out without a connected wallet | Connect your wallet to see your stake and projected daily Router limit. Connect wallet opens the connection flow; Withdrawal shows None. |
| Wallet position unavailable           | Your wallet position is not available yet. Personal actions are disabled; projected share is unknown and Withdrawal shows Not available. |
| No active stake                       | Zero amount and No active stake yet. Stake is available with a supported external connector; Unstake is disabled.                        |
| Active stake                          | Pool share and projected daily limit from the next snapshot. Stake and Unstake are available; a below-floor amount is identified.        |
| Withdrawal cooling down               | Pending amount and readiness countdown, or in cooldown before clock initialization. Cancel is available; another Unstake is disabled.    |
| Withdrawal ready                      | Pending amount marked ready. Withdraw {amount} vAPI and Cancel are available.                                                            |
| Staking unconfigured                  | Staking is not configured on this network yet. Your position is unavailable.                                                             |
| Chain read failed                     | Stake unavailable explains that tokens are unaffected. Retry reads the position again.                                                   |

Withdrawals take 24 hours after the request.
Cancel restores the pending amount to active stake; Withdraw {amount} vAPI opens withdrawal review when ready.
Follow [Stake and unstake](/stake/stake-and-unstake/) for the review operations.
Compute is a daily usage limit; unused Compute does not roll over or pay USDC or additional vAPI.

## Read next

Use these pages for the contract mechanism, Compute calculation and transaction steps.
Pool also shows Your Compute today with 30-day and 365-day equivalents at today's rate.
Those equivalents change with pool funds and stake.

- [How staking works](/stake/how-staking-works/)
- [Compute entitlement](/stake/compute-entitlement/)
- [Stake and unstake](/stake/stake-and-unstake/)
- [Pool](/stake/pool/)
- [Burn](/stake/burn/)
- [Reviewer eligibility](/stake/reviewer-eligibility/)
- [Staking contracts](/stake/contracts/)

Checked on 2026-11-17.
