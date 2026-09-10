#!/usr/bin/env node

import { pathToFileURL } from "node:url";

import { runCli } from "./cli.js";

export * from "./cli.js";

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : undefined;
if (invokedPath === import.meta.url) {
  process.exitCode = await runCli();
}
