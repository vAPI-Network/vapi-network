import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  readBalance: vi.fn(),
  readOverview: vi.fn(),
  writeText: vi.fn(),
}));
vi.mock("node:fs/promises", () => ({ mkdir: vi.fn() }));
vi.mock("@vapi-network/core", () => ({
  DEFAULT_REGISTRY_URL: "https://api.vapinetwork.ai",
  writeJsonAtomic: vi.fn(),
}));
vi.mock("./overview.js", () => ({
  baseBalanceReader: mocks.readBalance,
  readOverview: mocks.readOverview,
}));
vi.mock("electron", () => {
  class Port {
    listener?: (event: { data: unknown }) => void;
    on(_event: string, listener: Port["listener"]) {
      this.listener = listener;
    }
    start() {}
    postMessage({ id, request }: { id: number; request: { type: string } }) {
      this.listener?.({
        data: {
          id,
          response: {
            ok: true,
            type: request.type,
            wallets: [],
            vault: "unlocked",
          },
        },
      });
    }
  }
  return {
    app: {
      whenReady: () => Promise.resolve(),
      on: vi.fn(),
      getPath: () => "/tmp/desktop-test",
      getAppPath: () => "/tmp/desktop-test",
      getVersion: () => "0.1.0",
      isPackaged: false,
    },
    BrowserWindow: class {
      webContents = { setWindowOpenHandler: vi.fn(), on: vi.fn() };
      once = vi.fn();
      loadFile = vi.fn();
      loadURL = vi.fn();
    },
    clipboard: { writeText: mocks.writeText },
    ipcMain: {
      handle: (name: string, handler: (...args: unknown[]) => unknown) =>
        mocks.handlers.set(name, handler),
    },
    Menu: { buildFromTemplate: vi.fn(), setApplicationMenu: vi.fn() },
    MessageChannelMain: class {
      port1 = new Port();
      port2 = new Port();
    },
    nativeTheme: {},
    session: {
      defaultSession: {
        webRequest: { onHeadersReceived: vi.fn() },
        setPermissionRequestHandler: vi.fn(),
      },
    },
    shell: {},
    utilityProcess: { fork: () => ({ postMessage: vi.fn(), on: vi.fn() }) },
  };
});

beforeEach(async () => {
  vi.resetModules();
  mocks.handlers.clear();
  mocks.writeText.mockReset();
  mocks.readBalance.mockReset().mockResolvedValue(async () => 0n);
  mocks.readOverview
    .mockReset()
    .mockResolvedValue({ wallets: [], apps: [], activity: [], owner: null, recovery: null });
  await import("./index.js");
  await vi.waitFor(() => expect(mocks.handlers.has("overview")).toBe(true));
});

it("copies configuration-sized text up to 4096 characters and rejects larger or empty payloads", () => {
  const copy = mocks.handlers.get("copyText")!;
  copy({}, "x".repeat(4096));
  expect(mocks.writeText).toHaveBeenCalledWith("x".repeat(4096));
  expect(() => copy({}, "x".repeat(4097))).toThrow();
  expect(() => copy({}, "")).toThrow();
});

it("retries balance-reader initialization after a rejection", async () => {
  mocks.readBalance.mockRejectedValueOnce(new Error("Invalid RPC config."));
  const overview = mocks.handlers.get("overview")!;
  await expect(overview()).rejects.toThrow("Invalid RPC config.");
  await expect(overview()).resolves.toMatchObject({ ok: true });
  expect(mocks.readBalance).toHaveBeenCalledTimes(2);
  await expect(overview()).resolves.toMatchObject({ ok: true });
  expect(mocks.readBalance).toHaveBeenCalledTimes(2);
});

it.each(["a".repeat(33), "-wallet", "two words", "../wallet"])(
  "rejects invalid wallet names in app IPC: %s",
  async (wallet) => {
    await expect(mocks.handlers.get("appSnippet")!({}, "codex", wallet)).rejects.toThrow();
    await expect(mocks.handlers.get("connectApp")!({}, "codex", wallet)).rejects.toThrow();
  },
);

it("accepts a 32-character wallet name for app IPC", async () => {
  await expect(mocks.handlers.get("appSnippet")!({}, "codex", "a".repeat(32))).resolves.toBeNull();
});
