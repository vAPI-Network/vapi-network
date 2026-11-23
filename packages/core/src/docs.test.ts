import { describe, expect, it, vi } from "vitest";

import { DocsError, askDocs, readDocs, searchDocs } from "./docs.js";

const DOCS_RESPONSE_MAX_BYTES = 2 * 1024 * 1024;

const result = {
  result: {
    content: [
      {
        type: "text",
        text: "Title: Quickstart\nLink: https://docs.vapinetwork.ai/quickstart\nContent: Start here.",
      },
      { type: "text", text: "not a result" },
      {
        type: "text",
        text: "Title: Agents\nLink: https://docs.vapinetwork.ai/agents/quickstart\nContent: Build an agent.\nSecond line.",
      },
    ],
  },
  jsonrpc: "2.0",
  id: 1,
};

const siteResults = [
  {
    url: "/router/access-and-keys/",
    title: "Access and keys",
    heading: "",
    snippet:
      "Create and revoke wallet-bound Router keys, and choose Compute, Router balance, or an owner hybrid key. Key creation requires a ready account with a confirmed …",
  },
  {
    url: "/reference/http-api/agents-and-router/",
    title: "Agents and Router",
    heading: "",
    snippet:
      "HTTP routes for owner links, controls, prepaid balances, and live Router keys and usage. …",
  },
];

function siteSearchResponse(items = siteResults): Response {
  const envelope = {
    result: { content: [{ type: "text", text: JSON.stringify(items) }], isError: false },
    jsonrpc: "2.0",
    id: 1,
  };
  return new Response(`event: message\ndata: ${JSON.stringify(envelope)}\n\n`, {
    headers: { "content-type": "text/event-stream" },
  });
}

