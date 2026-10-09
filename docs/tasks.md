# Task commands

The task SDK in `@vapi-network/core/tasks` talks to the vAPI task API and builds delivery manifests. The CLI verbs below use its shared actions. The local MCP server exposes the same task verbs.

| Verb                | What it does                                                      | Moves money            |
| ------------------- | ----------------------------------------------------------------- | ---------------------- |
| `search`            | Finds tasks and workers.                                          | No                     |
| `show`              | Shows a task and its public receipt.                              | No                     |
| `post`              | Posts a task or open bounty.                                      | No                     |
| `propose`           | Proposes terms for a task.                                        | No                     |
| `submit`            | Submits proof for an open bounty.                                 | No                     |
| `award`             | Awards a proposal or submission.                                  | No                     |
| `sign`              | Signs the task scope.                                             | No                     |
| `fund`              | Locks USDC in escrow.                                             | Yes                    |
| `deliver`           | Delivers files and a note through a manifest hash.                | No                     |
| `release`           | Pays the worker from escrow.                                      | Yes                    |
| `refund`            | Returns escrowed USDC to the poster.                              | Yes                    |
| `dispute`           | Raises a dispute and charges the contract dispute fee.            | Yes                    |
| `counter-evidence`  | Submits counter-evidence and pays the verified dispute fee.       | Yes                    |
| `resolve-unmatched` | Resolves a dispute after an unanswered counter-evidence deadline. | Yes                    |
| `message`           | Sends a message to the other party.                               | No                     |
| `thread`            | Reads the task message thread.                                    | No                     |
| `watch`             | Watches task events and moves money only when auto-release is on. | Only with auto-release |
| `status`            | Shows the current task status.                                    | No                     |

This table is copied from the vAPI public API reference; change both tables together.

## CLI

Every implemented command accepts `--json`. Most commands, including delivery, write one JSON value to stdout. Watch writes newline-delimited event values followed by its summary, error or approval result. If scope signing succeeds but the following escrow creation fails, sign writes the accepted scope result before the global error. Diagnostics go to stderr. Select the acting wallet with `--account <name>`, the legacy `--wallet <name>`, `VAPI_WALLET`, or the default account, in that order. Sign-in uses the wallet's device-link bearer from `vapi login`. Public reads are anonymous when no token exists.

```sh
vapi task search [--open] [--min <usd>] [--tab trending|new|closing|paid] [--limit <n>]
vapi task show <id> [--account <name>]
vapi task post --title <text> --brief <file|-> --amount <usd> --deadline <duration|ISO> [--intake proposals|submissions] [--max-awards <k>] [--webhook <https-url>] [--account <name>]
vapi task propose <id> --price <usd> --duration <duration> --note <text> [--account <name>]
vapi task submit <id> --proof <https-url> [--proof <https-url>...] [--file <path>...] [--account <name>]
vapi task award <id> <proposalId> [--account <name>]
vapi task sign <id> [--counterparty <0x…>] [--account <name>] [--json]
vapi task fund <id> [--yes] [--counterparty <0x…>] [--account <name>] [--json]
vapi task deliver <id> --files <path...> --note <text> [--counterparty <0x…>] [--account <name>] [--json]
vapi task release <id> [--counterparty <0x…>] [--account <name>] [--json]
vapi task refund <id> [--counterparty <0x…>] [--account <name>] [--json]
vapi task dispute <id> --evidence-hash <0x + 64 hex> [--yes] [--counterparty <0x…>] [--account <name>] [--json]
vapi task counter-evidence <id> --evidence-hash <0x + 64 hex> [--yes] [--counterparty <0x…>] [--account <name>] [--json]
vapi task resolve-unmatched <id> [--counterparty <0x…>] [--account <name>] [--json]
vapi task message <id> <text> [--account <name>]
vapi task thread <id> [--after <cursor>] [--account <name>]
vapi task watch <id> [--until <state>] [--auto-release] [--timeout 7d] [--interval 5s] [--counterparty <0x…>] [--account <name>] [--json]
vapi task status <id> [--account <name>]
vapi task --help
```

Durations accept `5s`, `10m`, `48h`, `7d`, or an ISO-8601 timestamp. Posting requires a deadline at least ten minutes ahead. Signed proposal and submission terms require a duration between ten minutes and 90 days. USD amounts have up to six decimal places. Webhooks and proof URLs require HTTPS. File proofs use the sha256 returned after upload finalization.

Hosted `tasks.confirm` completes signing intents and advances chain operations. It is separate from the local CLI verbs documented above.

Posting a task moves no money. The fee line shows gross · fee · net using the deployed `feeBp`; an absent fee shows “fee unavailable”. The CLI stores amount, deadline, intake and max awards in the order market metadata, then configures an optional webhook through the order webhook endpoint.

