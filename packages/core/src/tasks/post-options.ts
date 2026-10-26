import type { z } from "zod";
import { TaskInputError, parseTaskDuration, TASK_LIMITS } from "./operation-support.js";
import { formatBaseUnitsUsd, parseUsdToBaseUnits } from "./money.js";
import { taskTermsSchema, type ProofRequirement, type TaskTerms } from "./v2.js";

export type TaskPostOptions = {
  shape?: TaskTerms["shape"];
  amountUsd?: string;
  deadline: string;
  bounty?: TaskTerms["bounty"];
  pool?: TaskTerms["pool"];
  milestones?: TaskTerms["milestones"];
  proofSpec?: z.input<typeof taskTermsSchema>["proofSpec"];
  checkin?: TaskTerms["checkin"];
  winners?: number;
  rewardPerWinner?: string;
  choiceWindowSeconds?: number;
  rewardPerClaim?: string;
  budget?: string;
  gate?: "open" | "proven";
  verifier?: "poster" | "vapi";
  openCheck?: "allowlist" | "invite";
};

function positive(text: string | undefined, name: string): bigint {
  if (text === undefined) throw new TaskInputError(`${name} is required.`);
  try {
    const value = parseUsdToBaseUnits(text);
    if (value <= 0n || value >= 1n << 256n) throw new Error();
    return value;
  } catch {
    throw new TaskInputError(`${name} must be a positive USDC amount with at most six decimals.`);
  }
}

