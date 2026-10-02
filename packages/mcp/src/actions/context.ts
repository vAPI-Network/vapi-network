import type {
  AgentProfile,
  MarketplaceDiscoveryPage,
  RunBudget,
  RunRef,
  TransferResult,
  VapiConfig,
} from "@vapi-network/core";

import type { CallToolInput, CallToolResult } from "../tools/call.js";
import type { InspectToolInput, InspectToolResult } from "../tools/inspect.js";
import type { MarketplaceSearchInput } from "../tools/search.js";
import type { SwarmRunInput, SwarmRunResult } from "../agent/swarm-run.js";
import type { DetachedRunSummary, DetachedSwarmRunResult } from "../agent/runtime.js";
import type { AccountsSendInput } from "./accounts.js";
import type { CallReadInput, CallReadOutput } from "./call-read.js";
import type {
  SwarmAddInput,
  SwarmDissolveInput,
  SwarmDissolveOutput,
  SwarmFundInput,
  SwarmFundOutput,
  SwarmLeaveInput,
  SwarmLeaveOutput,
  SwarmRebalanceInput,
  SwarmRebalanceOutput,
  SwarmSetupInput,
  SwarmSetupOutput,
  SwarmStatusInput,
  SwarmStatusOutput,
} from "./swarm.js";

export type ActionSurface = "cli" | "mcp" | "agent";

export type SwarmRunScope = {
  name: string;
  treasury: string;
  member: string;
  depth: 0 | 1;
  draw: RunBudget;
};

export type SwarmRunActionInput = SwarmRunInput & { detach?: boolean };
export type SwarmRunActionResult = SwarmRunResult | DetachedSwarmRunResult;
export type SwarmRunsInput = { name: string };
export type SwarmRunsResult = { swarm: string; runs: DetachedRunSummary[] };

export type ActionRunState = {
  ref?: RunRef;
  swarm?: SwarmRunScope;
  searchedRefs: Set<string>;
  inspected: Map<string, InspectToolResult>;
  paidOrigins: Set<string>;
};

export function createRunState(): ActionRunState {
  return {
    searchedRefs: new Set<string>(),
    inspected: new Map<string, InspectToolResult>(),
    paidOrigins: new Set<string>(),
  };
}

export function inspectionCacheKey(input: Pick<InspectToolInput, "id" | "endpoint">): string {
  return JSON.stringify([input.id, input.endpoint ?? null]);
}

export type CallPort = {
  search(input: MarketplaceSearchInput): Promise<MarketplaceDiscoveryPage>;
  inspect(input: InspectToolInput): Promise<InspectToolResult>;
  pay(input: CallToolInput & { wallet?: string }): Promise<{ wallet: string } & CallToolResult>;
  read?(input: CallReadInput): Promise<CallReadOutput>;
};

export type AccountsPort = {
  send(input: AccountsSendInput): Promise<TransferResult>;
};

export type SwarmPort = {
  setup(input: SwarmSetupInput): Promise<SwarmSetupOutput>;
  add(input: SwarmAddInput): Promise<SwarmSetupOutput>;
  leave(input: SwarmLeaveInput): Promise<SwarmLeaveOutput>;
  fund(input: SwarmFundInput): Promise<SwarmFundOutput>;
  rebalance(input: SwarmRebalanceInput): Promise<SwarmRebalanceOutput>;
  status(input: SwarmStatusInput): Promise<SwarmStatusOutput>;
  dissolve(input: SwarmDissolveInput): Promise<SwarmDissolveOutput>;
};

export type ActionContext = {
  config: VapiConfig;
  fetch?: typeof fetch;
  clock: () => Date;
  call: CallPort;
  accounts?: AccountsPort;
  swarm?: SwarmPort;
  swarmRun?: { run(input: SwarmRunActionInput): Promise<SwarmRunActionResult> };
  swarmRuns?: { list(input: SwarmRunsInput): Promise<SwarmRunsResult> };
  caps?: { perCallUsd: number };
  askOwner?: (question: {
    action: string;
    reason: string;
    ref?: string;
    priceUsd?: number;
  }) => Promise<boolean>;
  journal?: {
    decided?: (action: string, decision: string) => void | Promise<void>;
  };
  caller: {
    surface: ActionSurface;
    profile?: AgentProfile;
    run?: ActionRunState;
  };
};
