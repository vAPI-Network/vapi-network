#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = "vAPI-Network/vapi-network";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function filename(value) {
  if (
    typeof value !== "string" ||
    !value ||
    value === "." ||
    value === ".." ||
    /[/\\]/.test(value) ||
    Array.from(value).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
  ) {
    throw new Error(`Unsafe asset filename: ${JSON.stringify(value)}`);
  }
  return value;
}

export function tagVersion(tag) {
  const version = typeof tag === "string" && tag.startsWith("desktop-v") ? tag.slice(9) : "";
  if (!versionPattern.test(version)) throw new Error("Expected tag desktop-vX.Y.Z");
  return version;
}

export function parseSha256Sums(text) {
  const sums = new Map();
  for (const line of text.split(/\r?\n/).filter((line) => line.trim())) {
    const match = /^([a-f\d]{64}) [ *](.+)$/i.exec(line);
    if (!match) throw new Error("Invalid SHA256SUMS entry");
    const name = filename(match[2]);
    if (sums.has(name)) throw new Error(`Duplicate checksum: ${name}`);
    sums.set(name, match[1].toLowerCase());
  }
  if (!sums.size) throw new Error("Empty SHA256SUMS");
  return sums;
}

function scalar(value) {
  if (value.startsWith('"')) return JSON.parse(value);
  if (value.startsWith("'")) {
    if (!value.endsWith("'")) throw new Error("Unclosed YAML string");
    return value.slice(1, -1).replaceAll("''", "'");
  }
  return value;
}

// Read electron-builder's update manifest subset without a runtime YAML dependency.
export function parseLatestYml(text) {
  let version;
  const files = [];
  let inFiles = false;
  let current;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const field = /^([A-Za-z][\w]*):(?:\s+(.*))?$/.exec(line);
    if (field) {
      if (field[1] === "version") {
        if (version !== undefined) throw new Error("Duplicate update version");
        version = scalar(field[2] ?? "");
      }
      inFiles = field[1] === "files";
      continue;
    }
    if (!inFiles) continue;
    const entry = /^\s*- url:\s+(.+)$/.exec(line);
    if (entry) {
      current = { url: filename(scalar(entry[1])) };
      files.push(current);
      continue;
    }
    const hash = /^\s+sha512:\s+(.+)$/.exec(line);
    if (hash) {
      if (!current || current.sha512) throw new Error("Unexpected or duplicate update hash");
      current.sha512 = scalar(hash[1]);
    }
  }
  if (!versionPattern.test(version ?? "") || !files.length)
    throw new Error("Missing update version or files");
  const names = new Set();
  for (const file of files) {
    if (names.has(file.url)) throw new Error(`Duplicate update file: ${file.url}`);
    names.add(file.url);
    if (
      typeof file.sha512 !== "string" ||
      !/^[A-Za-z\d+/]{86}==$/.test(file.sha512) ||
      Buffer.from(file.sha512, "base64").toString("base64") !== file.sha512
    ) {
      throw new Error(`Invalid update sha512: ${file.url}`);
    }
  }
  return { version, files };
}

async function hashes(path) {
  const sha256 = createHash("sha256");
  const sha512 = createHash("sha512");
  for await (const chunk of createReadStream(path)) {
    sha256.update(chunk);
    sha512.update(chunk);
  }
  return { sha256: sha256.digest("hex"), sha512: sha512.digest("base64") };
}

