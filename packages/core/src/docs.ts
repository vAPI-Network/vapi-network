import { createPublicFetch } from "./net-guard.js";

export const DEFAULT_DOCS_ORIGIN = "https://docs.vapinetwork.ai";
const DOCS_URL_ENV = "VAPI_DOCS_URL";
const DOCS_RESPONSE_MAX_BYTES = 2 * 1024 * 1024;

const SEARCH_TIMEOUT_MS = 15_000;
const READ_TIMEOUT_MS = 15_000;
const ASK_TIMEOUT_MS = 60_000;
const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export type DocsErrorCode =
  "invalid_input" | "host_not_allowed" | "not_found" | "timeout" | "bad_response";

export class DocsError extends Error {
  readonly name = "DocsError";

  constructor(
    readonly code: DocsErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export type DocsSearchResult = { title: string; url: string; excerpt: string };
export type DocsSearchResponse = { results: DocsSearchResult[] };
export type DocsReadResponse = { url: string; markdown: string };
export type DocsSource = { title: string; url: string };
export type DocsAskResponse = { answer: string; sources: DocsSource[] };

export type DocsRequestOptions = {
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  /** Test and embedded-runtime deadline override. */
  timeoutMs?: number;
};

export type DocsSearchOptions = DocsRequestOptions & { limit?: number };

const publicFetch = createPublicFetch({ allowPrivateNetwork: false });

function resolveDocsOrigin(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env[DOCS_URL_ENV]?.trim() || DEFAULT_DOCS_ORIGIN;
  let url: URL;
  try {
    url = new URL(configured);
  } catch (cause) {
    throw new DocsError("host_not_allowed", `The configured docs origin is invalid.`, { cause });
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new DocsError(
      "host_not_allowed",
      "The configured docs origin must be an HTTPS origin without credentials, a path, a query, or a fragment.",
    );
  }
  return url.origin;
}

export async function searchDocs(
  query: string,
  options: DocsSearchOptions = {},
): Promise<DocsSearchResponse> {
  const normalized = nonEmpty(query, "Search query");
  if (options.limit !== undefined && (!Number.isSafeInteger(options.limit) || options.limit < 1)) {
    throw new DocsError("invalid_input", "Search limit must be a positive integer.");
  }
  const origin = resolveDocsOrigin(options.env);
  const { text: body } = await requestText(
    new URL("/~gitbook/mcp", origin),
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "searchDocumentation", arguments: { query: normalized } },
      }),
    },
    {
      operation: "search",
      origin,
      timeoutMs: options.timeoutMs ?? SEARCH_TIMEOUT_MS,
      fetchImpl: options.fetchImpl,
    },
  );
  const payload = parseSearchEnvelope(body);
  const blocks = searchTextBlocks(payload);
  const results = blocks.flatMap((block) => {
    const parsed = parseSearchBlock(block);
    return parsed === undefined ? [] : [parsed];
  });
  return { results: options.limit === undefined ? results : results.slice(0, options.limit) };
}

export async function readDocs(
  pageUrlOrPath: string,
  options: DocsRequestOptions = {},
): Promise<DocsReadResponse> {
  const input = nonEmpty(pageUrlOrPath, "Documentation page");
  const origin = resolveDocsOrigin(options.env);
  const page = docsPagePath(input, origin);
  const requestOptions = {
    operation: "read" as const,
    origin,
    timeoutMs: options.timeoutMs ?? READ_TIMEOUT_MS,
    fetchImpl: options.fetchImpl,
  };
  const found = await readFirstMarkdown(page, requestOptions);
  if (found !== undefined) return found;
  // A moved page's HTML path redirects all the way to its new home; its .md path can stop short.
  const { url: canonical } = await requestText(
    page,
    { method: "HEAD" },
    { ...requestOptions, notFoundOn404: true },
  );
  if (canonical.pathname !== page.pathname) {
    const moved = await readFirstMarkdown(canonical, requestOptions);
    if (moved !== undefined) return moved;
  }
  throw new DocsError("not_found", `Documentation page not found: ${page.href}`);
}

