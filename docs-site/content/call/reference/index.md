---
title: "Reference"
description: "Where the Call reference lives: networks and schemes, groups and fees, x402 extensions here; the CLI, SDK, HTTP API and MCP references in the Reference and…"
order: 21
---

The pages in this section describe the facts behind Call that do not change per listing. The tool references live in their own tabs so the CLI, SDK and HTTP API can be documented once for every product.

## In this section

| Page                                                          | What it answers                                                                                                  |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| [Networks and schemes](/call/reference/networks-and-schemes/) | Which networks and x402 schemes Call can pay, and what it shows but cannot pay                                   |
| [Groups and fees](/call/reference/groups-and-fees/)           | Why a listing sits in a group, which payout path applies, and how direct payouts and legacy fee disclosures work |
| [x402 extensions](/call/reference/x402-extensions/)           | The `builder-code`, `payment-identifier` and `bazaar` extensions Call sends and reads                            |

## Tool references

| Reference          | Where                                                                                                                                                                                                                                                          | Covers                                                                                      |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| CLI                | [CLI reference](/reference/cli/cli-reference/)                                                                                                                                                                                                                 | Every `vapi` command, option, environment variable and exit code                            |
| SDK                | [SDK](/reference/sdk/sdk/)                                                                                                                                                                                                                                     | `createVapiClient`, `call.search`, `call.inspect`, `call.pay`, and the lower-level packages |
| HTTP API           | [Discovery and services](/reference/http-api/discovery-and-services/), [Listing detail](/reference/http-api/listing-detail/), [Stats and activity](/reference/http-api/stats-and-activity/), [Feed and API catalog](/reference/http-api/feed-and-api-catalog/) | Reading the directory without the console                                                   |
| Provider write API | [Listings write API](/reference/http-api/listings-write-api/), [Claim and edit](/reference/http-api/claim-and-edit/)                                                                                                                                           | Publishing, activating and claiming listings by machine                                     |
| Local MCP          | [MCP server for Claude, Cursor and Codex](/agents/in-your-ai-app/use-vapi-in-claude-cursor-and-codex/)                                                                                                                                                         | Every tool of `vapi mcp`, account pinning, what the server cannot do                        |
| Hosted MCP         | [Remote MCP server](/agents/in-your-ai-app/hosted-mcp/)                                                                                                                                                                                                        | `call.search` and `call.inspect` over Streamable HTTP, no payments                          |
| x402               | [x402 payments and facilitator flow](/reference/x402/x402/), [x402 contracts](/reference/x402/contracts/)                                                                                                                                                      | The protocol under every Call payment and the Base contracts                                |

The provider's live 402 offer is the source of truth for the amount, network, asset and payee of any call. Nothing on these pages overrides it.

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

Checked on 2026-11-17.
