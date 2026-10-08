import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import {
  DEFAULT_AUTO_RELEASE_BELOW_USD,
  DEFAULT_MAX_PER_TASK_USD,
  getVapiPaths,
  isMissingFile,
} from "./config.js";
import { walletNameSchema } from "./wallet-name.js";

/**
 * The Call tools an agent profile may name when no register supplies the list.
 * `@vapi-network/mcp` builds the product schema from its action register with
 * `createAgentProfileSchema`, which holds the same names today.
 */
export const DEFAULT_AGENT_TOOLS = ["call.search", "call.inspect", "call.pay"] as const;
export const AGENT_GRANTS = ["read", "delegate", "allocate"] as const;

export type AgentGrant = (typeof AGENT_GRANTS)[number];

const agentProfileShape = {
  version: z.literal(1),
  name: walletNameSchema,
  wallet: z.string(),
  model: z.string().min(1),
  instructions: z.string().max(20_000),
  verifiedOnly: z.boolean().default(true),
  approveAboveUsd: z.number().min(0).default(0.5),
  maxPerTaskUsd: z.number().min(0).default(DEFAULT_MAX_PER_TASK_USD),
  autoReleaseBelowUsd: z.number().min(0).default(DEFAULT_AUTO_RELEASE_BELOW_USD),
  maxSteps: z.number().int().min(1).max(50).default(12),
  paused: z.boolean().default(false),
  grants: z.array(z.enum(AGENT_GRANTS)).default([]),
  createdAt: z.string(),
};

/** A profile schema that accepts exactly `toolNames` and defaults to all of them. */
export function createAgentProfileSchema(toolNames: readonly string[]) {
  if (toolNames.length === 0) {
    throw new Error("Agent profiles require at least one registered tool.");
  }
  const tools = [...toolNames] as [string, ...string[]];
  return z.object({ ...agentProfileShape, tools: z.array(z.enum(tools)).default(tools) });
}

export const agentProfileSchema = createAgentProfileSchema(DEFAULT_AGENT_TOOLS);

export type AgentProfile = z.infer<typeof agentProfileSchema>;
export type AgentProfileInput = z.input<typeof agentProfileSchema>;

export type AgentProfileParser = { parse(input: unknown): AgentProfile };

export async function readAgentProfile(
  home: string,
  name: string,
  options: { schema?: AgentProfileParser } = {},
): Promise<AgentProfile> {
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
  return (options.schema ?? agentProfileSchema).parse(JSON.parse(raw));
}

export async function writeAgentProfile(
  home: string,
  profile: AgentProfileInput,
  options: { schema?: AgentProfileParser } = {},
): Promise<void> {
  const parsed = (options.schema ?? agentProfileSchema).parse(profile);
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
  options: {
    warn?: (message: string) => void;
    schema?: AgentProfileParser;
    onInvalid?: (file: string) => void;
  } = {},
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
        (options.schema ?? agentProfileSchema).parse(
          JSON.parse(await readFile(join(directory, file), "utf8")),
        ),
      );
    } catch {
      options.onInvalid?.(file);
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
