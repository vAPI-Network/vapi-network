---
title: "Telegram notifications"
description: "Earn Telegram notification eligibility, delivery limits and message controls."
order: 114
---

Earn can send automated notifications to your actively linked Telegram account.
Not every event sends a message, so check Earn itself for your full history.

| Event                    | Eligibility                                                       |
| ------------------------ | ----------------------------------------------------------------- |
| Badge granted            | Can notify about a new badge.                                     |
| Positive points credited | Can notify unless the source is quest, daily-checkin or referral. |
| Referral signup          | The referral-signup source can notify.                            |

Events older than six hours are skipped.
Earn makes at most three notification attempts per UTC day, including failed sends.
Event deduplication lasts seven days.

## Recognise an Earn message

A badge message uses "New badge: …" or "You earned a new badge".
A points message contains a points title or amount.
Messages include "Send /mute to stop these messages." and an "Open Earn" button.
Check that Open Earn leads to api.vapinetwork.ai, and compare the event with your Earn activity.
A matching message format alone does not prove who sent it.
vAPI never asks for a seed phrase or private key; do not send either in a reply or enter them through a message link.

## Mute or resume messages

Send this command in the bot's private chat to stop Earn messages:

```text
/mute
```

Send this command in the same private chat to resume them:

```text
/unmute
```

These controls affect Earn notifications; they do not disconnect your Telegram account.
Review your connection in [Linked accounts](/products/earn/linked-accounts/).

Checked on 2026-11-17.
