import { AGENT_LINK_REVOKED_MESSAGE } from "@vapi-network/core/agent-link";
import { ROUTER_KEY_REVOKED_MESSAGE } from "@vapi-network/core/router-client";
import {
  appendAudit,
  createRunId,
  formatUsdc,
  RunBudgetError,
  type AgentProfile,
  type ChatMessage,
  type ChatRequest,
  type ChatResult,
  type RunBudget,
  type RunRef,
  type VapiConfig,
} from "@vapi-network/core";
import { z } from "zod";

import { inspectToolResultSchema } from "../actions/call.js";
import { callReadOutputSchema, type CallReadOutput } from "../actions/call-read.js";
import {
  createRunState,
  inspectionCacheKey,
  type ActionContext,
  type ActionRunState,
  type SwarmRunScope,
} from "../actions/context.js";
import type { Action } from "../actions/define.js";
import { exactUsdcPrice } from "../actions/policy.js";
import { ActionDeclinedError, actions, runAction } from "../actions/register.js";
import {
  swarmAllocateOutputSchema,
  swarmDelegateOutputSchema,
  type SwarmAllocateResult,
  type SwarmDelegateResult,
} from "../actions/swarm-agent.js";
import type { InspectToolResult } from "../tools/inspect.js";
import { UNTRUSTED_NOTICE, wrapUntrusted } from "./guards.js";

export type AgentEvent =
  | { type: "step"; n: number }
  | { type: "tool"; name: string; summary: string }
  | { type: "paid"; ref: string; amountUsd: number; network: string }
  | { type: "declined"; ref: string; reason: string }
  | {
      type: "stopped";
      reason: "finished" | "max_steps" | "router_budget" | "run_budget" | "paused" | "error";
      detail?: string;
    };

export type SwarmRunContext = SwarmRunScope & {
  allocate(input: {
    amountUsd: string;
    reason?: string;
    requestId: string;
  }): Promise<SwarmAllocateResult>;
  delegate(input: {
    member: string;
    task: string;
    budgetUsd: string;
    parentRunId: string;
    requestId: string;
  }): Promise<SwarmDelegateResult>;
};

export type RunAgentDeps = {
  profile: AgentProfile;
  config: VapiConfig;
  home: string;
  chat: (req: ChatRequest) => Promise<ChatResult>;
  search: (q: { query: string; network?: string; includeUnverified: boolean }) => Promise<
    Array<{
      ref: string;
      name: string;
      priceUsd: number | null;
      verification: string;
      description?: string;
    }>
  >;
  inspect: (ref: string) => Promise<InspectToolResult>;
  read?: (input: { url: string }) => Promise<CallReadOutput>;
  pay: (input: {
    ref: string;
    body?: unknown;
    maxPriceUsd: number;
  }) => Promise<{ ok: boolean; status: number; body: unknown; amountUsd: number; network: string }>;
  caps: { perCallUsd: number };
  approve: (question: { ref: string; priceUsd: number; reason: string }) => Promise<boolean>;
  onEvent?: (event: AgentEvent) => void;
  tty?: boolean;
  now?: () => Date;
  budget?: RunBudget;
  runId?: string;
  runMeta?: { swarm?: string; member?: string; parentRunId?: string };
  swarm?: SwarmRunContext;
  forRun?: (run: ActionRunState) => RunAgentDeps;
};

export type RunAgentResult = {
  runId: string;
  answer: string | null;
  stoppedBecause: AgentEvent & { type: "stopped" };
  paidUsd: number;
  steps: number;
  budget?: { limitUsd: number; spentUsd: number };
};

