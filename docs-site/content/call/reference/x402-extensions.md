---
title: "x402 extensions"
description: "Call payments carry the vapi builder code; x402 discovery and payment-identifier extensions support discovery and safe retries."
order: 24
---

Use this page to see which x402 extensions Call sends with payments and which discovery metadata it reads. The live 402 response tells you which optional extensions an API advertises.

## Payment extensions

### `builder-code`

The console and the `vapi` client attach `builder-code` with the value `vapi` to every payment they make. Facilitators can use it for on-chain attribution.

The payment carries the builder code in `extensions`:

```json
{
  "extensions": {
    "builder-code": {
      "info": {
        "s": ["vapi"]
      }
    }
  }
}
```

When the API declares an application code, the client echoes it as `a`. The client does not send `w`.

### `payment-identifier`

When an API advertises `payment-identifier`, the client generates an identifier and sends it in the payment. The same identifier and request fingerprint can be used to recognize a safe retry. Reusing the identifier for a different request fingerprint is rejected by an API that enforces the extension.

The client adds the identifier to the advertised extension metadata and records it as `paymentId` in the local receipt:

```json
{
  "extensions": {
    "payment-identifier": {
      "info": {
        "required": true,
        "id": "pay_example"
      },
      "schema": {
        "type": "object",
        "required": ["id"]
      }
    }
  }
}
```

## Bazaar discovery metadata

Providers can advertise the `bazaar` extension in their 402 response. Call reads the Bazaar input metadata, including the request method when it is present. `vapi check` reports whether the extension is advertised. Missing Bazaar metadata produces the `bazaar_metadata_missing` warning and does not block a listing.

The Coinbase x402 Bazaar mirror provides the resource URL and accepts data such as the network and amount. vAPI also reads Bazaar input and catalog metadata such as service name, description, method, tags, icon URL, x402 version, last-updated time, and quality when those fields are present.

## What vAPI sends and honours

| Extension or metadata | What vAPI sends                                                                | What vAPI honours                                                                                            |
| --------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `builder-code`        | `info.s` includes `vapi` on every console and `vapi` client payment.           | A declared application code in `info.a` and the server's declared extension metadata.                        |
| `payment-identifier`  | Sends an `info.id` only when the API advertises the extension.                 | The same identifier can identify a retry with the same request fingerprint; receipts keep it as `paymentId`. |
| `bazaar`              | It is provider-declared discovery metadata, not a payment field added by Call. | Provider 402 metadata and Coinbase Bazaar resource, accepts, input, and catalog fields for discovery.        |

See [Networks and schemes](/call/reference/networks-and-schemes/) for how mirrored Bazaar offers are filtered for payment.

Checked on 2026-10-15.
