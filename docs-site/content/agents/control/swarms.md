---
title: "Swarms"
description: "Local swarms group agent accounts around one treasury while each member keeps its own keys, balance, caps, and owner link."
order: 8
---

This page is for owners who want several local agents to share one treasury without sharing keys or account limits.

A swarm groups local agent accounts around one treasury and one capital policy. Each member keeps its own key, balance, caps, profile, and owner link.

## Treasury and members

The treasury is a linked account that holds swarm capital. It has no agent profile and never runs an agent loop. Members spend their own balances on Call and Router.

![A swarm in three layers. The owner funds the treasury with vapi swarm fund, and a treasury ceiling sweep returns excess USDC to the owner. The treasury holds the swarm's capital, one treasury per swarm; it has no agent profile and never runs an agent loop. It rebalances, allocates and delegates capital to members within the run's draw limit, and a member ceiling sweep returns excess USDC to the treasury. Each member keeps its own key, balance, caps, profile and owner link, and an account belongs to at most one swarm. research-lead runs the task in lead mode with the read, allocate and delegate grants, draws capital, and delegates one level of work to another member. research-helper-1 has the read grant and takes one delegated subtask with a hard budget. research-helper-2 has the read grant; in each mode it runs the same task on its own. Members pay for APIs on Call from their own balance with x402 in exact USDC, and think with Router.](vapi-swarms-light.svg)
![A swarm in three layers. The owner funds the treasury with vapi swarm fund, and a treasury ceiling sweep returns excess USDC to the owner. The treasury holds the swarm's capital, one treasury per swarm; it has no agent profile and never runs an agent loop. It rebalances, allocates and delegates capital to members within the run's draw limit, and a member ceiling sweep returns excess USDC to the treasury. Each member keeps its own key, balance, caps, profile and owner link, and an account belongs to at most one swarm. research-lead runs the task in lead mode with the read, allocate and delegate grants, draws capital, and delegates one level of work to another member. research-helper-1 has the read grant and takes one delegated subtask with a hard budget. research-helper-2 has the read grant; in each mode it runs the same task on its own. Members pay for APIs on Call from their own balance with x402 in exact USDC, and think with Router.](vapi-swarms-dark.svg)

_Excess USDC sweeps up one level: members to the treasury, the treasury to the owner._

A member ceiling sweep returns excess USDC to the treasury. A treasury ceiling sweep returns excess to the owner. One local account can belong to at most one swarm.

## Create and manage a swarm

Create two default members, or name roles and fund the treasury during setup:

```bash
vapi swarm create research --agents 2
vapi swarm create research --roles lead,helper,helper --fund 5 --from main
```

The default allocation strategy is `targets`. The CLI also accepts `even` and `weights`. New member profiles use `venice/claude-sonnet-5` unless `--model <id>` selects another Router model.

Use the lifecycle commands as work changes:

```bash
vapi swarm add research reviewer
vapi swarm remove research research-helper-1
vapi swarm fund research 2 --from main
vapi swarm rebalance research
vapi swarm status research
vapi swarm dissolve research
```

Removing a member sweeps it to the treasury and keeps its account, key, and profile. Dissolving sweeps members to the treasury and the treasury to the owner. It removes the swarm file but keeps the accounts and profiles.

## Run the swarm

Lead mode is the default. It runs the lead, which can allocate treasury money to itself or delegate one level of work:

```bash
vapi swarm run research "Compare three weather APIs" --mode lead
```

Each mode gives the same task to every eligible member independently:

```bash
vapi swarm run research "Review the same dataset" --mode each
```

`--budget <usd>` sets a hard Call-and-Router budget for each member run. Without it, a member uses the unspent remainder of its per-day cap. `--draw <usd>` bounds the total treasury capital allocated or delegated during the run and defaults to $2.00.

The lead receives `read`, `allocate`, and `delegate` grants during setup. Other members receive `read`. `swarm.allocate` draws capital for the current member within the draw limit. `swarm.delegate` gives another member a subtask and hard budget. Delegation is one level deep.

## Run in the background

Start local detached work, list it, and stop one run or all runs:

```bash
vapi swarm run research "Compare three weather APIs" --mode each --detach
vapi swarm runs research
vapi swarm stop research <run-id>
vapi swarm stop research --all
```

The local runtime writes secret-free run records under `~/.vapi/runs/` and output to `runs/<run-id>.log`. A second active run for the same member is refused.

If a launcher stopped before it saved a worker reference, `vapi swarm runs` reports the stale start after five minutes. Confirm that the worker is gone before clearing its reservation:

```bash
vapi swarm stop <name> <run-id> --confirm-worker-stopped
```

This override is terminal-only and unavailable through MCP. Never confirm while the worker may still run.

## MCP tools

| Tool              | What it does                                                                                             |
| ----------------- | -------------------------------------------------------------------------------------------------------- |
| `swarm.setup`     | Creates or resumes the treasury, members, caps, profiles, links, and optional funding.                   |
| `swarm.add`       | Adds or resumes one member.                                                                              |
| `swarm.leave`     | Sweeps and removes one member from the swarm.                                                            |
| `swarm.fund`      | Funds the treasury or returns owner funding instructions.                                                |
| `swarm.rebalance` | Moves funds between the treasury and members.                                                            |
| `swarm.status`    | Reads balances, links, allocation totals (allocated, swept out, and net per member), and open movements. |
| `swarm.dissolve`  | Sweeps the capital and removes the swarm file.                                                           |
| `swarm.run`       | Runs the lead or each eligible member, attached or detached.                                             |
| `swarm.runs`      | Lists stored background runs and their latest status.                                                    |

`swarm.allocate` and `swarm.delegate` work only inside a swarm run. A direct MCP call to either tool is refused.

## Next

- [Owner and agents](/agents/control/owner-and-agents/)
- [Sending and distributing](/agents/wallets/sending-and-distributing/)
- [Limits and ceilings](/agents/wallets/limits-and-ceilings/)

Checked on 2026-10-28.
