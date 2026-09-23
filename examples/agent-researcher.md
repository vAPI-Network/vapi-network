# Launch a research agent

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
