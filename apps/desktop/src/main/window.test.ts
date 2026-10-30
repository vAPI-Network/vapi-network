import { describe, expect, it } from "vitest";
import { windowOptions } from "./window.js";

describe("windowOptions", () => {
  it("is hardened", () => {
    const options = windowOptions("/app/preload.js");
    expect(options.webPreferences).toMatchObject({
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      preload: "/app/preload.js",
    });
    expect(options.webPreferences?.nodeIntegrationInWorker).not.toBe(true);
    expect(options.webPreferences?.allowRunningInsecureContent).not.toBe(true);
  });

  it("is a dark, inset-title-bar window like Claude Desktop", () => {
    const options = windowOptions("/app/preload.js");
    expect(options).toMatchObject({
      titleBarStyle: "hiddenInset",
      trafficLightPosition: { x: 16, y: 18 },
      backgroundColor: "#0a0a0a",
    });
  });
});
