# Backup and recovery

Cloud backup stores one encrypted vault envelope for each device name. The owner approves every new device before that device receives a backup key.

## What is stored

Plaintext version 2 contains the recovery phrase, next derivation index, and derived and imported accounts. It includes imported account keys, labels, spend caps, ceilings, automatic Router refill settings, the default account, configured networks, and the source protection flag.

The same plaintext can include agent profiles, swarm state, unfinished movements, and transfer receipts for those movement legs. The [backup envelope format](backup-envelope.md) defines the exact fields, exclusions, and size priority.

The writer snapshots movement files before the receipt journal. It verifies every unknown or journal-signed failed leg against the captured receipts. Each match uses the captured account name and nonce. File changes retry the whole snapshot up to three times. Continued changes stop the backup before upload and ask you to retry.

| Item               | Location                                                                     | Contents                                                            |
| ------------------ | ---------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Encrypted envelope | Private server bucket, at `<profileId>/<device>.json`                        | One AES-256-GCM envelope per owner profile and device name          |
| Backup key record  | OS secret store service `vapi-network`, account `vapi.backup.<device>.key`   | Owner, device, KDF parameters, 32-byte salt, and 32-byte backup key |
| Upload state       | OS secret store service `vapi-network`, account `vapi.backup.<device>.state` | Last successful upload time and envelope byte count                 |

The default server bucket is `agent-vault-backups`. A configured server can use another private bucket. The cloud-backup module writes neither local record to a vAPI file.

Account links, bearer tokens, refresh tokens, Router keys, and device codes are not in the backup. Each restored account must link again on the new device.

## Who can open a backup

The owner's browser derives the backup key from a repeatable wallet signature with HKDF-SHA256. It uses a recovery password with scrypt when the wallet cannot produce a repeatable signature. Only a holder of the resulting 32-byte key can open the envelope.

The browser seals that key to the device's fresh X25519 public key. The relay and storage endpoints receive public keys, sealed payloads, and encrypted envelopes. They never receive the owner key, recovery phrase, backup key, vault key, or password in plaintext.

## Turn on cloud backup

An existing vault and a linked account are required. Start enrollment directly with:

```sh
vapi backup --cloud
```

Interactive setup also offers cloud backup after the vault and first account exist. The prompt defaults to yes. Skip the offer with:

```sh
vapi setup --no-cloud-backup
```

Non-interactive setup skips the offer. No envelope is uploaded before the owner consents.

Enrollment prints a relay code and opens the console's `/agents` page when the environment permits browser access. Enter the code there and approve the device. The CLI opens the sealed response, stores the key, uploads the first envelope, and reports its time and size.

Backups use the device name as their server key. Enrollment warns when another device linked to the owner uses the same name because a later upload would replace that copy. Set `VAPI_DEVICE` for one run:

```sh
VAPI_DEVICE=research-laptop vapi backup --cloud
```

For a persistent name, set the `device` field in `~/.vapi/config.json`:

```json
{
  "device": "research-laptop"
}
```

The encrypted envelope may contain at most 65,536 bytes. The writer drops optional sections in the order described in the envelope guide when the full plaintext does not fit.

The CLI reports the dropped section names in `omitted`. It also writes `Cloud backup left out <sections>: they do not fit the 64 KB backup limit.` to standard error.

## Automatic uploads

After enrollment, these successful command forms request a new envelope:

```sh
vapi accounts add <name>
vapi accounts import <name>
vapi accounts rename <old> <new>
vapi accounts use <name>
vapi accounts remove <name>
vapi accounts restore <name>
vapi accounts caps <name>
vapi accounts distribute <amount> --from <account>
vapi accounts distribute --resume <id>

vapi wallet create <name>
vapi wallet add <name>
vapi wallet import <name>
vapi wallet rename <old> <new>
vapi wallet use <name>
vapi wallet remove <name>
vapi wallet restore <name>
vapi wallet caps <name>

vapi agent create <name>
vapi agent pause <name>
vapi agent resume <name>
vapi agent revoke <name>

vapi swarm create <name>
vapi swarm add <name> <role>
vapi swarm remove <name> <member>
vapi swarm fund <name> <usd>
vapi swarm rebalance <name>
vapi swarm dissolve <name>

vapi router buy --auto <1|5|20|50> --below <usd>
vapi router buy --auto off

vapi setup
vapi import
vapi login
vapi restore
```

Some commands can write resumable state before they report a failure. The CLI also requests an upload after failed swarm mutations, `accounts add`, `accounts distribute`, and `wallet add`.

The hook runs after the command prints its own result. It stops waiting after 10 seconds. A skipped or failed upload prints a dim diagnostic and never changes the command's exit code.

## Restore on a new device

Start owner restore on a device without a completed vault. The same command can finish an interrupted owner restore when its authenticated in-progress record matches the approved backup.

```sh
vapi restore --from-owner
```

The CLI prints a relay code for the console's `/agents` page. The owner selects a source backup there and approves the new device. The terminal shows the payload's owner address and asks for confirmation before it writes the vault.

