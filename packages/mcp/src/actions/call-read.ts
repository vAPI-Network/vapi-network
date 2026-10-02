import {
  assertPublicUrl,
  createPublicFetch,
  decodePaymentRequiredHeader,
  discardBody,
  type LookupFn,
  type VapiConfig,
  type VapiPaymentAccount,
} from "@vapi-network/core";
import { z } from "zod";

import { buildSIWxProof, parseSIWxResponse } from "../siwx.js";
import { defineAction } from "./define.js";

const MAX_RESPONSE_BYTES = 1_048_576;
const MAX_REDIRECTS = 3;

export const callReadInputSchema = z.object({ url: z.string() });
export const callReadOutputSchema = z.object({
  status: z.number().int(),
  contentType: z.string().nullable(),
  body: z.unknown(),
});

export type CallReadInput = z.infer<typeof callReadInputSchema>;
export type CallReadOutput = z.infer<typeof callReadOutputSchema>;

export const callRead = defineAction<CallReadInput, CallReadOutput>({
  name: "call.read",
  description:
    "Read an HTTPS URL from an origin this agent paid during the current run. This GET-only action can sign in with SIWX, but it never pays.",
  input: callReadInputSchema,
  output: callReadOutputSchema,
  money: "none",
  grant: "read",
  async run(input, ctx) {
    if (ctx.caller.run === undefined) {
      throw new Error("call.read only works inside an agent run");
    }
    if (ctx.call.read === undefined) {
      throw new Error("call.read is not available in this run");
    }
    return await ctx.call.read(input);
  },
});

export async function readPaidOrigin(args: {
  url: string;
  paidOrigins: ReadonlySet<string>;
  account: VapiPaymentAccount;
  config: VapiConfig;
  fetchImpl?: typeof fetch;
  lookup?: LookupFn;
  timeoutMs?: number;
}): Promise<CallReadOutput> {
  const timeoutMs = args.timeoutMs ?? 30_000;
  return await withReadTimeout(timeoutMs, async (signal) => {
    const initialUrl = parseReadUrl(args.url);
    if (!args.paidOrigins.has(initialUrl.origin)) {
      throw new Error("call.read only reads origins this agent paid in this run");
    }
    const paidOrigin = initialUrl.origin;
    const allowPrivateNetwork = args.config.allowPrivateNetwork ?? false;
    const fetchImpl =
      args.fetchImpl ??
      createPublicFetch({
        allowPrivateNetwork,
        lookup: args.lookup,
      });

    const fetchWithRedirects = async (
      startUrl: URL,
      headers: Headers,
    ): Promise<{ response: Response; responseUrl: URL }> => {
      let currentUrl = startUrl;
      let followedRedirects = 0;

      while (true) {
        await assertReadableUrl(currentUrl, paidOrigin, {
          allowPrivateNetwork,
          lookup: args.lookup,
          timeoutMs: Math.min(timeoutMs, 5_000),
        });
        const response = await fetchImpl(
          new Request(currentUrl, {
            method: "GET",
            headers,
            redirect: "manual",
            signal,
          }),
        );
        if (signal.aborted) {
          discardBody(response);
          signal.throwIfAborted();
        }
        if (!isRedirectStatus(response.status)) return { response, responseUrl: currentUrl };

        const location = response.headers.get("location");
        if (location === null) return { response, responseUrl: currentUrl };
        discardBody(response);
        if (followedRedirects >= MAX_REDIRECTS) {
          throw new Error(`call.read exceeded the maximum of ${MAX_REDIRECTS} HTTP redirect hops`);
        }
        currentUrl = parseReadUrl(location, currentUrl);
        followedRedirects += 1;
      }
    };

    const headers = new Headers({ accept: "application/json" });
    const initial = await fetchWithRedirects(initialUrl, headers);
    if (initial.response.status !== 402) return await readResult(initial.response, signal);

    if (await hasNonzeroPaymentOffer(initial.response, signal)) {
      discardBody(initial.response);
      throw new Error("call.read never pays");
    }
    const challenge = await parseSIWxResponse(
      initial.response.clone(),
      args.config.networks,
      initial.responseUrl.href,
    );
    if (challenge === null) {
      discardBody(initial.response);
      throw new Error("call.read never pays");
    }

    const proof = await buildSIWxProof({
      signer: args.account,
      challenge,
      responseUrl: initial.responseUrl.href,
    });
    discardBody(initial.response);
    const signedHeaders = new Headers(headers);
    for (const [name, value] of Object.entries(proof.headers)) signedHeaders.set(name, value);
    const proofSecrets = [proof.headers["SIGN-IN-WITH-X"], proof.payload.signature];

    try {
      const signed = await fetchWithRedirects(initial.responseUrl, signedHeaders);
      if (signed.response.status === 402) {
        discardBody(signed.response);
        throw new Error("call.read never pays");
      }
      return await readResult(signed.response, signal, proofSecrets);
    } catch (error) {
      throw sanitizeThrownError(error, proofSecrets);
    }
  });
}

