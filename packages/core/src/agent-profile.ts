import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import { getVapiPaths, isMissingFile } from "./config.js";
import { walletNameSchema } from "./wallet-name.js";

export const agentProfileSchema = z.object({
  version: z.literal(1),
  name: walletNameSchema,
  wallet: z.string(),
  model: z.string().min(1),
  instructions: z.string().max(20_000),
  verifiedOnly: z.boolean().default(true),
  approveAboveUsd: z.number().min(0).default(0.5),
  maxSteps: z.number().int().min(1).max(50).default(12),
  tools: z
    .array(z.enum(["call.search", "call.inspect", "call.pay"]))
    .default(["call.search", "call.inspect", "call.pay"]),
  paused: z.boolean().default(false),
  createdAt: z.string(),
});

export type AgentProfile = z.infer<typeof agentProfileSchema>;
export type AgentProfileInput = z.input<typeof agentProfileSchema>;

export async function readAgentProfile(home: string, name: string): Promise<AgentProfile> {
  const path = agentProfilePath(home, name);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isMissingFile(error)) {
      throw new Error(`No agent named ${name}. Create it with vapi agent create ${name}.`);
    }
    throw error;
  }
  return agentProfileSchema.parse(JSON.parse(raw));
}

export async function writeAgentProfile(home: string, profile: AgentProfileInput): Promise<void> {
  const parsed = agentProfileSchema.parse(profile);
  const directory = getVapiPaths(home).agentsDir;
  const path = join(directory, `${parsed.name}.json`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(parsed, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  await rename(temporaryPath, path);
}

export async function listAgentProfiles(
  home: string,
  options: { warn?: (message: string) => void } = {},
): Promise<AgentProfile[]> {
  const directory = getVapiPaths(home).agentsDir;
  let files: string[];
  try {
    files = await readdir(directory);
  } catch (error) {
    if (isMissingFile(error)) return [];
    throw error;
  }

  const warn = options.warn ?? ((message: string) => console.warn(message));
  const profiles: AgentProfile[] = [];
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    try {
      profiles.push(
        agentProfileSchema.parse(JSON.parse(await readFile(join(directory, file), "utf8"))),
      );
    } catch {
      warn(`Skipping invalid agent profile ${file}.`);
    }
  }
  profiles.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  return profiles;
}

export async function removeAgentProfile(home: string, name: string): Promise<void> {
  const path = agentProfilePath(home, name);
  try {
    await unlink(path);
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }
}

function agentProfilePath(home: string, name: string): string {
  const parsedName = walletNameSchema.parse(name);
  return join(getVapiPaths(home).agentsDir, `${parsedName}.json`);
}
