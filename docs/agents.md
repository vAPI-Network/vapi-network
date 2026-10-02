# Agents

Agent commands and the launch flow are covered here; see [README.md](../README.md).

| Command                          | Options                                                                                                                                                                             | What it does                                                                                                     |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `vapi agent create <name>`       | `--model <id>`, `--instructions <file>`, `--call-budget <usd>`, `--max-per-call <usd>`, `--router-budget <usd>`, `--approve-above <usd>`, `--include-unverified`, `--max-steps <n>` | Creates a capped local agent wallet, profile and owner link                                                      |
| `vapi agent run <name> "<task>"` | `--budget <usd>`                                                                                                                                                                    | Runs the named agent with an optional hard budget across Call and Router top-ups                                 |
| `vapi agent list`                | None                                                                                                                                                                                | Lists profiles, links and today's Call and Router budgets                                                        |
| `vapi agent pause <name>`        | None                                                                                                                                                                                | Stops future runs until the agent is resumed                                                                     |
| `vapi agent resume <name>`       | None                                                                                                                                                                                | Allows a paused agent to run again                                                                               |
| `vapi agent revoke <name>`       | None                                                                                                                                                                                | Revokes the link and removes the profile, but keeps its wallet                                                   |
| `vapi login`                     | `--wallet <name>`, `--label <name>`, `--publish`, `--no-browser`                                                                                                                    | Links the local agent wallet to your vAPI account                                                                |
| `vapi logout`                    | `--wallet <name>`                                                                                                                                                                   | Removes the selected wallet's agent link and stored credentials                                                  |
| `vapi whoami`                    | `--wallet <name>`                                                                                                                                                                   | Shows the chosen wallet's owner link and permissions, whether the link is live, and its ERC-8004 agent identity. |

## Run a swarm

`vapi swarm run <name> "<task>"` runs the swarm's lead by default. In lead mode,
the lead can allocate treasury money to itself or delegate work one level deep;
each delegated budget is a hard limit. Known unspent budget stays in the member
wallet. If an interrupted child has no final record, its `spentUsd` is `null`
and both spending and remaining budget are unknown. `--mode each` instead runs
every linked, active member with a profile and automatically declines every
owner-approval question.

Each invocation has a treasury draw limit, set with `--draw` and defaulting to
$2.00. It bounds the sum of allocations and delegated budgets made during that
run; the treasury's per-call and per-day caps and the relay limit still apply.
`--budget` sets each member run's hard Call-and-Router budget. Without it, each
member uses the unspent remainder of its per-day cap.

An active CLI or MCP run reloads the wallet's current caps before each Call
payment. Lowering caps applies to the next payment attempt without restarting
the run.

## Launch a research agent

This is the launch-video flow for a small local research agent. The wallet,
spend policy, Router key and receipts stay on this machine.

Create `researcher.md` first:

```md
Find current, verifiable data. Prefer primary sources, cite every factual
claim, and explain when the available evidence is incomplete.
```

Create the agent with the vAPI Router model you want to use:

```bash
vapi agent create researcher \
  --model <id> \
  --instructions researcher.md
```

Fund its dedicated wallet with $2 of USDC on Base. The command opens the
funding page and prints the address as a fallback:

```bash
vapi fund --wallet researcher --amount 2
```

Run the research task locally:

```bash
vapi agent run researcher "Summarise today's Base DEX volume with sources"
```

Show the paid calls recorded in the local append-only ledger:

```bash
vapi receipts --wallet researcher
```

Open the vAPI console and show `researcher` under **Your agents**. The entry is
the owner link for this local wallet, not a hosted agent process.

Pause and resume it without deleting either the profile or wallet:

```bash
vapi agent pause researcher
vapi agent resume researcher
```

To wind it down, pause it, sweep any remaining USDC to your owner address, then
revoke the owner link. Revocation removes the agent profile but keeps the empty
wallet on disk.

```bash
vapi agent pause researcher
vapi sweep 0xYOUR_OWNER_ADDRESS --wallet researcher
vapi agent revoke researcher
```
