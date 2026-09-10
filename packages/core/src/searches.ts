import { mkdir, open, readFile } from "node:fs/promises";
import { dirname } from "node:path";

import { z } from "zod";

import { getVapiPaths, isMissingFile } from "./config.js";

export interface SearchEvent {
  readonly timestamp: string;
  readonly query: string;
  readonly sources: ReadonlyArray<
    Readonly<{
      source: string;
      latencyMs: number;
      count: number;
      error?: string;
    }>
  >;
  readonly mergedCount: number;
}

const searchEventSchema: z.ZodType<SearchEvent> = z.strictObject({
  timestamp: z.iso.datetime(),
  query: z.string(),
  sources: z.array(
    z.strictObject({
      source: z.string().min(1),
      latencyMs: z.number().nonnegative().finite(),
      count: z.number().int().nonnegative(),
      error: z.string().optional(),
    }),
  ),
  mergedCount: z.number().int().nonnegative(),
});

export function parseSearchEvent(value: unknown): SearchEvent {
  return searchEventSchema.parse(value);
}

export async function appendSearchEvent(
  event: SearchEvent,
  path = getVapiPaths().searches,
): Promise<SearchEvent> {
  const parsed = parseSearchEvent(event);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const handle = await open(path, "a", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(parsed)}\n`, "utf8");
  } finally {
    await handle.close();
  }
  return parsed;
}

export async function readSearchEvents(path = getVapiPaths().searches): Promise<SearchEvent[]> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isMissingFile(error)) return [];
    throw error;
  }
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line, index) => {
      try {
        return parseSearchEvent(JSON.parse(line));
      } catch (error) {
        throw new Error(`Invalid search event on JSONL line ${index + 1}.`, { cause: error });
      }
    });
}
