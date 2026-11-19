import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;

/**
 * Returns the body of one release from CHANGELOG.md, without its heading.
 * A release heading is `## <version>`, optionally followed by a date.
 */
export function changelogSection(changelog, version) {
  if (!VERSION.test(version)) throw new Error(`Not a release version: ${version}`);
  const lines = changelog.split(/\r?\n/u);
  const start = lines.findIndex(
    (line) => line === `## ${version}` || line.startsWith(`## ${version} `),
  );
  if (start === -1) throw new Error(`CHANGELOG.md has no section for ${version}.`);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith("## "));
  const body = (end === -1 ? rest : rest.slice(0, end)).join("\n").trim();
  if (body.length === 0) throw new Error(`The CHANGELOG.md section for ${version} is empty.`);
  return body;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const version = (process.argv[2] ?? "").replace(/^v/u, "");
    const changelog = await readFile(join(repositoryRoot, "CHANGELOG.md"), "utf8");
    console.log(changelogSection(changelog, version));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
