# Task commands

Tasks is an onchain task market with USDC escrow, delivery, review and disputes. Tasks V2 is live on Base mainnet (chain 8453). Solidproof signed off the audit on 23 November 2026. The platform fee is 0% at launch; the owner Safe may raise it to at most 20%. Each task and each pool budget is capped at 5,000 USDC. Disputes cost 10% of the milestone, with a 20 USDC minimum and 500 USDC maximum.

The task SDK in `@vapi-network/core/tasks` talks to the vAPI task API and builds delivery manifests. The CLI verbs below use its shared actions. The local MCP server exposes the same task verbs.

| Verb                 | What it does                                                                 | Moves money            |
| -------------------- | ---------------------------------------------------------------------------- | ---------------------- |
| `search`             | Browses public tasks.                                                        | No                     |
| `show`               | Shows lifecycle, milestones, next action and receipts.                       | No                     |
| `pending`            | Lists the acting wallet's pending actions.                                   | No                     |
| `checkin`            | Records a worker check-in.                                                   | No                     |
| `post`               | Posts a task, bounty or pool; no new pool on Base mainnet. Optional funding. | Only with `--fund`     |
| `profile`            | Shows, creates or updates your provider profile and its verification.        | No                     |
| `offer`              | Lists, publishes, changes or pauses your services.                           | No                     |
| `propose`            | Proposes terms for a task.                                                   | No                     |
| `submit`             | Submits proof for an open bounty.                                            | No                     |
| `milestone`          | Submit, approve, reject, finalize or close a rejected V2 milestone           | On approve/finalize    |
| `cancel`             | Cancel a V2 offer, unpaid remainder or expire                                | Refunds only           |
| `claim`              | Pay a stored pool claim as its verifier                                      | Yes                    |
| `award`              | Awards a proposal or submission.                                             | No                     |
| `sign`               | Signs scope or V2 consent, or revokes consent nonces.                        | No                     |
| `fund`               | Locks USDC in escrow.                                                        | Yes                    |
| `deliver`            | Delivers files and a note through a manifest hash.                           | No                     |
| `release`            | Pays the worker from escrow.                                                 | Yes                    |
| `refund`             | Returns escrowed USDC to the poster.                                         | Yes                    |
| `dispute`            | Raises a dispute and charges the contract dispute fee.                       | Yes                    |
| `counter-evidence`   | Submits counter-evidence and pays the verified dispute fee.                  | Yes                    |
| `resolve-unmatched`  | Resolves a dispute after an unanswered counter-evidence deadline.            | Yes                    |
| `close-rejected`     | Closes a rejected milestone after its late window.                           | Refunds only           |
| `bump-consent-nonce` | Revokes outstanding consents for this escrow.                                | No                     |
| `prune-reviewer`     | Prunes an ineligible reviewer seat.                                          | No                     |
| `prune-reviewers`    | Prunes ineligible reviewer seats.                                            | No                     |
| `jury`               | Opens, draws, rearms or resolves the V2 jury on a disputed milestone.        | No                     |
| `vote`               | Commits a sealed jury vote, or reveals it from the local ballot.             | No                     |
| `approve-bond`       | Approves the verified escrow to collect the agreed worker bond.              | Yes                    |
| `claim-owed`         | Pulls a payout the escrow could not send to this wallet.                     | Yes                    |
| `reviewer-status`    | Shows a wallet's jury reviewer readiness from the chain.                     | No                     |
| `message`            | Sends a message to the other party.                                          | No                     |
| `thread`             | Reads the task message thread.                                               | No                     |
| `watch`              | Watches task events and moves money only when auto-release is on.            | Only with auto-release |
| `status`             | Shows signed-in chain state and participant events, or the public task card. | No                     |

The local CLI and MCP share these verbs. The [coverage table](./tasks-coverage.md) compares them with the hosted service. Unsupported operations report the server error without claiming success.

## CLI

Every implemented command accepts `--json`. Most commands, including delivery, write one JSON value to stdout. Watch writes newline-delimited event values followed by its summary, error or approval result. If scope signing succeeds but the following escrow creation fails, sign writes the accepted scope result before the global error. Diagnostics go to stderr. Select the acting wallet with `--account <name>`, the legacy `--wallet <name>`, `VAPI_WALLET`, or the default account, in that order. Sign-in uses the wallet's device-link bearer from `vapi login`. Public reads are anonymous when no token exists.