Pass the expected owner to verify it before the confirmation step:

```sh
vapi restore --from-owner --owner <0x…>
```

A non-interactive restore requires `--owner`. An owner mismatch, device mismatch, expired code, invalid payload, or unrelated existing vault stops the restore without storing the key.

If restore stops after publishing the vault, run the same restore again. A private, authenticated in-progress record lets that retry finish the registry, profiles, swarms, movements, and receipts. The retry is accepted only for the same backup; a different backup still stops with `vault_exists`.

A protected source vault stays protected. The new device asks for a new vault password because backup plaintext does not contain the old password.

Restore rebuilds derived and imported accounts, labels, spend caps, ceilings, Router refill settings, the default account, and configured networks. It also rebuilds included agent profiles, swarms, open movements, and their transfer receipts. Backup plaintext omits the local sender and recipient address bindings added to movement files, so the version 2 plaintext shape stays unchanged.

Every restored swarm receives the new device name from the approved relay payload. The source device name is not kept.

Profiles and swarms that refer to missing accounts are skipped. A swarm is also skipped when a stored member or treasury address differs from its restored account. A movement is skipped when one of its sending accounts is missing.

A transfer receipt is skipped when its account is absent, no backed-up movement leg matches its account and nonce, or staging fails. A skipped movement can still contribute a receipt for a sender whose account was restored. Any agent, swarm, movement, or receipt write failure is reported as skipped.

Restore preserves every revision of a transfer receipt journal and makes the receipt file private (`0600`) before appending to an existing ledger. If a signed receipt cannot be written, the matching movement leg remains `unknown`; it never returns to the signing path.

Restore never replaces a different existing profile, swarm, movement, or receipt with the same identity. It reports that existing path as a conflict. Byte-identical files and receipts count as restored.

Restore marks matching unfinished local legs for every movement named by the authenticated backup before publishing the vault. It applies this mark even when a missing sender or staging failure skips the movement. Resume cannot replace an expired authorization until you inspect the balance and explorer history and pass the terminal-only override.

The human result lists restored profiles and swarms, unfinished movements, skipped items, and conflicts. The JSON result returns the same values as `agents`, `swarms`, `movements`, `skipped`, and `conflicts`.

The new device stores its backup key during restore. Link every restored account before its calls, Router access, relayed transfers, or later backup uploads can resume:

```sh
vapi login --account <name>
```

## Open movements after restore

A restored `planned` leg with a matching transfer receipt becomes `unknown`. If the leg was signed, resume replays that authorization with the same nonce and never signs it again.

A restored `planned` leg without a signed receipt remains `planned`. Resume stops for review before deriving current address bindings or signing.

Every restored leg stays open until it becomes `sent` or `cancelled`. This includes a non-retryable failed leg whose receipt missed the backup snapshot. The open movement blocks another distribution, account rename, account removal, and automatic sweep for its sender.

If a restored authorization expires, or a restored transfer was not yet signed when the backup was taken, resume stops without signing. The error names the sending address and explorer so you can check whether the original device paid the transfer with a later nonce. If it did not, replace the expired authorization deliberately from a terminal:

```sh
vapi accounts distribute --resume <id> --replace-expired-restored
```

The replacement flag is unavailable through MCP. After review, the terminal command derives both current addresses and records them before it signs.

The separate `--bind-legacy-addresses` flag applies only to local pre-0.8 movement files that lack address evidence. It does not replace restored-leg review, and MCP cannot set it.

The CLI prints this line for each restored open movement:

```text
Unfinished movement <id> from <account>: vapi accounts distribute --resume <id>
```

Run the command from that line:

```sh
vapi accounts distribute --resume <id>
```

If the movement cannot resume, inspect every sending account's balance and explorer history before using terminal-only cancellation:

```sh
vapi accounts distribute --cancel <id>
```

Cancel signs nothing. Without an override, it marks a restored leg `sent` only when the journal contains a sent receipt or an on-chain check proves its saved nonce settled. Any other restored leg makes the whole cancellation fail without changing the movement or spend ledger.

After reviewing every sending account's balance and explorer history, you can abandon unproven restored legs from a terminal:

```sh
vapi accounts distribute --cancel <id> --replace-expired-restored
```

The override cancels restored legs without signed journal evidence. A signed restored leg still needs an on-chain check. A settled nonce becomes `sent`, an expired nonce becomes `cancelled`, and a pending nonce or failed check refuses the whole cancellation. Non-restored legs retain their normal checks. A cancelled leg stays terminal through later version 2 backup and restore operations. MCP cannot cancel a movement or set the override.

## Turn off cloud backup

Remove the device's backup key and upload-state record with:

```sh
vapi backup --cloud off
```

This stops later uploads from the device. The encrypted server copy remains until the owner deletes it from the console's `/agents` page.

## Check backup status

Run the status screen with:

```sh
vapi
```

The status line is `Cloud backup: off` when the device has no stored key. When active, it starts with `Cloud backup: on` and includes either `no upload yet` or the last successful upload time.
