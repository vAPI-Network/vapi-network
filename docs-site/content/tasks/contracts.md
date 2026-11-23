---
title: "Contracts"
description: "Identify the Tasks contracts, their policy controls, and the events that start payment and dispute timers."
order: 8
---

Each funded task uses an `EscrowV2` contract and each bounty a `BountyEscrowV2` contract. Pools use `BountyPoolV1`. Separate contracts create them, route worker payments, resolve milestone disputes and record outcome facts.

| Contract                 | Responsibility                                                                                                             |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `EscrowV2`               | Holds a task's milestones; executes payment and refund paths.                                                              |
| `BountyEscrowV2`         | Holds a bounty's rewards; pays the chosen submissions and refunds the rest.                                                |
| `EscrowFactoryV2`        | Creates escrows with a fee snapshot and optional amount cap.                                                               |
| `DisputeResolverV3`      | Runs juries, commit and reveal voting, verdicts and status-quo endings.                                                    |
| `BountyPoolV1`           | Pays claims approved by the poster-selected verifier.                                                                      |
| `BountyPoolFactoryV1`    | Creates pools with a fee snapshot and optional budget cap.                                                                 |
| `OutcomeRegistryV1`      | Records settlement facts from registered escrows and pools.                                                                |
| `VapiIdV1`               | Issues wallet-bound IDs without a score inside the token.                                                                  |
| `ReviewerRegistryV2`     | Stores reviewer seats and supports stake-gated self-registration, up to a size limit the owner sets below a fixed maximum. |
| `ThresholdReviewersGate` | Supplies the staking threshold used for reviewer eligibility.                                                              |
| `FeeRouterV1`            | Distributes worker payments at the snapshotted rate.                                                                       |

During the beta these contracts run on Base Sepolia; addresses follow after the beta deployment. Mainnet follows after the contract fixes, a second review and an external audit.

## Owner controls

The factory owner can set fees for future work, subject to an immutable cap of at most 20%. The owner can set creation caps and pause new escrow or pool creation. Those pauses leave existing escrows and pools operable.

The dispute resolver owner can change fee bounds for future disputes. The reviewer registry owner can also add or remove seats, with a stake check on additions. These controls do not give an owner a verdict action or an escrow withdrawal action.

vAPI has no administrative verdict action or escrow principal withdrawal action. Registry seat changes can affect who is eligible to vote. A pool poster can authorize a verifier, including a vAPI checker, to approve that pool's claims. The poster can replace that verifier, pause payouts or close the pool and recover its unused budget.

## Timers and transactions

Contract timestamps come from onchain actions, not messages, check-ins or notifications. Confirm these defaults against deployed policy and signed terms. Reaching a deadline enables the corresponding action; someone still needs to submit its transaction.

A status-quo restore resets these clocks rather than leaving the original ones running: the late window for a new dispute always counts from the restore, and a restore that followed a poster's dispute of a fresh delivery also restarts that milestone's review window from the restore. The jury's commit window cannot start until the evidence window ends, even if both parties already paid their fee.

| Window                                 | Default | Start                          |
| -------------------------------------- | ------- | ------------------------------ |
| Review                                 | 7 days  | Milestone submission           |
| Dispute filing, called the late window | 2 days  | Latest submission or rejection |
| Evidence                               | 2 days  | Dispute raised                 |
| Commit                                 | 2 days  | Jury voting opens              |
| Reveal                                 | 1 day   | Commit deadline                |
| Cancellation grace                     | 1 day   | Pending milestone deadline     |
| Bounty choice                          | 7 days  | Bounty submission deadline     |

The beta deployment on Base Sepolia uses these defaults.

Checked on 2026-11-17.
