import { afterEach, describe, expect, it, vi } from "vitest";

import { MCP_APP_VIEWS, createViewLoader } from "./views.js";

const registryUrl = "https://api.vapinetwork.ai/api/call/discovery";
const html = "<html>view</html>";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("MCP App views", () => {
  it("reuses the canonical view for each deprecated alias", () => {
    expect(MCP_APP_VIEWS.search).toBe(MCP_APP_VIEWS["call.search"]);
    expect(MCP_APP_VIEWS.inspect).toBe(MCP_APP_VIEWS["call.inspect"]);
  });

  it.each([html, ""])("caches a 200 body and exposes it synchronously: %j", async (body) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(body));
    const loader = createViewLoader({ registryUrl, fetchImpl });
    expect(loader.origin).toBe("https://api.vapinetwork.ai");
    expect(loader.get("call-search")).toBeUndefined();
    expect(await loader.load("call-search")).toBe(body);
    expect(loader.get("call-search")).toBe(body);
    expect(await loader.load("call-search")).toBe(body);
    expect(fetchImpl).toHaveBeenCalledExactlyOnceWith(
      "https://api.vapinetwork.ai/mcp/apps/call-search.html",
      { signal: expect.any(AbortSignal), redirect: "manual" },
    );
  });

  it("deduplicates concurrent loads and repeated warm-ups per view", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(html));
    const loader = createViewLoader({ registryUrl, fetchImpl });
    const first = loader.load("call-search");
    const second = loader.load("call-search");
    expect(first).toBe(second);
    await Promise.all([first, second, loader.warm(), loader.warm()]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(loader.get("call-search")).toBe(html);
    expect(loader.get("call-inspect")).toBe(html);
  });

  it.each([404, 302])("returns undefined and logs one line for HTTP %i", async (status) => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("unavailable", { status }));
    const log = vi.fn();
    const loader = createViewLoader({ registryUrl, fetchImpl, log });
    expect(await loader.load("call-search")).toBeUndefined();
    expect(loader.get("call-search")).toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledExactlyOnceWith(
      `vapi mcp: could not load view call-search from https://api.vapinetwork.ai/mcp/apps/call-search.html: HTTP ${status}`,
    );
  });

  it("retries failures, logs once per view, and caches a later success", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error("offline\nnetwork error"))
      .mockRejectedValueOnce(new Error("still offline"))
      .mockResolvedValueOnce(new Response(html));
    const log = vi.fn();
    const loader = createViewLoader({ registryUrl, fetchImpl, log });
    expect(await loader.load("call-inspect")).toBeUndefined();
    expect(await loader.load("call-inspect")).toBeUndefined();
    expect(log).toHaveBeenCalledExactlyOnceWith(
      "vapi mcp: could not load view call-inspect from https://api.vapinetwork.ai/mcp/apps/call-inspect.html: offline network error",
    );
    expect(await loader.load("call-inspect")).toBe(html);
    expect(await loader.load("call-inspect")).toBe(html);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(log).toHaveBeenCalledOnce();
  });

  it("aborts a stalled request at the timeout and clears the timer", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn<typeof fetch>(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
            once: true,
          });
        }),
    );
    const log = vi.fn();
    const loader = createViewLoader({ registryUrl, fetchImpl, timeoutMs: 10, log });
    const pending = loader.load("call-search");
    await vi.advanceTimersByTimeAsync(10);
    expect(await pending).toBeUndefined();
    expect(fetchImpl.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(log).toHaveBeenCalledOnce();
    expect(log.mock.calls[0]?.[0]).toContain("timed out after 10 ms");
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["request", "body"])("bounds a stalled %s even if it ignores abort", async (stage) => {
    vi.useFakeTimers();
    const stalled = new Promise<never>(() => {});
    const response = new Response(html);
    vi.spyOn(response, "text").mockReturnValue(stalled);
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(() => (stage === "request" ? stalled : Promise.resolve(response)));
    const loader = createViewLoader({ registryUrl, fetchImpl, timeoutMs: 10, log: vi.fn() });
    const pending = loader.load("call-search");
    await vi.advanceTimersByTimeAsync(10);
    expect(await pending).toBeUndefined();
    expect(loader.get("call-search")).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not let a late timed-out response overwrite a successful retry", async () => {
    vi.useFakeTimers();
    let resolveFirst!: (response: Response) => void;
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveFirst = resolve;
        }),
      )
      .mockResolvedValueOnce(new Response(html));
    const loader = createViewLoader({ registryUrl, fetchImpl, timeoutMs: 10, log: vi.fn() });
    const first = loader.load("call-search");
    await vi.advanceTimersByTimeAsync(10);
    expect(await first).toBeUndefined();
    expect(await loader.load("call-search")).toBe(html);
    resolveFirst(new Response("stale"));
    await vi.advanceTimersByTimeAsync(0);
    expect(loader.get("call-search")).toBe(html);
  });

  it("keeps body-read and diagnostic failures from rejecting a warm-up", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      const response = new Response(html);
      vi.spyOn(response, "text").mockRejectedValue(new Error("body unreadable"));
      return response;
    });
    const log = vi.fn(() => {
      throw new Error("stderr unavailable");
    });
    const loader = createViewLoader({ registryUrl, fetchImpl, log });
    await expect(loader.warm()).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledTimes(2);
    expect(loader.get("call-search")).toBeUndefined();
    expect(loader.get("call-inspect")).toBeUndefined();
  });

  it("writes a single newline-terminated diagnostic to stderr by default", async () => {
    const write = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new Error("offline"));
    const loader = createViewLoader({ registryUrl, fetchImpl });
    await loader.load("call-search");
    await loader.load("call-search");
    expect(write).toHaveBeenCalledExactlyOnceWith(
      "vapi mcp: could not load view call-search from https://api.vapinetwork.ai/mcp/apps/call-search.html: offline\n",
    );
  });
});
