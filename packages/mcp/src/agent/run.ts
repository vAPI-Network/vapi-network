import {
  appendAudit,
  type AgentProfile,
  type ChatMessage,
  type ChatRequest,
  type ChatResult,
  type VapiConfig,
} from "@vapi-network/core";

import type { InspectToolResult } from "../tools/inspect.js";
import { decidePayment, UNTRUSTED_NOTICE, wrapUntrusted } from "./guards.js";

export type AgentEvent =
  | { type: "step"; n: number }
  | { type: "tool"; name: string; summary: string }
  | { type: "paid"; ref: string; amountUsd: number; network: string }
  | { type: "declined"; ref: string; reason: string }
  | {
      type: "stopped";
      reason: "finished" | "max_steps" | "router_budget" | "paused" | "error";
      detail?: string;
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
};

export type RunAgentResult = {
  answer: string | null;
  stoppedBecause: AgentEvent & { type: "stopped" };
  paidUsd: number;
  steps: number;
};

type ModelToolCall = ChatResult["toolCalls"][number];
type InspectedListing = {
  result: InspectToolResult;
  priceUsd: number | null;
  verification: string;
};
type ToolOutcome = { output: unknown; fatalDetail?: string };

const TOOL_DEFINITIONS = [
  {
    profileName: "call.search",
    type: "function",
    function: {
      name: "call_search",
      description:
        "Search vAPI Call listings available to this agent. Set network to null to search every network, or to a CAIP-2 id such as eip155:8453 (Base) or eip155:5042 (Arc).",
      strict: true,
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
          network: { type: ["string", "null"] },
        },
        required: ["query", "network"],
        additionalProperties: false,
      },
    },
  },
  {
    profileName: "call.inspect",
    type: "function",
    function: {
      name: "call_inspect",
      description: "Inspect a vAPI Call listing's price, verification, and request contract.",
      strict: true,
      parameters: {
        type: "object",
        properties: { ref: { type: "string" } },
        required: ["ref"],
        additionalProperties: false,
      },
    },
  },
  {
    profileName: "call.pay",
    type: "function",
    function: {
      name: "call_pay",
      description:
        "Call and pay a listing. body is a JSON-encoded request body or null. max_usd cannot override wallet or agent policy.",
      strict: true,
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
    },
  },
] as const;

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

