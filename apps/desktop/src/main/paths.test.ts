import { describe, expect, it } from "vitest";
import { desktopPaths } from "./paths.js";

describe("desktopPaths", () => {
  it("keeps everything under one app-data directory", () => {
    const paths = desktopPaths("/Users/me/Library/Application Support");
    expect(paths.root).toBe("/Users/me/Library/Application Support/vAPI Desktop");
    expect(paths.socket).toBe("/Users/me/Library/Application Support/vAPI Desktop/mcp.sock");
    expect(paths.signerLedger).toBe(
      "/Users/me/Library/Application Support/vAPI Desktop/signer-ledger.json",
    );
    expect(paths.custody).toBe(
      "/Users/me/Library/Application Support/vAPI Desktop/custody-acknowledgement.json",
    );
  });
});
