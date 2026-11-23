---
title: "Limits and ceilings"
description: "Account caps, balance ceilings, Router allowances, and local run guards bound an agent's spending and execution."
order: 3
---

This page is for owners who want to bound an agent's payments, Router use, balance, and local run.

vAPI agents have account caps, a Router allowance, balance ceilings, and guards inside the local run loop.

## Account spend caps

Account caps apply to every payment from the agent account. Set a limit for one payment and a total for each day:

```bash
vapi accounts caps <name> --per-call <usd> --per-day <usd>
```

A refused API payment reports `spend_cap_exceeded` with the attempted and limit amounts. The client refuses before signing.

The caps also apply when the agent buys Router balance or refills it automatically:

```bash
vapi router buy <1|5|20|50> --account <name>
vapi router buy --auto <tier> --below <usd> --account <name>
```

## Balance ceiling

Each account has a 5 USDC Base ceiling by default. The account sends funds above the ceiling back to its parent, so an agent never holds more than it needs. Set another ceiling, or turn the automatic sweep off:

```bash
vapi accounts caps <name> --ceiling <usd>
vapi accounts caps <name> --ceiling off
```

The per-day cap is the sweep floor. Read [Sending and distributing](/agents/wallets/sending-and-distributing/#keep-balances-below-the-ceiling) for when sweeps run.

## Daily Router allowance

The owner sets a server-side daily Router allowance on `/link`. The owner can change it later from **My agents** at `/agents`.

The allowance can be from 0 to 1,000 USD. It caps the agent's Compute and balance keys separately, each with its own 24-hour reset window. Compute calls also use the owner's daily Compute limit; balance calls use the owner's shared prepaid balance.

Check the agent's Compute allowance and Router balance:

```bash
vapi router usage --account <name>
```

## Reference agent guards

Set the reference agent's daily wallet cap, suggested daily Compute allowance, per-call limit, approval threshold, and step limit when you create it:

```bash
vapi agent create <name> \
  --model <id> \
  --instructions <file> \
  --call-budget <usd> \
  --router-budget <usd> \
  --max-per-call <usd> \
  --approve-above <usd> \
  --max-steps <n>
```

By default, the agent asks before a call above $0.50. It uses only verified listings and only listings it found in the same run.

Add unverified listings explicitly:

```bash
vapi agent create <name> \
  --model <id> \
  --instructions <file> \
  --include-unverified
```

The agent stops after 12 model steps by default. It also stops when a budget runs out or a settlement is uncertain. Tool output reaches the model only as untrusted data, and every step is in the audit log.

One run budget caps Call payments and Router top-ups together:

```bash
vapi agent run <name> "<task>" --budget <usd>
```

See each profile, link, and today's Call and Router budgets:

```bash
vapi agent list
```

Pause future runs, then allow them again when you are ready:

```bash
vapi agent pause <name>
vapi agent resume <name>
```

## Next

- [How wallets work](/agents/wallets/how-wallets-work/)
- [Owner and agents](/agents/control/owner-and-agents/)
- [Run your first agent](/agents/quickstart/)

Checked on 2026-10-30.
