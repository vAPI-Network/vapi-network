import { SERVER_NAME, TOML_BEGIN, TOML_END } from "./install.js";

export type TomlEntry =
  { state: "absent" } | { state: "ours"; wallet: string | null } | { state: "conflict" };

type Line = { text: string; start: number };
type ManagedBlock = { first: Line; last: Line };

const conflictMessage =
  "A vapi server is already set up in this file. Remove it or edit it by hand.";
const serverKey = `(?:${SERVER_NAME}|"${SERVER_NAME}"|'${SERVER_NAME}')`;
const table = new RegExp(`^\\s*\\[\\s*mcp_servers\\s*\\.\\s*${serverKey}\\s*[.\\]]`);
const dottedKey = new RegExp(`^\\s*mcp_servers\\s*\\.\\s*${serverKey}\\s*\\.`);
const inlineServers = /^\s*mcp_servers\s*=\s*\{/;
const inlineServer = new RegExp(`(?:[{,]\\s*)${serverKey}\\s*=`);

function linesOf(text: string): Line[] {
  const lines: Line[] = [];
  let start = 0;
  for (const line of text.split("\n")) {
    const end = Math.min(start + line.length + 1, text.length);
    lines.push({ text: line.replace(/\r$/, ""), start });
    start = end;
  }
  return lines;
}

/** Multiple, reversed or incomplete marker pairs are unsafe to edit. */
function managedBlock(lines: Line[]): ManagedBlock | "conflict" | null {
  const begins = lines.filter((line) => line.text === TOML_BEGIN);
  const ends = lines.filter((line) => line.text === TOML_END);
  if (begins.length === 0 && ends.length === 0) return null;
  const first = begins[0];
  const last = ends[0];
  if (begins.length !== 1 || ends.length !== 1 || !first || !last || first.start >= last.start) {
    return "conflict";
  }
  return { first, last };
}

function hasUnmanagedServer(lines: Line[], block: ManagedBlock | null): boolean {
  return lines.some((line) => {
    if (block && line.start >= block.first.start && line.start <= block.last.start) return false;
    return (
      table.test(line.text) ||
      dottedKey.test(line.text) ||
      (inlineServers.test(line.text) && inlineServer.test(line.text))
    );
  });
}

export function readTomlEntry(text: string): TomlEntry {
  const lines = linesOf(text);
  const block = managedBlock(lines);
  if (block === "conflict" || hasUnmanagedServer(lines, block)) return { state: "conflict" };
  if (!block) return { state: "absent" };
  for (const line of lines) {
    if (line.start <= block.first.start || line.start >= block.last.start) continue;
    const wallet = /^\s*VAPI_DESKTOP_WALLET\s*=\s*("(?:[^"\\]|\\.)*")\s*(?:#.*)?$/.exec(
      line.text,
    )?.[1];
    if (wallet !== undefined) {
      try {
        return { state: "ours", wallet: JSON.parse(wallet) as string };
      } catch {
        return { state: "ours", wallet: null };
      }
    }
  }
  return { state: "ours", wallet: null };
}

/** Replace only our marked lines, or append after one blank line. */
export function writeTomlEntry(text: string, block: string): string {
  if (readTomlEntry(text).state === "conflict") throw new Error(conflictMessage);
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  const replacement = block.replace(/\r?\n/g, newline).replace(/(?:\r?\n)+$/, "");
  const existing = managedBlock(linesOf(text));
  if (existing && existing !== "conflict") {
    // Keep the existing end marker's line terminator (including absence of one).
    const end = existing.last.start + existing.last.text.length;
    return text.slice(0, existing.first.start) + replacement + text.slice(end);
  }
  if (text.length === 0) return replacement + newline;
  const terminated = text.endsWith("\n") ? text : text + newline;
  const separator = terminated.endsWith(newline + newline) ? "" : newline;
  return terminated + separator + replacement + newline;
}
