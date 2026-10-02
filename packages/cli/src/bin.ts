#!/usr/bin/env node

import { runCli } from "./cli.js";
import { isMainModule } from "./main-module.js";

export * from "./cli.js";

if (isMainModule(process.argv[1], import.meta.url)) {
  process.exitCode = await runCli();
}
