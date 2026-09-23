import { createHash } from "node:crypto";
import { mkdir, open, stat, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { dirname } from "node:path";

import { createSiweMessage } from "viem/siwe";

import { appendAudit } from "./audit.js";
import { createPublicFetch } from "./net-guard.js";
import type { SecretStore } from "./secret-store.js";
import type { AgentLink, WalletName, WalletStore } from "./wallet-store.js";

export const AGENT_LINK_STATEMENT = "Link this wallet to a vAPI account as an agent.";

export type DeviceLinkStart = {
  clientId: string;
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresIn: number;
  interval: number;
};

export type AgentTokens = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scopes: string[];
};

export type LinkResult = {
  tokens: AgentTokens;
  owner: `0x${string}`;
  routerKey?: string;
  routerBaseUrl?: string;
  routerKeyError?: string;
};

export class AgentLinkError extends Error {
  constructor(
    readonly code:
      | "access_denied"
      | "expired_token"
      | "invalid_agent_signature"
      | "invalid_scope"
      | "not_linked"
      | "http",
    message: string,
  ) {
    super(message);
    this.name = "AgentLinkError";
  }
}

export const DEFAULT_AGENT_SCOPES = ["mcp:call", "router.use"] as const;

const ALLOWED_AGENT_SCOPES = new Set<string>([...DEFAULT_AGENT_SCOPES, "call.publish"]);
const publicFetch = createPublicFetch({ allowPrivateNetwork: false });

export async function startDeviceLink(args: {
  apiBase: string;
  account: {
    address: `0x${string}`;
    signMessage(a: { message: string }): Promise<`0x${string}`>;
  };
  label: string;
  scopes?: string[];
  routerAllowanceUsd?: number;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}): Promise<DeviceLinkStart> {
  const scopes = args.scopes ?? [...DEFAULT_AGENT_SCOPES];
  if (scopes.some((scope) => !ALLOWED_AGENT_SCOPES.has(scope))) {
    throw new AgentLinkError("invalid_scope", "The requested agent scope is not allowed.");
  }

  const fetchImpl = args.fetchImpl ?? publicFetch;
  const api = new URL(args.apiBase);
  const nonceResponse = await safeFetch(
    fetchImpl,
    apiEndpoint(args.apiBase, "/api/auth/siwe-nonce"),
  );
  if (!nonceResponse.ok) throw httpError("The vAPI sign-in nonce request failed.");
  const noncePayload = await responseRecord(nonceResponse);
  const nonce = stringField(noncePayload, "nonce");
  if (nonce === undefined) throw httpError("The vAPI sign-in nonce response was invalid.");

  const message = createSiweMessage({
    domain: api.host,
    address: args.account.address,
    statement: AGENT_LINK_STATEMENT,
    uri: api.origin,
    version: "1",
    chainId: 8453,
    nonce,
    issuedAt: args.now?.() ?? new Date(),
  });
  const signature = await args.account.signMessage({ message });
  const response = await safeFetch(
    fetchImpl,
    apiEndpoint(args.apiBase, "/oauth/device_authorization"),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agent_message: message,
        agent_signature: signature,
        label: args.label,
        scope: scopes.join(" "),
        ...(args.routerAllowanceUsd === undefined
          ? {}
          : { router_allowance_usd: args.routerAllowanceUsd }),
      }),
    },
  );
  const payload = await responseRecord(response);
  if (!response.ok) throw deviceAuthorizationError(response.status, payload);

  return {
    clientId: requiredString(payload, "client_id"),
    deviceCode: requiredString(payload, "device_code"),
    userCode: requiredString(payload, "user_code"),
    verificationUri: requiredString(payload, "verification_uri"),
    verificationUriComplete: requiredString(payload, "verification_uri_complete"),
    expiresIn: requiredNumber(payload, "expires_in"),
    interval: requiredNumber(payload, "interval"),
  };
}

