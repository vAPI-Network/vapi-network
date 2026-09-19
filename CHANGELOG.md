# Changelog

All notable changes to the published `vapi-network` distribution and its four
scoped packages. The packages share one version and are released together.

## Unreleased (0.3.0)

### Added

- Several wallets on one machine. `~/.vapi/wallets/<name>.json` holds one
  keystore per wallet and `~/.vapi/wallets.json` records which wallet is the
  default, what each one may spend per call and per day, and its optional
  label. Names are 1 to 32 characters of lowercase letters, digits and dashes.
  The SDK entry point is `WalletStore`: list, resolve, create, import, unlock,
  rename, re-cap, remove and restore, without ever rewriting key material.
- Spend caps belong to the wallet, not to the machine, so an agent wallet can
  be given a small daily allowance while your own keeps a large one. Today's
  totals are counted per wallet in `spend-ledger.json`; rows written before
  named wallets count as `main`.
- Receipts record the wallet that paid. `receipts.jsonl` rows gain an optional
  `wallet` field, rows written before named wallets read as `main`, and renaming
  a wallet rewrites its rows in one atomic replacement.
- Removing a wallet is a move, not a delete: the encrypted keystore goes to
  `~/.vapi/wallets/.trash/`, where `restore` can bring it back. The default
  wallet is refused until another one is made the default, and a wallet that
  still holds USDC is refused unless you force it.
- `vapi wallet list|create|use|rename|remove|restore|caps` manages the wallets
  on a machine. `list` shows the address, the default marker, the caps in US
  dollars and the label; `caps` takes `--per-call` and `--per-day` in dollars;
  `remove` asks you to type the wallet name and prints where the keystore went.
- `--wallet <name>` on every command that touches a wallet, with `VAPI_WALLET`
  and the registry default behind it. Each of those commands names the wallet
  it used: `Wallet: <name> (<address>)` on the first line in text mode, and a
  `wallet` field in `--json`. `vapi receipts` and `vapi stats` show the selected
  wallet and take `--all-wallets`; `vapi import` writes a named wallet.
- An agent can no longer be shown a secret. `vapi backup` and `vapi export-key`
  run only when stdin and stdout are a real terminal, no agent or CI marker is
  set (`VAPI_NO_SECRETS`, `CLAUDECODE`, `CLAUDE_CODE`, `CURSOR_AGENT`,
  `CODEX_SANDBOX`, `OPENAI_CODEX`, `AGENT`, `CI`), and the person types the
  wallet name to confirm. Otherwise they print nothing and say so. `vapi init`
  and `vapi wallet create` still create the wallet and point at `vapi backup`.
- `~/.vapi/audit.log` (mode 0600) gets one JSON line per secret export and per
  wallet change: time, event, wallet, whether a terminal was attached, and the
  agent marker that was set. It never contains the secret itself.
- `@vapi-network/core/secrets` is a separate package entry point for the three
  functions that return a recovery phrase or a private key —
  `exportRecoveryPhrase`, `exportKeystoreKeys` and `createKeystoreWithPhrase`,
  plus `decryptPrivateKey`. They are no longer exported from
  `@vapi-network/core`, and the MCP package is forbidden by lint to import them.

### Changed

- A `~/.vapi` from 0.2.x migrates itself once, the first time the wallet store
  is opened: `keystore.json` moves to `wallets/main.json` with its contents
  untouched, `config.json`'s spend caps become the caps of `main`, and
  `keystore.json` stays behind as a mode 0600 symlink for one release so
  existing scripts keep working. A home without a keystore migrates nothing.
  The CLI itself no longer reads `keystore.json`; it resolves every path
  through the wallet store.
- `vapi init` on a machine that already has a wallet is no longer an error: it
  says nothing was created and lists the wallets it found, without asking for a
  passphrase.
- `vapi import` writes a new named wallet instead of replacing the only one.
  `--wallet <name>` chooses it, and `main` is assumed only on a machine that has
  no wallet yet. `--replace` moves the named wallet to `wallets/.trash/` first,
  still refusing a wallet that holds USDC unless `--force`.

## 0.2.5

### Added

- New wallets are created from a 12-word BIP-39 recovery phrase and stored as
  keystore version 3, which keeps the encrypted phrase instead of the derived
  keys. One phrase restores the Base account (`m/44'/60'/0'/0/0`) and the Solana
  account (`m/44'/501'/0'/0'`) in MetaMask, Rabby, Coinbase Wallet or Phantom.
  Keystores written by earlier versions keep working unchanged; they have no
  phrase, and `vapi export-key` stays their backup route.
- `vapi backup [--json]`: prints the recovery phrase for the local wallet, one
  numbered word per line on stdout with the warning on stderr, so it can be
  piped. A wallet created before recovery phrases is told so and pointed at its
  keystore file and `vapi export-key`.
- `vapi import --phrase [--networks <base,solana>] [--replace] [--force]`:
  restores a wallet from words typed at the prompt — never from the command
  line, where a shell history would keep them — under a new passphrase. An
  existing keystore is left alone unless `--replace`, which first moves it to
  `keystore.json.bak-<timestamp>`, and refuses outright while that wallet still
  holds USDC on Base unless `--force`. `vapi import --key` does the same with a
  0x-prefixed private key.
