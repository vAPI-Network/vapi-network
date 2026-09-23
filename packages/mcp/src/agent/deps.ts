import {
  getVapiPaths,
  type AgentProfile,
  type ChatRequest,
  type ChatResult,
  type SpendCaps,
  type VapiConfig,
  type VapiPaymentAccount,
  type WalletName,
} from "@vapi-network/core";

import { callService } from "../tools/call.js";
import { inspectService, type InspectToolResult } from "../tools/inspect.js";
import { searchMarketplace } from "../tools/search.js";
import type { AgentEvent, RunAgentDeps } from "./run.js";

export function createAgentRunDeps(input: {
  profile: AgentProfile;
  config: VapiConfig;
  home: string;
  account: VapiPaymentAccount;
  wallet: WalletName;
  spendCaps: SpendCaps;
  chat: (req: ChatRequest) => Promise<ChatResult>;
  approve: RunAgentDeps["approve"];
  onEvent?: (event: AgentEvent) => void;
  tty?: boolean;
  fetchImpl?: typeof fetch;
  ledgerPath?: string;
  receiptsPath?: string;
}): RunAgentDeps {
  const paths = getVapiPaths(input.home);
  const inspected = new Map<string, InspectToolResult>();
  return {
    profile: input.profile,
    config: input.config,
    home: input.home,
    chat: input.chat,
    async search(query) {
      const page = await searchMarketplace(query, input.config, input.fetchImpl, {
        searchesPath: paths.searches,
      });
      return page.items.map((hit) => ({
        ref: hit.ref,
        name: hit.card.title,
        priceUsd: exactUsdcPrice(
          hit.card.facts.find((fact) => fact.label.trim().toLocaleLowerCase() === "price")?.value,
        ),
        verification: hit.verification,
        description: hit.card.summary,
      }));
    },
    async inspect(ref) {
      const result = await inspectService({ id: ref }, input.config, input.fetchImpl);
      inspected.set(ref, result);
      return result;
    },
    async pay({ ref, body, maxPriceUsd }) {
      const listing = inspected.get(ref);
      const expectedPayTo = listing?.payment?.payTo;
      const result = await callService({
        input: {
          id: ref,
          ...(body === undefined ? {} : { body }),
          maxPriceUsd,
          ...(expectedPayTo === undefined ? {} : { expectedPayTo }),
        },
        account: input.account,
        config: input.config,
        wallet: input.wallet,
        spendCaps: input.spendCaps,
        ledgerPath: input.ledgerPath ?? paths.ledger,
        receiptsPath: input.receiptsPath ?? paths.receipts,
        ...(input.fetchImpl === undefined ? {} : { fetchImpl: input.fetchImpl }),
      });
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
    ...(input.onEvent === undefined ? {} : { onEvent: input.onEvent }),
    ...(input.tty === undefined ? {} : { tty: input.tty }),
  };
}

function exactUsdcPrice(value: string | undefined): number | null {
  if (value === undefined) return null;
  const normalized = value.trim();
  if (!/^\$(0|[1-9]\d*)(?:\.\d{1,6})?$/u.test(normalized)) return null;
  const price = Number(normalized.slice(1));
  return Number.isFinite(price) ? price : null;
}
