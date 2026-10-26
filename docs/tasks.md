# Task commands

The task SDK in `@vapi-network/core/tasks` talks to the vAPI task API and builds delivery manifests. The CLI verbs below use its shared actions. The local MCP server exposes the same task verbs.

| Verb                | What it does                                                                 | Moves money            |
| ------------------- | ---------------------------------------------------------------------------- | ---------------------- |
| `search`            | Finds tasks and workers.                                                     | No                     |
| `show`              | Shows lifecycle, milestones, next action and receipts.                       | No                     |
| `pending`           | Lists the acting wallet's pending actions.                                   | No                     |
| `checkin`           | Records a worker check-in.                                                   | No                     |
| `post`              | Posts a task, bounty or pool, optionally funding with the vault.             | Only with `--fund`     |
| `propose`           | Proposes terms for a task.                                                   | No                     |
| `submit`            | Submits proof for an open bounty.                                            | No                     |
| `milestone`         | Submit, approve, reject or finalize a zero-based V2 milestone                | On approve/finalize    |
| `cancel`            | Cancel a V2 offer, unpaid remainder or expire                                | Refunds only           |
| `claim`             | Pay a stored pool claim as its verifier                                      | Yes                    |
| `award`             | Awards a proposal or submission.                                             | No                     |
| `sign`              | Signs the task scope.                                                        | No                     |
| `fund`              | Locks USDC in escrow.                                                        | Yes                    |
| `deliver`           | Delivers files and a note through a manifest hash.                           | No                     |
| `release`           | Pays the worker from escrow.                                                 | Yes                    |
| `refund`            | Returns escrowed USDC to the poster.                                         | Yes                    |
| `dispute`           | Raises a dispute and charges the contract dispute fee.                       | Yes                    |
| `counter-evidence`  | Submits counter-evidence and pays the verified dispute fee.                  | Yes                    |
| `resolve-unmatched` | Resolves a dispute after an unanswered counter-evidence deadline.            | Yes                    |
| `message`           | Sends a message to the other party.                                          | No                     |
| `thread`            | Reads the task message thread.                                               | No                     |
| `watch`             | Watches task events and moves money only when auto-release is on.            | Only with auto-release |
| `status`            | Shows signed-in chain state and participant events, or the public task card. | No                     |

The local CLI and MCP share these verbs. Hosted API availability can lag the local tools; unsupported operations report the server error without claiming success.

## CLI

Every implemented command accepts `--json`. Most commands, including delivery, write one JSON value to stdout. Watch writes newline-delimited event values followed by its summary, error or approval result. If scope signing succeeds but the following escrow creation fails, sign writes the accepted scope result before the global error. Diagnostics go to stderr. Select the acting wallet with `--account <name>`, the legacy `--wallet <name>`, `VAPI_WALLET`, or the default account, in that order. Sign-in uses the wallet's device-link bearer from `vapi login`. Public reads are anonymous when no token exists.

