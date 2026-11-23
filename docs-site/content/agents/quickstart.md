---
title: "Run your first agent"
description: "Create, link, fund, and run a local agent with spending limits."
order: 1
---

This guide is for owners who want to create, link, fund, and run one local agent with clear limits.

New to vAPI? Start with the [Quickstart](/quickstart/). Read [How wallets work](/agents/wallets/how-wallets-work/) before you fund the agent.

Use [Start with your agent](/start-with-your-agent/) for terminal setup or a browser-only connection.

Give your agent this prompt:

```text
Read https://vapinetwork.ai/agent-start.md and follow it to set me up on vAPI.
```

## 1. Install and set up

Clients ≤ 0.9.0 fail every search whose results include a Solana row. Update to 0.14.0 with the global install below.

Install the client globally:

```bash
npm i -g vapi-network
```

Run setup after the global install:

```bash
vapi setup
```

Setup creates or restores the vault and derives the first account. It links that account to your owner account and offers encrypted cloud backup. It is safe to rerun and skips finished steps.

Or skip the global install and run setup through `npx`:

```bash
npx vapi-network setup
```

On a server, container or GitHub Codespace, read [Troubleshooting](/agents/wallets/troubleshooting/) before setup.

The lower-level initialization command remains available:

```bash
vapi init
```

In an interactive terminal, `vapi init` asks "Link to your dashboard? [Y/n]". Press Enter to accept the default, or pass `--no-link` to skip.

The remaining examples use the global `vapi` command. If you skipped the global install, replace it with `npx vapi-network`.

## 2. Create the agent

Create `researcher.md` with the agent's instructions:

```md
Find current, verifiable data. Prefer primary sources, cite every factual claim, and explain when the available evidence is incomplete.
```

Create a `researcher` agent. The wallet cap and suggested Router allowance are daily limits shared by its runs:

```bash
vapi agent create researcher \
  --model venice/deepseek-v4-flash \
  --instructions researcher.md \
  --call-budget 2 \
  --router-budget 2
```

The client creates the local profile and its dedicated wallet.

## 3. Approve the link

If the agent wallet is not linked yet, start its link:

```bash
vapi login --account researcher
```

The terminal shows a code and a URL. Open `https://api.vapinetwork.ai/link?code=...`, approve the link from your ready vAPI account, and set the daily Router allowance. The code lasts 20 minutes.

The code links the agent wallet to your account. It does not give the agent control of your wallet.

## 4. Fund the agent wallet

Open the funding page and print the agent's address:

```bash
vapi fund --account researcher --amount 2
```

Send USDC on Base to the printed address.

Buy $1 of Router balance so the first model call does not depend on the owner having Compute:

```bash
vapi router buy 1 --account researcher
```

The purchase uses the agent wallet's USDC and counts against its daily wallet cap. The remaining USDC can pay for vAPI Call requests.

## 5. Run a task

Run the agent on your machine:

```bash
vapi agent run researcher "Summarise today's Base DEX volume with sources"
```

## 6. Check the agent

Open [My agents](https://api.vapinetwork.ai/agents) in the console. The `vapi dashboard` command opens My agents for the selected account:

```bash
vapi dashboard --account researcher
```

The `researcher` entry is the owner link for the local wallet, not a hosted agent process. Its View activity link opens [Usage](https://api.vapinetwork.ai/usage) with that agent selected.

List local agent profiles and today's budgets:

```bash
vapi agent list
```

Check the account link and permissions for the wallet:

```bash
vapi whoami --account researcher
```

Owner approval supports wallet, email and Google sign-in. Finish account setup and confirmed vAPI ID first.
An own-wallet account may require wallet proof; embedded email/Google owners can approve without external-wallet SIWE.

## Next

- [Limits and ceilings](/agents/wallets/limits-and-ceilings/)
- [Owner and agents](/agents/control/owner-and-agents/)
- [CLI reference](/reference/cli/cli-reference/)

Checked on 2026-11-17.
