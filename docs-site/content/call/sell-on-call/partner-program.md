---
title: "Partner program"
description: "Partner listings require operator approval; direct-payout Partners use their own x402 payout address without a network fee."
order: 20
---

A Partner listing is an operator-approved listing for an x402 endpoint. Use this path when you want Call to list your origin directly and show Partner provenance.

## What Partner status means

Partner status is an operator action, not an automatic result of publishing. A Partner listing uses its concrete origin x402 endpoint directly. Partners are paid at their own `payTo`, with no network fee. Legacy splitter listings retain their disclosed fee until migrated. Partner status does not require an owner wallet signature.

## Onboarding ladder

Start at the highest rung you can reach:

1. **Native x402:** You already serve x402 at your origin. vAPI probes and lists the endpoint, then stays outside the request path.
2. **Adapter:** You deploy an open-source x402 adapter in front of your existing API. Your upstream key, payout address, and origin remain yours. vAPI stays out of the request and money paths.
3. **Hosted shim:** For selected partners, vAPI operates the x402 adapter on a vAPI origin.

Selected partners, including [o1 Launchpad](/call/providers/o1/), use a vAPI-hosted shim; its x402 challenge pays the partner's own wallet, and vAPI never receives the payment. This is separate from permissionless publishing.

The publish flow does not create a vAPI proxy or an operator-funded upstream call. If your endpoint does not return a supported 402 challenge, the flow provides Node and Python integration guidance and a retest path.

Partner status is handled by a vAPI operator. Publishing an API creates an Added API, not a Partner listing. Partners appear in the directory as **Verified Providers**; see [The Graph](/call/providers/the-graph/) for what a partner page looks like.

Checked on 2026-10-30.
