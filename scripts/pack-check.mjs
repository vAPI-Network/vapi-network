import { execFileSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { isBuiltin } from "node:module";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const EXPECTED_VERSION = "0.2.0-dev.3";
const EXPECTED_PACKAGES = new Set([
  "@vapi-network/core",
  "@vapi-network/sources",
  "@vapi-network/mcp",
  "@vapi-network/cli",
  "vapi-network",
]);
const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const packagesRoot = join(repositoryRoot, "packages");
const packageEntries = await readdir(packagesRoot, { withFileTypes: true });
const checked = [];

for (const entry of packageEntries.sort((left, right) => left.name.localeCompare(right.name))) {
  if (!entry.isDirectory()) continue;
  const packageRoot = join(packagesRoot, entry.name);
  let sourceManifest;
  try {
    sourceManifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") continue;
    throw error;
  }
  if (sourceManifest.private === true) continue;

  const publishRoot = join(packageRoot, "publish");
  const manifest = JSON.parse(await readFile(join(publishRoot, "package.json"), "utf8"));
  const offenders = await findMarker(publishRoot, Buffer.from("workspace:"));
  if (offenders.length > 0) {
    throw new Error(
      `${manifest.name} staged files contain workspace: references: ${offenders.join(", ")}`,
    );
  }
  const leakedRuntimeImports = await findExternalRuntimeImports(publishRoot);
  if (leakedRuntimeImports.length > 0) {
    throw new Error(
      `${manifest.name} staged JavaScript contains non-Node external imports: ${leakedRuntimeImports.join(", ")}`,
    );
  }
  if (JSON.stringify(manifest.dependencies ?? {}) !== "{}") {
    throw new Error(`${manifest.name} publish manifest dependencies must equal {}.`);
  }
  for (const field of [
    "optionalDependencies",
    "peerDependencies",
    "bundleDependencies",
    "bundledDependencies",
  ]) {
    if (field in manifest) {
      throw new Error(`${manifest.name} publish manifest must not declare ${field}.`);
    }
  }
  if (manifest.version !== EXPECTED_VERSION) {
    throw new Error(
      `${manifest.name} must be version ${EXPECTED_VERSION}; received ${manifest.version}.`,
    );
  }
  if (manifest.publishConfig?.tag !== "next" || manifest.publishConfig?.access !== "public") {
    throw new Error(`${manifest.name} publishConfig must set tag=next and access=public.`);
  }

  const report = JSON.parse(
    execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts", publishRoot], {
      cwd: packageRoot,
      encoding: "utf8",
      env: { ...process.env, npm_config_cache: join(repositoryRoot, ".npm-cache") },
      stdio: ["ignore", "pipe", "inherit"],
    }),
  )[0];
  if (report.name !== manifest.name || report.version !== manifest.version) {
    throw new Error(`${manifest.name} npm pack report does not match its staged manifest.`);
  }

  checked.push({ name: report.name, version: report.version, files: report.files.length });
  console.log(
    `pack check passed (${report.name}@${report.version}, ${report.files.length} files, zero runtime dependencies)`,
  );
}

const checkedNames = new Set(checked.map(({ name }) => name));
const missing = [...EXPECTED_PACKAGES].filter((name) => !checkedNames.has(name));
if (missing.length > 0) {
  throw new Error(`Required publishable packages were not checked: ${missing.join(", ")}`);
}
console.log(`checked ${checked.length} publishable packages`);

async function findMarker(root, marker) {
  const offenders = [];
  await visit(root);
  return offenders;

  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile()) {
        const contents = await readFile(path);
        if (contents.includes(marker)) offenders.push(relative(root, path));
      }
    }
  }
}

async function findExternalRuntimeImports(root) {
  const entryPoints = [];
  await visit(join(root, "dist"));
  if (entryPoints.length === 0) return [];

  const result = await build({
    entryPoints,
    // write:false never touches disk, but esbuild still requires outdir for multiple entries.
    outdir: join(root, ".pack-check"),
    bundle: true,
    write: false,
    platform: "node",
    format: "esm",
    packages: "external",
    metafile: true,
    logLevel: "silent",
  });
  return [
    ...new Set(
      Object.values(result.metafile.outputs).flatMap((output) =>
        output.imports
          .filter((dependency) => dependency.external && !isBuiltin(dependency.path))
          .map((dependency) => dependency.path),
      ),
    ),
  ].sort();

  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && /\.[cm]?js$/.test(entry.name)) entryPoints.push(path);
    }
  }
}