export async function verifyRelease(
  tag,
  {
    fetch: request = globalThis.fetch,
    run = spawnSync,
    platform = process.platform,
    report = console.log,
  } = {},
) {
  let failed = false;
  function check(label, ok) {
    report(`${ok ? "PASS" : "FAIL"} ${label}`);
    if (!ok) failed = true;
  }
  let dir;
  try {
    const version = tagVersion(tag);
    const resolved = run("git", ["rev-parse", `refs/tags/${tag}^{commit}`], {
      cwd: root,
      encoding: "utf8",
    });
    if (resolved.error || resolved.status !== 0) throw new Error(`Cannot resolve local tag ${tag}`);
    const commit = resolved.stdout.trim();
    check(`local tag ${tag}`, /^[a-f\d]{40,64}$/.test(commit));
    const response = await request(`https://api.github.com/repos/${repo}/releases/tags/${tag}`, {
      headers: { Accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`GitHub release: HTTP ${response.status}`);
    const release = await response.json();
    if (release.tag_name !== tag || release.draft || !Array.isArray(release.assets)) {
      throw new Error("Expected a published release for the requested tag");
    }
    check("published release tag", true);
    const assets = new Map();
    for (const asset of release.assets) {
      const name = filename(asset.name);
      if (assets.has(name)) throw new Error(`Duplicate release asset: ${name}`);
      const url = new URL(asset.browser_download_url);
      if (
        url.origin !== "https://github.com" ||
        !url.pathname.startsWith(`/${repo}/releases/download/${tag}/`)
      ) {
        throw new Error(`Unexpected download URL: ${name}`);
      }
      assets.set(name, url.href);
    }
    for (const name of ["build-info.json", "SHA256SUMS", "latest-mac.yml"]) {
      if (!assets.has(name)) throw new Error(`Missing release asset: ${name}`);
    }
    for (const ext of [".zip", ".dmg"]) {
      if (![...assets.keys()].some((name) => name.endsWith(ext)))
        throw new Error(`Missing ${ext} asset`);
    }
    dir = await mkdtemp(join(tmpdir(), "vapi-release-verify-"));
    const digests = new Map();
    for (const [name, url] of assets) {
      const download = await request(url, { signal: AbortSignal.timeout(300_000) });
      if (!download.ok || !download.body)
        throw new Error(`Download ${name}: HTTP ${download.status}`);
      const path = join(dir, name);
      await pipeline(
        Readable.fromWeb(download.body),
        createWriteStream(path, { flags: "wx", mode: 0o600 }),
      );
      digests.set(name, await hashes(path));
      check(`download ${name}`, true);
    }
    const info = JSON.parse(await readFile(join(dir, "build-info.json"), "utf8"));
    check("build-info commit matches local tag", info.commit === commit);
    check("build-info tag matches requested tag", info.tag === tag);
    const sums = parseSha256Sums(await readFile(join(dir, "SHA256SUMS"), "utf8"));
    for (const name of assets.keys()) {
      if (name !== "SHA256SUMS")
        check(`sha256 ${name}`, sums.get(name) === digests.get(name).sha256);
    }
    for (const name of sums.keys())
      check(`checksum asset exists: ${name}`, name !== "SHA256SUMS" && assets.has(name));
    const latest = parseLatestYml(await readFile(join(dir, "latest-mac.yml"), "utf8"));
    check("latest-mac.yml version matches tag", latest.version === version);
    const updateFiles = new Map(latest.files.map((file) => [file.url, file.sha512]));
    for (const name of assets.keys()) {
      if (name.endsWith(".zip") || name.endsWith(".dmg"))
        check(`sha512 ${name}`, updateFiles.get(name) === digests.get(name).sha512);
    }
    for (const file of latest.files)
      check(`update asset exists: ${file.url}`, assets.has(file.url));
    if (platform === "darwin") {
      for (const name of assets.keys()) {
        if (!name.endsWith(".dmg")) continue;
        try {
          const output = run("spctl", ["-a", "-vv", "-t", "install", join(dir, name)], {
            encoding: "utf8",
            stdio: "pipe",
          });
          // spctl writes its assessment to stderr, even on success.
          const assessment = `${output.stdout ?? ""}\n${output.stderr ?? ""}`;
          check(
            `Gatekeeper ${name}: accepted + Notarized Developer ID`,
            !output.error &&
              output.status === 0 &&
              /\baccepted\b/.test(assessment) &&
              assessment.includes("Notarized Developer ID"),
          );
        } catch (error) {
          check(`Gatekeeper ${name}: ${error.message}`, false);
        }
      }
    } else {
      report("INFO Gatekeeper assessment requires macOS");
    }
  } catch (error) {
    check(error.message, false);
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true });
  }
  return !failed;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = (await verifyRelease(process.argv[2])) ? 0 : 1;
}
