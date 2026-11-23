---
title: "Publish from the CLI"
description: "Publish, activate, verify-request and claim vAPI Call listings from the vapi CLI, for one API or a batch, with the payout wallet signing locally."
order: 14
---

This page is for providers who want to publish and manage Call listings from the `vapi` CLI instead of the console wizard at `/call/my-apis/new`. vAPI Call takes no fee. Providers are paid directly, without a splitter deployment.

For machine-managed publishing, see the [HTTP write API](/reference/http-api/listings-write-api/). For an API that vAPI already indexed, see [claim and edit](/reference/http-api/claim-and-edit/).

## Authenticate

Link an account with publishing rights to publish and claim without a registry API key. The login flag below requests the `call.publish` right.

```bash
vapi login --publish
```

Set the registry API key from a terminal. The CLI reads it from a prompt, never from an argument, and stores it in the OS secret store. `VAPI_API_KEY` is the CI route.

```bash
vapi auth set-key
```

The key is also used by claiming. Check or remove the stored key with these commands:

```bash
vapi auth status
vapi auth clear
```

## Publish one API

`vapi publish` accepts an origin, one endpoint, or an OpenAPI document. The CLI probes the URL, prints each probe step, and lets you choose the endpoints to list. A refusal exits before signing anything.

```bash
vapi publish https://weather.example
```

Use `--mode` when you want to identify the URL explicitly. Provide the listing name, description, and category for non-interactive use.

```bash
vapi publish https://weather.example/openapi.json --mode openapi --name Weather --description "Weather data" --category data --yes
```

The available publish options are:

| Option                                           | What it does                                                                     |
| ------------------------------------------------ | -------------------------------------------------------------------------------- |
| `--method`                                       | Sets the method for an endpoint probe.                                           |
| `--mode <origin\|endpoint\|openapi>`             | Identifies the URL as an origin, endpoint, or OpenAPI document.                  |
| `--name <text>`                                  | Sets the listing name.                                                           |
| `--description <text>`                           | Sets the listing description.                                                    |
| `--category <ai\|data\|crypto\|compute\|search>` | Sets the listing category.                                                       |
| `--select <names>`                               | Selects endpoint names to list.                                                  |
| `--account <name>`                               | Selects the payout wallet that signs.                                            |
| `--yes`                                          | Takes all discovered endpoints without interactive selection.                    |
| `--resume`                                       | Skips endpoints your authenticated account already lists and publishes the rest. |

The payout wallet signs one message that confirms it receives Call payouts. No payment is made by that signature. A listing can contain at most 20 endpoints.

## Publish a batch

When a source contains more than 20 endpoints, the CLI creates several listings with up to 20 endpoints each. The listings use names such as `Weather (1/4)` and keep probe order.

Select endpoints by name in a script:

```bash
vapi publish https://weather.example --select forecast,alerts --name Weather --description "Weather data" --category data --account provider
```

Use `--yes` to take all discovered endpoints in a terminal-free run:

```bash
vapi publish https://weather.example --yes --name Weather --description "Weather data" --category data --account provider
```

Each endpoint receives a result. A batch refused on its own merits does not stop the next batch. A rejected key, rate limit, or outage stops the run.

If a run stops, repeat it with `--resume`. The CLI checks your authenticated account's listings, skips those endpoints, and lists the rest.

```bash
vapi publish https://weather.example --resume --name Weather --description "Weather data" --category data --account provider
```

## Activate a listing

Set every selected endpoint's live x402 `payTo` to the payout wallet that signed the proof, then activate the listing with its slug.

```bash
vapi publish activate weather-call
```

Activation takes the listing live after every endpoint passes a fresh probe and every quote pays the proven payout wallet directly.

## Request review

Verification is separate from listing. Ask vAPI to review a live listing with its slug.

```bash
vapi publish verify-request weather-call
```

## List your listings

Show every listing owned by your authenticated account.

```bash
vapi publish list
```

## Claim a listing vAPI indexed

vAPI can index an API from a public x402 catalog before you publish it. If the listing pays the wallet you control, claim it from the CLI.

```bash
vapi claim https://weather.example --account provider
```

The claim is signed by the selected payee wallet. The registry matches that signer against the listings' `payTo`. A wallet that is not the payee, an origin with nothing to claim, and an already-owned listing each fail separately.

After claiming, use `vapi publish list` to see the listings owned by your authenticated account. Use `vapi publish verify-request <slug>` to ask for review.

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

## Next

- [Check an x402 API](/call/sell-on-call/check-an-x402-api/)
- [List your API](/call/sell-on-call/list-your-api/)
- [Listings write API](/reference/http-api/listings-write-api/)

Checked on 2026-11-17.
