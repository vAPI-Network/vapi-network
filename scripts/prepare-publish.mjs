import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

// npm reads package.json before prepack runs, so manifests cannot be safely
// rewritten in place. Build first, then publish the self-contained package from
// its generated publish/ directory. `files` entries are intentionally treated
// as literal top-level paths; package manifests must not use glob patterns.
const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const packagesRoot = join(repositoryRoot, "packages");
const packageDirectories = await findPublishablePackages(packagesRoot);

if (packageDirectories.length === 0) {
  throw new Error("No publishable packages found under packages/*.");
}

for (const packageRoot of packageDirectories) {
  const manifestPath = join(packageRoot, "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const publishRoot = join(packageRoot, "publish");
  const packageFiles = manifest.files;

  if (!Array.isArray(packageFiles) || packageFiles.length === 0) {
    throw new Error(`${manifest.name} must declare a non-empty files array.`);
  }
  for (const entry of packageFiles) {
    if (
      typeof entry !== "string" ||
      entry.length === 0 ||
      entry === "." ||
      entry === "publish" ||
      isAbsolute(entry) ||
      entry.includes("/") ||
      entry.includes("\\") ||
      entry.split(/[\\/]/).includes("..") ||
      ["*", "?", "[", "]"].some((marker) => entry.includes(marker))
    ) {
      throw new Error(`${manifest.name} files entries must be literal paths; received ${entry}.`);
    }
  }

  // Every runtime dependency is bundled by each package's build. The staged
  // manifest is the one npm sees, and therefore deliberately has no runtime,
  // peer, or optional dependency edges.
  manifest.dependencies = {};
  delete manifest.devDependencies;
  delete manifest.optionalDependencies;
  delete manifest.peerDependencies;
  delete manifest.peerDependenciesMeta;
  delete manifest.bundleDependencies;
  delete manifest.bundledDependencies;
  delete manifest.scripts;
  delete manifest.packageManager;
  delete manifest.private;

  const packedManifest = `${JSON.stringify(manifest, null, 2)}\n`;
  if (packedManifest.includes("workspace:")) {
    throw new Error(`${manifest.name} publish manifest still contains a workspace: reference.`);
  }

  await rm(publishRoot, { recursive: true, force: true });
  await mkdir(publishRoot, { recursive: true });
  for (const entry of packageFiles) {
    await cp(join(packageRoot, entry), join(publishRoot, entry), { recursive: true });
  }
  await cp(join(repositoryRoot, "LICENSE"), join(publishRoot, "LICENSE"));
  try {
    await cp(join(packageRoot, "README.md"), join(publishRoot, "README.md"));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    await cp(join(repositoryRoot, "README.md"), join(publishRoot, "README.md"));
  }
  await writeFile(join(publishRoot, "package.json"), packedManifest, "utf8");
  console.log(`staged ${manifest.name}@${manifest.version} at ${publishRoot}`);
}

async function findPublishablePackages(root) {
  const entries = await readdir(root, { withFileTypes: true });
  const packages = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory()) continue;
    const packageRoot = join(root, entry.name);
    let manifest;
    try {
      manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    if (manifest.private !== true) packages.push(packageRoot);
  }
  return packages;
}