describe("documentation client", () => {
  it("searches the new site's MCP endpoint and parses its SSE JSON array", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => siteSearchResponse());

    await expect(searchDocs(" router keys ", { fetchImpl, limit: 2 })).resolves.toEqual({
      results: siteResults.map(({ title, url, snippet }) => ({
        title,
        url: `https://docs.vapinetwork.ai${url}`,
        excerpt: snippet,
      })),
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
    const request = new Request(...(fetchImpl.mock.calls[0] as [RequestInfo | URL, RequestInit]));
    expect(request.url).toBe("https://docs.vapinetwork.ai/mcp");
    expect(request.method).toBe("POST");
    expect(request.headers.get("content-type")).toBe("application/json");
    expect(request.headers.get("accept")).toBe("application/json, text/event-stream");
    expect(request.headers.get("authorization")).toBeNull();
    expect(await request.json()).toEqual({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "search_docs", arguments: { query: "router keys", limit: 2 } },
    });
  });

  it("includes a heading and anchor on the configured docs origin", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      siteSearchResponse([
        {
          title: "Call",
          url: "/call/#who-call-is-for",
          heading: "Who Call is for",
          snippet: "Call APIs from your agent.",
        },
      ]),
    );

    await expect(
      searchDocs("call", {
        fetchImpl,
        env: { VAPI_DOCS_URL: "https://docs-staging.vapinetwork.ai" },
      }),
    ).resolves.toEqual({
      results: [
        {
          title: "Call › Who Call is for",
          url: "https://docs-staging.vapinetwork.ai/call/#who-call-is-for",
          excerpt: "Call APIs from your agent.",
        },
      ],
    });
    expect(String(fetchImpl.mock.calls[0]![0])).toBe("https://docs-staging.vapinetwork.ai/mcp");
    expect(JSON.parse(fetchImpl.mock.calls[0]![1]!.body as string).params.arguments).toEqual({
      query: "call",
    });
  });

  it.each([1, 12])("slices results locally and caps the tool limit for %s", async (limit) => {
    const items = Array.from({ length: 15 }, () => siteResults[0]!);
    const fetchImpl = vi.fn<typeof fetch>(async () => siteSearchResponse(items));

    expect((await searchDocs("keys", { fetchImpl, limit })).results).toHaveLength(limit);
    expect(JSON.parse(fetchImpl.mock.calls[0]![1]!.body as string).params.arguments.limit).toBe(
      Math.min(limit, 10),
    );
  });

  it.each([
    ["SSE", `event: message\ndata: ${JSON.stringify(result)}\n\n`, "text/event-stream"],
    ["plain JSON", JSON.stringify(result), "application/json"],
  ])("parses %s search responses and skips malformed blocks", async (_name, body, contentType) => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("Not Found", { status: 404 }))
      .mockResolvedValue(new Response(body, { headers: { "content-type": contentType } }));

    await expect(searchDocs("agent docs", { fetchImpl, limit: 1 })).resolves.toEqual({
      results: [
        {
          title: "Quickstart",
          url: "https://docs.vapinetwork.ai/quickstart",
          excerpt: "Start here.",
        },
      ],
    });
    expect(fetchImpl.mock.calls.map(([url]) => String(url))).toEqual([
      "https://docs.vapinetwork.ai/mcp",
      "https://docs.vapinetwork.ai/~gitbook/mcp",
    ]);
    const request = new Request(...(fetchImpl.mock.calls[1] as [RequestInfo | URL, RequestInit]));
    expect(request.url).toBe("https://docs.vapinetwork.ai/~gitbook/mcp");
    expect(request.method).toBe("POST");
    expect(request.headers.get("authorization")).toBeNull();
    expect(request.headers.get("accept")).toBe("application/json, text/event-stream");
    expect(await request.json()).toEqual({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "searchDocumentation", arguments: { query: "agent docs" } },
    });
  });

  it("falls back to GitBook search when /mcp answers HTTP 405, as GitBook does", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("Method Not Allowed", { status: 405 }))
      .mockResolvedValue(Response.json(result));

    await expect(searchDocs("agent docs", { fetchImpl, limit: 1 })).resolves.toEqual({
      results: [
        {
          title: "Quickstart",
          url: "https://docs.vapinetwork.ai/quickstart",
          excerpt: "Start here.",
        },
      ],
    });
    expect(fetchImpl.mock.calls.map(([url]) => String(url))).toEqual([
      "https://docs.vapinetwork.ai/mcp",
      "https://docs.vapinetwork.ai/~gitbook/mcp",
    ]);
  });

  it.each([
    ["tool error", { isError: true, content: [{ type: "text", text: "Unknown tool" }] }],
    ["invalid JSON", { content: [{ type: "text", text: "not JSON" }] }],
    ["invalid array", { content: [{ type: "text", text: "{}" }] }],
    ["invalid item", { content: [{ type: "text", text: '[{"title":"Call"}]' }] }],
    ["missing text", { content: [] }],
  ])("rejects a new-site %s without falling back", async (_name, toolResult) => {
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ result: toolResult }));

    await expect(searchDocs("call", { fetchImpl })).rejects.toMatchObject({
      code: "bad_response",
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it.each([401, 429, 500])("does not fall back on HTTP %s", async (status) => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response("Unavailable", { status }));

    await expect(searchDocs("call", { fetchImpl })).rejects.toMatchObject({
      code: "bad_response",
      message: expect.stringContaining(`HTTP ${status}`),
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("rejects a search result outside the docs origin", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      siteSearchResponse([{ ...siteResults[0]!, url: "https://evil.example/call/" }]),
    );

    await expect(searchDocs("call", { fetchImpl })).rejects.toMatchObject({
      code: "host_not_allowed",
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("turns a JSON-RPC search error into a stable bad-response error", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "unavailable" } }),
      );

    await expect(searchDocs("agents", { fetchImpl })).rejects.toMatchObject({
      name: "DocsError",
      code: "bad_response",
      message: expect.stringContaining("unavailable"),
    });
  });

  it.each([
    ["agents/quickstart", "https://docs.vapinetwork.ai/agents/quickstart.md"],
    ["/agents/quickstart.md?old=1#install", "https://docs.vapinetwork.ai/agents/quickstart.md"],
    [
      "https://docs.vapinetwork.ai/quickstart.md?x=1#top",
      "https://docs.vapinetwork.ai/quickstart.md",
    ],
    ["/call/", "https://docs.vapinetwork.ai/call.md"],
    ["/call/readme.md?old=1#top", "https://docs.vapinetwork.ai/call.md"],
    ["/call/readme", "https://docs.vapinetwork.ai/call/readme.md"],
    ["/", "https://docs.vapinetwork.ai/index.md"],
  ])("normalizes read input %s", async (input, expected) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response("# Page"));

    await expect(readDocs(input, { fetchImpl })).resolves.toEqual({
      url: expected,
      markdown: "# Page",
    });
    expect(String(fetchImpl.mock.calls[0]![0])).toBe(expected);
  });

  it("falls back to GitBook's readme for the docs root", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("Missing", { status: 404 }))
      .mockResolvedValueOnce(new Response("# Home"));

    await expect(readDocs("/", { fetchImpl })).resolves.toEqual({
      url: "https://docs.vapinetwork.ai/readme.md",
      markdown: "# Home",
    });
    expect(fetchImpl.mock.calls.map(([url]) => String(url))).toEqual([
      "https://docs.vapinetwork.ai/index.md",
      "https://docs.vapinetwork.ai/readme.md",
    ]);
  });

  it.each([
    "https://docs.vapinetwork.ai.evil.com/quickstart",
    "http://docs.vapinetwork.ai/quickstart",
    "https://user@docs.vapinetwork.ai/quickstart",
    "https://docs.vapinetwork.ai:444/quickstart",
    "//evil.example/quickstart",
  ])("refuses disallowed read target %s before fetching", async (input) => {
    const fetchImpl = vi.fn<typeof fetch>();

    await expect(readDocs(input, { fetchImpl })).rejects.toMatchObject({
      name: "DocsError",
      code: "host_not_allowed",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("uses the configured docs origin and still refuses every other origin", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response("# Internal docs"));
    const env = { VAPI_DOCS_URL: "https://docs-staging.vapinetwork.ai" };

    await expect(readDocs("/quickstart", { fetchImpl, env })).resolves.toMatchObject({
      url: "https://docs-staging.vapinetwork.ai/quickstart.md",
    });
    await expect(
      readDocs("https://docs.vapinetwork.ai/quickstart", { fetchImpl, env }),
    ).rejects.toMatchObject({ code: "host_not_allowed" });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it.each([
    () => new Response("missing", { status: 404 }),
    () => new Response("# Page Not Found\nTry another page."),
  ])("detects missing documentation pages", async (response) => {
    const fetchImpl = vi.fn<typeof fetch>(async () => response());

    await expect(readDocs("missing", { fetchImpl })).rejects.toMatchObject({ code: "not_found" });
    expect(fetchImpl.mock.calls.map(([url, init]) => `${init?.method} ${String(url)}`)).toEqual([
      "GET https://docs.vapinetwork.ai/missing.md",
      "GET https://docs.vapinetwork.ai/missing/readme.md",
      "HEAD https://docs.vapinetwork.ai/missing",
    ]);
  });

  it("reads a section root from its readme page", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (url) =>
      String(url).endsWith("/call/readme.md")
        ? new Response("# Call")
        : new Response("# Page Not Found\nTry another page."),
    );

    await expect(readDocs("/call", { fetchImpl })).resolves.toEqual({
      url: "https://docs.vapinetwork.ai/call/readme.md",
      markdown: "# Call",
    });
  });

  it("finds a moved page through its HTML redirect when the .md path stops short", async () => {
    const notFound = () => new Response("# Page Not Found\nTry another page.");
    const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (init?.method === "HEAD" && path === "/developers/quickstart") {
        return new Response(null, { status: 307, headers: { location: "/reference/quickstart" } });
      }
      if (init?.method === "HEAD" && path === "/reference/quickstart") {
        return new Response(null, { status: 308, headers: { location: "/quickstart" } });
      }
      if (init?.method === "HEAD") return new Response(null);
      return path === "/quickstart.md" ? new Response("# Quickstart") : notFound();
    });

    await expect(readDocs("/developers/quickstart", { fetchImpl })).resolves.toEqual({
      url: "https://docs.vapinetwork.ai/quickstart.md",
      markdown: "# Quickstart",
    });
  });

  it("follows a moved page's same-origin redirect and reports the final URL", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(null, { status: 307, headers: { location: "/reference/quickstart.md" } }),
      )
      .mockResolvedValueOnce(new Response("# Quickstart"));

    await expect(readDocs("/developers/quickstart", { fetchImpl })).resolves.toEqual({
      url: "https://docs.vapinetwork.ai/reference/quickstart.md",
      markdown: "# Quickstart",
    });
    expect(fetchImpl.mock.calls.map(([url]) => String(url))).toEqual([
      "https://docs.vapinetwork.ai/developers/quickstart.md",
      "https://docs.vapinetwork.ai/reference/quickstart.md",
    ]);
    expect(fetchImpl.mock.calls[0]![1]).toMatchObject({ redirect: "manual" });
  });

  it("refuses a redirect off the docs origin and stops redirect loops", async () => {
    const offOrigin = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(null, { status: 302, headers: { location: "https://evil.example/x.md" } }),
      );
    await expect(readDocs("quickstart", { fetchImpl: offOrigin })).rejects.toMatchObject({
      code: "host_not_allowed",
    });
    expect(offOrigin).toHaveBeenCalledOnce();

    const loop = vi.fn<typeof fetch>(
      async () => new Response(null, { status: 308, headers: { location: "/quickstart.md" } }),
    );
    await expect(readDocs("quickstart", { fetchImpl: loop })).rejects.toMatchObject({
      code: "bad_response",
      message: expect.stringContaining("redirected too many times"),
    });
    expect(loop).toHaveBeenCalledTimes(6);
  });

  it("times out a request even when the injected fetch ignores abort", async () => {
    const fetchImpl = vi.fn<typeof fetch>(() => new Promise(() => undefined));

    await expect(readDocs("quickstart", { fetchImpl, timeoutMs: 5 })).rejects.toMatchObject({
      code: "timeout",
    });
  });

  it("caps response bodies", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("x".repeat(DOCS_RESPONSE_MAX_BYTES + 1)));

    await expect(readDocs("quickstart", { fetchImpl })).rejects.toMatchObject({
      code: "bad_response",
      message: expect.stringContaining("exceeded"),
    });
  });

  it("parses the trailing answer source list", async () => {
    const markdown =
      "Use `vapi setup` first.\n\nMore detail.\n\n# Sources:\n- [Quickstart](https://docs.vapinetwork.ai/quickstart)\n- https://docs.vapinetwork.ai/call/quickstart\n";
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(markdown));

    await expect(askDocs("How do I start?", { fetchImpl })).resolves.toEqual({
      answer: "Use `vapi setup` first.\n\nMore detail.",
      sources: [
        { title: "Quickstart", url: "https://docs.vapinetwork.ai/quickstart" },
        {
          title: "https://docs.vapinetwork.ai/call/quickstart",
          url: "https://docs.vapinetwork.ai/call/quickstart",
        },
      ],
    });
    const requested = new URL(String(fetchImpl.mock.calls[0]![0]));
    expect(requested.origin).toBe("https://docs.vapinetwork.ai");
    expect(requested.searchParams.get("ask")).toBe("How do I start?");
  });

  it("falls back from ask HTTP 404 to the top three search sections", async () => {
    const items = Array.from({ length: 4 }, (_value, index) => ({
      ...siteResults[0]!,
      title: `Section ${index + 1}`,
      snippet: `Snippet ${index + 1}.`,
      url: `/section-${index + 1}/`,
    }));
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("<h1>Not Found</h1>", { status: 404 }))
      .mockImplementation(async () => siteSearchResponse(items));

    await expect(askDocs(" router keys ", { fetchImpl })).resolves.toEqual({
      answer:
        "These are the closest sections of the docs; the new docs site has no assistant.\n\n" +
        "- [Section 1](https://docs.vapinetwork.ai/section-1/): Snippet 1.\n" +
        "- [Section 2](https://docs.vapinetwork.ai/section-2/): Snippet 2.\n" +
        "- [Section 3](https://docs.vapinetwork.ai/section-3/): Snippet 3.",
      sources: items.slice(0, 3).map(({ title, url }) => ({
        title,
        url: `https://docs.vapinetwork.ai${url}`,
      })),
    });
    expect(fetchImpl.mock.calls.map(([url]) => String(url))).toEqual([
      "https://docs.vapinetwork.ai/readme.md?ask=router+keys",
      "https://docs.vapinetwork.ai/mcp",
    ]);
    expect(JSON.parse(fetchImpl.mock.calls[1]![1]!.body as string).params.arguments).toEqual({
      query: "router keys",
      limit: 3,
    });
  });

  it("reports no matching docs when the ask fallback search is empty", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("Not Found", { status: 404 }))
      .mockResolvedValueOnce(siteSearchResponse([]));

    await expect(askDocs("unknown topic", { fetchImpl })).resolves.toEqual({
      answer: "No matching documentation found.",
      sources: [],
    });
  });

  it("does not fall back from ask on an HTTP 500", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response("Unavailable", { status: 500 }));

    await expect(askDocs("router keys", { fetchImpl })).rejects.toMatchObject({
      code: "bad_response",
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it.each([
    [() => searchDocs("   "), "invalid_input"],
    [() => askDocs("\n"), "invalid_input"],
  ])("rejects empty input locally", async (operation, code) => {
    await expect(operation()).rejects.toBeInstanceOf(DocsError);
    await expect(operation()).rejects.toMatchObject({ code });
  });
});
