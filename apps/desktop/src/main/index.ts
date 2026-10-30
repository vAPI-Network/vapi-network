import {
  app,
  BrowserWindow,
  clipboard,
  ipcMain,
  Menu,
  MessageChannelMain,
  nativeTheme,
  session,
  shell,
  utilityProcess,
} from "electron";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

import { readAcknowledgement, recordAcknowledgement } from "./acknowledgement.js";
import { consoleLinkPage, consoleLinkUrl, resolveApiBase } from "./api-base.js";
import { appPaths } from "./apps/detect.js";
import { appSnippet, appStatuses, connectApp, type AppsDeps } from "./apps/service.js";
import { baseBalanceReader, readOverview } from "./overview.js";
import { createCrashLog } from "./crash-log.js";
import { appMenuTemplate } from "./menu.js";
import { desktopPaths } from "./paths.js";
import { readPreferences, writePreferences, type Preferences } from "./preferences.js";
import { windowOptions } from "./window.js";
import { startUpdater } from "./updater.js";
import type { SignerRequest, SignerResponse } from "../signer/messages.js";
import { walletNameSchema } from "../shared/wallet-name.js";
import { CONNECTABLE_APP_IDS, type ConnectableAppId, type ConnectResult } from "../shared/apps.js";
import { feedbackMailto } from "../shared/feedback.js";

const CSP = process.env.ELECTRON_RENDERER_URL
  ? // Dev server only: React Refresh preamble + HMR websocket (see electron.vite.config.ts).
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws://localhost:*"
  : "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'";

function createWindow(): BrowserWindow {
  const window = new BrowserWindow(windowOptions(join(__dirname, "../preload/index.cjs")));
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.once("ready-to-show", () => window.show());
  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void window.loadFile(join(__dirname, "../renderer/index.html"));
  }
  return window;
}

let uiPort: Electron.MessagePortMain | undefined;
let nextId = 1;
const pending = new Map<number, (response: SignerResponse) => void>();

function askSigner(request: SignerRequest): Promise<SignerResponse> {
  return new Promise((resolve, reject) => {
    if (!uiPort) return reject(new Error("Signer not started."));
    const id = nextId++;
    pending.set(id, resolve);
    uiPort.postMessage({ id, request });
  });
}

const home = process.env.VAPI_HOME ?? join(homedir(), ".vapi");
const apiBase = resolveApiBase(process.env);
let balanceReader: ReturnType<typeof baseBalanceReader> | undefined;
const paths = desktopPaths(app.getPath("appData"));
const preferencesPath = join(paths.root, "preferences.json");
const crashReportsDir = join(paths.root, "crash-reports");
let preferences: Preferences = { crashReports: false };
const crashLog = createCrashLog({
  dir: crashReportsDir,
  home: homedir(),
  version: app.getVersion(),
  enabled: () => preferences.crashReports,
});

async function sendFeedback(): Promise<void> {
  await shell.openExternal(
    feedbackMailto({
      version: app.getVersion(),
      macos: process.getSystemVersion(),
    }),
  );
}

process.on("uncaughtException", (error) => {
  void crashLog.record("main-exception", error);
  console.error(error);
});
process.on("unhandledRejection", (reason: unknown) => {
  void crashLog.record("main-rejection", reason);
  console.error(reason);
});
app.on("render-process-gone", (_event, _contents, details) => {
  void crashLog.record("renderer-gone", details);
});
app.on("child-process-gone", (_event, details) => {
  void crashLog.record("child-gone", details);
});

async function overview(appsDeps: AppsDeps) {
  const [listed, status, recovered] = await Promise.all([
    askSigner({ type: "listWallets", includeLinks: true }),
    askSigner({ type: "status" }),
    askSigner({ type: "recoveryStatus" }),
  ]);
  if (!listed.ok) return { ok: false as const, message: listed.message };
  if (listed.type !== "listWallets") return { ok: false as const, message: "Unexpected reply." };
  const owner = status.ok && status.type === "status" ? (status.owner ?? null) : null;
  balanceReader ??= baseBalanceReader(home).catch((error) => {
    balanceReader = undefined;
    throw error;
  });
  const result = await readOverview({
    home,
    wallets: listed.wallets,
    readBalance: await balanceReader,
    apps: () => appStatuses(appsDeps),
    owner,
    recovery: recovered.ok && recovered.type === "recoveryStatus" ? recovered.recovery : null,
  });
  return { ok: true as const, ...result };
}

