import { getAddress, type Address, type Hex } from "viem";

import type { X402NetworkConfig } from "./x402-networks.js";

export const SIGN_IN_WITH_X = "sign-in-with-x";

const MAX_CHALLENGE_BYTES = 1_048_576;
const MAX_STRING_LENGTH = 16_384;
const MAX_RESOURCES = 64;

export type SIWxSignatureType = "eip191";

export type SIWxExtensionInfo = Readonly<{
  domain: string;
  uri: string;
  statement?: string;
  version: "1";
  nonce: string;
  issuedAt: string;
  expirationTime?: string;
  notBefore?: string;
  requestId?: string;
  resources?: readonly string[];
}>;

export type SIWxSupportedChain = Readonly<{
  chainId: `eip155:${number}`;
  type: SIWxSignatureType;
  signatureScheme?: "eip191" | "eip1271" | "eip6492";
}>;

export type SIWxChallenge = Readonly<{
  info: SIWxExtensionInfo;
  chain: SIWxSupportedChain;
}>;

export type SIWxPayload = SIWxExtensionInfo &
  Readonly<{
    address: Address;
    chainId: `eip155:${number}`;
    type: SIWxSignatureType;
    signatureScheme?: SIWxSupportedChain["signatureScheme"];
    signature: Hex;
  }>;

export type SIWxSigner = Readonly<{
  address: Address;
  signMessage(args: { message: string }): Promise<Hex>;
}>;

export class SIWxError extends Error {
  constructor(
    public readonly code: "invalid_challenge" | "unsupported_challenge" | "origin_mismatch",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "SIWxError";
  }
}

/**
 * Reads an EVM Sign-In-With-X extension and binds it to the URL which returned the 402.
 * A missing SIWX extension returns null so normal x402 payment parsing can continue.
 */
export function parseSIWxChallenge(
  paymentRequired: unknown,
  configuredNetworks: X402NetworkConfig,
  responseUrl: string | URL,
  requiredNetwork?: string,
): SIWxChallenge | null {
  if (!isRecord(paymentRequired)) {
    throw invalidChallenge("x402 SIWX challenge must be a JSON object.");
  }
  if (paymentRequired.x402Version !== undefined && paymentRequired.x402Version !== 2) {
    throw new SIWxError(
      "unsupported_challenge",
      `Unsupported x402 version: ${String(paymentRequired.x402Version)}.`,
    );
  }
  if (!isRecord(paymentRequired.extensions)) return null;
  const extension = paymentRequired.extensions[SIGN_IN_WITH_X];
  if (extension === undefined) return null;
  if (!isRecord(extension)) {
    throw invalidChallenge("x402 SIWX extension must be an object.");
  }

  const info = parseInfo(extension.info);
  assertSIWxChallengeBoundToOrigin(info, responseUrl);
  if (!Array.isArray(extension.supportedChains) || extension.supportedChains.length === 0) {
    throw invalidChallenge("x402 SIWX extension has no supportedChains array.");
  }
  if (extension.supportedChains.length > MAX_RESOURCES) {
    throw invalidChallenge("x402 SIWX extension has too many supported chains.");
  }

  const chain = extension.supportedChains
    .map(parseSupportedChain)
    .find((candidate): candidate is SIWxSupportedChain => {
      if (!candidate || (requiredNetwork && candidate.chainId !== requiredNetwork)) return false;
      const configured = configuredNetworks[candidate.chainId];
      return Boolean(configured && configured.enabled !== false);
    });
  if (!chain) {
    const requirement = requiredNetwork
      ? `required network ${requiredNetwork}`
      : "a configured EVM network";
    throw new SIWxError("unsupported_challenge", `No x402 SIWX chain matches ${requirement}.`);
  }
  return { info, chain };
}

/** Reads a PAYMENT-REQUIRED header or bounded JSON response body for a SIWX extension. */
export async function parseSIWxResponse(
  response: Response,
  configuredNetworks: X402NetworkConfig,
  responseUrl: string | URL = response.url,
  requiredNetwork?: string,
): Promise<SIWxChallenge | null> {
  const header = response.headers.get("payment-required");
  let headerError: unknown;
  if (header) {
    try {
      return parseSIWxChallenge(
        decodeBase64Json(header),
        configuredNetworks,
        responseUrl,
        requiredNetwork,
      );
    } catch (error) {
      headerError = error;
    }
  }
  try {
    return parseSIWxChallenge(
      await readBoundedJson(response),
      configuredNetworks,
      responseUrl,
      requiredNetwork,
    );
  } catch (error) {
    if (headerError instanceof SIWxError) throw headerError;
    if (error instanceof SIWxError) throw error;
    throw invalidChallenge(
      "x402 402 response has neither a valid payment-required header nor a JSON SIWX body.",
      error,
    );
  }
}

