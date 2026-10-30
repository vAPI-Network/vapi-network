import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("MCP shim resource", () => {
  it("ships the wallet-aware hello shim", () => {
    const shim = readFileSync(resolve(__dirname, "../../resources/mcp-shim/shim.js"), "utf8");
    expect(shim).toContain("vapiDesktop");
    expect(shim).toContain("VAPI_DESKTOP_WALLET");
  });
});
