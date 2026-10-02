# Call

Discovering, checking, publishing and paying for APIs are covered here; see [README.md](../README.md).

## Reading search results

That is the same order `vapi init` prints as its next steps, and the same order
`vapi` alone lists. Two more are worth knowing early: `vapi inspect <ref>` shows
a listing's request contract and live 402 quote for free, before you pay, and
`vapi balance` shows what the wallet holds.

`vapi search` tags each listing with its group, `[vapi]`, `[added]`,
`[partner]` or `[external]`, and prints the network fee that is already inside
the price. vAPI and added APIs carry a 5% network fee inside the quoted price;
partner and external listings carry none. `vapi inspect` and `--json` return the
same `group` and `fee` fields.

Listing on vAPI is permissionless, and verification is a tier on top of it. Each
result also carries `[verified]`, `[requested]` or `[unverified]`, and a
mirrored catalog row carries `[external]` instead. By default `vapi search`
answers with vAPI-verified listings plus the mirrored external catalogs;
`--include-unverified` also returns self-listed APIs that passed vAPI's
automated x402 probe but were never reviewed. `vapi inspect` prints a
`Verification:` line, `vapi pay` says so in one line before the result when the
listing it just paid is not verified, and `--json` carries `verification` on
all three.

`vapi inspect` also says how a listing has behaved lately, when the registry
has measured it: a `Liveness:` line with its uptime over the last seven days of
hourly re-probes and its p50 and p95 latency, and a `Conformance:` line with the
x402 version its 402 declares, whether it follows that version, where the offer
travels, and any issue codes, the same codes `vapi check` reports. A registry
that has not measured a listing sends neither, and neither line is printed.
`--json` carries them as `liveness` and `conformance`.

When the registry knows it, `vapi inspect` also prints the listing's ERC-8004
agent identity on Base and its reputation. The client reads these fields from
the registry and does not read the chain.

## Paying and resuming

`vapi pay` also accepts `--max-price-usd` as a long-standing alias for `--max`;
the two cannot be combined. When a paid call loses its response, `vapi pay` refuses to guess
and names its receipt: `vapi pay --resume <receipt-id>` asks the token contract
on that receipt's network, with EIP-3009 `authorizationState(authorizer,
nonce)`, whether the signed authorization was used. **Settled** means the
payment went through, so do not pay again. **Expired** means it was never used
and the chain is past its `validBefore`, so it never can be, making paying again
safe. **Pending** means it is unused but still valid, so wait until the time it
prints. It unlocks no wallet and signs nothing. EVM only for now; a Solana
receipt says so, and a receipt written before 0.4.0 does not record the nonce.
Every payment payload carries the client code `vapi` in the x402 `builder-code`
extension. When the API advertises `payment-identifier`, vAPI generates one id,
sends it with the payment, records it as `paymentId` on the receipt, and shows
it again in `vapi pay --resume`. `mcp --json` is accepted as a no-op, because
the stdio transport is already JSON-RPC.

## Check your API

`vapi check` is a free x402 conformance doctor for the API you are building. It
asks the URL for its price without paying, grades the 402 the way a client reads
it, and looks for the origin's discovery documents:

```bash
vapi check https://weather.example/forecast
vapi check https://weather.example/alerts --method POST --json
```

| Rule         | Passes when                                                                                                                                                                                             |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `status`     | the URL answers HTTP 402                                                                                                                                                                                |
| `transport`  | the offer is readable: a base64 `PAYMENT-REQUIRED` header, a JSON body, or both; or the 402 carries an MPP (`WWW-Authenticate: Payment`) challenge, which is recognised but not payable with `vapi pay` |
| `version`    | it declares `x402Version` 2 (1 is a warning: v2-only clients cannot pay it)                                                                                                                             |
| `fields`     | every field that version requires is present and well-typed                                                                                                                                             |
| `scheme`     | at least one accepted option is `exact`                                                                                                                                                                 |
| `asset`      | an exact option pays canonical USDC, with USDC's EIP-712 domain, on Base, Arc mainnet, Arc testnet or Solana                                                                                            |
| `pay_to`     | every exact option's `payTo` is a valid, non-zero address for its network                                                                                                                               |
| `timeout`    | `maxTimeoutSeconds` is a whole number between 10 and 3600                                                                                                                                               |
| `extensions` | the offer advertises Bazaar metadata; every known advertised extension is listed                                                                                                                        |
| `discovery`  | `/.well-known/x402` serves a JSON document (a warning otherwise)                                                                                                                                        |
| `openapi`    | a discovered OpenAPI document describes the operation with `x-payment-info`                                                                                                                             |

The JSON report's `transport` field is `x402` or `mpp`; x402-only rules are
skipped for an MPP 402.

The `extensions` rule reports `bazaar`, `builder-code`, `payment-identifier`,
`sign-in-with-x`, `offer-and-receipt` and `auth-hints` in that order. Missing
Bazaar metadata is a `bazaar_metadata_missing` warning because adding it makes
the API discoverable in Coinbase's Bazaar and by Coinbase for Agents. This
local warning does not appear in the registry-shaped `conformance.issues`.

For OpenAPI, the check tries `openapi.json` beside the checked path and then in
each ancestor directory, nearest first, ending at the origin's `/openapi.json`.
If none has a `paths` object, it reads `/.well-known/api-catalog` and follows up
to 10 RFC 9264 `service-desc` links in order. It only follows same-origin links.

Offer findings carry stable snake_case codes, `v2_missing_resource`,
`offer_header_only`, `v2_header_malformed`, `scheme_unsupported` and the rest,
the same codes the registry records for a listing and `vapi inspect` prints.
`--json` returns the whole report, including the advertised `extensions` list
and a `conformance` object in the registry's shape. The exit code is `0` when
nothing failed, warnings included, `1` when a rule failed, and `2` for invalid
usage. No wallet is opened, nothing is signed, and no registry is called: the
only requests go to the origin being checked, through the same network guard as
every other request.

In CI, the repository is also a GitHub Action that runs the published CLI:

```yaml
- uses: vAPI-Network/vapi-network@main
  with:
    url: https://weather.example/forecast
    fail-on: warn # or fail, the default
