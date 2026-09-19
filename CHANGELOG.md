# Changelog

All notable changes to the published `vapi-network` distribution and its four
scoped packages. The packages share one version and are released together.

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