/** GitBook serves a page at `<path>.md` and a section or group root at `<path>/readme.md`. */
async function readFirstMarkdown(
  page: URL,
  options: RequestOptions,
): Promise<DocsReadResponse | undefined> {
  const path = page.pathname.replace(/\/+$/u, "");
  const candidates = path ? [`${path}.md`, `${path}/readme.md`] : ["/readme.md"];
  for (const pathname of candidates) {
    const candidate = new URL(page);
    candidate.pathname = pathname;
    try {
      const { text: markdown, url } = await requestText(
        candidate,
        { method: "GET", headers: { accept: "text/markdown" } },
        { ...options, notFoundOn404: true },
      );
      if (!markdown.trimStart().startsWith("# Page Not Found")) {
        return { url: url.href, markdown };
      }
    } catch (error) {
      if (!(error instanceof DocsError && error.code === "not_found")) throw error;
    }
  }
  return undefined;
}

export async function askDocs(
  question: string,
  options: DocsRequestOptions = {},
): Promise<DocsAskResponse> {
  const normalized = nonEmpty(question, "Question");
  const origin = resolveDocsOrigin(options.env);
  // The ask interface answers on markdown URLs; the bare site root serves HTML without the header.
  const url = new URL("/readme.md", origin);
  url.searchParams.set("ask", normalized);
  const { text: markdown } = await requestText(
    url,
    { method: "GET", headers: { accept: "text/markdown" } },
    {
      operation: "ask",
      origin,
      timeoutMs: options.timeoutMs ?? ASK_TIMEOUT_MS,
      fetchImpl: options.fetchImpl,
    },
  );
  return parseAnswer(markdown);
}

function nonEmpty(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new DocsError("invalid_input", `${label} must not be empty.`);
  return normalized;
}

function docsPagePath(value: string, origin: string): URL {
  let url: URL;
  try {
    url = new URL(value, `${origin}/`);
  } catch (cause) {
    throw new DocsError("invalid_input", "Documentation page must be a docs URL or path.", {
      cause,
    });
  }
  if (url.origin !== origin || url.username || url.password) {
    throw new DocsError(
      "host_not_allowed",
      `Documentation pages must use the configured docs origin ${origin}.`,
    );
  }
  url.search = "";
  url.hash = "";
  url.pathname = url.pathname.replace(/\/+$/u, "").replace(/(?:\/readme)?\.md$/iu, "") || "/";
  return url;
}

type RequestOptions = {
  operation: "search" | "read" | "ask";
  origin: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
  notFoundOn404?: boolean;
};