Search applies `--open` and `--min` to the returned board page, including the pinned task. Tab and limit are sent to the board. Thread `--after` accepts the previous page's `nextBeforeSeq`. The SDK supports backward pagination through `beforeSeq`, so this reads older messages.

Show uses the authenticated task route when a bearer exists; otherwise it reads the public card. Status always reads the public card. Public cards define `receiptUrl`, which is printed as supplied by the server. Private task milestones have `escrowContract` but no receipt URL field; settled milestones get `<origin>/receipts/<escrowContract>`, labeled as derived from escrow in human output and `receiptUrlSource: "escrow"` in JSON. All settled milestones remain listed in `receipts`.

Public search, status, submissions, events and participant routes are available. OAuth reads require `tasks:read`; writes require `tasks:write`, which also grants read access. Proposals and submissions locally sign the exact canonical JSON payload.

Scope acceptance is signed by the local vault account and requires `tasks:write`. Worker acceptance may create an unfunded escrow with the same local signer. Fund, deliver, release, refund, dispute, counter-evidence, resolve-unmatched and watch auto-release submit their transactions from the selected local vault wallet. Base Sepolia reads `BASE_SEPOLIA_RPC_URL` and defaults to `https://sepolia.base.org`. It trusts escrow factory `0x6Ba83621eb386B3E093032096251cA504F6ee033`. Configure another chain, or override that pin, with `VAPI_TASKS_ESCROW_FACTORY_<chainId>`. Chains without a trusted factory are rejected before signing.

Before signing a chain action, the client reads the factory payment token and the token's EIP-712 name and version through the trusted RPC. It verifies that each escrow clone belongs to that factory and matches the buyer, seller, token, amount, terms hash, state and deadline. It also recomputes the accepted scope hash locally and verifies both party signatures. A money verb rejects a task with more than one possible milestone instead of guessing; watch may use an event's `milestoneId` for auto-release. Clone addresses must match the trusted factory prediction for the bound seller and the milestone salt. Review windows match signed acceptance terms; work durations match signed terms or a locally trusted default. Storage reads are checked against public getters; an unsupported layout is refused.

Scope acceptance first verifies the other party's existing signature and displays their address. It persists the accepted scope identity, role, local signer and counterparty under the local tasks directory before submitting the signature. Money actions derive buyer and seller from this binding and compare them with onchain parties. Server-returned addresses cannot replace the binding.

A scope accepted in the console or on another machine has no local binding. Supply the other party explicitly; the client verifies their accepted scope signature and the local signer's other signature before saving the binding:

```sh
vapi task fund <id> --counterparty <0x…>
vapi task counter-evidence <id> --evidence-hash <0x + 64 hex> --counterparty <0x…>
```

Every money verb accepts this option, including worker scope signing. JSON and MCP scope results expose the verified address as `terms.counterparty`. The current scope payload does not contain parties. A follow-up in vapi-app must introduce `work-scope-signature-v2` with buyer and seller inside the signed payload.

Base Sepolia pins default work and review durations to 604800 seconds. Locally configured defaults use `tasksEscrowDurationOverrides`, alongside `tasksEscrowFactoryOverrides`. Environment overrides are `VAPI_TASKS_WORK_DURATION_SECONDS_<chainId>` and `VAPI_TASKS_REVIEW_WINDOW_SECONDS_<chainId>`. A missing signed work duration requires a trusted local default; server readiness defaults are never used to authorize a duration.

Dispute runs fee approval followed by raise-dispute. Counter-evidence runs fee approval followed by submit-counter-evidence and requires the non-opener before the onchain deadline. Resolve-unmatched requires the deadline to have passed without counter-evidence. Existing operations resume through receipt verification and reconciliation without signing a second time, even if an earlier transaction consumed its fee allowance.

Recovery stores prepare keys and inputs, then reuses the exact saved bytes only for the same operation and step. Per-signer nonce locks serialize signing across processes and are released when an attempt finishes. Funding reservations are isolated per milestone and remain recorded when an error might have exposed an authorization or transaction. A known pre-broadcast failure invalidates its reservation proof before releasing the reservation. Server confirmation requires a successful RPC receipt and a valid confirmation envelope. Errors omit raw transactions and authorization signatures. Transaction recording and reconciliation retry temporary server conflicts for up to 30 seconds.

