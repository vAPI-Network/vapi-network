---
title: "Profile"
description: "Your Earn profile, vAPI ID, Genesis Egg, statistics and picture settings."
order: 110
---

[Profile](https://api.vapinetwork.ai/earn/profile) shows your picture, account identity and member-since date.
It uses your existing account username, or your wallet as a fallback.
Profile has no username-edit control.
Linked-provider chips open [Linked accounts](/products/earn/linked-accounts/).
Invite controls let you share your referral link.
The [badge wall](/products/earn/badges/) shows your earned badges and progress toward others.

## vAPI ID and Genesis Egg

The vAPI ID tile appears when you have an ID or a pending mint.
A pending mint shows "Your ID is on its way" and "Minting on Base".
The tile does not give a mint time.
Read more about [account setup and vAPI ID](/account-and-sign-in/).

| Genesis Egg status | What Profile shows                                                              |
| ------------------ | ------------------------------------------------------------------------------- |
| Holder             | "Genesis Egg holder", cover artwork and token ID.                               |
| Nonholder          | "Not held" and "Get one", which opens [/eggs](https://api.vapinetwork.ai/eggs). |
| Failed read        | "Couldn't check".                                                               |

See [Genesis Goose Eggs](/token-and-foundation/genesis-eggs/) for the NFT campaign.

## Statistics

Profile shows your points, rank and progress.
Streak statistics include your current and best streak.
Points to the next rank appear only when that rank is on the cached leaderboard.

| Statistic | What it shows                          |
| --------- | -------------------------------------- |
| "Points"  | Your points total.                     |
| "Rank"    | Your current rank.                     |
| "Streak"  | Your current and best check-in streak. |
| "Badges"  | Earned and total badges.               |
| "Quests"  | Completed and total quests.            |

## Profile picture

Uploading a picture requires a wallet with an onchain vAPI ID.
Choose a PNG, JPEG or WebP file.
The browser crops it to a centre square and resizes it to 256 by 256 pixels before upload.
The uploaded file must be at most 512 KB (524,288 bytes).
That limit applies after resizing, rather than to your original file.
You can make three picture changes per rolling 24 hours.
Deleting your picture counts toward the same limit.
A picture removed by a reviewer cannot be re-uploaded for seven days.
Rules and safety lists the picture rules.

During an Earn pause, the saved board can show older profile statistics.
Check the pause notice for its timestamp; quest actions resume when the service recovers.
See [Earn](/products/earn/) for saved-board retention and automatic checks.

Checked on 2026-11-17.
