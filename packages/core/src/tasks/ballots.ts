// SPDX-License-Identifier: Apache-2.0
// Sealed jury ballots stay with the agent. The salt never leaves this machine
// until the agent itself reveals; vAPI only ever sees the commitment.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import { writeJsonAtomic } from "../atomic-file.js";
import { taskV2IndexSchema } from "./v2-write.js";

const address = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/u)
  .transform((v) => v.toLowerCase() as `0x${string}`);
const hash = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/u)
  .transform((v) => v.toLowerCase() as `0x${string}`);

/** Ballot outcomes in DisputeResolverV3 order: Worker = 0, Poster = 1, Split = 2. */
export const TASK_V2_VOTE_OUTCOMES = ["worker", "poster", "split"] as const;
export type TaskV2VoteOutcome = (typeof TASK_V2_VOTE_OUTCOMES)[number];

export const taskV2BallotSchema = z.strictObject({
  version: z.literal("vapi-tasks-ballot-v1"),
  orderId: z.uuid(),
  chainId: z.number().int().positive(),
  resolver: address,
  escrow: address,
  i: taskV2IndexSchema,
  caseId: hash,
  voter: address,
  outcome: z.union([z.literal(0), z.literal(1), z.literal(2)]),
  toWorker: z
    .string()
    .regex(/^(0|[1-9][0-9]*)$/u)
    .refine((v) => BigInt(v) < 2n ** 96n),
  salt: hash,
  commitment: hash,
  createdAt: z.iso.datetime(),
});
export type TaskV2Ballot = z.infer<typeof taskV2BallotSchema>;
export type TaskV2BallotCase = { chainId: number; resolver: string; caseId: string };

/** `<home>/tasks/ballots/<chainId>/<resolver>/<caseId>/`, next to the pending journal. */
export function taskV2BallotDirectory(home: string, key: TaskV2BallotCase): string {
  return join(
    home,
    "tasks",
    "ballots",
    String(z.number().int().positive().parse(key.chainId)),
    address.parse(key.resolver),
    hash.parse(key.caseId),
  );
}

export function taskV2BallotPath(
  home: string,
  key: TaskV2BallotCase & { commitment: string },
): string {
  return join(taskV2BallotDirectory(home, key), `${hash.parse(key.commitment)}.json`);
}

/**
 * Durable before any commit plan is requested: mode 0600, fsync of the file and
 * its directory. A crash after this write always leaves a revealable ballot.
 */
export async function writeTaskV2Ballot(home: string, ballot: TaskV2Ballot): Promise<string> {
  const parsed = taskV2BallotSchema.parse(ballot);
  const path = taskV2BallotPath(home, parsed);
  await writeJsonAtomic(path, parsed, { mode: 0o600 });
  return path;
}

async function readBallotFile(path: string): Promise<TaskV2Ballot | undefined> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const parsed = taskV2BallotSchema.safeParse(JSON.parse(text));
  return parsed.success ? parsed.data : undefined;
}

/** Lookup by the onchain commitment only: a ballot whose commit never mined is never returned. */
export async function readTaskV2Ballot(
  home: string,
  key: TaskV2BallotCase & { commitment: string; voter: string },
): Promise<TaskV2Ballot | undefined> {
  const ballot = await readBallotFile(taskV2BallotPath(home, key));
  if (
    !ballot ||
    ballot.chainId !== key.chainId ||
    ballot.resolver !== address.parse(key.resolver) ||
    ballot.caseId !== hash.parse(key.caseId) ||
    ballot.commitment !== hash.parse(key.commitment) ||
    ballot.voter !== address.parse(key.voter)
  )
    return undefined;
  return ballot;
}

/** Every intact ballot sealed for one case round, oldest first. */
export async function listTaskV2Ballots(
  home: string,
  key: TaskV2BallotCase,
): Promise<TaskV2Ballot[]> {
  const directory = taskV2BallotDirectory(home, key);
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const ballots: TaskV2Ballot[] = [];
  for (const name of names.filter((n) => /^0x[0-9a-f]{64}\.json$/u.test(n)).sort()) {
    const ballot = await readBallotFile(join(directory, name));
    if (ballot && `${ballot.commitment}.json` === name) ballots.push(ballot);
  }
  return ballots.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