// Renderer input is untrusted: bound copied addresses and app configuration snippets.
const copyTextSchema = z.string().min(1).max(4096);
// Only Basescan links (from our own receipts) may open in the browser.
const explorerUrlSchema = z.string().regex(/^https:\/\/basescan\.org\/[A-Za-z0-9/?=&._-]+$/);

const appIdSchema = z.enum(CONNECTABLE_APP_IDS as [ConnectableAppId, ...ConnectableAppId[]]);
const appPageSchema = z.enum(["grok-connectors"]);
const APP_PAGES = {
  // grok.com has no documented deep URL for connectors; update when one is documented.
  "grok-connectors": "https://grok.com/",
};

async function hasWallet(wallet: string): Promise<boolean> {
  try {
    const listed = await askSigner({ type: "listWallets" });
    return (
      listed.ok &&
      listed.type === "listWallets" &&
      listed.wallets.some(({ name }) => name === wallet)
    );
  } catch {
    return false;
  }
}

async function startProcesses(): Promise<void> {
  const paths = desktopPaths(app.getPath("appData"));
  await mkdir(paths.root, { recursive: true, mode: 0o700 });
  const helper = app.isPackaged
    ? join(process.resourcesPath, "vapi-keychain")
    : join(app.getAppPath(), "native/out/vapi-keychain");

  const signer = utilityProcess.fork(join(__dirname, "signer.js"), [], {
    serviceName: "vAPI signer",
    env: {
      ...process.env,
      VAPI_HOME: home,
      VAPI_DESKTOP_API_BASE: apiBase,
      VAPI_DESKTOP_SIGNER_LEDGER: paths.signerLedger,
      ...(process.platform === "darwin" ? { VAPI_DESKTOP_KEYCHAIN_HELPER: helper } : {}),
    },
  });
  signer.on("exit", (exitCode) => {
    if (exitCode !== 0) void crashLog.record("signer-exit", { exitCode });
  });
  const mcpHost = utilityProcess.fork(join(__dirname, "mcp-host.js"), [], {
    serviceName: "vAPI MCP host",
    env: { ...process.env, VAPI_HOME: home, VAPI_DESKTOP_SOCKET: paths.socket },
  });
  mcpHost.on("exit", (exitCode) => {
    if (exitCode !== 0) void crashLog.record("mcp-host-exit", { exitCode });
  });

  const ui = new MessageChannelMain();
  const mcp = new MessageChannelMain();
  signer.postMessage({ type: "ports", roles: ["ui", "mcp"] }, [ui.port1, mcp.port1]);
  mcpHost.postMessage({ type: "signer" }, [mcp.port2]);
  uiPort = ui.port2;
  uiPort.on("message", (event) => {
    const { id, response } = event.data as { id: number; response: SignerResponse };
    pending.get(id)?.(response);
    pending.delete(id);
  });
  uiPort.start();
}

