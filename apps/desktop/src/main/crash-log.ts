import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { english } from "viem/accounts";

const recoveryWords = new Set(english);

function scrubWords(text: string): string {
  type Run = { start: number; end: number; count: number };
  const runs: Run[] = [];
  let run: Run | undefined;
  for (const match of text.matchAll(/\b[a-z]+\b/gi)) {
    if (!recoveryWords.has(match[0].toLowerCase())) {
      run = undefined;
      continue;
    }
    // Pasted Kits separate words with spaces, commas or line breaks.
    if (run && /^[\s,]+$/.test(text.slice(run.end, match.index))) {
      run.end = match.index + match[0].length;
      run.count++;
    } else {
      run = { start: match.index, end: match.index + match[0].length, count: 1 };
      runs.push(run);
    }
  }
  let result = "";
  let cursor = 0;
  for (const { start, end, count } of runs) {
    if (count < 4) continue;
    result += `${text.slice(cursor, start)}<words>`;
    cursor = end;
  }
  return result + text.slice(cursor);
}

export type CrashKind =
  | "main-exception"
  | "main-rejection"
  | "renderer-gone"
  | "child-gone"
  | "signer-exit"
  | "mcp-host-exit";

export function scrub(text: string, home: string): string {
  const escapedHome = home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const redacted = text
    .replace(/\bBearer\s+[^\s,;]+/gi, "<token>")
    .replace(/\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "<token>")
    .replace(/\bvapi_[A-Za-z0-9]+\b/g, "<token>")
    .replace(/\b0x[0-9a-f]{64,}\b/gi, "<hex>")
    .replace(/\b0x[0-9a-f]{40}\b/gi, "<address>")
    .replace(/\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g, "<address>")
    .replace(/file:\/\/(?=\/)/g, "")
    .replace(new RegExp(`${escapedHome}(?=$|[\\s/"')])`, "g"), "~")
    .replace(/(["'])\/[^\n]*?\1/g, "$1<path>$1")
    .replace(/(?<![\w~:/])\/[^\s"'`<>()[\]{},;:]+/g, "<path>");
  return scrubWords(redacted);
}

function reportDetail(kind: CrashKind, detail: unknown, home: string): unknown {
  if (detail instanceof Error) {
    return {
      name: scrub(detail.name, home),
      message: scrub(detail.message, home),
      ...(typeof detail.stack === "string" ? { stack: scrub(detail.stack, home) } : {}),
    };
  }
  if (typeof detail === "string") return scrub(detail, home);
  if (kind === "main-exception" || kind === "main-rejection") return "Unknown error.";
  if (detail !== null && typeof detail === "object") {
    return {
      ...("exitCode" in detail &&
      typeof detail.exitCode === "number" &&
      Number.isFinite(detail.exitCode)
        ? { exitCode: detail.exitCode }
        : {}),
      ...("reason" in detail && typeof detail.reason === "string"
        ? { reason: scrub(detail.reason, home) }
        : {}),
    };
  }
  return {};
}

export function createCrashLog({
  dir,
  home,
  version,
  enabled,
  now = () => new Date(),
  maxEntries = 200,
}: {
  dir: string;
  home: string;
  version: string;
  enabled: () => boolean;
  now?: () => Date;
  maxEntries?: number;
}): { record(kind: CrashKind, detail: unknown): Promise<void> } {
  const path = join(dir, "crash-reports.jsonl");
  let pending = Promise.resolve();

  return {
    async record(kind, detail) {
      try {
        if (!enabled()) return;
      } catch {
        return;
      }
      // Serialize read/trim/write so simultaneous process failures cannot lose reports.
      pending = pending
        .then(async () => {
          if (!enabled()) return;
          const entry = {
            at: now().toISOString(),
            kind,
            version,
            detail: reportDetail(kind, detail, home),
          };
          await mkdir(dir, { recursive: true, mode: 0o700 });
          await chmod(dir, 0o700);
          let lines: string[] = [];
          try {
            lines = (await readFile(path, "utf8")).split("\n").filter(Boolean);
            await chmod(path, 0o600);
          } catch (error) {
            if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
              throw error;
          }
          lines.push(JSON.stringify(entry));
          await writeFile(path, `${lines.slice(-maxEntries).join("\n")}\n`, { mode: 0o600 });
        })
        .catch(() => undefined);
      return pending;
    },
  };
}
