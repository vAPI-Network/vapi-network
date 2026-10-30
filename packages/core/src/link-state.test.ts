// packages/core/src/link-state.test.ts
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { getAddress } from "viem";

import { agentSecretAccounts } from "./agent-link.js";
import { linkStates } from "./link-state.js";
import { memorySecretStore, type SecretStore } from "./secret-store.js";
import { WalletStore } from "./wallet-store.js";

const API_BASE = "https://api.vapinetwork.ai";
const OWNER = getAddress("0x8617e340b3d01fa5f11f306f4090fd50e238070d");
const homes: string[] = [];

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "vapi-link-state-"));
  homes.push(home);
  const secrets = memorySecretStore();
  const store = await WalletStore.open(home, { secrets });
  await store.create("claude", "");
  await store.create("research", "");
  const addresses = {
    claude: getAddress((await store.readAddress("claude"))!),
    research: getAddress((await store.readAddress("research"))!),
  };
  return { store, secrets, addresses };
}

async function link(
  store: WalletStore,
  secrets: SecretStore,
  name: string,
  options: { tokens: boolean } = { tokens: true },
): Promise<void> {
  await store.setLink(name, {
    apiBase: API_BASE,
    clientId: `agent_${name}`,
    owner: OWNER,
    label: name,
    scopes: ["mcp:call"],
    linkedAt: "2026-10-26T10:00:00.000Z",
  });
  if (!options.tokens) return;
  await secrets.set(
    agentSecretAccounts(name).tokens,
    JSON.stringify({
      accessToken: `token-${name}`,
      refreshToken: `refresh-${name}`,
      expiresAt: Number.MAX_SAFE_INTEGER,
      scopes: ["mcp:call"],
    }),
  );
}

function sibling(name: string, address: string, status: "active" | "revoked") {
  return {
    name,
    address,
    device: "vapi-desktop-test",
    status,
    allowance: { routerPerDayUsd: null, perCallUsd: null, perDayUsd: null },
    self: false,
  };
}

function server(handler: (request: { url: string; token: string | null }) => Response) {
  return vi.fn<typeof fetch>(async (input, init) => {
    const token = new Headers(init?.headers).get("authorization")?.replace("Bearer ", "") ?? null;
    return handler({ url: String(input), token });
  });
}

describe("linkStates", () => {
  it("reports not_linked without asking the server when there is no link or no token", async () => {
    const { store, secrets } = await fixture();
    await link(store, secrets, "claude", { tokens: false });
    const fetchImpl = server(() => Response.json({}));

    const states = await linkStates({ store, secrets, apiBase: API_BASE, fetchImpl });

    expect(states).toEqual(
      new Map([
        ["claude", "not_linked"],
        ["research", "not_linked"],
      ]),
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("marks a wallet the server reports revoked, with one siblings request", async () => {
    const { store, secrets, addresses } = await fixture();
    await link(store, secrets, "claude");
    await link(store, secrets, "research");
    const fetchImpl = server(() =>
      Response.json({
        owner: OWNER,
        siblings: [
          sibling("claude", addresses.claude, "active"),
          sibling("research", addresses.research, "revoked"),
        ],
      }),
    );

    const states = await linkStates({ store, secrets, apiBase: API_BASE, fetchImpl });

    expect(states).toEqual(
      new Map([
        ["claude", "linked"],
        ["research", "revoked"],
      ]),
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("marks the asking wallet revoked when its token is refused and asks through the next one", async () => {
    const { store, secrets, addresses } = await fixture();
    await link(store, secrets, "claude");
    await link(store, secrets, "research");
    const fetchImpl = server(({ url, token }) => {
      if (url.endsWith("/oauth/token")) {
        return Response.json({ error: "invalid_grant" }, { status: 400 });
      }
      if (token === "token-claude")
        return Response.json({ error: "unauthorized" }, { status: 401 });
      return Response.json({
        owner: OWNER,
        siblings: [sibling("research", addresses.research, "active")],
      });
    });

    const states = await linkStates({ store, secrets, apiBase: API_BASE, fetchImpl });

    expect(states).toEqual(
      new Map([
        ["claude", "revoked"],
        ["research", "linked"],
      ]),
    );
  });

  it("keeps linked wallets linked when vAPI cannot be reached", async () => {
    const { store, secrets } = await fixture();
    await link(store, secrets, "claude");
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      throw new TypeError("fetch failed");
    });

    const states = await linkStates({ store, secrets, apiBase: API_BASE, fetchImpl });

    expect(states.get("claude")).toBe("linked");
  });
});
