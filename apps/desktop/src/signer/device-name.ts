// apps/desktop/src/signer/device-name.ts

/**
 * The console groups agents by device and shows a device with this prefix as
 * "vAPI Desktop on <host>" (apps/api `_shared/client/lib/device-display.ts`; keep both equal).
 */
export const DESKTOP_DEVICE_PREFIX = "vapi-desktop-";
const DEVICE_NAME_MAX = 32;

/** "Ada-MacBook-Pro.local" → "vapi-desktop-ada-macbook-pro"; fits `^[a-z0-9][a-z0-9-]{0,31}$`. */
export function desktopDeviceName(hostname: string): string {
  const host = (hostname.split(".")[0] ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, DEVICE_NAME_MAX - DESKTOP_DEVICE_PREFIX.length)
    .replace(/-+$/g, "");
  return `${DESKTOP_DEVICE_PREFIX}${host || "mac"}`;
}
