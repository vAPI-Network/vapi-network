---
title: "Check an x402 API"
description: "The vapi check command grades an x402 offer, discovery document, and matching OpenAPI operation without making a payment."
order: 13
---

This page is for providers who want to grade an x402 response before they publish an API.

`vapi check <url>` checks the offer, discovery document, and matching OpenAPI operation without paying. New to Call? Start with the [Quickstart](/call/quickstart/).

## Run a check

```bash
vapi check https://weather.example/forecast
vapi check https://weather.example/alerts --method POST --json
```

The command sends the selected HTTP method, which defaults to `GET`. Supported methods are `GET`, `HEAD`, `POST`, `PUT`, `PATCH`, and `DELETE`. It asks the URL for its offer without opening a wallet, signing, paying, or calling the registry.

The 11 rules are:

| Rule         | What it checks                                                                                                                                   |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `status`     | The endpoint answers HTTP 402.                                                                                                                   |
| `transport`  | The offer is readable from a base64 `PAYMENT-REQUIRED` header, a JSON body, both, or an MPP `WWW-Authenticate: Payment` challenge.               |
| `version`    | The offer declares x402 version 2. Version 1 is a warning.                                                                                       |
| `fields`     | Every field required by the declared x402 version is present and well-typed.                                                                     |
| `scheme`     | At least one accepted option uses `exact`.                                                                                                       |
| `asset`      | An exact option pays canonical USDC with the correct EIP-712 domain on Base, Arc mainnet, or Arc testnet, or the canonical USDC asset on Solana. |
| `pay_to`     | Every exact option names a valid, non-zero address for its network.                                                                              |
| `timeout`    | `maxTimeoutSeconds` is a positive whole number. Values below 10 seconds or above 3,600 seconds warn.                                             |
| `extensions` | The offer's known extensions are reported. Missing Bazaar metadata warns.                                                                        |
| `discovery`  | `/.well-known/x402` serves a JSON document. Missing or malformed discovery warns.                                                                |
| `openapi`    | A discovered OpenAPI document describes the checked operation and includes `x-payment-info`.                                                     |

For OpenAPI, the check looks beside the requested path and then in each ancestor directory, ending at the origin's `/openapi.json`. If it finds no operation, it reads same-origin `service-desc` links from `/.well-known/api-catalog`, in order, up to 10 links.

## Issue codes

The report includes stable snake_case issue codes. A rule can have no issue, one issue, or several issues. The `extensions` warning `bazaar_metadata_missing` is local to `vapi check`; it does not appear in the registry-shaped `conformance.issues` object.

### Request and offer

| Code                     | Severity | Meaning                                                                                |
| ------------------------ | -------- | -------------------------------------------------------------------------------------- |
| `not_402`                | fail     | The checked URL did not answer HTTP 402.                                               |
| `offer_missing`          | fail     | The 402 has no readable offer in the header or JSON body.                              |
| `v2_header_malformed`    | fail     | The `PAYMENT-REQUIRED` header is not base64 JSON.                                      |
| `offer_version_mismatch` | warn     | The header and body declare different x402 versions.                                   |
| `offer_header_only`      | warn     | The offer is only in the header. x402 v1 clients and some indexers read the JSON body. |
| `v2_header_missing`      | warn     | The body declares x402 v2 but the 402 has no `PAYMENT-REQUIRED` header.                |
| `v1_legacy`              | warn     | The offer declares x402 version 1, which v2-only clients cannot pay.                   |
| `version_missing`        | fail     | The offer does not declare `x402Version`.                                              |
| `version_unsupported`    | fail     | The offer declares a value other than x402 version 1 or 2.                             |
| `scheme_unsupported`     | fail     | No accepted option uses the `exact` scheme.                                            |

### Required fields

All missing and invalid field codes are failures. The `v1` and `v2` prefixes identify the declared x402 version.

| Code                                                               | Meaning                                                                  |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| `v1_missing_accepts`, `v2_missing_accepts`                         | The offer has no non-empty `accepts` array.                              |
| `v1_invalid_accepts`, `v2_invalid_accepts`                         | An item in `accepts` is not an object.                                   |
| `v1_missing_scheme`, `v2_missing_scheme`                           | An accepted option has no `scheme`.                                      |
| `v1_invalid_scheme`, `v2_invalid_scheme`                           | An accepted option's `scheme` is not a non-empty string.                 |
| `v1_missing_network`, `v2_missing_network`                         | An accepted option has no `network`.                                     |
| `v1_invalid_network`, `v2_invalid_network`                         | An accepted option's `network` is not a non-empty string.                |
| `v1_missing_max_amount_required`                                   | A v1 option has no `maxAmountRequired`.                                  |
| `v1_invalid_max_amount_required`                                   | A v1 `maxAmountRequired` is not a valid amount.                          |
| `v1_missing_resource`                                              | A v1 option has no `resource`.                                           |
| `v1_invalid_resource`                                              | A v1 `resource` is not a non-empty string.                               |
| `v1_missing_description`                                           | A v1 option has no `description`.                                        |
| `v1_invalid_description`                                           | A v1 `description` is not text.                                          |
| `v1_missing_mime_type`                                             | A v1 option has no `mimeType`.                                           |
| `v1_invalid_mime_type`                                             | A v1 `mimeType` is not text.                                             |
| `v1_missing_pay_to`, `v2_missing_pay_to`                           | An accepted option has no `payTo`.                                       |
| `v1_invalid_pay_to`, `v2_invalid_pay_to`                           | An accepted option's `payTo` is not a non-empty string.                  |
| `v1_missing_max_timeout_seconds`, `v2_missing_max_timeout_seconds` | An accepted option has no `maxTimeoutSeconds`.                           |
| `v1_invalid_max_timeout_seconds`, `v2_invalid_max_timeout_seconds` | An accepted option's `maxTimeoutSeconds` is not a positive whole number. |
| `v1_missing_asset`, `v2_missing_asset`                             | An accepted option has no `asset`.                                       |
| `v1_invalid_asset`, `v2_invalid_asset`                             | An accepted option's `asset` is not a non-empty string.                  |
| `v2_missing_resource`                                              | A v2 offer has no `resource`.                                            |
| `v2_invalid_resource`                                              | A v2 `resource` is not an object with a non-empty `url`.                 |
| `v2_missing_amount`                                                | A v2 option has no `amount`.                                             |
| `v2_invalid_amount`                                                | A v2 `amount` is not a valid amount.                                     |

