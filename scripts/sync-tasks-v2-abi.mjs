#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copy the audited Tasks V2 JSON ABIs verbatim, including events and errors.
// Usage: node scripts/sync-tasks-v2-abi.mjs <contracts/abi directory> [--check]
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import prettier from "prettier";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const target = join(root, "packages/core/src/tasks/v2-abi.generated.ts");
export const TASKS_V2_ABI_CONTRACTS = {
  escrowFactoryV2Abi: "EscrowFactoryV2",
  escrowV2Abi: "EscrowV2",
  bountyEscrowV2Abi: "BountyEscrowV2",
  disputeResolverV3Abi: "DisputeResolverV3",
  bountyPoolFactoryV1Abi: "BountyPoolFactoryV1",
  bountyPoolV1Abi: "BountyPoolV1",
  reviewerRegistryV2Abi: "ReviewerRegistryV2",
  outcomeRegistryV1Abi: "OutcomeRegistryV1",
  feeRouterV1Abi: "FeeRouterV1",
};

export async function renderTasksV2Abi(directory) {
  const blocks = [];
  for (const [name, contract] of Object.entries(TASKS_V2_ABI_CONTRACTS)) {
    const text = await readFile(join(directory, `${contract}.json`), "utf8");
    const abi = JSON.parse(text);
    if (!Array.isArray(abi) || !abi.every((entry) => typeof entry.type === "string"))
      throw new Error(`Invalid ABI: ${contract}.json`);
    const sha = createHash("sha256").update(text).digest("hex");
    blocks.push(
      `// ${contract}.json sha256: ${sha}\nexport const ${name} = ${JSON.stringify(abi)} as const;`,
    );
  }
  return prettier.format(
    [
      "// SPDX-License-Identifier: Apache-2.0",
      "// Generated from vAPI-Network/vapi-app contracts/abi at tasks-v2-audit-3 (fcc670908).",
      "// Do not edit. Refresh: node scripts/sync-tasks-v2-abi.mjs <contracts/abi directory>.",
      "// Used for chain reads, plan verification and event decoding; participant plans are hosted.",
      "",
      ...blocks,
      "",
    ].join("\n"),
    { ...((await prettier.resolveConfig(target)) ?? {}), filepath: target },
  );
}

async function main(argv) {
  const directory = argv.find((value) => !value.startsWith("--"));
  if (!directory) {
    console.error("Usage: node scripts/sync-tasks-v2-abi.mjs <contracts/abi directory> [--check]");
    return 2;
  }
  const rendered = await renderTasksV2Abi(resolve(directory));
  if (argv.includes("--check")) {
    if ((await readFile(target, "utf8")) !== rendered) {
      console.error("Tasks V2 ABI copy is stale.");
      return 1;
    }
    console.log("Tasks V2 ABI copy is current.");
    return 0;
  }
  await writeFile(target, rendered);
  console.log("Wrote packages/core/src/tasks/v2-abi.generated.ts");
  return 0;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = await main(process.argv.slice(2));
