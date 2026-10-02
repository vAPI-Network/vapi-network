import { createAgentProfileSchema, type AgentProfile } from "@vapi-network/core";

import { accountsSend } from "./accounts.js";
import { callInspect, callPay, callSearch } from "./call.js";
import { callRead } from "./call-read.js";
import type { ActionContext } from "./context.js";
import type { Action } from "./define.js";
import { checkAction } from "./policy.js";
import { swarmAgentActions } from "./swarm-agent.js";
import { swarmActions } from "./swarm.js";

export class ActionDeclinedError extends Error {
  readonly name = "ActionDeclinedError";

  constructor(public readonly reason: string) {
    super(reason);
  }
}

export async function runAction<I, O>(
  action: Action<I, O>,
  rawInput: unknown,
  ctx: ActionContext,
): Promise<O> {
  const input = action.input.parse(rawInput) as I;
  if (action.money !== "none") {
    const decision = await checkAction(action, input, ctx);
    if (decision.kind === "deny") throw new ActionDeclinedError(decision.reason);
    if (decision.kind === "ask_owner") {
      const approved = ctx.askOwner
        ? await ctx.askOwner({
            action: action.name,
            reason: decision.reason,
            ...(decision.ref === undefined ? {} : { ref: decision.ref }),
            ...(decision.priceUsd === undefined ? {} : { priceUsd: decision.priceUsd }),
          })
        : false;
      if (!approved) {
        throw new ActionDeclinedError(`Payment was not approved: ${decision.reason}`);
      }
      const approvedDecision = await checkAction(action, input, ctx, { ownerApproved: true });
      if (approvedDecision.kind === "deny") {
        throw new ActionDeclinedError(approvedDecision.reason);
      }
    }
  }
  const output = await action.run(input, ctx);
  // Once an action has spent or moved money, its result is the only record the
  // caller gets of it, so a shape mismatch must not turn a paid call into an
  // error. Actions that move nothing still fail on a bad output.
  const checked = action.output.safeParse(output);
  if (!checked.success && action.money === "none") throw checked.error;
  return output;
}

export const actions = [
  callSearch,
  callInspect,
  callPay,
  accountsSend,
  ...swarmActions,
  callRead,
  ...swarmAgentActions,
] as const;

export const agentToolNames = actions
  .filter((action) => action.grant === "call")
  .map((action) => action.name) as AgentProfile["tools"];

export const registeredAgentProfileSchema = createAgentProfileSchema(agentToolNames);

export function findAction(name: string): (typeof actions)[number] | undefined {
  return actions.find((action) => action.name === name);
}
