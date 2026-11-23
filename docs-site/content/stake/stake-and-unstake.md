---
title: "Stake and unstake"
description: "Stake, request withdrawal, cancel a pending withdrawal, and withdraw after 24 hours in the console."
order: 3
---

Open the console [Stake page](https://api.vapinetwork.ai/stake) in your account.
With account sign-in methods enabled, a ready session reads the signed-in account wallet without a browser-wallet connection. Stake, Unstake, Withdraw and Cancel can prompt for the matching wallet before review. Resumption requires the same session, account and action context. Transactions require a connected matching external wallet and gas; embedded connector actions are unavailable because they require network fees.
Wallet, email and Google sign-in can open the account. With account methods disabled, reads and staking use the connected wallet; Compute follows the signed-in wallet.

## Stake vAPI

Select Stake first to open review.
Enter Amount to stake, or use Max in review.
Approve the amount if needed, then confirm the stake transaction in your wallet.

Your stake shows the active amount read from the chain.
The overview lists Next snapshot, Daily Compute, Reviewer and Withdrawal, in that order.
See [Stake](/stake/#read-your-position) for signed-out, empty, pending and unavailable states.

## Manage a withdrawal

Select Unstake to open review with Amount to withdraw.
The review operation is Request withdrawal.
Confirming the request removes that amount from active stake immediately and starts the 24-hour cooldown.

| Position                         | Entry button           | Review and result                                                   |
| -------------------------------- | ---------------------- | ------------------------------------------------------------------- |
| Active stake, no pending request | Unstake                | Amount to withdraw opens with the Request withdrawal operation.     |
| Pending withdrawal               | Cancel                 | Cancel withdrawal restores the full pending amount to active stake. |
| Withdrawal ready                 | Withdraw {amount} vAPI | Withdraw sends the pending amount to the requesting wallet.         |

While a withdrawal is pending, another Unstake is disabled.
The overview shows the pending amount and readiness countdown, then marks it ready after the cooldown.
You can cancel during the cooldown or after it ends, before withdrawal.
Cancellation restores active stake for the next applicable snapshot and does not recalculate today's Compute.

## Check Compute

Open the initially closed What if I stake more? section for the calculator.
What if I stake takes additional vAPI and adds it to both your active stake and the network total.
Projected for tomorrow shows the next-snapshot estimate after the configured cap and allocation floor.
Dollar output rounds down to cents; invalid input counts as zero extra stake.

See today's limit in Router opens [Router](https://api.vapinetwork.ai/router).
[Pool](/stake/pool/) shows Your Compute today and its 30-day and 365-day equivalents at today's rate.
Pool's simulator takes a proposed total stake and also works signed out.

Get vAPI is a header action for chain ID 8453 when the position is readable and available.
It opens Uniswap in a new tab, selecting Base, native input currency and the configured staking token as output.
See [Compute entitlement](/stake/compute-entitlement/) for calculation and timing.

Checked on 2026-11-17.
