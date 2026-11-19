import assert from "node:assert/strict";
import { test } from "node:test";

import { changelogSection } from "./changelog-section.mjs";

const CHANGELOG = [
  "# Changelog",
  "",
  "## Unreleased",
  "",
  "## 0.14.0 — 2026-11-17",
  "",
  "### Added",
  "",
  "- Native ETH withdrawals.",
  "",
  "## 0.9.7 (2026-10-26)",
  "",
  "- One payable endpoint.",
  "",
  "## 0.4.0",
  "",
  "- Wallet manager.",
  "",
  "## 0.4.0-dev.1",
  "",
  "- Preview.",
].join("\n");

test("returns the body of a release, whichever date format its heading uses", () => {
  assert.equal(changelogSection(CHANGELOG, "0.14.0"), "### Added\n\n- Native ETH withdrawals.");
  assert.equal(changelogSection(CHANGELOG, "0.9.7"), "- One payable endpoint.");
  assert.equal(changelogSection(CHANGELOG, "0.4.0"), "- Wallet manager.");
});

test("does not confuse a release with its pre-release or a longer version", () => {
  assert.equal(changelogSection(CHANGELOG, "0.4.0-dev.1"), "- Preview.");
  assert.throws(() => changelogSection(CHANGELOG, "0.14.00"), /no section/u);
  assert.throws(() => changelogSection(CHANGELOG, "0.1.0"), /no section/u);
});

test("refuses an empty section and anything that is not a version", () => {
  assert.throws(() => changelogSection("## 1.0.0\n\n## 0.9.0\n\n- x", "1.0.0"), /is empty/u);
  assert.throws(() => changelogSection(CHANGELOG, "Unreleased"), /Not a release version/u);
});
