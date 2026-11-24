import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpRequest, type IncomingMessage, type RequestOptions } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { Readable } from "node:stream";

export type LookupFn = (hostname: string) => Promise<string[]>;

const defaultLookup: LookupFn = async (hostname) => {
  const addresses = await dnsLookup(hostname, { all: true });
  return addresses.map(({ address }) => address);
};

export async function assertPublicUrl(
  url: URL,
  options: { allowPrivateNetwork: boolean; lookup?: LookupFn; timeoutMs?: number },
): Promise<void> {
  if (url.username || url.password) {
    throw guardError(url);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw guardError(url);
  }
  if (options.allowPrivateNetwork) {
    return;
  }

  const hostname = normalizeHostname(url.hostname);
  const lowercaseHostname = hostname.toLowerCase();
  if (
    !lowercaseHostname ||
    lowercaseHostname === "localhost" ||
    lowercaseHostname.endsWith(".localhost") ||
    lowercaseHostname.endsWith(".local") ||
    lowercaseHostname.endsWith(".internal")
  ) {
    throw guardError(url);
  }

  if (isIP(hostname)) {
    if (isNonPublicAddress(hostname)) {
      throw guardError(url);
    }
    return;
  }

  let addresses: string[];
  try {
    addresses = await withTimeout(
      (options.lookup ?? defaultLookup)(hostname),
      options.timeoutMs ?? 5_000,
    );
  } catch {
    throw guardError(url, "unresolved");
  }
  if (addresses.length === 0 || addresses.some(isNonPublicAddress)) {
    throw guardError(url);
  }
}

export function createPublicFetch(options: {
  allowPrivateNetwork: boolean;
  lookup?: LookupFn;
}): typeof fetch {
  const lookupFn = options.lookup ?? defaultLookup;
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    await assertPublicUrl(url, {
      allowPrivateNetwork: options.allowPrivateNetwork,
      lookup: lookupFn,
      timeoutMs: 5_000,
    });
    const normalized = new Request(input, init);
    const bytes = normalized.body ? Buffer.from(await normalized.arrayBuffer()) : null;
    return await new Promise<Response>((resolve, reject) => {
      const requestOptions: RequestOptions = {
        method: normalized.method,
        headers: Object.fromEntries(normalized.headers),
        signal: normalized.signal,
        ...(options.allowPrivateNetwork ? {} : { lookup: pinnedLookup(lookupFn) }),
      };
      const onResponse = (incoming: IncomingMessage) => {
        try {
          const headers = new Headers();
          for (const [name, value] of Object.entries(incoming.headers)) {
            if (Array.isArray(value)) {
              for (const item of value) headers.append(name, item);
            } else if (value !== undefined) {
              headers.set(name, value);
            }
          }
          const status = incoming.statusCode ?? 500;
          const bodyForbidden = normalized.method === "HEAD" || [204, 205, 304].includes(status);
          if (bodyForbidden) incoming.resume();
          const response = new Response(
            bodyForbidden ? null : (Readable.toWeb(incoming) as ReadableStream<Uint8Array>),
            { status, statusText: incoming.statusMessage, headers },
          );
          Object.defineProperty(response, "url", { value: url.toString() });
          resolve(response);
        } catch (error) {
          incoming.destroy();
          reject(error);
        }
      };
      const request =
        url.protocol === "https:"
          ? httpsRequest(url, requestOptions, onResponse)
          : httpRequest(url, requestOptions, onResponse);
      request.on("error", reject);
      if (bytes) request.write(bytes);
      request.end();
    });
  }) as typeof fetch;
}

