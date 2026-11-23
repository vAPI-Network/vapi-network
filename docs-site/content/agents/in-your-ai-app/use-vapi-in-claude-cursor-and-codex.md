---
title: "MCP server for Claude, Cursor and Codex"
description: "The local vAPI Network MCP server connects Claude, Cursor, and Codex to buyer-controlled wallets and x402 API tools."
order: 9
---

The vAPI Network MCP server connects Claude, Cursor, and Codex to the local vapi-network client over stdio.

`vapi mcp` runs a local MCP server over stdio. New users can start with the [Overview Quickstart](/quickstart/).

This page adds vAPI tools to those apps. To run Claude Code or Codex itself on your daily Compute, see [Use your Compute in Claude Code and Codex](/router/use-compute-in-claude-code-and-codex/).

Use [Start with your agent](/start-with-your-agent/) for terminal setup or a browser-only connection.

## Start the server

Clients ≤ 0.9.0 fail every search whose results include a Solana row. Update to 0.14.0 before installing the MCP server:

```bash
npm i -g vapi-network@latest
```

Install the server into your AI app with one of these commands. Since client 0.11.0, Claude Code has a separate install target from Claude Desktop:

```bash
vapi mcp install claude-code
vapi mcp install claude-desktop
vapi mcp install cursor
vapi mcp install codex
```

The Claude Code target registers through its `claude` command; start a new session afterward. The `claude` install target remains an alias for Claude Desktop. Restart Claude Desktop or reload Cursor after installation.

Or run the server through the published package:

```bash
npx -y vapi-network@latest mcp
```

Add the same command and arguments to an MCP client. The public client README shows this generic stdio shape for Claude Code, Claude Desktop, and Cursor:

```json
{
  "mcpServers": {
    "vapi": {
      "command": "npx",
      "args": ["-y", "vapi-network@latest", "mcp"]
    }
  }
}
```

If the vault is password-protected, open its session in your own terminal:

```bash
vapi vault unlock
```

The vault password does not go into the MCP configuration file or to the agent. For a non-terminal process, set `VAPI_VAULT_PASSWORD` in the client environment.

## Use a named account

Create a separate account for an agent and set its caps before you connect the agent:

```bash
vapi accounts add agent-claude --label "claude code"
vapi accounts caps agent-claude --per-day 5
```

Pin the MCP process to that account:

```json
{
  "mcpServers": {
    "vapi": {
      "command": "npx",
      "args": ["-y", "vapi-network@latest", "mcp", "--account", "agent-claude"],
      "env": {
        "VAPI_WALLET": "agent-claude",
        "VAPI_NO_SECRETS": "1"
      }
    }
  }
}
```

Spend caps belong to the account. The defaults are `$0.10` per call and `$1.00` per UTC day. `call.pay` applies the selected account's own caps before it signs. You can also pass `wallet` to a tool that accepts it. Without that input, the server uses the session account, then `VAPI_WALLET`, then the machine default.

`wallet.use` changes the account for this MCP process only. It does not change the default used by your terminal. Reads do not need a vault password. A payment opens the selected account for that payment.

## Tools