export async function pollDeviceLink(args: {
  apiBase: string;
  start: DeviceLinkStart;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}): Promise<LinkResult> {
  const fetchImpl = args.fetchImpl ?? publicFetch;
  const sleep = args.sleep ?? sleepFor;
  const now = args.now ?? Date.now;
  const deadline = now() + args.start.expiresIn * 1_000;
  let interval = args.start.interval;

  while (now() < deadline) {
    await sleep(interval * 1_000);
    if (now() >= deadline) break;

    const body = new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: args.start.deviceCode,
      client_id: args.start.clientId,
    });
    const response = await safeFetch(fetchImpl, apiEndpoint(args.apiBase, "/oauth/token"), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    const payload = await responseRecord(response);

    if (response.ok) {
      const scope = requiredString(payload, "scope");
      const owner = requiredOwner(payload, "owner_wallet");
      return {
        tokens: {
          accessToken: requiredString(payload, "access_token"),
          refreshToken: requiredString(payload, "refresh_token"),
          expiresAt: now() + requiredNumber(payload, "expires_in") * 1_000,
          scopes: splitScopes(scope),
        },
        owner,
        ...optionalStringProperty(payload, "router_key", "routerKey"),
        ...optionalStringProperty(payload, "router_base_url", "routerBaseUrl"),
        ...optionalStringProperty(payload, "router_key_error", "routerKeyError"),
      };
    }

    const error = stringField(payload, "error");
    if (response.status === 400 && error === "authorization_pending") continue;
    if (response.status === 400 && error === "slow_down") {
      interval += 5;
      continue;
    }
    if (response.status === 400 && error === "access_denied") {
      throw new AgentLinkError("access_denied", "The owner denied the agent link.");
    }
    if (response.status === 400 && error === "expired_token") throw expiredLinkError();
    throw httpError("The vAPI agent link request failed.");
  }

  throw expiredLinkError();
}

export const agentSecretAccounts = (
  wallet: WalletName,
): { tokens: string; routerStake: string; routerBalance: string } => ({
  tokens: `vapi.agent.${wallet}.tokens`,
  routerStake: `vapi.agent.${wallet}.router.stake`,
  routerBalance: `vapi.agent.${wallet}.router.balance`,
});

/** Renames a linked wallet and its name-keyed credentials as one serialized operation. */
export async function renameAgentLinkWallet(args: {
  secrets: SecretStore;
  wallets: WalletStore;
  from: string;
  to: string;
}) {
  await args.wallets.reload();
  const current = args.wallets.resolve({ name: args.from });
  if (current.entry.link === undefined) return await args.wallets.rename(args.from, args.to);
  return await withAgentCredentialLock(
    args.wallets,
    current.entry.link.clientId,
    async () => await args.wallets.rename(args.from, args.to, { secrets: args.secrets }),
  );
}

export async function saveAgentLink(args: {
  secrets: SecretStore;
  wallets: WalletStore;
  wallet: WalletName;
  start: DeviceLinkStart;
  result: LinkResult;
  apiBase: string;
  label: string;
  home?: string;
}): Promise<AgentLink> {
  if (!args.secrets.available) {
    throw new Error(
      "No OS secret store is available on this machine, so the agent link cannot be stored safely. Nothing was saved.",
    );
  }

  const link: AgentLink = {
    apiBase: args.apiBase,
    clientId: args.start.clientId,
    owner: args.result.owner,
    label: args.label,
    scopes: [...args.result.tokens.scopes],
    linkedAt: new Date().toISOString(),
    ...(args.result.routerKey === undefined || args.result.routerBaseUrl === undefined
      ? {}
      : { routerBaseUrl: args.result.routerBaseUrl }),
  };

  await withAgentCredentialLock(args.wallets, args.start.clientId, async () => {
    await args.wallets.reload();
    const previousLink = args.wallets.entry(args.wallet)?.link;
    const accounts = agentSecretAccounts(args.wallet);
    const previousSecrets = await readSecretSnapshot(args.secrets, accounts);

    try {
      await safeSetSecret(args.secrets, accounts.tokens, JSON.stringify(args.result.tokens));
      await writeOptionalSecret(args.secrets, accounts.routerStake, args.result.routerKey);
      // Balance keys belong to the prior owner/link generation and are never returned here.
      await writeOptionalSecret(args.secrets, accounts.routerBalance, undefined);
      await args.wallets.setLink(args.wallet, link);
    } catch (error) {
      const secretsRestored = await restoreSecretSnapshot(args.secrets, accounts, previousSecrets);
      const metadataRestored = await restoreLinkMetadata(args.wallets, args.wallet, previousLink);
      if (!secretsRestored || !metadataRestored) {
        // A missing link is safer than metadata that can select the wrong owner's credentials.
        await args.wallets.clearLink(args.wallet).catch(() => undefined);
        throw httpError(
          "The agent link could not be stored consistently. Local link metadata was cleared; run vapi login again.",
        );
      }
      throw error;
    }
  });

  await appendAudit(args.home ?? args.wallets.home, {
    event: "agent.linked",
    wallet: args.wallet,
    owner: args.result.owner,
    tty: Boolean(process.stderr.isTTY),
  });
  return link;
}

