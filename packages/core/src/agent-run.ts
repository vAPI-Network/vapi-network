import { randomBytes } from "node:crypto";

import { z } from "zod";

export type RunRef = {
  id: string;
  swarm?: string;
  member?: string;
  parentRunId?: string;
};

export const RUN_ID_PATTERN = /^run_[0-9a-f]{24}$/;

export function isRunId(value: unknown): value is string {
  return typeof value === "string" && RUN_ID_PATTERN.test(value);
}

export function createRunId(random: (bytes: number) => Uint8Array = randomBytes): string {
  return `run_${Buffer.from(random(12)).toString("hex")}`;
}

export const runRefSchema: z.ZodType<RunRef> = z.strictObject({
  id: z.string().regex(RUN_ID_PATTERN),
  swarm: z.string().optional(),
  member: z.string().optional(),
  parentRunId: z.string().optional(),
});
