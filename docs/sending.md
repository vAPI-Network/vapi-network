# Sending between accounts

`vapi send` moves USDC from one linked account to the owner or another active account. The sending account signs on this machine. vAPI relays the transfer and pays the gas, so sending is free.

## Send from the terminal

Name the amount, sending account, and recipient. Base is the default network. Use `--network arc` to send on Arc.

```sh
vapi send 2 --from research --to writer
vapi send 2 --from research --to owner --network arc
```

The recipient may be `owner`, an active account name, or the address of the owner or an active account. A revoked account and an unrelated address are refused before signing. The sender's per-call and per-day caps apply to every `vapi send` transfer.

## What the account signs

The account signs one EIP-3009 `transferWithAuthorization`. It names one exact recipient and amount, and expires after 10 minutes. The key stays on this machine, and the relay receives only the authorization and its signature.

The core API also accepts `purpose: "sweep"` when the recipient is the owner. An owner sweep is exempt from the sender's caps because it returns funds to the owner. A sweep to another account is refused.

## Distribute from one account

Distribute splits one amount across several local accounts. Name recipients with `--to`, or omit it to select every other linked, active account on this device.

```sh
vapi accounts distribute 10 --from main --to research,writer,reviewer
vapi accounts distribute 10 --from main
```

The split uses whole cents in recipient order. A 10 USDC split over three accounts sends 3.34, 3.33, and 3.33 USDC. The first account receives every remainder cent.

The command checks the sender's balance, largest-leg per-call cap, and remaining per-day cap before signing. It then signs and relays one EIP-3009 authorization per recipient in order. A failed leg does not stop the later legs.

Every distribution is written to `~/.vapi/movements/` before its first signature. An unfinished movement blocks another distribution from the same account. Continue it with the movement id printed by the command.

```sh
vapi accounts distribute --resume mv_0123456789abcdef
```

Resume skips sent legs and reuses the recorded nonce for any authorization that may still settle.

A failed leg remains unfinished when it is retryable or its transfer journal records a signed authorization. Every restored nonterminal leg also remains unfinished, even when its receipt is missing and the failure is not retryable. Automatic ceiling enforcement and `vapi sweep` do not sweep that account until the leg becomes terminal. This prevents an earlier signed sweep and a later sweep from both settling.

Movement files created by 0.7.0 may not contain sender and recipient addresses. Resume binds them from the signed authorization journal when it exists. Otherwise it prints the current address for each account name and signs nothing. Check those addresses, then accept them from a terminal:

```sh
vapi accounts distribute --resume mv_0123456789abcdef --bind-legacy-addresses
```

The result reports the accepted addresses. This flag is unavailable through MCP.

A distribution restored from backup keeps local restored markers that are not part of the backup plaintext. If its recorded authorization expires, or the transfer was not yet signed when the backup was taken, resume refuses to sign because the original device may have paid the transfer with a later nonce. Check the sending address's balance and explorer history named in the error. If the transfer was not paid, replace it deliberately from a terminal:

```sh
vapi accounts distribute --resume mv_0123456789abcdef --replace-expired-restored
```

This flag is unavailable through MCP.

## Cancel a movement that cannot resume

Use the terminal-only cancel command when an address change or another permanent conflict prevents resume:

```sh
vapi accounts distribute --cancel mv_0123456789abcdef
```

Cancel never signs or relays a transfer. It checks every non-sent leg before changing the movement. A journaled sent receipt or settled on-chain nonce becomes `sent` instead of `cancelled`.

An unsigned `planned` or `failed` leg can be cancelled. A signed non-restored leg can be cancelled only after the chain proves its authorization expired. The command refuses the entire movement while a non-restored leg is unknown or may still settle.

Without an override, cancel applies a stricter rule to every restored leg. It marks a restored leg `sent` only when the journal contains a sent receipt or an on-chain check proves its saved nonce settled. Otherwise it refuses the whole movement without changing the movement or spend ledger.

Review the sending account's balance and explorer history before abandoning a restored leg. Then run the terminal-only override:

```sh
vapi accounts distribute --cancel mv_0123456789abcdef --replace-expired-restored
```

The override cancels restored legs without signed journal evidence. A signed restored leg still needs an on-chain check. A settled nonce becomes `sent`, an expired nonce becomes `cancelled`, and a pending nonce or failed check refuses the whole cancellation. The command signs nothing. MCP cannot invoke cancel or set the override.

Cancellation releases the expired authorization's daily-cap reservation. It prints a balance command for each sender. Check those balances before starting another movement. Cancelled legs no longer block distributions, ceiling sweeps, rename, or removal.

## Continue an unknown transfer

An interrupted relay can leave the outcome unknown: a timeout, a lost connection, a `409 in_progress`, or a `503` from the relay, which vAPI answers when it cannot yet tell whether the transfer landed. The spend stays reserved because the authorization may already be in progress. Do not start another transfer for the same intent.

The local receipts ledger keeps the signed authorization needed to continue. Run the same command with the nonce printed by the first attempt. `--resume` sends that authorization again without signing another one.

```sh
vapi send 2 --from research --to writer --resume 0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
```

## Send from MCP

The `accounts.send` tool accepts `from`, `to`, `amountUsd`, and an optional `network` of `base` or `arc`. It always applies per-call and per-day caps. An unknown result tells the user to continue with `vapi send --resume` in a terminal.