type ModelToolCall = ChatResult["toolCalls"][number];
type ToolOutcome = { output: unknown; fatalDetail?: string };
type LoopSearchInput = {
  query: string;
  network?: string;
  includeUnverified: boolean;
};
type LoopInspectInput = { id: string };
type LoopPayInput = { id: string; body?: string; maxPriceUsd: number };
type LoopPayResult = { status: number; body: unknown };
type LoopReadInput = { url: string };
type ParsedLoopSwarmAllocateInput = { amountUsd: string; reason?: string };
type LoopSwarmAllocateInput = ParsedLoopSwarmAllocateInput & { requestId: string };
type ParsedLoopSwarmDelegateInput = { member: string; task: string; budgetUsd: string };
type LoopSwarmDelegateInput = ParsedLoopSwarmDelegateInput & { requestId: string };
type LoopExecution = {
  deps: RunAgentDeps;
  payment?: Awaited<ReturnType<RunAgentDeps["pay"]>>;
};
type LoopBinding = {
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, unknown>;
    required: string[];
    additionalProperties: false;
  };
  output: z.ZodType<unknown>;
  summary: string;
  parseArguments(value: string, deps: RunAgentDeps): unknown;
  run(input: unknown, ctx: ActionContext, execution: LoopExecution): Promise<unknown>;
};

const loopSearchResultSchema = z.array(
  z.object({
    ref: z.string(),
    name: z.string(),
    priceUsd: z.number().nullable(),
    verification: z.string(),
    description: z.string().optional(),
  }),
);
const loopPayResultSchema = z.object({ status: z.number(), body: z.unknown() });