/** Formats the canonical EIP-4361 message used by the official SIWX extension. */
export function createSIWxMessage(challenge: SIWxChallenge, address: Address): string {
  const { info, chain } = challenge;
  const chainId = parseEip155ChainId(chain.chainId);
  const lines = [
    `${info.domain} wants you to sign in with your Ethereum account:`,
    getAddress(address),
    "",
    info.statement ?? "",
    "",
    `URI: ${info.uri}`,
    `Version: ${info.version}`,
    `Chain ID: ${chainId}`,
    `Nonce: ${info.nonce}`,
    `Issued At: ${info.issuedAt}`,
  ];
  if (info.expirationTime) lines.push(`Expiration Time: ${info.expirationTime}`);
  if (info.notBefore) lines.push(`Not Before: ${info.notBefore}`);
  if (info.requestId) lines.push(`Request ID: ${info.requestId}`);
  if (info.resources?.length) {
    lines.push("Resources:", ...info.resources.map((resource) => `- ${resource}`));
  }
  return lines.join("\n");
}

/** Validates origin binding again immediately before requesting a personal signature. */
export async function buildSIWxProof(args: {
  signer: SIWxSigner;
  challenge: SIWxChallenge;
  responseUrl: string | URL;
}): Promise<{
  payload: SIWxPayload;
  headers: Readonly<{ "SIGN-IN-WITH-X": string }>;
}> {
  assertSIWxChallengeBoundToOrigin(args.challenge.info, args.responseUrl);
  const address = getAddress(args.signer.address);
  const signature = await args.signer.signMessage({
    message: createSIWxMessage(args.challenge, address),
  });
  if (!/^0x[0-9a-fA-F]+$/.test(signature)) {
    throw new Error("SIWX signer returned a non-hex EVM signature.");
  }
  const payload: SIWxPayload = {
    ...args.challenge.info,
    address,
    chainId: args.challenge.chain.chainId,
    type: args.challenge.chain.type,
    ...(args.challenge.chain.signatureScheme
      ? { signatureScheme: args.challenge.chain.signatureScheme }
      : {}),
    signature,
  };
  return {
    payload,
    headers: { "SIGN-IN-WITH-X": encodeBase64Json(payload) },
  };
}

export function assertSIWxChallengeBoundToOrigin(
  info: Pick<SIWxExtensionInfo, "domain" | "uri">,
  responseUrl: string | URL,
): void {
  let resource: URL;
  try {
    resource = typeof responseUrl === "string" ? new URL(responseUrl) : responseUrl;
  } catch (error) {
    throw invalidChallenge("SIWX response URL is invalid.", error);
  }
  if (info.domain !== resource.host) {
    throw new SIWxError(
      "origin_mismatch",
      `SIWX challenge domain ${JSON.stringify(info.domain)} does not match resource host ${JSON.stringify(resource.host)}. Refusing to sign.`,
    );
  }
  let uri: URL;
  try {
    uri = new URL(info.uri);
  } catch (error) {
    throw invalidChallenge(`SIWX challenge uri ${JSON.stringify(info.uri)} is invalid.`, error);
  }
  if (uri.origin !== resource.origin) {
    throw new SIWxError(
      "origin_mismatch",
      `SIWX challenge uri origin ${JSON.stringify(uri.origin)} does not match resource origin ${JSON.stringify(resource.origin)}. Refusing to sign.`,
    );
  }
}

