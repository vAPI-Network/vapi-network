# Changelog

All notable changes to the published `vapi-network` distribution and its four
scoped packages. The packages share one version and are released together.

## 0.4.0

Listing on vAPI became permissionless, so "is this listed?" stopped being a
useful question and "how far did vAPI review it?" took its place. The registry
now returns a verification tier on every listing, and the client's job is to
carry that tier all the way to whoever is about to spend money — one switch to
widen the search, one word on every result, and one line before an unverified
payment. Nothing is blocked; nothing is decided for you.

### Added

- `vapi publish <url>`: listing an API from the terminal. vAPI probes the URL —
  an origin, one endpoint, or an OpenAPI document — and prints every probe step;
  a refusal prints its code, reason and hint and exits `2` before anything is
  signed. You choose which of the endpoints it found to list, on a terminal or
  with `--select`/`--yes`, and the local wallet signs one EIP-4361 line,
  `Confirm this wallet receives vAPI Call payouts`, bound to the registry's host
  and to Base. The answer names the slug, the FeeSplitter address per network
  and the one step that stays in the console, because deploying the splitter is
  a wallet transaction. `vapi publish activate <slug>` takes the listing live,
  `vapi publish verify-request <slug>` asks for the review that ends the
  `[unverified]` tag, and `vapi publish list` shows what this key owns.
  `--json` emits the registry's raw responses.
- `vapi claim <origin>`: the owner of an API vAPI indexed from a public
  catalog takes those listings over. vapi fetches the registry's EIP-4361 claim
  message for the local wallet, refuses to sign one that is not bound to the
  registry's host, this wallet, Base and that origin, signs it on the same path
  as the publish payout line, and prints the slugs it claimed. A wallet that is
  not the payee (403), an origin with nothing to claim (404) and listings that
  already have an owner (409) each get a sentence. Needs `vapi auth set-key`;
  like publishing, there is no MCP tool for it. Each claim writes a
  `listing.claim` audit line.
- `vapi auth set-key`, `vapi auth status` and `vapi auth clear` for the registry
  API key. The key is typed on a prompt and never passed as an argument, is kept
  in the same OS secret store as the wallet passphrase — or in
  `~/.vapi/config.json` at mode 0600 where there is none — and is masked
  wherever it is reported. `VAPI_API_KEY` overrides both, for CI. It lives
  behind `@vapi-network/core/api-key`, which `packages/mcp` is lint-forbidden to
  import: there is no publish tool and no agent path to a provider credential.
- `verification` on every discovery hit and every service record, one of
  `"none"`, `"requested"` or `"verified"`. A registry that predates the tier,
  or one that starts sending a tier this client does not know, reads as
  `"none"` — the client never invents an endorsement. Rows mirrored from an
  external catalog are always `"none"`.
- `vapi search --include-unverified` and the `includeUnverified` argument on
  `call.search`: the one trust switch. Without it, results are vAPI-verified
  listings plus the mirrored external catalogs; with it, self-listed APIs that
  passed vAPI's automated x402 probe but were never reviewed are returned too.
  Only the opt-in is sent to the registry.
- `vapi search` tags every result with its tier next to its group —
  `[verified]`, `[requested]`, `[unverified]`, or `[external]` for a mirrored
  row, which is never repeated when the group already says `external`.
- `vapi inspect` prints a `Verification:` line and the network fee label above
  the record, and `vapi pay` prints one line naming the tier before the result
  when the listing it just paid was not verified. Neither prompts nor blocks.
- `verification` in `--json` on `search`, `inspect` and `pay`, and on the
  `call.search`, `call.inspect` and `call.pay` MCP results.
- `vapi pay --resume <receipt-id>`: after a paid call lost its response, asks
  the receipt's token contract, with EIP-3009 `authorizationState(authorizer,
