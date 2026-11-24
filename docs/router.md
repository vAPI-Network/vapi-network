# Router

Router and Stake are live on production. Router provides hosted inference at `router.vapinetwork.ai`, with OpenAI-compatible requests and an Anthropic-compatible `/v1/messages` endpoint with prompt-cache pricing. Staking vAPI earns a daily Router allowance called Compute, with reviewer eligibility for Tasks later. See [README.md](../README.md).

| Command                                       | Options                                                                 | What it does                                                                  |
| --------------------------------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `vapi router models`                          | `--account <name>`                                                      | Lists the vAPI Router model ids                                               |
| `vapi router usage`                           | `--account <name>`                                                      | Shows the agent's Compute allowance and Router balance                        |
| `vapi router chat --model <id> "<prompt>"`    | `--system <text>`, `--max-tokens <n>`, `--account <name>`               | Sends one chat request through vAPI Router                                    |
| `vapi router key`                             | `--rotate`, `--account <name>`                                          | Prints a gated Router key or rotates it without printing it                   |
| `vapi router clear-pending`                   | `--confirm-unpaid` or `--confirm-settled`, `--account <name>`, `--json` | Checks unpaid evidence or retires a settled purchase after saving its receipt |
| `vapi router buy <1\|5\|20\|50>`              | `--account <name>`, `--json`                                            | Buys vAPI Router balance with USDC from your wallet                           |
| `vapi router buy --auto <tier> --below <usd>` | `--account <name>`, or use `--auto off`                                 | Sets or clears automatic vAPI Router balance refill                           |
| `vapi stake status`                           | `--account <name>`                                                      | Shows the linked owner's stake and Compute today                              |
| `vapi stake open`                             | `--account <name>`, `--no-browser`                                      | Prints and optionally opens the staking page                                  |

`await vapi.router.openai()` returns the vAPI Router base URL and key for an
OpenAI-compatible framework. Use this in your own code. Do not pass it into a
model prompt.

Bought vAPI Router balance never expires and is used after the daily Compute
allowance runs out. Your wallet's client spend caps apply to every purchase,
including automatic refill.

## Purchase recovery

A payment authorization can be sent before settlement is confirmed. The CLI reports this state without claiming payment succeeded.
Purchase and chat-refill JSON include optional `receipt.settlement`, with `succeeded`, `rejected` or `unknown` as its value.
An unconfirmed authorization carries `settlement_unconfirmed`; do not repeat the purchase.
A rejected settlement is identified as rejected and never described as paid.
The signed journal remains available so the next Router request can check the chain.

A settled purchase can take time to appear in Router usage. The `credit_pending` warning identifies the purchase guarding your wallet.
While it remains pending, chat retries use the balance key and manual buys recover the earlier purchase without another payment.
Normal retirement requires a succeeded receipt in the local ledger and proof that the purchased credit is usable.
Usage proves credit when purchased balance reaches the recorded baseline plus the purchased tier under a current link with the same owner (case-insensitive) and API base.
A successful balance-key chat also proves credit. Older entries without a baseline require a successful balance-key chat.
`ensureRouterPurchaseReceipt` records the receipt; appends sync best effort. Retirement separately requires a strict sync of the ledger file and its parent directory. The file is opened without creating it, with write access only on Windows. Directory sync is skipped on Windows.
Receipt write or retirement sync failures retain the journal and allow balance-key chat to continue; `credit_pending` remains until retirement succeeds.

Relinking to the same owner and API base lets recovery fetch the balance key under the current link.
After relinking, usage reaching the recorded baseline plus the purchased tier or a successful balance-key chat proves credit for retirement.
A missing link or another owner or API base leaves the purchase pending and disables another purchase for that wallet.
Stake-key chat can continue under a valid current link with usable credentials, including another owner or API base; `pending_purchase_unlinked` names the payment and the retirement command.
With no link, chat returns `not_linked` and the error still carries `pending_purchase_unlinked`.
Login and logout wait for the purchase lock before changing the link. Logout bounds best-effort remote revocation, including its token refresh requests and response bodies, to ten seconds.
The deadline does not interrupt local waits for the wallet credential lock. Refresh checks that a link and its original token pair are still stored before writing rotated tokens; a shared credential publication lock makes that re-check and write exclusive with login and logout, and that lock adds no wait for a refresh's network request.

Inspect a pending purchase without clearing it:

```sh
vapi router clear-pending --account <name>
```

To retire a journal entry already marked settled, use explicit confirmation:

```sh
vapi router clear-pending --confirm-settled --account <name>
```

The command saves any missing succeeded receipt and prints the receipt id, transaction, amount and network before clearing.
It separately requires syncing the ledger file and, except on Windows, its parent directory before clearing; if a required sync fails, the journal stays pending.
Keep this evidence and contact support if the Router balance does not appear.
Retirement removes the guard against another purchase; check the earlier purchase before buying again.
The flag refuses prepared, signed and unknown entries, even if chain recovery might later prove settlement.
Retry chat to check the chain before deciding how to clear those entries.

Use unpaid confirmation only after verifying that the payment cannot settle:

```sh
vapi router clear-pending --confirm-unpaid --account <name>
```

This path checks receipt and nonce evidence, refuses paid attempts and live authorizations, and permits expired unused authorizations.
When chain evidence is unavailable, the flag records your explicit unpaid confirmation.
The two confirmation flags cannot be combined. MCP has no tool for retiring pending payment state.

With `--confirm-settled --json`, output follows the clear as one object.
It retains `wallet`, `pending` and `cleared`, and adds `receipt`, `receiptAppended` and `notice`.
The receipt contains `id`, `amountUsd`, `network` and an optional `transaction`; unavailable amounts remain `null`.
A second run finds no pending purchase and appends no additional receipt.