export function pinnedLookup(lookup: LookupFn): LookupFunction {
  return (hostname, dnsOptions, callback) => {
    void lookup(normalizeHostname(hostname))
      .then((addresses) => {
        if (addresses.length === 0 || addresses.some(isNonPublicAddress)) {
          callback(guardError(new URL(`https://${hostname}`)), "");
          return;
        }
        const address = addresses[0]!;
        const family = isIP(address);
        callback(
          null,
          dnsOptions.all ? [{ address, family }] : address,
          dnsOptions.all ? undefined : family,
        );
      })
      .catch((error: unknown) =>
        callback(error instanceof Error ? error : new Error("DNS lookup failed."), ""),
      );
  };
}

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("DNS lookup timed out.")), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function normalizeHostname(hostname: string): string {
  const unbracketed =
    hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  return unbracketed.endsWith(".") ? unbracketed.slice(0, -1) : unbracketed;
}

function isNonPublicAddress(address: string): boolean {
  const normalized = normalizeHostname(address);
  const version = isIP(normalized);
  if (version === 4) {
    return isNonPublicIpv4(parseIpv4(normalized));
  }
  if (version === 6) {
    return isNonPublicIpv6(parseIpv6(normalized));
  }
  return true;
}

function parseIpv4(address: string): [number, number, number, number] {
  const octets = address.split(".").map(Number);
  return [octets[0]!, octets[1]!, octets[2]!, octets[3]!];
}

function isNonPublicIpv4([first, second, third]: [number, number, number, number]): boolean {
  return (
    first === 0 ||
    first === 10 ||
    (first === 100 && second >= 64 && second <= 127) ||
    first === 127 ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 0 && (third === 0 || third === 2)) ||
    (first === 192 && second === 168) ||
    (first === 198 && second >= 18 && second <= 19) ||
    (first === 198 && second === 51 && third === 100) ||
    (first === 203 && second === 0 && third === 113) ||
    first >= 224
  );
}

function parseIpv6(address: string): number[] {
  let normalized = address.toLowerCase();
  const lastColon = normalized.lastIndexOf(":");
  const dottedTail = normalized.slice(lastColon + 1);
  if (dottedTail.includes(".")) {
    const [first, second, third, fourth] = parseIpv4(dottedTail);
    normalized = `${normalized.slice(0, lastColon + 1)}${((first << 8) | second).toString(16)}:${(
      (third << 8) |
      fourth
    ).toString(16)}`;
  }

  const halves = normalized.split("::");
  const left = halves[0] ? halves[0].split(":").map(parseHex) : [];
  const right = halves[1] ? halves[1].split(":").map(parseHex) : [];
  const omittedCount = 8 - left.length - right.length;
  return halves.length === 2
    ? [...left, ...Array.from({ length: omittedCount }, () => 0), ...right]
    : left;
}

function parseHex(value: string): number {
  return Number.parseInt(value, 16);
}

function isNonPublicIpv6(hextets: number[]): boolean {
  if (hextets.slice(0, 5).every((hextet) => hextet === 0) && hextets[5] === 0xffff) {
    const embeddedIpv4: [number, number, number, number] = [
      hextets[6]! >> 8,
      hextets[6]! & 0xff,
      hextets[7]! >> 8,
      hextets[7]! & 0xff,
    ];
    return isNonPublicIpv4(embeddedIpv4);
  }

  if (hextets.slice(0, 6).every((hextet) => hextet === 0)) {
    const compatibleIpv4: [number, number, number, number] = [
      hextets[6]! >> 8,
      hextets[6]! & 0xff,
      hextets[7]! >> 8,
      hextets[7]! & 0xff,
    ];
    if (isNonPublicIpv4(compatibleIpv4)) return true;
  }

  const isUnspecified = hextets.every((hextet) => hextet === 0);
  const isLoopback = hextets.slice(0, 7).every((hextet) => hextet === 0) && hextets[7] === 1;
  const first = hextets[0]!;
  const isUniqueLocal = first >= 0xfc00 && first <= 0xfdff;
  const isLinkLocal = first >= 0xfe80 && first <= 0xfebf;
  const isSiteLocal = first >= 0xfec0 && first <= 0xfeff;
  const isMulticast = first >= 0xff00;
  const isDocumentation = first === 0x2001 && hextets[1] === 0x0db8;
  return (
    isUnspecified ||
    isLoopback ||
    isUniqueLocal ||
    isLinkLocal ||
    isSiteLocal ||
    isMulticast ||
    isDocumentation
  );
}

