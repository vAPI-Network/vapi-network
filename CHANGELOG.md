# Changelog

All notable changes to the published `vapi-network` distribution and its four
scoped packages. The packages share one version and are released together.

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

### Changed

- The registry's canonical discovery paths are `/api/call/discovery` and
  `/api/call/services`, derived from `VAPI_REGISTRY_URL`. The historical
  `/api/marketplace/discovery` and `/api/network/services` paths are deprecated
  and normalized to the canonical pair.
- `vapi-network` now publishes to the `latest` npm tag via `publish:npm`; the
  `next` tag stays available through `publish:npm:next`.

### Fixed

- Pay-path fixes: `call.inspect` exposes a listing's executable request contract
  before payment, mirrored external listings stay off the Call surface, and
  spend policy is applied before signing so a declined call never creates a
  payment authorization.
