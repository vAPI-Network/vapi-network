import { readFile } from "node:fs/promises";
import { hostname as operatingSystemHostname } from "node:os";

import { getVapiPaths, writeConfigDevice } from "./config.js";

export const DEVICE_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;

function normalizedDeviceName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]/gu, "-")
    .replace(/-+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 32)
    .replace(/-+$/gu, "");
}

export function slugifyDeviceName(value: string): string {
  return normalizedDeviceName(value) || "device";
}

export function deviceName(
  args: {
    env?: NodeJS.ProcessEnv;
    hostname?: string;
    config?: { device?: string | undefined };
  } = {},
): string {
  const environmentValue = args.env === undefined ? process.env.VAPI_DEVICE : args.env.VAPI_DEVICE;
  for (const value of [environmentValue?.trim(), args.config?.device]) {
    if (value === undefined || value.length === 0) continue;
    const normalized = normalizedDeviceName(value);
    if (normalized.length > 0) return normalized;
  }
  return slugifyDeviceName(args.hostname ?? operatingSystemHostname());
}

export async function ensureDeviceName(
  args: {
    env?: NodeJS.ProcessEnv;
    hostname?: string;
    configPath?: string;
  } = {},
): Promise<string> {
  const configPath = args.configPath ?? getVapiPaths().config;
  let config: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(await readFile(configPath, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return deviceName({
        ...(args.env === undefined ? {} : { env: args.env }),
        ...(args.hostname === undefined ? {} : { hostname: args.hostname }),
      });
    }
    config = parsed as Record<string, unknown>;
  } catch {
    return deviceName({
      ...(args.env === undefined ? {} : { env: args.env }),
      ...(args.hostname === undefined ? {} : { hostname: args.hostname }),
    });
  }

  const configuredDevice =
    typeof config.device === "string" && DEVICE_NAME_PATTERN.test(config.device)
      ? config.device
      : undefined;
  const selected = deviceName({
    ...(args.env === undefined ? {} : { env: args.env }),
    ...(args.hostname === undefined ? {} : { hostname: args.hostname }),
    ...(configuredDevice === undefined ? {} : { config: { device: configuredDevice } }),
  });
  if (configuredDevice !== undefined) return selected;

  // VAPI_DEVICE is an invocation override, not the machine's persisted identity.
  const persisted = deviceName({
    env: {},
    ...(args.hostname === undefined ? {} : { hostname: args.hostname }),
  });
  try {
    await writeConfigDevice(configPath, persisted);
  } catch {
    // A failed persist must not prevent the link from starting.
  }
  return selected;
}
