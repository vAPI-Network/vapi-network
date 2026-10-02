import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DEVICE_NAME_PATTERN, deviceName, ensureDeviceName, slugifyDeviceName } from "./device.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function temporaryConfig(): Promise<{ directory: string; path: string }> {
  const directory = await mkdtemp(join(tmpdir(), "vapi-device-"));
  temporaryDirectories.push(directory);
  return { directory, path: join(directory, "config.json") };
}

describe("slugifyDeviceName", () => {
  it("slugs a Mac hostname, falls back for an empty hostname, and truncates to 32 characters", () => {
    expect(slugifyDeviceName("Zep's MacBook Pro.local")).toBe("zep-s-macbook-pro-local");
    expect(slugifyDeviceName("")).toBe("device");
    const truncated = slugifyDeviceName(`${"a".repeat(31)}-${"b".repeat(28)}`);
    expect(truncated).toBe("a".repeat(31));
    expect(truncated).toHaveLength(31);
    expect(truncated.endsWith("-")).toBe(false);
    expect(DEVICE_NAME_PATTERN.test(truncated)).toBe(true);
  });
});

describe("deviceName", () => {
  it("uses environment, then config, then hostname", () => {
    expect(
      deviceName({
        env: { VAPI_DEVICE: " Env Device " },
        config: { device: "config-device" },
        hostname: "host-device",
      }),
    ).toBe("env-device");
    expect(
      deviceName({ env: {}, config: { device: "Config Device" }, hostname: "host-device" }),
    ).toBe("config-device");
    expect(deviceName({ env: {}, hostname: "Host Device" })).toBe("host-device");
  });

  it("falls through an environment value that slugs to nothing", () => {
    expect(deviceName({ env: { VAPI_DEVICE: " !!! " }, config: { device: "config-device" } })).toBe(
      "config-device",
    );
  });
});

describe("ensureDeviceName", () => {
  it("writes a stable name once while preserving every existing config field", async () => {
    const { path } = await temporaryConfig();
    const original = {
      discoveryUrl: "https://api.example/services",
      apiKey: "registry-secret",
      extra: { untouched: true },
    };
    await writeFile(path, `${JSON.stringify(original, null, 2)}\n`, { mode: 0o600 });

    await expect(
      ensureDeviceName({ env: {}, hostname: "First Host", configPath: path }),
    ).resolves.toBe("first-host");
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      ...original,
      device: "first-host",
    });
    expect((await stat(path)).mode & 0o777).toBe(0o600);

    const stored = await readFile(path, "utf8");
    await expect(
      ensureDeviceName({ env: {}, hostname: "Renamed Host", configPath: path }),
    ).resolves.toBe("first-host");
    expect(await readFile(path, "utf8")).toBe(stored);
  });

  it("does not bake an environment override into config", async () => {
    const { path } = await temporaryConfig();
    await writeFile(path, '{"untouched":true}\n', { mode: 0o600 });

    await expect(
      ensureDeviceName({
        env: { VAPI_DEVICE: "temporary-session" },
        hostname: "Stable Host",
        configPath: path,
      }),
    ).resolves.toBe("temporary-session");
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      untouched: true,
      device: "stable-host",
    });
  });

  it("adds only device to an existing config.json and keeps apiKey", async () => {
    const { path } = await temporaryConfig();
    const original = {
      apiKey: "vapi_test_key",
      discoveryUrl: "https://example.test",
    };
    await writeFile(path, `${JSON.stringify(original)}\n`, { mode: 0o600 });

    await expect(
      ensureDeviceName({
        env: { VAPI_DEVICE: "env-name" },
        hostname: "Host Name",
        configPath: path,
      }),
    ).resolves.toBe("env-name");
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      ...original,
      device: "host-name",
    });
  });

  it("does not create config.json when it is absent", async () => {
    const withEnvironment = await temporaryConfig();

    await expect(
      ensureDeviceName({
        env: { VAPI_DEVICE: "ci-box" },
        hostname: "Ignored Host",
        configPath: withEnvironment.path,
      }),
    ).resolves.toBe("ci-box");
    expect(await readdir(withEnvironment.directory)).toEqual([]);

    const fromHostname = await temporaryConfig();

    await expect(
      ensureDeviceName({ env: {}, hostname: "Injected Host", configPath: fromHostname.path }),
    ).resolves.toBe("injected-host");
    expect(await readdir(fromHostname.directory)).toEqual([]);
  });
});