export async function agentAccessToken(args: {
  secrets: SecretStore;
  wallets: WalletStore;
  wallet: WalletName;
  fetchImpl?: typeof fetch;
  now?: () => number;
}): Promise<string> {
  return await resolveAgentAccessToken(args, {});
}

export async function agentFetch(
  args: {
    secrets: SecretStore;
    wallets: WalletStore;
    wallet: WalletName;
    fetchImpl?: typeof fetch;
    now?: () => number;
  },
  url: string,
  init?: RequestInit,
): Promise<Response> {
  const fetchImpl = args.fetchImpl ?? publicFetch;
  const accessToken = await resolveAgentAccessToken(args, {});
  const response = await safeAgentFetch(fetchImpl, url, withBearer(init, accessToken));
  if (response.status !== 401) return response;

  const refreshedToken = await resolveAgentAccessToken(args, { rejectedAccessToken: accessToken });
  return await safeAgentFetch(fetchImpl, url, withBearer(init, refreshedToken));
}

export async function forgetAgentLink(args: {
  secrets: SecretStore;
  wallets: WalletStore;
  wallet: WalletName;
  fetchImpl?: typeof fetch;
  home?: string;
}): Promise<void> {
  const link = args.wallets.entry(args.wallet)?.link;
  const fetchImpl = args.fetchImpl ?? publicFetch;
  if (link !== undefined) {
    try {
      const accessToken = await resolveAgentAccessToken(args, {});
      await fetchImpl(apiEndpoint(link.apiBase, "/api/agents/self"), {
        method: "DELETE",
        headers: { authorization: `Bearer ${accessToken}` },
      });
    } catch {
      // Remote revocation is best effort. Local secrets must still be removed.
    }
  }

  if (args.secrets.available) {
    if (link !== undefined) {
      await removeSecretAccounts(args.secrets, agentSecretAccounts(args.wallet));
    }
  }
  if (args.wallets.entry(args.wallet) !== undefined) await args.wallets.clearLink(args.wallet);
  if (link !== undefined) {
    await appendAudit(args.home ?? args.wallets.home, {
      event: "agent.unlinked",
      wallet: args.wallet,
      owner: link.owner,
      tty: Boolean(process.stderr.isTTY),
    });
  }
}

async function resolveAgentAccessToken(
  args: {
    secrets: SecretStore;
    wallets: WalletStore;
    wallet: WalletName;
    fetchImpl?: typeof fetch;
    now?: () => number;
  },
  options: { rejectedAccessToken?: string },
): Promise<string> {
  await args.wallets.reload();
  const link = args.wallets.entry(args.wallet)?.link;
  if (link === undefined || !args.secrets.available) throw notLinkedError();
  const accounts = agentSecretAccounts(args.wallet);
  const tokens = parseTokens(await safeGetSecret(args.secrets, accounts.tokens));
  if (tokens === undefined) throw notLinkedError();
  const now = args.now ?? Date.now;
  if (options.rejectedAccessToken === undefined && tokens.expiresAt - 60_000 > now()) {
    return tokens.accessToken;
  }

  return await withAgentCredentialLock(args.wallets, link.clientId, async () => {
    await args.wallets.reload();
    const currentLink = args.wallets.entry(args.wallet)?.link;
    if (currentLink === undefined) throw notLinkedError();
    const currentAccounts = agentSecretAccounts(args.wallet);
    const current = parseTokens(await safeGetSecret(args.secrets, currentAccounts.tokens));
    if (current === undefined) throw notLinkedError();
    if (
      options.rejectedAccessToken !== undefined &&
      current.accessToken !== options.rejectedAccessToken
    ) {
      return current.accessToken;
    }
    if (options.rejectedAccessToken === undefined && current.expiresAt - 60_000 > now()) {
      return current.accessToken;
    }

    const response = await safeFetch(
      args.fetchImpl ?? publicFetch,
      apiEndpoint(currentLink.apiBase, "/oauth/token"),
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: current.refreshToken,
          client_id: currentLink.clientId,
        }),
      },
    );
    const payload = await responseRecord(response);
    if (!response.ok) {
      if (response.status === 400 && stringField(payload, "error") === "invalid_grant") {
        throw new AgentLinkError(
          "not_linked",
          "This agent's link was revoked or expired. Run vapi login again.",
        );
      }
      throw httpError("The vAPI agent token refresh failed.");
    }

    const refreshed: AgentTokens = {
      accessToken: requiredString(payload, "access_token"),
      refreshToken: stringField(payload, "refresh_token") ?? current.refreshToken,
      expiresAt: now() + requiredNumber(payload, "expires_in") * 1_000,
      scopes:
        stringField(payload, "scope") === undefined
          ? [...current.scopes]
          : splitScopes(requiredString(payload, "scope")),
    };
    await safeSetSecret(args.secrets, currentAccounts.tokens, JSON.stringify(refreshed));
    return refreshed.accessToken;
  });
}