async function requestText(
  requestUrl: URL,
  init: RequestInit,
  options: RequestOptions,
): Promise<{ text: string; url: URL }> {
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1) {
    throw new DocsError("invalid_input", "Documentation request timeout must be positive.");
  }
  assertAllowedUrl(requestUrl, options.origin);
  const controller = new AbortController();
  const timeoutError = new DocsError(
    "timeout",
    `The documentation ${options.operation} request timed out.`,
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort(timeoutError);
      reject(timeoutError);
    }, options.timeoutMs);
  });
  let url = requestUrl;
  try {
    let response: Response;
    for (let hops = 0; ; hops += 1) {
      response = await Promise.race([
        (options.fetchImpl ?? publicFetch)(url, {
          ...init,
          redirect: "manual",
          signal: controller.signal,
        }),
        timeout,
      ]);
      if (response.url) assertAllowedUrl(new URL(response.url), options.origin);
      const location = response.headers.get("location");
      // Moved docs pages redirect to their new path; GET and HEAD follow, and only within the docs origin.
      if (
        (init.method !== "GET" && init.method !== "HEAD") ||
        !REDIRECT_STATUSES.has(response.status) ||
        !location
      ) {
        break;
      }
      if (hops === MAX_REDIRECTS) {
        throw new DocsError(
          "bad_response",
          `The documentation ${options.operation} request redirected too many times.`,
        );
      }
      await response.body?.cancel();
      const next = new URL(location, url);
      assertAllowedUrl(next, options.origin);
      url = next;
    }
    if (options.notFoundOn404 && response.status === 404) {
      throw new DocsError("not_found", `Documentation page not found: ${url.href}`);
    }
    if (!response.ok) {
      throw new DocsError(
        "bad_response",
        `The documentation ${options.operation} request returned HTTP ${response.status}.`,
      );
    }
    return { text: await Promise.race([readCappedText(response), timeout]), url };
  } catch (error) {
    if (error instanceof DocsError) throw error;
    if (controller.signal.aborted) throw timeoutError;
    throw new DocsError("bad_response", `The documentation ${options.operation} request failed.`, {
      cause: error,
    });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function assertAllowedUrl(url: URL, origin: string): void {
  if (url.origin !== origin || url.username || url.password) {
    throw new DocsError(
      "host_not_allowed",
      `Documentation requests may only contact the configured docs origin ${origin}.`,
    );
  }
}

async function readCappedText(response: Response): Promise<string> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && Number(contentLength) > DOCS_RESPONSE_MAX_BYTES) {
    throw responseTooLarge();
  }
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > DOCS_RESPONSE_MAX_BYTES) {
        await reader.cancel();
        throw responseTooLarge();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function responseTooLarge(): DocsError {
  return new DocsError(
    "bad_response",
    `The documentation response exceeded ${DOCS_RESPONSE_MAX_BYTES} bytes.`,
  );
}

function parseSearchEnvelope(body: string): unknown {
  const trimmed = body.trim();
  if (!trimmed) throw invalidSearchResponse();
  if (trimmed.startsWith("{")) return parseJson(trimmed);

  const records: string[] = [];
  let data: string[] = [];
  for (const line of body.split(/\r?\n/u)) {
    if (line === "") {
      if (data.length > 0) records.push(data.join("\n"));
      data = [];
    } else if (line.startsWith("data:")) {
      data.push(line.slice(5).trimStart());
    }
  }
  if (data.length > 0) records.push(data.join("\n"));
  for (const record of records) {
    try {
      return JSON.parse(record) as unknown;
    } catch {
      // A malformed SSE event is ignored in case a later event has the result.
    }
  }
  throw invalidSearchResponse();
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (cause) {
    throw new DocsError("bad_response", "The documentation search response was invalid JSON.", {
      cause,
    });
  }
}

function searchTextBlocks(payload: unknown): string[] {
  const envelope = asRecord(payload);
  const rpcError = asRecord(envelope?.error);
  if (rpcError !== undefined) {
    const message = typeof rpcError.message === "string" ? `: ${rpcError.message}` : "";
    throw new DocsError("bad_response", `The documentation search returned an error${message}`);
  }
  const result = asRecord(envelope?.result);
  if (!Array.isArray(result?.content)) throw invalidSearchResponse();
  return result.content.flatMap((item) => {
    const block = asRecord(item);
    return block?.type === "text" && typeof block.text === "string" ? [block.text] : [];
  });
}

function parseSearchBlock(block: string): DocsSearchResult | undefined {
  const match = /^Title:\s*([^\r\n]+)\r?\nLink:\s*([^\r\n]+)\r?\nContent:\s*([\s\S]*)$/u.exec(
    block.trim(),
  );
  if (!match) return undefined;
  const title = match[1]!.trim();
  const url = match[2]!.trim();
  const excerpt = match[3]!.trim();
  return title && url && excerpt ? { title, url, excerpt } : undefined;
}

function invalidSearchResponse(): DocsError {
  return new DocsError("bad_response", "The documentation search response was invalid.");
}

function parseAnswer(markdown: string): DocsAskResponse {
  const heading = /^# Sources:\s*$/gmu;
  const matches = [...markdown.matchAll(heading)];
  const last = matches.at(-1);
  if (last?.index === undefined) return { answer: markdown.trimEnd(), sources: [] };
  const answer = markdown.slice(0, last.index).trimEnd();
  const sourceText = markdown.slice(last.index + last[0].length).trim();
  const sources = sourceText.split(/\r?\n/u).flatMap((line) => {
    const linked = /^\s*(?:[-*]|\d+\.)\s+\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)\s*$/u.exec(line);
    if (linked) return [{ title: linked[1]!.trim(), url: linked[2]! }];
    const bare = /^\s*(?:[-*]|\d+\.)\s+(https?:\/\/\S+)\s*$/u.exec(line);
    if (!bare) return [];
    return [{ title: bare[1]!, url: bare[1]! }];
  });
  return { answer, sources };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
