import { describe, expect, it, vi } from "vitest";

import { fetchWalletIdentity, formatIdentityLines, formatScore } from "./identity.js";

describe("identity formatting", () => {
  it("formats the Base identity and reputation", () => {
    expect(
      formatIdentityLines({ erc8004Id: "42", reputation: { score: 4.567, count: 1 } }),
    ).toEqual(["On-chain identity: ERC-8004 agent #42 (Base)", "Reputation: 4.57 (1 review)"]);
  });

  it("omits reputation when the registry did not send it", () => {
    expect(formatIdentityLines({ erc8004Id: "42" })).toEqual([
      "On-chain identity: ERC-8004 agent #42 (Base)",
    ]);
  });

  it("rounds scores to at most two decimals without trailing zeros", () => {
    expect(formatScore(4)).toBe("4");
    expect(formatScore(4.5)).toBe("4.5");
    expect(formatScore(4.567)).toBe("4.57");
  });

  it("uses plural reviews except for one", () => {
    expect(formatIdentityLines({ erc8004Id: "42", reputation: { score: 0, count: 0 } })[1]).toBe(
      "Reputation: 0 (0 reviews)",
    );
    expect(formatIdentityLines({ erc8004Id: "42", reputation: { score: 4, count: 2 } })[1]).toBe(
      "Reputation: 4 (2 reviews)",
    );
  });
});

describe("wallet identity lookup", () => {
  const wallet = "0x1111111111111111111111111111111111111111";

  it("accepts a registered identity with reputation", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      Response.json({
        wallet,
        chain: "eip155:8453",
        identity: {
          erc8004Id: "42",
          agentCount: 1,
          registry: "0xregistry",
          reputation: { score: 4.5, count: 3 },
        },
      }),
    );

    await expect(
      fetchWalletIdentity({ baseUrl: "https://registry.example", wallet, fetchImpl }),
    ).resolves.toEqual({
      ok: true,
      identity: {
        erc8004Id: "42",
        agentCount: 1,
        registry: "0xregistry",
        reputation: { score: 4.5, count: 3 },
      },
    });
  });

  it("accepts a registered identity without reputation", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      Response.json({
        wallet,
        chain: "eip155:8453",
        identity: { erc8004Id: "42", agentCount: 1, registry: "0xregistry" },
      }),
    );

    await expect(
      fetchWalletIdentity({ baseUrl: "https://registry.example", wallet, fetchImpl }),
    ).resolves.toEqual({
      ok: true,
      identity: { erc8004Id: "42", agentCount: 1, registry: "0xregistry" },
    });
  });

  it("accepts a wallet with no registered identity", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      Response.json({ wallet, chain: "eip155:8453", identity: null }),
    );

    await expect(
      fetchWalletIdentity({ baseUrl: "https://registry.example", wallet, fetchImpl }),
    ).resolves.toEqual({ ok: true, identity: null });
  });

  it.each([400, 500])("rejects HTTP %s", async (status) => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(null, { status }));
    await expect(
      fetchWalletIdentity({ baseUrl: "https://registry.example", wallet, fetchImpl }),
    ).resolves.toEqual({ ok: false });
  });

  it("rejects a fetch failure", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      throw new TypeError("network failure");
    });
    await expect(
      fetchWalletIdentity({ baseUrl: "https://registry.example", wallet, fetchImpl }),
    ).resolves.toEqual({ ok: false });
  });

  it("rejects a 400 for a malformed wallet", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      Response.json({ error: "invalid wallet" }, { status: 400 }),
    );
    await expect(
      fetchWalletIdentity({ baseUrl: "https://registry.example", wallet, fetchImpl }),
    ).resolves.toEqual({ ok: false });
  });

  it("rejects invalid JSON", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response("not json", { status: 200 }));
    await expect(
      fetchWalletIdentity({ baseUrl: "https://registry.example", wallet, fetchImpl }),
    ).resolves.toEqual({ ok: false });
  });

  it("rejects an identity with the wrong id type", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      Response.json({
        wallet,
        chain: "eip155:8453",
        identity: { erc8004Id: 5 },
      }),
    );
    await expect(
      fetchWalletIdentity({ baseUrl: "https://registry.example", wallet, fetchImpl }),
    ).resolves.toEqual({ ok: false });
  });

  it("keeps the mount prefix, encodes the wallet, and sends no authorization", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      expect(new URL(String(input)).href).toBe(
        `https://registry.example/mount/api/call/identity/${encodeURIComponent(wallet)}`,
      );
      expect(init?.method).toBe("GET");
      expect(init?.headers).toEqual({ accept: "application/json" });
      return Response.json({ wallet, chain: "eip155:8453", identity: null });
    });

    await expect(
      fetchWalletIdentity({ baseUrl: "https://registry.example/mount/", wallet, fetchImpl }),
    ).resolves.toEqual({ ok: true, identity: null });
  });

  it("drops malformed reputation while keeping the identity", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      Response.json({
        wallet,
        chain: "eip155:8453",
        identity: {
          erc8004Id: "42",
          agentCount: 1,
          registry: "0xregistry",
          reputation: { score: "4.5", count: 3 },
        },
      }),
    );

    await expect(
      fetchWalletIdentity({ baseUrl: "https://registry.example", wallet, fetchImpl }),
    ).resolves.toEqual({
      ok: true,
      identity: { erc8004Id: "42", agentCount: 1, registry: "0xregistry" },
    });
  });

  it("treats an aborted request as a failed lookup", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      const signal = init?.signal;
      if (signal === undefined || signal === null) throw new Error("missing signal");
      await new Promise<void>((resolve, reject) => {
        if (signal.aborted) {
          reject(signal.reason);
          return;
        }
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        void resolve;
      });
      throw new Error("request did not abort");
    });

    await expect(
      fetchWalletIdentity({
        baseUrl: "https://registry.example",
        wallet,
        fetchImpl,
        timeoutMs: 10,
      }),
    ).resolves.toEqual({ ok: false });
  });
});
