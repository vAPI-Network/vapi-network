---
title: "The Graph"
description: "Query 20 Subgraphs from The Graph through vAPI Call: $0.01 in USDC on Base per GraphQL query over x402, from the console, the vapi CLI and SDK, or an agent on…"
order: 8
---

The Graph indexes blockchain data into Subgraphs: open GraphQL APIs for protocols such as Uniswap, Aave and ENS. On Call, The Graph is a Verified Provider. You pay $0.01 in USDC on Base per query, straight to The Graph's gateway, with no API key and no account at The Graph.

| Fact              | Value                                                                                           |
| ----------------- | ----------------------------------------------------------------------------------------------- |
| Listing           | [api.vapinetwork.ai/call/the-graph](https://api.vapinetwork.ai/call/the-graph), ref `the-graph` |
| Group and tier    | Verified Provider, verified by vAPI                                                             |
| Price             | $0.01 per query, from the live offer                                                            |
| Asset and network | USDC on Base (`eip155:8453`)                                                                    |
| Protocol          | x402 v2, `exact` scheme                                                                         |
| Payee             | `0x79DC34E41B2b591078d3dE222C43EcaaBD52FcCB` (The Graph's gateway)                              |
| vAPI network fee  | None                                                                                            |

## How a query is paid

1. You send a GraphQL query to a Subgraph endpoint on The Graph's gateway, `gateway.thegraph.com`.
2. The gateway answers 402 with its offer: $0.01 in USDC on Base.
3. Your client or browser wallet checks the offer against your limits and signs the payment.
4. The gateway settles it, runs the query on The Graph Network, and returns the result.
5. The `vapi` client writes a receipt; the console shows the settlement reference.

## Endpoints

The listing has 20 endpoints, one per Subgraph. Ten cover Base.

| Endpoint                | Data                             |
| ----------------------- | -------------------------------- |
| `aerodrome_base`        | Aerodrome pools on Base          |
| `uniswap_v4_base`       | Uniswap v4 on Base               |
| `uniswap_v3_base`       | Uniswap v3 pools on Base         |
| `uniswap_v2_base`       | Uniswap v2 pairs on Base         |
| `aave_v3_base`          | Aave v3 on Base                  |
| `compound_v3_base`      | Compound v3 on Base              |
| `superfluid_base`       | Superfluid token streams on Base |
| `creatorbid_base`       | CreatorBid Agent Keys on Base    |
| `squadswap_base`        | SquadSwap pools on Base          |
| `thirdfy_base`          | Thirdfy pools on Base            |
| `uniswap_v3_arbitrum`   | Uniswap v3 on Arbitrum           |
| `uniswap_v3_optimism`   | Uniswap v3 on Optimism           |
| `query_subgraph`        | Uniswap v3 on Ethereum           |
| `aave_v3_ethereum`      | Aave v3 on Ethereum              |
| `compound_v3_ethereum`  | Compound v3 on Ethereum          |
| `curve_ethereum`        | Curve on Ethereum                |
| `balancer_v2_ethereum`  | Balancer v2 on Ethereum          |
| `sushiswap_v2_ethereum` | SushiSwap on Ethereum            |
| `lido_ethereum`         | Lido oracle reports on Ethereum  |
| `ens_ethereum`          | ENS names on Ethereum            |

Aerodrome cannot sort pools by a USD total; filter with `where`, for example `totalValueLockedUSD_gt`, as its example query does.

For `aerodrome_base`:

```graphql
{
  pools(first: 5, where: { totalValueLockedUSD_gt: "1000000" }) {
    id
    token0 {
      symbol
    }
    token1 {
      symbol
    }
    feeTier
    totalValueLockedUSD
    volumeUSD
    feesUSD
    txCount
  }
}
```

Every endpoint takes a `POST` with a JSON body: `query` (required) and `variables` (optional). Inspecting an endpoint is free and shows an example query for its schema:

```bash
vapi inspect the-graph --endpoint uniswap_v3_base
```

```text
Verification: verified
Fee: No network fee
Liveness: 100.0% up over 7 days (41 checks) · p50 498 ms · p95 524 ms
{
  "name": "uniswap_v3_base",
  "method": "POST",
  "url": "https://gateway.thegraph.com/api/x402/subgraphs/id/96eJ9Go8gFjySRGnndG7EYxThaiwVDV8BYPp1TMDcoYh",
  "price": "$0.01",
  "requestSchema": { "required": ["query"], "properties": { "query": { "type": "string", "example": "{ pools(first: 5, orderBy: totalValueLockedUSD, orderDirection: desc) { id token0 { symbol } token1 { symbol } feeTier totalValueLockedUSD volumeUSD txCount } }" }, "variables": { "type": "object" } } },
  "payment": { "scheme": "exact", "network": "eip155:8453", "payTo": "0x79DC34E41B2b591078d3dE222C43EcaaBD52FcCB" }
}
```

## Before you start

- For the console: a browser wallet with a little USDC on Base.
- For the CLI, SDK or MCP: Node.js 22 or later and the `vapi` wallet from the [Quickstart](/call/quickstart/), funded with a few dollars of USDC on Base. One query costs $0.01. You do not need ETH for gas.

## In the console

1. Open [api.vapinetwork.ai/call/the-graph](https://api.vapinetwork.ai/call/the-graph) and choose the Subgraph endpoint, for example `uniswap_v3_base`.
2. Put a query in the `query` field. The form starts with the endpoint's example; this one returns the five Uniswap v3 pools on Base with the most liquidity:

   ```graphql
   {
     pools(first: 5, orderBy: totalValueLockedUSD, orderDirection: desc) {
       id
       token0 {
         symbol
       }
       token1 {
         symbol
       }
       feeTier
       totalValueLockedUSD
     }
   }
   ```

3. Choose **Check live price**. The quote shows $0.01, Base, and the payee above.
4. Connect your wallet if you have not, choose **Pay 0.01 USDC and call**, and sign the authorization your wallet shows.
5. Choose **View result** to read the JSON response and its settlement reference.

## With the CLI

```bash
vapi pay the-graph \
  --endpoint uniswap_v3_base \
  --method POST \
  --content-type application/json \
  --body '{"query":"{ pools(first: 5, orderBy: totalValueLockedUSD, orderDirection: desc) { id token0 { symbol } token1 { symbol } feeTier totalValueLockedUSD } }"}' \
  --max 0.05
```

`--max` is the most you agree to pay for this call. The client refuses to sign if the live offer is higher. The result is JSON with `status`, `body` (the GraphQL response) and `payment`. Check what you paid with `vapi receipts`.

Pass GraphQL variables next to the query:

```bash
vapi pay the-graph \
  --endpoint ens_ethereum \
  --method POST \
  --content-type application/json \
  --body '{"query":"query($name: String!) { domains(where: { name: $name }) { name owner { id } createdAt } }","variables":{"name":"vitalik.eth"}}' \
  --max 0.05
```

### Any Subgraph by URL

The 20 endpoints are a curated set. The gateway serves other published Subgraphs through x402 by Subgraph ID. Pass the URL instead of the listing ref and pin the payee:

```bash
vapi pay https://gateway.thegraph.com/api/x402/subgraphs/id/<SUBGRAPH_ID> \
  --method POST \
  --content-type application/json \
  --body '{"query":"{ _meta { block { number } } }"}' \
  --expected-pay-to 0x79DC34E41B2b591078d3dE222C43EcaaBD52FcCB \
  --max 0.05
```

`--expected-pay-to` makes the client refuse any offer that pays a different address. Find Subgraph IDs in [The Graph Explorer](https://thegraph.com/explorer). Check an endpoint's offer for free before you pay:

```bash
vapi check https://gateway.thegraph.com/api/x402/subgraphs/id/<SUBGRAPH_ID> --method POST
```

```text
Check: POST https://gateway.thegraph.com/api/x402/subgraphs/id/… — HTTP 402
  pass  status      HTTP 402 Payment Required.
  pass  scheme      1 of 1 accepted option uses the exact scheme.
  pass  asset       Pays canonical USDC on eip155:8453.
  pass  pay_to      Every exact option names a well-formed payTo address.
7 passed, 4 warnings, 0 failed.
```

## With the SDK

```ts
import { createVapiClient } from "vapi-network";

const vapi = await createVapiClient({ account: "main" });

const result = await vapi.call.pay({
  id: "the-graph",
  endpoint: "uniswap_v3_base",
  method: "POST",
  contentType: "application/json",
  body: {
    query:
      "{ pools(first: 5, orderBy: totalValueLockedUSD, orderDirection: desc) { id totalValueLockedUSD } }",
  },
  maxPriceUsd: 0.05,
  expectedPayTo: "0x79DC34E41B2b591078d3dE222C43EcaaBD52FcCB",
});

console.log(result.body);
```

`endpoint` is required for this listing because it has several endpoints. The SDK applies the account's caps and writes the same receipts as the CLI.

## From an agent on MCP

Install the local MCP server once ([Quickstart, MCP tab](/call/quickstart/)):

```bash
vapi mcp install claude-desktop    # or: claude-code, cursor, codex
```

Then ask, for example:

> Use The Graph on vAPI to list the top five Uniswap v3 pools on Base by liquidity.

> Use The Graph on vAPI to list Aerodrome pools on Base with more than $1M of liquidity.

> Use The Graph on vAPI to compare USDC supply rates on Aave v3 and Compound v3 on Base.

> Use The Graph on vAPI to find who owns vitalik.eth.

The agent calls `call.search` to find the listing, `call.inspect` with the endpoint name to read the schema and example query, and `call.pay` with `maxPriceUsd` to run the query. The account's caps bound what it can spend.

## Price

$0.01 per query in the 2026-10-16 sample, with no vAPI fee. The gateway's live 402 offer is the price; your client compares it with `--max`, `maxPriceUsd` and your caps before signing.

## Limits and errors

| Problem                                                    | What to do                                                                                                                                                                    |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The client refuses to sign                                 | The live offer is above `--max` or `maxPriceUsd`, or above your account caps. Raise the limit, or check the offer with `vapi check`.                                          |
| The response has GraphQL `errors`                          | The query does not match the Subgraph schema. Run `vapi inspect the-graph --endpoint <name>` for an example query, or open the Subgraph in The Graph Explorer for its schema. |
| The response says `bad indexers` or `indexing_error`       | The Graph's indexers could not answer that query. The gateway can still charge the $0.01. Try a smaller query or another endpoint, and report the Subgraph to vAPI.           |
| `ambiguous_default` or "has 20 distinct payable endpoints" | Name an endpoint with `--endpoint` in the CLI or `endpoint` in the SDK.                                                                                                       |
| `settlement_unknown` after a long wait                     | The provider did not answer within the timeout. Run `vapi pay --resume <receipt-id>` to see whether it settled, then retry with `--timeout 180` if the Subgraph is slow.      |
| A response is lost after you paid                          | Run `vapi pay --resume <receipt-id>`. It reads the chain and tells you whether the payment settled.                                                                           |
| Not enough USDC                                            | Run `vapi balance`, then `vapi fund`.                                                                                                                                         |

## Learn more

- [The Graph documentation](https://thegraph.com/docs/)
- [The Graph Explorer](https://thegraph.com/explorer)
- [Pay with the CLI, MCP and SDK](/call/use-call/pay-with-vapi/)
- [Receipts and retries](/call/use-call/receipts-and-retries/)

Checked on 2026-10-30.
