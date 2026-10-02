# Wallets

## The picture

The Owner is the human wallet that signs in to the console. The device vault holds one recovery phrase and the accounts used by local agents. Each account has its own USDC balance, Router allowance, and caps.

```text
Owner wallet (your own, signs in to the console)            0xA1b2…9f0e
  │ links, sets allowance, can revoke
  ▼
Device vault  ~/.vapi/vault.json   one 12-word phrase, unlocked by the OS keychain
  ├─ Account main        0xB2c3…8e1d   USDC 0.98   Router today $0.01 of $1.00   caps $0.05/call $1/day   ceiling 5 USDC
  ├─ Account researcher  0xC3d4…7d2c   USDC 0.50   Router today $0.00 of $1.00   paused
  └─ Account imported-1  0xD4e5…6c3b   (imported key, not in the phrase)
```

The Owner controls links and allowances. The account controls its own caps. The Router spends against the allowance and the caps.

Agent accounts keep small working balances. Each account defaults to a 5 USDC ceiling on Base. After a settled paid call and whenever the status screen opens, the account signs any excess back to its linked owner. The per-day spend cap is the floor, so a 5 USDC ceiling with an 8 USDC daily cap sweeps down to 8 USDC.

## Vocabulary

These words have the same meaning in the CLI, console, MCP tool names, SDK, and docs.

| Word      | Meaning                                                                                                                 |
| --------- | ----------------------------------------------------------------------------------------------------------------------- |
| Owner     | Your own wallet. Signs in to the console, approves links, sets allowances, holds Router balance and stake.              |
| Vault     | The encrypted file on one device that holds the phrase and the accounts. One per device.                                |
| Account   | An agent wallet inside the vault. Derived from the phrase, or imported. Has a name, an address, USDC, caps, and a link. |
| Allowance | The Router budget per day the owner grants one account.                                                                 |
| Caps      | The per-call and per-day spend limits, plus the Base USDC ceiling that returns excess funds to the owner.               |
| Balance   | USDC held by an account (Call), or Router balance held by the owner (Router).                                           |

## The vault file

The file is `vault.json` under the vAPI home, which defaults to `~/.vapi`. It holds one recovery phrase per device in encrypted form. Derived accounts use BIP-39 and the MetaMask derivation path `m/44'/60'/0'/0/{index}`; imported accounts sit next to them and keep encrypted private keys. The device key lives in the OS secret store: macOS Keychain, Windows Credential Manager via DPAPI, or Linux libsecret.

## Servers and CI: `vapi vault protect`

This command adds password protection to the device vault. A protected vault stays locked until the following command succeeds, and the open session lasts eight hours.

```sh
vapi vault protect
vapi vault unlock
vapi vault status
vapi vault lock
vapi vault unprotect
```

The command usage is:

```text
Usage: vapi vault protect|unprotect|lock|unlock|status [--json]
```

After protection, the CLI prints:

```text
The vault is now password protected and locked. Run vapi vault unlock to use it for 8 hours.
```

The other lifecycle messages are:

```text
Vault open on this device for 8 hours. Lock it early with vapi vault lock.
Locked the vault.
The vault has no open session to lock.
The vault is no longer password protected.
```

For a non-terminal process, set `VAPI_VAULT_PASSWORD` before the command.

```sh
VAPI_VAULT_PASSWORD="$VAULT_PASSWORD" vapi vault unlock
```

`VAPI_KEYSTORE_PASSWORD` remains an alias for one release. The CLI prints this deprecation notice when it uses that variable for a vault password.

```text
VAPI_KEYSTORE_PASSWORD is deprecated for vault passwords; use VAPI_VAULT_PASSWORD instead.
```

## Three layers against loss

Losing a device should cost as little as possible. Three layers cover it, cheapest first.

