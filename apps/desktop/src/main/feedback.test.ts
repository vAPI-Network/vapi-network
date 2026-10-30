import type { MenuItemConstructorOptions } from "electron";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FEEDBACK_ADDRESS, feedbackMailto } from "../shared/feedback.js";
import { appMenuTemplate } from "./menu.js";

describe("beta feedback", () => {
  it("opens an encoded email containing only the app and macOS versions", () => {
    const mailto = feedbackMailto({ version: "0.1.0", macos: "15.1" });
    expect(FEEDBACK_ADDRESS).toBe("founders@vapinetwork.ai");
    expect(mailto).toMatch(/^mailto:founders@vapinetwork\.ai\?/);
    const params = new URL(mailto).searchParams;
    expect(params.get("subject")).toBe("vAPI Desktop beta feedback");
    expect(params.get("body")).toBe("vAPI Desktop 0.1.0\nmacOS 15.1\n\nWhat happened:\n\n");
    expect(mailto).toContain("%0A");
    expect(decodeURIComponent(mailto)).not.toMatch(/\/Users\/|0x/);
  });

  it("encodes version strings without adding mailto parameters", () => {
    const params = new URL(feedbackMailto({ version: "0.1.0&cc=other", macos: "15.1" }))
      .searchParams;
    expect(params.has("cc")).toBe(false);
    expect(params.get("body")).toContain("0.1.0&cc=other");
  });
});

function items(template: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
  return template.flatMap((item) => [
    item,
    ...(Array.isArray(item.submenu) ? items(item.submenu) : []),
  ]);
}

describe("app menu", () => {
  it("offers feedback from Help and the standard macOS menus", () => {
    const onFeedback = vi.fn();
    const template = appMenuTemplate({ packaged: true, onFeedback });
    expect(template).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "appMenu" }),
        expect.objectContaining({ role: "editMenu" }),
        expect.objectContaining({ role: "windowMenu" }),
      ]),
    );
    const help = template.find((item) => item.role === "help");
    expect(Array.isArray(help?.submenu)).toBe(true);
    const feedback = (help?.submenu as MenuItemConstructorOptions[]).find(
      (item) => item.label === "Send feedback…",
    );
    expect(feedback?.click).toBeTypeOf("function");
    feedback?.click?.({} as Electron.MenuItem, undefined, {} as Electron.KeyboardEvent);
    expect(onFeedback).toHaveBeenCalledOnce();
  });

  it("offers developer tools only in development", () => {
    const onFeedback = vi.fn();
    expect(
      items(appMenuTemplate({ packaged: true, onFeedback })).some(
        (item) => item.role === "toggleDevTools" || item.role === "viewMenu",
      ),
    ).toBe(false);
    expect(
      items(appMenuTemplate({ packaged: false, onFeedback })).some(
        (item) => item.role === "toggleDevTools",
      ),
    ).toBe(true);
  });
});

