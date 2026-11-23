---
title: "Reviewer eligibility"
description: "10,000 vAPI of active stake meets the reviewer stake threshold; Tasks is still coming soon."
order: 6
---

10,000 vAPI of active stake meets the current stake threshold for Tasks reviewer eligibility. [Tasks](/tasks/) is still coming soon; meeting the threshold does not open reviewer work today.

## Eligibility rule

`ThresholdReviewersGate` reads live active stake:

```solidity
stakedBalance(account) >= threshold
```

A withdrawal request reduces active stake immediately, so its pending amount does not count. Cancelling the request restores active stake and can restore eligibility immediately. This live check is separate from the daily Compute snapshot.

## Threshold controls

| Parameter                     | Value                                                 |
| ----------------------------- | ----------------------------------------------------- |
| Current threshold             | 10,000 vAPI                                           |
| Permitted threshold range     | 10,000–1,000,000 vAPI                                 |
| Change notice                 | 7 days                                                |
| Execution window after notice | 14 days                                               |
| Gate owner                    | Safe listed in [Staking contracts](/stake/contracts/) |

The owner proposes a threshold, waits seven days, and executes within the following 14-day window. The current threshold stays active until execution. The owner can cancel a proposal; an expired proposal must be proposed again.

The gate checks eligibility and does not move vAPI. `VapiStaking` itself has no owner. Token governance controls are not active.
