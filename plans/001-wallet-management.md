# Plan 001: Wallet management

Status: Releases 1 to 3 shipped in 0.3.0 (2026-09-19). Owner: Zep. Scope: `vapi-network` client only
(core, cli, mcp). The console funding page is unchanged.

## Goal

A person or agent using `vapi` must be able to answer four questions without
reading source: what happens if I lose this machine, how do I move the wallet,
how do I keep my own money apart from an agent's, and where does the passphrase
live when an agent runs unattended. Today the answers are "the funds are gone",
"you can't", "you can't", and "in plain text in your editor config".

The wallet stays self-custodial: keys are generated and stored on the user's
machine, encrypted with their passphrase; vAPI servers never receive key
material, phrases, or passphrases. Nothing in this plan adds a server call.

## Today

- `vapi init` generates a random secp256k1 key (Base) and optionally a random
  ed25519 seed (Solana), encrypts both with AES-256-GCM under a scrypt-derived
  key, writes `~/.vapi/keystore.json` (version 2) with mode 0600.
- Unlock: passphrase prompt, or `VAPI_KEYSTORE_PASSWORD`; the MCP server
  depends on the env var, so editor configs hold the passphrase in clear.
- Commands: `init`, `accounts --enable solana`, `balance`, `sweep`,
  `export-key`, `fund`. One wallet per `VAPI_HOME`.
- No phrase, no import, no backup command, no passphrase change, no second
  wallet, no custody notice at creation.

## Not in scope

Hardware wallets, smart-account or social recovery, cloud backup, a GUI. The
keystore stays a local signer behind the existing `unlockKeystore` interface so
those can come later without touching commands.

## Release 1: recovery and honesty (0.2.5)

### 1.1 Custody notice at creation

`vapi init` prints, before generating anything:

```
This wallet is yours. vAPI has no copy of the key and cannot recover it.
If you lose this machine and your recovery phrase, the funds are gone.
```

Then the phrase step below. `--json` output carries `custody: "self"` and the
same warning string so agents can relay it.

### 1.2 Recovery phrase, keystore version 3

- New wallets are created from a 12-word BIP-39 phrase (English wordlist,
  `viem/accounts` `generateMnemonic`).
- Derivation: Base `m/44'/60'/0'/0/0` via `mnemonicToAccount`; Solana
  `m/44'/501'/0'/0'` via SLIP-0010 ed25519 (HMAC-SHA512 over `node:crypto`,
  about thirty lines, no dependency; verified against the Phantom test vector).
  One phrase restores both accounts in MetaMask, Rabby, Coinbase Wallet and
  Phantom.
- Keystore version 3 stores the encrypted seed (not the derived keys) plus the
  derived public addresses. Version 1 and 2 files keep working unchanged; they
  have no phrase, and `backup` tells the user so and points at `export-key`.
- The phrase is shown once at init, one word per line, numbered, after a
  "press Enter when you have written it down" gate. `--json` and non-TTY runs
  never print it; they say where to get it (`vapi backup`).

### 1.3 Commands

| Command                | Behaviour                                                                                                                                                                                                                  |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `vapi backup`          | Passphrase, then prints the phrase (v3) or explains the file+passphrase and `export-key` route (v1/v2). Never to stderr, never logged.                                                                                     |
| `vapi import --phrase` | Reads 12 or 24 words from the prompt (never argv), derives both accounts, writes a v3 keystore under a new passphrase. Refuses if a keystore exists unless `--replace` and the existing one has zero balance or `--force`. |
| `vapi import --key`    | Same with a raw hex key (Base only, v2-style keystore).                                                                                                                                                                    |
| `vapi passphrase`      | Old passphrase, new passphrase twice, re-encrypt in place (atomic write as today).                                                                                                                                         |
| `vapi export-key`      | Unchanged; for v3 it derives from the seed.                                                                                                                                                                                |

### 1.4 Docs

README section "Your wallet is yours" (creation, backup, restore, the three
things vAPI cannot do), and the same text on the docs site. `init`'s next
steps gain one line: `Back up   vapi backup   (write the 12 words down; vAPI cannot recover them)`.

### 1.5 Tests

Keystore v3 round trip; phrase derivation against fixed vectors for both
chains; v1 and v2 files still unlock; `import --phrase` produces the same
addresses as the vector; `passphrase` keeps addresses and receipts; TTY gate
and non-TTY behaviour of `init` and `backup`; secrets never appear in `--json`
or stderr.

Definition of done: gate green (`typecheck`, `lint`, `format:check`, `test`,
`pack:check`), CHANGELOG entry, version 0.2.5, the README section reviewed by
Zep before publish.

## Safety model (applies to every release)

