---
title: "Sending and distributing"
description: "The vapi client sends USDC once or distributes it across local accounts while signing keys stay on the device."
order: 4
---

This page is for owners who want to send USDC once or distribute it across several local agent accounts.

Use `vapi send` for one transfer. Use `vapi accounts distribute` for a recorded multi-account plan. Both keep the signing key on this device while vAPI relays the transfer and pays the gas.

## Send one transfer

Send Base USDC to an active sibling account or back to the owner:

```bash
vapi send 2 --from research --to writer
vapi send 2 --from research --to owner
```

Add `--network arc` for Arc. The sender's per-call and per-day caps apply. The recipient must be the owner, an active account name, or the address of the owner or an active account.

List the owner's accounts on this device and other devices:

```bash
vapi accounts --all
```

Accounts on other devices are read-only in this list. Their keys and recovery data stay on their devices.

An interrupted relay can leave a transfer outcome unknown. Resume the recorded authorization with the nonce printed by the first attempt:

```bash
vapi send 2 --from research --to writer --resume <nonce>
```

Resume reuses the authorization. It does not sign a replacement.

## Distribute one amount

Name the recipients, or omit `--to` to select every other linked, active local account:

```bash
vapi accounts distribute 10 --from main --to research,writer,reviewer
vapi accounts distribute 10 --from main
```

The plan splits whole cents in recipient order. Any remainder cents go to the first account. Before signing, the client checks the sender's balance, the largest leg against its per-call cap, and the total against its remaining per-day cap.

The client writes every leg to `~/.vapi/movements/` before the first signature. It then signs and relays the legs in order. A failed leg does not stop later legs.

## Resume or cancel a movement

An unfinished movement blocks another distribution from the same sender. It also blocks automatic ceiling sweeps and `vapi sweep` while an authorization may still settle.

Resume with the movement ID printed by the command:

```bash
vapi accounts distribute --resume <movement-id>
```

Resume skips sent legs and keeps recorded nonces. This prevents two authorizations for the same intended transfer.

Cancel eligible unsent legs when a movement cannot resume:

```bash
vapi accounts distribute --cancel <movement-id>
```

Cancel never signs or relays a transfer. It reconciles sent evidence, cancels unsigned local legs, and cancels signed local legs only after the chain proves their authorizations expired. A pending authorization or failed chain check leaves the entire movement and spend ledger unchanged.

Cancellation releases eligible expired spend reservations. Cancelled legs no longer block later distributions, sweeps, renames, or removals.

![How one distribution runs and recovers, for example vapi accounts distribute 10 --from main. 1, Plan: the client splits whole cents per leg and checks the sender's balance and its per-call and per-day caps before signing. 2, Journal: every leg is written to ~/.vapi/movements/ before the first signature. 3, Sign and relay: the legs go out in order, a failed leg does not stop the next, and vAPI pays the gas. If the run is interrupted, the movement stays open: it blocks another distribution from the same sender, automatic ceiling sweeps and vapi sweep, so nothing is paid twice. Resume with vapi accounts distribute --resume and the movement ID: it signs and relays only what is left, skips sent legs and keeps recorded nonces, so one intended transfer never gets a second authorization. When a movement cannot resume, vapi accounts distribute --cancel never signs or relays; it reconciles sent legs, cancels unsigned legs, and cancels signed legs only after the chain proves their authorizations expired. A pending authorization or a failed chain check changes nothing. Never start a fresh transfer after an interruption: resume or cancel first. Cancelled legs stop blocking and release their spend reservations.](vapi-movements-light.svg)
![How one distribution runs and recovers, for example vapi accounts distribute 10 --from main. 1, Plan: the client splits whole cents per leg and checks the sender's balance and its per-call and per-day caps before signing. 2, Journal: every leg is written to ~/.vapi/movements/ before the first signature. 3, Sign and relay: the legs go out in order, a failed leg does not stop the next, and vAPI pays the gas. If the run is interrupted, the movement stays open: it blocks another distribution from the same sender, automatic ceiling sweeps and vapi sweep, so nothing is paid twice. Resume with vapi accounts distribute --resume and the movement ID: it signs and relays only what is left, skips sent legs and keeps recorded nonces, so one intended transfer never gets a second authorization. When a movement cannot resume, vapi accounts distribute --cancel never signs or relays; it reconciles sent legs, cancels unsigned legs, and cancels signed legs only after the chain proves their authorizations expired. A pending authorization or a failed chain check changes nothing. Never start a fresh transfer after an interruption: resume or cancel first. Cancelled legs stop blocking and release their spend reservations.](vapi-movements-dark.svg)

_Every leg is recorded before signing, so recovery never needs a fresh transfer. Orange marks where USDC moves._

## Keep balances below the ceiling

Accounts have a 5 USDC Base ceiling by default. A settled paid call and the status screen send excess funds to the account's parent. The owner is the parent for a normal account, and the treasury is the parent for a swarm member.

The per-day cap is the sweep floor. Set another ceiling or disable automatic ceiling sweeps from a terminal:

```bash
vapi accounts caps <name> --ceiling <usd>
vapi accounts caps <name> --ceiling off
```

Run a deliberate sweep to the linked owner, or supply another destination address:

```bash
vapi sweep --account <name>
vapi sweep <address> --account <name>
```

Resume or safely cancel an open movement before sweeping its sender.

## Terminal-only recovery flags

These flags require human review and are unavailable through MCP.

| Flag                         | Use it when                                                                                                       | Review before use                                                                                    |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `--cancel <movement-id>`     | A movement cannot resume and its unsent legs must be abandoned.                                                   | Check that no authorization can still settle. The command performs its own journal and chain checks. |
| `--replace-expired-restored` | A restored leg is unjournaled, expired, or was never signed when backed up. Use it with `--resume` or `--cancel`. | Check the sender's balance and explorer history for a payment made by the source device.             |
| `--bind-legacy-addresses`    | A local pre-0.8 movement lacks saved addresses and has no signed journal evidence. Use it with `--resume`.        | Compare the current sender and recipient addresses printed by the command before accepting them.     |

Examples after completing the stated review:

```bash
vapi accounts distribute --resume <movement-id> --replace-expired-restored
vapi accounts distribute --cancel <movement-id> --replace-expired-restored
vapi accounts distribute --resume <movement-id> --bind-legacy-addresses
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

## Next

- [Limits and ceilings](/agents/wallets/limits-and-ceilings/)
- [Backup and recovery](/agents/wallets/backup-and-recovery/)
- [Swarms](/agents/control/swarms/)

Checked on 2026-11-17.
