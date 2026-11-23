---
title: "Stay live"
description: "Call rechecks self-listed and direct Partner APIs hourly; three consecutive failures suspend discovery until activation passes."
order: 17
---

Call checks live listings after they are published. Use the recheck route when you have fixed an endpoint or want to refresh its liveness record.

## Recheck schedule

Self-listed and Partner listings in direct mode are rechecked every hour, oldest check first. Each check reads a live x402 quote from every endpoint. It accepts the proven payout wallet or the stored legacy splitter; activation requires direct payout.

Mirrored External listings are checked at most once a day, oldest check first, with up to 50 mirrors per run. The mirror check asks only whether the listed route is still there. It does not rewrite the catalog's price, endpoints, or payout terms.

## Strikes and recovery

For a self-listed or Partner listing, a failed check adds a strike. Three consecutive strikes suspend the listing and remove it from discovery. Verification is not changed by a liveness suspension.

Fix the endpoint and set its live `payTo` to your proven payout wallet, then press Go live on My APIs at `/call/my-apis`. The listing is re-probed and its strike count is cleared.

For a mirrored listing, HTTP 402, 400, 405, 415, 422, 401, 403, and 429 count as a live response. No response, a timeout, 404, 410, a 5xx, or any other status is a strike. Three consecutive failures suspend the mirror. A later daily pass lists it again.

## Revenue in My APIs

Sign in to [My APIs](https://api.vapinetwork.ai/call/my-apis) to see each listing's settled USDC revenue.
Revenue includes canonical Solana USDC alongside supported EVM USDC.
Amounts keep USDC's six-decimal precision and show at least two decimal places.

| Row                     | Values                                                                      |
| ----------------------- | --------------------------------------------------------------------------- |
| Earned (30d)            | Net USDC, gross USDC and settled-call count for the last 30 days.           |
| Last 60 days            | Net USDC, gross USDC and settled-call count for the retained 60-day window. |
| No retained settlements | No settled calls yet.                                                       |

Gross is the buyer's payment.
Net subtracts the legacy splitter fee only when the actual recipient matches the listing's stored splitter.
Direct Solana payments have equal gross and net amounts.
Solana recipient matching preserves case; EVM matching ignores case.

## Trigger a public recheck

Anyone can trigger a public recheck through the [listing resync endpoint](/reference/http-api/listing-detail/).

The request has no body. The response reports `refreshed`, `failed`, `suspended`, or `not_live`. Mirrored rows are refreshed by the external catalog, so this route returns `mirrored` for them.

Account authentication can use email or Google. Payout-wallet signatures still prove the wallet that receives payments.
Sensitive writes on applicable own-wallet accounts can require wallet proof even after account sign-in.

Checked on 2026-11-17.
