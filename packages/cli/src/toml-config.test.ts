import { describe, expect, it } from "vitest";

import { escapeToml, removeTomlTables, tomlKeyPath, tomlTableName } from "./toml-config.js";

describe("TOML table editing", () => {
  it("removes quoted keys and sub-tables while preserving other namespaces and CRLF", () => {
    const mcp = '[mcp_servers.vapi]\r\ncommand = "vapi"\r\n';
    const provider =
      '["model_providers".\'vapi\'] # comment\r\nname = "old"\r\n[model_providers.vapi.env]\r\nX = "x"\r\n';
    const other = '[profiles.other]\r\nmodel = "keep"\r\n';
    const contents = `# untouched\r\n${mcp}${provider}${other}`;
    expect(
      removeTomlTables(contents, ([root, name]) => root === "model_providers" && name === "vapi"),
    ).toBe(`# untouched\r\n${mcp}${other}`);
    expect(
      removeTomlTables(contents, ([root, name]) => root === "mcp_servers" && name === "vapi"),
    ).toBe(`# untouched\r\n${provider}${other}`);
  });

  it.each(['"""', "'".repeat(3)])(
    "preserves table-like text in multiline strings delimited by %s",
    (quote) => {
      const notes = `instructions = ${quote}\n[model_providers.vapi]\nkeep this example\n${quote}\n`;
      const source = `${notes}[model_providers.vapi]\nname = "remove"\n[profiles.other]\nmodel = "own"\n`;
      expect(
        removeTomlTables(source, ([root, name]) => root === "model_providers" && name === "vapi"),
      ).toBe(`${notes}[profiles.other]\nmodel = "own"\n`);
    },
  );

  it("keeps sibling tables, parses dotted quoted keys, and handles array tables", () => {
    const source =
      "[profiles.vapi]\na = 1\n[[profiles.vapi.tools]]\nb = 2\n[profiles.vapi_other]\nc = 3";
    expect(removeTomlTables(source, ([root, name]) => root === "profiles" && name === "vapi")).toBe(
      "[profiles.vapi_other]\nc = 3",
    );
    expect(tomlKeyPath("\"a.b\" . 'c.d'")).toEqual(["a.b", "c.d"]);
    expect(tomlKeyPath('"model_providers"."v\\u0061pi"')).toEqual(["model_providers", "vapi"]);
    expect(tomlTableName("not a header")).toBeUndefined();
    expect(tomlKeyPath("not a key")).toEqual([]);
    expect(escapeToml('a"b\\c\n')).toBe('a\\"b\\\\c\\n');
  });
});
