import { describe, expect, it } from "vitest";

import { TOML_BEGIN, TOML_END, tomlBlock } from "./install.js";
import { readTomlEntry, writeTomlEntry } from "./toml-block.js";

const block = tomlBlock({
  shimPath: "/Applications/vAPI Desktop.app/shim",
  socketPath: "/tmp/mcp.sock",
  wallet: "claude",
});
const researchBlock = tomlBlock({
  shimPath: "/Applications/vAPI Desktop.app/shim",
  socketPath: "/tmp/mcp.sock",
  wallet: "research",
});
const original = `model = "gpt-5"

[projects."/Users/x/a"]
trust_level = "trusted"
[projects."/Users/x/b"]
trust_level = "trusted"
[projects."/Users/x/c"]
trust_level = "trusted"
`;
const conflictMessage =
  "A vapi server is already set up in this file. Remove it or edit it by hand.";

describe("managed TOML entries", () => {
  it("writes a block and final newline into an empty file", () => {
    expect(readTomlEntry("")).toEqual({ state: "absent" });
    expect(writeTomlEntry("", block)).toBe(`${block}\n`);
  });

  it("keeps every byte of a Zep-shaped config before one blank line and the block", () => {
    expect(writeTomlEntry(original, block)).toBe(`${original}\n${block}\n`);
  });

  it("adds a missing final newline before the separating blank line", () => {
    expect(writeTomlEntry(original.slice(0, -1), block)).toBe(`${original}\n${block}\n`);
  });

  it("replaces only the marked block and is idempotent", () => {
    const suffix = '\n[projects."/Users/x/after"]\ntrust_level = "trusted"\n';
    const updated = writeTomlEntry(`${original}\n${block}\n${suffix}`, researchBlock);
    expect(updated).toBe(`${original}\n${researchBlock}\n${suffix}`);
    expect(writeTomlEntry(updated, researchBlock)).toBe(updated);
  });

  it("reads the wallet inside our markers", () => {
    expect(readTomlEntry(`${original}\n${block}\n`)).toEqual({ state: "ours", wallet: "claude" });
  });

  it("reports a missing wallet inside the markers as null", () => {
    const legacy = block.replace('VAPI_DESKTOP_WALLET = "claude"\n', "");
    expect(readTomlEntry(legacy)).toEqual({ state: "ours", wallet: null });
  });

  it.each([
    "[mcp_servers.vapi]",
    '[ mcp_servers . "vapi" ]',
    "[mcp_servers.vapi.env]",
    'mcp_servers.vapi.command = "x"',
    'mcp_servers = { vapi = { command = "x" } }',
  ])("refuses an unmanaged server: %s", (entry) => {
    expect(readTomlEntry(`${original}\n${entry}\n`)).toEqual({ state: "conflict" });
    expect(() => writeTomlEntry(`${original}\n${entry}\n`, block)).toThrow(
      new Error(conflictMessage),
    );
    expect(readTomlEntry(`${block}\n${entry}\n`)).toEqual({ state: "conflict" });
  });

  it.each(["[mcp_servers.vapi-other]", "[mcp_servers.vapix]"])(
    "allows a different server: %s",
    (entry) => {
      expect(readTomlEntry(entry)).toEqual({ state: "absent" });
      expect(writeTomlEntry(entry, block)).toBe(`${entry}\n\n${block}\n`);
    },
  );

  it("refuses a begin marker without an end marker", () => {
    const text = `${original}\n${TOML_BEGIN}\n[mcp_servers.vapi]\n`;
    expect(readTomlEntry(text)).toEqual({ state: "conflict" });
    expect(() => writeTomlEntry(text, block)).toThrow(new Error(conflictMessage));
  });

  it("writes, reads and replaces blocks using the file's CRLF endings", () => {
    const crlfOriginal = original.replaceAll("\n", "\r\n");
    const written = writeTomlEntry(crlfOriginal, block);
    expect(written).toBe(`${crlfOriginal}\r\n${block.replaceAll("\n", "\r\n")}\r\n`);
    expect(readTomlEntry(written)).toEqual({ state: "ours", wallet: "claude" });
    expect(writeTomlEntry(written, researchBlock)).toBe(
      `${crlfOriginal}\r\n${researchBlock.replaceAll("\n", "\r\n")}\r\n`,
    );
  });

  it("refuses duplicate or reversed markers", () => {
    for (const text of [`${block}\n${block}\n`, `${TOML_END}\n${TOML_BEGIN}\n`]) {
      expect(readTomlEntry(text)).toEqual({ state: "conflict" });
      expect(() => writeTomlEntry(text, block)).toThrow(new Error(conflictMessage));
    }
  });
});