```sh
vapi task search [--open] [--min <usd>] [--tab trending|new|closing|paid] [--limit <n>]
vapi task show <id> [--account <name>]
vapi task pending [--account <name>]
vapi task checkin <id> --status on-track|blocked|need-input [--note <text>] [--link <url>] [--account <name>]
vapi task post --title <text> --brief <file|-> --deadline <duration|ISO> [--shape task|bounty|pool] [--amount <usd>] [--milestone "amount|acceptance|deadline"...] [--proof <preset>[:mustContain]...] [--checkin none|6h|24h|72h|7d] [--winners <n> --reward-per-winner <usd> --choice-window <sec>] [--reward-per-claim <usd> --budget <usd> --gate open|proven --verifier poster|vapi --open-check allowlist|invite] [--fund] [--yes] [--no-wait] [--timeout 120s] [--intake proposals|submissions] [--max-awards <k>] [--webhook <https-url>] [--account <name>]
vapi task propose <id> --price <usd> --duration <duration> --note <text> [--account <name>]
vapi task submit <id> [--proof <https-url>...] [--file <path>...] [--withdraw] [--proposal-id <id>] [--account <name>]
vapi task award <id> <proposalId> [--account <name>]
vapi task sign <id> [--yes] [--no-wait] [--timeout 120s] [--counterparty <0x…>] [--account <name>] [--json]
vapi task fund <id> [--yes] [--no-wait] [--timeout 120s] [--counterparty <0x…>] [--account <name>] [--json]
vapi task deliver <id> --files <path...> --note <text> [--no-wait] [--timeout 120s] [--counterparty <0x…>] [--account <name>] [--json]
vapi task release <id> [--no-wait] [--timeout 120s] [--counterparty <0x…>] [--account <name>] [--json]
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

Scope acceptance derives the local role from the order: the poster is the client at `clientAddress`, while the worker is the provider at the accepted proposal's `providerAddress`. It does not trust a server role label. The client verifies the other party's existing signature, then stores the accepted scope identity, derived role, local signer and counterparty under the local tasks directory before submitting the local signature. Money actions derive buyer and seller from this binding and compare them with onchain parties. Server-returned addresses cannot replace the binding.

Before signing, the CLI shows the direction, counterparty, amount, deadline and local signer. Signing requires `--yes` or, in an interactive non-JSON terminal outside CI, the prompt `Sign this scope? [y/N]`. Without consent in non-interactive mode it exits `3` with approval needed and does not sign or create the local binding.

Fund, deliver, release, refund, dispute, counter-evidence, resolve-unmatched and watch auto-release require a scope signed on this machine. `--counterparty` only confirms the counterparty already stored in that local binding; it cannot import or recover a scope accepted in the console or on another machine. JSON and MCP scope results expose the verified address as `terms.counterparty`. The current scope payload does not contain parties. A follow-up in vapi-app must introduce `work-scope-signature-v2` with buyer and seller inside the signed payload.

Base Sepolia pins default work and review durations to 604800 seconds. Locally configured defaults use `tasksEscrowDurationOverrides`, alongside `tasksEscrowFactoryOverrides`. Environment overrides are `VAPI_TASKS_WORK_DURATION_SECONDS_<chainId>` and `VAPI_TASKS_REVIEW_WINDOW_SECONDS_<chainId>`. A missing signed work duration requires a trusted local default; server readiness defaults are never used to authorize a duration.

Dispute runs fee approval followed by raise-dispute. Counter-evidence runs fee approval followed by submit-counter-evidence and requires the non-opener before the onchain deadline. Resolve-unmatched requires the deadline to have passed without counter-evidence. Existing operations resume through receipt verification and reconciliation without signing a second time, even if an earlier transaction consumed its fee allowance.

Recovery stores prepare keys and inputs, then reuses the exact saved bytes only for the same operation and step. Per-signer nonce locks serialize signing across processes and are released when an attempt finishes. Funding reservations are isolated per milestone and remain recorded when an error might have exposed an authorization or transaction. A known pre-broadcast failure invalidates its reservation proof before releasing the reservation. Server confirmation requires a successful RPC receipt and a valid confirmation envelope. Errors omit raw transactions and authorization signatures. Transaction recording and reconciliation retry temporary server conflicts for up to 30 seconds.

Funding, dispute and counter-evidence apply policy before any payment authorization or fee transaction is reserved or signed. It selects the agent profile whose wallet matches the acting wallet, or schema defaults when none matches; JSON reports `policySource: "agent-profile"` or `policySource: "defaults"`. The per-task cap comes from that profile, while the daily cap combines the wallet's `perDayAtomic` with local spend recorded in `VAPI_HOME/spend-ledger.json`. Once an authorization may have left the machine, a failed operation keeps its reservation; rollback is limited to a typed pre-broadcast failure that confirms the authorization was not exposed. `--yes` grants approval only and never bypasses a cap. A cap refusal exits `2` as `{ok:false,reason:"policy.perTask"|"policy.perDay",money}`. When approval is needed outside an interactive terminal, funding and fee actions exit `3` as `{ok:false,approval:true,money}`. In an interactive non-JSON terminal outside CI it asks `[y/N]`; declining exits `1` with code `not_approved` and message `Not approved; nothing was signed.`

The per-task cap is the running total of all escrow funding and dispute fees reserved for one task.

Fund, release, refund and resolve-unmatched print gross · fee · net from the deployed `feeBp`; if the fee cannot be read they print `fee unavailable`. Dispute and counter-evidence print the verified dispute fee before acting. The fee is 10% of the onchain escrow amount, floored to base units and clamped between 20 and 500 USDC. Fee reservations count toward the daily cap and stay reserved after an approval may have left the machine. Explicit release and refund follow the requested action without an automatic-release policy gate.

Delivery accepts 1 to 20 regular files. `--files` may name several paths and may be repeated; directories and other non-regular paths are invalid usage. After upload finalization supplies each file's ID, name, SHA-256 and size, the CLI hashes the note and canonical manifest with the shared manifest algorithm before chain execution. Dispute and counter-evidence accept only an already prepared `0x`-prefixed 64-hex-character evidence hash. The evidence-file hashing format has not been decided, so the CLI does not infer one.

Watch polls `events(id, { after: cursor, wait: 0 })`, advances its cursor and ignores duplicate events. `--interval` defaults to `5s` and must be at least one second; `--timeout` defaults to `7d` and must be positive. `--until` accepts `open`, `awarded`, `funded`, `delivered`, `paid`, `released`, `refunded`, `disputed`, `expired`, `closed`, `completed` `cancelled`, `checkin`, `stalled`, `claimed`, `judging` or `milestone`. With `--auto-release`, an amount strictly below `autoReleaseBelowUsd` is released automatically only while the current milestone remains delivered with submitted escrow; historical delivery events for settled or disputed milestones are ignored. An amount at or above that threshold requires interactive approval or exits `3` in non-interactive mode.

A route this server does not offer reports `<verb> is not available on this server yet.` with code `not_available` and exit `1`. A `403` with `insufficient_scope` asks you to run `vapi login` again. An explicit missing task remains a missing-task error.

| Exit code | Meaning                                                               |
| --------- | --------------------------------------------------------------------- |
| `0`       | Ok                                                                    |
| `1`       | Error, including invalid usage, unavailable routes and chain failures |
| `2`       | Policy refusal                                                        |
| `3`       | Approval needed in non-interactive mode                               |

At exit `1`, invalid usage has JSON `{ok:false,error:{code:"usage_error",message}}`. At exit `2`, policy refusal JSON has `ok:false`, `reason: "policy.perTask"` or `reason: "policy.perDay"`, and `money`. Other thrown task errors use the same nested error object with their specific code. Funding and fee approval exits use `{ok:false,approval:true,money}`. Scope signing without non-interactive consent exits `3` as `{ok:false,approval:true,reason:"approval_needed",terms}` plus the standard task output metadata.

Sign, fund, deliver and release wait up to `120s` for vAPI to index a confirmed transaction. `--no-wait` skips polling, while `--timeout` changes the limit. An indexing timeout prints a status command and keeps exit code `0` because the transaction succeeded.

## Tasks v2

```sh
# One worker, two milestones; amounts sum to the budget.
vapi task post --title "Research shortlist" --brief brief.md --amount 100 --deadline 7d \
  --shape task --milestone "30|Shortlist approved|3d" \
  --milestone "70|Intros completed|7d" --proof link --checkin 24h