const LOOP_BINDINGS: Readonly<Record<string, LoopBinding>> = {
  "call.search": {
    description:
      "Search vAPI Call listings available to this agent. Set network to null to search every network, or to a CAIP-2 id such as eip155:8453 (Base) or eip155:5042 (Arc).",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
        network: { type: ["string", "null"] },
      },
      required: ["query", "network"],
      additionalProperties: false,
    },
    output: loopSearchResultSchema,
    summary: "Search completed.",
    parseArguments(value, deps) {
      const args = parseObjectArgs(value);
      const query = requiredString(args, "query");
      const network = searchNetwork(nullableString(args, "network"));
      return {
        query,
        ...(network === null ? {} : { network }),
        includeUnverified: !deps.profile.verifiedOnly,
      } satisfies LoopSearchInput;
    },
    async run(input, ctx, execution) {
      const search = input as LoopSearchInput;
      const rows = await execution.deps.search(search);
      for (const row of rows) ctx.caller.run?.searchedRefs.add(row.ref);
      return rows;
    },
  },
  "call.inspect": {
    description: "Inspect a vAPI Call listing's price, verification, and request contract.",
    parameters: {
      type: "object",
      properties: { ref: { type: "string" } },
      required: ["ref"],
      additionalProperties: false,
    },
    output: inspectToolResultSchema,
    summary: "Inspection completed.",
    parseArguments(value) {
      const args = parseObjectArgs(value);
      return { id: requiredString(args, "ref") } satisfies LoopInspectInput;
    },
    async run(input, ctx, execution) {
      const { id } = input as LoopInspectInput;
      const cacheKey = inspectionCacheKey({ id });
      const cached = ctx.caller.run?.inspected.get(cacheKey);
      if (cached) return cached;
      const result = await execution.deps.inspect(id);
      ctx.caller.run?.inspected.set(cacheKey, result);
      return result;
    },
  },
  "call.pay": {
    description:
      "Call and pay a listing. body is a JSON-encoded request body or null. max_usd cannot override wallet or agent policy.",
    parameters: {
      type: "object",
      properties: {
        ref: { type: "string" },
        body: { type: ["string", "null"] },
        max_usd: { type: "number", minimum: 0 },
      },
      required: ["ref", "body", "max_usd"],
      additionalProperties: false,
    },
    output: loopPayResultSchema,
    summary: "Payment tool completed.",
    parseArguments(value) {
      const args = parseObjectArgs(value);
      const id = requiredString(args, "ref");
      const body = nullableString(args, "body");
      const maxPriceUsd = requiredNonnegativeNumber(args, "max_usd");
      return {
        id,
        ...(body === null ? {} : { body }),
        maxPriceUsd,
      } satisfies LoopPayInput;
    },
    async run(input, ctx, execution) {
      const { id, body: bodyText, maxPriceUsd } = input as LoopPayInput;
      const listing = ctx.caller.run?.inspected.get(inspectionCacheKey({ id }));
      const priceUsd = listing === undefined ? null : exactUsdcPrice(listing.price);
      if (priceUsd === null) throw new Error("The payment policy did not retain an exact price.");
      const body = bodyText === undefined ? undefined : parseJsonBody(bodyText);
      try {
        execution.payment = await execution.deps.pay({
          ref: id,
          ...(body === undefined ? {} : { body }),
          maxPriceUsd: Math.min(maxPriceUsd, priceUsd, execution.deps.caps.perCallUsd),
        });
      } catch (error) {
        throw new LoopPaymentError(error);
      }
      return {
        status: execution.payment.status,
        body: execution.payment.body,
      } satisfies LoopPayResult;
    },
  },
  "call.read": {
    description: "Read an HTTPS URL from an origin this agent paid in the current run.",
    parameters: {
      type: "object",
      properties: { url: { type: "string" } },
      required: ["url"],
      additionalProperties: false,
    },
    output: callReadOutputSchema,
    summary: "Paid-origin read completed.",
    parseArguments(value) {
      const args = parseObjectArgs(value);
      return { url: requiredString(args, "url") } satisfies LoopReadInput;
    },
    async run(input, _ctx, execution) {
      if (execution.deps.read === undefined) {
        throw new Error("call.read is not available in this run");
      }
      return await execution.deps.read(input as LoopReadInput);
    },
  },
  "swarm.allocate": {
    description:
      'Ask your swarm treasury for USDC budget for this member. Give the amount in whole cents, for example "0.50".',
    parameters: {
      type: "object",
      properties: {
        amount_usd: { type: "string" },
        reason: { type: ["string", "null"] },
      },
      required: ["amount_usd", "reason"],
      additionalProperties: false,
    },
    output: swarmAllocateOutputSchema,
    summary: "Swarm treasury allocation completed.",
    parseArguments(value) {
      const args = parseObjectArgs(value);
      const amountUsd = requiredString(args, "amount_usd");
      const reason = nullableString(args, "reason");
      return {
        amountUsd,
        ...(reason === null ? {} : { reason }),
      } satisfies ParsedLoopSwarmAllocateInput;
    },
    async run(input, _ctx, execution) {
      if (execution.deps.swarm === undefined) {
        throw new Error("swarm.allocate is not available in this run");
      }
      return await execution.deps.swarm.allocate(input as LoopSwarmAllocateInput);
    },
  },
  "swarm.delegate": {
    description:
      "Give another member of your swarm a subtask and a USDC budget moved from the treasury. It runs now and its result is returned.",
    parameters: {
      type: "object",
      properties: {
        member: { type: "string" },
        task: { type: "string" },
        budget_usd: { type: "string" },
      },
      required: ["member", "task", "budget_usd"],
      additionalProperties: false,
    },
    output: swarmDelegateOutputSchema,
    summary: "Swarm delegation completed.",
    parseArguments(value) {
      const args = parseObjectArgs(value);
      return {
        member: requiredString(args, "member"),
        task: requiredString(args, "task"),
        budgetUsd: requiredString(args, "budget_usd"),
      } satisfies ParsedLoopSwarmDelegateInput;
    },
    async run(input, ctx, execution) {
      if (execution.deps.swarm === undefined) {
        throw new Error("swarm.delegate is not available in this run");
      }
      const parentRunId = ctx.caller.run?.ref?.id;
      if (parentRunId === undefined) {
        throw new Error("swarm.delegate requires an active parent run id");
      }
      return await execution.deps.swarm.delegate({
        ...(input as LoopSwarmDelegateInput),
        parentRunId,
      });
    },
  },
};

const FINISH_TOOL = {
  type: "function",
  function: {
    name: "finish",
    description: "Finish the run with the final answer.",
    strict: true,
    parameters: {
      type: "object",
      properties: { answer: { type: "string" } },
      required: ["answer"],
      additionalProperties: false,
    },
  },
} as const;