nonce)`, whether the signed authorization was used — `settled` (do not pay
  again), `expired` (never used and past `validBefore` by chain time, so paying
  again is safe) or `pending` (wait until the time it prints). It unlocks no
  wallet and signs nothing. EVM only; a Solana receipt says it is not supported
  yet. Receipts now record `authorization: { from, nonce, validBefore }` for
  every EVM payment they sign; older receipts parse unchanged and are named as
  predating it. Every `settlement_unknown` "do not retry automatically" message
  from `vapi pay` and `call.pay` now ends with the exact `vapi pay --resume`
  command for its receipt.
- `vapi inspect` prints a `Liveness:` line — uptime over seven days of hourly
  re-probes, p50 and p95 latency — and a `Conformance:` line — declared x402
  version, whether the 402 follows it, where the offer travels, issue codes —
  when the registry sends `liveness` and `conformance`. Both are optional on
  every discovery hit and service record, reach `--json` and `call.inspect`
  unchanged, and a malformed value reads as absent rather than failing the
  listing.
- `includeUnverified` on `discover()` and on the `Source.search` seam, and
  `verification` on core's `Listing`. Sources that have no notion of vAPI
  verification ignore the option and claim no tier.

### Changed

- `call.pay`'s tool description now tells an agent to prefer a verified listing
  and to read the request contract and the price with `call.inspect` before
  paying one that is not.
- Resolving one exact ref — `vapi inspect`, `vapi pay`, and the registry
  source's `inspect` — always asks the registry for unverified listings too.
  Resolving a ref the caller already holds is not a browse, so the tier is
  disclosed rather than used to hide the answer.
- Every package, `scripts/pack-check.mjs`, `CLI_VERSION` and
  `VAPI_CLIENT_VERSION` move to 0.4.0.

## 0.3.0

Several wallets on one machine, a passphrase that no longer has to sit in an
editor's configuration file, and a hard line between what a person may see and
what an agent may.

### Added

- Several wallets on one machine. `~/.vapi/wallets/<name>.json` holds one
  keystore per wallet and `~/.vapi/wallets.json` records which wallet is the
  default, what each one may spend per call and per day, and its optional
  label. Names are 1 to 32 characters of lowercase letters, digits and dashes.
- `vapi wallet list|create|use|rename|remove|restore|caps` manages those
  wallets. `list` shows the address, the default marker, the caps in US
  dollars, whether the wallet is unlocked, and the label; `caps` takes
  `--per-call` and `--per-day` in dollars; `remove` asks you to type the wallet
  name and prints where the keystore went.
- `--wallet <name>` on every command that touches a wallet, with `VAPI_WALLET`
  and the machine default behind it. Each of those commands names the wallet it
  used: `Wallet: <name> (<address>)` on the first line in text mode, and a
  `wallet` field in `--json`. `vapi receipts` and `vapi stats` show the selected
  wallet and take `--all-wallets`; `vapi import` writes a named wallet.
- Spend caps belong to the wallet, not to the machine, so an agent wallet can be
  given a small daily allowance while your own keeps a large one. Today's totals
  are counted per wallet in `spend-ledger.json`; rows written before named
  wallets count as `main`.
- Receipts record the wallet that paid. `receipts.jsonl` rows gain an optional
  `wallet` field, rows written before named wallets read as `main`, and renaming
  a wallet rewrites its rows in one atomic replacement.
- Removing a wallet is a move, not a delete: the encrypted keystore goes to
  `~/.vapi/wallets/.trash/`, where `vapi wallet restore` can bring it back. The
  default wallet is refused until another one is made the default, and a wallet
  that still holds USDC is refused unless you force it.
- `vapi unlock [--wallet <name>]` and `vapi lock [--wallet <name> | --all]` keep
  a wallet's passphrase in the OS secret store instead of in an editor's
  configuration file: the macOS Keychain through `security`, or libsecret
  through `secret-tool` on Linux, under the service `vapi-network` and the
  wallet's name. `unlock` runs only on a real terminal with no agent marker set,
  and verifies that the passphrase actually opens the wallet before storing it.
  The passphrase is handed to the OS binary over stdin, never as a command-line
  argument, so it never appears in `ps`. No new dependency. Windows keeps
  `VAPI_KEYSTORE_PASSWORD` until there is a Credential Manager path.
- `wallet.list` and `wallet.use` on the MCP server. `wallet.list` returns every
  wallet with its address, label, spend caps in both atomic USDC and US dollars,
  USDC balances, and which one is the default and which one the session pays
  from; a wallet whose RPC is unreachable reports `balanceError` and the rest of
  the list still answers. `wallet.use` points the session at another wallet for
  the lifetime of that process only — it never writes `wallets.json`, so the
  default a human chose in their terminal is untouched.
- An optional `wallet` argument on `wallet.address`, `wallet.balance`,
  `wallet.accounts`, `wallet.fund`, `call.pay`, `receipts.list` and
  `receipts.stats`. Without it the session's active wallet is used, then
  `VAPI_WALLET`, then the machine default. Every tool result now carries the
  `wallet` field it used, `call.pay` applies that wallet's own spend caps and
  tags its receipt with its name, and `receipts.list` and `receipts.stats`
  filter by it or take `allWallets: true`.
- An agent can no longer be shown a secret. `vapi backup` and `vapi export-key`
  run only when stdin and stdout are a real terminal, no agent or CI marker is
  set (`VAPI_NO_SECRETS`, `CLAUDECODE`, `CLAUDE_CODE`, `CURSOR_AGENT`,
  `CODEX_SANDBOX`, `OPENAI_CODEX`, `AGENT`, `CI`), and the person types the
  wallet name to confirm. Otherwise they print nothing and say so. `vapi init`
  and `vapi wallet create` still create the wallet and point at `vapi backup`.
- `~/.vapi/audit.log` (mode 0600) gets one JSON line per secret export, per
  wallet change and per MCP session wallet switch: time, event, wallet, whether
  a terminal was attached, and the agent marker that was set. It never contains
  the secret itself.
- `@vapi-network/core/secrets`, a separate package entry point for the functions
  that return a recovery phrase or a private key: `exportRecoveryPhrase`,
  `exportKeystoreKeys`, `createKeystoreWithPhrase` and `decryptPrivateKey`.
- `examples/wallets.ts`, which lists, creates and re-caps wallets through the
  SDK. Both examples are type-checked by `pnpm typecheck`.

### Changed

- Every unlock resolves its passphrase the same way, in one place:
  `VAPI_KEYSTORE_PASSWORD` first, then the OS secret store entry for that
  wallet, then a prompt on a terminal. A run with none of the three names both
  other routes, including `vapi unlock`, instead of only the environment
  variable. A stored passphrase that no longer opens its wallet says exactly
  that and points at `vapi unlock`; `vapi passphrase` removes the stored copy
  when it changes the passphrase, so a stale entry cannot outlive it. The SDK
  entry point is `resolvePassphrase` in `@vapi-network/core`.
- The MCP server no longer pays from one account unlocked at startup. It
  resolves the wallet a tool call names and unlocks that wallet for that one
  payment, so `wallet.use` actually changes which key signs. Reads — addresses,
  balances, accounts and funding links — need no passphrase at all. An agent is
  never prompted.
- `vapi init` on a machine that already has a wallet is no longer an error: it
  says nothing was created and lists the wallets it found, without asking for a
  passphrase.
- `vapi import` writes a new named wallet instead of replacing the only one.
  `--wallet <name>` chooses it, and `main` is assumed only on a machine that has
  no wallet yet. `--replace` moves the named wallet to `wallets/.trash/` first,
  still refusing a wallet that holds USDC unless `--force`.
- `vapi wallet list` gained an `UNLOCKED` column, and `unlocked` in `--json`:
  which wallets an agent can pay from without being given a passphrase.
- `vapi mcp` takes `--wallet <name>`, which the help text now lists, and `vapi
help` is listed alongside `vapi version`.
- The README is rebuilt around the current surface: a quickstart in the order
  `vapi init` itself prints, one table for every CLI command and flag, one table
  for every MCP tool, and the SDK's two entry points side by side.

### Deprecated

- The pre-namespace MCP tool aliases `search`, `inspect`, `call` and `wallet`
  still work and still behave identically to `call.search`, `call.inspect`,
  `call.pay` and `wallet.balance`, and each result carries one `DEPRECATED:`
  line naming its replacement. They will be removed in a later release.
- `~/.vapi/keystore.json` survives the 0.3.0 migration as a mode 0600 symlink to
  `wallets/main.json`, for one release only. Scripts that read it directly
  should move to `wallets/<name>.json` or to `WalletStore`.

### Removed

- `createOnrampSession` and its `OnrampSession` and `CreateOnrampSessionOptions`
  types, deprecated in 0.2.5. The session token it minted was single-use and
  expired minutes later, so a link printed in a terminal was usually dead before
  anyone clicked it. `fundingPageUrl` — which `vapi fund` and `wallet.fund`
  already use — mints the session at click time instead.
- `openWallet` and `listReceipts` from `@vapi-network/core`. Nothing called
  either; `openWallet` also defaulted to the legacy `keystore.json` path, which
  is now a compatibility symlink. Use `WalletStore.open(...).unlock(name, …)`
  and `readReceipts`.

### Migration from 0.2.x

Nothing to do by hand. The first command you run on a 0.2.x home migrates it
once, when the wallet store is opened: `keystore.json` moves to
`wallets/main.json` with its contents untouched, `config.json`'s spend caps
become the caps of the wallet `main`, and `keystore.json` stays behind as a mode
0600 symlink for one release so existing scripts keep working. A home without a
keystore migrates nothing, and no keystore file is ever rewritten.

Receipts written before this release have no `wallet` field and read as `main`,
so `vapi receipts` and `vapi stats` show your history unchanged. Spend caps now
live on the wallet rather than in `config.json`; set them with `vapi wallet caps
<name> --per-call <usd> --per-day <usd>`. `VAPI_KEYSTORE_PASSWORD` is still
honoured, and is still checked first — `vapi unlock` is the new option, not a
replacement.

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
