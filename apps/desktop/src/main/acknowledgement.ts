import { readFile } from "node:fs/promises";
import { writeJsonAtomic } from "@vapi-network/core";

import { CUSTODY_TERMS } from "../shared/custody.js";

export type Acknowledgement = {
  version: string;
  statements: readonly string[];
  acceptedAt: string;
};

/**
 * Records that the user accepted the current custody terms. Main writes its own copy of the
 * sentences; the renderer only names the version it showed, and a stale version is refused.
 */
export async function recordAcknowledgement(
  path: string,
  version: unknown,
  now = new Date(),
): Promise<Acknowledgement> {
  if (version !== CUSTODY_TERMS.version)
    throw new Error("These terms are out of date. Reopen the app.");
  const record: Acknowledgement = {
    version: CUSTODY_TERMS.version,
    statements: CUSTODY_TERMS.statements,
    acceptedAt: now.toISOString(),
  };
  await writeJsonAtomic(path, record, { mode: 0o600 });
  return record;
}

export async function readAcknowledgement(path: string): Promise<Acknowledgement | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Acknowledgement;
    return parsed.version === CUSTODY_TERMS.version ? parsed : undefined;
  } catch {
    return undefined;
  }
}
