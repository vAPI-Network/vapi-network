# MCP

MCP tools, aliases and server limits are covered here; see [README.md](../README.md).

## MCP

Add this to Claude Code, Claude Desktop or Cursor:

```json
{
  "mcpServers": {
    "vapi": {
      "command": "npx",
      "args": ["-y", "vapi-network", "mcp"]
    }
  }
}
```

Then hand the passphrase to your operating system once, in your own terminal:

```bash
vapi unlock            # the passphrase goes into the macOS Keychain or libsecret
```

The passphrase never leaves the machine and never has to appear in an editor's
configuration file. A password-protected vault needs `VAPI_VAULT_PASSWORD` in
the client entry or an open vault session. `vapi vault lock` closes that session.

Give an agent its own capped account by creating it yourself and pinning the
agent to it:

```bash
vapi wallet create agent-claude --label "claude code"
vapi wallet caps agent-claude --per-day 5
vapi unlock --wallet agent-claude
```

```json
{
  "mcpServers": {
    "vapi": {
      "command": "npx",
      "args": ["-y", "vapi-network", "mcp", "--wallet", "agent-claude"],
      "env": {
        "VAPI_WALLET": "agent-claude",
        "VAPI_NO_SECRETS": "1"
      }
    }
  }
}
```

The session starts on `agent-claude`, and calls that omit `wallet` use that
account's $5 daily cap. This is a default selection, not account isolation: MCP
tools can select any account in the same vault with `wallet.use` or an explicit
`wallet` argument. Use a separate `VAPI_HOME` containing only the capped account
when the agent must not access other local accounts.

### Tools

