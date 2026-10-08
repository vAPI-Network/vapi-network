import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { TASKS_CLIENT_VERBS } from "./verbs.js";

describe("task client verbs", () => {
  it("matches the documented verb table", () => {
    const docs = readFileSync(new URL("../../../../docs/tasks.md", import.meta.url), "utf8");
    const lines = docs.split("\n");
    const headerIndex = lines.findIndex(
      (line) =>
        line
          .split("|")
          .map((cell) => cell.trim())
          .filter(Boolean)
          .join(" | ") === "Verb | What it does | Moves money",
    );
    expect(headerIndex).toBeGreaterThanOrEqual(0);

    const tableLines = lines.slice(headerIndex + 2);
    const tableEnd = tableLines.findIndex((line) => !line.trim().startsWith("|"));
    const documentedVerbs = tableLines
      .slice(0, tableEnd < 0 ? undefined : tableEnd)
      .map((line) => line.split("|")[1]?.replaceAll("`", "").trim())
      .filter((verb): verb is string => Boolean(verb));

    expect(documentedVerbs).toEqual([...TASKS_CLIENT_VERBS]);
  });
});