export async function runAgent(task: string, deps: RunAgentDeps): Promise<RunAgentResult> {
  const { profile } = deps;
  const seenRefs = new Set<string>();
  const inspected = new Map<string, InspectedListing>();
  const messages: ChatMessage[] = [
    { role: "system", content: `${profile.instructions}\n\n${UNTRUSTED_NOTICE}` },
    { role: "user", content: task },
  ];
  const enabledTools = new Set(profile.tools);
  const tools = [
    ...TOOL_DEFINITIONS.filter((tool) => enabledTools.has(tool.profileName)),
    FINISH_TOOL,
  ];
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
        wallet: profile.wallet,
        tty: deps.tty ?? false,
        detail: JSON.stringify({ reason, steps, paidUsd }),
      },
      { ...(deps.now === undefined ? {} : { now: deps.now }) },
    );
    deps.onEvent?.(stoppedBecause);
    return { answer, stoppedBecause, paidUsd, steps };
  };

  const inspectListing = async (ref: string): Promise<InspectedListing> => {
    const existing = inspected.get(ref);
    if (existing) return existing;
    const result = await deps.inspect(ref);
    const remembered = {
      result,
      priceUsd: exactUsdcPrice(result.price),
      verification: result.verification,
    };
    inspected.set(ref, remembered);
    return remembered;
  };

  const decline = async (ref: string, reason: string): Promise<ToolOutcome> => {
    const event: AgentEvent = { type: "declined", ref, reason };
    await audit("agent.run.declined", JSON.stringify({ ref, reason }));
    deps.onEvent?.(event);
    return { output: { status: "declined", reason } };
  };

  const runTool = async (call: ModelToolCall): Promise<ToolOutcome> => {
    try {
      if (!isAllowedTool(call.name, enabledTools)) {
        return { output: `Tool ${call.name} is not allowed for this agent.` };
      }
      if (call.name === "call_search") {
        const args = parseObjectArgs(call.arguments);
        const query = requiredString(args, "query");
        const network = searchNetwork(nullableString(args, "network"));
        const rows = await deps.search({
          query,
          ...(network === null ? {} : { network }),
          includeUnverified: !profile.verifiedOnly,
        });
        for (const row of rows) seenRefs.add(row.ref);
        return { output: rows };
      }
      if (call.name === "call_inspect") {
        const args = parseObjectArgs(call.arguments);
        const ref = requiredString(args, "ref");
        return { output: (await inspectListing(ref)).result };
      }
      if (call.name === "call_pay") {
        const args = parseObjectArgs(call.arguments);
        const ref = requiredString(args, "ref");
        const bodyText = nullableString(args, "body");
        const maxUsd = requiredNonnegativeNumber(args, "max_usd");
        const listing = await inspectListing(ref);
        const decision = decidePayment({
          ref,
          priceUsd: listing.priceUsd,
          verification: listing.verification,
          seenRefs,
          verifiedOnly: profile.verifiedOnly,
          approveAboveUsd: profile.approveAboveUsd,
          maxPerCallUsd: deps.caps.perCallUsd,
        });
        if (decision.action === "refuse") return await decline(ref, decision.reason);
        if (decision.action === "ask") {
          const approved = await deps.approve({
            ref,
            priceUsd: listing.priceUsd!,
            reason: decision.reason,
          });
          if (!approved) {
            return await decline(ref, `Payment was not approved: ${decision.reason}`);
          }
        }
        const priceUsd = listing.priceUsd!;
        if (maxUsd < priceUsd) {
          return await decline(
            ref,
            `Requested maximum $${maxUsd} is below the listing price $${priceUsd}.`,
          );
        }
        const body = bodyText === null ? undefined : parseJsonBody(bodyText);
        let result: Awaited<ReturnType<RunAgentDeps["pay"]>>;
        try {
          result = await deps.pay({
            ref,
            ...(body === undefined ? {} : { body }),
            maxPriceUsd: Math.min(maxUsd, priceUsd, deps.caps.perCallUsd),
          });
        } catch (error) {
          if (hasErrorCode(error, "settlement_unknown")) {
            const detail = settlementUnknownDetail(error);
            return {
              output: { status: "settlement_unknown", reason: detail },
              fatalDetail: detail,
            };
          }
          const spendBudgetReason = callBudgetReason(error);
          if (spendBudgetReason !== undefined) {
            const outcome = await decline(ref, spendBudgetReason);
            return { ...outcome, fatalDetail: spendBudgetReason };
          }
          throw error;
        }
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
        return { output: { status: result.status, body: result.body } };
      }
      return { output: `Unknown tool ${call.name}.` };
    } catch (error) {
      if (error instanceof AgentAuditError) {
        return {
          output: "The local audit log could not be written. The run is stopping.",
          fatalDetail: "The local audit log could not be written.",
        };
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
      if (hasErrorCode(error, "budget_exhausted")) {
        return await stop("router_budget", routerBudgetDetail(error));
      }
      return await stop("error", "The vAPI Router request failed.");
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
    for (const call of reply.toolCalls) {
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
      const outcome = await runTool(call);
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: wrapUntrusted(call.name, outcome.output),
      });
      deps.onEvent?.({ type: "tool", name: call.name, summary: toolSummary(call.name) });
      if (outcome.fatalDetail) return await stop("error", outcome.fatalDetail);
    }
  }
  return await stop("max_steps");
}

function isAllowedTool(name: string, enabledTools: ReadonlySet<string>): boolean {
  if (name === "finish") return true;
  const profileName =
    name === "call_search"
      ? "call.search"
      : name === "call_inspect"
        ? "call.inspect"
        : name === "call_pay"
          ? "call.pay"
          : null;
  return profileName !== null && enabledTools.has(profileName);
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

function exactUsdcPrice(value: string): number | null {
  const match = /^\$(0|[1-9]\d*)(?:\.(\d{1,6}))?$/u.exec(value.trim());
  if (!match) return null;
  const price = Number(value.trim().slice(1));
  return Number.isFinite(price) ? price : null;
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

function toolSummary(name: string): string {
  if (name === "call_search") return "Search completed.";
  if (name === "call_inspect") return "Inspection completed.";
  if (name === "call_pay") return "Payment tool completed.";
  return "Tool call rejected.";
}

class ToolInputError extends Error {}

class AgentAuditError extends Error {
  constructor(cause: unknown) {
    super("The local audit log could not be written.", { cause });
  }
}