/**
 * A request the guard refused before connecting. `reason` is `unresolved` when
 * the hostname's DNS lookup failed or timed out, and `blocked` otherwise.
 */
export class NetworkGuardError extends Error {
  constructor(
    message: string,
    readonly reason: "blocked" | "unresolved",
  ) {
    super(message);
    this.name = "NetworkGuardError";
  }
}

function guardError(url: URL, reason: "blocked" | "unresolved" = "blocked"): NetworkGuardError {
  return new NetworkGuardError(
    `URL hostname ${JSON.stringify(url.hostname)} is not allowed; private or internal destinations require allowPrivateNetwork true in the vAPI config.`,
    reason,
  );
}

// The variables Node.js reads for each protocol under NODE_USE_ENV_PROXY=1; it has no ALL_PROXY.
const PROXY_VARIABLES: Readonly<Record<string, readonly string[]>> = {
  "https:": ["HTTPS_PROXY", "https_proxy"],
  "http:": ["HTTP_PROXY", "http_proxy"],
};
const SYSTEM_ERROR_CODE = /^[A-Z][A-Z0-9_]{1,39}$/u;

/**
 * Says why a request to `url` never got an answer, in words that are safe to
 * print: the host, and a Node system error code such as `ECONNREFUSED`, never
 * the error's own message. When the proxy variable for the URL's protocol is
 * set it adds how Node.js treats it: the proxy is used only with
 * `NODE_USE_ENV_PROXY=1`, and the host must still resolve on this machine
 * because the guard looks it up first.
 */
export function describeNetworkFailure(
  error: unknown,
  url: URL,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const host = url.host;
  let reason: string;
  const guard = guardReason(error);
  if (guard !== undefined) {
    reason =
      guard === "unresolved"
        ? `the DNS lookup for ${host} failed`
        : `${host} is not a public address`;
  } else if (isTimeout(error)) {
    reason = `the connection to ${host} timed out`;
  } else {
    const code = systemErrorCode(error);
    reason = `could not connect to ${host}${code === undefined ? "" : ` (${code})`}`;
  }
  const proxy = (PROXY_VARIABLES[url.protocol] ?? []).find(
    (name) => (env[name] ?? "").trim() !== "",
  );
  let hint = "";
  if (proxy !== undefined) {
    if (env.NODE_USE_ENV_PROXY !== "1") {
      hint = ` ${proxy} is set, but Node.js uses it only with NODE_USE_ENV_PROXY=1 (Node.js 22.21 or later): run the command again with NODE_USE_ENV_PROXY=1.`;
    } else if (guard === "unresolved") {
      hint = ` vapi looks ${host} up on this machine before it uses the proxy in ${proxy}, so the name must resolve here too.`;
    } else if (guard === undefined) {
      hint = ` NODE_USE_ENV_PROXY=1 and ${proxy} are set, so the proxy may have refused the connection.`;
    }
  }
  return `${reason}.${hint}`;
}

/**
 * The guard's reason for a refused request. Read by name, not `instanceof`:
 * the package's entry points are bundled separately, so a guard error from one
 * is not an instance of the class in another.
 */
function guardReason(error: unknown): "blocked" | "unresolved" | undefined {
  if (!(error instanceof Error) || error.name !== "NetworkGuardError") return undefined;
  const reason = (error as { reason?: unknown }).reason;
  return reason === "blocked" || reason === "unresolved" ? reason : undefined;
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
}

function systemErrorCode(error: unknown): string | undefined {
  for (let current = error, depth = 0; current instanceof Error && depth < 3; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && SYSTEM_ERROR_CODE.test(code)) return code;
    current = current.cause;
  }
  return undefined;
}
