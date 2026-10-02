import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const stylePath = join(repositoryRoot, "docs", "STYLE.md");

try {
  const style = await readFile(stylePath, "utf8");
  const bannedParagraph = style
    .split(/\n\s*\n/)
    .find((paragraph) => paragraph.trimStart().startsWith("Banned words:"));

  if (!bannedParagraph) {
    throw new Error("docs/STYLE.md is missing the Banned words: paragraph.");
  }

  const joinedParagraph = bannedParagraph
    .split(/\r?\n/)
    .map((line) => line.trim())
    .join(" ");
  const prefix = "Banned words:";
  const paragraphText = joinedParagraph.slice(prefix.length).trim();
  const periodIndex = paragraphText.indexOf(".");

  if (periodIndex === -1) {
    throw new Error("docs/STYLE.md has no terminating period for the Banned words: paragraph.");
  }

  const bannedWords = paragraphText
    .slice(0, periodIndex)
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  const patterns = bannedWords.map((entry) => ({
    label: "banned word",
    regex: new RegExp(`\\b${entry.split(/[- ]+/).map(escapeRegex).join("[ -]")}\\b`, "gi"),
  }));
  const files = await collectFiles();
  const hits = [];

  for (const file of files) {
    const source = await readFile(file, "utf8");
    const lines = maskCode(source.split(/\r?\n/));
    const displayPath = relative(repositoryRoot, file);

    lines.forEach((line, lineIndex) => {
      for (const pattern of patterns) {
        pattern.regex.lastIndex = 0;
        let match;
        while ((match = pattern.regex.exec(line)) !== null) {
          hits.push({
            file: displayPath,
            line: lineIndex + 1,
            column: match.index,
            label: pattern.label,
            text: match[0],
          });
        }
      }

      for (let column = 0; column < line.length; column += 1) {
        if (line[column] === "—") {
          hits.push({
            file: displayPath,
            line: lineIndex + 1,
            column,
            label: "em dash",
            text: "—",
          });
        }
      }
    });
  }

  hits.sort(
    (left, right) =>
      left.file.localeCompare(right.file) ||
      left.line - right.line ||
      left.column - right.column ||
      left.label.localeCompare(right.label),
  );

  if (hits.length === 0) {
    console.log("Copy lint passed.");
  } else {
    for (const hit of hits) {
      console.log(`${hit.file}:${hit.line}: ${hit.label}: ${hit.text}`);
    }
    console.log(`Total: ${hits.length} hits.`);
    process.exitCode = 1;
  }
} catch (error) {
  console.error(`Copy lint failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 2;
}

async function collectFiles() {
  const files = [];
  await addFile(join(repositoryRoot, "README.md"), files);
  await addDirectMarkdown(join(repositoryRoot, "docs"), files);
  await addPackageReadmes(files);
  await addDirectMarkdown(join(repositoryRoot, "examples"), files);
  return files
    .filter((file) => relative(repositoryRoot, file) !== "docs/STYLE.md")
    .sort((left, right) =>
      relative(repositoryRoot, left).localeCompare(relative(repositoryRoot, right)),
    );
}

async function addPackageReadmes(files) {
  let entries;
  try {
    entries = await readdir(join(repositoryRoot, "packages"), { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }

  for (const entry of entries) {
    if (entry.isDirectory()) {
      await addFile(join(repositoryRoot, "packages", entry.name, "README.md"), files);
    }
  }
}

async function addDirectMarkdown(directory, files) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }

  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(join(directory, entry.name));
    }
  }
}

async function addFile(file, files) {
  try {
    await readFile(file);
    files.push(file);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function maskCode(lines) {
  let fenceCharacter = null;

  return lines.map((line) => {
    const fence = line.match(/^\s*(`{3,}|~{3,})/);
    if (fenceCharacter !== null) {
      if (fence?.[1][0] === fenceCharacter) fenceCharacter = null;
      return "";
    }
    if (fence) {
      fenceCharacter = fence[1][0];
      return "";
    }
    return maskInlineCode(line);
  });
}

function maskInlineCode(line) {
  let result = line;
  let cursor = 0;

  while (cursor < result.length) {
    const openStart = result.indexOf("`", cursor);
    if (openStart === -1) break;
    const runLength = countBackticks(result, openStart);
    const closeStart = findClosingRun(result, openStart + runLength, runLength);
    if (closeStart === -1) {
      cursor = openStart + runLength;
      continue;
    }
    const spanLength = closeStart + runLength - openStart;
    result = `${result.slice(0, openStart)}${" ".repeat(spanLength)}${result.slice(openStart + spanLength)}`;
    cursor = openStart + spanLength;
  }

  return result;
}

function countBackticks(line, start) {
  let end = start;
  while (end < line.length && line[end] === "`") end += 1;
  return end - start;
}

function findClosingRun(line, start, runLength) {
  let cursor = start;
  while (cursor < line.length) {
    const candidate = line.indexOf("`", cursor);
    if (candidate === -1) return -1;
    const candidateLength = countBackticks(line, candidate);
    if (candidateLength === runLength) return candidate;
    cursor = candidate + candidateLength;
  }
  return -1;
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
