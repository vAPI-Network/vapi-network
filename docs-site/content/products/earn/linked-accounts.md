---
title: "Linked accounts"
description: "Link social accounts, choose leaderboard visibility and verify GitHub follows."
order: 113
---

[Linked accounts](https://api.vapinetwork.ai/earn/account) has cards for X, Discord, Telegram and GitHub.
The page shows an "of 4 linked" count.
Cards show "Connected" or "Not linked"; an empty card can say "No account linked".
If linking is not configured, the card says "Linking is not available right now."

| Provider | Link control    | Optional leaderboard visibility |
| -------- | --------------- | ------------------------------- |
| X        | "Link X"        | Available with a username.      |
| Discord  | "Link Discord"  | Available with a username.      |
| Telegram | "Link Telegram" | Available with a username.      |
| GitHub   | "Link GitHub"   | Unavailable.                    |

## Linking rules

You cannot link a provider account that belongs to another vAPI profile.
When a card shows Disconnect, you can disconnect and then reconnect or replace that provider account.
Availability depends on the provider and profile; some cards do not offer this control.
Public leaderboard visibility requires a username.
A Telegram account without a username cannot appear publicly.
On a phone, Telegram linking opens the login bot.
A link started from Linked accounts returns here after confirmation.

## Verify a GitHub follow

Follow the [vAPI-Network organisation](https://github.com/vAPI-Network) with your linked GitHub account, then verify the quest.
You must link GitHub before verification.
The GitHub account must be at least 30 days old.
The check follows your immutable GitHub account ID, so renaming the account does not bypass the checks.
Verification shares a limit of six attempts per minute per profile with the GitHub star quest.

An account below the age requirement gets "Your GitHub account needs to be at least 30 days old to earn this quest."
If the connected account is not following, the message is "Follow vAPI-Network with the GitHub account you connected, then verify again."

## Disconnect and reconnect

Each provider allows two counted disconnects in a rolling 30 days when the control is available.
Disconnecting within 15 minutes of linking is a free undo, even after reaching the limit.
A previously disconnected empty card offers "Reconnect".

The old provider identity stays tied to your vAPI account and cannot be used on another account.
Ownership is retained for five years and refreshed on reuse. New links start hidden.
Your points stay, and completed quests do not pay again.
Provider quest points do not count at rewards while that provider is disconnected; connect an account from that provider again.

## LinkedIn

LinkedIn has a separate section below the four provider cards.
It provides account and review management, with disconnect management when available.
It does not change the main "of 4 linked" count for X, Discord, Telegram and GitHub.

Checked on 2026-11-17.