function parseInfo(value: unknown): SIWxExtensionInfo {
  if (!isRecord(value)) throw invalidChallenge("x402 SIWX extension has no info object.");
  const domain = readRequiredString(value, "domain", 255);
  const uri = readRequiredString(value, "uri");
  const version = readRequiredString(value, "version", 16);
  const nonce = readRequiredString(value, "nonce", 256);
  const issuedAt = readRequiredString(value, "issuedAt", 128);
  if (version !== "1") {
    throw new SIWxError("unsupported_challenge", `Unsupported SIWX version: ${version}.`);
  }
  if (!/^[a-zA-Z0-9]{8,}$/.test(nonce)) {
    throw invalidChallenge("x402 SIWX nonce must contain at least 8 alphanumeric characters.");
  }
  assertDateTime(issuedAt, "issuedAt");
  const statement = readOptionalString(value, "statement");
  const expirationTime = readOptionalString(value, "expirationTime", 128);
  const notBefore = readOptionalString(value, "notBefore", 128);
  const requestId = readOptionalString(value, "requestId");
  for (const [field, candidate] of [
    ["uri", uri],
    ["statement", statement],
    ["requestId", requestId],
  ] as const) {
    if (candidate && /[\r\n]/.test(candidate)) {
      throw invalidChallenge(`x402 SIWX info.${field} must not contain line breaks.`);
    }
  }
  if (expirationTime) assertDateTime(expirationTime, "expirationTime");
  if (notBefore) assertDateTime(notBefore, "notBefore");

  let resources: string[] | undefined;
  if (value.resources !== undefined) {
    if (!Array.isArray(value.resources) || value.resources.length > MAX_RESOURCES) {
      throw invalidChallenge("x402 SIWX resources must be a bounded array of URIs.");
    }
    resources = value.resources.map((resource) => {
      if (
        typeof resource !== "string" ||
        resource.length === 0 ||
        resource.length > MAX_STRING_LENGTH
      ) {
        throw invalidChallenge("x402 SIWX resource URI is invalid or too long.");
      }
      try {
        new URL(resource);
        return resource;
      } catch (error) {
        throw invalidChallenge(
          `x402 SIWX resource URI ${JSON.stringify(resource)} is invalid.`,
          error,
        );
      }
    });
  }
  return {
    domain,
    uri,
    version: "1",
    nonce,
    issuedAt,
    ...(statement ? { statement } : {}),
    ...(expirationTime ? { expirationTime } : {}),
    ...(notBefore ? { notBefore } : {}),
    ...(requestId ? { requestId } : {}),
    ...(resources ? { resources } : {}),
  };
}

function parseSupportedChain(value: unknown): SIWxSupportedChain | null {
  if (!isRecord(value)) return null;
  const chainId = typeof value.chainId === "string" ? value.chainId : "";
  if (value.type !== "eip191" || !isEip155ChainId(chainId)) return null;
  const signatureScheme = value.signatureScheme;
  if (
    signatureScheme !== undefined &&
    signatureScheme !== "eip191" &&
    signatureScheme !== "eip1271" &&
    signatureScheme !== "eip6492"
  ) {
    return null;
  }
  return {
    chainId,
    type: "eip191",
    ...(signatureScheme ? { signatureScheme } : {}),
  };
}

function isEip155ChainId(value: string): value is `eip155:${number}` {
  try {
    parseEip155ChainId(value);
    return true;
  } catch {
    return false;
  }
}

function parseEip155ChainId(value: string): string {
  const match = /^eip155:(\d+)$/.exec(value);
  if (!match) throw new Error(`Invalid EIP-155 chain identifier: ${value}.`);
  const chainId = BigInt(match[1]!);
  if (chainId <= 0n) throw new Error(`Invalid EIP-155 chain identifier: ${value}.`);
  return chainId.toString();
}

function assertDateTime(value: string, field: string): void {
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw invalidChallenge(`x402 SIWX ${field} must be an ISO 8601 timestamp.`);
  }
}

function readRequiredString(
  value: Record<string, unknown>,
  field: string,
  maximumLength = MAX_STRING_LENGTH,
): string {
  const result = readOptionalString(value, field, maximumLength);
  if (!result) throw invalidChallenge(`x402 SIWX info.${field} is required.`);
  return result;
}

function readOptionalString(
  value: Record<string, unknown>,
  field: string,
  maximumLength = MAX_STRING_LENGTH,
): string | undefined {
  const candidate = value[field];
  if (candidate === undefined) return undefined;
  if (typeof candidate !== "string" || candidate.length === 0 || candidate.length > maximumLength) {
    throw invalidChallenge(`x402 SIWX info.${field} is invalid or too long.`);
  }
  return candidate;
}

async function readBoundedJson(response: Response): Promise<unknown> {
  if (!response.body) throw new Error("x402 SIWX response body is empty.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    total += next.value.byteLength;
    if (total > MAX_CHALLENGE_BYTES) {
      await reader.cancel();
      throw new Error(`x402 SIWX response exceeds ${MAX_CHALLENGE_BYTES} bytes.`);
    }
    chunks.push(next.value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}

function decodeBase64Json(value: string): unknown {
  try {
    if (value.length > Math.ceil((MAX_CHALLENGE_BYTES * 4) / 3) + 4) {
      throw new Error("encoded challenge exceeds the size limit");
    }
    const bytes = Uint8Array.from(globalThis.atob(value), (character) => character.charCodeAt(0));
    if (bytes.byteLength > MAX_CHALLENGE_BYTES) {
      throw new Error("decoded challenge exceeds the size limit");
    }
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch (error) {
    throw invalidChallenge("x402 SIWX payment-required header is not valid base64 JSON.", error);
  }
}

function encodeBase64Json(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return globalThis.btoa(binary);
}

function invalidChallenge(message: string, cause?: unknown): SIWxError {
  return new SIWxError("invalid_challenge", message, cause === undefined ? undefined : { cause });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
