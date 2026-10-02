import { askDocs, readDocs, searchDocs } from "@vapi-network/core";

import {
  UsageError,
  getEnvironment,
  output,
  parseArguments,
  requiredPositional,
  type CliDependencies,
  type CliIo,
} from "./cli.js";

const DOCS_USAGE =
  'Usage: vapi docs "<question>", vapi docs search "<query>", or vapi docs read <url-or-path> [--json].';

export async function docsCommand(
  argv: string[],
  json: boolean,
  io: CliIo,
  dependencies: CliDependencies,
): Promise<void> {
  if (argv[0] === "search") {
    await docsSearchCommand(argv.slice(1), json, io, dependencies);
    return;
  }
  if (argv[0] === "read") {
    await docsReadCommand(argv.slice(1), json, io, dependencies);
    return;
  }
  if (argv[0] === undefined) throw new UsageError(DOCS_USAGE);
  await docsAskCommand(argv, json, io, dependencies);
}

async function docsAskCommand(
  argv: string[],
  json: boolean,
  io: CliIo,
  dependencies: CliDependencies,
): Promise<void> {
  const parsed = parseArguments(argv, { valueOptions: new Set(), maximumPositionals: 1 });
  const question = requiredPositional(parsed.positionals[0], "<question>", DOCS_USAGE);
  const result = await askDocs(question, requestOptions(dependencies));
  output(
    io,
    json,
    result,
    [
      result.answer,
      ...(result.sources.length === 0
        ? []
        : ["", "Sources:", ...result.sources.map((source) => `- ${source.title}: ${source.url}`)]),
    ].join("\n"),
  );
}

async function docsSearchCommand(
  argv: string[],
  json: boolean,
  io: CliIo,
  dependencies: CliDependencies,
): Promise<void> {
  const parsed = parseArguments(argv, { valueOptions: new Set(), maximumPositionals: 1 });
  const query = requiredPositional(parsed.positionals[0], "<query>", DOCS_USAGE);
  const result = await searchDocs(query, requestOptions(dependencies));
  output(
    io,
    json,
    result,
    result.results
      .map(({ title, url, excerpt }) => `${title}\n${url}\n${shortExcerpt(excerpt)}`)
      .join("\n\n"),
  );
}

async function docsReadCommand(
  argv: string[],
  json: boolean,
  io: CliIo,
  dependencies: CliDependencies,
): Promise<void> {
  const parsed = parseArguments(argv, { valueOptions: new Set(), maximumPositionals: 1 });
  const page = requiredPositional(parsed.positionals[0], "<url-or-path>", DOCS_USAGE);
  const result = await readDocs(page, requestOptions(dependencies));
  output(io, json, result, result.markdown);
}

function requestOptions(dependencies: CliDependencies) {
  return {
    env: getEnvironment(dependencies),
    ...(dependencies.fetchImpl === undefined ? {} : { fetchImpl: dependencies.fetchImpl }),
  };
}

function shortExcerpt(value: string): string {
  const oneLine = value.replace(/\s+/gu, " ").trim();
  return oneLine.length <= 240 ? oneLine : `${oneLine.slice(0, 239).trimEnd()}…`;
}