An AI agent may drive the CLI, the MCP server or the SDK. The model is
built so that it never has to see a secret to do its job.

**Secrets** are the recovery phrase, a private key and a passphrase. Addresses,
balances, receipts and wallet names are not secrets.

**Where a secret may be shown**

- Only by the CLI, only when stdin and stdout are a real terminal, only after
  the person types the wallet name to confirm. `vapi backup`, `vapi export-key`
  and the phrase step of `init` / `wallet create` refuse otherwise and print:
  "Run this yourself in a terminal; an agent must never see these words."
- Agent detection: stdout or stdin not a TTY, or any of the marker variables
  `VAPI_NO_SECRETS`, `CLAUDECODE`, `CLAUDE_CODE`, `CURSOR_AGENT`, `CODEX_SANDBOX`,
  `OPENAI_CODEX`, `AGENT`, `CI` is set. `VAPI_NO_SECRETS=1` is the documented
  way to lock a machine's agent configs.
- The MCP server has no tool that returns a phrase, a key or a passphrase, and
  no tool that creates, removes, renames, backs up or exports a wallet.
- The SDK keeps secret-returning functions (`exportRecoveryPhrase`,
  `exportKeystoreKeys`, `createKeystoreWithPhrase`'s phrase) in a separate
  entry point `@vapi-network/core/secrets`, not re-exported from the main
  index. The MCP package never imports it (lint rule). Docs mark it human-only.

**How an agent pays without a secret**

- The passphrase for the wallet the human assigned to the agent comes from the
  OS secret store (Release 3) or, until then, `VAPI_KEYSTORE_PASSWORD`. It
  unlocks that wallet only.
- The unlocked key exists in memory for one signature and is zeroed after.
- Spend caps are per wallet and enforced in the pay path.

**Traceability**

- `~/.vapi/audit.log` (0600, append-only from the client's point of view)
  gets one line per secret export, wallet creation, removal, restore, rename,
  default change and cap change: ISO time, command, wallet name, tty yes/no,
  agent marker if any. Never the secret itself.

## Release 2: the wallet manager (0.3.0)

One machine, several wallets, one clear rule for which wallet a command
uses. Works the same through the CLI, the MCP server and the SDK, with one
deliberate difference: an agent can use wallets, only a human can create,
remove, back up or export one.

### 2.1 Layout

```
~/.vapi/
  config.json              # registry, networks (no spend caps any more)
  wallets.json             # { version: 1, default: "main", wallets: { main: {...} } }
  wallets/
    main.json              # keystore (v3, or migrated v2)
    agent-claude.json
    .trash/                # removed wallets, kept, 0600, never auto-deleted
  receipts.jsonl           # rows gain "wallet": "<name>"
```

- Names: `[a-z0-9][a-z0-9-]{0,31}`. Shown everywhere a wallet is used.
- `wallets.json` entry: `{ createdAt, label?, spendCaps: { perCallAtomic, perDayAtomic } }`.
  Spend caps move from `config.json` to the wallet; an agent wallet can have
  a small daily cap while the owner's has a large one.
- Migration, once, on first run of 0.3.0: `keystore.json` → `wallets/main.json`,
  `config.spendCaps` → `wallets.json` main entry, receipts rows without a
  wallet are treated as `main`. `keystore.json` becomes a 0600 symlink to
  `wallets/main.json` for one release so external scripts keep working.
  A `VAPI_HOME` without a keystore migrates nothing.

### 2.2 Selection

Precedence: `--wallet <name>` flag, then `VAPI_WALLET`, then the default
in `wallets.json`. Every command that touches a wallet says which one:
`Wallet: main (0x1234…abcd)` as the first stdout line in text mode, and a
`wallet` field in `--json`. A name that does not exist is an error listing
the names that do.

### 2.3 SDK (`@vapi-network/core`)

`WalletStore` is the one entry point; every existing function that takes a
keystore path keeps working.

| Method                                                                         | Notes                                                                                                                                     |
| ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `WalletStore.open(home?)`                                                      | Runs the migration if needed.                                                                                                             |
| `list()`                                                                       | Names, addresses, default marker, caps, createdAt. No passphrase.                                                                         |
| `resolve(selection?)`                                                          | Applies the precedence above; returns `{ name, path, entry }`.                                                                            |
| `create(name, passphrase, { phrase?, enableSolana?, label?, spendCaps? })`     | Same v3 creation as `init`; returns account and phrase.                                                                                   |
| `importKey(name, passphrase, privateKey)`                                      | v2-style keystore.                                                                                                                        |
| `unlock(name, passphrase)`                                                     | `unlockKeystore` on the resolved path.                                                                                                    |
| `setDefault(name)`, `rename(old, new)`, `setSpendCaps(name, caps)`, `setLabel` | Atomic writes of `wallets.json`.                                                                                                          |
| `remove(name, { force? })`                                                     | Refuses the default wallet and any wallet with a USDC balance unless `force`; moves the file to `wallets/.trash/<name>-<timestamp>.json`. |
| `restore(name)`                                                                | Brings a trashed wallet back.                                                                                                             |

Receipts, spend-ledger and sweep code take the wallet name so records stay
apart per wallet.

### 2.4 CLI

```
vapi wallet list [--json]
vapi wallet create <name> [--networks base,solana] [--label <text>] [--json]
vapi wallet use <name>
vapi wallet rename <old> <new>
vapi wallet remove <name> [--force]        # asks you to type the name in a terminal
vapi wallet restore <name>
vapi wallet caps <name> [--per-call <usd>] [--per-day <usd>] [--json]
```

Existing commands gain `--wallet <name>`: `balance`, `accounts`, `fund`,
`pay`, `sweep`, `receipts`, `stats`, `export-key`, `backup`, `import`,
`passphrase`. `receipts` and `stats` show the selected wallet by default
and take `--all-wallets`. `init` creates `main` when no wallet exists and
otherwise says so and lists the wallets. `import` writes a new named wallet
(`--wallet <name>`, default `main` only when none exists) instead of
replacing; `--replace` keeps its meaning for an explicitly named wallet.

### 2.5 MCP

- New tools: `wallet.list` (names, addresses, balances, caps, which is
  active) and `wallet.use` (sets the active wallet **for this session
  only**; it never rewrites the human's default on disk).
- `wallet.address`, `wallet.balance`, `wallet.accounts`, `wallet.fund`,
  `call.pay`, `receipts.list`, `receipts.stats` accept an optional
  `wallet` argument; without it the session's active wallet, then
  `VAPI_WALLET`, then the default.
- No tool creates, removes, renames, exports or backs up a wallet, and no tool
  returns a phrase or key. Those stay in the CLI, in front of a person.
- The unattended passphrase comes from `VAPI_KEYSTORE_PASSWORD` for the
  active wallet, or from the secret store (Release 3).

### 2.6 Funding page

`fund` passes `?label=<name>`; the page shows the name next to the address.
One-line console change, separate PR.

### 2.7 Tests

Migration from a 0.2.x home (with and without Solana, with legacy receipts);
selection precedence; every `WalletStore` method including refusal cases;
CLI commands text and JSON; MCP `wallet.use` not touching disk; spend caps
enforced per wallet in `pay`; receipts filtered per wallet.

## Release 3: no plain-text passphrase for agents (0.3.x)

- `vapi unlock [--wallet <name>]` stores the passphrase in the OS secret
  store under service `vapi-network`, account `<wallet name>`: macOS
  Keychain through the `security` binary, Linux through `secret-tool` when
  present. `vapi lock [--wallet <name>|--all]` removes it. No dependency.
- Passphrase resolution order becomes: `VAPI_KEYSTORE_PASSWORD` (kept for CI),
  secret store, prompt. The README's MCP snippet drops the env var.
- `vapi wallet list` shows which wallets are unlocked for agents.
- Windows keeps the env var until a Credential Manager path exists.

## Risks and decisions

- **Agents and secrets.** The MCP surface deliberately cannot mint, remove or
  export wallets. Agent wallets are created by the human, funded from the
  page, and capped.
- **Removal is a move, not a delete.** `.trash` keeps the encrypted file; the
  passphrase is still required to use it.
- **Migration.** One automatic layout move, with a symlink for one release;
  keystore file contents are never rewritten by the migration.
- **Zero runtime dependencies.** Kept.

## Order of work

1. Release 1: shipped in 0.2.5 (PRs #14, #15, #16).
2. Release 2: shipped in 0.3.0 as three PRs — core `WalletStore`, the layout
   migration and per-wallet receipts and caps; the CLI wallet commands and
   `--wallet`; the MCP `wallet.list` and `wallet.use` session.
3. Release 3: shipped in 0.3.0 as one PR — `vapi unlock` and `vapi lock`, the
   OS secret store, and `resolvePassphrase` as the single unlock order.

Everything in this plan is now in 0.3.0. What it deliberately did not do, and
what a later plan would pick up:

- 2.6 Funding page `?label=<name>`: a console change, not a client one, and
  still open.
- Windows has no Credential Manager path, so it keeps
  `VAPI_KEYSTORE_PASSWORD`.
- The `keystore.json` compatibility symlink is kept for one release and should
  be dropped in 0.4.0.
