import { describe, expect, it, vi } from "vitest";

import {
  ONRAMP_FALLBACK_INSTRUCTIONS,
  createOnrampSession,
  fundingPageUrl,
  resolveRegistryUrl,
  type CreateOnrampSessionOptions,
} from "./onramp.js";

const ADDRESS = "0x1111111111111111111111111111111111111111";

describe("createOnrampSession", () => {
  it("posts the funding request to the registry and returns the hosted URL", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ url: "https://pay.coinbase.com/buy/session" }));

    const session = await createOnrampSession(options({ fiatAmount: 25, fetchImpl }));

    expect(session).toEqual({
      status: "ready",
      address: ADDRESS,
      url: "https://pay.coinbase.com/buy/session",
    });
    const [endpoint, init] = fetchImpl.mock.calls[0]!;
    expect(String(endpoint)).toBe("https://registry.example/api/wallet/onramp-session");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({
      address: ADDRESS,
      network: "base",
      asset: "USDC",
      fiatAmount: 25,
    });
  });

  it("omits fiatAmount when the caller has no preference", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ url: "https://pay.coinbase.com/buy/session" }));

    await createOnrampSession(options({ fetchImpl }));

    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toEqual({
      address: ADDRESS,
      network: "base",
      asset: "USDC",
    });
  });

  it("falls back to direct transfer instructions on 503 onramp_unavailable", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ error: "onramp_unavailable" }, { status: 503 }));

    expect(await createOnrampSession(options({ fetchImpl }))).toEqual({
      status: "unavailable",
      address: ADDRESS,
      reason: "onramp_unavailable",
      instructions: ONRAMP_FALLBACK_INSTRUCTIONS,
    });
  });

  it("falls back when the registry cannot be reached at all", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new Error("getaddrinfo ENOTFOUND"));

    expect(await createOnrampSession(options({ fetchImpl }))).toEqual({
      status: "unavailable",
      address: ADDRESS,
      reason: "getaddrinfo ENOTFOUND",
      instructions: ONRAMP_FALLBACK_INSTRUCTIONS,
    });
  });

  it("falls back when a success response carries no usable URL", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ url: "javascript:alert(1)" }));

    expect(await createOnrampSession(options({ fetchImpl }))).toMatchObject({
      status: "unavailable",
      reason: "The registry returned no onramp URL.",
    });
  });

  it("prefers VAPI_REGISTRY_URL over the shipped default", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ url: "https://pay.example/session" }));

    await createOnrampSession({
      address: ADDRESS,
      fetchImpl,
      env: { VAPI_REGISTRY_URL: "https://staging.example/base" },
    });

    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(
      "https://staging.example/base/api/wallet/onramp-session",
    );
  });

  it("rejects a non-positive amount before any network request", async () => {
    const fetchImpl = vi.fn<typeof fetch>();

    await expect(createOnrampSession(options({ fiatAmount: 0, fetchImpl }))).rejects.toThrow(
      "greater than zero",
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("fundingPageUrl", () => {
  it("points at the hosted funding page for one address", () => {
    expect(fundingPageUrl("https://registry.example", ADDRESS)).toBe(
      `https://registry.example/fund/${ADDRESS}`,
    );
  });

  it("keeps a mount prefix and drops a trailing slash, query and fragment", () => {
    expect(fundingPageUrl("https://registry.example/base/?a=1#top", ADDRESS)).toBe(
      `https://registry.example/base/fund/${ADDRESS}`,
    );
  });

  it("prefills the requested amount", () => {
    expect(fundingPageUrl("https://registry.example", ADDRESS, { amount: 25 })).toBe(
      `https://registry.example/fund/${ADDRESS}?amount=25`,
    );
  });

  it("rejects anything that is not an EVM address", () => {
    expect(() => fundingPageUrl("https://registry.example", "not-an-address")).toThrow(
      "0x-prefixed EVM address",
    );
    expect(() => fundingPageUrl("https://registry.example", `${ADDRESS}00`)).toThrow(
      "0x-prefixed EVM address",
    );
  });

  it("rejects a non-positive amount", () => {
    expect(() => fundingPageUrl("https://registry.example", ADDRESS, { amount: 0 })).toThrow(
      "greater than zero",
    );
  });

  it("rejects an unusable registry URL", () => {
    expect(() => fundingPageUrl("registry.example", ADDRESS)).toThrow();
  });
});

describe("resolveRegistryUrl", () => {
  it("prefers VAPI_REGISTRY_URL over the shipped default", () => {
    expect(resolveRegistryUrl({ VAPI_REGISTRY_URL: " https://staging.example " })).toBe(
      "https://staging.example",
    );
    expect(resolveRegistryUrl({})).toBe("https://api.vapinetwork.ai");
  });
});

function options(overrides: Partial<CreateOnrampSessionOptions> = {}): CreateOnrampSessionOptions {
  return {
    address: ADDRESS,
    registryUrl: "https://registry.example",
    env: {},
    ...overrides,
  };
}
