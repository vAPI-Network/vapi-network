#!/usr/bin/env node

import { runCliWithUpdateCheck } from "@vapi-network/cli";

process.exitCode = await runCliWithUpdateCheck();
