import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { localFileSource } from "./local-file.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("local file source", () => {
  it("reads, searches, and inspects a JSON listing array with local provenance", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vapi-sources-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "listings.json");
    await writeFile(
      path,
      JSON.stringify([
        {
          resource: { url: "https://example.com/weather" },
          name: "Weather data",
          method: "GET",
          provenance: [{ source: "author", ref: "weather" }],
        },
        { resource: "https://example.com/prices", name: "Prices" },
        { resource: "not a URL" },
      ]),
    );

    const source = localFileSource(path);
    await expect(source.search("weather")).resolves.toHaveLength(1);
    await expect(source.inspect("0")).resolves.toMatchObject({
      resource: { url: "https://example.com/weather" },
      provenance: [
        { source: "author", ref: "weather" },
        { source: "local", sourceUrl: path, ref: "0" },
      ],
    });
    await expect(source.inspect("https://example.com/prices")).resolves.toMatchObject({
      name: "Prices",
    });
  });

  it("rejects a non-array document", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vapi-sources-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "listings.json");
    await writeFile(path, "{}", "utf8");

    await expect(localFileSource(path).search()).rejects.toThrow("must contain a JSON array");
  });
});
