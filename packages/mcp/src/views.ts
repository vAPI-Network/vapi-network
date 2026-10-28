export type ViewName = "call-search" | "call-inspect";

const searchView = { view: "call-search", uri: "ui://vapi/call-search.html" } as const;
const inspectView = { view: "call-inspect", uri: "ui://vapi/call-inspect.html" } as const;

export const MCP_APP_VIEWS = {
  "call.search": searchView,
  "call.inspect": inspectView,
  search: searchView,
  inspect: inspectView,
} as const satisfies Record<string, { view: string; uri: string }>;

export const VIEW_RESOURCE_META = {
  "call-search": {
    title: "vAPI marketplace results",
    description: "Interactive list of Call listings returned by call.search.",
  },
  "call-inspect": {
    title: "vAPI listing inspector",
    description: "Interactive request contract and price for one Call listing.",
  },
};

export type ViewLoader = {
  origin: string;
  load(view: ViewName): Promise<string | undefined>;
  get(view: ViewName): string | undefined;
  warm(): Promise<void>;
};

export function createViewLoader(options: {
  registryUrl: string;
  fetchImpl: typeof fetch;
  timeoutMs?: number;
  log?: (line: string) => void;
}): ViewLoader {
  const origin = new URL(options.registryUrl).origin;
  const timeoutMs = options.timeoutMs ?? 2_000;
  const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const cache = new Map<ViewName, string>();
  const inFlight = new Map<ViewName, Promise<string | undefined>>();
  const logged = new Set<ViewName>();

  async function fetchHtml(view: ViewName): Promise<string | undefined> {
    const url = `${origin}/mcp/apps/${view}.html`;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        const error = new Error(`timed out after ${timeoutMs} ms`);
        reject(error);
        controller.abort(error);
      }, timeoutMs);
    });
    try {
      // Bound both the request and body read, even if a fetch ignores abort.
      return await Promise.race([
        (async () => {
          const response = await options.fetchImpl(url, {
            signal: controller.signal,
            redirect: "manual",
          });
          if (response.status !== 200) {
            void response.body?.cancel().catch(() => {});
            throw new Error(`HTTP ${response.status}`);
          }
          return await response.text();
        })(),
        timedOut,
      ]);
    } catch (error) {
      if (!logged.has(view)) {
        logged.add(view);
        const reason = (error instanceof Error ? error.message : String(error)).replace(
          /[\r\n\u2028\u2029]+/gu,
          " ",
        );
        try {
          log(`vapi mcp: could not load view ${view} from ${url}: ${reason}`);
        } catch {
          // A diagnostic failure must not prevent the host's text fallback.
        }
      }
      return undefined;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  function load(view: ViewName): Promise<string | undefined> {
    const html = cache.get(view);
    if (html !== undefined) return Promise.resolve(html);
    const pending = inFlight.get(view);
    if (pending) return pending;
    const request = fetchHtml(view)
      .then((html) => {
        if (html !== undefined) cache.set(view, html);
        return html;
      })
      .finally(() => inFlight.delete(view));
    inFlight.set(view, request);
    return request;
  }

  return {
    origin,
    load,
    get: (view) => cache.get(view),
    async warm() {
      await Promise.allSettled([load("call-search"), load("call-inspect")]);
    },
  };
}
