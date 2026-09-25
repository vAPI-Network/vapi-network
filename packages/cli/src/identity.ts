import { createPublicFetch } from "@vapi-network/core";

import { listingsUrl } from "./publish-client.js";

export type WalletIdentity = {
  erc8004Id: string;
  agentCount: number;
  registry: string;
  reputation?: { score: number; count: number } | undefined;
};

export type IdentityForDisplay = {
  erc8004Id: string;
  reputation?: { score: number; count: number } | undefined;
};

export async function fetchWalletIdentity(options: {
  baseUrl: string;
  wallet: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  allowPrivateNetwork?: boolean;
}): Promise<{ ok: true; identity: WalletIdentity | null } | { ok: false }> {
  try {
    const fetchImpl =
      options.fetchImpl ??
      createPublicFetch({ allowPrivateNetwork: options.allowPrivateNetwork ?? false });
    const response = await fetchImpl(
      listingsUrl(options.baseUrl, `/api/call/identity/${encodeURIComponent(options.wallet)}`),
      {
        method: "GET",
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(options.timeoutMs ?? 3_000),
      },
    );
    if (response.status !== 200) return { ok: false };

    const parsed = parseIdentityResponse(await response.json());
    return parsed === undefined ? { ok: false } : { ok: true, identity: parsed };
  } catch {
    return { ok: false };
  }
}

export function formatScore(score: number): string {
  return String(Number(score.toFixed(2)));
}

export function formatIdentityLines(identity: IdentityForDisplay): string[] {
  return [
    `On-chain identity: ERC-8004 agent #${identity.erc8004Id} (Base)`,
    ...(identity.reputation === undefined
      ? []
      : [
          `Reputation: ${formatScore(identity.reputation.score)} (${identity.reputation.count} review${identity.reputation.count === 1 ? "" : "s"})`,
        ]),
  ];
}

function parseIdentityResponse(value: unknown): WalletIdentity | null | undefined {
  if (!isRecord(value) || typeof value.wallet !== "string" || value.chain !== "eip155:8453") {
    return undefined;
  }
  if (value.identity === null) return null;
  if (!isRecord(value.identity)) return undefined;

  const { identity } = value;
  if (
    typeof identity.erc8004Id !== "string" ||
    identity.erc8004Id.length === 0 ||
    typeof identity.agentCount !== "number" ||
    !Number.isFinite(identity.agentCount) ||
    typeof identity.registry !== "string"
  ) {
    return undefined;
  }

  const reputation = parseReputation(identity.reputation);
  return {
    erc8004Id: identity.erc8004Id,
    agentCount: identity.agentCount,
    registry: identity.registry,
    ...(reputation === undefined ? {} : { reputation }),
  };
}

function parseReputation(value: unknown): { score: number; count: number } | undefined {
  if (!isRecord(value)) return undefined;
  if (
    typeof value.score !== "number" ||
    !Number.isFinite(value.score) ||
    typeof value.count !== "number" ||
    !Number.isInteger(value.count) ||
    value.count < 0
  ) {
    return undefined;
  }
  return { score: value.score, count: value.count };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
