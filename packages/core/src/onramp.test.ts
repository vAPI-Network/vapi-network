import { describe, expect, it } from "vitest";

import { fundingPageUrl, resolveRegistryUrl } from "./onramp.js";

const ADDRESS = "0x1111111111111111111111111111111111111111";

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
