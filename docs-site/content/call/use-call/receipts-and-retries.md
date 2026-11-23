---
title: "Receipts and retries"
description: "Every paid Call request leaves a receipt. Use it to see what you paid, to check an uncertain settlement onchain, and to retry safely when the API supports…"
order: 6
---

A receipt records one paid call: the quote, the settlement and the latency. Use it to see what you paid and to answer the one question a lost response leaves: did that payment settle?

## Where receipts are

- The `vapi` client writes a local receipt for every paid call, from the CLI, the MCP server and the SDK alike. They live under `~/.vapi` and never leave your machine.
- The console shows the settlement reference on the page after a paid call. The Usage page at `/call/usage` lists the paid calls your connected wallet settled, read from the chain.

List receipts:

```bash
vapi receipts
vapi receipts --limit 20
vapi receipts --all-wallets
```

```text
Wallet: main (0x782F38a2cADbeA094bc89895A1edf965901A7600)
2026-10-15T09:41:12.000Z	succeeded	GET https://weather.cyberwarex.com/forecast (https://basescan.org/tx/0x...)
```

Each line is the time, the settlement outcome (`succeeded`, `rejected` or `unknown`), the request, and the explorer link when the settlement names a transaction. Export them for a spreadsheet or a ledger:

```bash
vapi receipts export --format csv --range 30d
vapi receipts export --format json --range 7d
```

`vapi stats --range 7d` sums the same receipts: spend, calls, outcomes, latency and the APIs you used most.

## Check an uncertain payment

Slow providers get up to 120 seconds for the paid response by default. Use `--timeout <seconds>` to raise the wait, up to 300 seconds and capped at the offer's `maxTimeoutSeconds`. A timeout reports `settlement_unknown`.

When a paid call returns nothing, the client refuses to guess and names its receipt. Ask the chain before anyone pays again:

```bash
vapi pay --resume <receipt-id>
```

```text
Receipt: rcpt_… — POST https://gateway.thegraph.com/api/x402/subgraphs/id/…
Authorization: nonce 0x… from 0x782F…7600, USDC 0x8335…2913 on eip155:8453, valid before 2026-10-15T09:46:12.000Z
Settled: the authorization was used on-chain, so the payment went through. Do not pay again.
```

The client reads the authorization's state from the USDC contract. It opens no wallet, signs nothing and pays nothing. Three answers are possible:

| Answer  | Meaning                                                     | What to do                                                                           |
| ------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Settled | The authorization was used. The payment went through.       | Do not pay again. Ask the provider for the response if you need it.                  |
| Expired | The authorization was never used and its window has passed. | Paying again is safe.                                                                |
| Pending | Unused, but still inside its window.                        | Wait until the time printed, then run the command again. Paying now could pay twice. |

In MCP, `call.pay` returns `settlement_unknown` in the same situation and names the receipt for this command. An agent should stop and report, not retry.

## Safe retries with payment identifiers

Some APIs advertise the x402 `payment-identifier` extension. The client then generates an identifier, sends it with the payment and stores it on the receipt as `paymentId`. Retrying the same request with the same identifier returns the cached response without a second settlement. Reusing the identifier for a different request is rejected. See [x402 extensions](/call/reference/x402-extensions/).

![Two ways to recover a paid call. Response lost: a paid call returned no response, so the payment may or may not have settled; vapi receipts lists every paid call with its ID; vapi pay --resume with that receipt ID reads the authorization's state onchain. No wallet is opened, nothing is signed, and nothing is paid again. Safe retry, when the API advertises payment-identifier: retry the request with the same payment-identifier as the first attempt. With the same request fingerprint you get the cached response and no second settlement. With a different fingerprint the retry is rejected, because the identifier was already used for another request. One identifier means one settlement.](vapi-receipts-retries-light.svg)
![Two ways to recover a paid call. Response lost: a paid call returned no response, so the payment may or may not have settled; vapi receipts lists every paid call with its ID; vapi pay --resume with that receipt ID reads the authorization's state onchain. No wallet is opened, nothing is signed, and nothing is paid again. Safe retry, when the API advertises payment-identifier: retry the request with the same payment-identifier as the first attempt. With the same request fingerprint you get the cached response and no second settlement. With a different fingerprint the retry is rejected, because the identifier was already used for another request. One identifier means one settlement.](vapi-receipts-retries-dark.svg)

_Reconcile with the receipt, or retry with the same payment identifier. Neither pays twice._

Call statistics use retained snapshots. The console describes these as “Onchain x402 payments to the APIs Call indexes.”
The 7d and 30d totals combine closed UTC-day rollups with live today.
Producers use live summaries if rollup coverage is incomplete or outdated; reads do not start expensive summaries.

| Window | Freshness                                                                     |
| ------ | ----------------------------------------------------------------------------- |
| 24h    | Fresh for one minute, stale for another 15 minutes.                           |
| 7d     | Fresh for 15 minutes; snapshots retained another day beyond the stale window. |
| 30d    | Fresh for 15 minutes; snapshots retained another day beyond the stale window. |

Failed refreshes preserve last-good data and its generatedAt timestamp. Missing snapshots fail immediately.
The console shows “Stats unavailable” when statistics cannot be read.

These network snapshots differ from CLI receipt statistics, which sum locally retained receipts.

## Next

- [Pay with the CLI, MCP and SDK](/call/use-call/pay-with-vapi/)
- [How Call works](/call/how-call-works/)

Checked on 2026-11-17.
