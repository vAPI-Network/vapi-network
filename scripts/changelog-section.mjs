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

const REPOSITORY_URL = "https://github.com/vAPI-Network/vapi-network";

/**
 * The body of a GitHub release: the changelog section, then one line with the
 * install command, the npm page and, when the previous tag is known, the
 * comparison with it.
 */
export function releaseNotes(changelog, version, previousTag) {
  const links = [
    `Install: \`npm i -g vapi-network@${version}\``,
    `[npm](https://www.npmjs.com/package/vapi-network/v/${version})`,
  ];
  if (previousTag !== undefined && previousTag.length > 0) {
    if (!VERSION.test(previousTag.replace(/^v/u, ""))) {
      throw new Error(`Not a release tag: ${previousTag}`);
    }
    links.push(
      `[Changes since ${previousTag}](${REPOSITORY_URL}/compare/${previousTag}...v${version})`,
    );
  }
  return `${changelogSection(changelog, version)}\n\n---\n\n${links.join(" · ")}`;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [tag = "", mode, previousTag] = process.argv.slice(2);
    const version = tag.replace(/^v/u, "");
    const changelog = await readFile(join(repositoryRoot, "CHANGELOG.md"), "utf8");
    console.log(
      mode === "--release"
        ? releaseNotes(changelog, version, previousTag)
        : changelogSection(changelog, version),
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
