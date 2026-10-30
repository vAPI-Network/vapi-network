// apps/desktop/src/signer/device-name.test.ts
import { describe, expect, it } from "vitest";

import { desktopDeviceName } from "./device-name.js";

const DEVICE_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;

describe("desktopDeviceName", () => {
  it("names the device after the Mac, without the .local suffix", () => {
    expect(desktopDeviceName("Ada-MacBook-Pro.local")).toBe("vapi-desktop-ada-macbook-pro");
    expect(desktopDeviceName("Ada's iMac")).toBe("vapi-desktop-ada-s-imac");
  });

  it("always fits the console's device pattern", () => {
    for (const host of ["a-very-long-hostname-for-the-mac-studio-in-the-office", "--", ""]) {
      const name = desktopDeviceName(host);
      expect(name).toMatch(DEVICE_PATTERN);
      expect(name.endsWith("-")).toBe(false);
    }
    expect(desktopDeviceName("")).toBe("vapi-desktop-mac");
  });
});