type RegisteredAction = (typeof actions)[number];

export function loopActionsFor(profile: {
  tools: readonly string[];
  grants?: readonly string[];
}): RegisteredAction[] {
  const enabledTools = new Set(profile.tools);
  const enabledGrants = new Set(profile.grants ?? []);
  return actions.filter(
    (action) =>
      LOOP_BINDINGS[action.name] !== undefined &&
      ((action.grant === "call" && enabledTools.has(action.name)) ||
        (action.grant !== "call" && enabledGrants.has(action.grant))),
  );
}

export function loopToolsForProfile(profile: {
  tools: readonly string[];
  grants?: readonly string[];
}) {
  return [
    ...loopActionsFor(profile).map((action) => {
      const binding = loopBinding(action);
      return {
        profileName: action.name,
        type: "function" as const,
        function: {
          name: action.loopName,
          description: binding.description,
          strict: true as const,
          parameters: binding.parameters,
        },
      };
    }),
    FINISH_TOOL,
  ];
}

export async function runAgent(task: string, deps: RunAgentDeps): Promise<RunAgentResult> {
  const { profile } = deps;
  const runId = deps.runId ?? createRunId();
  const run: RunRef = { id: runId, ...(deps.runMeta ?? {}) };
  const runState = createRunState();
  runState.ref = run;
  if (deps.swarm !== undefined) {
    runState.swarm = {
      name: deps.swarm.name,
      treasury: deps.swarm.treasury,
      member: deps.swarm.member,
      depth: deps.swarm.depth,
      draw: deps.swarm.draw,
    };
  }
  const runDeps = deps.forRun?.(runState) ?? deps;
  const actionContext: ActionContext = {
    config: deps.config,
    clock: deps.now ?? (() => new Date()),
    call: {
      async search() {
        throw new Error("The agent loop uses its reduced search binding.");
      },
      async inspect({ id }) {
        return await runDeps.inspect(id);
      },
      async pay() {
        throw new Error("The agent loop uses its reduced payment binding.");
      },
    },
    caps: deps.caps,
    async askOwner({ ref, priceUsd, reason }) {
      if (ref === undefined || priceUsd === undefined) {
        throw new Error("The payment policy did not provide an approval subject.");
      }
      return await deps.approve({ ref, priceUsd, reason });
    },
    caller: { surface: "agent", profile, run: runState },
  };
  const messages: ChatMessage[] = [
    { role: "system", content: `${profile.instructions}\n\n${UNTRUSTED_NOTICE}` },
    { role: "user", content: task },
  ];
  const loopActions = loopActionsFor(profile);
  const tools = loopToolsForProfile(profile);
  let paidUsd = 0;
  let steps = 0;

  const audit = async (
    event: "agent.run.start" | "agent.run.step" | "agent.run.pay" | "agent.run.declined",
    detail: string,
  ): Promise<void> => {
    try {
      await appendAudit(
        deps.home,
        {
          event,
          run,
          wallet: profile.wallet,
          tty: deps.tty ?? false,
          detail,
        },
        { ...(deps.now === undefined ? {} : { now: deps.now }) },
      );
    } catch (error) {
      throw new AgentAuditError(error);
    }
  };

  const stop = async (
    reason: Extract<AgentEvent, { type: "stopped" }>["reason"],
    detail?: string,
    answer: string | null = null,
  ): Promise<RunAgentResult> => {
    const stoppedBecause: Extract<AgentEvent, { type: "stopped" }> = {
      type: "stopped",
      reason,
      ...(detail === undefined ? {} : { detail }),
    };
    await appendAudit(
      deps.home,
      {
        event: "agent.run.end",
        run,
        wallet: profile.wallet,
        tty: deps.tty ?? false,
        detail: JSON.stringify({ reason, steps, paidUsd }),
      },
      { ...(deps.now === undefined ? {} : { now: deps.now }) },
    );
    deps.onEvent?.(stoppedBecause);
    return {
      runId,
      answer,
      stoppedBecause,
      paidUsd,
      steps,
      ...(deps.budget === undefined
        ? {}
        : {
            budget: {
              limitUsd: Number(deps.budget.limitAtomic) / 1_000_000,
              spentUsd: Number(deps.budget.spentAtomic()) / 1_000_000,
            },
          }),
    };
  };

  const decline = async (ref: string, reason: string): Promise<ToolOutcome> => {
    const event: AgentEvent = { type: "declined", ref, reason };
    await audit("agent.run.declined", JSON.stringify({ ref, reason }));
    deps.onEvent?.(event);
    return { output: { status: "declined", reason } };
  };

  const declineSafely = async (ref: string, reason: string): Promise<ToolOutcome> => {
    try {
      return await decline(ref, reason);
    } catch (error) {
      if (error instanceof AgentAuditError) {
        return {
          output: "The local audit log could not be written. The run is stopping.",
          fatalDetail: "The local audit log could not be written.",
        };
      }
      throw error;
    }
  };

  const runTool = async (
    call: ModelToolCall,
    step: number,
    callIndex: number,
  ): Promise<ToolOutcome> => {
    let input: unknown;
    let action: RegisteredAction | undefined;
    try {
      if (!isAllowedTool(call.name, loopActions)) {
        return { output: `Tool ${call.name} is not allowed for this agent.` };
      }
      action = actionForLoopName(call.name, loopActions);
      if (action === undefined) return { output: `Unknown tool ${call.name}.` };
      const binding = loopBinding(action);
      input = binding.parseArguments(call.arguments, deps);
      if (action.name === "swarm.allocate" || action.name === "swarm.delegate") {
        const callId = call.id.length === 0 ? `step-${step}-${callIndex}` : call.id;
        // Request ids are <runId>:<toolCallId>; different ids are distinct intents bounded by the run draw.
        input = { ...(input as Record<string, unknown>), requestId: `${runId}:${callId}` };
      }
      const execution: LoopExecution = { deps: runDeps };
      const loopAction: Action<unknown, unknown> = {
        ...action,
        output: binding.output,
        async run(actionInput, ctx) {
          return await binding.run(actionInput, ctx, execution);
        },
      };
      const output = await runAction(loopAction, input, actionContext);
      if (action.name === "call.pay") {
        const ref = (input as LoopPayInput).id;
        const result = execution.payment;
        if (result === undefined) throw new Error("The payment binding returned no result.");
        paidUsd += result.amountUsd;
        await audit(
          "agent.run.pay",
          JSON.stringify({ ref, amountUsd: result.amountUsd, network: result.network }),
        );
        deps.onEvent?.({
          type: "paid",
          ref,
          amountUsd: result.amountUsd,
          network: result.network,
        });
      }
      return { output };
    } catch (error) {
      if (error instanceof AgentAuditError) {
        return {
          output: "The local audit log could not be written. The run is stopping.",
          fatalDetail: "The local audit log could not be written.",
        };
      }
      if (error instanceof ActionDeclinedError) {
        const declinedRef = actionDeclineRef(action, input);
        if (declinedRef !== undefined) {
          return await declineSafely(declinedRef, error.reason);
        }
      }
      const ref = paymentRef(input);
      if (error instanceof LoopPaymentError && ref !== undefined) {
        if (hasErrorCode(error.paymentError, "settlement_unknown")) {
          const detail = settlementUnknownDetail(error.paymentError);
          return {
            output: { status: "settlement_unknown", reason: detail },
            fatalDetail: detail,
          };
        }
        const runBudgetReason = callRunBudgetReason(error.paymentError, runDeps.budget);
        if (runBudgetReason !== undefined) {
          return await declineSafely(ref, runBudgetReason);
        }
        const spendBudgetReason = callBudgetReason(error.paymentError);
        if (spendBudgetReason !== undefined) {
          const outcome = await declineSafely(ref, spendBudgetReason);
          return outcome.fatalDetail === undefined
            ? { ...outcome, fatalDetail: spendBudgetReason }
            : outcome;
        }
        return { output: shortToolError(call.name, error.paymentError) };
      }
      return { output: shortToolError(call.name, error) };
    }
  };

  await audit("agent.run.start", JSON.stringify({ agent: profile.name }));
  if (profile.paused) return await stop("paused");

  for (let step = 1; step <= profile.maxSteps; step += 1) {
    steps = step;
    deps.onEvent?.({ type: "step", n: step });
    await audit("agent.run.step", JSON.stringify({ step }));
    let reply: ChatResult;
    try {
      reply = await deps.chat({ model: profile.model, messages, tools, tool_choice: "auto" });
    } catch (error) {
      if (error instanceof RunBudgetError || hasErrorCode(error, "run_budget_exceeded")) {
        return await stop("run_budget", runBudgetDetail(runDeps.budget));
      }
      if (hasErrorCode(error, "budget_exhausted")) {
        return await stop("router_budget", routerBudgetDetail(error));
      }
      return await stop("error", routerErrorDetail(error));
    }
    if (reply.toolCalls.length === 0) {
      return await stop("finished", undefined, reply.content ?? null);
    }
    messages.push({
      role: "assistant",
      content: reply.content ?? "",
      tool_calls: reply.toolCalls.map((call) => ({
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: call.arguments },
      })),
    });
    for (const [callIndex, call] of reply.toolCalls.entries()) {
      if (call.name === "finish") {
        try {
          const answer = requiredString(parseObjectArgs(call.arguments), "answer");
          return await stop("finished", undefined, answer);
        } catch (error) {
          const output = shortToolError(call.name, error);
          messages.push({
            role: "tool",
            tool_call_id: call.id,
            content: wrapUntrusted(call.name, output),
          });
          deps.onEvent?.({ type: "tool", name: call.name, summary: "Finish input rejected." });
          continue;
        }
      }
      const outcome = await runTool(call, step, callIndex);
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: wrapUntrusted(call.name, outcome.output),
      });
      deps.onEvent?.({
        type: "tool",
        name: call.name,
        summary: toolSummary(call.name, loopActions),
      });
      if (outcome.fatalDetail) return await stop("error", outcome.fatalDetail);
    }
  }
  return await stop("max_steps");
}

