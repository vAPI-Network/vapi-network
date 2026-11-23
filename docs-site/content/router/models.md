---
title: "Models"
description: "Choose Venice and 0G models by kind, capability, price, and privacy label."
order: 8
---

Venice and 0G are Router's production upstreams: 223 configured models on 2026-10-30, 167 from Venice (text, image, embedding, speech, transcription) and 56 from 0G (53 text and 3 embedding, from Qwen, Z.ai, Moonshot AI, MiniMax, Xiaomi, Baidu, Tencent and 0G). Open the console [Models page](https://api.vapinetwork.ai/router/models) to filter by kind, capability, privacy, and upstream, and to inspect prices.

## Model kinds

| Kind                       | Endpoint                        | Metering unit                                    | Example model id                 |
| -------------------------- | ------------------------------- | ------------------------------------------------ | -------------------------------- |
| Text                       | `POST /v1/chat/completions`     | Input, output, cache-read and cache-write tokens | `venice/deepseek-v4-flash`       |
| Text (Messages-compatible) | `POST /v1/messages`             | Input, output, cache-read and cache-write tokens | `venice/claude-sonnet-4-5`       |
| Text (0G)                  | `POST /v1/chat/completions`     | Input and output tokens                          | `0g/qwen3.7-flash`               |
| Embedding                  | `POST /v1/embeddings`           | Tokens                                           | `venice/text-embedding-bge-m3`   |
| Speech                     | `POST /v1/audio/speech`         | Characters                                       | `venice/tts-kokoro`              |
| Transcription              | `POST /v1/audio/transcriptions` | Audio seconds                                    | `venice/openai/whisper-large-v3` |
| Image                      | `POST /v1/images/generations`   | Images                                           | `venice/venice-sd35`             |

The console displays token prices per million tokens, speech prices per million characters, and transcription prices per minute. The catalog can change; list models before choosing an id.

Video, music, inpainting, and upscaling are not hosted through Router.

## Catalog policy

The catalog is generated from supported Venice and 0G model types and can change when regenerated. Offline rows and rows missing the prices needed for their billing unit are excluded.

| Held-back entries                                                                                    | Reason                                                                                    |
| ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Ids beginning with `e2ee-`                                                                           | Client-side encryption variants cannot be used through the OpenAI-compatible SDK surface. |
| Ids matching `heretic`, `uncensored`, `lustify`, or `abliterat`, and rows with an `uncensored` trait | Product policy.                                                                           |
| Ids containing `gpt-image`                                                                           | LiteLLM's token-based image calculator ignores the flat per-image price.                  |
| Ids containing `bg-remover`                                                                          | Image-to-image tools do not use the image-generation endpoint.                            |

## Privacy labels

Each model row carries a `private` or `anonymized` privacy label. Check the row you intend to call rather than assuming one policy for every model from either upstream.

For anonymized Venice rows:

Venice strips user-identifying metadata; the upstream provider's own retention and training policy applies.

0G TeeML rows run inference inside a TEE and carry `private`. TeeTLS rows attest the route and carry `anonymized`; the upstream sees the prompt and its retention and training policy applies.

Router has no shared response cache.

## Prompt-cache pricing

The Anthropic Messages-compatible endpoint at `POST /v1/messages` supports clients such as Claude Code. Venice text models meter prompt-cache reads and writes at their configured cache prices on both endpoints; 0G rows carry no cache prices. These are separate from a shared response cache, which Router does not run.

For `venice/claude-sonnet-4-5`, the configured USD prices per million tokens are:

| Token class              | USD per million tokens |
| ------------------------ | ---------------------: |
| Input                    |                  $3.00 |
| Output                   |                 $15.00 |
| Cache read               |                  $0.30 |
| Cache creation           |                  $3.75 |
| Cache write (1-hour TTL) |                  $3.75 |

Prices differ by model. A budget-exhausted Messages request returns `429 budget_exceeded`.

## List models

The OpenAI-compatible listing uses a Router bearer key:

```bash
curl https://router.vapinetwork.ai/v1/models \
  -H "Authorization: Bearer $VAPI_ROUTER_KEY"
```

The console catalog is also available without authentication at:

```http
GET https://api.vapinetwork.ai/api/router/models
```

See [Call your first model](/router/api-quickstart/) to create a key and send a request.
