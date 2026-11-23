---
title: "Feed and API catalog"
description: "Call exposes an Atom feed for new verified listings and an RFC 9727 API catalog for machine-readable discovery."
order: 10
---

The feed and API catalog make Call discoverable by tools that already understand Atom or RFC 9727. Use the feed for new verified listings and the catalog for machine-readable links to vAPI services.

## Atom feed

### GET /call/feed.xml

Read the 50 newest verified self-listed, partner, and claimed listings, ordered by `listedAt`.

**Auth:** none.

| Query parameter | Description                                       |
| --------------- | ------------------------------------------------- |
| None            | This endpoint has no documented query parameters. |

```bash
curl -H 'Accept: application/atom+xml' 'https://api.vapinetwork.ai/call/feed.xml'
```

The response is an Atom 1.0 document with content type `application/atom+xml`. Each entry links to `/call/:serviceId`. The feed is cached for five minutes.

This captured response is shortened to two entries.

```xml
<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <id>https://api.vapinetwork.ai/call/feed.xml</id>
  <title>New APIs on vAPI Call</title>
  <subtitle>Verified x402 APIs newly listed on vAPI Call.</subtitle>
  <link rel="self" type="application/atom+xml" href="https://api.vapinetwork.ai/call/feed.xml"/>
  <link rel="alternate" type="text/html" href="https://api.vapinetwork.ai/call"/>
  <updated>2026-10-13T16:58:06.296Z</updated>
  <author><name>vAPI Call</name></author>
  <entry>
    <id>https://api.vapinetwork.ai/call/exa</id>
    <title>Exa</title>
    <link rel="alternate" type="text/html" href="https://api.vapinetwork.ai/call/exa"/>
    <published>2026-10-13T16:58:06.296Z</published>
    <updated>2026-10-13T16:58:06.296Z</updated>
    <summary>Return relevant web search results. Each request costs $0.007 in USDC on Base over x402.</summary>
  </entry>
  <entry>
    <id>https://api.vapinetwork.ai/call/the-graph</id>
    <title>The Graph</title>
    <link rel="alternate" type="text/html" href="https://api.vapinetwork.ai/call/the-graph"/>
    <published>2026-10-13T16:57:32.473Z</published>
    <updated>2026-10-13T16:57:32.473Z</updated>
    <summary>Query onchain data from 20 Subgraphs: Uniswap, Aave, Aerodrome, ENS, Curve, Lido and more. Each request costs $0.01 in USDC on Base over x402.</summary>
  </entry>
</feed>
```

## RFC 9727 API catalog

### GET /.well-known/api-catalog

Read the RFC 9727 linkset that names vAPI discovery, the x402 decoder, the hosted MCP, and related machine-readable documents.

**Auth:** none.

| Request header | Description                     |
| -------------- | ------------------------------- |
| `Accept`       | Use `application/linkset+json`. |

```bash
curl -H 'Accept: application/linkset+json' 'https://api.vapinetwork.ai/.well-known/api-catalog'
```

The response is a linkset with content type `application/linkset+json`.

```json
{
  "linkset": [
    {
      "anchor": "https://api.vapinetwork.ai/.well-known/api-catalog",
      "item": [
        { "href": "https://api.vapinetwork.ai/api/call/discovery", "title": "Call discovery" },
        { "href": "https://api.vapinetwork.ai/x402/decode", "title": "vAPI x402 decoder" },
        { "href": "https://api.vapinetwork.ai/mcp", "title": "vAPI hosted MCP" },
        { "href": "https://api.vapinetwork.ai/a2a", "title": "vAPI A2A agent" }
      ],
      "service-doc": [{ "href": "https://vapinetwork.ai/llms.txt", "type": "text/plain" }]
    },
    {
      "anchor": "https://api.vapinetwork.ai/x402/decode",
      "service-desc": [
        { "href": "https://api.vapinetwork.ai/x402/openapi.json", "type": "application/json" }
      ],
      "status": [{ "href": "https://api.vapinetwork.ai/x402/readyz", "type": "application/json" }]
    },
    {
      "anchor": "https://api.vapinetwork.ai/mcp",
      "status": [{ "href": "https://api.vapinetwork.ai/mcp/health", "type": "application/json" }]
    },
    {
      "anchor": "https://api.vapinetwork.ai/a2a",
      "service-desc": [
        {
          "href": "https://api.vapinetwork.ai/.well-known/agent-card.json",
          "type": "application/json"
        }
      ]
    }
  ]
}
```

### HEAD /.well-known/api-catalog

Check the API catalog headers without downloading the linkset body.

**Auth:** none.

| Request header | Description                    |
| -------------- | ------------------------------ |
| None           | No request header is required. |

```bash
curl -I 'https://api.vapinetwork.ai/.well-known/api-catalog'
```

The headers keep the catalog link. A response body is not used for this request.

The console root and `/api/call/discovery` also send a `Link` header pointing to this catalog.

Checked on 2026-10-16.
