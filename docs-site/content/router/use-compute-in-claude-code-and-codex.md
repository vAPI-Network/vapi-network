---
title: "Use your Compute in Claude Code and Codex"
description: "Configure AI clients with an owner Router key and understand Compute and hybrid funding."
order: 4
---

Create an owner Router key on [API keys](https://api.vapinetwork.ai/router/keys).
Choose Compute for your daily usage limit, Router balance for prepaid usage, or Compute, then Router balance for hybrid.
Copy the secret once and keep it private.

| Client setting                 | Value                                                                   |
| ------------------------------ | ----------------------------------------------------------------------- |
| OpenAI-compatible SDK base URL | https://router.vapinetwork.ai/v1                                        |
| Anthropic Messages base URL    | https://router.vapinetwork.ai                                           |
| Credential                     | Your owner Router key.                                                  |
| Model                          | An ID from the [Models page](https://api.vapinetwork.ai/router/models). |

Router accepts Anthropic Messages requests and routes them through chat completions.
Claude models use their configured prompt-cache prices; see [Models](/router/models/#prompt-cache-pricing).
Configure the client's endpoint and credential settings with the values above.

A manual owner hybrid key preserves the same secret while switching funding sources.
It uses Compute first, then Router balance when available.
Switching is asynchronous; requests can receive a 429 budget error until reassignment completes.
Repairs run every minute, and a replica that missed cache eviction can take another 60 seconds.
See [Access and keys](/router/access-and-keys/) for Paying now and reconciliation timing.

Single-source keys spend only their chosen source; direct clients switch those keys themselves.
Owner hybrid keys are separate from linked-agent credentials and launcher configuration.
See [Use Router from your agents](/router/use-router-from-your-agents/) for the linked-agent two-key model.

Checked on 2026-11-17.
