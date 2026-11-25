import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { assertPublicUrl, createPublicFetch, getDefaultConfig } from "@vapi-network/core";

import { commandFetch, loadCommandFetch } from "./cli-context.js";

// The helper's only seam is the options it gives the guard; the guard then runs
// with a lookup that answers like a local proxy's fake-IP DNS, so no socket opens.
vi.mock("@vapi-network/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@vapi-network/core")>();
  return { ...actual, createPublicFetch: vi.fn(actual.createPublicFetch) };
});

const FAKE_IP_LOOKUP = async () => ["198.18.0.1"];
const VAPI_URL = new URL("https://api.vapinetwork.ai/api/agents/self");
const homes: string[] = [];

afterEach(async () => {
  vi.mocked(createPublicFetch).mockClear();
  await Promise.all(homes.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function guardOptions(): { allowPrivateNetwork: boolean } {
  const calls = vi.mocked(createPublicFetch).mock.calls;
  expect(calls).toHaveLength(1);
  return calls[0]![0];
}

describe("commandFetch", () => {
  it("lets a fake-IP address through when allowPrivateNetwork is on", async () => {
    commandFetch({}, { allowPrivateNetwork: true });

    const options = guardOptions();
    expect(options).toEqual({ allowPrivateNetwork: true });
    await expect(
      assertPublicUrl(VAPI_URL, { ...options, lookup: FAKE_IP_LOOKUP }),
    ).resolves.toBeUndefined();
  });

  it.each([
    ["off", { allowPrivateNetwork: false }],
    ["unset", {}],
  ])("refuses a fake-IP address when allowPrivateNetwork is %s", async (_label, config) => {
    commandFetch({}, config);

    const options = guardOptions();
    expect(options).toEqual({ allowPrivateNetwork: false });
    await expect(
      assertPublicUrl(VAPI_URL, { ...options, lookup: FAKE_IP_LOOKUP }),
    ).rejects.toMatchObject({ name: "NetworkGuardError", reason: "blocked" });
    const guarded = createPublicFetch({ ...options, lookup: FAKE_IP_LOOKUP });
    await expect(guarded(VAPI_URL)).rejects.toMatchObject({ name: "NetworkGuardError" });
  });

  it("uses an injected fetchImpl before the config", () => {
    const fetchImpl = vi.fn<typeof fetch>();

    expect(commandFetch({ fetchImpl }, { allowPrivateNetwork: true })).toBe(fetchImpl);
    expect(createPublicFetch).not.toHaveBeenCalled();
  });
});

describe("loadCommandFetch", () => {
  async function configPath(config?: object): Promise<string> {
    const home = await mkdtemp(join(tmpdir(), "vapi-cli-context-"));
    homes.push(home);
    const path = join(home, "config.json");
    if (config !== undefined) await writeFile(path, JSON.stringify(config));
    return path;
  }

  it("reads allowPrivateNetwork from the config file", async () => {
    await loadCommandFetch(
      {},
      await configPath({ ...getDefaultConfig({}), allowPrivateNetwork: true }),
    );

    expect(guardOptions()).toEqual({ allowPrivateNetwork: true });
  });

  it("keeps the address check on for a missing config file", async () => {
    await loadCommandFetch({}, await configPath());

    expect(guardOptions()).toEqual({ allowPrivateNetwork: false });
  });

  it("uses an injected fetchImpl without reading the config", async () => {
    const fetchImpl = vi.fn<typeof fetch>();

    expect(await loadCommandFetch({ fetchImpl }, "/nonexistent/vapi/config.json")).toBe(fetchImpl);
    expect(createPublicFetch).not.toHaveBeenCalled();
  });
});
