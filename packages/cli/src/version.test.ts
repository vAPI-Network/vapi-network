import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { CLI_VERSION } from "./version";

describe("CLI_VERSION", () => {
  it("matches the package manifest so `vapi --version` never lies", async () => {
    const manifest = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version: string };
    expect(CLI_VERSION).toBe(manifest.version);
  });
});
