---
title: "Dot"
description: "Get a private AI chat completion from Dot through vAPI Call: an OpenAI-style request, priced per request from its length, paid in USDC on Base over x402 from…"
order: 11
---

Dot is a private AI chat service: it answers a chat completion and, by its own account, does not store the prompt. On Call, Dot is a Verified Provider with one endpoint that takes an OpenAI-style request. You pay per completion in USDC on Base, straight to Dot, with no account and no API key at Dot.

| Fact              | Value                                                                                            |
| ----------------- | ------------------------------------------------------------------------------------------------ |
| Listing           | [api.vapinetwork.ai/call/dot](https://api.vapinetwork.ai/call/dot), ref `dot`                    |
| Group and tier    | Verified Provider, verified by vAPI                                                              |
| Price             | Set per request by Dot's live offer; $0.006452 for a short prompt with the default output budget |
| Asset and network | USDC on Base (`eip155:8453`)                                                                     |
| Protocol          | x402 v2, `exact` scheme                                                                          |
| Payee             | `0x3551a237e71F48Bba1B0ab7E43c1d4118E2dE26f` (Dot)                                               |
| vAPI network fee  | None                                                                                             |

## How a completion is paid

1. You send the chat request to Dot, `api.usedot.xyz/x402/chat/completions`.
2. Dot answers 402 with an offer priced for that request: its prompt length and its output budget.
3. Your client or browser wallet checks the offer against your limits and signs the payment.
4. Dot settles the payment, runs the completion, and returns it.
5. The `vapi` client writes a receipt; the console shows the settlement reference.

## Endpoint

| Endpoint          | Method | Body                                                                          |
| ----------------- | ------ | ----------------------------------------------------------------------------- |
| `chat_completion` | `POST` | `{ "model": "dot-auto", "messages": [{ "role": "user", "content": "..." }] }` |

`model: "dot-auto"` lets Dot choose the model; in the 2026-10-20 sample it chose `dot-kimi-k2-6`. `messages` follows the OpenAI chat format. `max_tokens` caps the answer and lowers the price. The response is an OpenAI-style `chat.completion` with `choices`, `usage`, and a `dot_parameters` object describing Dot's routing. Inspecting the listing is free:

```bash
vapi inspect dot
```

```text
Verification: verified
Fee: No network fee
Liveness: 98.8% up over 7 days (166 checks) · p50 144 ms · p95 225 ms
Conformance: x402 v2, conformant, offer in the PAYMENT-REQUIRED header only · issues: offer_header_only
{
  "name": "chat_completion",
  "method": "POST",
  "url": "https://api.usedot.xyz/x402/chat/completions",
  "price": "$0.006452",
  "description": "Direct x402 private chat completion. Body: { \"model\": \"dot-auto\", \"messages\": [{ \"role\": \"user\", \"content\": \"...\" }] }.",
  "group": "partner",
  "payment": {
    "scheme": "exact",
    "network": "eip155:8453",
    "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    "payTo": "0x3551a237e71F48Bba1B0ab7E43c1d4118E2dE26f",
    "checkedAt": "2026-10-20T14:11:00.198Z"
  }
}
```

## Before you start

- For the console: a browser wallet with a little USDC on Base.
- For the CLI, SDK or MCP: Node.js 22 or later and the `vapi` wallet from the [Quickstart](/call/quickstart/), funded with a few dollars of USDC on Base. One short completion costs under $0.01. You do not need ETH for gas.

## In the console

1. Open [api.vapinetwork.ai/call/dot](https://api.vapinetwork.ai/call/dot). The listing has one endpoint, `chat_completion`.
2. Under **Request input**, choose **JSON** and enter the body:

   ```json
   {
     "model": "dot-auto",
     "messages": [{ "role": "user", "content": "In one sentence, what is x402?" }],
     "max_tokens": 256
   }
   ```

3. Choose **Check live price**. The quote shows Dot's price for this body, Base, and the payee above.
4. Connect your wallet if you have not, choose **Pay … USDC and call** with the quoted amount, and sign the authorization your wallet shows.
5. Choose **View result** to read the completion and its settlement reference.

## With the CLI

```bash
vapi pay dot \
  --method POST \
  --content-type application/json \
  --body '{"model":"dot-auto","messages":[{"role":"user","content":"In one sentence, what is x402?"}],"max_tokens":256}' \
  --max 0.02
```

`--max` is the most you agree to pay for this call. The client refuses to sign if the live offer is higher. The result is JSON with `status`, `body` (the completion) and `payment`. From the run above, shortened:

```json
{
  "status": 200,
  "body": {
    "object": "chat.completion",
    "model": "dot-kimi-k2-6",
    "choices": [
      {
        "index": 0,
        "finish_reason": "stop",
        "message": {
          "role": "assistant",
          "content": " x402 is an open protocol that enables internet-native payments by using the HTTP 402 status code to let software (including AI agents) pay for online resources instantly with stablecoins, without requiring accounts, credit cards, or human intervention [1][3][5]."
        }
      }
    ],
    "usage": { "prompt_tokens": 2118, "completion_tokens": 54, "total_tokens": 2172 }
  },
  "payment": {
    "network": "eip155:8453",
    "amountUsd": "0.003231",
    "payTo": "0x3551a237e71F48Bba1B0ab7E43c1d4118E2dE26f",
    "settlement": {
      "success": true,
      "explorerUrl": "https://basescan.org/tx/0x8b3c3726eba720ab13af9b746ea66efb5def9e15537500280978f2a5449651b0"
    }
  }
}
```

`prompt_tokens` counts Dot's own system prompt as well as yours. Check what you paid with `vapi receipts`.

## With the SDK

```ts
import { createVapiClient } from "vapi-network";

const vapi = await createVapiClient({ account: "main" });

const result = await vapi.call.pay({
  id: "dot",
  method: "POST",
  contentType: "application/json",
  body: {
    model: "dot-auto",
    messages: [{ role: "user", content: "In one sentence, what is x402?" }],
    max_tokens: 256,
  },
  maxPriceUsd: 0.02,
  expectedPayTo: "0x3551a237e71F48Bba1B0ab7E43c1d4118E2dE26f",
});

console.log(result.body.choices[0].message.content);
```

The listing has one endpoint, so `endpoint` is optional. `expectedPayTo` makes the client refuse an offer that pays any other address. The SDK applies the account's caps and writes the same receipts as the CLI.

## From an agent on MCP

Install the local MCP server once ([Quickstart, MCP tab](/call/quickstart/)):

```bash
vapi mcp install claude-desktop    # or: claude-code, cursor, codex
```

Then ask, for example:

> Use Dot on vAPI to summarise this paragraph privately, in at most 100 words.

> Use Dot on vAPI to draft a reply to this email, and keep the answer under 200 tokens.

> Use Dot on vAPI to explain x402 in one sentence.

The agent calls `call.search` to find the listing, `call.inspect` to read the endpoint, and `call.pay` with `maxPriceUsd` to run the completion. The account's caps bound what it can spend.

## Price

Dot prices each request from its live offer. The offer grows with the prompt and with the output budget: without `max_tokens`, Dot quotes for 2,048 output tokens. In the 2026-10-20 sample, a one-word prompt was quoted at $0.006452 with the default budget and $0.003227 with `max_tokens: 256`; a prompt of about 2,000 words was quoted at $0.008139. The listing shows the price for a short probe request. There is no vAPI fee.

Your client compares the live offer with `--max`, `maxPriceUsd` and your caps before signing. Set `--max` with headroom over the listing price, for example $0.02, so a longer prompt is not refused.

## Limits and errors

| Problem                                | What to do                                                                                                                                                                                                           |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The client refuses to sign             | Dot's offer for this request is above `--max` or `maxPriceUsd`, or above your account caps. Set `max_tokens`, shorten the prompt, or raise the limit.                                                                |
| `settlement_unknown` after a long wait | Dot did not answer within the timeout. Run `vapi pay --resume <receipt-id>` to see whether it settled. Retry with `--timeout 180` only after an expired, unused authorization confirms that another payment is safe. |
| A response is lost after you paid      | Run `vapi pay --resume <receipt-id>`. It reads the chain and tells you whether the payment settled.                                                                                                                  |
| Not enough USDC                        | Run `vapi balance`, then `vapi fund`.                                                                                                                                                                                |

## Learn more

- [Dot](https://usedot.xyz)
- [Pay with the CLI, MCP and SDK](/call/use-call/pay-with-vapi/)
- [Receipts and retries](/call/use-call/receipts-and-retries/)

Checked on 2026-10-30.
