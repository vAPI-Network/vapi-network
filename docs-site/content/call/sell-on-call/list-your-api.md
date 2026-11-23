---
title: "List your API"
description: "List a provider-hosted x402 API on vAPI Call: serve a USDC offer, prove your payout wallet, pass the automated probe, and meet the publication requirements."
order: 12
---

Listing on Call is permissionless: your API can go live after its endpoints pass the automated x402 probe and pay your signed payout wallet directly. No review is needed to be listed; [verification](/call/sell-on-call/get-verified/) is a separate tier that puts you in default search. Prepare the payment challenge, OpenAPI metadata, and browser access before you publish.

## What a listing needs

| Piece        | Requirement                                                                                                                                                                                           |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 402 response | Return x402 v2 with the `exact` scheme in both the JSON body and the base64 `PAYMENT-REQUIRED` header for a clean conformance check. An otherwise valid offer in either carrier lists with a warning. |
| Asset        | Use canonical USDC on a [supported self-listing network](/call/reference/networks-and-schemes/). This example uses Base, `eip155:8453`, at `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`.              |
| `payTo`      | Set every endpoint's live `payTo` to the payout wallet you prove by signature. No splitter deployment is required.                                                                                    |
| OpenAPI      | For OpenAPI publishing, declare a `402` response and `x-payment-info` on every paid operation. A single concrete endpoint can be listed without OpenAPI.                                              |
| CORS         | For browser calls, allow the console origin and expose `PAYMENT-REQUIRED` and `PAYMENT-RESPONSE` to browser JavaScript. Listing can succeed without confirmed CORS, with a warning.                   |

## A minimal paid endpoint

Replace the example `payTo` value in the handler with your signed payout wallet. This Hono handler uses the Coinbase x402 facilitator at `https://x402.org/facilitator`. It returns the same v2 fields as the real 402 sample, including the resource and payment option fields.

```ts
import { Hono } from "hono";
import { cors } from "hono/cors";
import { serve } from "@hono/node-server";

const app = new Hono();
const facilitator = "https://x402.org/facilitator";
const payTo = "0x7B5592D2F8adBF58b4A69b374636EC918F21eFAb"; // replace with your payout wallet
const offer = {
  x402Version: 2,
  error: "Payment required",
  resource: {
    url: "http://localhost:4242/paid",
    description: "A paid example resource.",
    mimeType: "application/json",
    serviceName: "Provider API",
  },
  accepts: [
    {
      scheme: "exact",
      network: "eip155:8453",
      amount: "5000",
      asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      payTo,
      maxTimeoutSeconds: 120,
      extra: { name: "USD Coin", version: "2" },
    },
  ],
};
app.use("*", cors({ origin: "*", exposeHeaders: ["PAYMENT-REQUIRED", "PAYMENT-RESPONSE"] }));
app.get("/openapi.json", (c) =>
  c.json({
    openapi: "3.0.3",
    info: { title: "Provider API", version: "1.0.0" },
    paths: {
      "/paid": {
        post: {
          "x-payment-info": offer.accepts[0],
          responses: {
            "200": { description: "Paid response" },
            "402": { description: "Payment required" },
          },
        },
      },
    },
  }),
);
app.post("/paid", async (c) => {
  const encoded = c.req.header("PAYMENT-SIGNATURE");
  if (!encoded) return c.json(offer, 402, { "PAYMENT-REQUIRED": btoa(JSON.stringify(offer)) });
  let payment;
  try {
    payment = JSON.parse(atob(encoded));
  } catch {
    return c.json({ error: "Invalid payment" }, 400);
  }
  const body = { x402Version: 2, paymentPayload: payment, paymentRequirements: offer.accepts[0] };
  const headers = { "content-type": "application/json" };
  const verify = await fetch(`${facilitator}/verify`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const verified = await verify.json();
  if (!verify.ok || !verified.isValid) return c.json({ error: "Payment verification failed" }, 402);
  const settle = await fetch(`${facilitator}/settle`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const settlement = await settle.json();
  if (!settle.ok || !settlement.success) return c.json({ error: "Payment settlement failed" }, 502);
  return c.json({ resource: offer.resource }, 200, {
    "PAYMENT-RESPONSE": btoa(JSON.stringify(settlement)),
  });
});
serve({ fetch: app.fetch, port: 4242 });
```

