---
title: "Claim your listing"
description: "Providers can claim a mirrored Call listing by proving control of the wallet that receives its x402 payments."
order: 18
---

Call can mirror an API before its provider creates an account. Use a claim when your API is already in the External catalog and its x402 quotes pay your wallet.

## Claim in the console

Open the mirrored listing and choose **Claim it**. Continue in **My APIs** at `/call/my-apis`; the console starts the claim for the listing's origin.

Sign the EIP-4361 message with the listing's payout wallet. The message is bound to the vAPI host, Base, the origin, and the statement `Claim the vAPI Call listings served from <origin>`.

## Claim with `vapi`

Set an API key, then pass the origin and the wallet that the x402 quotes use:

```bash
vapi auth set-key
vapi claim https://weather.example --account payout
```

The client gets the claim message, checks that it names the expected host and origin, signs it locally, and submits it. A wallet that is not the payee cannot claim the listing.

## After the claim

Every unowned mirrored listing from that origin whose EVM quotes pay the signing wallet becomes part of your profile. It remains an External, direct-payout listing, so its network fee stays at 0%. The claim changes who manages the listing, not how buyers pay.

You can then edit the name and description and request verification:

```bash
vapi publish list
vapi publish verify-request <slug>
```

The claim API returns `not_payee` when the wallet is not the payee, `no_listings` when there is no unclaimed listing for the origin, `already_owned` when all matching listings already have an owner, and `invalid_signature` when the signature is invalid.

Checked on 2026-10-15.
