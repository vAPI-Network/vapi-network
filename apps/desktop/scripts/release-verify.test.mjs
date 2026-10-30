import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { parseLatestYml, parseSha256Sums, tagVersion, verifyRelease } from "./release-verify.mjs";

const zip = "vAPI-Desktop-0.1.0-arm64-mac.zip";
const dmg = "vAPI Desktop-0.1.0-arm64.dmg";
const sha512 = Buffer.alloc(64, 1).toString("base64");
const latest = `version: 0.1.0
files:
  - url: ${zip}
    sha512: ${sha512}
    size: 123
  - url: '${dmg}'
    sha512: "${sha512}"
    size: 456
path: ${zip}
sha512: ${sha512}
releaseDate: '2026-10-28T12:00:00.000Z'
stagingPercentage: 10
`;

test("parses sha256 sums for text and binary files, preserving spaces", () => {
  assert.deepEqual(
    parseSha256Sums(`${"a".repeat(64)}  ${zip}\n${"B".repeat(64)} *${dmg}\n`),
    new Map([
      [zip, "a".repeat(64)],
      [dmg, "b".repeat(64)],
    ]),
  );
});

test("rejects malformed, duplicate, empty or unsafe checksum entries", () => {
  for (const text of [
    "",
    `abc  ${zip}`,
    `${"a".repeat(64)}  ../file.zip`,
    `${"a".repeat(64)}  dir\\file.zip`,
    `${"a".repeat(64)}  ${zip}\n${"b".repeat(64)}  ${zip}`,
  ]) {
    assert.throws(() => parseSha256Sums(text));
  }
});

test("parses electron-builder's version and two file hashes", () => {
  assert.deepEqual(parseLatestYml(latest), {
    version: "0.1.0",
    files: [
      { url: zip, sha512 },
      { url: dmg, sha512 },
    ],
  });
  assert.equal(parseLatestYml(latest.replace(/^ {2}/gm, "")).files.length, 2);
});

test("rejects incomplete or unsafe update metadata", () => {
  for (const text of [
    "",
    latest.replace("version: 0.1.0\n", ""),
    latest.replace(`    sha512: ${sha512}\n`, ""),
    latest.replace(zip, "../file.zip"),
    latest.replace(dmg, zip),
    latest.replace(sha512, "bad-hash"),
  ]) {
    assert.throws(() => parseLatestYml(text));
  }
});

test("extracts only stable desktop release versions", () => {
  assert.equal(tagVersion("desktop-v0.1.0"), "0.1.0");
  for (const tag of [
    "v0.1.0",
    "desktop-v0.1",
    "desktop-v01.1.0",
    "desktop-v0.1.0-beta.1",
    "desktop-v0.1.0\n",
  ]) {
    assert.throws(() => tagVersion(tag));
  }
});

// Exercise the verifier with release bytes, without network or signing tools.
const commit = "a".repeat(40);
const digest = (value, algorithm, encoding) => createHash(algorithm).update(value).digest(encoding);

function fixture({ info = {}, updateVersion = "0.1.0", corrupt, missing } = {}) {
  const content = new Map([
    [zip, "zip bytes"],
    [dmg, "dmg bytes"],
  ]);
  const yml = `version: ${updateVersion}\nfiles:\n${[...content]
    .map(
      ([name, bytes]) => `  - url: '${name}'\n    sha512: ${digest(bytes, "sha512", "base64")}\n`,
    )
    .join("")}`;
  content.set("latest-mac.yml", yml);
  content.set("build-info.json", JSON.stringify({ commit, tag: "desktop-v0.1.0", ...info }));
  content.set(
    "SHA256SUMS",
    [...content].map(([name, bytes]) => `${digest(bytes, "sha256", "hex")}  ${name}\n`).join(""),
  );
  if (corrupt) content.set(corrupt, "tampered bytes");
  if (missing) content.delete(missing);
  const base = "https://github.com/vAPI-Network/vapi-network/releases/download/desktop-v0.1.0/";
  return async (url) => {
    if (url.startsWith("https://api.github.com/")) {
      assert.equal(
        url,
        "https://api.github.com/repos/vAPI-Network/vapi-network/releases/tags/desktop-v0.1.0",
      );
      return Response.json({
        tag_name: "desktop-v0.1.0",
        draft: false,
        assets: [...content.keys()].map((name) => ({
          name,
          browser_download_url: base + encodeURIComponent(name),
        })),
      });
    }
    const name = decodeURIComponent(new URL(url).pathname.split("/").at(-1));
    return new Response(content.get(name), { status: content.has(name) ? 200 : 404 });
  };
}

test("verifies release provenance, every checksum, update hashes and macOS assessment", async () => {
  const lines = [];
  const commands = [];
  assert.equal(
    await verifyRelease("desktop-v0.1.0", {
      fetch: fixture(),
      platform: "darwin",
      report: (line) => lines.push(line),
      run(command, args) {
        commands.push([command, args]);
        return command === "git"
          ? { stdout: `${commit}\n`, status: 0 }
          : { stdout: "", stderr: "accepted\nsource=Notarized Developer ID", status: 0 };
      },
    }),
    true,
  );
  assert.ok(lines.includes(`PASS sha256 ${zip}`));
  assert.ok(lines.includes(`PASS sha512 ${dmg}`));
  assert.ok(lines.some((line) => line.startsWith("PASS Gatekeeper")));
  assert.equal(commands[0][1][1], "refs/tags/desktop-v0.1.0^{commit}");
  assert.deepEqual(commands[1][1].slice(0, 4), ["-a", "-vv", "-t", "install"]);
  assert.ok(commands[1][1][4].endsWith(`/${dmg}`));
});

test("fails closed for mismatched provenance, tampering, version and missing assets", async () => {
  for (const options of [
    { info: { commit: "b".repeat(40) } },
    { info: { tag: "desktop-v0.2.0" } },
    { corrupt: zip },
    { updateVersion: "0.2.0" },
    { missing: dmg },
    { missing: "SHA256SUMS" },
  ]) {
    const lines = [];
    assert.equal(
      await verifyRelease("desktop-v0.1.0", {
        fetch: fixture(options),
        run: () => ({ stdout: commit, status: 0 }),
        platform: "linux",
        report: (line) => lines.push(line),
      }),
      false,
    );
    assert.ok(lines.some((line) => line.startsWith("FAIL")));
  }
});

test("requires Gatekeeper acceptance and notarization together", async () => {
  for (const result of [
    { status: 0, stderr: "accepted\nsource=Developer ID" },
    { status: 0, stderr: "rejected\nsource=Notarized Developer ID" },
    { status: 1, stderr: "accepted\nsource=Notarized Developer ID" },
  ]) {
    assert.equal(
      await verifyRelease("desktop-v0.1.0", {
        fetch: fixture(),
        platform: "darwin",
        report() {},
        run: (command) => (command === "git" ? { stdout: commit, status: 0 } : result),
      }),
      false,
    );
  }
});

test("reports an unavailable release as failure", async () => {
  assert.equal(
    await verifyRelease("desktop-v0.1.0", {
      fetch: async () => new Response("missing", { status: 404 }),
      run: () => ({ stdout: commit, status: 0 }),
      platform: "linux",
      report() {},
    }),
    false,
  );
});