### Asset, address, and timeout

| Code                   | Severity | Meaning                                                                             |
| ---------------------- | -------- | ----------------------------------------------------------------------------------- |
| `asset_not_usdc`       | fail     | The exact option does not pay canonical USDC for its network.                       |
| `network_unknown`      | fail     | The exact option names a network vAPI does not know.                                |
| `usdc_domain_mismatch` | fail     | The option's EIP-712 USDC domain does not match the canonical domain.               |
| `pay_to_invalid`       | fail     | An exact option has a missing, malformed, zero, or wrong-network recipient address. |
| `max_timeout_invalid`  | fail     | An exact option's timeout is not a positive whole number.                           |
| `max_timeout_short`    | warn     | The shortest timeout is below 10 seconds.                                           |
| `max_timeout_long`     | warn     | The longest timeout is above 3,600 seconds.                                         |

### Discovery and OpenAPI

| Code                           | Severity | Meaning                                                                                              |
| ------------------------------ | -------- | ---------------------------------------------------------------------------------------------------- |
| `bazaar_metadata_missing`      | warn     | The offer advertises no Bazaar extension.                                                            |
| `discovery_missing`            | warn     | `/.well-known/x402` did not serve a discovery document.                                              |
| `discovery_malformed`          | warn     | The discovery response is not a JSON object.                                                         |
| `openapi_missing`              | warn     | No OpenAPI document with `paths` was found in the path, its ancestors, or same-origin catalog links. |
| `openapi_operation_missing`    | warn     | An OpenAPI document was found, but it does not describe the checked method and path.                 |
| `openapi_payment_info_missing` | warn     | The matching OpenAPI operation has no `x-payment-info`.                                              |

## Exit codes and JSON

The command returns `0` when no rule fails, including when warnings exist. It returns `1` when any rule fails and `2` for invalid usage. `--json` writes the complete report as one JSON value, including `url`, `method`, `status`, `conformance`, the advertised known `extensions`, every rule and issue, and the `summary` counts.

The report's `transport` field is `x402` or `mpp`. For an MPP response, the `transport` rule carries the `mpp` tag and x402-only rules are skipped. The `extensions` list reports `bazaar`, `builder-code`, `payment-identifier`, `sign-in-with-x`, `offer-and-receipt`, and `auth-hints` when advertised.

## GitHub action

The repository publishes an Action named `x402 conformance check`. It runs the published CLI with `vapi check --json`. It does not open a wallet, make a payment, or call the registry.

Use the Action exactly as shown in the repository README:

```yaml
- uses: vAPI-Network/vapi-network@main
  with:
    url: https://weather.example/forecast
    fail-on: warn # or fail, the default
```

### Inputs

| Name      | Required | Default | Description                                                                 |
| --------- | -------- | ------- | --------------------------------------------------------------------------- |
| `url`     | `true`   | none    | The HTTP(S) URL of the paid endpoint to check.                              |
| `fail-on` | `false`  | `fail`  | `fail` fails the step when a rule fails. `warn` also fails it on a warning. |

### Outputs

| Name     | Description                          |
| -------- | ------------------------------------ |
| `report` | The full `vapi check --json` report. |

Complete workflow example:

```yaml
name: Check x402 API

on:
  push:
    branches: [main]

jobs:
  x402:
    runs-on: ubuntu-latest
    steps:
      - name: Check paid endpoint
        id: check
        uses: vAPI-Network/vapi-network@main
        with:
          url: https://weather.example/forecast
          fail-on: fail
```

The Action prints every rule, adds annotations for failures and warnings, exposes the JSON report as `report`, and fails the step according to `fail-on`.

## Next

- [Publishing from the CLI](/call/sell-on-call/publishing-from-the-cli/)
- [List your API](/call/sell-on-call/list-your-api/)
- [x402 on vAPI](/reference/x402/x402/)

Checked on 2026-10-15.