function parseReadUrl(value: string, base?: URL): URL {
  try {
    return base === undefined ? new URL(value) : new URL(value, base);
  } catch {
    throw new Error("call.read requires a valid URL");
  }
}

async function assertReadableUrl(
  url: URL,
  paidOrigin: string,
  network: { allowPrivateNetwork: boolean; lookup?: LookupFn; timeoutMs: number },
): Promise<void> {
  if (url.protocol !== "https:") {
    throw new Error("call.read only reads HTTPS URLs");
  }
  if (url.origin !== paidOrigin) {
    throw new Error("call.read never leaves its initial paid origin");
  }
  await assertPublicUrl(url, network);
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

async function readResult(
  response: Response,
  signal: AbortSignal,
  secrets: readonly string[] = [],
): Promise<CallReadOutput> {
  const contentType = response.headers.get("content-type");
  return {
    status: response.status,
    contentType: contentType === null ? null : redactKnownSecrets(contentType, secrets),
    body: sanitizeReturnedValue(await readResponseBody(response, contentType, signal), secrets),
  };
}

async function readResponseBody(
  response: Response,
  contentType: string | null,
  signal: AbortSignal,
): Promise<unknown> {
  const length = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) {
    discardBody(response);
    throw new Error(`API response exceeds the ${MAX_RESPONSE_BYTES}-byte display limit.`);
  }
  if (response.body === null) return null;

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const cancel = () => void reader.cancel(signal.reason).catch(() => undefined);
  signal.addEventListener("abort", cancel, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const next = await reader.read();
      signal.throwIfAborted();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error(`API response exceeds the ${MAX_RESPONSE_BYTES}-byte display limit.`);
      }
      chunks.push(next.value);
    }
  } finally {
    signal.removeEventListener("abort", cancel);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder().decode(bytes);
  if (text.length === 0) return null;
  return isJsonContentType(contentType) ? (JSON.parse(text) as unknown) : text;
}

function isJsonContentType(value: string | null): boolean {
  const mediaType = value?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return mediaType === "application/json" || mediaType.endsWith("+json");
}

function sanitizeReturnedValue(value: unknown, secrets: readonly string[], depth = 0): unknown {
  if (typeof value === "string") return redactKnownSecrets(value, secrets);
  if (value === null || typeof value !== "object") return value;
  if (depth >= 16) return "[redacted nested response value]";
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeReturnedValue(item, secrets, depth + 1));
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      redactKnownSecrets(key, secrets),
      sanitizeReturnedValue(item, secrets, depth + 1),
    ]),
  );
}

function sanitizeThrownError(error: unknown, secrets: readonly string[]): unknown {
  if (!(error instanceof Error)) return error;
  const message = redactKnownSecrets(error.message, secrets);
  const cause =
    error.cause instanceof Error
      ? sanitizeThrownError(error.cause, secrets)
      : typeof error.cause === "string"
        ? redactKnownSecrets(error.cause, secrets)
        : error.cause;
  if (message === error.message && cause === error.cause) return error;
  const sanitized = new Error(message, cause === undefined ? undefined : { cause });
  sanitized.name = error.name;
  return sanitized;
}

function redactKnownSecrets(value: string, secrets: readonly string[]): string {
  let redacted = value;
  for (const secret of [...new Set(secrets)].sort((left, right) => right.length - left.length)) {
    if (secret) redacted = redacted.replaceAll(secret, "[redacted]");
  }
  return redacted;
}

async function hasNonzeroPaymentOffer(response: Response, signal: AbortSignal): Promise<boolean> {
  const encoded = response.headers.get("payment-required");
  if (encoded !== null) {
    try {
      if (containsNonzeroPrice(decodePaymentRequiredHeader(encoded))) return true;
    } catch {
      // SIWX parsing below reports malformed challenges with its established error.
    }
  }

  const contentType = response.headers.get("content-type");
  const body = await readResponseBody(response.clone(), contentType, signal);
  if (typeof body !== "string") return containsNonzeroPrice(body);
  try {
    return containsNonzeroPrice(JSON.parse(body) as unknown);
  } catch {
    return false;
  }
}

/** Fails closed: any payment option whose amount is not exactly zero counts as a price. */
function containsNonzeroPrice(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const accepts = Reflect.get(value, "accepts");
  if (!Array.isArray(accepts)) return false;
  return accepts.some((candidate) => {
    if (typeof candidate !== "object" || candidate === null) return true;
    // x402 v2 names it `amount`, v1 `maxAmountRequired`.
    const amount = Reflect.get(candidate, "amount") ?? Reflect.get(candidate, "maxAmountRequired");
    if (amount === 0 || amount === 0n) return false;
    if (typeof amount === "string" && /^0+$/.test(amount)) return false;
    return true;
  });
}

async function withReadTimeout<T>(
  timeoutMs: number,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("call.read timeoutMs must be a positive integer");
  }
  const controller = new AbortController();
  const timeoutError = new Error(`call.read timed out after ${timeoutMs} ms`);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(timeoutError);
      controller.abort(timeoutError);
    }, timeoutMs);
  });
  try {
    return await Promise.race([operation(controller.signal), timedOut]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
