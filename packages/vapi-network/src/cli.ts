#!/usr/bin/env node

import { runCli } from "@vapi-network/cli";

process.exitCode = await runCli();
