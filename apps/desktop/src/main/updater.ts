import type { AppUpdater } from "electron-updater";
import { z } from "zod";

export const UPDATE_CONTROL_URL =
  "https://raw.githubusercontent.com/vAPI-Network/vapi-network/main/apps/desktop/update-control.json";

export const controlSchema = z.object({
  paused: z.boolean(),
  blockedVersions: z.array(z.string()),
});

export function mayInstall(control: unknown, offeredVersion: string): boolean {
  const parsed = controlSchema.safeParse(control);
  return (
    parsed.success && !parsed.data.paused && !parsed.data.blockedVersions.includes(offeredVersion)
  );
}

export type Updater = Pick<
  AppUpdater,
  "autoDownload" | "autoInstallOnAppQuit" | "logger" | "checkForUpdates" | "downloadUpdate"
> & {
  on(event: "error", listener: () => void): unknown;
  on(event: "update-available", listener: (info: { version: string }) => void): unknown;
};

async function fetchUpdateControl(): Promise<unknown> {
  const response = await fetch(UPDATE_CONTROL_URL, { signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error("Update control unavailable.");
  return await response.json();
}

export function startUpdater({
  signed,
  packaged,
  fetchControl = fetchUpdateControl,
  updater,
  log = (message) => console.error(message),
}: {
  signed: boolean;
  packaged: boolean;
  fetchControl?: () => Promise<unknown>;
  /** electron-updater's `autoUpdater`; main imports it only for signed packaged builds. */
  updater: Updater;
  log?: (message: string) => void;
}): { check(): Promise<void> } | null {
  if (!signed || !packaged) return null;
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = true;
  // Library logs include download URLs and local cache paths.
  updater.logger = null;
  updater.on("error", () => log("vAPI Desktop updater failed."));
  updater.on("update-available", (info) => {
    void (async () => {
      const control = await fetchControl();
      if (mayInstall(control, info.version)) await updater.downloadUpdate();
    })().catch(() => log("vAPI Desktop update download failed."));
  });

  async function check(): Promise<void> {
    try {
      const control = controlSchema.safeParse(await fetchControl());
      if (!control.success || control.data.paused) return;
      await updater.checkForUpdates();
    } catch {
      log("vAPI Desktop update check failed.");
    }
  }

  void check();
  setInterval(() => void check(), 6 * 60 * 60 * 1000).unref();
  return { check };
}
