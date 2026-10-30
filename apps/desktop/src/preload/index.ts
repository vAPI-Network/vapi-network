import { contextBridge, ipcRenderer } from "electron";

import type { ConnectableAppId } from "../shared/apps.js";

contextBridge.exposeInMainWorld("desktop", {
  signer: (request: unknown) => ipcRenderer.invoke("signer", request),
  appSnippet: (id: ConnectableAppId, wallet: string) =>
    ipcRenderer.invoke("appSnippet", id, wallet),
  connectApp: (id: ConnectableAppId, wallet: string) =>
    ipcRenderer.invoke("connectApp", id, wallet),
  openAppPage: (key: "grok-connectors") => ipcRenderer.invoke("openAppPage", key),
  overview: () => ipcRenderer.invoke("overview"),
  custodyAccepted: () => ipcRenderer.invoke("custodyAccepted"),
  acceptCustody: (version: unknown) => ipcRenderer.invoke("acceptCustody", version),
  copyText: (text: unknown) => ipcRenderer.invoke("copyText", text),
  openExplorer: (url: unknown) => ipcRenderer.invoke("openExplorer", url),
  openConsole: (url: unknown) => ipcRenderer.invoke("openConsole", url),
  printKit: () => ipcRenderer.invoke("printKit"),
  appInfo: () => ipcRenderer.invoke("appInfo"),
  preferences: () => ipcRenderer.invoke("preferences"),
  setCrashReports: (on: boolean) => ipcRenderer.invoke("setCrashReports", on),
  sendFeedback: () => ipcRenderer.invoke("sendFeedback"),
  showCrashReports: () => ipcRenderer.invoke("showCrashReports"),
});