/** Normalize UI amounts once. Bounty market budgets are per winner; escrow budgets are total. */
export function prepareTaskPost(input: TaskPostOptions, now: Date) {
  // Native hosted fields and the decimal convenience fields describe the same terms.
  const agree = <T>(value: T | undefined, native: T | undefined, name: string): T | undefined => {
    if (value !== undefined && native !== undefined && value !== native)
      throw new TaskInputError(`Conflicting ${name} terms.`);
    return value ?? native;
  };
  if (
    input.bounty &&
    Date.parse(input.bounty.deadlineAt) !== now.getTime() + parseTaskDuration(input.deadline, now)
  )
    throw new TaskInputError("The bounty and task deadlines must match.");
  if (input.pool?.openCheck && !["allowlist", "invite"].includes(input.pool.openCheck))
    throw new TaskInputError("Only allowlist and invite open checks are available.");
  input = {
    ...input,
    winners: agree(input.winners, input.bounty?.winners, "winner count"),
    rewardPerWinner: agree(
      input.rewardPerWinner === undefined
        ? undefined
        : formatBaseUnitsUsd(positive(input.rewardPerWinner, "reward per winner")),
      input.bounty ? formatBaseUnitsUsd(input.bounty.rewardPerWinnerBaseUnits) : undefined,
      "reward per winner",
    ),
    choiceWindowSeconds: agree(
      input.choiceWindowSeconds,
      input.bounty?.choiceWindowSeconds,
      "choice window",
    ),
    rewardPerClaim: agree(
      input.rewardPerClaim === undefined
        ? undefined
        : formatBaseUnitsUsd(positive(input.rewardPerClaim, "reward per claim")),
      input.pool ? formatBaseUnitsUsd(input.pool.rewardPerClaimBaseUnits) : undefined,
      "reward per claim",
    ),
    budget: agree(
      input.budget === undefined
        ? undefined
        : formatBaseUnitsUsd(positive(input.budget, "pool budget")),
      input.pool ? formatBaseUnitsUsd(input.pool.budgetBaseUnits) : undefined,
      "pool budget",
    ),
    gate: agree(input.gate, input.pool?.gate, "pool gate"),
    verifier: agree(input.verifier, input.pool?.verifier, "pool verifier"),
    openCheck: agree(
      input.openCheck,
      input.pool?.openCheck as "allowlist" | "invite" | undefined,
      "open check",
    ),
  };
  const duration = parseTaskDuration(input.deadline, now);
  if (duration < TASK_LIMITS.postDeadlineMinMs)
    throw new TaskInputError("--deadline must be at least 10 minutes from now.");
  const deadlineAt = new Date(now.getTime() + duration).toISOString();
  const shape = input.shape ?? "task";
  if (shape !== "task" && input.milestones !== undefined)
    throw new TaskInputError("Milestones require shape task.");
  if (
    shape !== "bounty" &&
    [input.winners, input.rewardPerWinner, input.choiceWindowSeconds].some((v) => v !== undefined)
  )
    throw new TaskInputError("Winner options require shape bounty.");
  if (
    shape !== "pool" &&
    [input.rewardPerClaim, input.budget, input.gate, input.verifier, input.openCheck].some(
      (v) => v !== undefined,
    )
  )
    throw new TaskInputError("Claim options require shape pool.");
  let amount: bigint;
  const terms: Record<string, unknown> = {
    shape,
    ...(input.milestones === undefined ? {} : { milestones: input.milestones }),
    ...(input.proofSpec === undefined ? {} : { proofSpec: input.proofSpec }),
    ...(input.checkin === undefined ? {} : { checkin: input.checkin }),
  };
  if (shape === "bounty") {
    amount = positive(input.rewardPerWinner ?? input.amountUsd, "--reward-per-winner");
    terms.bounty = {
      winners: input.winners ?? 1,
      rewardPerWinnerBaseUnits: amount.toString(),
      deadlineAt,
      choiceWindowSeconds: input.choiceWindowSeconds ?? 604_800,
    };
  } else if (shape === "pool") {
    amount = positive(input.budget ?? input.amountUsd, "--budget");
    const reward = positive(input.rewardPerClaim, "--reward-per-claim");
    if (reward > amount) throw new TaskInputError("The pool budget must cover at least one claim.");
    terms.pool = {
      rewardPerClaimBaseUnits: reward.toString(),
      budgetBaseUnits: amount.toString(),
      gate: input.gate ?? "proven",
      verifier: input.verifier ?? "poster",
      ...(input.openCheck ? { openCheck: input.openCheck } : {}),
    };
    if (input.openCheck && input.gate !== "open")
      throw new TaskInputError("Extra checks require --gate open.");
    if (input.gate === "open" && !input.openCheck)
      throw new TaskInputError(
        "An open pool requires --open-check allowlist|invite (configure participants separately).",
      );
  } else {
    const sum = input.milestones?.reduce((total, item) => total + BigInt(item.amountBaseUnits), 0n);
    amount =
      input.amountUsd === undefined && sum !== undefined
        ? sum
        : positive(input.amountUsd, "--amount");
    if (sum !== undefined && sum !== amount)
      throw new TaskInputError("Milestone amounts must sum to --amount.");
    if (
      input.milestones?.some(
        (item) => Date.parse(item.deadlineAt) - now.getTime() < TASK_LIMITS.postDeadlineMinMs,
      )
    )
      throw new TaskInputError("Milestone deadlines must be at least 10 minutes from now.");
  }
  if (input.amountUsd !== undefined && positive(input.amountUsd, "--amount") !== amount)
    throw new TaskInputError("--amount conflicts with the shape budget.");
  const parsed = taskTermsSchema.safeParse(terms);
  if (!parsed.success)
    throw new TaskInputError(parsed.error.issues[0]?.message ?? "Invalid task terms.");
  const escrowAmount = amount * BigInt(shape === "bounty" ? (input.winners ?? 1) : 1);
  if (escrowAmount >= 1n << 256n) throw new TaskInputError("Total escrow amount exceeds uint256.");
  return { terms: parsed.data, amount, escrowAmount, deadlineAt };
}

export function parseTaskMilestone(text: string, index: number, now: Date) {
  const parts = text.split("|");
  if (parts.length !== 3)
    throw new TaskInputError('--milestone must be "amount|acceptance|deadline".');
  return {
    index,
    amountBaseUnits: positive(parts[0]!.trim(), "milestone amount").toString(),
    acceptance: parts[1]!.trim(),
    deadlineAt: new Date(now.getTime() + parseTaskDuration(parts[2]!.trim(), now)).toISOString(),
  };
}
export function parseTaskProof(text: string): ProofRequirement {
  const separator = text.indexOf(":");
  const preset = separator < 0 ? text : text.slice(0, separator);
  // Media needs kinds on the wire. The shorthand accepts both capture types.
  const requirement = {
    preset,
    ...(preset === "media" ? { kinds: ["photo", "video"] } : {}),
    ...(separator < 0 ? {} : { mustContain: text.slice(separator + 1) }),
  };
  const parsed = taskTermsSchema.shape.proofSpec.unwrap().safeParse([requirement]);
  if (!parsed.success)
    throw new TaskInputError(`Invalid --proof: ${parsed.error.issues[0]?.message ?? text}`);
  return (parsed.data as ProofRequirement[])[0]!;
}