```

It prints every rule, annotates failures and warnings, exposes the JSON report
as the `report` output, and fails the step on a failed rule, or on a warning
too, with `fail-on: warn`.

## Publish an API

Listing on vAPI is permissionless. vAPI probes the URL you hand it; if it
answers x402, the listing exists, and you decide when it goes live.

```bash
vapi auth set-key                        # paste the key from the console, once
vapi publish https://weather.example     # probe, pick endpoints, sign the payout wallet
vapi publish activate weather-call       # once the FeeSplitter is deployed
vapi publish verify-request weather-call # ask for the review that ends the [unverified] tag
vapi publish list
```

`vapi publish` takes an origin, a single endpoint, or an OpenAPI document, plus
`--mode` when the registry should not have to guess which. It prints every
probe step; on a refusal it prints the code, the reason and the hint, and exits
`2` without signing anything. On a terminal it asks which endpoints to list. A
script names them with `--select forecast,alerts`, or takes all of them with
`--yes`, and then has to supply `--name`, `--description` and `--category`
itself.

A listing holds at most 20 endpoints, so a larger catalog is published as
several listings of up to 20, `Weather (1/4)`, `Weather (2/4)` and so on, in
probe order, each with its own signature of the payout line, and every
endpoint gets one result line: `listed` with its slug, `failed` with the
reason, or `pending` when an earlier refusal stopped the run. A batch refused
on its own merits does not stop the next one; a rejected key, a rate limit or
an outage does. Run the same command again with `--resume` and it asks
`vapi publish list` what this key already lists, skips those endpoints, and
lists only the rest.

Your wallet signs one line, `Confirm this wallet receives vAPI Call payouts`,
so the registry knows where the money goes. It is an EIP-4361 message bound to
the registry's own host and to Base: nothing is paid, nothing is approved, and
no key leaves the machine.

Payouts arrive through a FeeSplitter you own. Deploying it is a wallet
transaction against the factory, so it stays in the console at
`<registry>/providers`; `vapi publish` prints the address it will have on each
network and the exact next step. An active listing answers
`vapi search --include-unverified`, and `vapi publish verify-request <slug>`
asks for the review that puts it in the default search.

### Claim a listing vAPI indexed

vAPI mirrors public x402 catalogs, so your API may already be listed without
you. If it is, you can own those listings instead of publishing new ones:

```bash
vapi claim https://weather.example --wallet payout   # the wallet the listings pay
```

The registry sends an EIP-4361 message bound to its own host and to Base, with
the statement `Claim the vAPI Call listings served from <origin>`. vapi checks
that the message says exactly that for this wallet before it signs anything,
signs it the same way `vapi publish` signs its payout line, and the registry
matches the signer against the listings' `payTo`. Every unowned indexed listing
served from that origin that pays this wallet becomes yours; they stay paid
directly to it with no vAPI fee, `vapi publish list` shows them, and `vapi
publish verify-request <slug>` asks for review. A wallet that is not the payee,
an origin with nothing to claim, and listings that already have an owner each
get their own sentence and exit `1`. Like publishing, claiming needs `vapi auth
set-key` and has no MCP tool.

The API key is a secret like any other here. `vapi auth set-key` reads it from
a prompt, never from an argument, and keeps it in the same OS secret store as
your passphrase, or in `~/.vapi/config.json` at mode 0600 on a platform that
has none. `VAPI_API_KEY` is the route for CI. No agent can reach it: there is
no publish tool on the MCP server, and the key lives behind its own package
entry point that `packages/mcp` is forbidden to import.

## Discovery sources

Discovery is a plugin interface. The client merges listings from several
sources, de-duplicates them by normalized resource URL, and keeps each listing's
provenance:

- **vAPI Registry**, enabled by the default distribution, using
  `https://api.vapinetwork.ai/api/call/discovery` and
  `https://api.vapinetwork.ai/api/call/services`. If the primary returns HTTP
  404 or cannot be resolved, the client logs one notice and tries the hosts in
  `registryFallbacks` on the same canonical paths. The historical
  `/api/marketplace/discovery` and `/api/network/services` paths are deprecated;
  a base URL supplied on either is normalized to the canonical pair.
- **Coinbase Bazaar**, the public x402 v2 `/discovery/resources` catalogue
  exposed by a facilitator.
- **Local file**, a JSON array of listings for private or development
  catalogues.
- **x402scan**, a deliberate stub until x402scan documents a stable public read
  API this client can safely target.

Use `@vapi-network/sources` to compose only the catalogues you trust. Every
outbound request is guarded against local and private destinations before it is
made, and redirects and resolved IP addresses are re-validated as new
destinations.