| Tool                      | Input                                                                                                                             | Result                                                                                                                                                                                                                |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs.search`             | `query`                                                                                                                           | Matching documentation excerpts with titles and URLs; works without a wallet                                                                                                                                          |
| `docs.read`               | `url`                                                                                                                             | One documentation page as Markdown; works without a wallet                                                                                                                                                            |
| `tasks.search`            | `open`, `minUsd`, `tab`, `limit`                                                                                                  | Task operation; availability depends on the Tasks backend.                                                                                                                                                            |
| `tasks.show`              | `id`, `wallet`                                                                                                                    | Task operation; availability depends on the Tasks backend.                                                                                                                                                            |
| `tasks.post`              | `wallet`, `title`, `brief`, `amountUsd`, `deadline`, `intake`, `maxAwards`, `webhookUrl`, `vendor`                                | Task operation; availability depends on the Tasks backend.                                                                                                                                                            |
| `tasks.propose`           | `id`, `wallet`, `priceUsd`, `duration`, `note`                                                                                    | Task operation; availability depends on the Tasks backend.                                                                                                                                                            |
| `tasks.submit`            | `id`, `wallet`, `proofUrls[]`, `files[]`                                                                                          | Task operation; availability depends on the Tasks backend.                                                                                                                                                            |
| `tasks.award`             | `id`, `wallet`, `proposalId`                                                                                                      | Task operation; availability depends on the Tasks backend.                                                                                                                                                            |
| `tasks.sign`              | `id`, `wallet`, `counterparty`, `wait`                                                                                            | Task operation; availability depends on the Tasks backend.                                                                                                                                                            |
| `tasks.fund`              | `id`, `wallet`, `counterparty`, `wait`                                                                                            | Task operation; availability depends on the Tasks backend.                                                                                                                                                            |
| `tasks.deliver`           | `id`, `wallet`, `files[]`, `note`, `counterparty`, `wait`                                                                         | Task operation; availability depends on the Tasks backend.                                                                                                                                                            |
| `tasks.release`           | `id`, `wallet`, `counterparty`, `wait`                                                                                            | Task operation; availability depends on the Tasks backend.                                                                                                                                                            |
| `tasks.refund`            | `id`, `wallet`, `counterparty`                                                                                                    | Task operation; availability depends on the Tasks backend.                                                                                                                                                            |
| `tasks.dispute`           | `id`, `wallet`, `evidenceHash`, `counterparty`                                                                                    | Task operation; availability depends on the Tasks backend.                                                                                                                                                            |
| `tasks.counter-evidence`  | `id`, `wallet`, `evidenceHash`, `counterparty`                                                                                    | Task operation; availability depends on the Tasks backend.                                                                                                                                                            |
| `tasks.resolve-unmatched` | `id`, `wallet`, `counterparty`                                                                                                    | Task operation; availability depends on the Tasks backend.                                                                                                                                                            |
| `tasks.message`           | `id`, `wallet`, `text`                                                                                                            | Task operation; availability depends on the Tasks backend.                                                                                                                                                            |
| `tasks.thread`            | `id`, `wallet`, `after`                                                                                                           | Task operation; availability depends on the Tasks backend.                                                                                                                                                            |
| `tasks.watch`             | `id`, `wallet`, `after`, `until`, `waitSeconds`                                                                                   | Task operation; availability depends on the Tasks backend.                                                                                                                                                            |
| `tasks.status`            | `id`, `wallet`                                                                                                                    | Task operation; availability depends on the Tasks backend.                                                                                                                                                            |
| `vapi.status`             | None                                                                                                                              | Status report with owner, vault, accounts, unfinished movements, and next commands                                                                                                                                    |
| `vapi.accounts`           | None                                                                                                                              | Local accounts with addresses, balances, Router usage, caps, ceilings, and link status                                                                                                                                |
| `vapi.siblings`           | `account`                                                                                                                         | The owner's linked accounts across devices, without keys, phrases, or tokens                                                                                                                                          |
| `accounts.add`            | `name`, `caps`, `routerAllowanceUsd`, `link`                                                                                      | Creates a derived account and returns trusted-device or owner-approval link status                                                                                                                                    |
| `accounts.caps`           | `name`, `perCallUsd`, `perDayUsd`, `ceilingUsd`                                                                                   | Lowers local spend caps or the ceiling; raising or disabling the ceiling stays in the terminal                                                                                                                        |
| `accounts.send`           | `from`, `to`, `amountUsd`, `network`                                                                                              | Relayed transfer status; an unknown result names the terminal resume command                                                                                                                                          |
| `auth.link`               | optional `label`, optional `account`                                                                                              | Starts linking this wallet to a person's vAPI account for browser approval with mcp:call, router.use, tasks:read and tasks:write; returns the code and URL                                                            |
| `auth.status`             | `wallet`                                                                                                                          | Link status, owner, label, permissions, Router-key presence, and any pending browser approval                                                                                                                         |
| `router.models`           | None                                                                                                                              | Model ids available from vAPI Router                                                                                                                                                                                  |
| `router.usage`            | `wallet`                                                                                                                          | Router usage plus the linked owner's stake and stake-funded Compute                                                                                                                                                   |
| `router.chat`             | `model`, `messages[]`, `max_tokens`, `wallet`                                                                                     | Completion `content`, resolved `model`, and token `usage`; the Router key stays in the vault's secret store and is never returned                                                                                     |
| `router.buy`              | `usd` (`1`, `5`, `20`, or `50`), `wallet`                                                                                         | Receipt summary and the new vAPI Router balance; the Router key stays in the vault's secret store and is never returned                                                                                               |
| `call.search`             | `query`, `kinds[]`, `network`, `limit`, `cursor`, `includeUnverified`, `includeOutage`                                            | One discovery page: `items` with `group`, `fee`, `verification`, optional `health` and `alternatives`, plus `nextCursor`, `unavailableKinds`, `rankingVersion`                                                        |
| `call.inspect`            | `id`, `endpoint`                                                                                                                  | A listing's `verification`, `fee`, `health`, `liveness`, `conformance`, identity, request contract, optional response schemas and example requests, and the registry's last observed quote (price, network and payee) |
| `call.pay`                | `wallet`, `id` or `url`, `method`, `endpoint`, `body`, `contentType`, `network`, `expectedPayTo`, `maxPriceUsd`, `timeoutSeconds` | `wallet`, `status`, `body`, `payment`, `verification` for a registry listing, and `expectedRequest` when a 402 named one                                                                                              |
| `call.read`               | `url`                                                                                                                             | Agent-run-only GET result from an origin paid during the run; never pays and redacts its SIWX proof                                                                                                                   |
| `wallet.address`          | `wallet`                                                                                                                          | `wallet`, `address`                                                                                                                                                                                                   |
| `wallet.balance`          | `wallet`                                                                                                                          | `wallet`, `address`, `balances[]` per configured network                                                                                                                                                              |
| `wallet.accounts`         | `wallet`                                                                                                                          | `wallet`, `accounts[]` with USDC, gas balance and deposit guidance                                                                                                                                                    |
| `wallet.list`             | None                                                                                                                              | `wallet`, `default`, and every wallet with caps in atomic USDC and dollars, balances, and `balanceError` when an RPC is unreachable                                                                                   |
| `wallet.use`              | `name`                                                                                                                            | `wallet`, `active`, `previous`, `scope: "session"`                                                                                                                                                                    |
| `wallet.fund`             | `wallet`, `amountUsd`                                                                                                             | `wallet`, `address`, `network`, `url`, `instructions`                                                                                                                                                                 |
| `receipts.list`           | `wallet`, `allWallets`, `limit`                                                                                                   | `wallet`, `receipts[]`                                                                                                                                                                                                |
| `receipts.stats`          | `wallet`, `allWallets`, `range`                                                                                                   | `wallet`, `range`, `generatedAt`, `totals`, `outcomes`, `latency`, `topServices`, `search`                                                                                                                            |
| `support.report`          | `message`, `includeAddresses`, `send`                                                                                             | `path`, `issueUrl`, the report itself, and `responseCode` when sent                                                                                                                                                   |
| `swarm.setup`             | `name`, `agents` or `roles[]`, `strategy`, `targetsUsd`, `caps`, `treasuryCaps`, `network`, `model`, `fundUsd`, `from`            | Swarm state, member setup status, link or caps next steps, and optional funding result                                                                                                                                |
| `swarm.add`               | `name`, `role`, `targetUsd`, `weight`                                                                                             | Updated swarm and member setup status                                                                                                                                                                                 |
| `swarm.leave`             | `name`, `member`                                                                                                                  | Member sweep and removal status                                                                                                                                                                                       |
| `swarm.fund`              | `name`, `amountUsd`, `from`                                                                                                       | Treasury funding result or owner funding instructions                                                                                                                                                                 |
| `swarm.rebalance`         | `name`, `targetsUsd`                                                                                                              | Movement, blocked legs, skipped members, and balance status                                                                                                                                                           |
| `swarm.status`            | `name`                                                                                                                            | Treasury, members, balances, links, allocation totals (allocated, swept out, and net per member), and open movements                                                                                                  |
| `swarm.dissolve`          | `name`                                                                                                                            | Member and treasury sweep results, then swarm removal status                                                                                                                                                          |
| `swarm.run`               | `name`, `task`, `mode`, `lead`, `budgetUsd`, `drawUsd`, `detach`                                                                  | Attached member results, or detached run ids and skipped members                                                                                                                                                      |
| `swarm.allocate`          | `amountUsd`, `reason`, `requestId`                                                                                                | Agent-only treasury allocation inside a swarm run; direct MCP calls are refused                                                                                                                                       |
| `swarm.delegate`          | `member`, `task`, `budgetUsd`, `requestId`                                                                                        | Agent-only one-level delegation inside a swarm run; direct MCP calls are refused                                                                                                                                      |
| `swarm.runs`              | `name`                                                                                                                            | Stored background runs with their latest runtime status                                                                                                                                                               |

`call.search` hides outage APIs by default; set `includeOutage: true` to include them. Results can name cheaper or healthier alternatives. In Claude Desktop, local `call.search` and `call.inspect` also show interactive MCP Apps results, with a text fallback when the view is unavailable.

`call.search` returns vAPI-verified listings and mirrored external catalogues by default. Set `includeUnverified` to `true` to add self-listed APIs that passed the automated x402 probe but were not reviewed. Inspect the request contract and stored quote before paying an unverified listing. `call.pay` fetches a fresh quote, so set an explicit `maxPriceUsd`. In client 0.14.0, Solana listings appear in search, but `call.inspect` and `call.pay` return `unsupported_network`.

`call.pay` accepts optional `timeoutSeconds`, an integer from 1 to 300. It sets the paid-response wait, capped at the offer's `maxTimeoutSeconds`. By default, the client uses the offer's timeout, with a minimum of 30 seconds and a maximum of 120 seconds. The unpaid 402 probe waits at most 30 seconds.

A spend-cap refusal uses `spend_cap_exceeded`, includes attempted and limit amounts, and is not retryable through MCP. Change the cap in your terminal only if you intend to allow the payment.

When a paid call has an uncertain outcome, `call.pay` returns `settlement_unknown` and tells you not to retry automatically. It names the receipt for `vapi pay --resume <receipt-id>`.

`call.read` works only inside an agent run. It sends a GET request to an HTTPS origin paid during that run, can use SIWX sign-in, and never pays. A direct MCP call is refused. Reflected SIWX headers and signatures are redacted from its result.

`swarm.allocate` and `swarm.delegate` are agent-only tools inside a swarm run. The first draws treasury capital for the current member. The second delegates one level of work with a hard budget. Direct MCP calls to either tool are refused.

`swarm.run` defaults to lead mode. Set `detach` to start local background work. MCP cannot export a member key.

## Link from Claude or Cursor

Claude, Cursor, or Codex can call `auth.link` with a `label`. The tool returns a code and URL. Open the console link at `https://api.vapinetwork.ai/link?code=...` in your browser, approve it from your ready vAPI account, and set the agent's daily vAPI Router allowance in USD. The code lasts 20 minutes.

