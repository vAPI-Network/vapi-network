---
title: "How wallets work"
description: "A device vault holds separate local accounts with their own USDC balances, payment caps, and balance ceilings."
order: 2
---

This page is for owners and builders who need to understand how one owner, one device vault, and several agent accounts fit together.

One owner account controls links and Router allowances. It has a bound wallet and supports wallet, email and Google sign-in.
The embedded vAPI owner wallet is separate from local vault accounts. One device vault holds named accounts. Each account has its own USDC balance, spend caps, and balance ceiling.

The client also supports cloud recovery, durable movements, and swarm state.

![How one owner, one device vault and its accounts fit together. Your owner account opens through wallet, email or Google sign-in, approves links, and has a bound wallet. It links each account, sets its Router allowance, and can change its Router allowance or revoke its link. Each account sends USDC above its ceiling back to its parent in a ceiling sweep. The device vault at ~/.vapi/vault.json holds one 12-word phrase and opens with a device key kept in the operating system's secret store, or on Linux without a working keyring in ~/.vapi/secrets.json, encrypted with VAPI_VAULT_PASSWORD; each device has one vault. Three example accounts: main, derived at index 0, is active with 0.98 USDC for Call, $0.01 of a $1.00 Router allowance used today, caps of $0.05 a call and $1 a day, and a 5 USDC ceiling. researcher, derived at index 1, is paused with 0.50 USDC, $0.00 of $1.00 used today, and the same caps and ceiling. imported-1 uses an imported key encrypted in the vault; the phrase does not cover it, so only a cloud backup restores it, with vapi restore --from-owner. vapi restore brings back the derived accounts from the phrase. Each account pays per request on Call from its own USDC with x402, within its caps, and makes Router model calls within its allowance, which comes from the owner's Compute.](vapi-agents-wallets-light.svg)
![How one owner, one device vault and its accounts fit together. Your owner account opens through wallet, email or Google sign-in, approves links, and has a bound wallet. It links each account, sets its Router allowance, and can change its Router allowance or revoke its link. Each account sends USDC above its ceiling back to its parent in a ceiling sweep. The device vault at ~/.vapi/vault.json holds one 12-word phrase and opens with a device key kept in the operating system's secret store, or on Linux without a working keyring in ~/.vapi/secrets.json, encrypted with VAPI_VAULT_PASSWORD; each device has one vault. Three example accounts: main, derived at index 0, is active with 0.98 USDC for Call, $0.01 of a $1.00 Router allowance used today, caps of $0.05 a call and $1 a day, and a 5 USDC ceiling. researcher, derived at index 1, is paused with 0.50 USDC, $0.00 of $1.00 used today, and the same caps and ceiling. imported-1 uses an imported key encrypted in the vault; the phrase does not cover it, so only a cloud backup restores it, with vapi restore --from-owner. vapi restore brings back the derived accounts from the phrase. Each account pays per request on Call from its own USDC with x402, within its caps, and makes Router model calls within its allowance, which comes from the owner's Compute.](vapi-agents-wallets-dark.svg)

_One owner, one vault per device, one wallet per account. Orange marks where USDC moves._

| Word      | Meaning                                                                                             |
| --------- | --------------------------------------------------------------------------------------------------- |
| Owner     | Your vAPI account with its bound wallet and sign-in methods. It approves links and sets allowances. |
| Vault     | The encrypted file on one device that holds the phrase and accounts. Each device has one vault.     |
| Account   | An agent wallet inside the vault. It is derived from the phrase or imported.                        |
| Allowance | The Router budget per day that the owner grants one account.                                        |
| Caps      | The account's per-call and per-day spend limits, plus its Base USDC ceiling.                        |
| Balance   | USDC held by an account for Call, or Router balance held by the owner.                              |
| Movement  | A durable plan for one or more transfers, with each leg recorded before signing.                    |

## One vault per device

The vault at `~/.vapi/vault.json` holds one 12-word phrase and the accounts. Derived accounts use BIP-39 and the MetaMask path `m/44'/60'/0'/0/{index}`. Restoring the phrase into MetaMask produces the same derived addresses.

Create the vault and its first account:

```bash
vapi setup
```

List local accounts, add a derived account, or include read-only accounts on the owner's other devices:

```bash
vapi accounts
vapi accounts add <name>
vapi accounts --all
```

Imported accounts keep an encrypted private key in the vault. The recovery phrase does not cover them.

```bash
vapi accounts import <name>
```

