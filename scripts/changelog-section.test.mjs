import assert from "node:assert/strict";
import { test } from "node:test";

import { changelogSection, releaseNotes } from "./changelog-section.mjs";

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

test("release notes end with the install command, the npm page and the comparison", () => {
  const notes = releaseNotes(CHANGELOG, "0.14.0", "v0.9.7");
  assert.ok(notes.startsWith("### Added\n\n- Native ETH withdrawals."));
  assert.ok(notes.includes("Install: `npm i -g vapi-network@0.14.0`"));
  assert.ok(notes.includes("https://www.npmjs.com/package/vapi-network/v/0.14.0"));
  assert.ok(
    notes.endsWith(
      "[Changes since v0.9.7](https://github.com/vAPI-Network/vapi-network/compare/v0.9.7...v0.14.0)",
    ),
  );
});

test("release notes leave the comparison out without a previous tag and refuse a bad one", () => {
  assert.ok(!releaseNotes(CHANGELOG, "0.14.0").includes("compare"));
  assert.ok(!releaseNotes(CHANGELOG, "0.14.0", "").includes("compare"));
  assert.throws(() => releaseNotes(CHANGELOG, "0.14.0", "main"), /Not a release tag/u);
});