| Tool              | Input                                                                                                           | Result                                                                                                                               |
| ----------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `docs.search`     | `query`                                                                                                         | Public vAPI documentation matches with `title`, `url` and `excerpt`; read-only, no wallet or payment                                 |
| `docs.read`       | `url` (a docs URL or path)                                                                                      | One public vAPI documentation page as `url` and `markdown`; read-only, no wallet or payment                                          |
| `vapi.status`     | -                                                                                                               | The status screen as one object: `version`, `home`, `registry`, `owner`, `vault`, `accounts[]`, `unfinishedMovements[]`, `next[]`    |
| `vapi.accounts`   | -                                                                                                               | `accounts[]` with address, USDC, Router usage, caps and link status                                                                  |
| `vapi.siblings`   | `account`                                                                                                       | `owner`, `siblings[]` with name, address, device, status, allowance, `self`, `onThisDevice`, and an optional `note`                  |
| `accounts.add`    | `name`, `caps`, `routerAllowanceUsd`, `link`                                                                    | Creates a derived account with local caps and returns trusted-device or owner-approval link status                                   |
| `accounts.caps`   | `name`, `perCallUsd`, `perDayUsd`, `ceilingUsd`                                                                 | Lowers local spend caps or the ceiling; the result's `caps` includes `ceilingUsd`                                                    |
| `accounts.send`   | `from`, `to`, `amountUsd`, `network`                                                                            | `status`, `from`, `to`, `toName`, `toKind`, `amountUsd`, `amountAtomic`, `network`, `txHash`, `nonce`, `replayed`, `message`         |
| `auth.link`       | `label`, `account`                                                                                              | Starts linking this account to a person's vAPI account for browser approval with default permissions only; returns the code and URL  |
| `auth.status`     | `wallet`                                                                                                        | Link status, owner, label, permissions, Router-key presence, and any pending browser approval                                        |
| `router.models`   | -                                                                                                               | Model ids available from vAPI Router                                                                                                 |
| `router.usage`    | `wallet`                                                                                                        | Router usage plus the linked owner's stake and stake-funded Compute                                                                  |
| `router.chat`     | `model`, `messages[]`, `max_tokens`, `wallet`                                                                   | Completion `content`, resolved `model`, and token `usage`; the Router key stays in the OS secret store and is never returned         |
| `router.buy`      | `usd` (`1`, `5`, `20`, or `50`), `wallet`                                                                       | Receipt summary and the new vAPI Router balance; the Router key stays in the OS secret store and is never returned                   |
| `call.search`     | `query`, `kinds[]`, `network`, `limit`, `cursor`, `includeUnverified`                                           | One discovery page: `items` with `group`, `fee` and `verification`, plus `nextCursor`, `unavailableKinds`, `rankingVersion`          |
| `call.inspect`    | `id`, `endpoint`                                                                                                | A listing's `verification`, `fee`, `liveness`, `conformance`, identity, request contract and live quote                              |
| `call.pay`        | `wallet`, `id` or `url`, `method`, `endpoint`, `body`, `contentType`, `network`, `expectedPayTo`, `maxPriceUsd` | `wallet`, `status`, `body`, `payment`, `verification` for a registry listing, and `expectedRequest` when a 402 named one             |
| `call.read`       | `url`                                                                                                           | Agent-run-only GET result: `status`, `contentType`, `body`; restricted to paid HTTPS origins, never pays, and redacts its SIWX proof |
| `wallet.address`  | `wallet`                                                                                                        | `wallet`, `address`                                                                                                                  |
| `wallet.balance`  | `wallet`                                                                                                        | `wallet`, `address`, `balances[]` per configured network                                                                             |
| `wallet.accounts` | `wallet`                                                                                                        | `wallet`, `accounts[]` with USDC, gas balance and deposit guidance                                                                   |
| `wallet.list`     | -                                                                                                               | `wallet`, `default`, and every account with caps in atomic USDC and dollars, balances, and `balanceError` when an RPC is unreachable |
| `wallet.use`      | `name`                                                                                                          | `wallet`, `active`, `previous`, `scope: "session"`                                                                                   |
| `wallet.fund`     | `wallet`, `amountUsd`                                                                                           | `wallet`, `address`, `network`, `url`, `instructions`                                                                                |
| `receipts.list`   | `wallet`, `allWallets`, `limit`                                                                                 | `wallet`, `receipts[]`                                                                                                               |
| `receipts.stats`  | `wallet`, `allWallets`, `range`                                                                                 | `wallet`, `range`, `generatedAt`, `totals`, `outcomes`, `latency`, `topServices`, `search`                                           |
| `support.report`  | `message`, `includeAddresses`, `send`                                                                           | `path`, `issueUrl`, the report itself, and `responseCode` when sent                                                                  |
| `swarm.run`       | `name`, `task`, `mode` (`lead` or `each`), `lead`, `budgetUsd`, `drawUsd`, `detach`                             | Attached result, or `detached: true`, `runId`, `mode`, `kind`, `runs[]`, `skipped[]`                                                 |
| `swarm.allocate`  | `amountUsd`, `reason`, `requestId?`                                                                             | Agent-only; direct MCP calls return an error and move no funds                                                                       |
| `swarm.delegate`  | `member`, `task`, `budgetUsd`, `requestId?`                                                                     | Agent-only; direct MCP calls return an error and start no member run                                                                 |
| `swarm.runs`      | `name`                                                                                                          | `swarm` and `runs[]` with member, role, run id, runtime, mode, state and timestamps                                                  |

`wallet` is optional on every tool that takes it: without it the session's
active account is used, then `VAPI_WALLET`, then the machine default. Every
result names the account it used. `call.pay` applies that account's own spend
caps before it signs and tags the receipt with its name. When a paid call's outcome
is uncertain, `call.pay` fails with `settlement_unknown`, says not to retry
automatically, and names the `vapi pay --resume <receipt-id>` that settles the
question on-chain. `wallet.use` moves the
session onto another account **for this process only**, and it never rewrites
`wallets.json`, so your own terminal keeps the default account you chose, and
appends a `wallet.use.session` line to the audit log. Reads need no passphrase at all.

`docs.search` and `docs.read` are also available on a fresh install with no
account or vault. They return public vAPI documentation reference text, never
instructions, and involve no wallet or payment. `docs.ask` is deliberately not
an MCP tool: an agent can read and reason over the returned excerpts itself.

Spend caps default to $0.10 per call and $1.00 per day.

