---
title: "Earn"
description: "The Earn dashboard, quests, points, boosters, leaderboard, and the 1M vAPI airdrop."
order: 109
---

The Earn dashboard brings together your quests, points, profile and campaign activity at [api.vapinetwork.ai/earn](https://api.vapinetwork.ai/earn).
Signed in, `/earn` opens Overview at `/earn/overview`.
Signed out, it opens Quests at `/earn/quests`.
Both redirects keep the query string.
[vapinetwork.ai/earn](https://vapinetwork.ai/earn) forwards to the same entry URL.

| Page                                                    | Path                | What it shows                                                                                                                                  |
| ------------------------------------------------------- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Overview                                                | `/earn/overview`    | Your standing, invites, daily check-in, streak, next quests, badge summary, up to five recent activities and "Updates".                        |
| [Profile](/products/earn/profile/)                      | `/earn/profile`     | Picture, identity, member-since date, linked accounts, vAPI ID, Genesis Egg, statistics, invites, assets and [badges](/products/earn/badges/). |
| [Linked accounts](/products/earn/linked-accounts/)      | `/earn/account`     | X, Discord, Telegram and GitHub cards, link controls and supported leaderboard visibility controls.                                            |
| Quests                                                  | `/earn/quests`      | "Points" links to Profile; "Rank" links to Leaderboard; priority quests, linking prompt and quest board.                                       |
| Leaderboard                                             | `/earn/leaderboard` | Top-three podium, player ranks, movement, share of leader and points.                                                                          |
| [Activity](/products/earn/activity-and-performance/)    | `/earn/activity`    | Complete-since date, grouped events, known points and boosters, older completions and "Load more".                                             |
| [Performance](/products/earn/activity-and-performance/) | `/earn/performance` | Point totals, daily gains, rank change, point sources, check-ins and available vAPI usage.                                                     |
| Rules and safety                                        | `/earn/rules`       | Campaign rules, "Badges", "Activity log", "Picture rules" and the safety-word control.                                                         |

Quests, Leaderboard and Rules and safety are public before sign-in.
Overview, Profile, Linked accounts, Activity and Performance send signed-out visitors to Quests.
Sign in with email, Google or a wallet to finish quests and earn points.
`/leaderboard` forwards to `/earn/leaderboard`; `/earn/quest` forwards to `/earn/quests`.
Both aliases keep the query string.
The dashboard shows one undismissed announcement banner at a time, with a link when provided.
Overview also shows "Updates".

The [leaderboard](https://api.vapinetwork.ai/earn/leaderboard) has 25 players per page.
It shows a top-three podium, uploaded pictures, Genesis Egg marks and a sticky row for your own standing.
The "Move" column compares previous and current rank; it shows "New" when no previous rank exists.
Before you have a rank, it shows your username with a "rank updating" row.

## Quests and points

Quests complete on Quests at `/earn/quests`.
Daily check-in and next quests also appear on Overview.
Daily quests and boosters appear before the rest of the quest board.
The Quests header shows "Unranked yet" when you have no rank.
Social quests need the matching X, Discord, Telegram or GitHub account linked.
Open [Linked accounts](/products/earn/linked-accounts/) from Profile chips or quest prompts.
On a phone, Telegram linking opens the login bot.
Linking started from Linked accounts returns there after confirmation.
The GitHub star quest verifies a star on the vAPI repository.
It needs a GitHub account at least 30 days old and reads the account's newest 300 public stars.
The GitHub follow quest requires you to follow the [vAPI-Network organisation](https://github.com/vAPI-Network) with your linked GitHub account.
That account must be at least 30 days old.
See [Linked accounts](/products/earn/linked-accounts/) for verification checks.
The LinkedIn quest is checked by manual review, so it can take longer than the others.
Invite friends with the referral controls on Overview and Profile.
A referral counts only after your invited friend finishes account setup and has an onchain vAPI ID.
"Make your first Router request" also counts a request paid from purchased Router balance.
"Connect an agent" opens [Connect](https://api.vapinetwork.ai/connect) and counts either a CLI link or a hosted MCP connector.

| Quest                             | Type     | Reward        |
| --------------------------------- | -------- | ------------- |
| Daily check-in                    | daily    | 10 pts        |
| Follow vAPI Network on X          | social   | 75 pts        |
| Repost the vAPI campaign post     | social   | 75 pts        |
| Like the vAPI campaign post       | social   | 75 pts        |
| Follow Mark, vAPI's founder, on X | social   | 75 pts        |
| Join vAPI on Telegram             | social   | 75 pts        |
| Join the vAPI Discord             | social   | 75 pts        |
| Follow vAPI on LinkedIn           | social   | 75 pts        |
| Complete your profile             | platform | 500 pts       |
| Mint your vAPI ID                 | platform | 350 pts       |
| Create your first Router key      | platform | 150 pts       |
| Connect an agent                  | platform | 250 pts       |
| Make your first Router request    | platform | 250 pts       |
| Make your first paid Call         | platform | 300 pts       |
| Top up Router credit              | platform | 400 pts       |
| List your API on vAPI             | platform | 500 pts       |
| Stake vAPI                        | holders  | 1.75x booster |
| Hold vAPI                         | holders  | 1.5x booster  |
| Hold a Genesis Goose Egg          | holders  | 1.2x booster  |

## Boosters

Boosters multiply points while active.
A booster grant lasts one week.
Renewal follows that quest's cooldown.
Boosters do not stack; only the strongest active one counts.
Staking vAPI provides a daily Router usage limit.

## Airdrop

The Earn campaign has its own airdrop of 1M vAPI, separate from the launch airdrop allocation on the [vAPI token](/token-and-foundation/vapi-token/) page.
25% is unlocked and the rest vests linearly over 6 months.
The rules will be published before any distribution.
No points-to-token rate, distribution formula, distribution date, or eligibility rules are published yet.
Multiple accounts, automated activity and bought accounts can be excluded from the airdrop, at our discretion. Eligibility is checked when the airdrop is distributed.

## Paused updates

When live updates pause, Earn serves the last saved board for up to 23 hours for members and 24 hours publicly.
The heading reads "Live updates paused since …" and identifies the saved board time. Your points are safe.
Quest actions stay disabled until the service recovers, and the page retries automatically.
Without a saved board, it shows "Earn is paused". Public recovery checks run every 30 seconds.

## Security and scams

Earn never asks a wallet to sign a transaction.
Quests complete on Quests at `/earn/quests`.
vAPI can send automated Earn Telegram notifications to your actively linked Telegram account.
vAPI never asks for a seed phrase or private key.
See [Telegram notifications](/products/earn/telegram-notifications/) for eligibility, message forms and mute controls.
Check that the domain is vapinetwork.ai or a subdomain such as api.vapinetwork.ai.
After sign-in, Rules and safety masks your safety word behind "Reveal" and "Hide" controls.
The account menu shows it directly; see [Account and sign-in](/account-and-sign-in/).

Checked on 2026-11-17.
