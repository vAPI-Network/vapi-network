import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { mayInstall, startUpdater, UPDATE_CONTROL_URL } from "./updater.js";

const open = { paused: false, blockedVersions: [] };
const paused = { paused: true, blockedVersions: [] };

function fakeUpdater() {
  return Object.assign(new EventEmitter(), {
    autoDownload: true,
    autoInstallOnAppQuit: false,
    logger: console as Console | null,
    checkForUpdates: vi.fn(async () => null),
    downloadUpdate: vi.fn(async () => [] as string[]),
  });
}

describe("update control", () => {
  it.each([
    [open, true],
    [paused, false],
    [{ paused: false, blockedVersions: ["0.2.0"] }, false],
    [{ paused: false, blockedVersions: ["0.3.0"] }, true],
    [{ paused: "false", blockedVersions: [] }, false],
    [{ paused: false, blockedVersions: [2] }, false],
    [{ paused: false }, false],
    [null, false],
  ])("allows an offered version only under valid, open control: %j", (control, allowed) => {
    expect(mayInstall(control, "0.2.0")).toBe(allowed);
  });
});

describe("desktop updater", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it.each([
    [false, true],
    [true, false],
    [false, false],
  ])("does nothing when signed=%s and packaged=%s", (signed, packaged) => {
    const updater = fakeUpdater();
    const fetchControl = vi.fn();
    expect(startUpdater({ signed, packaged, updater, fetchControl })).toBeNull();
    expect(updater.checkForUpdates).not.toHaveBeenCalled();
    expect(fetchControl).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  function start(fetchControl = vi.fn(async (): Promise<unknown> => open)) {
    const updater = fakeUpdater();
    const log = vi.fn();
    const controller = startUpdater({ signed: true, packaged: true, updater, fetchControl, log });
    return { updater, log, controller, fetchControl };
  }

  it("checks at startup and every six hours without automatic downloads or raw logs", async () => {
    const { updater } = start();
    await vi.advanceTimersByTimeAsync(0);
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(updater.autoDownload).toBe(false);
    expect(updater.autoInstallOnAppQuit).toBe(true);
    expect(updater.logger).toBeNull();
    await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000);
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(2);
  });

  it("downloads an offered version after rechecking control", async () => {
    const { updater, fetchControl } = start();
    await vi.advanceTimersByTimeAsync(0);
    updater.emit("update-available", { version: "0.2.0" });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchControl).toHaveBeenCalledTimes(2);
    expect(updater.downloadUpdate).toHaveBeenCalledTimes(1);
  });

  it.each([paused, null, { paused: false, blockedVersions: ["0.2.0"] }])(
    "refuses a download when control changes to %j",
    async (control) => {
      const fetchControl = vi.fn(async (): Promise<unknown> => open);
      const { updater } = start(fetchControl);
      await vi.advanceTimersByTimeAsync(0);
      fetchControl.mockResolvedValue(control);
      updater.emit("update-available", { version: "0.2.0" });
      await vi.advanceTimersByTimeAsync(0);
      expect(updater.downloadUpdate).not.toHaveBeenCalled();
    },
  );

  it.each([paused, null])("skips a check under closed control: %j", async (control) => {
    const { updater, controller } = start(vi.fn(async () => control));
    await controller?.check();
    expect(updater.checkForUpdates).not.toHaveBeenCalled();
  });

  it("fails closed when control cannot be read", async () => {
    const fetchControl = vi.fn(async (): Promise<unknown> => {
      throw new Error("https://example.com/?token=secret /Users/tester/cache");
    });
    const { updater, controller, log } = start(fetchControl);
    await controller?.check();
    updater.emit("update-available", { version: "0.2.0" });
    await vi.advanceTimersByTimeAsync(0);
    expect(updater.checkForUpdates).not.toHaveBeenCalled();
    expect(updater.downloadUpdate).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalled();
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/secret|\/Users\/|https:/);
  });

  it("contains check, download and emitted errors without leaking their details", async () => {
    const { updater, controller, log } = start();
    await vi.advanceTimersByTimeAsync(0);
    const error = new Error("https://example.com/?token=secret /Users/tester/cache");
    updater.checkForUpdates.mockRejectedValue(error);
    await expect(controller?.check()).resolves.toBeUndefined();
    updater.downloadUpdate.mockRejectedValue(error);
    updater.emit("update-available", { version: "0.2.0" });
    expect(() => updater.emit("error", error)).not.toThrow();
    await vi.advanceTimersByTimeAsync(0);
    expect(log.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/secret|\/Users\/|https:/);
  });

  it("reads the fixed control URL with an eight-second timeout and refuses HTTP failures", async () => {
    expect(UPDATE_CONTROL_URL).toBe(
      "https://raw.githubusercontent.com/vAPI-Network/vapi-network/main/apps/desktop/update-control.json",
    );
    const fetch = vi.fn(async () => ({ ok: false, json: vi.fn(async () => open) }));
    vi.stubGlobal("fetch", fetch);
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const updater = fakeUpdater();
    const controller = startUpdater({ signed: true, packaged: true, updater, log: vi.fn() });
    await controller?.check();
    expect(fetch).toHaveBeenCalledWith(UPDATE_CONTROL_URL, { signal: expect.any(AbortSignal) });
    expect(timeout).toHaveBeenCalledWith(8000);
    expect(updater.checkForUpdates).not.toHaveBeenCalled();
    timeout.mockRestore();
  });
});
