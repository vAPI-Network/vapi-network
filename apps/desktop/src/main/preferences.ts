import { readFile } from "node:fs/promises";
import { writeJsonAtomic } from "@vapi-network/core";
import { z } from "zod";

const preferencesSchema = z.object({ crashReports: z.boolean() });

export type Preferences = z.infer<typeof preferencesSchema>;

export async function readPreferences(path: string): Promise<Preferences> {
  try {
    return preferencesSchema.parse(JSON.parse(await readFile(path, "utf8")));
  } catch {
    return { crashReports: false };
  }
}

export async function writePreferences(path: string, preferences: Preferences): Promise<void> {
  await writeJsonAtomic(path, preferencesSchema.parse(preferences), { mode: 0o600 });
}
