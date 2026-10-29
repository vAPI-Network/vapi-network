import { readFile } from "node:fs/promises";

import { DEFAULT_SPEND_CAPS, VAPI_CLIENT_VERSION } from "@vapi-network/core";
import { describe, expect, it } from "vitest";

// SKILL.md ships in the npm package and is served at vapinetwork.ai/SKILL.md.
// Its setup step tells an agent to update when the CLI and skill versions
// differ, so the frontmatter version has to move with every release.
const skill = await readFile(new URL("../SKILL.md", import.meta.url), "utf8");
const manifest = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
) as { version: string; files: string[] };

function frontmatter(source: string): Record<string, string> {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(source);
  if (!match) throw new Error("SKILL.md has no frontmatter.");
  const fields: Record<string, string> = {};
  for (const line of match[1]!.split("\n")) {
    const field = /^([a-z]+):\s*(.*)$/.exec(line);
    if (field) fields[field[1]!] = field[2]!;
  }
  return fields;
}

function usd(atomic: string): string {
  return `$${(Number(atomic) / 1_000_000).toFixed(2)}`;
}

describe("SKILL.md", () => {
  it("carries the package version and ships with the package", () => {
    const fields = frontmatter(skill);
    expect(fields.name).toBe("vapi");
    expect(fields.version).toBe(manifest.version);
    expect(fields.version).toBe(VAPI_CLIENT_VERSION);
    expect(manifest.files).toContain("SKILL.md");
  });

  it("states the default spend caps the CLI applies", () => {
    expect(skill).toContain(
      `${usd(DEFAULT_SPEND_CAPS.perCallAtomic)} per call and ${usd(DEFAULT_SPEND_CAPS.perDayAtomic)} per day`,
    );
  });

  it("names the error codes the CLI returns", () => {
    for (const code of [
      "spend_cap_exceeded",
      "per_call_cap_exceeded",
      "per_day_cap_exceeded",
      "max_price_exceeded",
      "settlement_unknown",
      "payment_rejected",
      "response_unreadable",
      "unsupported_network",
    ]) {
      expect(skill).toContain(`\`${code}\``);
    }
  });
});