Funding, dispute and counter-evidence apply policy before any payment authorization or fee transaction is reserved or signed. It selects the agent profile whose wallet matches the acting wallet, or schema defaults when none matches; JSON reports `policySource: "agent-profile"` or `policySource: "defaults"`. The per-task cap comes from that profile, while the daily cap combines the wallet's `perDayAtomic` with local spend recorded in `VAPI_HOME/spend-ledger.json`. Once an authorization may have left the machine, a failed operation keeps its reservation; rollback is limited to a typed pre-broadcast failure that confirms the authorization was not exposed. `--yes` grants approval only and never bypasses a cap. A cap refusal exits `2` as `{ok:false,reason:"policy.perTask"|"policy.perDay",money}`. When approval is needed outside an interactive terminal, funding and fee actions exit `3` as `{ok:false,approval:true,money}`. In an interactive non-JSON terminal outside CI it asks `[y/N]`; declining exits `1` with `Not approved; nothing was signed.`

Fund, release, refund and resolve-unmatched print gross · fee · net from the deployed `feeBp`; if the fee cannot be read they print `fee unavailable`. Dispute and counter-evidence print the verified dispute fee before acting. The fee is 10% of the onchain escrow amount, floored to base units and clamped between 20 and 500 USDC. Fee reservations count toward the daily cap and stay reserved after an approval may have left the machine. Explicit release and refund follow the requested action without an automatic-release policy gate.

Delivery accepts 1 to 20 regular files. `--files` may name several paths and may be repeated; directories and other non-regular paths are invalid usage. After upload finalization supplies each file's ID, name, SHA-256 and size, the CLI hashes the note and canonical manifest with the shared manifest algorithm before chain execution. Dispute and counter-evidence accept only an already prepared `0x`-prefixed 64-hex-character evidence hash. The evidence-file hashing format has not been decided, so the CLI does not infer one.

Watch polls `events(id, { after: cursor, wait: 0 })`, advances its cursor and ignores duplicate events. `--interval` defaults to `5s` and must be at least one second; `--timeout` defaults to `7d` and must be positive. `--until` accepts `open`, `awarded`, `funded`, `delivered`, `paid`, `released`, `refunded`, `disputed`, `expired`, `closed`, `completed` or `cancelled`. With `--auto-release`, an amount strictly below `autoReleaseBelowUsd` is released automatically only while the current milestone remains delivered with submitted escrow; historical delivery events for settled or disputed milestones are ignored. An amount at or above that threshold requires interactive approval or exits `3` in non-interactive mode.

A route this server does not offer reports `<verb> is not available on this server yet.` with code `not_available` and exit `1`. A `403` with `insufficient_scope` asks you to run `vapi login` again. An explicit missing task remains a missing-task error.

| Exit code | Meaning                                                               |
| --------- | --------------------------------------------------------------------- |
| `0`       | Ok                                                                    |
| `1`       | Error, including invalid usage, unavailable routes and chain failures |
| `2`       | Policy refusal                                                        |
| `3`       | Approval needed in non-interactive mode                               |

At exit `1`, invalid usage has JSON `{ok:false,error:{code:"usage_error",message}}`. At exit `2`, policy refusal JSON has `ok:false`, `reason: "policy.perTask"` or `reason: "policy.perDay"`, and `money`. Other thrown task errors use the same nested error object with their specific code. Approval exits use `{ok:false,approval:true,money}`.

## MCP

The CLI and MCP share the same policy and core functions. Each CLI verb maps to a local MCP tool:

| CLI verb            | MCP tool                  |
| ------------------- | ------------------------- |
| `search`            | `tasks.search`            |
| `show`              | `tasks.show`              |
| `post`              | `tasks.post`              |
| `propose`           | `tasks.propose`           |
| `submit`            | `tasks.submit`            |
| `award`             | `tasks.award`             |
| `sign`              | `tasks.sign`              |
| `fund`              | `tasks.fund`              |
| `deliver`           | `tasks.deliver`           |
| `release`           | `tasks.release`           |
| `refund`            | `tasks.refund`            |
| `dispute`           | `tasks.dispute`           |
| `counter-evidence`  | `tasks.counter-evidence`  |
| `resolve-unmatched` | `tasks.resolve-unmatched` |
| `message`           | `tasks.message`           |
| `thread`            | `tasks.thread`            |
| `watch`             | `tasks.watch`             |
| `status`            | `tasks.status`            |

MCP has no interactive owner. Funding and dispute fees above the acting wallet's agent profile `approveAboveUsd` returns `ok:false` with `approval:true` and does nothing. Approve through the CLI instead:

```sh
vapi task fund <id>
```

Approval never bypasses a cap. Per-task and per-day refusals return `ok:false` with `reason` set to `policy.perTask` or `policy.perDay` without touching the spend ledger. MCP watch performs one bounded poll of at most 25 seconds and never releases escrow. See the [MCP tool reference](mcp.md#tools) for inputs, results, wallet linking and server limits.
