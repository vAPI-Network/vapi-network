---
title: "Activity and performance"
description: "Read your Earn point trends, usage and activity history."
order: 112
---

[Performance](https://api.vapinetwork.ai/earn/performance) shows your point trends and available vAPI usage.
[Activity](https://api.vapinetwork.ai/earn/activity) lists the events behind your progress.
Both pages require sign-in.

## Performance

"This week" covers seven UTC days, including today.
"Best day" uses the latest day when several days tie.
"Rank change" reports rank movement rather than a historical rank chart.
"Total points" shows your current points total.
Choose "7 days" or "Since joining" to change the range.
The second control can show "Since [date]" when the page uses activity as a fallback.
The total-points chart works backward from your current total and subtracts daily gains, with a minimum of zero.
History covers up to 366 days; activity gains provide a fallback when history is unavailable.

"Where points came from" groups known-point activity under "Invites", "Quests", "Booster bonus" and "Check-ins".
It covers the last 30 UTC days, or starts at the complete-since date if that date is later.
Older backfilled completions do not contribute to these categories.
"Daily check-ins" shows a 30-day grid with checked-in, missed and untracked days.

"Your use of vAPI" shows each value only when it is available.

| Value            | What it shows                                                     |
| ---------------- | ----------------------------------------------------------------- |
| "Paid Calls"     | Paid Calls within the displayed retained window, capped at "50+". |
| "Router top-ups" | Your Router top-ups.                                              |
| "Staked vAPI"    | Your staked vAPI.                                                 |
| "Linked agents"  | Your linked agents.                                               |

## Activity

Activity shows a complete-since date for its records.
Events include known points and boosters when available.
The log groups events into these categories.

| Category          | Event                                                                  |
| ----------------- | ---------------------------------------------------------------------- |
| "Quest completed" | You completed a quest.                                                 |
| "Badge earned"    | You earned a badge.                                                    |
| "Account linked"  | You linked a provider account.                                         |
| "Account removed" | Removal label; a disconnect is not guaranteed to record an event.      |
| "Friend joined"   | An invited friend joined; referrer credits enrich or create one row.   |
| "Referral reward" | Points credited to the invited player.                                 |
| "Points added"    | Credits, debits and signed adjustments, with the relevant point title. |

Each page contains 30 rows; choose "Load more" to read the next page.
Older backfilled quests show "Completed" and a date without points.
Recurring entries stay for 35 days; other entries stay for 400 days.

Activity can show "Season reward", "Clip reward", "Email confirmed", "Points spent" and "Points adjusted".
Quest and check-in credits do not create duplicate rows. A live completion can update an existing backfilled row while retaining awarded-point details.
Recording is separate from dashboard display; the dashboard alone does not establish whether recording is enabled.

Check-in streaks use UTC days. A check-in on the same or an earlier day does not increment the streak.
The next day increments it; a gap resets the current streak, while the best streak never decreases.
Retries repair failed streak writes using persisted event time, so later-day replays do not add a day. Webhook activity does not advance streaks.

Checked on 2026-11-17.
