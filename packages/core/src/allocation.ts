import { effectiveCeiling } from "./ceiling.js";

export const RELAY_MAX_PER_TRANSFER_ATOMIC = 50_000_000n;

export type AllocationBlockReason =
  | "insufficient_balance"
  | "per_call_cap_exceeded"
  | "per_day_cap_exceeded"
  | "relay_limit_exceeded"
  | "recipient_ceiling"
  | "share_too_small";

export type AllocationPolicy = {
  balanceAtomic: bigint | string;
  perCallAtomic: bigint | string;
  perDayRemainingAtomic: bigint | string;
  relayMaxPerTransferAtomic?: bigint | string;
};

export type AllocationInput =
  | {
      strategy: "even";
      from: string;
      recipients: readonly (
        | string
        | {
            to: string;
            balanceAtomic?: bigint | string;
            ceilingAtomic?: bigint | string | null;
          }
      )[];
      amountUsd: string | number;
      policy: AllocationPolicy;
    }
  | {
      strategy: "weights";
      from: string;
      recipients: readonly {
        to: string;
        weight: number;
        balanceAtomic?: bigint | string;
        ceilingAtomic?: bigint | string | null;
      }[];
      amountUsd: string | number;
      policy: AllocationPolicy;
    }
  | {
      strategy: "targets";
      treasury: string;
      members: readonly {
        account: string;
        balanceAtomic: bigint | string;
        targetAtomic: bigint | string;
        ceilingAtomic: bigint | string | null;
        perDayCapAtomic?: bigint | string | null;
      }[];
      policy: AllocationPolicy;
    };

export type AllocationPurpose = "send" | "sweep";
export type AllocationLeg = {
  to: string;
  amountUsd: string;
  from?: string;
  purpose?: AllocationPurpose;
};
export type BlockedAllocationLeg = AllocationLeg & { reason: AllocationBlockReason };
export type AllocationPlan = {
  legs: AllocationLeg[];
  blocked: BlockedAllocationLeg[];
};

export class AllocationError extends Error {
  constructor(
    readonly code: "invalid_amount" | "invalid_recipients" | "amount_too_small" | "invalid_weights",
    message: string,
  ) {
    super(message);
    this.name = "AllocationError";
  }
}

/** Pure allocation planning. Amounts are deliberately limited to whole cents. */
export function planAllocation(input: AllocationInput): AllocationPlan {
  if (input.strategy === "weights") return planWeights(input);
  if (input.strategy === "targets") return planTargets(input);
  if (input.strategy !== "even") {
    // Retain a runtime guard for JS callers.
    throw new AllocationError("invalid_amount", "Unsupported allocation strategy.");
  }
  const recipients = input.recipients.map((recipient) =>
    typeof recipient === "string" ? { to: recipient } : recipient,
  );
  if (recipients.length === 0 || recipients.some((recipient) => !recipient.to.trim())) {
    throw new AllocationError("invalid_recipients", "At least one recipient is required.");
  }

  const amountCents = parseUsdCents(input.amountUsd);
  const count = BigInt(recipients.length);
  const share = amountCents / count;
  if (share === 0n) {
    throw new AllocationError(
      "amount_too_small",
      `Amount too small to split over ${recipients.length} accounts.`,
    );
  }
  const remainder = amountCents % count;
  const candidates = recipients.map((recipient, index) => ({
    recipient,
    cents: share + (index === 0 ? remainder : 0n),
  }));

  const balanceAtomic = parseAtomic(input.policy.balanceAtomic, "balance");
  const perCallAtomic = parseAtomic(input.policy.perCallAtomic, "per-call cap");
  const perDayRemainingAtomic = parseAtomic(
    input.policy.perDayRemainingAtomic,
    "remaining per-day cap",
  );
  const relayMaxAtomic = relayMaxFor(input.policy);
  const totalAtomic = amountCents * 10_000n;
  const globalReason: AllocationBlockReason | undefined =
    totalAtomic > balanceAtomic
      ? "insufficient_balance"
      : totalAtomic > perDayRemainingAtomic
        ? "per_day_cap_exceeded"
        : undefined;

  const legs: AllocationLeg[] = [];
  const blocked: BlockedAllocationLeg[] = [];
  for (const candidate of candidates) {
    let keptCents = candidate.cents;
    const recipientBalance =
      candidate.recipient.balanceAtomic === undefined
        ? undefined
        : parseAtomic(candidate.recipient.balanceAtomic, "recipient balance");
    const recipientCeiling =
      candidate.recipient.ceilingAtomic === undefined || candidate.recipient.ceilingAtomic === null
        ? candidate.recipient.ceilingAtomic
        : parseAtomic(candidate.recipient.ceilingAtomic, "recipient ceiling");
    if (
      recipientBalance !== undefined &&
      recipientCeiling !== undefined &&
      recipientCeiling !== null &&
      recipientBalance + keptCents * 10_000n > recipientCeiling
    ) {
      const headroomCents =
        recipientCeiling > recipientBalance ? (recipientCeiling - recipientBalance) / 10_000n : 0n;
      blocked.push({
        to: candidate.recipient.to,
        amountUsd: formatUsdCents(keptCents - headroomCents),
        reason: "recipient_ceiling",
      });
      keptCents = headroomCents;
    }
    if (keptCents === 0n) continue;
    const leg = { to: candidate.recipient.to, amountUsd: formatUsdCents(keptCents) };
    const legAtomic = keptCents * 10_000n;
    const reason =
      globalReason ??
      (legAtomic > perCallAtomic
        ? "per_call_cap_exceeded"
        : legAtomic > relayMaxAtomic
          ? "relay_limit_exceeded"
          : undefined);
    if (reason === undefined) legs.push(leg);
    else blocked.push({ ...leg, reason });
  }
  return { legs, blocked };
}