function isAllowedTool(name: string, loopActions: readonly RegisteredAction[]): boolean {
  if (name === "finish") return true;
  return actionForLoopName(name, loopActions) !== undefined;
}

function actionForLoopName(
  name: string,
  loopActions: readonly RegisteredAction[],
): RegisteredAction | undefined {
  return loopActions.find((action) => action.loopName === name);
}

function loopBinding(action: RegisteredAction): LoopBinding {
  const binding = LOOP_BINDINGS[action.name];
  if (binding === undefined) {
    throw new Error(`No agent-loop binding is registered for ${action.name}.`);
  }
  return binding;
}

function paymentRef(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const id = Reflect.get(input, "id");
  return typeof id === "string" ? id : undefined;
}

function actionDeclineRef(
  action: RegisteredAction | undefined,
  input: unknown,
): string | undefined {
  if (action?.name === "swarm.allocate") return action.name;
  if (action?.name === "swarm.delegate" && typeof input === "object" && input !== null) {
    const member = Reflect.get(input, "member");
    return typeof member === "string" ? `${action.name}:${member}` : action.name;
  }
  return paymentRef(input);
}

function parseObjectArgs(value: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new ToolInputError("Tool arguments were not valid JSON.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ToolInputError("Tool arguments must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

function parseJsonBody(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new ToolInputError("call_pay body was not valid JSON.");
  }
}

function requiredString(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new ToolInputError(`${name} must be a non-empty string.`);
  }
  return value;
}

