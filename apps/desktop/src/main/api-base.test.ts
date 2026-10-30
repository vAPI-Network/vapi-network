import { afterEach, describe, expect, it, vi } from "vitest";

import { consoleLinkPage, consoleLinkUrl, resolveApiBase } from "./api-base.js";

const BASE = "https://api.vapinetwork.ai";

describe("consoleLinkPage", () => {
  it("returns the trusted console link page without a code or API path", () => {
    expect(consoleLinkPage("https://api-staging.vapinetwork.ai/some/path")).toBe(
      "https://api-staging.vapinetwork.ai/link",
    );
    expect(consoleLinkPage("http://localhost:5173/path?code=unsafe#hash")).toBe(
      "http://localhost:5173/link",
    );
  });
});

describe("resolveApiBase", () => {
  afterEach(() => vi.restoreAllMocks());

  it("uses production unless VAPI_REGISTRY_URL points elsewhere, as the CLI does", () => {
    expect(resolveApiBase({})).toBe(BASE);
    expect(resolveApiBase({ VAPI_REGISTRY_URL: " https://staging-api.example.com/ " })).toBe(
      "https://staging-api.example.com",
    );
  });

  it("accepts HTTP development origins and defaults empty configuration without warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(resolveApiBase({ VAPI_REGISTRY_URL: "http://localhost:5173/path" })).toBe(
      "http://localhost:5173",
    );
    expect(resolveApiBase({ VAPI_REGISTRY_URL: "  " })).toBe(BASE);
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([
    "not a URL",
    "https://[",
    "file:///tmp/registry",
    "ftp://api.example",
    "javascript:alert(1)",
    "bad\nURL",
  ])("falls back to core's default and warns once on one line for %j", (rejected) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(resolveApiBase({ VAPI_REGISTRY_URL: rejected })).toBe(BASE);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(JSON.stringify(rejected)));
    expect(warn).toHaveBeenCalledWith(expect.not.stringMatching(/[\r\n]/));
  });
});

describe("consoleLinkUrl", () => {
  it("also opens the console's agents page, nothing else", () => {
    const base = "https://api-staging.vapinetwork.ai";
    expect(consoleLinkUrl(`${base}/agents`, base)).toBe(`${base}/agents`);
    expect(consoleLinkUrl(`${base}/agents/x`, base)).toBeNull();
    expect(consoleLinkUrl("https://evil.example/agents", base)).toBeNull();
  });

  it("returns the configured server's link href with its code unchanged", () => {
    expect(consoleLinkUrl(`${BASE}/link?code=ABCD-EFGH`, BASE)).toBe(`${BASE}/link?code=ABCD-EFGH`);
    expect(consoleLinkUrl("https://staging.example/link", "https://staging.example")).toBe(
      "https://staging.example/link",
    );
  });

  it.each(["  https://api.vapinetwork.ai/link  \n", "https://api.vapinetwork.ai\t/link"])(
    "returns only the normalized href for %j",
    (raw) => {
      expect(consoleLinkUrl(raw, BASE)).toBe(`${BASE}/link`);
    },
  );

  it.each([
    "https://evil.example/link?code=ABCD-EFGH",
    `${BASE}/settings`,
    "http://api.vapinetwork.ai/link",
    "https://api.vapinetwork.ai:444/link",
    `${BASE}/link/`,
    `${BASE}/LINK`,
    `${BASE}/%6Cink`,
    "https://user:pw@api.vapinetwork.ai/link",
    "https://:@api.vapinetwork.ai/link",
    "https://@api.vapinetwork.ai/link",
    "https://:\t@api.vapinetwork.ai/link",
    "https:////:@api.vapinetwork.ai/link",
    "https://\\:@api.vapinetwork.ai/link",
    "javascript:alert(1)",
    "not a URL",
    `${BASE}/link?code=${"A".repeat(512)}`,
    42,
  ])("refuses %j", (raw) => {
    expect(consoleLinkUrl(raw, BASE)).toBeNull();
  });

  it("allows @ outside the authority", () => {
    expect(consoleLinkUrl(`${BASE}/link?code=@`, BASE)).toBe(`${BASE}/link?code=@`);
  });
});