type WeightsInput = Extract<AllocationInput, { strategy: "weights" }>;
type TargetsInput = Extract<AllocationInput, { strategy: "targets" }>;

function planWeights(input: WeightsInput): AllocationPlan {
  assertDistinctNames(
    input.from,
    input.recipients.map(({ to }) => to),
  );

  const amountCents = parseUsdCents(input.amountUsd);
  const weights = scaleWeights(input.recipients.map(({ weight }) => weight));
  const totalWeight = weights.reduce((total, weight) => total + weight, 0n);
  if (totalWeight === 0n) {
    throw new AllocationError("invalid_weights", "Weights must have a positive scaled total.");
  }

  const shares = weights.map((weight, index) => {
    const weightedCents = amountCents * weight;
    return {
      index,
      cents: weightedCents / totalWeight,
      remainder: weightedCents % totalWeight,
    };
  });
  let leftover = amountCents - shares.reduce((total, share) => total + share.cents, 0n);
  const remainderOrder = [...shares].sort(
    (left, right) => compareBigints(right.remainder, left.remainder) || left.index - right.index,
  );
  for (const share of remainderOrder) {
    if (leftover === 0n) break;
    share.cents += 1n;
    leftover -= 1n;
  }

  const balanceAtomic = parseAtomic(input.policy.balanceAtomic, "balance");
  const perCallAtomic = parseAtomic(input.policy.perCallAtomic, "per-call cap");
  const perDayRemainingAtomic = parseAtomic(
    input.policy.perDayRemainingAtomic,
    "remaining per-day cap",
  );
  const relayMaxAtomic = relayMaxFor(input.policy);
  const totalAtomic = amountCents * 10_000n;
  const globalReason: AllocationBlockReason | undefined =
    totalAtomic > balanceAtomic
      ? "insufficient_balance"
      : totalAtomic > perDayRemainingAtomic
        ? "per_day_cap_exceeded"
        : undefined;

  const legs: AllocationLeg[] = [];
  const blocked: BlockedAllocationLeg[] = [];
  for (const share of shares) {
    const recipient = input.recipients[share.index]!;
    if (share.cents === 0n) {
      blocked.push(blockedLeg(input.from, recipient.to, 0n, "send", "share_too_small"));
      continue;
    }

    if (globalReason !== undefined) {
      blocked.push(blockedLeg(input.from, recipient.to, share.cents, "send", globalReason));
      continue;
    }

    let keptCents = share.cents;
    const recipientBalance =
      recipient.balanceAtomic === undefined
        ? undefined
        : parseAtomic(recipient.balanceAtomic, "recipient balance");
    const recipientCeiling =
      recipient.ceilingAtomic === undefined || recipient.ceilingAtomic === null
        ? recipient.ceilingAtomic
        : parseAtomic(recipient.ceilingAtomic, "recipient ceiling");
    if (
      recipientBalance !== undefined &&
      recipientCeiling !== undefined &&
      recipientCeiling !== null &&
      recipientBalance + keptCents * 10_000n > recipientCeiling
    ) {
      const headroomCents =
        recipientCeiling > recipientBalance ? (recipientCeiling - recipientBalance) / 10_000n : 0n;
      const blockedCents = keptCents - headroomCents;
      keptCents = headroomCents;
      blocked.push(blockedLeg(input.from, recipient.to, blockedCents, "send", "recipient_ceiling"));
    }

    if (keptCents === 0n) continue;
    const keptAtomic = keptCents * 10_000n;
    const reason: AllocationBlockReason | undefined =
      keptAtomic > perCallAtomic
        ? "per_call_cap_exceeded"
        : keptAtomic > relayMaxAtomic
          ? "relay_limit_exceeded"
          : undefined;
    if (reason === undefined) legs.push(allocationLeg(input.from, recipient.to, keptCents, "send"));
    else blocked.push(blockedLeg(input.from, recipient.to, keptCents, "send", reason));
  }
  return { legs, blocked };
}