const SEARCH_NETWORK_ALIASES: Readonly<Record<string, string>> = {
  base: "eip155:8453",
  "base mainnet": "eip155:8453",
  arc: "eip155:5042",
  "arc mainnet": "eip155:5042",
};
const CAIP2 = /^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}$/;

/**
 * Models fill the optional network with "", chain names or ids we do not
 * know. An empty or unknown value searches every network instead of erroring
 * or filtering every listing out; a known name maps to its CAIP-2 id.
 */
function searchNetwork(value: string | null): string | null {
  const trimmed = value?.trim() ?? "";
  if (trimmed === "") return null;
  const alias = SEARCH_NETWORK_ALIASES[trimmed.toLowerCase()];
  if (alias !== undefined) return alias;
  return CAIP2.test(trimmed) ? trimmed : null;
}

function nullableString(args: Record<string, unknown>, name: string): string | null {
  const value = args[name];
  if (value === null) return null;
  if (typeof value !== "string") throw new ToolInputError(`${name} must be a string or null.`);
  return value;
}

function requiredNonnegativeNumber(args: Record<string, unknown>, name: string): number {
  const value = args[name];
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new ToolInputError(`${name} must be a non-negative finite number.`);
  }
  return value;
}

function shortToolError(name: string, error: unknown): string {
  if (error instanceof ToolInputError) return error.message;
  return `${name} failed.`;
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    typeof Reflect.get(error, "code") === "string" &&
    Reflect.get(error, "code") === code
  );
}

