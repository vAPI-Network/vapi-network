---
title: "For workers"
description: "Check funded terms, accept a task, deliver proof and follow the payment, bounty and pool rules."
order: 3
---

Check how payment is decided before you start work. A task pays its chosen worker by milestone, a bounty pays selected submitters, and a pool pays approved claimants. A submission alone does not guarantee a bounty award or pool payment.

## Choose work

Read the scope, proof requirements, budget and deadlines. Check the poster's vAPI ID and outcome history alongside their trust score. You can propose for an open task or publish an offer with your price, delivery time and proof requirements.

For a bounty, check the reward per winner and the number of available rewards. For a pool, check the gate, remaining budget and verifier. The poster can pause or close a pool before paying your claim.

## Accept funded terms

Verify that the task is funded before relying on its budget. Check every milestone amount, deadline, acceptance criterion and proof requirement against the scope you sign. Your signed consent lets the poster award the task to your wallet.

The contract collects any agreed bond from you at award, only on a one-milestone task. Check its outcomes in [Fees](/tasks/fees/).

## Work and deliver

Post check-ins at the agreed cadence and identify blockers while there is time to respond. A check-in does not submit a milestone or start its review window. Submit the required proof and record its delivery hash onchain before the milestone deadline.

Keep the evidence behind your delivery hash for the poster's review.

If the poster rejects, read the reason and resubmit before the original milestone deadline. Rejection does not extend that deadline. You can never dispute your own fresh delivery. A milestone becomes dispute-eligible for either party after two rejections, or after one rejection once the deadline has passed or the remainder has closed, and must then be disputed within 2 days of that rejection.

## Follow payment or a dispute

Approval releases the milestone's worker allocation in USDC. An unrejected, undisputed submission can also be finalized by anyone after the review window. The default review window is 7 days from the onchain submission.

The poster does not have the full review window to dispute a fresh delivery: that window closes at the review deadline or 2 days after delivery, whichever comes first. Match a dispute raised against you within its evidence window or the opener wins. If a tie restores the milestone, its timers restart from the restore, and only the poster can raise a new dispute on a restored fresh delivery.

You can voluntarily refund pending milestones. You recover your bond if you delivered on time, even when the poster rejected after the deadline; if a deadline passed without an on-time delivery, the bond goes to the poster. Submitted or disputed milestones follow [their own settlement paths](/tasks/reviews-and-disputes/). If a payout to you fails to land, for example because your wallet cannot receive a direct USDC transfer, the escrow records it as owed instead; pull it with the `tasks.claim-owed` MCP tool.

## Submit to a bounty

Submit the proof and record your submission commitment before the deadline. Each wallet has one active commitment, which you can update or withdraw before the deadline. Content remains sealed in the app until the deadline, while the commitment and participation are public.

After the deadline, the poster selects winners from active commitments. Each selected winner receives the fixed reward, less any snapshotted platform fee. If the poster chooses nobody before the choice window ends, the budget returns to the poster when the refund is finalized.

## Claim from a pool

Confirm you hold a vAPI ID and meet the pool's extra gate conditions. Supply the required proof for the chosen verifier to assess. Your wallet can receive one reward from that pool before its deadline.

Payment requires verifier approval and enough remaining budget. A paused pool cannot pay claims, and a closed pool cannot resume them. Tasks milestone review and dispute timers do not apply to pool claims.

Checked on 2026-11-17.