```sh
vapi task search [--open] [--min <usd>] [--tab trending|new|closing|paid] [--limit <n>] [--json]
vapi task show <id> [--account <name>] [--json]
vapi task pending [--account <name>] [--json]
vapi task checkin <id> --status on-track|blocked|need-input [--note <text>] [--link <url>] [--account <name>] [--json]
vapi task post --title <text> --brief <file|-> --deadline <duration|ISO> [--shape task|bounty|pool] [--amount <usd>] [--milestone "amount|acceptance|deadline"...] [--proof <preset>[:mustContain]...] [--checkin none|6h|24h|72h|7d] [--winners <n> --reward-per-winner <usd> --choice-window <sec>] [--reward-per-claim <usd> --budget <usd> --gate open|proven --verifier poster|vapi --open-check allowlist|invite] [--fund] [--yes] [--no-wait] [--timeout 120s] [--intake proposals|submissions] [--max-awards <k>] [--webhook <https-url>] [--account <name>] [--json]
vapi task profile [--name <text> --bio <file|-> --skill <text>...] [--language <name>...] [--location <text>] [--photo <path>|--remove-photo] [--account <name>] [--json]
vapi task offer [<offerId>] [--title <text>] [--description <file|->] [--package <tier>:<usd>:<time>:<summary>...] [--category general-digital|software-api|research-data|design-content] [--skill <tag>...] [--pause|--resume] [--account <name>] [--json]
vapi task propose <id> --price <usd> --duration <duration> --note <text> [--account <name>] [--json]
vapi task submit <id> [--proof <https-url>...] [--file <path>...] [--withdraw] [--proposal-id <id>] [--account <name>] [--json]
vapi task milestone <id> --index N submit|approve|reject|finalize|close-rejected [--proof <https-url>...] [--file <path>...] [--proof-json <file>] [--note <text>] [--reason <text>] [--json]
vapi task cancel <id> offer|remainder|expire [--json]
vapi task claim <id> --claimant <addr> [--json]
vapi task award <id> [<proposalId>|--worker <addr>|--winners a,b,c] [--account <name>] [--json]
vapi task sign <id> [--action award-consent|split-consent|bump-consent-nonce --index N --to-worker <base-units> --new-nonce N] [--yes] [--no-wait] [--timeout 120s] [--counterparty <0x…>] [--account <name>] [--json]
vapi task fund <id> [--yes] [--no-wait] [--timeout 120s] [--counterparty <0x…>] [--account <name>] [--json]
vapi task deliver <id> --files <path...> --note <text> [--no-wait] [--timeout 120s] [--counterparty <0x…>] [--account <name>] [--json]
vapi task release <id> [--no-wait] [--timeout 120s] [--counterparty <0x…>] [--account <name>] [--json]
vapi task refund <id> [--counterparty <0x…>] [--account <name>] [--json]
vapi task dispute <id> [--evidence-hash <0x + 64 hex>|--index N --evidence <text>] [--action raise|resolve-unmatched|split --to-worker <base-units>] [--yes] [--counterparty <0x…>] [--account <name>] [--json]
vapi task counter-evidence <id> [--evidence-hash <0x + 64 hex>|--index N --evidence <text>] [--yes] [--counterparty <0x…>] [--account <name>] [--json]
vapi task resolve-unmatched <id> [--index N] [--counterparty <0x…>] [--account <name>] [--json]
vapi task close-rejected <id> --index N [--account <name>] [--json]
vapi task bump-consent-nonce <id> --new-nonce N [--account <name>] [--json]
vapi task prune-reviewer <id> --reviewer <address> [--account <name>] [--json]
vapi task prune-reviewers <id> --reviewers a,b,c [--account <name>] [--json]
vapi task jury <id> --index N --step open|draw|rearm|resolve [--account <name>] [--json]
vapi task vote <id> --index N (--commit worker|poster|split [--to-worker <base-units>] | --reveal) [--account <name>] [--json]
vapi task approve-bond <id> [--yes] [--account <name>] [--json]
vapi task claim-owed <id> [--to <0x…>] [--account <name>] [--json]
vapi task reviewer-status [--address <0x…>] [--account <name>] [--json]
vapi task message <id> <text> [--account <name>] [--json]
vapi task thread <id> [--after <cursor>] [--account <name>] [--json]
vapi task watch <id> [--until <state>] [--auto-release] [--timeout 7d] [--interval 5s] [--counterparty <0x…>] [--account <name>] [--json]
vapi task status <id> [--operation <uuid> --step <v2-step> --recover|--abandon] [--account <name>] [--json]
vapi task --help
```

The block above is the usage section of `vapi task --help`. `award <id> <proposalId>` awards a V1 proposal and is not available on Base mainnet, which runs V2 only. On mainnet the worker runs `sign --action award-consent` and the poster then runs `award --worker <addr>`. Without `--action`, `sign` is the V1 scope signature. `dispute` and `counter-evidence` take `--index` with `--evidence` on V2 and `--evidence-hash` on V1.

Durations accept `5s`, `10m`, `48h`, `7d`, or an ISO-8601 timestamp. A task deadline and every task milestone deadline must be at least 3 hours ahead when vAPI receives the post. That is one hour of work time on the contract, one hour to award and one hour to fund. The client asks for one minute on top, so the shortest accepted task deadline is `181m`. Bounty and pool posting require at least ten minutes. Before creation and funding, task milestones must also leave the verified contract’s `MIN_WORK_TIME` from the trusted chain clock. Signed proposal and submission terms require a duration between ten minutes and 90 days. USD amounts have up to six decimal places. Webhooks and proof URLs require HTTPS. File proofs use the sha256 returned after upload finalization.

Hosted `tasks.confirm` completes signing intents and advances chain operations. It is separate from the local CLI verbs documented above.

Posting a task without `--fund` moves no money. The fee line shows gross · fee · net. On a chain with a local V2 pin, the client reads `feeBp()` and the size limit from the pinned factory. It reads `maxEscrowAmount()` for a task or bounty and `maxPoolBudget()` for a pool. A total above that limit is refused before anything is posted. A bounty counts winners times reward. Without a local pin, or when the read fails, the fee comes from vAPI and an absent fee shows “fee unavailable”; the API and the contract still enforce the limit. The CLI stores amount, deadline, intake and max awards in the order market metadata, then configures an optional webhook through the order webhook endpoint.

Search applies `--open` and `--min` to the returned board page, including the pinned task. Tab and limit are sent to the board. Thread `--after` accepts the previous page's `nextBeforeSeq`. The SDK supports backward pagination through `beforeSeq`, so this reads older messages.

Show uses the authenticated task route when a bearer exists; otherwise it reads the public card. Status reads chain state and participant events when signed in, or the public card without sign-in. Public cards define `receiptUrl`, which is printed as supplied by the server. Private task milestones have `escrowContract` but no receipt URL field; settled milestones get `<origin>/receipts/<escrowContract>`, labeled as derived from escrow in human output and `receiptUrlSource: "escrow"` in JSON. All settled milestones remain listed in `receipts`.

A server with Tasks enabled provides public search, status, submissions, events and participant routes. OAuth reads require `tasks:read`; writes require `tasks:write`, which also grants read access. Proposals and submissions locally sign the exact canonical JSON payload.

### Legacy V1 scope and recovery

The following scope-binding rules apply to the retained V1 compatibility path.
V2 uses the verified deployment and participant write path described below.

Scope acceptance is signed by the local vault account and requires `tasks:write`. Worker acceptance may create an unfunded escrow with the same local signer. Fund, deliver, release, refund, dispute, counter-evidence, resolve-unmatched and watch auto-release submit their transactions from the selected local vault wallet. Base Sepolia reads `BASE_SEPOLIA_RPC_URL` and defaults to `https://sepolia.base.org`. It trusts escrow factory `0x6Ba83621eb386B3E093032096251cA504F6ee033`. Configure another chain, or override that pin, with `VAPI_TASKS_ESCROW_FACTORY_<chainId>`. Chains without a trusted factory are rejected before signing.