describe("beta support IPC", () => {
  let dir: string;
  let app: EventEmitter;
  let children: EventEmitter[];
  let handlers: Map<string, (...args: unknown[]) => unknown>;
  let openExternal: ReturnType<typeof vi.fn>;
  let openPath: ReturnType<typeof vi.fn>;
  let exceptions: NodeJS.UncaughtExceptionListener[];
  let rejections: NodeJS.UnhandledRejectionListener[];
  const systemVersion = Object.getOwnPropertyDescriptor(process, "getSystemVersion");

  beforeEach(async () => {
    vi.resetModules();
    dir = await mkdtemp(join(tmpdir(), "desktop-beta-ipc-"));
    exceptions = process.listeners("uncaughtException");
    rejections = process.listeners("unhandledRejection");
    Object.defineProperty(process, "getSystemVersion", { configurable: true, value: () => "15.1" });
    app = Object.assign(new EventEmitter(), {
      whenReady: () => Promise.resolve(),
      getVersion: () => "0.1.0",
      getPath: () => dir,
      getAppPath: () => dir,
      isPackaged: false,
    });
    children = [];
    handlers = new Map();
    openExternal = vi.fn().mockResolvedValue(undefined);
    openPath = vi.fn().mockResolvedValue("");
    vi.doMock("electron", () => ({
      app,
      BrowserWindow: class {
        webContents = { setWindowOpenHandler: vi.fn(), on: vi.fn() };
        once = vi.fn();
        loadFile = vi.fn();
        loadURL = vi.fn();
      },
      clipboard: { writeText: vi.fn() },
      ipcMain: {
        handle: (name: string, handler: (...args: unknown[]) => unknown) =>
          handlers.set(name, handler),
      },
      Menu: { buildFromTemplate: vi.fn((template) => template), setApplicationMenu: vi.fn() },
      MessageChannelMain: class {
        port1 = Object.assign(new EventEmitter(), { start: vi.fn(), postMessage: vi.fn() });
        port2 = Object.assign(new EventEmitter(), { start: vi.fn(), postMessage: vi.fn() });
      },
      nativeTheme: {},
      session: {
        defaultSession: {
          webRequest: { onHeadersReceived: vi.fn() },
          setPermissionRequestHandler: vi.fn(),
        },
      },
      shell: { openExternal, openPath },
      utilityProcess: {
        fork: () => {
          const child = Object.assign(new EventEmitter(), { postMessage: vi.fn() });
          children.push(child);
          return child;
        },
      },
    }));
    await import("./index.js");
    await vi.waitFor(() => expect(handlers.has("showCrashReports")).toBe(true));
  });

  afterEach(async () => {
    for (const listener of process.listeners("uncaughtException")) {
      if (!exceptions.includes(listener)) process.removeListener("uncaughtException", listener);
    }
    for (const listener of process.listeners("unhandledRejection")) {
      if (!rejections.includes(listener)) process.removeListener("unhandledRejection", listener);
    }
    if (systemVersion) Object.defineProperty(process, "getSystemVersion", systemVersion);
    else Reflect.deleteProperty(process, "getSystemVersion");
    vi.doUnmock("electron");
    vi.resetModules();
    await rm(dir, { recursive: true, force: true });
  });

  it("keeps the mail destination in main and persists only validated preferences", async () => {
    expect(handlers.get("appInfo")!()).toEqual({ version: "0.1.0" });
    expect(handlers.get("preferences")!()).toEqual({ crashReports: false });
    await handlers.get("sendFeedback")!({}, "https://untrusted.example");
    expect(openExternal).toHaveBeenCalledWith(feedbackMailto({ version: "0.1.0", macos: "15.1" }));
    await expect(handlers.get("setCrashReports")!({}, "true")).rejects.toThrow();
    expect(handlers.get("preferences")!()).toEqual({ crashReports: false });
    await handlers.get("setCrashReports")!({}, true);
    expect(JSON.parse(await readFile(join(dir, "vAPI Desktop/preferences.json"), "utf8"))).toEqual({
      crashReports: true,
    });
    await handlers.get("showCrashReports")!();
    expect(openPath).toHaveBeenCalledWith(join(dir, "vAPI Desktop/crash-reports"));
    expect((await stat(join(dir, "vAPI Desktop/crash-reports"))).mode & 0o777).toBe(0o700);
  });

  it("records process-gone events and non-zero helper exits only after opting in", async () => {
    await handlers.get("setCrashReports")!({}, true);
    app.emit("render-process-gone", {}, {}, { reason: "crashed", exitCode: 11, name: "private" });
    app.emit("child-process-gone", {}, { reason: "crashed", exitCode: 12, name: "private" });
    children[0]!.emit("exit", 0);
    children[0]!.emit("exit", 7);
    children[1]!.emit("exit", 8);
    const path = join(dir, "vAPI Desktop/crash-reports/crash-reports.jsonl");
    const reports = await vi.waitFor(async () => {
      const entries = (await readFile(path, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(entries).toHaveLength(4);
      return entries;
    });
    expect(reports.map((entry) => entry.kind)).toEqual([
      "renderer-gone",
      "child-gone",
      "signer-exit",
      "mcp-host-exit",
    ]);
    expect(reports[0].detail).toEqual({ exitCode: 11, reason: "crashed" });
    await handlers.get("setCrashReports")!({}, false);
    children[0]!.emit("exit", 9);
    expect((await readFile(path, "utf8")).trim().split("\n")).toHaveLength(4);
  });
});