type TargetCandidate = {
  from: string;
  to: string;
  cents: bigint;
  purpose: AllocationPurpose;
  ceilingBlockedCents?: bigint;
};

function planTargets(input: TargetsInput): AllocationPlan {
  assertDistinctNames(
    input.treasury,
    input.members.map(({ account }) => account),
    true,
  );

  const treasuryBalanceAtomic = parseAtomic(input.policy.balanceAtomic, "treasury balance");
  const perCallAtomic = parseAtomic(input.policy.perCallAtomic, "treasury per-call cap");
  const perDayRemainingAtomic = parseAtomic(
    input.policy.perDayRemainingAtomic,
    "treasury remaining per-day cap",
  );
  const relayMaxAtomic = relayMaxFor(input.policy);
  const downs: TargetCandidate[] = [];
  const ups: TargetCandidate[] = [];

  for (const member of input.members) {
    const balanceAtomic = parseAtomic(member.balanceAtomic, `${member.account} balance`);
    const targetAtomic = parseAtomic(member.targetAtomic, `${member.account} target`);
    const ceilingAtomic =
      member.ceilingAtomic === null
        ? null
        : parseAtomic(member.ceilingAtomic, `${member.account} ceiling`);
    const perDayCapAtomic =
      member.perDayCapAtomic === undefined || member.perDayCapAtomic === null
        ? member.perDayCapAtomic
        : parseAtomic(member.perDayCapAtomic, `${member.account} per-day cap`);

    if (balanceAtomic > targetAtomic) {
      const cents = (balanceAtomic - targetAtomic) / 10_000n;
      if (cents > 0n) {
        downs.push({
          from: member.account,
          to: input.treasury,
          cents,
          purpose: "sweep",
        });
      }
      continue;
    }
    if (targetAtomic === balanceAtomic) continue;

    const desiredCents = (targetAtomic - balanceAtomic) / 10_000n;
    if (desiredCents === 0n) continue;
    const ceiling = effectiveCeiling(ceilingAtomic, perDayCapAtomic);
    let cents = desiredCents;
    let ceilingBlockedCents: bigint | undefined;
    if (ceiling !== null && balanceAtomic + cents * 10_000n > ceiling) {
      const headroomCents = ceiling > balanceAtomic ? (ceiling - balanceAtomic) / 10_000n : 0n;
      ceilingBlockedCents = cents - headroomCents;
      cents = headroomCents;
    }
    ups.push({
      from: input.treasury,
      to: member.account,
      cents,
      purpose: "send",
      ...(ceilingBlockedCents === undefined ? {} : { ceilingBlockedCents }),
    });
  }

  const legs: AllocationLeg[] = [];
  const blocked: BlockedAllocationLeg[] = [];
  for (const candidate of downs) {
    if (relayMaxAtomic < 10_000n) {
      blocked.push(blockedCandidate(candidate, "relay_limit_exceeded"));
    } else {
      legs.push(...splitCandidateAtRelayMaximum(candidate, relayMaxAtomic));
    }
  }

  let balanceLeftAtomic = treasuryBalanceAtomic;
  let perDayLeftAtomic = perDayRemainingAtomic;
  for (const candidate of ups) {
    if (candidate.ceilingBlockedCents !== undefined) {
      blocked.push(
        blockedLeg(
          candidate.from,
          candidate.to,
          candidate.ceilingBlockedCents,
          candidate.purpose,
          "recipient_ceiling",
        ),
      );
    }
    if (candidate.cents === 0n) continue;

    const candidateAtomic = candidate.cents * 10_000n;
    if (candidateAtomic > perCallAtomic) {
      blocked.push(blockedCandidate(candidate, "per_call_cap_exceeded"));
      continue;
    }
    if (candidateAtomic > relayMaxAtomic) {
      blocked.push(blockedCandidate(candidate, "relay_limit_exceeded"));
      continue;
    }

    const availableAtomic =
      balanceLeftAtomic < perDayLeftAtomic ? balanceLeftAtomic : perDayLeftAtomic;
    const keptCents =
      availableAtomic / 10_000n < candidate.cents ? availableAtomic / 10_000n : candidate.cents;
    if (keptCents > 0n) {
      legs.push(allocationLeg(candidate.from, candidate.to, keptCents, candidate.purpose));
      const spentAtomic = keptCents * 10_000n;
      balanceLeftAtomic -= spentAtomic;
      perDayLeftAtomic -= spentAtomic;
    }
    if (keptCents < candidate.cents) {
      blocked.push(
        blockedLeg(
          candidate.from,
          candidate.to,
          candidate.cents - keptCents,
          candidate.purpose,
          balanceLeftAtomic <= perDayLeftAtomic ? "insufficient_balance" : "per_day_cap_exceeded",
        ),
      );
    }
  }

  return { legs, blocked };
}