type AgentSecretAccountSet = ReturnType<typeof agentSecretAccounts>;

type SecretSnapshot = {
  tokens?: string;
  routerStake?: string;
  routerBalance?: string;
};

async function readSecretSnapshot(
  secrets: SecretStore,
  accounts: AgentSecretAccountSet,
): Promise<SecretSnapshot> {
  const [tokens, routerStake, routerBalance] = await Promise.all([
    safeGetSecret(secrets, accounts.tokens),
    safeGetSecret(secrets, accounts.routerStake),
    safeGetSecret(secrets, accounts.routerBalance),
  ]);
  return {
    ...(tokens === undefined ? {} : { tokens }),
    ...(routerStake === undefined ? {} : { routerStake }),
    ...(routerBalance === undefined ? {} : { routerBalance }),
  };
}

async function restoreSecretSnapshot(
  secrets: SecretStore,
  accounts: AgentSecretAccountSet,
  snapshot: SecretSnapshot,
): Promise<boolean> {
  try {
    await writeOptionalSecret(secrets, accounts.tokens, snapshot.tokens);
    await writeOptionalSecret(secrets, accounts.routerStake, snapshot.routerStake);
    await writeOptionalSecret(secrets, accounts.routerBalance, snapshot.routerBalance);
    return true;
  } catch {
    return false;
  }
}

async function restoreLinkMetadata(
  wallets: WalletStore,
  wallet: WalletName,
  link: AgentLink | undefined,
): Promise<boolean> {
  try {
    if (link === undefined) await wallets.clearLink(wallet);
    else await wallets.setLink(wallet, link);
    return true;
  } catch {
    return false;
  }
}

async function writeOptionalSecret(
  secrets: SecretStore,
  account: string,
  value: string | undefined,
): Promise<void> {
  if (value === undefined) await safeRemoveSecret(secrets, account);
  else await safeSetSecret(secrets, account, value);
}

async function removeSecretAccounts(
  secrets: SecretStore,
  accounts: AgentSecretAccountSet,
): Promise<void> {
  await safeRemoveSecret(secrets, accounts.tokens);
  await safeRemoveSecret(secrets, accounts.routerStake);
  await safeRemoveSecret(secrets, accounts.routerBalance);
}

