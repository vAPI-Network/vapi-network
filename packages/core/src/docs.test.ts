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

describe("documentation client", () => {
  it.each([
    ["SSE", `event: message\ndata: ${JSON.stringify(result)}\n\n`, "text/event-stream"],
    ["plain JSON", JSON.stringify(result), "application/json"],
  ])("parses %s search responses and skips malformed blocks", async (_name, body, contentType) => {
    const fetchImpl = vi
      .fn<typeof fetch>()
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
    const request = new Request(...(fetchImpl.mock.calls[0] as [RequestInfo | URL, RequestInit]));
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
    ["/", "https://docs.vapinetwork.ai/readme.md"],
  ])("normalizes read input %s", async (input, expected) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response("# Page"));

    await expect(readDocs(input, { fetchImpl })).resolves.toEqual({
      url: expected,
      markdown: "# Page",
    });
    expect(String(fetchImpl.mock.calls[0]![0])).toBe(expected);
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

  it.each([
    [() => searchDocs("   "), "invalid_input"],
    [() => askDocs("\n"), "invalid_input"],
  ])("rejects empty input locally", async (operation, code) => {
    await expect(operation()).rejects.toBeInstanceOf(DocsError);
    await expect(operation()).rejects.toMatchObject({ code });
  });
});
