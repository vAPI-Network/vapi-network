import type { BrowserWindowConstructorOptions } from "electron";

/** The one BrowserWindow this app opens. Every hardening flag lives here so a test can assert it. */
export function windowOptions(preloadPath: string): BrowserWindowConstructorOptions {
  return {
    width: 1120,
    height: 760,
    minWidth: 960,
    minHeight: 620,
    title: "vAPI Desktop",
    show: false,
    // Dark only for now (Zep, 2026-10-26); the sidebar runs up under the traffic lights.
    backgroundColor: "#0a0a0a",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 18 },
    webPreferences: {
      preload: preloadPath,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: false,
    },
  };
}
