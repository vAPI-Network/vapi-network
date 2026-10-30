import { describe, expect, it } from "vitest";
import { desktopPaths } from "./paths.js";

describe("desktopPaths", () => {
  it("keeps everything under one app-data directory", () => {
    const paths = desktopPaths("/Users/zep/Library/Application Support");
    expect(paths.root).toBe("/Users/zep/Library/Application Support/vAPI Desktop");
    expect(paths.socket).toBe("/Users/zep/Library/Application Support/vAPI Desktop/mcp.sock");
    expect(paths.signerLedger).toBe(
      "/Users/zep/Library/Application Support/vAPI Desktop/signer-ledger.json",
    );
    expect(paths.custody).toBe(
      "/Users/zep/Library/Application Support/vAPI Desktop/custody-acknowledgement.json",
    );
  });
});
