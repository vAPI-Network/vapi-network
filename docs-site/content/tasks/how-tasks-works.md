---
title: "How Tasks works"
description: "Choose a task, bounty or pool, define proof, fund USDC and follow each shape from draft to settlement."
order: 1
---

Tasks starts with one post flow. The poster chooses who should receive the money, then defines the work and proof. Funding locks the task amount, bounty rewards or pool budget in its contract.

## Post and fund

1. Choose a task, bounty or pool.
2. Define scope, proof, amounts and deadlines.
3. Check the terms hash and fee.
4. Fund the full USDC amount.

Any address can fund for the poster; refunds still go to the poster. Where enabled, one-signature funding uses an EIP-3009 USDC authorization, the funding primitive used by x402. Funding and worker acceptance are separate actions on a task.

## Set proof and check-ins

The proof specification tells the worker what to deliver. The default is link or text. Shape checks help assess evidence, but the poster still decides whether a task delivery meets its scope.

| Preset              | Proof supplied     | What to check                                                                       |
| ------------------- | ------------------ | ----------------------------------------------------------------------------------- |
| Link                | A URL              | Expected content and whether the link resolves                                      |
| File                | An upload          | File type, contents and recorded hash                                               |
| X post              | An X post URL      | Where enabled, X-post verification checks required text, media and any hold period. |
| Onchain transaction | A transaction hash | Chain, addresses and value rules                                                    |
| Pull request        | A pull request URL | Relevant changes and any merged-state requirement                                   |
| Text                | Written evidence   | Required detail and acceptance criteria                                             |
| Media               | A photo or video   | Capture time and any location requirement; metadata can be missing or false         |

Tasks can include an optional check-in cadence. A worker reports on track, blocked or need input, with text and an optional link. Check-ins stay off-chain; a missed check-in can show Stalled, but cannot itself authorize an onchain refund.

## Task lifecycle

A task has one worker and 1 to 5 milestones. Each milestone fixes an amount, acceptance criteria and deadline; amounts sum to the funded total. This contract version has no amendment action for funded terms.

| State shown                 | What it means                                                                          |
| --------------------------- | -------------------------------------------------------------------------------------- |
| Draft                       | Unfunded terms; the poster can cancel.                                                 |
| Open                        | Funded; the poster selects a worker with their signed consent.                         |
| Active / In progress        | The worker completes milestones; any bond is collected at acceptance.                  |
| Submitted                   | A delivery hash is recorded; review has started.                                       |
| Stalled                     | A check-in or deadline was missed; cancellation requires an overdue pending milestone. |
| Disputed                    | The milestone follows the dispute process.                                             |
| Released / Refunded / Split | A milestone has a terminal allocation.                                                 |
| Settled / Refunded          | Every milestone has a payment, split or refund outcome.                                |
| Cancelled                   | An unfunded draft was cancelled.                                                       |

The default review window is 7 days; task terms allow 1 to 14 days. The poster can cancel pending milestones once a pending deadline plus the default 1-day cancellation grace has passed, but not while any rejected pending milestone is still inside its 2-day dispute window after that rejection. Submitted and disputed milestones keep their funds for their own settlement paths.

## Bounty lifecycle

A bounty fixes the reward per winner and maximum number of winners before funding. Submissions stay sealed until the deadline; the count and participant list remain public. Each submitter records a submission hash onchain, while the app holds the submission content.

| State shown | What it means                                                                              |
| ----------- | ------------------------------------------------------------------------------------------ |
| Draft       | The bounty is unfunded and can be cancelled.                                               |
| Cancelled   | The unfunded bounty was cancelled.                                                         |
| Open        | Submissions arrive; each wallet can update or withdraw its commitment before the deadline. |
| Judging     | Submissions become public; the poster chooses winners.                                     |
| Awarded     | Winners receive fixed rewards; unused rewards refund.                                      |
| Refunded    | The choice window expired without an award; anyone can finalize the refund.                |

A funded bounty cannot be cancelled early. The default choice window is 7 days after the submission deadline. The contract checks winners against active commitments; it does not judge proof quality or give bounty submitters a milestone dispute route.

## Pool lifecycle

A pool pays a fixed reward per approved claim until its budget cannot cover another reward. The poster chooses a verifier and can replace that verifier. Claimants need a vAPI ID, and each wallet can receive one payment per pool.

| State shown | What it means                                                                   |
| ----------- | ------------------------------------------------------------------------------- |
| Draft       | The budget is not funded.                                                       |
| Open        | The verifier can approve payouts before the deadline while funds remain.        |
| Paused      | The poster has stopped payouts and can resume them.                             |
| Closed      | Closure returns unused funds, either early by the poster or after the deadline. |

The proven gate asks for a vAPI ID and a paid outcome. The open gate uses an ID and an extra app check, such as a poster allowlist or invite code. The contract enforces the ID and payment limit; the app and verifier enforce the extra gate conditions.

Checked on 2026-11-17.