`auth.status` reports the link, owner, label, permissions, Router-key presence, and any pending browser approval. `auth.link` requests `mcp:call`, `router.use`, `tasks:read` and `tasks:write`. The two Tasks permissions grant nothing usable until Tasks opens. To grant `call.publish`, run this command in your terminal:

```bash
vapi login --account agent-claude --publish
```

The Router key stays in the vault's secret store, and no tool returns it. After the link is approved, `router.chat` and `router.buy` work from the linked wallet.

See [Agents](/agents/) for the setup flow and [Owner and agents](/agents/control/owner-and-agents/) for the permissions model.

## Deprecated aliases

These pre-namespace names still work and behave like their replacements. Each result carries a one-line `DEPRECATED:` notice. They are scheduled for removal in a later release.

| Alias     | Use instead      |
| --------- | ---------------- |
| `search`  | `call.search`    |
| `inspect` | `call.inspect`   |
| `call`    | `call.pay`       |
| `wallet`  | `wallet.balance` |

## What the MCP server cannot do

The MCP server cannot rename, remove, restore, back up, or import an account, and it cannot export a key. It cannot cancel a movement or set `--replace-expired-restored`, `--bind-legacy-addresses`, or `--confirm-worker-stopped`. No tool returns a key, recovery phrase, passphrase, or token. Recovery and secret-export actions stay in the CLI, in front of a person.

The agent cannot reach secrets through MCP. The MCP package does not import the separate secrets entry point, and no MCP tool returns recovery data or key material.

Owner approval supports wallet, email and Google sign-in. Finish account setup and confirmed vAPI ID first.
An own-wallet account may require wallet proof; embedded email/Google owners can approve without external-wallet SIWE.

Task wait defaults to true. Watch defaults to after=0 and waitSeconds=25, bounded to 0–25 seconds.
Watch never releases escrow. Native ETH withdrawal has no MCP tool; use the terminal client.

## Next

- [Run your first agent](/agents/quickstart/)
- [Hosted MCP](/agents/in-your-ai-app/hosted-mcp/)
- [SDK](/reference/sdk/sdk/)

Checked on 2026-11-17.