Setup generates the device key and selects the vault's secret store.

| Platform                                             | Secret store                                                                  |
| ---------------------------------------------------- | ----------------------------------------------------------------------------- |
| macOS                                                | Keychain                                                                      |
| Windows                                              | Per-user Windows Data Protection (DPAPI)                                      |
| Linux with a working keyring                         | The libsecret keyring through `secret-tool`                                   |
| Linux without a working keyring, since client 0.13.0 | Encrypted `~/.vapi/secrets.json`, with `VAPI_VAULT_PASSWORD` set before setup |

The vault file cannot be opened without that device key.

## Servers and CI

On servers, containers and GitHub Codespaces without a working keyring, set `VAPI_VAULT_PASSWORD` before setup. Use at least 12 characters. Since client 0.13.0, the client keeps the device key and agent link in `~/.vapi/secrets.json`, encrypted with that password.

The choice is fixed once per vault in `~/.vapi/secret-store.json`. Existing vaults, macOS, Windows and Linux with a working keyring keep the OS store. Every later command for an encrypted-file vault needs the variable set. See [Troubleshooting](/agents/wallets/troubleshooting/) for setup examples.

Password protection is separate from the secret-store choice. It wraps the device key under a password you choose. An unlocked session lasts eight hours.

```bash
vapi vault protect
vapi vault unlock
vapi vault status
vapi vault lock
vapi vault unprotect
```

Set `VAPI_VAULT_PASSWORD` for a non-terminal process. `VAPI_KEYSTORE_PASSWORD` is a deprecated alias.

## The status screen

Run `vapi` to see the owner, vault state, cloud-backup state, account balances, Router usage, caps, ceilings, and unfinished movements.

```bash
vapi
```

Each account has a 5 USDC Base ceiling by default. After a settled paid call and when the status screen opens, the account sends excess funds to its parent. A normal account's parent is the owner. A swarm member's parent is its treasury.

The per-day cap is the sweep floor. An account with a 5 USDC ceiling and an 8 USDC per-day cap sweeps down to 8 USDC.

## Backup and restore

Show the recovery phrase from a real terminal:

```bash
vapi backup
```

Phrase restore always rebuilds account 1. It scans further addresses until five consecutive addresses have no Base USDC and reports how many it scanned. Use `vapi restore --accounts <n>` to restore a fixed count without balance queries. Restore from the phrase:

```bash
vapi restore
```

After restore, add missing derived accounts again in order, including unfunded accounts beyond the scanned range:

```bash
vapi accounts add <name>
```

Imported keys do not return from the phrase. An owner-encrypted cloud backup can include imported accounts and other device state.

```bash
vapi backup --cloud
vapi restore --from-owner
```

Read [Backup and recovery](/agents/wallets/backup-and-recovery/) before restoring open movements. Keep recovery words away from websites, chats, and agent prompts.

## What the owner sees

The console's **My agents** page groups accounts by device. Each account shows its name, address, USDC balance, Router allowance, spending today, caps, and status. Each account links to **View activity**, which shows the Call payments that wallet signed.

The owner can change an allowance or revoke a link in the console. Pause a local agent profile with `vapi agent pause <name>` in your terminal. The approval page names the device and account before the owner approves it.

For the account and device relationship, see [Owner and agents](/agents/control/owner-and-agents/). For transfers and ceilings, see [Sending and distributing](/agents/wallets/sending-and-distributing/).

## Coming from 0.5

The first 0.6.0 command migrated each `wallets/*.json` keystore into an imported vault account and moved the old files to `wallets.migrated/`. Use the account commands and `--account <name>`.

```bash
vapi accounts
vapi accounts use <name>
vapi pay <ref> --account <name>
```

The old `vapi wallet` commands remain an alias of `vapi accounts`. The `--wallet` option still works for one more release; use `--account`.

Client 0.14.0 preserves the existing secret-store selection during repeated setup. An unpinned existing vault stays OS-backed.
Setup locks backend selection against concurrent runs and validates existing encrypted credentials instead of replacing entries.
A locked encrypted-file store remains encrypted and never falls back to plaintext. Set VAPI_VAULT_PASSWORD to open it.

## Next

- [Limits and ceilings](/agents/wallets/limits-and-ceilings/)
- [Backup and recovery](/agents/wallets/backup-and-recovery/)
- [Troubleshooting](/agents/wallets/troubleshooting/)
- [Owner and agents](/agents/control/owner-and-agents/)

Checked on 2026-11-17.
