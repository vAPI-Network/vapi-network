import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { discover, type Source } from "./discovery.js";
import { appendSearchEvent, readSearchEvents } from "./searches.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("search event ledger", () => {
  it("appends events and records per-source discovery health", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vapi-searches-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "searches.jsonl");
    await appendSearchEvent(
      {
        timestamp: "2026-09-10T08:00:00.000Z",
        query: "weather",
        sources: [{ source: "manual", latencyMs: 4, count: 1 }],
        mergedCount: 1,
      },
      path,
    );
    const source: Source = {
      id: "local",
      search: async () => [
        { resource: { url: "https://api.example/weather" }, provenance: [{ source: "local" }] },
      ],
      inspect: async () => null,
    };
    const ticks = [10, 17];
    await discover([source], "forecast", {
      searchesPath: path,
      now: new Date("2026-09-10T09:00:00.000Z"),
      nowMs: () => ticks.shift() ?? 17,
    });

    await expect(readSearchEvents(path)).resolves.toEqual([
      {
        timestamp: "2026-09-10T08:00:00.000Z",
        query: "weather",
        sources: [{ source: "manual", latencyMs: 4, count: 1 }],
        mergedCount: 1,
      },
      {
        timestamp: "2026-09-10T09:00:00.000Z",
        query: "forecast",
        sources: [{ source: "local", latencyMs: 7, count: 1 }],
        mergedCount: 1,
      },
    ]);
  });
});