Before signing a chain action, the client reads the factory payment token and the token's EIP-712 name and version through the trusted RPC. It verifies that each escrow clone belongs to that factory and matches the buyer, seller, token, amount, terms hash, state and deadline. It also recomputes the accepted scope hash locally and verifies both party signatures. A money verb rejects a task with more than one possible milestone instead of guessing; watch may use an event's `milestoneId` for auto-release. Clone addresses must match the trusted factory prediction for the bound seller and the milestone salt. Review windows match signed acceptance terms; work durations match signed terms or a locally trusted default. Storage reads are checked against public getters; an unsupported layout is refused.

Scope acceptance derives the local role from the order: the poster is the client at `clientAddress`, while the worker is the provider at the accepted proposal's `providerAddress`. It does not trust a server role label. The client verifies the other party's existing signature, then stores the accepted scope identity, derived role, local signer and counterparty under the local tasks directory before submitting the local signature. Money actions derive buyer and seller from this binding and compare them with onchain parties. Server-returned addresses cannot replace the binding.

Before signing, the CLI shows the direction, counterparty, amount, deadline and local signer. Signing requires `--yes` or, in an interactive non-JSON terminal outside CI, the prompt `Sign this scope? [y/N]`. Without consent in non-interactive mode it exits `3` with approval needed and does not sign or create the local binding.

Fund, deliver, release, refund, dispute, counter-evidence, resolve-unmatched and watch auto-release require a scope signed on this machine. `--counterparty` only confirms the counterparty already stored in that local binding; it cannot import or recover a scope accepted in the console or on another machine. JSON and MCP scope results expose the verified address as `terms.counterparty`. The current scope payload does not contain parties. A later scope format will carry buyer and seller inside the signed payload.

Base Sepolia pins default work and review durations to 604800 seconds. Locally configured defaults use `tasksEscrowDurationOverrides`, alongside `tasksEscrowFactoryOverrides`. Environment overrides are `VAPI_TASKS_WORK_DURATION_SECONDS_<chainId>` and `VAPI_TASKS_REVIEW_WINDOW_SECONDS_<chainId>`. A missing signed work duration requires a trusted local default; server readiness defaults are never used to authorize a duration.

Dispute runs fee approval followed by raise-dispute. Counter-evidence runs fee approval followed by submit-counter-evidence and requires the non-opener before the onchain deadline. Resolve-unmatched requires the deadline to have passed without counter-evidence. Existing operations resume through receipt verification and reconciliation without signing a second time, even if an earlier transaction consumed its fee allowance.

Recovery stores prepare keys and inputs, then reuses the exact saved bytes only for the same operation and step. Per-signer nonce locks serialize signing across processes and are released when an attempt finishes. Funding reservations are isolated per milestone and remain recorded when an error might have exposed an authorization or transaction. A known pre-broadcast failure invalidates its reservation proof before releasing the reservation. Server confirmation requires a successful RPC receipt and a valid confirmation envelope. Errors omit raw transactions and authorization signatures. Transaction recording and reconciliation retry temporary server conflicts for up to 30 seconds.

Funding, dispute and counter-evidence apply policy before any payment authorization or fee transaction is reserved or signed. It selects the agent profile whose wallet matches the acting wallet. An account without a profile uses the limits its owner set with `vapi accounts caps`, or the defaults. JSON reports `policySource` as `agent-profile`, `account` or `defaults`. The per-task cap comes from that source, while the daily cap combines the wallet's `perDayAtomic` with local spend recorded in `VAPI_HOME/spend-ledger.json`. Once an authorization may have left the machine, a failed operation keeps its reservation; rollback is limited to a typed pre-broadcast failure that confirms the authorization was not exposed. `--yes` grants approval only and never bypasses a cap. A cap refusal exits `2` as `{ok:false,reason:"policy.perTask"|"policy.perDay",money}`. When approval is needed outside an interactive terminal, funding and fee actions exit `3` as `{ok:false,approval:true,money}`. In an interactive non-JSON terminal outside CI it asks `[y/N]`; declining exits `1` with code `not_approved` and message `Not approved; nothing was signed.`

