---
title: "CLI reference"
description: "The vapi CLI reference documents commands, options, environment variables, and exit codes for local wallets and API payments."
order: 2
---

> [!NOTE]
> Call, Router, Stake and Agents are live. Tasks is coming soon.

This page is for developers and operators who need every `vapi` command, option, environment variable, and exit code.

This reference covers released client 0.14.0.

The CLI manages vault accounts, moves USDC and withdraws native Base ETH, pays x402 APIs, runs agents and swarms, and publishes APIs. New users can start with the [Overview Quickstart](/quickstart/).

```bash
npm i -g vapi-network
vapi init
```

Clients ≤ 0.9.0 fail every search whose results include a Solana row. Update with `npm i -g vapi-network@latest`.

The CLI prints one line on stderr when a newer `vapi-network` release is published. It checks at most once a day. It skips the notice with `--json`, in CI, inside `vapi mcp`, or when `VAPI_NO_UPDATE_CHECK=1`.

Most commands use `--json` for structured output. Receipt exports use `--format json` or `--format csv`. Exit codes are `0` for success, `1` for an operational failure, and `2` for invalid usage. `vapi mcp --json` is accepted as a no-op because the stdio transport is already JSON-RPC.

## Setup

### `vapi init`

Creates `~/.vapi`, the vault account `main`, and the config. Says so if one exists. In an interactive terminal it then offers to link the wallet to your vAPI dashboard: press Enter to start [`vapi login`](/reference/cli/cli-reference/#vapi-login), or answer `n` to skip. JSON and non-interactive runs never prompt; they print a `vapi login` hint, and JSON results add `linked: false` with a `next` link step. A failed link never fails the command.

| Option                  | What it does                    | Default                                  |
| ----------------------- | ------------------------------- | ---------------------------------------- |
| `--networks <base,arc>` | Enables the listed networks.    | Base                                     |
| `--no-link`             | Skips the dashboard link offer. | Offers a link in an interactive terminal |

```bash
vapi init --networks base,arc
```

### `vapi setup`

Creates or completes the device vault, first account, and owner link

| Option              | What it does                              | Default                       |
| ------------------- | ----------------------------------------- | ----------------------------- |
| `--accounts <n>`    | Sets the setup account count.             | No fixed default established  |
| `--no-cloud-backup` | Skips the interactive cloud-backup offer. | Offers enrollment after setup |

```bash
vapi setup --no-cloud-backup
```

Owner linking opens the browser account journey at /link. Wallet, email and Google owners must finish setup and confirmed ID.
The console owner account is separate from the local agent wallet. Own-wallet actions may require wallet proof.
Use [Start with your agent](/start-with-your-agent/) for the maintained setup handoff.

### `vapi fund`

Prints and opens the hosted funding page. Makes no network call.

| Option             | What it does                                     | Default                                                  |
| ------------------ | ------------------------------------------------ | -------------------------------------------------------- |
| `--amount <usd>`   | Prefills a US dollar amount on the funding page. | Not stated in the source                                 |
| `--account <name>` | Selects the account to fund.                     | `VAPI_WALLET`, then the default from `vapi accounts use` |

```bash
vapi fund --amount 25 --account main
```

### `vapi accounts`

Lists local vault accounts, balances, links, caps, and ceilings

| Option  | What it does                                                  | Default             |
| ------- | ------------------------------------------------------------- | ------------------- |
| `--all` | Adds the owner's accounts on other devices as read-only rows. | Local accounts only |

```bash
vapi accounts --all
```

## Accounts and transfers

### `vapi accounts add <name>`

Adds a derived account and starts its owner link

| Option           | What it does                                 | Default                  |
| ---------------- | -------------------------------------------- | ------------------------ |
| `--label <text>` | Sets the account label.                      | Not stated in the source |
| `--no-link`      | Creates the account without starting a link. | Starts a link            |

```bash
vapi accounts add researcher --label "research agent"
```

### `vapi accounts import <name>`

Imports one private key as a vault account

| Option              | What it does                        | Default                   |
| ------------------- | ----------------------------------- | ------------------------- |
| `--keystore <path>` | Reads an encrypted legacy keystore. | Prompts for a private key |
| `--key-file <path>` | Reads the private key from a file.  | Prompts for a private key |
| `--label <text>`    | Sets the account label.             | Not stated in the source  |

```bash
vapi accounts import legacy --keystore ./legacy.json
```

### `vapi accounts rename|use|remove|restore`

Renames an account, selects the default, moves an account to trash, or restores it

| Command or option                  | What it does                                             | Default                      |
| ---------------------------------- | -------------------------------------------------------- | ---------------------------- |
| `vapi accounts rename <old> <new>` | Renames the account and its local references.            | Not applicable               |
| `vapi accounts use <name>`         | Makes the account the default.                           | Not applicable               |
| `vapi accounts remove <name>`      | Removes the account after terminal confirmation.         | Refuses without confirmation |
| `--force`                          | Removes the named account without terminal confirmation. | Off                          |
| `vapi accounts restore <name>`     | Restores a removed account.                              | Not applicable               |

```bash
vapi accounts rename old-name new-name
vapi accounts use researcher
vapi accounts remove retired-account --force
vapi accounts restore retired-account
```

### `vapi accounts caps <name>`

Sets local spend caps and the automatic Base USDC ceiling

| Option                 | What it does                                           | Default                 |
| ---------------------- | ------------------------------------------------------ | ----------------------- |
| `--per-call <usd>`     | Sets the maximum for one paid call or capped transfer. | Keeps the current value |
| `--per-day <usd>`      | Sets the UTC-day spending maximum.                     | Keeps the current value |
| `--ceiling <usd\|off>` | Sets or disables the automatic Base USDC ceiling.      | Keeps the current value |

```bash
vapi accounts caps researcher --per-call 0.05 --per-day 1 --ceiling 5
```

### `vapi send <amount>`

Moves USDC to the owner or another active owner account through the gas-paid relay

| Option                       | What it does                                           | Default           |
| ---------------------------- | ------------------------------------------------------ | ----------------- |
| `--from <account>`           | Selects the sending account. Required.                 | None              |
| `--to <account\|owner\|0x…>` | Selects the recipient. Required.                       | None              |
| `--network <base\|arc>`      | Selects the transfer network.                          | `base`            |
| `--resume <nonce>`           | Reuses an authorization after an unknown relay result. | Starts a transfer |

```bash
vapi send 2 --from research --to writer
```

### `vapi accounts distribute`

Plans, journals, and runs a multi-account distribution

| Option                       | What it does                                                                                                 | Default                            |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------- |
| `<amount>`                   | Sets the total USDC amount to distribute.                                                                    | Required for a new plan            |
| `--from <account>`           | Selects the sender.                                                                                          | Required for a new plan            |
| `--to <a,b,c>`               | Selects local linked active recipients.                                                                      | Every other eligible local account |
| `--network <base\|arc>`      | Selects the transfer network.                                                                                | `base`                             |
| `--resume <movement-id>`     | Continues unfinished legs with their recorded nonces.                                                        | Starts a plan                      |
| `--cancel <movement-id>`     | Cancels eligible unsent legs without signing. Terminal only and unavailable through MCP.                     | Not applicable                     |
| `--replace-expired-restored` | Allows reviewed restored legs to be replaced or cancelled. Requires `--resume` or `--cancel`; terminal only. | Refuses unproven restored legs     |
| `--bind-legacy-addresses`    | Binds reviewed addresses on an unsigned pre-0.8 leg. Requires `--resume`; terminal only.                     | Refuses an unbound legacy leg      |

```bash
vapi accounts distribute 10 --from main --to research,writer
vapi accounts distribute --resume <movement-id>
vapi accounts distribute --cancel <movement-id>
```

## Legacy wallet aliases

The `vapi wallet` commands are compatibility aliases for account commands. Use `vapi accounts` and `--account <name>` in new scripts.

| Legacy command                   | Current command                                                                      |
| -------------------------------- | ------------------------------------------------------------------------------------ |
| `vapi wallet list`               | `vapi accounts`                                                                      |
| `vapi wallet create <name>`      | `vapi accounts add <name>`, then the dashboard link offer (skip it with `--no-link`) |
| `vapi wallet use <name>`         | `vapi accounts use <name>`                                                           |
| `vapi wallet rename <old> <new>` | `vapi accounts rename <old> <new>`                                                   |
| `vapi wallet remove <name>`      | `vapi accounts remove <name>`                                                        |
| `vapi wallet restore <name>`     | `vapi accounts restore <name>`                                                       |
| `vapi wallet caps <name>`        | `vapi accounts caps <name>`                                                          |

### `vapi balance`

The selected account's address and USDC balances

| Option             | What it does                    | Default                                                  |
| ------------------ | ------------------------------- | -------------------------------------------------------- |
| `--account <name>` | Selects the account to inspect. | `VAPI_WALLET`, then the default from `vapi accounts use` |

```bash
vapi balance --account main
```

## Discovery

### `vapi search [query]`

Searches the registry's marketplace discovery feed, including mirrored external listings

| Option                 | What it does                                                                               | Default                  |
| ---------------------- | ------------------------------------------------------------------------------------------ | ------------------------ |
| `--kind <kind>`        | Filters by kind and can be repeated.                                                       | Not stated in the README |
| `--network <caip2>`    | Filters by CAIP-2 network identifier.                                                      | Not stated in the README |
| `--limit <n>`          | Limits the number of results.                                                              | Not stated in the README |
| `--cursor <cursor>`    | Continues from a discovery cursor.                                                         | Not stated in the README |
| `--include-unverified` | Includes self-listed APIs that passed the automated x402 probe but have not been reviewed. | Excluded                 |
| `--include-outage`     | Includes APIs hidden by the registry's default outage filter.                              | Excluded                 |

```bash
vapi search "weather" --include-unverified
```

Search output shows health and cheaper or healthier alternatives when the registry supplies them. JSON search, inspect, and payment results can include next-action hints.

### `vapi inspect <id>`

Returns verification, fee, health, liveness, conformance, identity, request contract, optional response schemas and example requests, and the registry's last observed quote (price, network and payee), for free.

`inspect` does not fetch a fresh provider quote. `pay` fetches it when you pay, so set an explicit maximum price with `--max`. Solana listings return `unsupported_network` in client 0.14.0.

| Option              | What it does                        | Default                  |
| ------------------- | ----------------------------------- | ------------------------ |
| `--endpoint <name>` | Selects an endpoint on the listing. | Not stated in the README |

```bash
vapi inspect weather-call --endpoint forecast
```

### `vapi check <url>`

Grades its 402, extensions and same-origin discovery. Never pays

| Option              | What it does                                | Default |
| ------------------- | ------------------------------------------- | ------- |
| `--method <method>` | Sends the check with the given HTTP method. | GET     |

```bash
vapi check https://weather.example/forecast --method GET
```

## Read documentation

The docs commands need no account, wallet, or payment. `vapi docs` asks the documentation assistant; `search` returns excerpts and `read` returns one Markdown page. All three accept `--json`.

```bash
vapi docs "How do Router keys work?"
vapi docs search "Router keys"
vapi docs read https://docs.vapinetwork.ai/router/access-and-keys
```

## Paying

### `vapi pay <id-or-url>`

Calls the API and pays it from the local wallet, naming an unverified tier

| Option                        | What it does                                                                                                | Default                                                                        |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `--method <method>`           | Sets the HTTP method for the request.                                                                       | Not stated in the README                                                       |
| `--endpoint <name>`           | Selects an endpoint on the listing.                                                                         | Not stated in the README                                                       |
| `--body <json>`               | Sends a JSON request body.                                                                                  | Not stated in the README                                                       |
| `--content-type <type>`       | Sets the request content type.                                                                              | Not stated in the README                                                       |
| `--network <caip2>`           | Selects the payment network.                                                                                | Not stated in the README                                                       |
| `--expected-pay-to <address>` | Checks the expected payment recipient.                                                                      | Not stated in the README                                                       |
| `--max <amount>`              | Sets the maximum for this call in US dollars.                                                               | Not stated in the README                                                       |
| `--timeout <seconds>`         | Sets the paid-response wait to an integer from 1 to 300 seconds, capped at the offer's `maxTimeoutSeconds`. | The offer's timeout, with a minimum of 30 seconds and a maximum of 120 seconds |
| `--max-price-usd`             | Acts as a long-standing alias for `--max`; the two cannot be combined.                                      | Not stated in the README                                                       |
| `--account <name>`            | Selects the wallet that pays.                                                                               | `VAPI_WALLET`, then the default from `vapi accounts use`                       |

```bash
vapi pay <id-or-url> --max <usd> [--timeout <seconds>]
vapi pay weather-call --endpoint forecast --max 0.02 --account main
```

API payment spend-cap refusals use `spend_cap_exceeded` with attempted and limit amounts. The refusal happens before signing.

The unpaid 402 probe waits at most 30 seconds. If the paid response times out, the client reports `settlement_unknown`. Run `vapi pay --resume <receipt-id>` to see whether it settled.

Every payment payload carries the client code `vapi` in the x402 `builder-code` extension. When the API advertises `payment-identifier`, vAPI generates one ID, sends it with the payment, records it as `paymentId` on the receipt, and shows it again in `vapi pay --resume`.

### `vapi pay --resume <receipt-id>`

Checks settlement, shows its payment id, and never pays

This command has no command-specific options.

```bash
vapi pay --resume receipt-123
```

This command asks the token contract on the receipt's network whether the signed EIP-3009 authorization was used. Settled means the payment went through, so do not pay again. Expired means it was never used and can no longer be used, so paying again is safe. Pending means it is unused but still valid, so wait until the printed time. The command unlocks no wallet and signs nothing. It supports EVM receipts; a Solana receipt or a receipt from before 0.4.0 says why it cannot check.

## Receipts and stats

### `vapi receipts`

The local append-only call ledger, newest last

| Option             | What it does                         | Default                                                  |
| ------------------ | ------------------------------------ | -------------------------------------------------------- |
| `--limit <n>`      | Limits the number of receipts.       | All matching retained receipts                           |
| `--account <name>` | Selects the wallet's receipts.       | `VAPI_WALLET`, then the default from `vapi accounts use` |
| `--all-wallets`    | Includes receipts from every wallet. | Off                                                      |

```bash
vapi receipts --account main --limit 20
```

### `vapi receipts export`

Raw receipts for a spreadsheet or dashboard

| Option                   | What it does                         | Default                                                  |
| ------------------------ | ------------------------------------ | -------------------------------------------------------- |
| `--format <json\|csv>`   | Selects JSON or CSV output.          | Not stated in the README                                 |
| `--range <24h\|7d\|30d>` | Selects the time range.              | All retained receipts                                    |
| `--account <name>`       | Selects the wallet's receipts.       | `VAPI_WALLET`, then the default from `vapi accounts use` |
| `--all-wallets`          | Includes receipts from every wallet. | Off                                                      |

```bash
vapi receipts export --format csv --range 7d --account main
```

### `vapi stats`

Spend, outcomes, latency percentiles and top services

| Option                   | What it does                      | Default                                                  |
| ------------------------ | --------------------------------- | -------------------------------------------------------- |
| `--range <24h\|7d\|30d>` | Selects the time range.           | 24h                                                      |
| `--account <name>`       | Selects the wallet's stats.       | `VAPI_WALLET`, then the default from `vapi accounts use` |
| `--all-wallets`          | Includes stats from every wallet. | Not stated in the README                                 |

```bash
vapi stats --range 24h --account main
```

## Agents

Agents hold rights on your account, never on your wallet. See [Agents](/agents/).

### `vapi login`

Links the local agent wallet to your vAPI account

| Option             | What it does                                       | Default                                                  |
| ------------------ | -------------------------------------------------- | -------------------------------------------------------- |
| `--account <name>` | Selects the local agent wallet to link.            | `VAPI_WALLET`, then the default from `vapi accounts use` |
| `--label <name>`   | Sets the agent label shown to the owner.           | Not stated in the README                                 |
| `--publish`        | Requests permission to publish on vAPI Call.       | Not requested                                            |
| `--no-browser`     | Prints the approval URL without opening a browser. | Browser opens on a terminal                              |

```bash
vapi login --account agent --label researcher
```

One owner can link at most 50 agents. On a device you trusted on `/link`, later links complete without the browser step.

### `vapi dashboard`

Opens the console's **My agents** page for the selected account and prints its URL. When the account is not linked yet, it says so and offers the link first, with the same rules as `vapi init`.

| Option             | What it does                                  | Default                                                  |
| ------------------ | --------------------------------------------- | -------------------------------------------------------- |
| `--account <name>` | Selects the account.                          | `VAPI_WALLET`, then the default from `vapi accounts use` |
| `--no-browser`     | Prints the URL without opening a browser.     | Browser opens on a terminal                              |
| `--no-link`        | Skips the link offer for an unlinked account. | Offers a link in an interactive terminal                 |
| `--json`           | Prints `{ account, url, linked, opened }`.    | Human output                                             |

```bash
vapi dashboard --account researcher
```

### `vapi logout`

Removes the selected wallet's agent link and stored credentials

| Option             | What it does                   | Default                                                  |
| ------------------ | ------------------------------ | -------------------------------------------------------- |
| `--account <name>` | Selects the wallet to log out. | `VAPI_WALLET`, then the default from `vapi accounts use` |

```bash
vapi logout --account agent
```

### `vapi whoami`

Shows the chosen wallet's owner link and permissions, whether the link is live, and its ERC-8004 agent identity.

| Option             | What it does                    | Default                                                  |
| ------------------ | ------------------------------- | -------------------------------------------------------- |
| `--account <name>` | Selects the wallet to identify. | `VAPI_WALLET`, then the default from `vapi accounts use` |

```bash
vapi whoami --account agent
```

### `vapi agent create <name>`

Creates a capped local agent wallet, profile and owner link

The instructions file can contain at most 20,000 characters.

| Option                  | What it does                                                     | Default                |
| ----------------------- | ---------------------------------------------------------------- | ---------------------- |
| `--model <id>`          | Selects the vAPI Router model.                                   | Required               |
| `--instructions <file>` | Reads the agent instructions from a file.                        | Required               |
| `--call-budget <usd>`   | Sets the wallet's daily spend cap.                               | `$1`                   |
| `--max-per-call <usd>`  | Sets the maximum for one paid call.                              | `$0.05`                |
| `--router-budget <usd>` | Suggests the agent's daily Compute allowance for owner approval. | `$1`                   |
| `--approve-above <usd>` | Asks for approval above this price.                              | `$0.50`                |
| `--include-unverified`  | Allows unverified listings.                                      | Verified listings only |
| `--max-steps <n>`       | Sets the maximum number of model steps.                          | `12`                   |

```bash
vapi agent create researcher --model <id> --instructions ./researcher.md
```

### `vapi agent run`

Runs the named agent, or one bundled member in headless mode.

| Option                    | What it does                                                                         | Default                             |
| ------------------------- | ------------------------------------------------------------------------------------ | ----------------------------------- |
| `--budget <usd>`          | Sets one hard limit across Call payments and Router top-ups.                         | The account's remaining per-day cap |
| `--detach`                | Starts the run in the local background runtime.                                      | Runs attached                       |
| `--runtime local`         | Selects the local background runtime. Requires `--detach`.                           | `local`                             |
| `--result-file <path>`    | Writes the final JSON result. Cannot be combined with `--detach`.                    | Does not write a result file        |
| `--bundle-env <VAR>`      | Selects the separate headless form and runs one bundled member in an ephemeral home. | Normal named-account form           |
| `--task-base64url <text>` | Supplies the headless task as base64url text. Requires `--bundle-env`.               | Direct task argument                |

```bash
vapi agent run researcher "Compare today's weather forecasts"
vapi agent run researcher "Compare today's weather forecasts" --budget 0.50
vapi agent run researcher "Compare today's weather forecasts" --detach
vapi agent run --bundle-env <VAR> "<task>" --result-file <path>
```

### `vapi agent list`

Lists profiles, links and today's Call and Router budgets

This command has no command-specific options.

```bash
vapi agent list
```

### `vapi agent pause <name>`

Stops future runs until the agent is resumed

This command has no command-specific options.

```bash
vapi agent pause researcher
```

### `vapi agent resume <name>`

Allows a paused agent to run again

This command has no command-specific options.

```bash
vapi agent resume researcher
```

### `vapi agent revoke <name>`

Revokes the link and removes the profile, but keeps its wallet

This command has no command-specific options.

```bash
vapi agent revoke researcher
```

## Swarms

See [Swarms](/agents/control/swarms/) for the treasury and member model.

### `vapi swarm create <name>`

Creates or resumes a treasury, members, caps, profiles, links, and optional funding

| Option                                | What it does                                                                        | Default                  |
| ------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------ |
| `--agents <n>`                        | Creates the requested number of generated roles. Cannot be combined with `--roles`. | Two members              |
| `--roles <a,b,c>`                     | Sets ordered member roles. Cannot be combined with `--agents`.                      | Generated roles          |
| `--fund <usd>`                        | Funds the treasury during setup. Requires `--from`.                                 | No funding transfer      |
| `--from <account>`                    | Selects the linked funding account. Requires `--fund`.                              | None                     |
| `--strategy <targets\|even\|weights>` | Selects the allocation strategy.                                                    | `targets`                |
| `--targets <role=usd,...>`            | Sets role targets for the targets strategy.                                         | Strategy defaults        |
| `--caps <perCall>/<perDay>`           | Sets member caps.                                                                   | `$0.10/$1`               |
| `--treasury-caps <perCall>/<perDay>`  | Sets treasury movement caps.                                                        | `$5/$20`                 |
| `--network <base\|arc>`               | Sets the swarm network.                                                             | `base`                   |
| `--model <id>`                        | Sets the model for new member profiles.                                             | `venice/claude-sonnet-5` |
| `--no-wait`                           | Returns without waiting for owner link approvals.                                   | Waits for approvals      |

```bash
vapi swarm create research --roles lead,helper --fund 5 --from main
```

### `vapi swarm add|remove|fund|rebalance|status|dissolve`

Manages swarm membership and capital

| Command                                                  | What it does                                                                  |
| -------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `vapi swarm add <name> <role>`                           | Adds or resumes one member.                                                   |
| `vapi swarm remove <name> <member>`                      | Sweeps a member to the treasury and removes its membership.                   |
| `vapi swarm fund <name> <usd> [--from <account>]`        | Funds the treasury or prints owner funding instructions.                      |
| `vapi swarm rebalance <name> [--targets <role=usd,...>]` | Moves funds between the treasury and members.                                 |
| `vapi swarm status <name>`                               | Shows balances, links, allocation history, open movements, and detached runs. |
| `vapi swarm dissolve <name>`                             | Sweeps capital and removes the swarm file.                                    |

```bash
vapi swarm add research helper
vapi swarm remove research helper
vapi swarm fund research 5 --from main
vapi swarm rebalance research --targets lead=2,helper=1
vapi swarm status research
vapi swarm dissolve research
```

### `vapi swarm run <name> "<task>"`

Runs the lead or each eligible member

| Option                     | What it does                                                               | Default                      |
| -------------------------- | -------------------------------------------------------------------------- | ---------------------------- |
| `--mode <lead\|each>`      | Runs the lead or every eligible member independently.                      | `lead`                       |
| `--lead <member>`          | Selects the lead account in lead mode.                                     | Swarm lead                   |
| `--budget <usd>`           | Sets each member's hard Call-and-Router budget.                            | Remaining per-day cap        |
| `--draw <usd>`             | Sets the shared treasury draw limit.                                       | `$2.00`                      |
| `--detach`                 | Starts background work.                                                    | Runs attached                |
| `--runtime local\|railway` | Selects the execution runtime.                                             | `local`                      |
| `--result-file <path>`     | Writes the attached final JSON result. Cannot be combined with `--detach`. | Does not write a result file |

```bash
vapi swarm run research "Compare three weather APIs" --mode each --budget 0.50
```

### `vapi swarm runs|stop`

Lists or stops detached work

| Command or option                | What it does                                                                                                       |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `vapi swarm runs <name>`         | Lists stored run status for the swarm.                                                                             |
| `vapi swarm stop <name> <runId>` | Stops the specified run.                                                                                           |
| `vapi swarm stop <name> --all`   | Stops every run and tracked sandbox for the swarm.                                                                 |
| `--confirm-worker-stopped`       | Clears a stale id-less start after the owner proves the worker is gone. Terminal only and unavailable through MCP. |

```bash
vapi swarm runs research
vapi swarm stop research <runId>
vapi swarm stop research --all
```

## Tasks preview

Released clients include these Tasks commands. Backend and preview availability depend on the deployment; see [Tasks](/tasks/). Inspect the command inventory without creating or funding a task:

```bash
vapi task --help
```

| Command                                           | Arguments and options                                                                                                                                          |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `task search`                                     | `[--open] [--min usd] [--tab trending\|new\|closing\|paid] [--limit n]`                                                                                        |
| `task show <id>`                                  | `[--account name]`                                                                                                                                             |
| `task post`                                       | `--title text --brief file\|- --amount usd --deadline duration\|ISO [--intake proposals\|submissions] [--max-awards k] [--webhook https-url] [--account name]` |
| `task propose <id>`                               | `--price usd --duration duration --note text [--account name]`                                                                                                 |
| `task submit <id>`                                | Repeatable `--proof https-url`; repeatable `[--file path]`; `[--account name]`                                                                                 |
| `task award <id> <proposalId>`                    | `[--account name]`                                                                                                                                             |
| `task sign <id>`; `task fund <id>`                | `[--yes] [--no-wait] [--timeout duration] [--counterparty address] [--account name]`                                                                           |
| `task deliver <id>`                               | `--files path... --note text [--no-wait] [--timeout duration] [--counterparty address] [--account name]`                                                       |
| `task release <id>`                               | `[--no-wait] [--timeout duration] [--counterparty address] [--account name]`                                                                                   |
| `task refund <id>`                                | `[--counterparty address] [--account name]`                                                                                                                    |
| `task dispute <id>`; `task counter-evidence <id>` | `--evidence-hash 0x+64hex [--yes] [--counterparty address] [--account name]`                                                                                   |
| `task resolve-unmatched <id>`                     | `[--counterparty address] [--account name]`                                                                                                                    |
| `task message <id> <text>`                        | `[--account name]`                                                                                                                                             |
| `task thread <id>`                                | `[--after cursor] [--account name]`                                                                                                                            |
| `task watch <id>`                                 | `[--until state] [--auto-release] [--timeout duration] [--interval duration] [--counterparty address] [--account name]`                                        |
| `task status <id>`                                | `[--account name]`                                                                                                                                             |

Task commands exit `1` on errors including invalid usage, `2` on policy refusal, and `3` when non-interactive approval is needed. Local MCP exposes the corresponding `tasks.*` tools. The published client's pinned Base Sepolia factory predates escrow V2, so V2 dispute actions refuse until a compatible deployment is pinned.

## Router and Stake

See [vAPI Router](/router/) and [vAPI Stake](/stake/).

### `vapi claude`

Starts Claude Code through Router or the tool's own login. Available since 0.12.0.
Router is selected when at least $0.50 of today's Compute remains. Otherwise, or when Router cannot be reached, the tool uses its own login.
The route is chosen once at launch. Other arguments pass through in order; a literal `--` ends launcher option parsing. The launcher rejects `--json`.

| Option             | What it does                                                             | Default                               |
| ------------------ | ------------------------------------------------------------------------ | ------------------------------------- |
| `--vapi`           | Forces Router even below $0.50; missing credentials fail the launch.     | Automatic route selection             |
| `--own`            | Uses the tool's own login without checking Router.                       | Automatic route selection             |
| `--model <m>`      | Accepts `sonnet`, `opus`, `haiku` or a Router model id.                  | `venice/claude-sonnet-5-5`            |
| `--use-balance`    | Counts purchased Router balance and uses it when Compute is below $0.50. | Off                                   |
| `--account <name>` | Selects the vAPI account whose credentials and allowance to use.         | `VAPI_WALLET`, then the vault default |

Syntax from the published help:

```bash
vapi claude [--vapi|--own] [--model <m>] [--use-balance] [--account <name>] [<claude args>...]
```

### `vapi codex`

Starts Codex through Router or the tool's own login. Available since 0.12.0.
Router is selected when at least $0.50 of today's Compute remains. Otherwise, or when Router cannot be reached, the tool uses its own login.
The route is chosen once at launch. Other arguments pass through in order; a literal `--` ends launcher option parsing. The launcher rejects `--json`.

| Option             | What it does                                                             | Default                                                  |
| ------------------ | ------------------------------------------------------------------------ | -------------------------------------------------------- |
| `--vapi`           | Forces Router even below $0.50; missing credentials fail the launch.     | Automatic route selection                                |
| `--own`            | Uses the tool's own login without checking Router.                       | Automatic route selection                                |
| `--model <id>`     | Passes the model id unchanged.                                           | Profile model; installer sets `venice/openai-gpt-61-sol` |
| `--use-balance`    | Counts purchased Router balance and uses it when Compute is below $0.50. | Off                                                      |
| `--account <name>` | Selects the vAPI account whose credentials and allowance to use.         | `VAPI_WALLET`, then the vault default                    |

Syntax from the published help:

```bash
vapi codex [--vapi|--own] [--model <id>] [--use-balance] [--account <name>] [<codex args>...]
```

### `vapi code install`

Configures detected coding tools for vAPI Compute. Available since 0.12.0.
It reuses the account link and Router key, or starts login and creates a key when needed.
Codex gets a provider and profile in `~/.codex/config.toml`, or `$CODEX_HOME/config.toml` when set. Claude Code needs no config change.
Interactive terminals ask before adding aliases in `~/.zshrc` or `~/.bashrc`. Windows skips aliases. Missing tools are skipped; nothing is written if neither tool exists.

| Option             | What it does                            | Default                               |
| ------------------ | --------------------------------------- | ------------------------------------- |
| `--yes`            | Accepts shell aliases without a prompt. | Interactive prompt                    |
| `--no-alias`       | Leaves shell aliases unchanged.         | Interactive prompt                    |
| `--account <name>` | Selects the vAPI account.               | `VAPI_WALLET`, then the vault default |
| `--json`           | Prints structured output.               | Not stated in the README              |

Syntax from the published help:

```bash
vapi code install [--yes] [--no-alias] [--account <name>] [--json]
```

### `vapi code uninstall`

Removes the Codex profile and the marked shell alias block. Available since 0.12.0.
Other content in those files stays as it was. The command supports structured output.

| Option   | What it does              | Default                  |
| -------- | ------------------------- | ------------------------ |
| `--json` | Prints structured output. | Not stated in the README |

Syntax from the published help:

```bash
vapi code uninstall [--json]
```

### `vapi router models`

Lists the vAPI Router model ids

| Option             | What it does               | Default                                                  |
| ------------------ | -------------------------- | -------------------------------------------------------- |
| `--account <name>` | Selects the linked wallet. | `VAPI_WALLET`, then the default from `vapi accounts use` |

```bash
vapi router models --account agent
```

### `vapi router usage`

Shows the agent's Compute allowance and Router balance

| Option             | What it does               | Default                                                  |
| ------------------ | -------------------------- | -------------------------------------------------------- |
| `--account <name>` | Selects the linked wallet. | `VAPI_WALLET`, then the default from `vapi accounts use` |

```bash
vapi router usage --account agent
```

### `vapi router chat --model <id> "<prompt>"`

Sends one chat request through vAPI Router

| Option             | What it does                         | Default                                                  |
| ------------------ | ------------------------------------ | -------------------------------------------------------- |
| `--system <text>`  | Sets the system message.             | Not stated in the README                                 |
| `--max-tokens <n>` | Sets the maximum output token count. | Not stated in the README                                 |
| `--account <name>` | Selects the linked wallet.           | `VAPI_WALLET`, then the default from `vapi accounts use` |

```bash
vapi router chat --model <id> "Summarize this API" --account agent
```

### `vapi router key`

Prints a gated Compute key or recovers and stores it without printing it

| Option             | What it does                                                                                                                     | Default                                                  |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `--rotate`         | Recovers and stores the Compute key without printing it; an existing key is reused without resetting spend or its budget window. | Prints the current gated key                             |
| `--account <name>` | Selects the linked wallet.                                                                                                       | `VAPI_WALLET`, then the default from `vapi accounts use` |

```bash
vapi router key --rotate --account agent
```

### `vapi router buy <1|5|20|50>`

Buys vAPI Router balance with USDC from your wallet

| Option             | What it does                     | Default                                                  |
| ------------------ | -------------------------------- | -------------------------------------------------------- |
| `--account <name>` | Selects the wallet that pays.    | `VAPI_WALLET`, then the default from `vapi accounts use` |
| `--json`           | Writes one JSON value to stdout. | Human-readable terminal output                           |

```bash
vapi router buy 5 --account agent
```

### `vapi router buy --auto <1|5|20|50> --below <usd>`

Sets or clears automatic vAPI Router balance refill

| Option             | What it does                              | Default                                                  |
| ------------------ | ----------------------------------------- | -------------------------------------------------------- |
| `--account <name>` | Selects the wallet that pays for refills. | `VAPI_WALLET`, then the default from `vapi accounts use` |
| `--auto off`       | Clears automatic refill.                  | Not applicable                                           |

```bash
vapi router buy --auto 5 --below 2.50 --account agent
vapi router buy --auto off --account agent
```

### `vapi stake status`

Shows the linked owner's stake and Compute today

| Option             | What it does               | Default                                                  |
| ------------------ | -------------------------- | -------------------------------------------------------- |
| `--account <name>` | Selects the linked wallet. | `VAPI_WALLET`, then the default from `vapi accounts use` |

```bash
vapi stake status --account agent
```

### `vapi stake open`

Prints and optionally opens the staking page

| Option             | What it does                                       | Default                                                  |
| ------------------ | -------------------------------------------------- | -------------------------------------------------------- |
| `--account <name>` | Selects the linked wallet.                         | `VAPI_WALLET`, then the default from `vapi accounts use` |
| `--no-browser`     | Prints the staking page without opening a browser. | Browser opens on a terminal                              |

```bash
vapi stake open --account agent
```

## Publishing

### `vapi publish <url>`

Probes your API, lists the endpoints you pick, signs the payout wallet

| Option                                           | What it does                                                                   | Default                                                  |
| ------------------------------------------------ | ------------------------------------------------------------------------------ | -------------------------------------------------------- |
| `--method <method>`                              | Sets the method for an endpoint probe.                                         | Not stated in the README                                 |
| `--mode <origin\|endpoint\|openapi>`             | Tells the registry whether the URL is an origin, endpoint or OpenAPI document. | Not stated in the README                                 |
| `--name <text>`                                  | Sets the listing name.                                                         | Not stated in the README                                 |
| `--description <text>`                           | Sets the listing description.                                                  | Not stated in the README                                 |
| `--category <ai\|data\|crypto\|compute\|search>` | Sets the listing category.                                                     | Not stated in the README                                 |
| `--select <names>`                               | Selects the endpoint names to list.                                            | Not stated in the README                                 |
| `--account <name>`                               | Selects the payout wallet that signs.                                          | `VAPI_WALLET`, then the default from `vapi accounts use` |
| `--yes`                                          | Takes all discovered endpoints without an interactive selection.               | Not stated in the README                                 |
| `--resume`                                       | Skips endpoints this API key already lists and publishes the rest.             | Not stated in the README                                 |

```bash
vapi publish https://weather.example --mode origin --name Weather --category data --yes --account provider
```

### `vapi publish activate <slug>`

Takes a listing live after re-probing every endpoint for direct payout to the proven provider wallet

This command has no command-specific options.

```bash
vapi publish activate weather-call
```

### `vapi publish verify-request <slug>`

Asks vAPI to review the listing

This command has no command-specific options.

```bash
vapi publish verify-request weather-call
```

### `vapi publish list`

Every listing this API key owns

This command has no command-specific options.

```bash
vapi publish list
```

### `vapi claim <origin>`

Takes over the listings vAPI indexed from your API, signed by their payee

| Option             | What it does                                   | Default                                                  |
| ------------------ | ---------------------------------------------- | -------------------------------------------------------- |
| `--account <name>` | Selects the payee wallet that signs the claim. | `VAPI_WALLET`, then the default from `vapi accounts use` |

```bash
vapi claim https://weather.example --account provider
```

## Auth

### `vapi auth set-key`

Prompts for the registry API key. The prompt points to [Connect → API keys](https://api.vapinetwork.ai/connect?advanced=keys#api-keys).

Key storage follows the vault's backend, as described under [Configuration and environment variables](/reference/cli/cli-reference/#configuration-and-environment-variables).

This command has no command-specific options.

```bash
vapi auth set-key
```

### `vapi auth status`

Whether this machine has a key and where it comes from, masked

This command has no command-specific options.

```bash
vapi auth status
```

### `vapi auth clear`

Takes the stored key back out

This command has no command-specific options.

```bash
vapi auth clear
```

## Maintenance

### `vapi sweep [<address>]`

Moves USDC or native Base ETH to an address, or to the linked owner when omitted

| Option                | What it does                  | Default                                                        |
| --------------------- | ----------------------------- | -------------------------------------------------------------- |
| `--asset <usdc\|eth>` | Selects the withdrawal asset. | usdc                                                           |
| `--network <caip2>`   | Selects a configured network. | Configured Base networks for ETH; configured networks for USDC |
| `--account <name>`    | Selects the account to sweep. | `VAPI_WALLET`, then the default from `vapi accounts use`       |

```bash
vapi sweep --network eip155:8453 --account agent
```

Native ETH withdrawal is available in client 0.14.0 through the sweep asset option. USDC remains the default.
ETH withdrawals support Base mainnet and Base Sepolia only. An explicit network must already be configured.
Without a network option, ETH uses configured Base networks; USDC attempts configured networks.
Omitting the destination uses the linked owner; otherwise supply an explicit address.
Unfinished distributions and unresolved automatic ceiling sweeps block manual withdrawals, including ETH.

The client retains estimated execution gas plus the L1 data fee with a 20% margin.
If the L1 oracle fails, it reserves 0.00001 ETH for that component.
It re-estimates the exact withdrawal amount at most five times. Contract destinations cannot use the ordinary-transfer gas fallback.
If gas cannot be safely estimated, it sends no transaction.

Inspect withdrawal options without moving funds:

```bash
npx -y vapi-network@0.14.0 --help
```

Excerpt from the captured help:

```text
  vapi sweep [<address>] [--asset usdc|eth] [--network <caip2>] [--account <name>] [--json]
```

### `vapi export-key`

Prints the private key. Terminal only, never for an agent.

| Option              | What it does                        | Default                                                  |
| ------------------- | ----------------------------------- | -------------------------------------------------------- |
| `--network <caip2>` | Selects the account network.        | Not stated in the README                                 |
| `--account <name>`  | Selects the account to export from. | `VAPI_WALLET`, then the default from `vapi accounts use` |

```bash
vapi export-key --network eip155:8453 --account main
```

### `vapi backup`

Prints the vault recovery phrase or manages owner-encrypted cloud backup

| Option             | What it does                                                               | Default                                                  |
| ------------------ | -------------------------------------------------------------------------- | -------------------------------------------------------- |
| `--account <name>` | Selects a derived account before printing the vault phrase.                | `VAPI_WALLET`, then the default from `vapi accounts use` |
| `--cloud`          | Enrolls the device and uploads an encrypted backup after console approval. | Prints the recovery phrase                               |
| `--cloud off`      | Deletes the local backup key and stops later uploads.                      | Not applicable                                           |

```bash
vapi backup --account main
vapi backup --cloud
```

Phrase output is terminal-only and unavailable to agents. Cloud backup never returns the phrase or a private key.

### `vapi restore`

Restores a vault from a phrase or an owner-approved cloud backup

| Option           | What it does                                                                                                | Default                                                  |
| ---------------- | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `--accounts <n>` | Restores a fixed count of derived accounts without balance queries; cannot be combined with `--from-owner`. | Scans until five consecutive addresses have no Base USDC |
| `--from-owner`   | Starts owner-approved cloud restore on a new device.                                                        | Reads a recovery phrase                                  |
| `--owner <0x…>`  | Checks the expected owner before writing the vault. Required without a terminal.                            | Confirms the returned owner interactively                |

```bash
vapi restore
vapi restore --from-owner --owner <0x…>
```

### `vapi import`

Restores a wallet from a prompt, never from argv

| Option                  | What it does                                                                             | Default                           |
| ----------------------- | ---------------------------------------------------------------------------------------- | --------------------------------- |
| `--phrase`              | Imports from recovery words entered at a prompt.                                         | Not stated in the README          |
| `--key`                 | Imports from a private key entered at a prompt.                                          | Not stated in the README          |
| `--account <name>`      | Names the new wallet.                                                                    | `main` only when no wallet exists |
| `--networks <base,arc>` | Selects the networks for the restored wallet. Device-vault imports support Base and Arc. | Not stated in the README          |
| `--replace`             | Moves vault account metadata or a legacy encrypted keystore to trash before replacement. | Not stated in the README          |
| `--force`               | Allows replacement when the named wallet still holds USDC on Base.                       | Not stated in the README          |

```bash
vapi import --phrase --account backup-2026 --networks base,arc
```

### `vapi passphrase`

Changes a legacy keystore's passphrase. Protect current vault accounts with `vapi vault protect`.

| Option             | What it does                                 | Default                                                  |
| ------------------ | -------------------------------------------- | -------------------------------------------------------- |
| `--account <name>` | Selects the wallet whose passphrase changes. | `VAPI_WALLET`, then the default from `vapi accounts use` |

```bash
vapi passphrase --account main
```

### `vapi vault protect|unprotect|lock|unlock|status`

Manages password protection and the device-wide vault session

| Command                | What it does                                              |
| ---------------------- | --------------------------------------------------------- |
| `vapi vault protect`   | Adds password protection to the device vault.             |
| `vapi vault unprotect` | Removes password protection from the device vault.        |
| `vapi vault unlock`    | Opens the protected vault on this device for eight hours. |
| `vapi vault lock`      | Ends the protected vault session.                         |
| `vapi vault status`    | Shows the vault protection and session state.             |

```bash
vapi vault protect
vapi vault unprotect
vapi vault lock
vapi vault status
vapi vault unlock
```

Set `VAPI_VAULT_PASSWORD` for unattended protected-vault access.

### `vapi unlock`

This deprecated alias routes current vault accounts to `vapi vault unlock` for an eight-hour device-wide session. Legacy accounts store their passphrase in the OS secret store.

| Option             | What it does                | Default                                                  |
| ------------------ | --------------------------- | -------------------------------------------------------- |
| `--account <name>` | Selects the wallet to open. | `VAPI_WALLET`, then the default from `vapi accounts use` |

```bash
vapi unlock --account agent
```

### `vapi lock`

This deprecated alias routes current vault accounts to `vapi vault lock`. Legacy accounts have their stored passphrases removed.

| Option             | What it does                                                                | Default                                                  |
| ------------------ | --------------------------------------------------------------------------- | -------------------------------------------------------- |
| `--account <name>` | Selects the wallet to lock.                                                 | `VAPI_WALLET`, then the default from `vapi accounts use` |
| `--all`            | Locks the vault session and removes every stored legacy account passphrase. | Not stated in the README                                 |

```bash
vapi lock --all
```

### `vapi report "<what>"`

Writes a privacy-preserving local bug report

| Option                | What it does                             | Default                  |
| --------------------- | ---------------------------------------- | ------------------------ |
| `--include-addresses` | Includes wallet addresses in the report. | Not stated in the README |
| `--send`              | Sends the report.                        | Not stated in the README |

```bash
vapi report "search returned no listings"
```

### `vapi mcp`

Serves the MCP tools over stdio

| Option             | What it does                               | Default                                                  |
| ------------------ | ------------------------------------------ | -------------------------------------------------------- |
| `--account <name>` | Selects the wallet used by the MCP server. | `VAPI_WALLET`, then the default from `vapi accounts use` |

```bash
vapi mcp --account agent
```

### `vapi mcp install <claude-code|claude-desktop|cursor|codex>`

Registers vAPI through Claude Code's `claude` command, or writes an MCP server entry for Claude Desktop, Cursor, or Codex

The entry runs `npx -y vapi-network@latest mcp`. Running the install command again rewrites an older entry to this form.

| Option             | What it does                                    | Default                                                                         |
| ------------------ | ----------------------------------------------- | ------------------------------------------------------------------------------- |
| `--home <dir>`     | Sets `VAPI_HOME` for the installed server.      | `VAPI_HOME`, then `~/.vapi`                                                     |
| `--registry <url>` | Sets the registry URL for the installed server. | The selected home's configured registry, then the default registry              |
| `--no-link`        | Skips the dashboard link offer.                 | Offers a link in an interactive terminal when the default account is not linked |

```bash
vapi mcp install codex --home /srv/vapi --registry https://registry.example
```

When the default account is not linked, the command then offers to link it to your dashboard, using the same `--home` and `--registry`, so the agent's activity shows up under **My agents** and **Activity**.

The `claude-code` target requires `claude` on PATH and registers the server at user scope. Start a new Claude Code session afterward. The `claude` target is an alias for `claude-desktop`.

Cursor uses `.cursor/mcp.json` in the current directory. Codex uses `~/.codex/config.toml`. Claude Desktop uses `~/Library/Application Support/Claude/claude_desktop_config.json` on macOS, `~/.config/Claude/claude_desktop_config.json` on Linux, and `%APPDATA%/Claude/claude_desktop_config.json` on Windows.

### `vapi serve`

Preview only; exits `2` with a message

This command has no command-specific options.

```bash
vapi serve
```

### `vapi version`

The client version, also as `--version` or `-v`

This command has no command-specific options.

```bash
vapi version
```

### `vapi help`

Prints command usage, also as `--help` or `-h`. Bare `vapi` shows device status.

This command has no command-specific options.

```bash
vapi help
```

## Configuration and environment variables

Local state lives in `~/.vapi/`. `VAPI_HOME` can select another directory.

| Variable                                                                                    | What it does                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `VAPI_HOME`                                                                                 | Uses a different directory instead of `~/.vapi`.                                                                                                                                                                              |
| `VAPI_WALLET`                                                                               | Selects the wallet when no `--account` is given.                                                                                                                                                                              |
| `VAPI_REGISTRY_URL`                                                                         | Replaces the registry base; the canonical discovery paths derive from it.                                                                                                                                                     |
| `VAPI_DISCOVERY_URL`                                                                        | Sets the services discovery URL.                                                                                                                                                                                              |
| `VAPI_MARKETPLACE_DISCOVERY_URL`                                                            | Sets the marketplace discovery URL.                                                                                                                                                                                           |
| `VAPI_VAULT_PASSWORD`                                                                       | Supplies the device-vault password. On Linux without a keyring, set at least 12 characters before setup. This keeps the device key and agent link encrypted in `~/.vapi/secrets.json`; the backend choice is fixed per vault. |
| `VAPI_KEYSTORE_PASSWORD`                                                                    | Supplies a legacy keystore password and remains a deprecated vault fallback.                                                                                                                                                  |
| `VAPI_API_KEY`                                                                              | Supplies the registry key that `vapi publish` authenticates with in CI.                                                                                                                                                       |
| `VAPI_NO_SECRETS`                                                                           | Set to `1` to stop `vapi backup` and `vapi export-key` printing anything.                                                                                                                                                     |
| `BASE_RPC_URL`                                                                              | Overrides the Base RPC.                                                                                                                                                                                                       |
| `ARC_RPC_URL`                                                                               | Overrides the Arc mainnet RPC.                                                                                                                                                                                                |
| `ARC_TESTNET_RPC_URL`                                                                       | Sets the Arc testnet RPC endpoint.                                                                                                                                                                                            |
| `VAPI_ARC_GAS_HEADROOM_USDC`                                                                | Sets the USDC retained for Arc sweep gas.                                                                                                                                                                                     |
| `VAPI_DEVICE`                                                                               | Overrides the device name.                                                                                                                                                                                                    |
| `CLAUDECODE`, `CLAUDE_CODE`, `CURSOR_AGENT`, `CODEX_SANDBOX`, `OPENAI_CODEX`, `AGENT`, `CI` | Mark an agent or CI environment where secret exports are refused.                                                                                                                                                             |

`ARC_RPC_URL` also enables Arc mainnet.

Current accounts live in `vault.json`, with account metadata in `wallets.json` and the device key in the vault's selected backend. Other local files include `config.json`, `audit.log`, `receipts.jsonl`, `searches.jsonl`, `spend-ledger.json`, and `reports/`. Removed vault accounts leave metadata-only trash records. Legacy accounts use individual encrypted keystores, and removed legacy accounts move those files to trash.

Storage follows the vault's backend. The OS store is the default. On Linux without a keyring, `VAPI_VAULT_PASSWORD` of at least 12 characters keeps the device key and agent link encrypted in `~/.vapi/secrets.json`. Set the variable before setup. The choice is fixed once per vault.

## Complete command inventory

The table omits the repeated vapi prefix. Brackets mark optional arguments.
Ordinary commands accept JSON output; Claude and Codex launchers reject it, and receipt exports use a format option.
Account selection uses the explicit account option, then VAPI_WALLET, then the machine default.
The wallet option remains a deprecated compatibility alias. Bare vapi opens status; there is no status subcommand.

| Command                                                                                                                        | Arguments and options                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Bare `vapi`                                                                                                                    | Status screen; no command name                                                                                                                                                                                                 |
| `init`                                                                                                                         | `[--networks base,arc] [--no-link]`                                                                                                                                                                                            |
| `setup`                                                                                                                        | `[--no-cloud-backup] [--accounts n]`                                                                                                                                                                                           |
| `accounts`, `accounts list`                                                                                                    | `[--all]`                                                                                                                                                                                                                      |
| `accounts add <name>`                                                                                                          | `[--label text] [--no-link]`                                                                                                                                                                                                   |
| `accounts import <name>`                                                                                                       | `[--keystore path \| --key-file path] [--label text]`                                                                                                                                                                          |
| `accounts rename <old> <new>`; `accounts use <name>`; `accounts restore <name>`                                                | No additional command flags                                                                                                                                                                                                    |
| `accounts remove <name>`                                                                                                       | `[--force]`                                                                                                                                                                                                                    |
| `accounts caps <name>`                                                                                                         | `[--per-call usd] [--per-day usd] [--ceiling usd\|off]`                                                                                                                                                                        |
| `accounts distribute <amount>`                                                                                                 | `--from account [--to a,b,c] [--network base\|arc]`                                                                                                                                                                            |
| `accounts distribute --resume <id>`                                                                                            | `[--replace-expired-restored] [--bind-legacy-addresses]`                                                                                                                                                                       |
| `accounts distribute --cancel <id>`                                                                                            | `[--replace-expired-restored]`                                                                                                                                                                                                 |
| Legacy `accounts --enable <network>`                                                                                           | `arc\|solana [--account name]`; Solana refuses because device-vault Solana keys are unavailable                                                                                                                                |
| Legacy `accounts --account <name>`                                                                                             | Network-account listing                                                                                                                                                                                                        |
| `send <amount>`                                                                                                                | `--from account --to account\|owner\|address [--network base\|arc] [--resume nonce]`                                                                                                                                           |
| `fund`                                                                                                                         | `[--amount usd] [--account name]`                                                                                                                                                                                              |
| `docs "<question>"`; `docs search "<query>"`; `docs read <url-or-path>`                                                        | No additional command flags                                                                                                                                                                                                    |
| `search [query]`                                                                                                               | Repeatable `--kind`; `[--network caip2] [--limit n] [--cursor cursor] [--include-unverified] [--include-outage]`                                                                                                               |
| `inspect <id>`                                                                                                                 | `[--endpoint name]`                                                                                                                                                                                                            |
| `pay <id-or-url>`                                                                                                              | `[--method method] [--endpoint name] [--body json] [--content-type type] [--network caip2] [--expected-pay-to address] [--max amount] [--timeout seconds] [--account name]`; `--max-price-usd` aliases `--max`                 |
| `pay --resume <receipt-id>`                                                                                                    | Reconciles the existing authorization; does not pay                                                                                                                                                                            |
| `check <url>`                                                                                                                  | `[--method method]`                                                                                                                                                                                                            |
| `balance`                                                                                                                      | `[--account name]`                                                                                                                                                                                                             |
| `receipts`                                                                                                                     | `[--limit n] [--account name] [--all-wallets]`                                                                                                                                                                                 |
| `receipts export`                                                                                                              | `--format json\|csv [--range 24h\|7d\|30d] [--account name] [--all-wallets]`                                                                                                                                                   |
| `stats`                                                                                                                        | `[--range 24h\|7d\|30d] [--account name] [--all-wallets]`                                                                                                                                                                      |
| `sweep [address]`                                                                                                              | `[--asset usdc\|eth] [--network caip2] [--account name]`                                                                                                                                                                       |
| `dashboard`                                                                                                                    | `[--account name] [--no-browser]`                                                                                                                                                                                              |
| `login`                                                                                                                        | `[--account name] [--label name] [--publish] [--no-browser]`                                                                                                                                                                   |
| `logout`; `whoami`                                                                                                             | `[--account name]`                                                                                                                                                                                                             |
| `agent create <name>`                                                                                                          | `--model id --instructions file [--call-budget usd] [--max-per-call usd] [--router-budget usd] [--approve-above usd] [--max-per-task usd] [--auto-release-below usd] [--include-unverified] [--max-steps n] [--yes]`           |
| `agent run <name> "<task>"`                                                                                                    | `[--budget usd] [--detach] [--runtime local] [--result-file path]`                                                                                                                                                             |
| `agent run --bundle-env <VAR>`                                                                                                 | `"<task>" \| --task-base64url text`; `[--budget usd] [--result-file path]`                                                                                                                                                     |
| `agent list`; `agent show <name>`; `agent pause <name>`; `agent resume <name>`; `agent revoke <name>`                          | No additional command flags                                                                                                                                                                                                    |
| `swarm create <name>`                                                                                                          | `[--agents n\|--roles a,b,c] [--fund usd --from account] [--strategy targets\|even\|weights] [--targets role=usd,...] [--caps perCall/perDay] [--treasury-caps perCall/perDay] [--network base\|arc] [--model id] [--no-wait]` |
| `swarm add <name> <role>`; `swarm remove <name> <member>`; `swarm status <name>`; `swarm dissolve <name>`; `swarm runs <name>` | No additional command flags                                                                                                                                                                                                    |
| `swarm fund <name> <usd>`                                                                                                      | `[--from account]`                                                                                                                                                                                                             |
| `swarm rebalance <name>`                                                                                                       | `[--targets role=usd,...]`                                                                                                                                                                                                     |
| `swarm run <name> "<task>"`                                                                                                    | `[--mode lead\|each] [--lead member] [--budget usd] [--draw usd] [--detach] [--runtime local\|railway] [--result-file path]`                                                                                                   |
| Railway swarm run                                                                                                              | Requires `--mode each --runtime railway --checkpoint name --allow-remote-key`; `[--keep-sandbox]`                                                                                                                              |
| `swarm stop <name>`                                                                                                            | `[runId\|--all] [--confirm-worker-stopped]`                                                                                                                                                                                    |
| `claude`; `codex`                                                                                                              | `[--vapi\|--own] [--model id] [--use-balance] [--account name]`; remaining arguments pass through; literal `--` ends launcher parsing                                                                                          |
| `code install`                                                                                                                 | `[--yes] [--no-alias] [--account name]`                                                                                                                                                                                        |
| `code uninstall`                                                                                                               | No additional command flags                                                                                                                                                                                                    |
| `router models`; `router usage`                                                                                                | `[--account name]`                                                                                                                                                                                                             |
| `router chat "<prompt>"`                                                                                                       | `--model id [--system text] [--max-tokens n] [--account name]`                                                                                                                                                                 |
| `router buy <1\|5\|20\|50>`                                                                                                    | `[--account name]`                                                                                                                                                                                                             |
| `router buy --auto <1\|5\|20\|50>`                                                                                             | `--below usd [--account name]`                                                                                                                                                                                                 |
| `router buy --auto off`                                                                                                        | `[--account name]`                                                                                                                                                                                                             |
| `router key`                                                                                                                   | `[--rotate] [--account name]`                                                                                                                                                                                                  |
| `stake status`; `stake open`                                                                                                   | `[--account name]`; `open` also accepts `[--no-browser]`                                                                                                                                                                       |
| `export-key`                                                                                                                   | `[--network caip2] [--account name]`                                                                                                                                                                                           |
| `backup`                                                                                                                       | `[--account name] [--cloud [off]]`                                                                                                                                                                                             |
| `restore`                                                                                                                      | `[--accounts n \| --from-owner [--owner address]]`                                                                                                                                                                             |
| `import`                                                                                                                       | `--phrase \| --key`; `[--account name] [--networks base,arc] [--replace] [--force]`                                                                                                                                            |
| `passphrase`; `unlock`                                                                                                         | `[--account name]`                                                                                                                                                                                                             |
| `lock`                                                                                                                         | `[--account name \| --all]`                                                                                                                                                                                                    |
| `vault protect`; `vault unprotect`; `vault lock`; `vault unlock`; `vault status`                                               | No additional command flags                                                                                                                                                                                                    |
| `report "<what happened>"`                                                                                                     | `[--include-addresses] [--send]`                                                                                                                                                                                               |
| `auth set-key`; `auth status`; `auth clear`                                                                                    | No additional command flags                                                                                                                                                                                                    |
| `publish <url>`                                                                                                                | `[--method method] [--mode origin\|endpoint\|openapi] [--name text] [--description text] [--category ai\|data\|crypto\|compute\|search] [--select names] [--account name] [--yes] [--resume]`                                  |
| `publish activate <slug>`; `publish verify-request <slug>`; `publish list`                                                     | No additional command flags                                                                                                                                                                                                    |
| `claim <origin>`                                                                                                               | `[--account name]`                                                                                                                                                                                                             |
| `mcp`                                                                                                                          | `[--account name]`                                                                                                                                                                                                             |
| `mcp install <target>`                                                                                                         | Targets `claude-code`, `claude-desktop`, `cursor`, `codex`; `[--home dir] [--registry url] [--no-link]`                                                                                                                        |
| `serve`; `version`; `help`                                                                                                     | No additional command flags; version aliases `--version`, `-v`; help aliases `--help`, `-h`                                                                                                                                    |

## Defaults and constraints

These defaults apply to client 0.14.0. Optional values without a confirmed default are omitted.
Receipt limits are unlimited when omitted; export ranges then cover all retained receipts.

| Setting                           | Default or constraint                                                                                                                           |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Initial networks                  | Base                                                                                                                                            |
| Ordinary account caps             | `$0.10` per call, `$1` per day; Base ceiling `$5`                                                                                               |
| Default task policy               | Maximum `$100`; automatic release strictly below `$25`                                                                                          |
| New agent profile                 | Call budget `$1`, Router budget `$1`, per-call `$0.05`, approval threshold `$0.50`, 12 steps                                                    |
| Sweep asset                       | `usdc`                                                                                                                                          |
| Check method                      | `GET`                                                                                                                                           |
| Search                            | Unverified and outage opt-ins omitted by default; limit forwarded when supplied, otherwise registry default                                     |
| Paid-response timeout             | Offer timeout clamped to 30–120 seconds; absent usable offer timeout, 120 seconds. Explicit value 1–300 seconds, capped by usable offer timeout |
| Receipt limit                     | No limit when omitted                                                                                                                           |
| Receipt export range              | All retained receipts when omitted                                                                                                              |
| CLI/local-MCP receipt stats range | `24h`                                                                                                                                           |
| Swarm creation                    | Two agents, Base, `targets`, model `venice/claude-sonnet-5`                                                                                     |
| Swarm run                         | `lead`; shared treasury draw default `$2`                                                                                                       |
| Claude launcher                   | Automatic Router selection at `$0.50` remaining Compute; default Router model `venice/claude-sonnet-5-5`                                        |
| Codex launcher model              | `venice/openai-gpt-61-sol`                                                                                                                      |
| Task indexing wait                | `120s`                                                                                                                                          |
| CLI task watch                    | Timeout `7d`, interval `5s`                                                                                                                     |
| Vault session                     | Eight hours                                                                                                                                     |
| Phrase restore                    | Scans until five consecutive derived addresses have no Base USDC; `--accounts` requests a fixed count                                           |

## Next

- [Open source](/reference/open-source/)
- [SDK](/reference/sdk/sdk/)
- [Run your first agent](/agents/quickstart/)

Checked on 2026-11-17.