| Layer                        | What it protects                                                                                                                                                                  | Where                                                 |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Small balances               | Each account keeps a 5 USDC ceiling on Base by default and signs any excess back to the owner. A lost account loses its working balance only.                                     | [Accounts](#accounts), [docs/sending.md](sending.md)  |
| One phrase                   | One 12-word recovery phrase rebuilds every derived account in the vault. `vapi backup` prints it and `vapi restore` reads it.                                                     | [Backup and restore](#backup-and-restore)             |
| Owner-encrypted cloud backup | The device encrypts the vault with a key only the owner wallet can produce and stores the ciphertext with vAPI. A new device restores it after the owner approves in the browser. | [docs/backup-and-recovery.md](backup-and-recovery.md) |

Imported keys are not in the phrase. The cloud backup carries them, or back them up separately.

## Backup and restore

The encrypted console backup uses the versioned [backup envelope format](backup-envelope.md).

Run the backup command on a real terminal. It prints the recovery phrase only after the terminal checks and the account-name confirmation. It refuses a non-terminal run with this message:

```sh
vapi backup
```

```text
vapi backup prints your recovery phrase and only works in a terminal.
```

Restore reads the phrase, rebuilds the vault, and re-derives accounts from index 0 until it finds an unused address. Setup offers the same restore choice when no vault exists.

```sh
vapi restore
vapi setup
```

This wallet is yours. vAPI stores at most an encrypted backup that only your owner wallet can open, and cannot recover the key without it. If you lose this machine, your recovery phrase, and the owner-encrypted backup, the funds are gone.

## Accounts

The `vapi accounts` family lists accounts, derives new accounts, imports keys, changes names, selects the default, removes accounts, restores removed accounts, sets caps, and distributes USDC. Imported keys are not in the recovery phrase, so back up an imported key separately.

A trusted device is one the owner approved by selecting the trust checkbox on the consent page and setting an allowance. On that device, `vapi login`, `vapi accounts add`, and the MCP tool `accounts.add` link a new account without another approval when the request stays within the trusted scopes and allowance. Any other device receives the link code and waits for the owner to approve it.

MCP uses `accounts.add` to create an account and `accounts.caps` to change caps. A chat can lower spend caps and the ceiling. Only the terminal can raise them or turn the ceiling off.

Use [`vapi send`](sending.md) to move USDC between the owner's active accounts or back to the owner. The sending account signs locally, and vAPI pays the gas.

```sh
vapi accounts
vapi accounts list
vapi accounts --all
vapi accounts add <name> [--label <text>] [--no-link]
vapi accounts import <name> [--keystore <path> | --key-file <path>] [--label <text>]
vapi accounts rename <old> <new>
vapi accounts use <name>
vapi accounts remove <name> [--force]
vapi accounts restore <name>
vapi accounts caps <name> [--per-call <usd>] [--per-day <usd>] [--ceiling <usd|off>]
vapi accounts distribute <amount> --from <account> [--to <a,b,c>] [--network base|arc]
vapi accounts distribute --resume <movement-id> [--replace-expired-restored] [--bind-legacy-addresses]
vapi accounts distribute --cancel <movement-id> [--replace-expired-restored]
```

Without `--to`, distribute selects every other linked, active account on this device. It splits whole cents in account order and puts remainder cents in the first account. The sender's balance, largest-leg per-call cap, and remaining per-day cap are checked before the first signature. Each leg is signed and relayed in order.

A movement file records every leg, nonce, sender address and recipient address before signing. If the process stops, the next distribution refuses to start and prints the exact `vapi accounts distribute --resume <movement-id>` command. Resume reuses each recorded authorization and skips legs already sent. A failed leg remains open when it is retryable or its transfer journal proves that an authorization was signed. Every restored leg remains open until it is `sent` or `cancelled`, including a non-retryable failure without a receipt. Resume refuses when either saved account name now resolves to another address.

Remove refuses every account named by an unfinished movement, including a sender whose own leg is sent. Rename applies the same check to the old and new names. Retryable failures, signed failed legs, and every restored nonterminal leg count as open. A local unsigned non-retryable failure and a cancelled leg are terminal. Dissolve the named swarm, resume the movement, or cancel its terminal legs before reusing an account name.

Rename and remove wait for active capital work on every affected account name. If that work stays busy, the command changes nothing and tells you which rename or remove command to retry.

Add, import, restore, and rename also serialize changes to each affected account name. If another account change stays busy, the command tells you what to retry.

Receipt appends and account-name rewrites share one short local journal lock. If another command holds it for too long, vAPI reports that the receipt journal is busy and tells you to retry. A transfer never contacts the relay when its signed authorization cannot first be saved to the journal.

A local movement from 0.7.0 may lack saved addresses. Resume takes immutable addresses from a matching signed transfer journal. Without that evidence, it prints the current address for each name and signs nothing. After checking both addresses, use `--bind-legacy-addresses` in a terminal to record them and continue. The result reports the addresses that the terminal accepted. MCP cannot set this flag.

A restored transfer that is not proven sent, expired or never signed at backup time, is not signed automatically because the source device may have paid it with a later nonce. The error tells you how to check. After confirming it was not paid, `--replace-expired-restored` permits a deliberate terminal-only replacement; MCP cannot set this flag.

Use `vapi accounts distribute --cancel <movement-id>` when a movement cannot resume and you want to abandon its unsent legs. Cancel signs nothing. It reconciles journaled or on-chain sent legs, cancels unsigned local legs, and cancels signed local legs only after on-chain expiry. An unknown or still-valid authorization refuses the whole command.

A restored leg requires extra review. Check its sender balance and explorer history, then add `--replace-expired-restored` to the cancel command. The override cancels an unjournaled restored leg or a signed restored leg whose nonce is proven expired. A pending nonce or failed chain check refuses the whole cancellation without changing the movement or spend ledger. The result prints the sender balance commands to run before another movement. MCP cannot cancel a movement or set the override.

The ceiling is 5 USDC for new and existing accounts unless the terminal sets another value. `--ceiling off` disables automatic sweeps. A sweep always returns funds to the linked owner and never lowers the account below its per-day cap. Automatic ceiling enforcement and `vapi sweep` refuse to sign while an open movement leg from that account may still settle. Resume the movement first. If it cannot resume, wait for any signed authorization to expire and cancel it from the terminal.

The `--all` flag shows every account of the same owner, including accounts on other devices. Rows from other devices are read-only, and no command acts on them. The default account's link supplies the agent bearer, or the first linked local account does when the default is not linked. If no local account is linked, the command prints the local accounts and tells you to run `vapi login`. The request sends only the agent bearer; keys and phrases stay on the machine. With `--all --json`, the object contains `accounts` and `siblings`, plus `siblingsError` when the remote read fails.

Wallet commands accept this selector:

```text
--account <name>
```

Selection falls back to `VAPI_WALLET`, then the default set by the following command.

```sh
vapi accounts use <name>
```

`--wallet <name>` remains supported for one release. When used, the CLI prints:

```text
--wallet is now --account; --wallet keeps working for one release.
```

## Migration from 0.5

On first opening a 0.5 home, the store checks `wallets/<name>.json` files and imports readable keystores as imported accounts with their old names. It moves each migrated file to `wallets.migrated/<name>.json`, keeps a compatibility link at the old path for one release, and records the move in `audit.log`.

If the old passphrase is already available through `VAPI_KEYSTORE_PASSWORD` or the OS secret store, migration needs no input. Otherwise, the command that opens that account asks for `Passphrase for <name>:` once. The old passphrase is not part of the new vault phrase.

## The status screen

A bare `vapi` prints the status screen. With no vault, it prints only the setup line. With a vault, it shows the home directory, Owner, vault state, one line per account, balances, Router usage, caps, ceilings, and the next commands. It runs each local account's ceiling sweep as best effort. It also prints one resume command for every unfinished distribution.

```sh
vapi
```

This screen comes from a vault restored from the BIP-39 test phrase into an empty home, so the account holds nothing and is not linked yet:

```text
vAPI 0.8.0        home /tmp/vapi-docs-home        registry api.vapinetwork.ai

Owner      not linked   console: https://api.vapinetwork.ai/agents
Vault      unlocked on this device (macOS Keychain)   backup: vapi backup

Accounts
  account-1 *  0xf39F…2266   0.00 USDC    Router today —   caps $0.10 / $1.00 per day   ceiling 5 USDC   not linked

Next
  vapi setup                        link account-1 to your owner wallet
  vapi pay <ref> --max 0.02         pay an API from account-1
  vapi router chat "hello"          talk to a model on account-1's allowance
  vapi accounts add <name>          add an account
```

## Agents and secrets / audit log

Agents and MCP do not receive a recovery phrase, private key, or vault password. Secret exports require a real terminal and are refused when an agent marker is set. Set the following variable to refuse secret exports for the process.

```sh
VAPI_NO_SECRETS=1
```

The local audit log is `~/.vapi/audit.log`, or the same path under `VAPI_HOME`. It is append-only and records events such as vault protection, restore, migration, backup display, account import, removal, rename, default changes, caps changes, and secret-export refusals. Audit entries record names, addresses, terminal state, and safe details, never phrases, private keys, or passwords.