# Three winners, 25 USDC each. The total escrow budget is 75 USDC.
vapi task post --title "Record the demo" --brief brief.md --deadline 3d \
  --shape bounty --winners 3 --reward-per-winner 25 --choice-window 604800 \
  --proof x-post:vAPI --proof media

# Each verified claim earns 5 USDC from a 100 USDC budget.
vapi task post --title "Try the demo" --brief brief.md --deadline 7d \
  --shape pool --reward-per-claim 5 --budget 100 --gate proven --verifier poster

vapi task checkin <id> --status blocked --note "Waiting for access" --link https://example.com/proof
vapi task pending --json
vapi task submit <id> --withdraw
```

`--shape` defaults to `task`. Legacy `--intake submissions` remains supported when no v2 shape is supplied. A task accepts one to five `--milestone` values; each deadline accepts a duration or ISO timestamp and must be at least ten minutes away. If `--amount` is omitted, milestone amounts determine the task budget. Bounties default to one winner and a seven-day choice window. Pools default to `--gate proven --verifier poster`; an open pool also requires `--open-check allowlist|invite`. Membership is configured separately on the hosted service.

Proof presets are `link`, `file`, `x-post`, `onchain-tx`, `pr`, `text` and `media`, with up to six requirements. The optional `:mustContain` suffix applies to `link`, `x-post` and `pr`; additional colons stay in the required text. `media` shorthand accepts both photo and video. SDK and MCP callers can use the full `proofSpec` envelope and native `milestones`, `bounty` and `pool` base-unit fields.

The HTTP SDK remains in `@vapi-network/core/tasks`. For the hosted canonical views and one-call preparation, SDK code uses `createHostedTasksClient` from `@vapi-network/mcp` (also available as `mcp.createHostedTasksClient` in `vapi-network`). The adapter returns unsigned intents; it never signs:

```ts
import { createHostedTasksClient } from "@vapi-network/mcp";

