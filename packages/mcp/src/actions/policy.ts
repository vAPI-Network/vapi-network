import { formatUsdc, treasuryRequestMovementId } from "@vapi-network/core";

import { decidePayment } from "../agent/guards.js";
import { inspectionCacheKey, type ActionContext } from "./context.js";
import type { Action } from "./define.js";

export type PolicyDecision =
  | { kind: "allow" }
  | { kind: "ask_owner"; reason: string; ref?: string; priceUsd?: number }
  | { kind: "deny"; reason: string };

export function exactUsdcPrice(value: string): number | null {
  const match = /^\$(0|[1-9]\d*)(?:\.(\d{1,6}))?$/u.exec(value.trim());
  if (!match) return null;
  const price = Number(value.trim().slice(1));
  return Number.isFinite(price) ? price : null;
}

export async function checkAction<I, O>(
  action: Action<I, O>,
  input: I,
  ctx: ActionContext,
  options: { ownerApproved?: boolean } = {},
): Promise<PolicyDecision> {
  if (action.money === "none" || ctx.caller.profile === undefined) return { kind: "allow" };
  if (action.money === "moves") {
    if (action.name !== "swarm.allocate" && action.name !== "swarm.delegate") {
      return { kind: "deny", reason: "Agents cannot move money between accounts yet." };
    }

    const profile = ctx.caller.profile;
    if (!profile.grants.some((grant) => grant === action.grant)) {
      return { kind: "deny", reason: `This agent does not have the ${action.grant} grant.` };
    }

    const swarm = ctx.caller.run?.swarm;
    if (swarm === undefined) {
      return { kind: "deny", reason: "Only a swarm run can move treasury money." };
    }
    if (action.name === "swarm.delegate" && swarm.depth !== 0) {
      return { kind: "deny", reason: "A delegated run cannot delegate." };
    }

    const rawAmount =
      action.name === "swarm.allocate"
        ? (input as { amountUsd?: unknown }).amountUsd
        : (input as { budgetUsd?: unknown }).budgetUsd;
    let amountCents: bigint;
    try {
      amountCents = parseWholeUsdCents(rawAmount);
    } catch {
      return {
        kind: "deny",
        reason: "Enter a positive USDC amount in whole cents.",
      };
    }

    const amountAtomic = amountCents * 10_000n;
    const drawLeft = swarm.draw.limitAtomic - swarm.draw.spentAtomic();
    const requestId = (input as { requestId?: unknown }).requestId;
    const reserved =
      typeof requestId === "string" && requestId.length > 0
        ? swarm.draw.reservedAtomic(treasuryRequestMovementId(swarm.name, requestId))
        : 0n;
    // A reservation under the deterministic movement id means this intent is already planned.
    // Replaying it creates no new legs, even when a ceiling trimmed the original request.
    const drawNeeded = reserved > 0n ? 0n : amountAtomic;
    if (drawNeeded > drawLeft) {
      const nonnegativeDrawLeft = drawLeft < 0n ? 0n : drawLeft;
      return {
        kind: "deny",
        reason: `The swarm run has $${formatUsdc(nonnegativeDrawLeft)} left to draw.`,
      };
    }

    const amountUsd = Number(amountCents) / 100;
    if (amountUsd > profile.approveAboveUsd && options.ownerApproved !== true) {
      const member =
        action.name === "swarm.delegate" ? (input as { member: string }).member : swarm.member;
      return {
        kind: "ask_owner",
        reason: `Treasury draw $${amountUsd} is above the approval threshold $${profile.approveAboveUsd}.`,
        ref: `swarm treasury → ${member}`,
        priceUsd: amountUsd,
      };
    }
    return { kind: "allow" };
  }
  if (action.name === "swarm.run") {
    return { kind: "deny", reason: "Agents cannot start swarm runs." };
  }
  if (action.name !== "call.pay") return { kind: "allow" };

  const ref = (input as { id?: unknown }).id;
  if (typeof ref !== "string") {
    return { kind: "deny", reason: "The listing has no exact USDC price." };
  }

  const run = ctx.caller.run;
  if (run === undefined) {
    throw new Error("An agent action context requires run state.");
  }
  const inspectInput = {
    id: ref,
    ...((input as { endpoint?: unknown }).endpoint === undefined
      ? {}
      : { endpoint: (input as { endpoint: string }).endpoint }),
  };
  const cacheKey = inspectionCacheKey(inspectInput);
  let listing = run.inspected.get(cacheKey);
  if (listing === undefined) {
    listing = await ctx.call.inspect(inspectInput);
    run.inspected.set(cacheKey, listing);
  }
  const priceUsd = exactUsdcPrice(listing.price);
  const profile = ctx.caller.profile;
  const decision = decidePayment({
    ref,
    priceUsd,
    verification: listing.verification,
    seenRefs: run.searchedRefs,
    verifiedOnly: profile.verifiedOnly,
    approveAboveUsd: profile.approveAboveUsd,
    maxPerCallUsd: ctx.caps?.perCallUsd ?? Number.POSITIVE_INFINITY,
  });

  if (decision.action === "refuse") return { kind: "deny", reason: decision.reason };
  if (decision.action === "ask" && options.ownerApproved !== true) {
    return {
      kind: "ask_owner",
      reason: decision.reason,
      ref,
      ...(priceUsd === null ? {} : { priceUsd }),
    };
  }

  const maxUsd = Number((input as { maxPriceUsd?: unknown }).maxPriceUsd);
  if (priceUsd !== null && maxUsd < priceUsd) {
    return {
      kind: "deny",
      reason: `Requested maximum $${maxUsd} is below the listing price $${priceUsd}.`,
    };
  }
  return { kind: "allow" };
}

function parseWholeUsdCents(value: unknown): bigint {
  if (typeof value !== "string" && typeof value !== "number") throw new Error("Invalid amount.");
  const raw = String(value);
  if (!/^\d+(?:\.\d{1,2})?$/u.test(raw)) throw new Error("Invalid amount.");
  const [whole = "0", fraction = ""] = raw.split(".");
  const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0") || "0");
  if (cents <= 0n) throw new Error("Invalid amount.");
  return cents;
}