function splitCandidateAtRelayMaximum(
  candidate: TargetCandidate,
  relayMaxAtomic: bigint,
): AllocationLeg[] {
  const maximumCents = relayMaxAtomic / 10_000n;
  const legs: AllocationLeg[] = [];
  let remaining = candidate.cents;
  while (remaining > 0n) {
    const cents = remaining > maximumCents ? maximumCents : remaining;
    legs.push(allocationLeg(candidate.from, candidate.to, cents, candidate.purpose));
    remaining -= cents;
  }
  return legs;
}

function assertDistinctNames(
  from: string,
  recipients: readonly string[],
  rejectFrom = false,
): void {
  const normalizedFrom = from.trim();
  const normalizedRecipients = recipients.map((recipient) => recipient.trim());
  if (
    !normalizedFrom ||
    normalizedRecipients.length === 0 ||
    normalizedRecipients.some((recipient) => !recipient) ||
    new Set(normalizedRecipients).size !== normalizedRecipients.length ||
    (rejectFrom && normalizedRecipients.includes(normalizedFrom))
  ) {
    throw new AllocationError(
      "invalid_recipients",
      "Sender and recipient names must be non-blank and distinct.",
    );
  }
}

function scaleWeights(weights: readonly number[]): bigint[] {
  const decimalWeights = weights.map((weight) => {
    if (!Number.isFinite(weight) || weight <= 0) {
      throw new AllocationError("invalid_weights", "Weights must be positive finite numbers.");
    }

    const match = /^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(weight.toString());
    if (match === null) {
      throw new AllocationError("invalid_weights", "Weights must be positive finite numbers.");
    }
    const fraction = match[2] ?? "";
    return {
      coefficient: BigInt(`${match[1]}${fraction}`),
      exponent: Number(match[3] ?? 0) - fraction.length,
    };
  });
  const commonExponent = Math.min(...decimalWeights.map(({ exponent }) => exponent));
  return decimalWeights.map(
    ({ coefficient, exponent }) => coefficient * 10n ** BigInt(exponent - commonExponent),
  );
}

function relayMaxFor(policy: AllocationPolicy): bigint {
  return policy.relayMaxPerTransferAtomic === undefined
    ? RELAY_MAX_PER_TRANSFER_ATOMIC
    : parseAtomic(policy.relayMaxPerTransferAtomic, "relay per-transfer maximum");
}

function allocationLeg(
  from: string,
  to: string,
  cents: bigint,
  purpose: AllocationPurpose,
): AllocationLeg {
  return { from, to, amountUsd: formatUsdCents(cents), purpose };
}

function blockedLeg(
  from: string,
  to: string,
  cents: bigint,
  purpose: AllocationPurpose,
  reason: AllocationBlockReason,
): BlockedAllocationLeg {
  return { ...allocationLeg(from, to, cents, purpose), reason };
}

function blockedCandidate(
  candidate: TargetCandidate,
  reason: AllocationBlockReason,
): BlockedAllocationLeg {
  return blockedLeg(candidate.from, candidate.to, candidate.cents, candidate.purpose, reason);
}

function compareBigints(left: bigint, right: bigint): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function parseUsdCents(value: string | number): bigint {
  const raw = String(value);
  if (!/^\d+(?:\.\d{1,2})?$/.test(raw)) {
    throw new AllocationError("invalid_amount", "Enter a positive USDC amount in whole cents.");
  }
  const [whole = "0", fraction = ""] = raw.split(".");
  const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0") || "0");
  if (cents <= 0n) {
    throw new AllocationError("invalid_amount", "Enter a positive USDC amount in whole cents.");
  }
  return cents;
}

export function formatUsdCents(cents: bigint): string {
  if (cents < 0n) throw new Error("USDC cents cannot be negative.");
  return `${cents / 100n}.${(cents % 100n).toString().padStart(2, "0")}`;
}

function parseAtomic(value: bigint | string, label: string): bigint {
  if (typeof value === "bigint") {
    if (value >= 0n) return value;
  } else if (/^\d+$/.test(value)) {
    return BigInt(value);
  }
  throw new Error(`Invalid ${label} atomic amount.`);
}