/** A rotating refresh token may be consumed only once, including across processes. */
async function withAgentCredentialLock<T>(
  wallets: WalletStore,
  clientId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const digest = createHash("sha256").update(clientId).digest("hex").slice(0, 24);
  const lockPath = `${wallets.registryPath}.${digest}.agent-link.lock`;
  await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + 30_000;
  let handle: FileHandle | undefined;

  while (!handle) {
    try {
      handle = await open(lockPath, "wx", 0o600);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      await removeStaleCredentialLock(lockPath);
      if (Date.now() >= deadline) {
        throw httpError("Timed out waiting to update the agent credentials.");
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  try {
    return await operation();
  } finally {
    await handle.close();
    await unlink(lockPath).catch(() => undefined);
  }
}

async function removeStaleCredentialLock(path: string): Promise<void> {
  try {
    const metadata = await stat(path);
    if (Date.now() - metadata.mtimeMs > 5 * 60_000) await unlink(path);
  } catch {
    // Another waiter may have removed it, or a transient stat failed. Retry the lock itself.
  }
}

async function safeGetSecret(secrets: SecretStore, account: string): Promise<string | undefined> {
  try {
    return await secrets.get(account);
  } catch {
    throw httpError("The agent tokens could not be read from the OS secret store.");
  }
}

async function safeSetSecret(secrets: SecretStore, account: string, value: string): Promise<void> {
  try {
    await secrets.set(account, value);
  } catch {
    throw httpError("The agent credentials could not be stored in the OS secret store.");
  }
}

async function safeRemoveSecret(secrets: SecretStore, account: string): Promise<void> {
  try {
    await secrets.remove(account);
  } catch {
    throw httpError("The agent credentials could not be removed from the OS secret store.");
  }
}

function parseTokens(value: string | undefined): AgentTokens | undefined {
  if (value === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  const accessToken = stringField(parsed, "accessToken");
  const refreshToken = stringField(parsed, "refreshToken");
  const expiresAt = numberField(parsed, "expiresAt");
  const scopes = parsed.scopes;
  if (
    accessToken === undefined ||
    refreshToken === undefined ||
    expiresAt === undefined ||
    !Array.isArray(scopes) ||
    scopes.some((scope) => typeof scope !== "string")
  ) {
    return undefined;
  }
  return { accessToken, refreshToken, expiresAt, scopes: scopes as string[] };
}

function withBearer(init: RequestInit | undefined, accessToken: string): RequestInit {
  const headers = new Headers(init?.headers);
  headers.set("authorization", `Bearer ${accessToken}`);
  return { ...init, headers };
}

async function safeFetch(
  fetchImpl: typeof fetch,
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  try {
    return await fetchImpl(input, init);
  } catch {
    throw httpError("The vAPI agent link request failed.");
  }
}

async function safeAgentFetch(
  fetchImpl: typeof fetch,
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  try {
    return await fetchImpl(input, init);
  } catch {
    throw httpError("The vAPI agent request failed.");
  }
}

function deviceAuthorizationError(
  status: number,
  payload: Record<string, unknown>,
): AgentLinkError {
  const error = stringField(payload, "error");
  if (status === 401 && error === "invalid_agent_signature") {
    return new AgentLinkError(
      "invalid_agent_signature",
      "The agent wallet signature was rejected.",
    );
  }
  if (status === 400 && error === "invalid_scope") {
    return new AgentLinkError("invalid_scope", "The requested agent scope is not allowed.");
  }
  return httpError("The vAPI agent link request failed.");
}

function notLinkedError(): AgentLinkError {
  return new AgentLinkError("not_linked", "Run vapi login first.");
}

function expiredLinkError(): AgentLinkError {
  return new AgentLinkError(
    "expired_token",
    "The agent link request expired. Run vapi login again.",
  );
}

function httpError(message: string): AgentLinkError {
  return new AgentLinkError("http", message);
}

function apiEndpoint(apiBase: string, path: string): string {
  return new URL(path, new URL(apiBase).origin).toString();
}

async function responseRecord(response: Response): Promise<Record<string, unknown>> {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw httpError("The vAPI agent link response was invalid.");
  }
  if (!isRecord(payload)) throw httpError("The vAPI agent link response was invalid.");
  return payload;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function numberField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = stringField(record, key);
  if (value === undefined) throw httpError("The vAPI agent link response was invalid.");
  return value;
}

function requiredNumber(record: Record<string, unknown>, key: string): number {
  const value = numberField(record, key);
  if (value === undefined) throw httpError("The vAPI agent link response was invalid.");
  return value;
}

function requiredOwner(record: Record<string, unknown>, key: string): `0x${string}` {
  const value = requiredString(record, key);
  if (!value.startsWith("0x")) throw httpError("The vAPI agent link response was invalid.");
  return value as `0x${string}`;
}

function optionalStringProperty<Key extends string>(
  record: Record<string, unknown>,
  source: string,
  target: Key,
): Partial<Record<Key, string>> {
  const value = stringField(record, source);
  return value === undefined ? {} : ({ [target]: value } as Record<Key, string>);
}

function splitScopes(scope: string): string[] {
  return scope.split(/\s+/u).filter(Boolean);
}

async function sleepFor(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}