## Run it

Create a temporary project, install the two packages, save the TypeScript-compatible handler as `index.mjs`, and run it with Node. The command checks the POST route without opening a wallet or paying.

```bash
mkdir -p /tmp/vapi-call && cd /tmp/vapi-call
npm init -y && npm i hono @hono/node-server
node index.mjs
```

## Check it

Run `vapi check` against the running endpoint. It grades the 402 the way a buyer client reads it, without paying. The extension and discovery warnings are expected for this minimal example.

The client refuses private hosts by default. For a local server, set `allowPrivateNetwork` to `true` in the client config (`~/.vapi/config.json`, created by `vapi init`) before you run the check; remove it again when you are done.

```bash
vapi check http://localhost:4242/paid --method POST
```

```text
Check: POST http://localhost:4242/paid — HTTP 402
  pass  status      HTTP 402 Payment Required.
  pass  transport   The offer is in the PAYMENT-REQUIRED header and the body.
  pass  version     Declares x402 version 2.
  pass  fields      Every field x402 v2 requires is present and well-typed.
  pass  scheme      1 of 1 accepted option uses the exact scheme.
  pass  asset       Pays canonical USDC on eip155:8453.
  pass  pay_to      Every exact option names a well-formed payTo address.
  pass  timeout     maxTimeoutSeconds 120.
  warn  extensions  Advertises none of the known extensions. Adding Bazaar metadata makes the API discoverable in Coinbase's Bazaar and by Coinbase for Agents. [bazaar_metadata_missing]
  warn  discovery   No discovery document at http://localhost:4242/.well-known/x402: HTTP 404. [discovery_missing]
  pass  openapi     http://localhost:4242/openapi.json declares x-payment-info for POST /paid.
9 passed, 2 warnings, 0 failed.
```

## Publish

Open **Add API** at [api.vapinetwork.ai/call/my-apis/new](https://api.vapinetwork.ai/call/my-apis/new), or use the CLI commands below. The wizard has four stages:

1. Discover: submit your origin, endpoint, or OpenAPI URL, then check and select the payable operations.
2. Describe: review the endpoints and fill in the API name, description and category.
3. Payout: prove control of the payout wallet by signature. Every selected endpoint's live `payTo` must match that wallet.
4. Saved: press `Go live` so activation re-probes every endpoint and confirms direct payout.

```bash
vapi auth set-key
vapi publish https://your-api.example --mode origin --select paid --name "Provider API" --description "Paid API" --category data
vapi publish activate <slug>
```

## Get verified

Verification is a review tier for a live listing, and the listing stays live while review is pending. Request it from My APIs or run `vapi publish verify-request <slug>` after activation. Read [Get verified](/call/sell-on-call/get-verified/) for the review checks and request flow.

## Stay live

Self-listed and Partner APIs are rechecked every hour. Rechecks accept direct payouts or a stored legacy splitter; activation requires direct payout. Three consecutive failed checks add three strikes, suspend the listing, and remove it from discovery without changing its verification tier. Fix the endpoint, press `Go live` on My APIs, and read [Stay live](/call/sell-on-call/stay-live/) for the recovery flow.

If publishing shows “Verification pending. You can publish once your account is checked.”, wait for the account check.
When account-check enforcement applies, held or excluded accounts cannot activate or republish.

| Action or account          | Account-check gate |
| -------------------------- | ------------------ |
| Drafts and edits           | Remain allowed.    |
| Suspension                 | Remains allowed.   |
| Existing public listings   | Remain public.     |
| Unscored existing accounts | Can publish.       |

A probe rejection with diagnostics appends ‘Open "Why it failed" above for the fix.’ to the specific rejection message.
Without diagnostics, it shows “The endpoint could not be checked. Confirm the URL is public, reachable, and uses HTTPS.”
Open "Why it failed" for the specific reason and fix when available.

Account authentication can use email or Google. Payout-wallet signatures still prove the wallet that receives payments.
Sensitive writes on applicable own-wallet accounts can require wallet proof even after account sign-in.

Checked on 2026-11-17.
