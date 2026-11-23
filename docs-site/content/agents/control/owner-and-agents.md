---
title: "Owner and agents"
description: "Owners link, limit, pause, or revoke agents without giving them control of the owner wallet."
order: 7
---

This page is for owners who want to link, limit, pause, or revoke local agents without giving them control of the owner's wallet.

The owner controls the vAPI account, while each agent uses a separate local wallet. This keeps account permissions and wallet control separate.

## Link an agent

As the owner, sign in with email, Google or a wallet. The client creates separate agent wallets on your machine.

Use the CLI [login command](/reference/cli/cli-reference/) to start a link for the selected agent wallet.

The terminal shows a code and a URL. Open `https://api.vapinetwork.ai/link?code=...`, approve from your ready vAPI account, and set the agent's daily Router allowance in USD. The code lasts 20 minutes.

`vapi init`, `vapi wallet create` and `vapi mcp install` offer this link themselves in an interactive terminal; press Enter to accept or pass `--no-link` to skip.

When you approve the first link, you can tick Trust this device for new accounts. On a device the owner trusts, later links can complete without the browser step, and the terminal prints `Linked on this trusted device`. The client must request trusted-device linking with a bearer token from an account already linked on that device. Requested permissions must fit that token's scopes. The requested Router allowance must fit the trusted allowance.

The default link from CLI login or setup requests `mcp:call`, `router.use`, `tasks:read` and `tasks:write`. Tasks is not open in production yet, so the two Tasks permissions grant nothing usable today. The CLI login command's publish option requests publishing rights when you start the link.

This adds the optional `call.publish` scope. These scopes grant rights on your account, never on your wallet.

Agents run on your own machines with their own wallets. They can use vAPI on your account within the limits you set. They can never move money from your wallet.

## See what your agents do

My agents starts with "Give this to your agent" above the agent list. Manual connection options remain below.
The connect=1 query opens, scrolls to and focuses the setup region.
For an existing account, use this prompt:

```text
I have a vAPI account. Read https://vapinetwork.ai/agent-start.md and follow it to connect yourself to it.
```

Every linked agent shows up in the console under Account → My agents at `/agents` with its wallet, USDC balance, Router allowance, spending today and last use. Open the account menu through the header avatar and username to see your safety word directly.
See [Account and sign-in](/account-and-sign-in/) for menu order and wallet actions.
The CLI dashboard command opens My agents from the terminal.

To see what your agents spent, open Account → Usage and activity in the navigation (`/usage`) while you are signed in. It shows the paid Call requests from your own wallet and from every linked agent: total spend, number of calls, the APIs used and the recent calls with the wallet that paid. Use the selector at the top to switch between All, My wallet and a single agent.

Each agent on My agents has a View activity link. It opens Usage and activity at `/usage?agent=<wallet>` with that agent selected. Only active links count; a revoked agent's payments drop out of the totals.

## Fund and sweep

Funding is push-only. You send USDC to the agent's address. The CLI fund command prints the funding page.

The CLI sweep command sends the agent wallet's USDC back to the linked owner when you omit the destination address.
Client 0.14.0 also withdraws native Base ETH; see [Sending and distributing](/agents/wallets/sending-and-distributing/).
My agents displays Base ETH alongside USDC only when the ETH balance is positive and available.
Calls are paid in USDC. This ETH pays the network fee when you move funds out.

## Check or revoke a link

The CLI whoami command checks the owner link and its permissions.

The result includes the link and either `Status: active` or `Status: revoked`.

In the console navigation, open Account → My agents at `/agents`. Use Change allowance to edit its Router caps, or Revoke and then Confirm revoke to revoke the link. The CLI agent revoke and logout commands can also revoke or remove a local link.

Relinking an agent wallet revokes its previous link. One owner can have at most 50 linked agents.

The agent's tokens and Router key live in the vault's secret store under the wallet name. macOS, Windows and Linux with a working keyring use the OS store. A new headless Linux vault created with `VAPI_VAULT_PASSWORD` uses encrypted `~/.vapi/secrets.json`. See [How wallets work](/agents/wallets/how-wallets-work/#servers-and-ci) for the fixed backend choice.

- [How wallets work](/agents/wallets/how-wallets-work/)
- [Limits and ceilings](/agents/wallets/limits-and-ceilings/)
- [Agents and Router HTTP API](/reference/http-api/agents-and-router/)

Owner approval supports wallet, email and Google sign-in. Finish account setup and confirmed vAPI ID first.
An own-wallet account may require wallet proof; embedded email/Google owners can approve without external-wallet SIWE.

Checked on 2026-11-17.