const tasks = createHostedTasksClient({ baseUrl, token });
const shown = await tasks.show(taskId);
console.log(shown.lifecycle, shown.nextAction);
const pending = await tasks.pending();
```

Check-ins accept `on-track`, `blocked` and `need-input`. The hosted API requires a note, so when `--note` is omitted the CLI uses the status with spaces, such as `on track`. Check-in links are recorded as HTTP(S) references. `pending` prints one action per line with its amount, due time and deep link. Withdrawal needs no signature: the CLI selects the acting wallet's single active submission, or accepts `--proposal-id` explicitly. Proof and file options cannot be combined with withdrawal.

Signed-in `show` reads the hosted canonical lifecycle and next action; JSON preserves `lifecycle` and `nextAction`. Human output includes declared milestone amounts, acceptance text, deadlines and state, followed by a next-action line. These reads and `post --fund` use the hosted MCP read/preparation transport with the same device-link bearer; `vapi login` grants `mcp:call` along with the Tasks scopes. No authorization is signed on the hosted service.

`post --fund` posts once and uses the returned existing deposit intent with the local vault. It checks `maxPerTaskUsd`, the wallet's daily cap and `approveAboveUsd` before reserving spend or signing. `--yes` grants threshold approval and cannot override caps. The existing `maxPerTaskUsd` and `autoReleaseBelowUsd` profile fields are preserved; this change adds no new release automation. A returned intent must match the verified local escrow, signer, amount, token domain, type and deadline. The same scope binding and onchain verification as `task fund` apply.

The T7 hosted implementation returns the created task plus `funding.error` for fresh posts until create-and-fund is available: `funding_requires_accepted_scope`, `bounty_funding_not_available_yet` or `pool_funding_not_available_yet`. CLI JSON retains both the task and that error and exits `1`; local MCP returns the same error with the task. No success is invented for unsupported funding. The existing task path remains award → sign → worker creates escrow → fund.

`task fund` first probes `GET /v1/tasks/:id/fund`. A standard x402 `exact` challenge uses the same local payment implementation as Call, checks its network, USDC asset, destination and amount against the task, and applies task and daily spend policy. Local scope and escrow verification still apply. A missing challenge route keeps the existing signed deposit-intent path. Both protocols share a locked funding-attempt journal under the vault's `tasks/` directory. Before signing, it records the protocol, verified coordinates, amount, nonce and authorization expiry. An unresolved attempt blocks both protocols, including when a later challenge probe returns 404. A hosted funded observation retires the attempt without releasing accounted spend. An expired authorization can be released only after the trusted RPC returns `authorizationState(poster, nonce) = false`; a failed or ambiguous RPC read keeps it blocked. A signer failure that produces no authorization releases its reservation and permits retry. x402 funding is tested with recorded responses; the live T26 route has not been verified.

Both funding paths poll the hosted escrow state unless `--no-wait` is supplied. They print `escrow funded` only after a hosted funded observation. `--no-wait` and an indexing timeout retain a pending result; payment acknowledgement alone is insufficient. `watch` also understands `task.checkin`, `task.stalled`, `task.claimed`, `task.judging`, `task.milestone` and `task.released`. Judging prints `deadline passed, N submissions, pick winners`; event JSON retains the original payload.

## MCP

The CLI and MCP share the same policy and core functions. Each CLI verb maps to a local MCP tool:

| CLI verb            | MCP tool                  |
| ------------------- | ------------------------- |
| `search`            | `tasks.search`            |
| `show`              | `tasks.show`              |
| `pending`           | `tasks.pending`           |
| `checkin`           | `tasks.checkin`           |
| `post`              | `tasks.post`              |
| `propose`           | `tasks.propose`           |
| `submit`            | `tasks.submit`            |
| `milestone`         | `tasks.milestone`         |
| `cancel`            | `tasks.cancel`            |
| `claim`             | `tasks.claim`             |
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

## V2 participant writes

Hosted V2 writes are off by default. No deployed V2 tuple or live write has been
verified for these commands. Wire contracts follow vapi-app `tasks-v1`, PR #490
(T11) and integration PR #493. V1 proposal awards, scope signing and escrow
operations keep their existing path when the hosted API selects V1.

```sh
vapi task milestone <id> --index 0 submit --proof https://example.com/delivery
vapi task milestone <id> --index 0 submit --file ./delivery.txt --note "Ready for review"
vapi task milestone <id> --index 0 approve
vapi task milestone <id> --index 0 reject --reason "Include the requested proof"
vapi task milestone <id> --index 0 finalize
vapi task cancel <id> offer
vapi task cancel <id> remainder
vapi task cancel <id> expire
vapi task sign <id> --action award-consent
vapi task award <id> --worker 0x...
vapi task award <id> --winners 0x...,0x...
vapi task sign <id> --action split-consent --index 0 --to-worker 12000000
vapi task dispute <id> --action split --index 0 --to-worker 12000000
vapi task fund <id>
vapi task refund <id>
vapi task dispute <id> --index 0 --evidence "Evidence text"
vapi task counter-evidence <id> --index 0 --evidence "Counter-evidence text"
vapi task resolve-unmatched <id> --index 0
vapi task claim <id> --claimant 0x...
vapi task status <id> --operation <uuid> --step v2-fund --recover
vapi task status <id> --operation <uuid> --step v2-fund --abandon
```

Action indices are **zero-based C0 indices (0–4)**. Posted milestone declarations
remain one-based. `--to-worker` takes exact USDC base units (six decimals), not
USD. Milestone submission accepts repeated HTTPS `--proof` and local `--file`
arguments as submission does; `--proof-json <file>` accepts the hosted preset
ProofFill array for text, media, PR and onchain transaction proofs. Rejection
requires a reason. A bounty award sends the entire winners list in one
`awardBounty` plan. Pool `claim --claimant` pays an existing signed claim as the
pool verifier; claim admission is separate.

The worker signs `award-consent` before the poster awards the task. A negotiated
split requires the other party's `split-consent` with the same index and amount.
The CLI and SDK sign the exact EIP-712 data returned by the API, confirm that
signature with the API, and follow its returned transaction plans. They construct
no calldata. The existing vault stores and signs locally. Before any funding or
dispute fee signature, the CLI checks `maxPerTaskUsd`, approval thresholds and
the daily cap, then reserves the amount the wallet pays with `reserveSpend`.
Escrow payouts do not charge that amount again. MCP cannot grant human approval;
the CLI accepts `--yes` under the existing policy rules.

Human output shows gross · fee · net before signing. JSON stdout contains one
result; the money line goes to stderr and the result includes `money`,
`lifecycle`, `nextAction`, and the operation ID/state. For running orders the fee
comes from the hosted immutable V2 snapshot. Missing required money data refuses
the action. Stable hosted errors such as `v2_writes_disabled`,
`chain_preflight_unavailable`, `v2_binding_mismatch`,
`v2_funding_snapshot_unavailable` and `v1_order` retain their codes.

Approval, pool creation and action steps run in sequence. A failed step stops the
sequence. Signed transaction bytes and preparation keys persist in the local
pending journal; retrying the original command resumes its hosted operation.
The CLI and SDK poll order-level confirm/reconcile and recover responses without
requiring a milestone row, and reports completion only after hosted confirmation.
V2 always waits for that confirmation, including when legacy `--no-wait` was
supplied. Bounded polling returns `operation_pending` if it cannot confirm; it
never prints a completion line on that path. `status --operation --step` resumes
hosted recovery scans; a prepared result means rerun the original action to sign
the remaining plan. Abandon scans until the API permits abandonment or returns a
recovered operation. It never clears local signed bytes or spend reservations.

The corresponding local tools are `tasks.milestone {id,action,i,proof?,reason?}`,
`tasks.cancel {id,scope}`, `tasks.award {id,worker|winners}`,
`tasks.sign {id,action,i?,toWorker?}`, `tasks.claim {id,action:"pay",claimant}`,
and the existing money tools with V2 indices/evidence where applicable.
`tasks.status {id,operationId,step,abandon?}` handles journal recovery. All tools
have plain top-level object schemas. The SDK exposes `prepareV2`, `signV2`,
`confirmV2Signature`, `operationV2`, `executeTaskV2` and `recoverTaskV2`; custom
legacy transport and signing adapters can keep the original interface.