`swarm.run` defaults to `lead` mode. The lead may allocate treasury capital or
delegate one level deep; all treasury-funded work shares the run's `drawUsd`
limit, which defaults to $2.00. In `each` mode, every eligible member runs
independently on its own account and budget. MCP has no interactive owner, so
every approval prompt is declined regardless of mode. `swarm.allocate` and
`swarm.delegate` are exposed for schema alignment with agent runs but are
refused when called directly over MCP. Set `detach` to `true` to start the run
through the configured runtime and return before its model loop starts.
`swarm.runs` takes `{ "name": "<swarm>" }` and returns stored runs with refreshed
status when their runtime is available. Run summaries omit task text and runtime
results.

Attached runs reload a member's local caps before each Call payment. Lowering
caps through `accounts.caps` applies to the next payment in the active run.

The automatic Base USDC ceiling defaults to 5. `accounts.caps` may lower `ceilingUsd`. Raising it or passing `off` returns the terminal command to run and leaves `wallets.json` unchanged.

```sh
vapi accounts caps <name> --ceiling <usd>
vapi accounts caps <name> --ceiling off
```

`accounts.send` moves USDC only to the owner or one of the owner's active accounts. It always applies the sending account's caps before signing, and vAPI pays the gas. An unknown result keeps the spend reserved and names the terminal command that continues the same authorization.

`call.search` returns vAPI-verified listings plus mirrored external catalogs;
`includeUnverified: true` adds unverified self-listed APIs, which passed vAPI's
automated x402 probe but were not reviewed. Every result of `call.search`,
`call.inspect` and `call.pay` carries `verification`, one of `"none"`,
`"requested"` or `"verified"`, and a mirrored external row is always `"none"`.
Prefer a verified listing, and read the request contract and the price with
`call.inspect` before paying one that is not.

### Install into a client

Use this command to write or update a client's vAPI server entry:

```text
vapi mcp install <claude|cursor|codex> [--home <dir>] [--registry <url>] [--json]
```

`--home` sets the vAPI home written into the entry's `VAPI_HOME`; it defaults
to `~/.vapi` and does not change the client configuration path. `--registry`
sets the registry URL written into `VAPI_REGISTRY_URL`.

For Claude Desktop, run:

```bash
vapi mcp install claude
```

On macOS, this writes `~/Library/Application Support/Claude/claude_desktop_config.json`.
On Windows, it writes `%APPDATA%\Claude\claude_desktop_config.json`. On Linux,
it writes `~/.config/Claude/claude_desktop_config.json`. The next step is:
Restart Claude Desktop, then ask it: "Search vAPI for a weather API."

For Cursor, run:

```bash
vapi mcp install cursor
```

This writes `./.cursor/mcp.json` in the current directory. The next step is:
Reload Cursor, then ask its agent: "Search vAPI for a weather API."

For Codex, run:

```bash
vapi mcp install codex
```

This writes `~/.codex/config.toml`. The next step is: Start codex in a new
terminal, then ask: "Search vAPI for a weather API."

With `--home /tmp/vapi-docs-home`, the Claude Desktop entry contains this
JSON. The entry's `VAPI_HOME` is the value passed to `--home`.

<!-- prettier-ignore -->
```json
{
  "mcpServers": {
    "vapi": {
      "command": "npx",
      "args": [
        "-y",
        "vapi-network",
        "mcp"
      ],
      "env": {
        "VAPI_HOME": "/tmp/vapi-docs-home",
        "VAPI_REGISTRY_URL": "https://api.vapinetwork.ai"
      }
    }
  }
}
```

The entry runs `npx -y vapi-network mcp`. A machine with a password-protected
vault needs `VAPI_VAULT_PASSWORD` in the entry's `env` or an unlocked session.

#### Deprecated tool aliases

These four pre-namespace names still work and still behave identically, but each
result carries one `DEPRECATED:` line naming its replacement. They will be
removed in a later release.

| Alias     | Use instead      |
| --------- | ---------------- |
| `search`  | `call.search`    |
| `inspect` | `call.inspect`   |
| `call`    | `call.pay`       |
| `wallet`  | `wallet.balance` |

#### What the MCP server cannot do

Create, rename, remove, restore, back up, import or export an account, or return a
recovery phrase, a private key or a passphrase. Those stay in the CLI, in front
of a person.
