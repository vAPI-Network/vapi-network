// SPDX-License-Identifier: Apache-2.0
// Event schemas extracted from vAPI-Network/vapi-app, tasks-v2-audit-3.
import { decodeEventLog, type Hex } from "viem";
import {
  escrowFactoryV2Abi,
  escrowV2Abi,
  bountyEscrowV2Abi,
  disputeResolverV3Abi,
  bountyPoolFactoryV1Abi,
  bountyPoolV1Abi,
  reviewerRegistryV2Abi,
  outcomeRegistryV1Abi,
  feeRouterV1Abi,
} from "./v2-abi.js";

export const TASKS_V2_EVENT_ABIS = {
  EscrowFactoryV2: escrowFactoryV2Abi,
  EscrowV2: escrowV2Abi,
  BountyEscrowV2: bountyEscrowV2Abi,
  DisputeResolverV3: disputeResolverV3Abi,
  BountyPoolFactoryV1: bountyPoolFactoryV1Abi,
  BountyPoolV1: bountyPoolV1Abi,
  ReviewerRegistryV2: reviewerRegistryV2Abi,
  OutcomeRegistryV1: outcomeRegistryV1Abi,
  FeeRouterV1: feeRouterV1Abi,
} as const;

/** The caller supplies the verified emitting contract kind; malformed/unknown logs throw. */
export function decodeTaskV2Event(
  contract: keyof typeof TASKS_V2_EVENT_ABIS,
  log: { data: Hex; topics: [Hex, ...Hex[]] },
) {
  const decoded = decodeEventLog({ abi: TASKS_V2_EVENT_ABIS[contract], ...log, strict: true });
  return normalizeTaskV2Outcomes(decoded);
}

export const TASK_V2_NO_VERDICT_SUMMARY =
  "Disputed: status quo final after round 2 without a verdict; no dispute winner.";
export const TASK_V2_REVIEWER_GUIDANCE =
  "mayVote reports jury membership only. Do not touch your stake until you have revealed; even a cancelled unstake can cost the vote.";
export const TASK_V2_JURY_RULES =
  "Fewer than 3 eligible reviewers ends the round immediately. With 3 to 20 eligible reviewers everyone eligible is in the jury; above 20, 5 are drawn. A verdict needs at least 3 reveals and a strict majority. Round 1 without a verdict restores the pre-dispute state. Round 2 without a verdict makes the status quo final: disputed, with no dispute winner. Draw strictly after the seed block through HISTORY_WINDOW (8,191 blocks); rearm only after that window, at most 3 times. The next expired attempt ends the round. No mediation or appeal.";

/** Cause 6 describes a terminal payout, never a verdict for the recipient. Preserve amounts. */
export function normalizeTaskV2Outcomes<T>(value: T): T {
  const walk = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(walk);
    if (item === null || typeof item !== "object") return item;
    const source = item as Record<string, unknown>;
    const result = Object.fromEntries(
      Object.entries(source).map(([key, entry]) => [key, walk(entry)]),
    );
    if (source.cause === 6 || source.cause === "6" || source.cause === 6n) {
      result.disputed = true;
      result.disputeWinner = 0;
      result.summary = TASK_V2_NO_VERDICT_SUMMARY;
    }
    if (typeof source.mayVote === "boolean") {
      result.juryMember = source.mayVote;
      result.mayVoteMeaning = "jury membership only";
      result.reviewerGuidance = TASK_V2_REVIEWER_GUIDANCE;
    }
    return result;
  };
  return walk(value) as T;
}

/** Human status/show output uses the same cause-6 explanation as SDK and MCP output. */
export function taskV2OutcomeLines(value: unknown): string[] {
  if (!value || typeof value !== "object") return [];
  const source = value as Record<string, unknown>;
  if (source.cause === 6 || source.cause === "6" || source.cause === 6n)
    return [TASK_V2_NO_VERDICT_SUMMARY];
  return [...new Set(Object.values(source).flatMap(taskV2OutcomeLines))];
}