app.whenReady().then(async () => {
  preferences = await readPreferences(preferencesPath);
  Menu.setApplicationMenu(
    Menu.buildFromTemplate(
      appMenuTemplate({
        packaged: app.isPackaged,
        onFeedback: () => void sendFeedback().catch(console.error),
      }),
    ),
  );
  nativeTheme.themeSource = "dark";
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: { ...details.responseHeaders, "Content-Security-Policy": [CSP] },
    });
  });
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) =>
    callback(false),
  );
  app.on("web-contents-created", (_event, contents) => {
    contents.on("will-attach-webview", (event) => event.preventDefault());
  });
  // Packaged builds take the icon from resources/icon.icns; dev runs inside Electron.app.
  if (!app.isPackaged && process.platform === "darwin") {
    app.dock?.setIcon(join(app.getAppPath(), "resources/icon.png"));
  }
  await startProcesses();
  // Squirrel.Mac only installs signed updates; unsigned and dev builds never load the updater.
  if (__VAPI_DESKTOP_SIGNED__ && app.isPackaged) {
    try {
      const { autoUpdater } = await import("electron-updater");
      startUpdater({ signed: true, packaged: true, updater: autoUpdater });
    } catch {
      console.error("vAPI Desktop updater could not start.");
    }
  }
  const paths = desktopPaths(app.getPath("appData"));
  const appsDeps: AppsDeps = {
    paths: appPaths(app.getPath("appData"), homedir()),
    shimPath: app.isPackaged
      ? join(process.resourcesPath, "vapi-mcp-shim")
      : join(app.getAppPath(), "native/out/vapi-mcp-shim"),
    shimJsPath: app.isPackaged
      ? join(process.resourcesPath, "mcp-shim/shim.js")
      : join(app.getAppPath(), "resources/mcp-shim/shim.js"),
    socketPath: paths.socket,
    mcpbDir: join(paths.root, "mcpb"),
    open: async (target) =>
      target.startsWith("/")
        ? await shell.openPath(target)
        : await shell.openExternal(target).then(
            () => "",
            (error: unknown) => (error instanceof Error ? error.message : String(error)),
          ),
  };
  // The signer validates every request with zod, so main forwards the
  // renderer's payload without trusting it.
  ipcMain.handle(
    "signer",
    async (_event, request: unknown) => await askSigner(request as SignerRequest),
  );
  ipcMain.handle("overview", async () => await overview(appsDeps));
  ipcMain.handle("appInfo", () => ({ version: app.getVersion() }));
  ipcMain.handle("preferences", () => preferences);
  ipcMain.handle("setCrashReports", async (_event, on: unknown) => {
    const next = { crashReports: z.boolean().parse(on) };
    await writePreferences(preferencesPath, next);
    preferences = next;
    return preferences;
  });
  ipcMain.handle("sendFeedback", sendFeedback);
  ipcMain.handle("showCrashReports", async () => {
    await mkdir(crashReportsDir, { recursive: true, mode: 0o700 });
    const error = await shell.openPath(crashReportsDir);
    if (error) throw new Error(error);
  });
  const { custody } = desktopPaths(app.getPath("appData"));
  ipcMain.handle("custodyAccepted", async () => (await readAcknowledgement(custody)) !== undefined);
  ipcMain.handle("acceptCustody", async (_event, version: unknown) => {
    await recordAcknowledgement(custody, version);
  });
  ipcMain.handle("copyText", (_event, text: unknown) => {
    clipboard.writeText(copyTextSchema.parse(text));
  });
  ipcMain.handle("openExplorer", async (_event, url: unknown) => {
    await shell.openExternal(explorerUrlSchema.parse(url));
  });
  ipcMain.handle("openConsole", async (_event, url: unknown) => {
    const href = consoleLinkUrl(url, apiBase);
    if (href !== null) {
      try {
        await shell.openExternal(href);
        return { opened: true };
      } catch {
        // Offer the trusted manual page when the operating system cannot open it.
      }
    }
    return { opened: false, page: consoleLinkPage(apiBase) };
  });
  // The print dialog lets the user print or save a PDF; the app never writes the words itself.
  ipcMain.handle(
    "printKit",
    async (event) =>
      await new Promise<boolean>((resolve) => {
        event.sender.print({ silent: false, printBackground: false }, (success) =>
          resolve(success),
        );
      }),
  );
  ipcMain.handle("appSnippet", async (_event, id: unknown, wallet: unknown) => {
    const appId = appIdSchema.parse(id);
    const walletName = walletNameSchema.parse(wallet);
    if (!(await hasWallet(walletName))) return null;
    return appSnippet(appsDeps, appId, walletName);
  });
  ipcMain.handle(
    "connectApp",
    async (_event, id: unknown, wallet: unknown): Promise<ConnectResult> => {
      const appId = appIdSchema.parse(id);
      const walletName = walletNameSchema.parse(wallet);
      if (!(await hasWallet(walletName))) {
        return { ok: false, message: "That agent wallet is not in vAPI Desktop." };
      }
      return await connectApp(appsDeps, appId, walletName);
    },
  );
  ipcMain.handle("openAppPage", async (_event, key: unknown) => {
    await shell.openExternal(APP_PAGES[appPageSchema.parse(key)]);
  });
  createWindow();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
