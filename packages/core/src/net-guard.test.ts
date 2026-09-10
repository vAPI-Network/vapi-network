import { describe, expect, it, vi } from "vitest";

import { assertPublicUrl, createPublicFetch, type LookupFn } from "./net-guard.js";

const guardedOptions = { allowPrivateNetwork: false } as const;
const guardMessage = /allowPrivateNetwork true/;
const internalHostnames = ["localhost", "foo.local", "a.internal", "sub.foo.localhost"];
const nonPublicIpLiterals = [
  "0.1.2.3",
  "10.1.2.3",
  "100.64.0.1",
  "127.0.0.1",
  "169.254.169.254",
  "172.16.0.9",
  "192.0.0.1",
  "192.0.2.1",
  "192.168.1.1",
  "198.18.0.1",
  "198.51.100.1",
  "203.0.113.1",
  "224.0.0.1",
  "240.0.0.1",
  "[::]",
  "[::1]",
  "[fc00::1]",
  "[fe80::1]",
  "[fec0::1]",
  "[::ffff:127.0.0.1]",
  "[::ffff:192.0.2.1]",
  "[::127.0.0.1]",
  "[::198.51.100.1]",
  "[2001:db8::1]",
  "[ff02::1]",
];

describe("vAPI public network guard", () => {
  it("rejects embedded URL credentials even when private networks are allowed", async () => {
    await expect(
      assertPublicUrl(new URL("https://user:pass@example.com/path"), {
        allowPrivateNetwork: true,
      }),
    ).rejects.toThrow(guardMessage);
  });

  it("keeps credential and protocol checks active in the fetch wrapper", async () => {
    const privateFetch = createPublicFetch({ allowPrivateNetwork: true });

    await expect(privateFetch("http://user:pass@127.0.0.1/path")).rejects.toThrow(guardMessage);
    await expect(privateFetch("data:text/plain,not-a-service")).rejects.toThrow(guardMessage);
  });

  it.each(internalHostnames)("rejects the internal hostname %s", async (hostname) => {
    await expect(
      assertPublicUrl(new URL(`https://${hostname}/path`), guardedOptions),
    ).rejects.toThrow(guardMessage);
  });

  it.each(nonPublicIpLiterals)("rejects the non-public IP literal %s", async (hostname) => {
    await expect(
      assertPublicUrl(new URL(`https://${hostname}/path`), guardedOptions),
    ).rejects.toThrow(guardMessage);
  });

  it("rejects an empty hostname", async () => {
    await expect(assertPublicUrl(new URL("file:///path"), guardedOptions)).rejects.toThrow(
      guardMessage,
    );
  });

  it("allows a public IP literal without resolving it", async () => {
    const lookup = vi.fn<LookupFn>();

    await expect(
      assertPublicUrl(new URL("https://93.184.216.34/path"), {
        ...guardedOptions,
        lookup,
      }),
    ).resolves.toBeUndefined();
    expect(lookup).not.toHaveBeenCalled();
  });

  it.each([
    { name: "a private address", addresses: ["10.0.0.5"] },
    { name: "a site-local IPv6 address", addresses: ["fec0::1"] },
    { name: "mixed public and private addresses", addresses: ["93.184.216.34", "10.0.0.5"] },
  ])("rejects a hostname resolving to $name", async ({ addresses }) => {
    const lookup = vi.fn<LookupFn>().mockResolvedValue(addresses);

    await expect(
      assertPublicUrl(new URL("https://example.com/path"), {
        ...guardedOptions,
        lookup,
      }),
    ).rejects.toThrow(guardMessage);
  });

  it("allows a hostname resolving only to public addresses", async () => {
    const lookup = vi.fn<LookupFn>().mockResolvedValue(["93.184.216.34"]);

    await expect(
      assertPublicUrl(new URL("https://example.com/path"), {
        ...guardedOptions,
        lookup,
      }),
    ).resolves.toBeUndefined();
    expect(lookup).toHaveBeenCalledWith("example.com");
  });

  it("rejects a hostname when resolution fails", async () => {
    const lookup = vi.fn<LookupFn>().mockRejectedValue(new Error("DNS unavailable"));

    await expect(
      assertPublicUrl(new URL("https://example.com/path"), {
        ...guardedOptions,
        lookup,
      }),
    ).rejects.toThrow(guardMessage);
  });

  it.each([
    ["a rebound private address", ["127.0.0.1"]],
    ["mixed connection-time answers", ["93.184.216.34", "127.0.0.1"]],
  ])("pins the connection and rejects %s", async (_name, reboundAddresses) => {
    const lookup = vi
      .fn<LookupFn>()
      .mockResolvedValueOnce(["93.184.216.34"])
      .mockResolvedValueOnce(reboundAddresses);
    const guardedFetch = createPublicFetch({ allowPrivateNetwork: false, lookup });

    await expect(guardedFetch("https://rebind.example/path")).rejects.toThrow(guardMessage);
    expect(lookup).toHaveBeenNthCalledWith(1, "rebind.example");
    expect(lookup).toHaveBeenNthCalledWith(2, "rebind.example");
  });

  it.each([
    ...internalHostnames.map((hostname) => `https://${hostname}/path`),
    ...nonPublicIpLiterals.map((hostname) => `https://${hostname}/path`),
  ])("allows %s when private networks are enabled", async (url) => {
    const lookup = vi.fn<LookupFn>();

    await expect(
      assertPublicUrl(new URL(url), { allowPrivateNetwork: true, lookup }),
    ).resolves.toBeUndefined();
    expect(lookup).not.toHaveBeenCalled();
  });

  it.each([
    { name: "private DNS", lookup: vi.fn<LookupFn>().mockResolvedValue(["10.0.0.5"]) },
    {
      name: "mixed DNS",
      lookup: vi.fn<LookupFn>().mockResolvedValue(["93.184.216.34", "10.0.0.5"]),
    },
    {
      name: "failed DNS",
      lookup: vi.fn<LookupFn>().mockRejectedValue(new Error("DNS unavailable")),
    },
  ])("skips $name lookup when private networks are enabled", async ({ lookup }) => {
    await expect(
      assertPublicUrl(new URL("https://example.com/path"), {
        allowPrivateNetwork: true,
        lookup,
      }),
    ).resolves.toBeUndefined();
    expect(lookup).not.toHaveBeenCalled();
  });
});