- `vapi passphrase [--json]`: re-encrypts the keystore under a new passphrase.
  The wallet, its addresses, and its recovery phrase are unchanged.

### Changed

- `vapi init` states the custody terms before it creates anything: vAPI has no
  copy of the key and cannot recover it. On a terminal it then shows the 12
  words once, numbered, and waits until you confirm you have written them down.
  `--json` and piped runs never print the phrase; they carry
  `custody: "self"`, the same warning, `recoveryPhrase: "hidden"`, and point at
  `vapi backup`. The next steps gained a `vapi backup` line.
- `vapi fund` and the `wallet.fund` MCP tool now hand out the hosted funding
  page at `<registry>/fund/<address>` instead of a pre-minted Coinbase session.
  The Coinbase session token is single-use and expires after five minutes, so
  anyone who took a moment to log in landed on "Action not available". The page
  mints the session at click time and also offers a wallet transfer
  (MetaMask/Coinbase Wallet/WalletConnect) and a bridge from another chain.
- Neither command touches the network any more: `vapi fund` works offline, never
  reports `onramp_unavailable`, and prints `{ address, network, url }` with
  `--json`. `wallet.fund` returns the same shape plus a short instruction for the
  agent to hand the link to its human.

### Deprecated

- `createOnrampSession` stays exported for backwards compatibility but is no
  longer used by the CLI or the MCP server. Use the new `fundingPageUrl`.

## 0.2.3

### Added

- `vapi export-key [--network <caip2>] [--json]`: unlocks the local keystore and
  prints the private key for the selected account — the EVM key as 0x-prefixed
  hex by default, or the base58 Ed25519 secret key for a Solana network. The
  warning goes to stderr and the key alone to stdout, so it can be piped.

### Fixed

- `vapi init` checks for an existing keystore before prompting for a passphrase,
  and names the wallet address it is refusing to replace.
- Config files written by older installs that still point at the retired
  `console.vapinetwork.ai` and `console-staging.vapinetwork.ai` hosts, or at the
  `/api/network/services` and `/api/marketplace/discovery` paths, are repaired in
  memory on load and rewritten on disk by `vapi init`. Before this, every command
  failed with `URL hostname … is not allowed`.
- The `bin` entries no longer use a `./` prefix, which npm stripped from the
  published manifest with a `"bin[vapi]" script name … was invalid` warning.

## 0.2.1

### Changed

- The terminal mark is drawn at the logo's real proportions (28x12 cells, solid
  colour cells; the ink blocks follow the terminal's own foreground so they read
  on light and dark themes) inside a framed welcome banner with the tagline and
  version beside it. `vapi init` and bare `vapi` show it; `--json`, `NO_COLOR`,
  `CI` and non-TTY output get the plain frame.

## 0.2.0

First release published to the npm `latest` tag. `0.2.0-dev.x` preview builds
remain on `next`.

### Added

- `vapi fund [--amount <usd>] [--json]`: asks the registry for a hosted Coinbase
  Onramp session for the local address, prints the link, opens it in the default
  browser on a terminal, and shows the resulting balance. When the onramp is
  unavailable it prints the address plus direct USDC-on-Base instructions instead
  of failing. vAPI never holds the funds.
- `wallet.fund` MCP tool, sharing `createOnrampSession` in `@vapi-network/core`
  with the CLI so both surfaces return the same session or fallback text.
- An animated block-logo banner on `vapi init` and on bare `vapi`. The mark is
  the nine-rectangle vAPI grid scaled to 34 terminal columns. It prints once as a
  static frame when stdout is not a terminal, or when `--json`, `NO_COLOR`, or
  `CI` is set.
- A next-steps block after `vapi init` (address, fund, search, pay, MCP config).
  `vapi init --json` gains a matching `nextSteps: string[]`; the rest of its JSON
  shape is unchanged.
- `vapi report` and the `support.report` MCP tool write a privacy-preserving
  local report and upload it only with an explicit `--send`.
- Listing disclosures from the registry: `group` (`vapi`, `added`, `partner`, or
  `external`) and `fee` (`{ bps, label }`). `vapi search` prints the group as a
  short tag plus the fee label, `vapi inspect` reports both, and `call.search`
  and `call.inspect` carry them in their MCP output schemas. vAPI and added APIs
  carry a 5% network fee inside the quoted price; partner and external listings
  carry none.

### Changed

- Every registry response schema is now tolerant of unknown keys, so a registry
  that starts returning an additional field can no longer fail `vapi search`,
  `vapi inspect`, or `vapi pay` with "Discovery response is malformed." Unknown
  fields are preserved and still reach `--json` consumers. Requests this client
  builds — discovery input, payment payloads, SIWx proofs — stay strict.
- Every package's `publish:npm` now targets the `latest` npm tag, and every
  package gained a `publish:npm:next` for `next` previews.
- The registry's canonical discovery paths are `/api/call/discovery` and
  `/api/call/services`, derived from `VAPI_REGISTRY_URL`. The historical
  `/api/marketplace/discovery` and `/api/network/services` paths are deprecated
  and normalized to the canonical pair.

### Fixed

- Pay-path fixes: `call.inspect` exposes a listing's executable request contract
  before payment, mirrored external listings stay off the Call surface, and
  spend policy is applied before signing so a declined call never creates a
  payment authorization.
