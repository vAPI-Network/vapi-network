/**
 * Core is the policy layer and must not depend on MCP or CLI. Both the CLI task
 * verbs (which depend on core and MCP) and the local MCP server need these pure
 * funding and release decisions, so they live in core.
 */
export type FundingDecision =
  { ok: true } | { ok: false; reason: "policy.perTask" | "policy.perDay" } | { approval: true };

export function decideFunding(input: {
  amountUsd: number;
  maxPerTaskUsd: number;
  approveAboveUsd: number;
  dayRemainingUsd: number;
}): FundingDecision {
  validateAmount(input.amountUsd);
  if (input.amountUsd > input.maxPerTaskUsd) return { ok: false, reason: "policy.perTask" };
  if (input.amountUsd > input.dayRemainingUsd) return { ok: false, reason: "policy.perDay" };
  if (input.amountUsd > input.approveAboveUsd) return { approval: true };
  return { ok: true };
}

export type ReleaseDecision = { auto: true } | { approval: true };

export function decideRelease(input: {
  amountUsd: number;
  autoReleaseBelowUsd: number;
}): ReleaseDecision {
  validateAmount(input.amountUsd);
  return input.amountUsd < input.autoReleaseBelowUsd ? { auto: true } : { approval: true };
}

function validateAmount(amountUsd: number): void {
  if (!Number.isFinite(amountUsd) || amountUsd < 0) {
    throw new Error("Task amount must be a finite, non-negative USD number.");
  }
}