The per-task cap is the running total of all escrow funding and dispute fees reserved for one task. A poster who funded a 100 USDC task under a 100 USD per-task cap cannot raise a dispute on it until that cap is raised, because the fee is at least 20 USDC. [Limits before you fund](#limits-before-you-fund) lists every limit and the command that changes it.

Fund, release, refund and resolve-unmatched print gross · fee · net from the deployed `feeBp`; if the fee cannot be read they print `fee unavailable`. Dispute and counter-evidence print the verified dispute fee before acting. The fee is 10% of the onchain escrow amount, floored to base units and clamped between 20 and 500 USDC. Fee reservations count toward the daily cap and stay reserved after an approval may have left the machine. Explicit release and refund follow the requested action without an automatic-release policy gate.

Delivery accepts 1 to 20 regular files. `--files` may name several paths and may be repeated; directories and other non-regular paths are invalid usage. After upload finalization supplies each file's ID, name, SHA-256 and size, the CLI hashes the note and canonical manifest with the shared manifest algorithm before chain execution. On the V1 path, dispute and counter-evidence accept only an already prepared `0x`-prefixed 64-hex-character evidence hash. The evidence-file hashing format has not been decided, so the CLI does not infer one. On V2, which is the only path on Base mainnet, both take `--index` and `--evidence <text>` and the client checks the hash in the prepared transaction against that text.

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

## Tasks V2 on Base mainnet

Tasks V2 is live on Base mainnet (chain 8453). Solidproof signed off the audit on 23 November 2026. The platform fee is 0% at launch; the owner Safe may raise it to at most 20%. Each task and each pool budget is capped at 5,000 USDC. Disputes cost 10% of the milestone, with a 20 USDC minimum and 500 USDC maximum.

Pools use poster verification at launch; the automatic checker is off.
Evidence and vote commitment windows last 48 hours each; the reveal window lasts 24 hours.
vAPI Guardians are reviewers. A Guardian needs 10,000 vAPI staked and a vAPI ID,
then registers a seat and sets availability. Seat, stake and availability must mature
through the 24-hour warm-up. The registry has 250 seats. Keep stake through reveal.

`vapi task post --fund` posts and funds in one call with the local vault, and `vapi task fund <id>` funds a posted task. Both need vAPI to report Tasks as available; see [hosted availability](#hosted-availability). Work is divided into milestones with amounts, deadlines and acceptance criteria.
The worker submits each milestone, then the poster reviews it during the review window.
Approval releases payment; rejection sends the milestone back to the worker. Finalization releases eligible deliveries after the review window.
Refund returns eligible remaining funds to the poster.

The poster may dispute a fresh (submitted) delivery. The worker never disputes its own fresh delivery.
A rejected milestone becomes disputable by either side after 2 rejections, or after 1 rejection once the milestone deadline has passed.
Fewer than 3 eligible reviewers ends the round immediately. With 3 to 20, all eligible reviewers join the jury; above 20, 5 are drawn.
A verdict needs at least 3 revealed votes and a strict majority. Round 1 without a verdict restores the pre-dispute state. Round 2 without a verdict makes the status quo final: disputed, with no dispute winner (outcome cause 6).
The dispute fee is 10% of the milestone, minimum 20 USDC, maximum 500 USDC, which can be above 20% of a small milestone.
A worker who delivered on time keeps the bond on a voluntary refund. There is no mediation and no appeal.

### What the client completes alone

| Shape  | Through this client alone | What is missing                                                                                                                                           |
| ------ | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Task   | Yes                       | Nothing. The worker runs `sign --action award-consent`, the poster runs `award --worker <addr>`, then `milestone` and `refund` cover the rest.            |
| Bounty | No                        | A winner needs an onchain entry commitment, and this client has no commit step. Workers commit on vapinetwork.ai or through the hosted MCP.               |
| Pool   | No                        | The client pays a stored claim with `claim --claimant`, but it cannot submit a claim or close a pool. It funds a pool only when the verifier is `poster`. |

vAPI decides which shapes a network accepts. On Base mainnet today an agent can post and fund a task and a bounty. A new pool is refused there for now: `vapi task post --shape pool` prints `shape_unavailable: Pools are not available yet.` and nothing is posted, and funding one prints `shape_unavailable: Pools cannot be funded yet.` A pool that is already funded keeps working, so `claim --claimant` still pays its claims.

A funded bounty has no cancel. Its USDC returns only after the deadline plus the choice window, through `cancel <id> expire`. Post a bounty from this client only when the workers will enter it elsewhere.

`propose` sends an offer the poster can read on the task. It needs vAPI to report Tasks as available. `award <id> <proposalId>` awards such an offer off chain and is V1 only. On Base mainnet the poster hires on chain instead: the worker runs `sign --action award-consent`, then the poster runs `award --worker <addr>`.

### Hosted availability

Before a step that starts new work, the client reads `GET /api/tasks/readiness`. Those steps put new USDC into Tasks (`fund`, `post --fund`, `approve-bond`) or hire a worker (`sign --action award-consent`, `award --worker`). When that document says `configured: false`, or cannot be read, the client stops before anything is prepared, signed, sent or counted against a cap. The message is `vAPI reports Tasks as unavailable on Base right now. Nothing was signed and no money moved. Try again later.` and the error code is `tasks_unavailable`. Hiring waits because an award turns an offer the poster can still cancel into an engagement and collects the worker's bond. vAPI switches the same steps off while Tasks is paused.

The readiness document never decides which contract receives money. The chain ID and the contract addresses are pinned in the client, and every target is verified on chain before a signature. The client also requires the chain of a prepared step to equal the `chainId` in that document.

Every other step acts on work that is already running. That covers milestone actions, `award --winners` for a bounty, cancel, refund, claim, dispute, counter-evidence, jury steps, votes and `claim-owed`. Those steps do not depend on `configured`, so a hosted flag cannot hold back a payout, a refund or an answer to a dispute.

An operation that already signed something is not a first run. When a command is interrupted after a signature, for example after its transaction was sent, run the same command again. The client then resumes the saved operation, and it does not ask about availability, the size limit or the wallet balance, because the money may already have moved.

What the rerun does depends on the saved transaction of the last step, the one that moves the money:

- The node reports it as mined. The rerun signs nothing and sends nothing. It reports the transaction to vAPI and waits for the confirmation. It is not asked about the per-task limit, the daily cap, approval, the 30-minute authorization window or the deadline again, and the amount stays counted once, on the day it was reserved.
- It is saved but not mined, or the node cannot be asked. The rerun sends the same bytes again. The limits, approval, the authorization window and the deadline are checked as on a first run. On the day it was reserved the amount is counted once; a rerun on a later day counts it against that day's cap as well.
- It was never signed. That step still waits while Tasks is unavailable, and the message says that this step was not signed and that anything signed earlier stands. The same holds for a funding authorization whose amount was reserved but which was never signed: the message is `No new signature was made. An authorization signed earlier stays valid until it expires.`

vAPI makes a funding authorization valid for 30 minutes. One that ran out before anything was signed is dropped, and the next `vapi task fund` asks vAPI for a new one. One that was signed is kept, also after it ran out. If its transaction was never signed, the rerun then stops with `v2_plan_mismatch` and names the time window. The expired authorization can no longer move money, but this client does not replace a signed authorization: its amount stays counted, and the task has to be posted again to be funded from this account.

A consent leaves no transaction and no reserved amount on this machine. When `vapi task sign --action award-consent` is run again while Tasks is unavailable, the client cannot know whether the first run signed and uploaded the consent. The message then says that this run signed nothing and moved no money, that an earlier consent may still be valid until it expires, and that `vapi task bump-consent-nonce <id> --new-nonce <n>` revokes it.

`vapi task status <id> --operation <uuid> --step <v2-step> --recover` reconciles one step without the wallet.

### Limits before you fund

Several limits apply to one funding. Each refusal happens before anything is signed.

| Limit              | Default           | Applies to                                                                                                        | Change it                                               |
| ------------------ | ----------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Per-day cap        | 1 USD             | All spending of the account in one UTC day, including task funding                                                | `vapi accounts caps <name> --per-day <usd>`             |
| Per-task cap       | 100 USD           | Funding plus dispute fees for one task                                                                            | `vapi accounts caps <name> --max-per-task <usd> --yes`  |
| Approval threshold | 0.50 USD          | Any funding or fee above it needs a person's approval                                                             | `vapi accounts caps <name> --approve-above <usd> --yes` |
| Live size limit    | 5,000 USDC        | One task, one bounty total or one pool budget, enforced by the contract                                           | Set by the contract owner                               |
| Account ceiling    | 5 USDC            | A linked account sweeps its balance above the ceiling, or above the per-day cap when that is higher, to its owner | `vapi accounts caps <name> --ceiling <usd\|off>`        |
| Wallet balance     | Your USDC and ETH | The funding amount in USDC and gas in ETH on Base                                                                 | Send both to the account address                        |

The CLI grants approval with `--yes` or an interactive prompt. Local MCP cannot grant approval, so an agent funds through MCP only up to the approval threshold of its account. Raise that threshold in a terminal first. Raising `--max-per-task` or `--approve-above` is a decision for a person. In a terminal it asks for a typed `yes`, or takes `--yes`. It is refused, with or without `--yes`, when standard input is not a terminal or when an agent session is detected through a variable such as `CLAUDECODE`. Lowering either value needs no confirmation and works everywhere. A value above 1,000,000 USD is refused, and a per-task cap above the live size limit prints a note. An account with an agent profile stores both values in the profile, and `vapi agent create` sets them with the same option names. Any other account stores them on its entry in `wallets.json`. They are not part of a backup, so set them again after a restore. Creating an agent profile for an account clears a value on that account that is above the default and keeps one that is below it, so removing the profile later returns the account to the default or to the owner's stricter value, never to an old raise. `vapi agent create` for an account that already exists follows the same rule for a person: from an agent session or without a terminal it refuses `--max-per-task`, `--approve-above` or `--call-budget` above what the account has.

Leave room for a dispute. Its fee is 10% of the milestone, at least 20 and at most 500 USDC, and it counts toward the same per-task cap as the funding.

Fresh funding sends up to three transactions (create the escrow, approve USDC, fund), reads the chain many times and waits for two confirmations. Set `BASE_RPC_URL` to your own Base endpoint for that; the default is the public `https://mainnet.base.org`.

The CLI verbs and matching local MCP tools are listed in [MCP](#mcp).
Use `milestone` for submit, approve, reject, finalize and close-rejected; use `dispute`, `counter-evidence` and `resolve-unmatched` for disputes.
Jury and vote commands are described in [jury steps](#v2-jury-and-reviewer-steps).

Base mainnet uses the verified local pins below. No deployment overrides are needed.
Base Sepolia (84532) remains available only with a complete explicit local V2 override.
The following commands are templates; replace files and identifiers with your own values.

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
# Not on Base mainnet for now: vAPI answers shape_unavailable.
vapi task post --title "Try the demo" --brief brief.md --deadline 7d \
  --shape pool --reward-per-claim 5 --budget 100 --gate proven --verifier poster

vapi task checkin <id> --status blocked --note "Waiting for access" --link https://example.com/proof
vapi task pending --json
vapi task submit <id> --withdraw
```

`--shape` defaults to `task`. Legacy `--intake submissions` remains supported when no v2 shape is supplied. A task accepts one to five `--milestone` values; each deadline accepts a duration or ISO timestamp and must be at least 3 hours ahead when vAPI receives the post, so use `181m` or more. Before creation and funding, every milestone is also checked against the trusted chain clock plus the verified contract’s `MIN_WORK_TIME`; allow extra time to award the task. If `--amount` is omitted, milestone amounts determine the task budget. Bounties default to one winner and a seven-day choice window. Pools default to `--gate proven --verifier poster`; an open pool also requires `--open-check allowlist|invite`. Membership is configured separately on the hosted service.

Proof presets are `link`, `file`, `x-post`, `onchain-tx`, `pr`, `text` and `media`, with up to six requirements. The optional `:mustContain` suffix applies to `link`, `x-post` and `pr`; additional colons stay in the required text. `media` shorthand accepts both photo and video. SDK and MCP callers can use the full `proofSpec` envelope and native `milestones`, `bounty` and `pool` base-unit fields.

The HTTP SDK remains in `@vapi-network/core/tasks`. For the hosted canonical views and one-call preparation, SDK code uses `createHostedTasksClient` from `@vapi-network/mcp` (also available as `mcp.createHostedTasksClient` in `vapi-network`). The adapter returns unsigned intents; it never signs:

```ts
import { createHostedTasksClient } from "@vapi-network/mcp";

const tasks = createHostedTasksClient({ baseUrl, token });
const shown = await tasks.show(taskId);
console.log(shown.lifecycle, shown.nextAction);
const pending = await tasks.pending();
```

Check-ins accept `on-track`, `blocked` and `need-input`. The hosted API requires a note, so when `--note` is omitted the CLI uses the status with spaces, such as `on track`. Check-in links are recorded as HTTP(S) references. `pending` prints one action per line with its amount, due time and deep link. Stored-entry withdrawal needs no signature: the CLI selects the acting wallet's single active submission, or accepts `--proposal-id` explicitly. Proof and file options cannot be combined with withdrawal. V2 bounty commitments and chain withdrawals are not yet supported by this client; a stored entry alone is not an onchain commitment. See [action coverage](./tasks-coverage.md).

Signed-in `show` reads the hosted canonical lifecycle and next action; JSON preserves `lifecycle` and `nextAction`. Human output includes declared milestone amounts, acceptance text, deadlines and state, followed by a next-action line. These reads and `post --fund` use the hosted MCP read/preparation transport with the same device-link bearer; `vapi login` grants `mcp:call` along with the Tasks scopes. No authorization is signed on the hosted service.

`post --fund` posts once and uses the returned existing deposit intent with the local vault. It checks `maxPerTaskUsd`, the wallet's daily cap and `approveAboveUsd` before reserving spend or signing. `--yes` grants threshold approval and cannot override caps. The existing `maxPerTaskUsd` and `autoReleaseBelowUsd` profile fields are preserved; this change adds no new release automation. A returned intent must match the verified local escrow, signer, amount, token domain, type and deadline. The same scope binding and onchain verification as `task fund` apply.

When vAPI reports Tasks as unavailable, `post --fund` stops before the task is posted. The client retains a created task when the server returns `funding.error`, and reports the funding failure. Do not post again to retry funding. V2 funding uses hosted preparation, local deployment verification and local signing. The legacy scope path remains award → sign → worker creates escrow → fund.

`task fund` first probes `GET /v1/tasks/:id/fund`. A standard x402 `exact` challenge uses the same local payment implementation as Call, checks its network, USDC asset, destination and amount against the task, and applies task and daily spend policy. Local scope and escrow verification still apply. A missing challenge route keeps the existing signed deposit-intent path. Both protocols share a locked funding-attempt journal under the vault's `tasks/` directory. Before signing, it records the protocol, verified coordinates, amount, nonce and authorization expiry. An unresolved attempt blocks both protocols, including when a later challenge probe returns 404. A hosted funded observation retires the attempt without releasing accounted spend. An expired authorization can be released only after the trusted RPC returns `authorizationState(poster, nonce) = false`; a failed or ambiguous RPC read keeps it blocked. A signer failure that produces no authorization releases its reservation and permits retry. x402 funding is tested with recorded responses; availability depends on the server.

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
| `jury`              | `tasks.jury`              |
| `vote`              | `tasks.vote`              |
| `approve-bond`      | `tasks.approve-bond`      |
| `claim-owed`        | `tasks.claim-owed`        |
| `reviewer-status`   | `tasks.reviewer-status`   |
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

Tasks V2 runs on Base mainnet (chain 8453) against the contracts pinned in the
client. The hosted API decides per task whether a V2 write is available. When it
reports a V1 order or V2 writes switched off, commands keep the V1 path, and an
explicitly requested V2 action is refused with `v2_writes_disabled`. V1 proposal
awards, scope signing and escrow operations keep their existing path when the
hosted API selects V1.

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

Action indices are **zero-based milestone indices (0–4)**. Posted milestone declarations
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

Creation, approval and action steps run in sequence. Each V2 transaction is signed with a 25%
buffer over the node's gas estimate; unused gas is not charged. A failed step stops the
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

V2 signing also requires a **local deployment trust anchor**. The V2 pin map is
empty until the deployment record is verified. Hosted readiness,
intent recipients and operation destinations cannot supply that trust. With no
pin or explicit override the command returns `v2_trust_unavailable` before a
signature. For staging, configure all six chain-specific variables, for example:

```sh
VAPI_TASKS_V2_ESCROW_FACTORY_84532=0x...
VAPI_TASKS_V2_DISPUTE_RESOLVER_V3_84532=0x...
VAPI_TASKS_V2_POOL_FACTORY_84532=0x...
VAPI_TASKS_V2_USDC_84532=0x...
VAPI_TASKS_V2_USDC_NAME_84532='USD Coin'
VAPI_TASKS_V2_USDC_VERSION_84532=2
```

The guard reads the current contracts: the factory's `paymentToken()`, the clone's
`FACTORY()`, `USDC()`, `terms()` and `totalPrincipal()`, and consent nonces from
`consentNonces()` under the `vAPI Tasks Escrow` version `2` EIP-712 domain. Its ABI
entries are copied directly from the audited contract JSON files by
`node scripts/sync-tasks-v2-abi.mjs <contracts/abi directory>` (`--check` reports a stale
copy); never edit `packages/core/src/tasks/v2-abi.generated.ts` by hand.

Cloud inputs use the `VAPI_NETWORK_` prefix. Every override is logged to stderr as
“untrusted override”; SDK callers can supply `trustedV2Deployments` and
`onV2UntrustedOverride` in the chain options. Factory membership, poster, token,
amounts and on-chain terms are checked through the configured RPC. Every
registered-target action must match the order's accepted terms hash and the
pinned factory's prediction with that order's salt. The acting wallet must hold
the on-chain role required by the action; award consent comes from the prospective
worker before assignment. The money confirmation preview includes the verified
escrow address. Before signing, the client durably saves the accepted chain,
escrow and terms hash locally. Every later V2 write and consent must match that
binding; hosted metadata cannot replace it, including after a restart or failed
signature confirmation.

Fresh funding follows the hosted sequence: `createEscrow` (or `createPool`) on the
pinned factory, a USDC approval of the new clone, then `fund()` on the clone; with
an EIP-3009 authorization a task is created and funded in one
`createAndFundWithAuthorization` call. The client predicts the clone from accepted
order terms, local defaults and the pinned factory's `feeBp()`; `objectionWindow`
is app metadata set to the accepted review window; every creation input (the complete `IEscrowV2.Terms`
tuple, the milestones and the order salt) must match that prediction. An accepted bounty choice window takes precedence
over local defaults. Unset offer TTL and choice windows default to 604800 seconds;
staging can explicitly set
`VAPI_TASKS_V2_OFFER_TTL_SECONDS_<chainId>` and
`VAPI_TASKS_V2_CHOICE_WINDOW_SECONDS_<chainId>`, or the SDK pin's
`offerTtlSeconds` and `choiceWindowSeconds`. `VAPI_TASKS_V2_REVIEW_WINDOW_SECONDS_<chainId>`
(SDK `reviewWindowSeconds`) pins the review default in the same V2 tuple. The optional
`VAPI_TASKS_V2_EVIDENCE_WINDOW_SECONDS_<chainId>` (SDK `evidenceWindowSeconds`)
also accepts a positive safe integer; it records local evidence-window configuration. An unset review window uses the existing
local trusted duration setting. These are local decisions, never hosted
readiness values. Creation plans must match accepted terms and the pinned
factory's prediction. A hosted
signature intent lacks the frozen creation arguments needed to verify an
undeployed recipient, so that authorization is refused until the recipient can
be independently verified. Pool funding also requires its on-chain verifier to
be the accepted poster; an independently trusted delegated checker is not yet
configured. Funding authorizations require the exact pinned USDC
domain and schema, a 32-byte nonce, a start before the chain clock and an expiry at
most one hour after it.

Every transaction selector, destination and requested index/amount is checked
before signing. Funding, dispute fees and the worker bond approve only the verified
clone, for the exact amount paid. Unmatched settlement requires a verified disputed
milestone and the clone resolver's `caseData` (Raised, the same opener, an elapsed
evidence deadline) before its money preview. Voluntary refunds include pending and submitted milestones; cancelling
an unpaid remainder includes pending milestones only.

Post-with-funding persists its original unsigned operation or intent and
idempotency key before an approval refusal. `task fund <id> --yes` resumes that
preparation without creating a conflicting hosted operation.

## V2 jury and reviewer steps

A matched V2 dispute goes to a jury of reviewers on DisputeResolverV3. The rules:

- Fewer than 3 eligible reviewers ends the round immediately. With 3 to 20, all eligible reviewers join the jury; above 20, 5 are drawn.
- A verdict needs at least 3 reveals and a strict majority.
- Round 1 without a verdict restores the pre-dispute state. Round 2 without a verdict makes the status quo final: disputed, with no dispute winner (outcome cause 6).
- There is no mediation or appeal.

```sh
vapi task jury <id> --index 0 --step open
vapi task jury <id> --index 0 --step draw
vapi task jury <id> --index 0 --step rearm
vapi task vote <id> --index 0 --commit worker
vapi task vote <id> --index 0 --commit split --to-worker 40000000
vapi task vote <id> --index 0 --reveal
vapi task jury <id> --index 0 --step resolve
vapi task approve-bond <id>
vapi task claim-owed <id> [--to 0x...]
vapi task reviewer-status [--address 0x...]
```

| Step                  | Hosted write action                           | Contract call                                                    | Who may run it                                      |
| --------------------- | --------------------------------------------- | ---------------------------------------------------------------- | --------------------------------------------------- |
| `jury --step open`    | `open-jury`                                   | `openJury`, then `continueJury` while the case is `Snapshotting` | Anyone, after the dispute is matched                |
| `jury --step draw`    | `draw-jury`                                   | `drawJury`                                                       | Anyone, inside the draw window                      |
| `jury --step rearm`   | `rearm-draw`                                  | `rearmDraw`                                                      | Anyone, after a missed draw window                  |
| `jury --step resolve` | `resolve`                                     | `resolve`                                                        | Anyone, after the reveal window                     |
| `vote --commit`       | `commit-vote` with the commitment             | `commitVote`                                                     | An eligible or drawn reviewer, in the commit window |
| `vote --reveal`       | `reveal-vote` with outcome, toWorker and salt | `revealVote`                                                     | The reviewer that committed, in the reveal window   |
| `approve-bond`        | `approve-bond`                                | USDC `approve(escrow clone, bond)`                               | The awarded or intended worker                      |
| `claim-owed`          | `claim-owed`                                  | `claimOwed(to)` on the escrow clone                              | Any account the escrow owes                         |

`vote --reveal` first reads the resolver's `caseData` and the chain clock: it refuses with
`reveal_not_open` until the commit deadline has passed, `reveal_window_closed` after the reveal
deadline and `reveal_unavailable` outside the voting stage, so the salt never reaches vAPI while
others can still commit. `jury --step open` on a matched case refuses with `evidence_window_open` until
the case's `evidenceDeadline` has passed.

Every step follows the V2 participant write pattern: the hosted API prepares the plan through
`POST /v1/work-orders/{id}/writes`, the client verifies it locally, signs with the local vault and
confirms. Indices are zero-based milestone indices. `jury --step open` repeats while the case is
`Snapshotting`, because a registry larger than one snapshot batch needs several `continueJury` calls.
Jury and vote steps move no USDC from the acting wallet; `resolve` pays out from escrow by the
verdict.

The plan guard pins the resolver through the verified escrow. It reads `DISPUTE_RESOLVER()` from the
clone that the pinned factory registered and requires every jury and vote plan to target that
address. The required `VAPI_TASKS_V2_DISPUTE_RESOLVER_V3_<chainId>` pin (SDK `disputeResolverV3`),
read with the other V2 override variables, must agree with it. The guard decodes each plan with the DisputeResolverV3 ABI and compares
the selector, escrow, index, commitment, outcome, `toWorker` and salt to the requested step. A bond
approval must approve exactly the bond `EscrowV2.award` collects, the clone's `totalPrincipal()` × its
`terms().workerBondBp` / 10,000, to the verified clone. That on-chain rate must equal the accepted
order terms (it is also part of the frozen terms hash); a rate from the hosted response alone is
never used. The poster cannot run it, and it counts against the task and daily caps as escrow
funding.
`claim-owed` must call `claimOwed` on the verified clone with `--to`, or the acting wallet when
`--to` is absent.

Vote salts stay with the agent. `vote --commit` generates a 32-byte salt locally and computes the
commitment on this machine, exactly as DisputeResolverV3 does:
`keccak256(abi.encode(escrow, i, round, reviewer, outcome, toWorker, salt))`. Only the public
dispute round (`disputeRound`) and case id are read over RPC, and the case id must match that round.
It writes the ballot to
`VAPI_HOME/tasks/ballots/<chainId>/<resolver>/<caseId>/<commitment>.json` with mode 0600 and an
fsync before it requests the commit plan. Only the commitment goes to vAPI. A retry with the same
vote reuses its sealed ballot. `vote --reveal` reads this wallet's onchain `commitments(caseId,
voter)` and opens only the ballot with that commitment, so a replaced ballot whose commit never mined
is never revealed. Reveal from the machine that committed; without the ballot there is nothing to
reveal. Outcomes are `worker`, `poster` and `split` (DisputeResolverV3 order 0, 1, 2). `--to-worker`
is USDC base units and only for `split`.

Trust boundaries for a ballot:

- Until reveal, the vote and its salt stay on this machine. The commit sends only the commitment to
  vAPI and to the chain, and neither the RPC nor vAPI sees the vote or the salt.
- At reveal, the vote and its salt go to the hosted vAPI API, which prepares the reveal transaction,
  and then to the chain through your RPC in the signed transaction. After the reveal is mined the
  vote is public chain data.

Results, progress and errors carry the commitment, case and ballot path, and reveal calldata is
shown as `[redacted: reveal calldata]`. Plain `show` and `status` drop every `salt` field, and the
calldata and ballot fields of any commit or reveal vote step, at any depth. Outside the chain's
`v2State` they also replace any text that quotes a ballot key with `[redacted]`, and drop
`outcome` and `toWorker` from an object that carries both, or either one next to `ballot`, `vote`,
`commitment` or `reveal`. Revealed votes in `v2State` stay. A `show` or `status` error whose message
has a 32-byte hex value or mentions an outcome, toWorker, ballot, salt or vote gets a fixed message
with only the HTTP status; a server code that is not short snake case becomes `http_<status>`. If
the dispute moves to a new round between sealing and signing, the commit stops with
`v2_round_changed` and nothing is signed; vote again in the new round. A hosted error on a commit or reveal
step is never copied, because it may echo the request: it becomes `v2_vote_rejected` with a fixed
message. Results, errors and `status --operation` recovery or abandon output carry only documented
fields, down to each lifecycle milestone and the next action; unknown hosted fields are dropped and
reveal calldata is redacted by step and by selector. During `status --operation` recovery or abandon,
any failed hosted call, the order refresh included, is replaced whatever `--step` names: it becomes
`v2_vote_rejected` for a commit or reveal step and `v2_recovery_failed` otherwise, with only the HTTP
status kept.

`reviewer-status` reads the chain directly. It takes the resolver from the pinned escrow factory's
task implementation (`implementation()` then its immutable `DISPUTE_RESOLVER()`; the factory has no
resolver getter), which must match the local `disputeResolverV3` pin, then reads the registry seat (`isReviewer`), the vAPI ID
(`hasId`), the stake (`stakedBalance` on the gate's `staking()`) against the gate `threshold()`, the
gate's `isEligible`, and the resolver's `available`, `suspended`, `missedReveals` and `claimable`.
`ready` means these current checks pass. Warm-up, frozen case membership and historical
stake checks still apply; it does not guarantee a draw or a vote.

MCP tools: `tasks.jury {id,i,step}`, `tasks.vote {id,i,action,outcome?,toWorker?}`,
`tasks.approve-bond {id}`, `tasks.claim-owed {id,to?}` and `tasks.reviewer-status {address?}`. The
local MCP server uses the same ballot store.

Reviewer writes (`set-available`, `reactivate`, `claim-reviewer-fee`) are not in the CLI yet. They
need an order-less hosted route, which vAPI does not offer yet; until then use the hosted MCP
`tasks.reviewer` tool.

## Audit-3 contract compatibility

The SDK copies all functions, events and errors for the nine Tasks V2 contracts from
`contracts/abi` at `tasks-v2-audit-3` (`fcc670908`), preserving Apache-2.0 provenance.
Refresh with `node scripts/sync-tasks-v2-abi.mjs <contracts/abi directory>`; add `--check`
to verify byte-for-byte reproducibility. `decodeTaskV2Event(contractKind, log)` decodes
logs, including `DisputeFeesSettled`, `ConsentNonceBumped`, `RoundEndedWithoutJury`,
`ReviewerPruned` and `SurplusSwept` (pool and resolver). The caller
must verify the emitting address before choosing the contract kind.

SplitConsent includes `uint32 round` immediately after `milestone`, equal to the
verified escrow's `disputeRounds(i) - 1`. Offers are usable only before the jury opens.
`bump-consent-nonce` revokes the caller's outstanding award and split consents for
that escrow; the new nonce must exceed its current nonce and be at most uint128 max.
Revocation requires a saved local target binding and refuses when that binding is
unavailable, so a hosted response cannot redirect revocation to another clone.

The draw window is `HISTORY_WINDOW = 8,191` blocks, strictly after `drawBlock` and
inclusive of `drawBlock + 8,191`. `rearmDraw` is available only after that boundary.
There are at most three rearms; the next expired attempt ends the round without a jury.
`caseData` includes `rearms`. Fewer than three eligible reviewers also ends the round.

`mayVote` reports jury membership only; it does not promise that a vote will pass
stake or deadline checks. Do not touch your stake until you have revealed; even a
cancelled unstake can cost the vote. Seat, availability and stake have warm-up rules.

The permissionless maintenance verbs use the same hosted prepare/confirm flow and
local plan verification as other writes. Pruning targets the registry read from the
verified escrow's pinned resolver and does not change frozen juries:

```sh
vapi task close-rejected <id> --index 0
vapi task bump-consent-nonce <id> --new-nonce 7
vapi task prune-reviewer <id> --reviewer 0x...
vapi task prune-reviewers <id> --reviewers 0x...,0x...
```

`closeRejected` closes a rejected milestone after its late window when the remainder
has closed; its principal goes to the poster. Pruning an eligible seat reverts.
MCP equivalents are `tasks.close-rejected {id,i}`, `tasks.bump-consent-nonce {id,newNonce}`,
`tasks.prune-reviewer {id,reviewer}` and `tasks.prune-reviewers {id,reviewers}`.

## Verified Base mainnet deployment

The local trust table in `packages/core/src/tasks/v2-trust.ts` pins chain 8453.
All SDK, CLI and MCP checks use it. Hosted readiness cannot replace these pins.
The contracts are verified on Base mainnet and match the `tasks-v2-audit-3` suite.

| Contract            | Base mainnet address                         |
| ------------------- | -------------------------------------------- |
| EscrowFactoryV2     | `0x3586A4C92b55a83175D911aBA9B50329319E34BD` |
| DisputeResolverV3   | `0xEe36F3B19dcC38B6b5676B6cdcDd63a6d7Fbb435` |
| BountyPoolFactoryV1 | `0xD03264c27AE3900834d6C5ba85cd15C56B21452f` |
| USDC                | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |
| OutcomeRegistryV1   | `0xa4E8D29657f7B85886aBB8C02756aE43aD4872Aa` |
| ReviewerRegistryV2  | `0x9CABaE0013732fF8Fb3C779061000Ce582ae0cA6` |

USDC uses the EIP-712 domain name `USD Coin` and version `2`.
The offer TTL, review window and bounty choice window are 604800 seconds (seven days).
The evidence window is 172800 seconds (48 hours). The jury commit window is 48 hours;
the reveal window is 24 hours. These are separate from the seven-day delivery review window.

Base mainnet reads the configured RPC or `BASE_RPC_URL`; the default is `https://mainnet.base.org`.
Other chains, including Base Sepolia, require a complete explicit V2 override with factories,
resolver, USDC and its domain. Each override prints an untrusted-override notice.
Legacy V1 factory and duration overrides do not establish V2 trust.

See [action coverage](./tasks-coverage.md) for hosted actions that need additional client work.

The hosted close and nonce-revocation actions also accept their hosted action names locally:

```sh
vapi task milestone <id> close-rejected --index 0
vapi task sign <id> --action bump-consent-nonce --new-nonce 7
```

The dedicated close-rejected and bump-consent-nonce verbs remain available.
Reviewer pruning uses a verified task binding in this client; hosted pruning is deployment-scoped.
