# Configuration

Configuration, funding, networks, sign-in and local metrics are covered here; see [README.md](../README.md).

## Configuration

Local state lives in `~/.vapi/`:

```text
config.json           registry URLs, networks, RPC endpoints and device name
vault.json            encrypted device phrase and account keys
wallets.json          default account, caps, labels and account links
wallets/
  <name>.json         legacy keystores or compatibility links after migration
  .trash/             removed accounts, kept encrypted
wallets.migrated/      archived legacy keystores
audit.log             one JSON line per secret export or account change
receipts.jsonl        the append-only call ledger
searches.jsonl        one line per discovery query
spend-ledger.json     today's spend reservations and totals, per account
update-check.json     cached npm update check
reports/              what vapi report writes
```

`keystore.json` is retired by the device-vault migration. See the [wallet guide](wallets.md#migration-from-05) for legacy files.

| Variable                 | What it does                                                                               |
| ------------------------ | ------------------------------------------------------------------------------------------ |
| `VAPI_HOME`              | Use a different directory instead of `~/.vapi`                                             |
| `VAPI_WALLET`            | The account to use when no `--account` is given                                            |
| `VAPI_REGISTRY_URL`      | Replace the registry base; canonical discovery paths derive from it                        |
| `VAPI_VAULT_PASSWORD`    | Supply the password for a protected device vault in unattended use                         |
| `VAPI_KEYSTORE_PASSWORD` | Legacy keystore passphrase; deprecated alias for a vault password                          |
| `VAPI_API_KEY`           | Registry key for human publishing or CI; overrides the OS secret store and config fallback |
| `VAPI_NO_SECRETS`        | Set to `1` to refuse recovery phrase and private key exports                               |
| `VAPI_DEVICE`            | Override the device name sent with account link requests                                   |
| `VAPI_DOCS_URL`          | Override the public documentation origin                                                   |
| `VAPI_NO_UPDATE_CHECK`   | Set to `1` to disable the interactive npm update check                                     |

`config.json` accepts these fields:

| Field                          | What it controls                                                                      |
| ------------------------------ | ------------------------------------------------------------------------------------- |
| `discoveryUrl`                 | Service catalogue URL; defaults to `https://api.vapinetwork.ai/api/call/services`     |
| `marketplaceDiscoveryUrl`      | Ranked discovery URL; defaults to `https://api.vapinetwork.ai/api/call/discovery`     |
| `registryFallbacks`            | Optional pairs of service and ranked discovery URLs                                   |
| `networks`                     | Network-keyed RPC URLs, USDC addresses, optional deposit guidance and EIP-712 domains |
| `spendCaps`                    | Legacy fallback caps; current account caps live in `wallets.json`                     |
| `device`                       | Device name for account linking                                                       |
| `allowPrivateNetwork`          | Allow private destinations for a development registry; defaults to false              |
| `tasksEscrowFactoryOverrides`  | Trusted escrow factory by chain ID for Tasks preview                                  |
| `tasksEscrowDurationOverrides` | Trusted work and review durations by chain ID for Tasks preview                       |

The raw file may also contain an `apiKey` fallback on platforms without an OS secret store. Parsed configuration drops that secret; config rewrites preserve it. MCP cannot import the API-key entry point.

The `device` field in `config.json` names the device sent with link requests, uses 1 to 32 lowercase letters, digits, or dashes, and is written from the hostname on first use.

`BASE_RPC_URL` overrides the Base RPC. `ARC_RPC_URL` overrides the Arc mainnet RPC. `ARC_TESTNET_RPC_URL` and
`SOLANA_RPC_URL` point those two networks at an endpoint you trust. On first
use of the default home, the client copies an existing `~/.vapi/agent-cash/`
configuration into `~/.vapi/` when it can do so without overwriting files,
prints a notice, and leaves the old directory alone.

## Funding

```bash
vapi fund                 # open the funding page for your address
vapi fund --amount 25     # prefill a US dollar amount
vapi fund --json          # { address, network, url }
```

`vapi fund` prints `<registry>/fund/<your-address>` and opens it in your default
browser when you are on a terminal. The page offers three routes: a card via
Coinbase (needs a Coinbase account; US guest checkout), a transfer from
MetaMask, Coinbase Wallet or WalletConnect, or a bridge from another chain. It
is public, takes no sign-in, and mints the card session when you click, so the
link keeps working while you log in, and nothing expires in your scrollback.

The command itself makes **no network call**: it works offline, and it always
also prints

```text
Send USDC on Base (eip155:8453) to this address; add a little ETH for gas if you plan to sweep.
```

Whichever route you pick, the USDC lands on your local address on Base. **vAPI
never holds your funds**, never proxies the payment, and never sees your card
details or your private key. MCP clients use `wallet.fund`, which returns the
same `{ address, network, url }` plus a line telling the agent to hand the link
to its human.

## Networks and accounts

| Network        | x402 identifier                                       | USDC                                           | Gas / RPC notes                                                      |
| -------------- | ----------------------------------------------------- | ---------------------------------------------- | -------------------------------------------------------------------- |
| Base mainnet   | `eip155:8453`                                         | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`   | ETH; defaults to `https://mainnet.base.org`                          |
| Arc mainnet    | `eip155:5042`                                         | `0x3600000000000000000000000000000000000000`   | USDC is also the gas token; defaults to `https://rpc.mainnet.arc.io` |
| Arc testnet    | `eip155:5042002`                                      | `0x3600000000000000000000000000000000000000`   | USDC is also the gas token; set `ARC_TESTNET_RPC_URL`                |
| Solana mainnet | `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d` | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` | SOL; defaults to `https://api.mainnet-beta.solana.com`               |

The x402 reference packages shorten the Solana CAIP-2 reference to
`solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`; vAPI accepts that identifier as an
alias while persisting the full genesis hash above. Enable Arc mainnet with
`vapi init --networks base,arc` (or the same `--networks` value on `vapi import`), `vapi accounts --enable arc`, or `ARC_RPC_URL`. Its
explorer is `https://explorer.arc.io`.

The legacy `vapi accounts --account <name>` and `vapi accounts --enable <network>` forms list one deposit account per configured network: its CAIP-2 ID,
network name, address, atomic and formatted USDC balance, gas-token balance, and
deposit guidance. Account lookup dispatches by CAIP namespace, so the EVM and
Solana adapters stay independent of one another. The current `vapi accounts` command lists vault accounts; see the [wallet guide](wallets.md#accounts). For Arc testnet, add the faucet
to that network's `config.json` entry:

```json
{
  "depositUrl": "https://your-arc-faucet.example",
  "depositInstructions": "Use the configured Arc testnet faucet, then send USDC to this address."
}
```

Arc mainnet uses the default public RPC or `ARC_RPC_URL` and needs no faucet
configuration.

Solana listings remain searchable, but the device vault does not support Solana keys yet. Inspecting or paying a Solana listing returns `unsupported_network`. Solana setup through `vapi init --networks base,solana` or `vapi accounts --enable solana` is refused. The network table describes protocol metadata, not released vault payment support.

## Sign-in with X

x402 v2 services can require Sign-In-With-X (SIWX) before returning a price.
When `vapi pay` or `call.pay` receives that challenge, vAPI checks that both the
challenge domain and URI match the final resource origin, signs the canonical
EIP-4361 message locally with EVM `personal_sign`, and retries once with
`SIGN-IN-WITH-X`. The proof is never sent to a redirect or a different host.

If the retry returns a normal 402 quote, the usual spend-policy and payment flow
continues. If the resource is free after sign-in, the result has
`outcome: "signed_in"` and the local receipt records `amountAtomic: "0"`.

## Metrics and bug reports

vAPI measures call and discovery health locally and uploads nothing. Receipts
can include the listing name and provider host, policy decision, retry count,
client version, outcome, total latency, and discovery, quote, signing, request
and settlement phase timings. Policy declines are recorded with the quoted
amount but without a payer or transaction, so blocked spend stays visible
without creating a payment authorization. Search events record the query,
sources tried, per-source latency and result count, merged result count and
timestamp.

```sh
vapi stats --range 7d
vapi receipts export --format csv --range 30d
```

When the registry reports it, `vapi stats` also shows the network-wide amount routed through vAPI for 24h and 30d in USD plus the 30d transaction count. This covers all vAPI clients, not just this wallet.

`vapi report "<what happened>"` writes `$VAPI_HOME/reports/<timestamp>.json` and
prints that path plus a prefilled GitHub issue URL. Reports contain the message,
client version, OS and Node information, and only the newest five receipt IDs.
Wallet and payee addresses are included only with `--include-addresses`; amounts
never are. Nothing is uploaded unless `--send` is explicit.
