# Plan 001: Wallet management

Status: proposed 2026-09-19. Owner: Zep. Scope: `vapi-network` client only
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

| Command | Behaviour |
| --- | --- |
| `vapi backup` | Passphrase, then prints the phrase (v3) or explains the file+passphrase and `export-key` route (v1/v2). Never to stderr, never logged. |
| `vapi import --phrase` | Reads 12 or 24 words from the prompt (never argv), derives both accounts, writes a v3 keystore under a new passphrase. Refuses if a keystore exists unless `--replace` and the existing one has zero balance or `--force`. |
| `vapi import --key` | Same with a raw hex key (Base only, v2-style keystore). |
| `vapi passphrase` | Old passphrase, new passphrase twice, re-encrypt in place (atomic write as today). |
| `vapi export-key` | Unchanged; for v3 it derives from the seed. |

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

## Release 2: several wallets (0.3.0)

### 2.1 Layout

```
~/.vapi/
  config.json            # registry, networks, defaults
  wallets/
    default.json         # keystore v3 (or migrated v2)
    agent-claude.json
  wallets.json           # { "default": "default" }
  receipts.jsonl         # unchanged, rows gain "wallet": "<name>"
```

First run of 0.3.0 moves `keystore.json` to `wallets/default.json` and writes
`wallets.json`; the old path is left as a 0600 symlink for one release so
external scripts do not break, then removed in 0.4.

### 2.2 Selection

Precedence: `--wallet <name>` flag, then `VAPI_WALLET`, then `wallets.json`
default. Every command that unlocks a keystore prints which wallet it used.
`fund`, `balance`, `sweep`, `export-key`, `backup`, `passphrase` all take
`--wallet`.

### 2.3 Commands

| Command | Behaviour |
| --- | --- |
| `vapi wallet create <name> [--networks base,solana]` | Same flow as `init` (notice, phrase, passphrase). `init` becomes `wallet create default` plus config. |
| `vapi wallet list [--json]` | Name, addresses, balances, default marker, spend caps. |
| `vapi wallet use <name>` | Sets the default. |
| `vapi wallet rename <old> <new>` | File and receipts rows. |
| `vapi wallet remove <name>` | Refuses while the balance is above zero unless `--force`; prints the backup route first. |
| `vapi wallet caps <name> --per-call <usd> --per-day <usd>` | Spend caps move from `config.json` to the wallet entry, so an agent wallet can have a small daily cap while the owner's has none. |

### 2.4 MCP

New tools `wallet.list` and `wallet.use`; every existing `wallet.*`,
`call.pay` and `receipts.*` tool accepts an optional `wallet` argument.
Default behaviour unchanged, so existing agent configs keep working.

### 2.5 Funding page

`fund --wallet agent-claude` opens the page with `?label=agent-claude`, which
the page shows next to the address so the user knows which wallet they are
topping up. Console change, one line, separate PR.

## Release 3: no plain-text passphrase for agents (0.3.x)

- `vapi unlock [--wallet <name>]` stores the passphrase in the OS secret
  store: macOS Keychain via the `security` CLI, Linux via `secret-tool` when
  present. No new dependency. `vapi lock` removes it.
- `getKeystorePassphrase` order becomes: env var (kept for CI), secret store,
  prompt. MCP configs then hold no secret; the README's MCP snippet drops
  `VAPI_KEYSTORE_PASSWORD`.
- Windows uses the env var until a Credential Manager path exists.

## Risks and decisions

- **Phrase on screen.** Shown once, gated on Enter, never in JSON. Same trade
  as every wallet; documented.
- **Solana derivation.** Hand-written SLIP-0010 must match Phantom, or a
  restored phrase shows a different Solana address. Fixed test vectors are the
  guard.
- **Migration.** v1/v2 keystores never get rewritten silently; only
  `passphrase` and `import` write a new file. The wallets-folder move in 0.3.0
  is the one automatic migration and keeps a symlink for a release.
- **Zero runtime dependencies.** Kept: viem already bundles BIP-39; SLIP-0010
  is local code; secret stores use OS binaries.

## Order of work

1. Release 1 in one PR per numbered item (1.2 first, then 1.3, then 1.1 and
   1.4 together), each with tests, then a single publish of 0.2.5.
2. Release 2 after 0.2.5 has been in use for a week.
3. Release 3 independent of 2; can start once 1 ships.