function callBudgetReason(error: unknown): string | undefined {
  if (hasErrorCode(error, "per_call_cap_exceeded")) {
    return "This wallet's per-call Call budget is exhausted.";
  }
  if (hasErrorCode(error, "per_day_cap_exceeded")) {
    return "This wallet's daily Call budget is exhausted.";
  }
  return undefined;
}

function callRunBudgetReason(error: unknown, budget: RunBudget | undefined): string | undefined {
  if (!(error instanceof RunBudgetError) && !hasErrorCode(error, "run_budget_exceeded")) {
    return undefined;
  }
  return budget === undefined
    ? "The run budget is spent; this call was not paid."
    : `The run budget of $${formatUsdc(budget.limitAtomic)} is spent; this call was not paid.`;
}

function runBudgetDetail(budget: RunBudget | undefined): string {
  return budget === undefined
    ? "The run budget is spent."
    : `The run budget of $${formatUsdc(budget.limitAtomic)} is spent.`;
}

function routerBudgetDetail(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (
    /^Today's Router allowance is used up\. It resets at (?:\d{2}:\d{2} UTC|\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\.$/u.test(
      message,
    )
  ) {
    return message;
  }
  return "Today's Router allowance is used up.";
}

function routerErrorDetail(error: unknown): string {
  if (hasErrorCode(error, "not_linked")) {
    return error instanceof Error && error.message === AGENT_LINK_REVOKED_MESSAGE
      ? AGENT_LINK_REVOKED_MESSAGE
      : "Not linked. Run vapi login.";
  }
  if (hasErrorCode(error, "no_router_key") && hasErrorStatus(error, 401)) {
    return ROUTER_KEY_REVOKED_MESSAGE;
  }
  return "The vAPI Router request failed.";
}

function hasErrorStatus(error: unknown, status: number): boolean {
  return typeof error === "object" && error !== null && Reflect.get(error, "status") === status;
}

function settlementUnknownDetail(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  const resume =
    /vapi pay --resume ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/iu.exec(
      message,
    )?.[1];
  return resume === undefined
    ? "Payment settlement is unknown. Do not retry automatically; reconcile the receipt before paying again."
    : `Payment settlement is unknown. Do not retry automatically. Check it with \`vapi pay --resume ${resume}\` before paying again.`;
}

function toolSummary(name: string, loopActions: readonly RegisteredAction[]): string {
  const action = actionForLoopName(name, loopActions);
  return action === undefined ? "Tool call rejected." : loopBinding(action).summary;
}

class ToolInputError extends Error {}

class LoopPaymentError extends Error {
  constructor(readonly paymentError: unknown) {
    super("The loop payment failed.", { cause: paymentError });
  }
}

class AgentAuditError extends Error {
  constructor(cause: unknown) {
    super("The local audit log could not be written.", { cause });
  }
}
