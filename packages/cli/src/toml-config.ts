// Keep untouched TOML lines verbatim, including their original line endings.
export function removeTomlTables(contents: string, isTarget: (path: string[]) => boolean): string {
  let removing = false;
  let retained = "";
  for (const { line, table } of tomlLines(contents)) {
    if (table !== undefined) removing = isTarget(tomlKeyPath(table));
    if (!removing) retained += line;
  }
  return retained;
}

// Table-like text inside multiline TOML strings is data, never a header.
export function* tomlLines(
  contents: string,
): Generator<{ line: string; table: string | undefined }> {
  let multiline: string | undefined;
  for (const line of contents.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    yield { line, table: multiline === undefined ? tomlTableName(line) : undefined };
    for (let index = 0; index < line.length; index += 1) {
      const char = line[index];
      if (multiline !== undefined) {
        if (multiline === '"""' && char === "\\") {
          index += 1;
          continue;
        }
        if (line.startsWith(multiline, index)) {
          index += 2;
          multiline = undefined;
        }
      } else {
        if (char === "#") break;
        if (char !== "'" && char !== '"') continue;
        const delimiter = char.repeat(3);
        if (line.startsWith(delimiter, index)) {
          multiline = delimiter;
          index += 2;
        } else {
          for (index += 1; index < line.length; index += 1) {
            if (char === '"' && line[index] === "\\") index += 1;
            else if (line[index] === char) break;
          }
        }
      }
    }
  }
}

export function tomlKeyPath(table: string): string[] {
  const key = String.raw`(?:[A-Za-z0-9_-]+|"(?:[^"\\]|\\.)*"|'[^']*')`;
  const pattern = new RegExp(`^\\s*(${key})(?:\\s*\\.\\s*(${key}))*\\s*$`);
  if (!pattern.test(table)) return [];
  return [...table.matchAll(new RegExp(key, "g"))].map(([part]) => unquoteTomlKey(part));
}

export function tomlTableName(line: string): string | undefined {
  const header = line.replace(/\r?\n$/, "");
  const match = /^\s*(?:\[\[\s*(.*?)\s*\]\]|\[\s*(.*?)\s*\])\s*(?:#.*)?$/.exec(header);
  return match?.[1] ?? match?.[2];
}

export function unquoteTomlKey(key: string): string {
  if (key.startsWith("'") && key.endsWith("'")) return key.slice(1, -1);
  if (key.startsWith('"') && key.endsWith('"')) {
    try {
      return JSON.parse(key) as string;
    } catch {
      return key;
    }
  }
  return key;
}

export function tomlSeparator(contents: string): string {
  if (contents.length === 0 || /(?:\r?\n)[ \t]*(?:\r?\n)$/.test(contents)) return "";
  return /\r?\n$/.test(contents) ? "\n" : "\n\n";
}

export function escapeToml(value: string): string {
  return JSON.stringify(value).slice(1, -1);
}
