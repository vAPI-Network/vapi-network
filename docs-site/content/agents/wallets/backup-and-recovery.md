---
title: "Backup and recovery"
description: "A recovery phrase and owner-encrypted cloud backup let you restore a local vault without sending plaintext keys to vAPI Network."
order: 5
---

This page is for owners who need to back up or restore a local vault without sending plaintext keys to vAPI.

Keep a written recovery phrase and enable owner-encrypted cloud backup when you need to restore imported accounts or operational state.

## Back up the recovery phrase

Show the vault's 12-word phrase from a real terminal:

```bash
vapi backup
```

The command checks that a person controls the terminal and asks for account-name confirmation. Phrase restore always rebuilds account 1. It scans further addresses until five consecutive addresses have no Base USDC and reports how many it scanned. Use `vapi restore --accounts <n>` to restore a fixed count without balance queries. It does not cover imported private keys.

After restore, add missing derived accounts again in order, including unfunded accounts beyond the scanned range:

```bash
vapi accounts add <name>
```

Store the words offline. Anyone holding them can spend every derived account.

## Turn on encrypted cloud backup

An existing vault and a linked account are required.

```bash
vapi backup --cloud
```

The command prints a relay code and opens the console's **My agents** page when a browser is available. Enter the code and approve the device. The device stores its backup key in the vault's secret store and uploads the encrypted envelope. This uses the OS store, or encrypted `~/.vapi/secrets.json` for a headless Linux vault. See [How wallets work](/agents/wallets/how-wallets-work/#servers-and-ci) for the fixed backend choice.

Interactive `vapi setup` offers cloud backup after it creates the first account. Use `vapi setup --no-cloud-backup` to skip the offer.

Stop later uploads from this device:

```bash
vapi backup --cloud off
```

This removes the local backup key. Delete the encrypted server copy from the console.

## What the backup contains

Version 2 backup plaintext contains the recovery phrase, derivation index, derived and imported accounts, imported keys, labels, caps, ceilings, Router refill settings, the default account, configured networks, and the source protection flag.

It can also contain agent profiles, swarms, open movements, and matching transfer-receipt revisions. Vault-only backups keep the byte-identical version 1 plaintext format.

Encrypted envelopes may contain at most 65,536 bytes. If needed, the writer drops agents, then swarms, then movements and receipts. It never drops account policy. The result names dropped sections in `omitted` and prints a 64 KB warning.

The snapshot verifies that open signed legs have matching receipts. If account, movement, or receipt files keep changing across three attempts, no backup is created or uploaded. Retry after the active command finishes.

## Restore from the owner

Start on a new device without a completed vault:

```bash
vapi restore --from-owner
```

Enter the relay code on the console's **My agents** page, choose the source backup, and approve the new device. The terminal shows the owner address and asks before writing the vault.

Pin the expected owner address when needed. A non-interactive restore requires this flag.

```bash
vapi restore --from-owner --owner <0x…>
```

Restore rebuilds accounts, caps, ceilings, Router refill settings, the default account, networks, and any included profiles, swarms, open movements, and receipts. It reports skipped items and conflicts rather than replacing unrelated local records.

Links and credentials are not restored. Link each account again:

```bash
vapi login --account <name>
```

![What each backup brings back. The 12-word phrase, shown by vapi backup and kept written down offline, restores derived accounts only, with vapi restore. The cloud backup, turned on with vapi backup --cloud, is an owner-encrypted envelope of at most 64 KB, restored with vapi restore --from-owner. It restores derived accounts, imported accounts and their keys, labels, caps and ceilings, and Router refill settings, the default account and networks. Agent profiles and swarms, and open movements with their receipts, are included when they fit and are dropped first above 64 KB. Neither backup includes links, bearer and refresh tokens, Router keys or device codes. After either restore, link each account again with vapi login --account and the account name.](vapi-backup-coverage-light.svg)
![What each backup brings back. The 12-word phrase, shown by vapi backup and kept written down offline, restores derived accounts only, with vapi restore. The cloud backup, turned on with vapi backup --cloud, is an owner-encrypted envelope of at most 64 KB, restored with vapi restore --from-owner. It restores derived accounts, imported accounts and their keys, labels, caps and ceilings, and Router refill settings, the default account and networks. Agent profiles and swarms, and open movements with their receipts, are included when they fit and are dropped first above 64 KB. Neither backup includes links, bearer and refresh tokens, Router keys or device codes. After either restore, link each account again with vapi login --account and the account name.](vapi-backup-coverage-dark.svg)

_The phrase covers derived accounts. The cloud backup adds everything else except links and credentials._

## Review restored movements

A restored signed leg with a matching receipt becomes `unknown` and reuses the same authorization on resume. A restored planned leg without a signed receipt stays planned and stops for review.

Every restored leg stays open until it becomes `sent` or `cancelled`. An open leg blocks another distribution, account rename, account removal, and automatic sweep for its sender.

Start with the resume command printed after restore:

```bash
vapi accounts distribute --resume <movement-id>
```

If the client asks for restored-leg review, check the sender's balance and explorer history. The source device may have paid the transfer with a later nonce. Only after confirming that it did not, use the terminal-only replacement or cancellation path:

```bash
vapi accounts distribute --resume <movement-id> --replace-expired-restored
vapi accounts distribute --cancel <movement-id> --replace-expired-restored
```

MCP cannot set the override or cancel a movement. Read [Sending and distributing](/agents/wallets/sending-and-distributing/) for all recovery flags.

## What never leaves the device

The backup service receives an encrypted envelope. The relay receives public keys and a sealed backup-key payload. Neither receives the owner key, recovery phrase, backup key, vault key, or recovery password in plaintext.

Account links, bearer tokens, refresh tokens, Router keys, and device codes are excluded from the backup. Agents and MCP cannot read a recovery phrase, private key, or vault password.

## Next

- [How wallets work](/agents/wallets/how-wallets-work/)
- [Sending and distributing](/agents/wallets/sending-and-distributing/)
- [Limits and ceilings](/agents/wallets/limits-and-ceilings/)

Checked on 2026-11-12.
