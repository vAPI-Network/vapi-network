import {
  classifySettlement,
  getVapiPaths,
  type AgentProfile,
  type CeilingSweepHook,
  type ChatRequest,
  type ChatResult,
  type RunBudget,
  type SpendCaps,
  type VapiConfig,
  type VapiPaymentAccount,
  type WalletName,
} from "@vapi-network/core";

import { createCallPort, type CreateCallPortOptions } from "../actions/call.js";
import { readPaidOrigin } from "../actions/call-read.js";
import { createRunState, inspectionCacheKey } from "../actions/context.js";
import { exactUsdcPrice } from "../actions/policy.js";
import type { AgentEvent, RunAgentDeps } from "./run.js";

export function createAgentRunDeps(input: {
  profile: AgentProfile;
  config: VapiConfig;
  home: string;
  account: VapiPaymentAccount;
  wallet: WalletName;
  spendCaps: SpendCaps;
  currentSpendCaps?: () => Promise<SpendCaps>;
  chat: (req: ChatRequest) => Promise<ChatResult>;
  approve: RunAgentDeps["approve"];
  onEvent?: (event: AgentEvent) => void;
  tty?: boolean;
  fetchImpl?: typeof fetch;
  ledgerPath?: string;
  receiptsPath?: string;
  ceilingSweep?: CeilingSweepHook | false;
  budget?: RunBudget;
  now?: () => Date;
  allowanceExpiresAt?: Date;
  runId?: string;
  runMeta?: { swarm?: string; member?: string; parentRunId?: string };
}): RunAgentDeps {
  const paths = getVapiPaths(input.home);
  const forRun = (run: ReturnType<typeof createRunState>): RunAgentDeps => {
    const resolvePayment: CreateCallPortOptions["resolvePayment"] = async () => {
      const now = input.now?.() ?? new Date();
      if (
        input.allowanceExpiresAt !== undefined &&
        now.getTime() >= input.allowanceExpiresAt.getTime()
      ) {
        throw new Error(
          `Remote allowance expired at ${input.allowanceExpiresAt.toISOString()}. Start a new Railway run before paying.`,
        );
      }
      const spendCaps =
        input.currentSpendCaps === undefined ? input.spendCaps : await input.currentSpendCaps();
      return {
        account: input.account,
        wallet: input.wallet,
        spendCaps,
        ledgerPath: input.ledgerPath ?? paths.ledger,
        receiptsPath: input.receiptsPath ?? paths.receipts,
        ...(input.fetchImpl === undefined ? {} : { fetchImpl: input.fetchImpl }),
        ...(input.ceilingSweep === undefined ? {} : { ceilingSweep: input.ceilingSweep }),
        ...(input.budget === undefined ? {} : { runBudget: input.budget }),
        ...(input.now === undefined ? {} : { now }),
        ...(input.allowanceExpiresAt === undefined
          ? {}
          : { allowanceExpiresAt: input.allowanceExpiresAt }),
        ...(run.ref === undefined ? {} : { run: run.ref }),
      };
    };
    const call = createCallPort({
      config: input.config,
      fetchImpl: input.fetchImpl,
      searchesPath: paths.searches,
      cacheMarketplaceHits: "optional",
      resolvePayment,
    });
    const dependencies: RunAgentDeps = {
      profile: input.profile,
      config: input.config,
      home: input.home,
      chat: input.chat,
      async search(query) {
        const page = await call.search(query);
        const rows = page.items.map((hit) => ({
          ref: hit.ref,
          name: hit.card.title,
          priceUsd: exactPriceFact(
            hit.card.facts.find((fact) => fact.label.trim().toLocaleLowerCase() === "price")?.value,
          ),
          verification: hit.verification,
          description: hit.card.summary,
        }));
        for (const row of rows) run.searchedRefs.add(row.ref);
        return rows;
      },
      async inspect(ref) {
        const result = await call.inspect({ id: ref });
        run.inspected.set(inspectionCacheKey({ id: ref }), result);
        return result;
      },
      async read({ url }) {
        return await readPaidOrigin({
          url,
          paidOrigins: run.paidOrigins,
          account: input.account,
          config: input.config,
          ...(input.fetchImpl === undefined ? {} : { fetchImpl: input.fetchImpl }),
        });
      },
      async pay({ ref, body, maxPriceUsd }) {
        const listing = run.inspected.get(inspectionCacheKey({ id: ref }));
        const expectedPayTo = listing?.payment?.payTo;
        const result = await call.pay({
          id: ref,
          ...(body === undefined ? {} : { body }),
          maxPriceUsd,
          ...(expectedPayTo === undefined ? {} : { expectedPayTo }),
        });
        if (
          result.payment !== null &&
          result.outcome !== "signed_in" &&
          result.resourceUrl !== undefined &&
          classifySettlement(result.payment.settlement) === "succeeded"
        ) {
          run.paidOrigins.add(new URL(result.resourceUrl).origin);
        }
        return {
          ok: result.status >= 200 && result.status < 300,
          status: result.status,
          body: result.body,
          amountUsd: result.payment === null ? 0 : Number(result.payment.amountUsd),
          network: result.payment?.network ?? listing?.payment?.network ?? listing?.network ?? "",
        };
      },
      caps: { perCallUsd: Number(input.spendCaps.perCallAtomic) / 1_000_000 },
      approve: input.approve,
      ...(input.budget === undefined ? {} : { budget: input.budget }),
      ...(input.runId === undefined ? {} : { runId: input.runId }),
      ...(input.runMeta === undefined ? {} : { runMeta: input.runMeta }),
      forRun(this: RunAgentDeps, nextRun) {
        const next = forRun(nextRun);
        return {
          ...this,
          search: this.search === dependencies.search ? next.search : this.search,
          inspect: this.inspect === dependencies.inspect ? next.inspect : this.inspect,
          read: this.read === dependencies.read ? next.read : this.read,
          pay: this.pay === dependencies.pay ? next.pay : this.pay,
          forRun: next.forRun,
        };
      },
      ...(input.onEvent === undefined ? {} : { onEvent: input.onEvent }),
      ...(input.tty === undefined ? {} : { tty: input.tty }),
    };
    return dependencies;
  };
  return forRun(createRunState());
}

function exactPriceFact(value: string | undefined): number | null {
  return value === undefined ? null : exactUsdcPrice(value);
}
